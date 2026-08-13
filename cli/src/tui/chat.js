'use strict';

/**
 * Mini GChat screen: groups | channels | transcript | composer.
 *
 * Hover outlines a message. Click selects it; r/e/d/c/p then act.
 * Icons sit on the right. Delete dims everything but the message.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ansi = require('./ansi');
const {
  DEFAULT_CHAT,
  buildChatFrame,
  composeChatFrame,
  hitTest,
  TRANSITION_MS,
  scrollOffsetFromY,
  clampScrollForMessage,
  WHEEL_LINES,
} = require('./chat-layout');
const { looksLikeImagePath, readClipboardImage } = require('./clipboard-image');
const {
  decryptServerMessage,
  decryptAttachment,
  decryptAttachmentMeta,
} = require('../client/messages');
const {
  loadPrefs,
  getActiveChannel,
  setActiveChannel,
  listChannels,
  rememberChannel,
  savePrefs,
  normalizeChannel,
  setChannelOrder,
} = require('../store/prefs');

const MAX_COMPOSER = 2000;
const MEDIA_CACHE_MAX = 8;
const MEDIA_DIR = path.join(os.tmpdir(), 'gchat-cli-media');

function defaultChatState(over = {}) {
  return { ...DEFAULT_CHAT, ...over };
}

function createChatController({ client, paths, stdout, getSize, onDraw, onQuit } = {}) {
  const state = defaultChatState({
    username: client?.user?.username || '',
    userId: client?.user?.id || null,
    status: 'connecting',
  });

  let lastFrame = null;
  let lastHoverKey = '';
  let inputBuffer = '';
  let running = false;
  let pulseTimer = null;
  let draggingScroll = false;
  let channelDrag = null;
  let typingTimer = null;
  let typingSent = false;
  const mediaCache = new Map(); // messageId -> { path, filename, mimeType, size, bytes }

  function size() {
    if (typeof getSize === 'function') return getSize();
    return {
      cols: (stdout && stdout.columns) || 80,
      rows: (stdout && stdout.rows) || 24,
    };
  }

  function draw() {
    const { cols, rows } = size();
    lastFrame = buildChatFrame(cols, rows, state);
    if (stdout) stdout.write(composeChatFrame(cols, rows, state));
    if (typeof onDraw === 'function') onDraw(lastFrame);
    return lastFrame;
  }

  function setStatus(text) {
    state.status = text || '';
    state.error = null;
  }

  function setError(text) {
    state.error = String(text || 'error');
    state.status = state.error;
  }

  function needsPulse() {
    if (!state.activeGroupId) return true;
    if (state.transition) return true;
    if (state.typing) return true;
    if (state.overlay && state.overlay.type === 'delete') return true;
    return (state.messages || []).some((item) => item.sending);
  }

  function startPulse() {
    if (pulseTimer) return;
    pulseTimer = setInterval(() => {
      state.animFrame = (state.animFrame || 0) + 1;
      if (state.transition && Date.now() >= state.transition.until) {
        state.transition = null;
      }
      if (state.typing && state.typing.until && Date.now() >= state.typing.until) {
        state.typing = null;
      }
      if (!needsPulse()) {
        clearInterval(pulseTimer);
        pulseTimer = null;
      }
      draw();
    }, 50);
  }

  function beginTransition() {
    state.transition = { until: Date.now() + TRANSITION_MS };
    startPulse();
  }

  async function waitTransition() {
    const until = state.transition?.until || 0;
    const wait = until - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    state.transition = null;
  }

  function upsertMessage(item) {
    if (!item?.msg?.id) return;
    const id = String(item.msg.id);
    const idx = state.messages.findIndex((m) => String(m.msg.id) === id);
    if (idx >= 0) state.messages[idx] = { ...state.messages[idx], ...item };
    else state.messages.push(item);
    state.messages.sort((a, b) => String(a.msg.createdAt || '').localeCompare(String(b.msg.createdAt || '')));
    if (state.messages.length > 500) state.messages.splice(0, state.messages.length - 500);
  }

  async function decorate(msg, groupId) {
    const secret = client.getSecret(groupId);
    if (!secret) {
      return { msg, text: null, channel: 'main', error: 'missing key', attach: null };
    }
    if (msg.type === 'image' || msg.type === 'file') {
      const attach = await decryptAttachmentMeta(msg, secret, groupId);
      return {
        msg,
        text: null,
        channel: attach.hashtag || 'main',
        error: null,
        attach,
        replyTo: resolveReply(msg, attach),
      };
    }
    const dec = await decryptServerMessage(msg, secret, groupId);
    return { msg, ...dec, attach: null, replyTo: resolveReply(msg, dec.metadata) };
  }

  function resolveReply(msg, metadata) {
    const replyId = msg.replyToId || msg.reply_to || null;
    const preview = metadata?.replyPreview || null;
    if (!replyId && !preview) return null;
    const original = replyId ? findMessage(replyId) : null;
    const name = original?.msg?.senderName || original?.msg?.senderId || null;
    const text = original?.text || preview || original?.attach?.filename || '';
    const [maybeName, ...rest] = String(preview || '').split(':');
    return {
      id: replyId,
      name: name || (preview && rest.length ? maybeName.trim() : 'message'),
      preview: rest.length ? rest.join(':').trim() : text,
    };
  }

  async function loadGroup(group) {
    if (state.overlay && state.overlay.type === 'delete') return;
    if (!group) {
      state.activeGroupId = null;
      state.messages = [];
      state.channels = ['main'];
      state.activeChannel = 'main';
      state.hoverMessageId = null;
      state.transition = null;
      const prefs = loadPrefs(paths);
      prefs.activeGroupId = null;
      savePrefs(prefs, paths);
      startPulse();
      return;
    }
    state.activeGroupId = group.id;
    state.messages = [];
    state.hoverMessageId = null;
    state.hoverAction = null;
    state.selectedMessageId = null;
    state.channelMenu = null;
    state.scrollOffset = 0;
    client.setActiveGroup(group.id);
    const groupRef = state.groups.find((g) => String(g.id) === String(group.id));
    if (groupRef) groupRef.unreadCount = 0;
    beginTransition();
    draw();
    try {
      const opened = await client.openGroup(group.id);
      const decrypted = [];
      for (const msg of opened.messages || []) {
        decrypted.push(await decorate(msg, group.id));
      }
      state.messages = decrypted;
      const prefs = loadPrefs(paths);
      for (const item of decrypted) {
        if (item.channel) rememberChannel(group.id, item.channel, prefs);
      }
      savePrefs(prefs, paths);
      const nextChannels = listChannels(group.id, paths);
      const nextActive = getActiveChannel(group.id, paths) || 'main';
      await waitTransition();
      state.channels = nextChannels;
      state.activeChannel = nextActive;
    } catch (err) {
      state.transition = null;
      setError(err.message || String(err));
    }
  }

  async function switchChannel(name) {
    if (state.overlay && state.overlay.type === 'delete') return;
    if (!state.activeGroupId) return;
    const next = client.switchChannel(state.activeGroupId, name);
    if (next === state.activeChannel && !state.transition) return;
    state.activeChannel = next;
    state.scrollOffset = 0;
    state.hoverMessageId = null;
    state.selectedMessageId = null;
    beginTransition();
    draw();
    await waitTransition();
  }

  function cycleChannel(delta) {
    if (state.overlay && state.overlay.type === 'delete') return Promise.resolve();
    const list = state.channels && state.channels.length ? state.channels : ['main'];
    const current = state.activeChannel || 'main';
    const idx = Math.max(0, list.indexOf(current));
    const next = list[(idx + delta + list.length) % list.length];
    return switchChannel(next);
  }

  function applyScroll(delta) {
    if (!lastFrame) lastFrame = buildChatFrame(size().cols, size().rows, state);
    let next = (state.scrollOffset || 0) + delta;
    next = Math.max(0, Math.min(lastFrame.maxScroll, next));
    if (state.overlay && state.overlay.type === 'delete') {
      next = clampScrollForMessage(
        next,
        lastFrame.messageBounds,
        lastFrame.totalLines,
        lastFrame.regions.transcript.h
      );
    }
    state.scrollOffset = next;
  }

  async function refreshGroups() {
    try {
      state.groups = await client.listGroups();
    } catch (err) {
      state.groups = state.groups || [];
      setError(err.message || String(err));
    }
  }

  async function start() {
    running = true;
    state.username = client.user?.username || state.username;
    state.userId = client.user?.id || state.userId;
    client.onEvent = (event, payload) => {
      handleEvent(event, payload).catch(() => {});
    };
    try {
      const me = client.user || await client.me();
      state.username = me.username;
      state.userId = me.id;
    } catch {
      /* session may already be warm */
    }
    await refreshGroups();
    try {
      await client.connectSocket();
      state.connected = true;
    } catch (err) {
      state.connected = false;
      setError(err.message || 'socket failed');
    }
    const prefs = loadPrefs(paths);
    const wanted = prefs.activeGroupId
      ? state.groups.find((g) => String(g.id) === String(prefs.activeGroupId))
      : state.groups[0];
    await loadGroup(wanted || null);
    if (needsPulse()) startPulse();
    draw();
  }

  function stop() {
    running = false;
    if (pulseTimer) {
      clearInterval(pulseTimer);
      pulseTimer = null;
    }
    if (typingTimer) {
      clearTimeout(typingTimer);
      typingTimer = null;
    }
    try {
      client.disconnectSocket();
    } catch {
      /* ignore */
    }
  }

  async function handleEvent(event, payload) {
    if (!running) return;
    if (event === 'connect') {
      state.connected = true;
      draw();
      return;
    }
    if (event === 'disconnect') {
      state.connected = false;
      setStatus('disconnected');
      draw();
      return;
    }
    if (event === 'connect_error') {
      state.connected = false;
      setError(payload?.message || String(payload || 'socket error'));
      draw();
      return;
    }
    if (event === 'new_message' && payload) {
      if (String(payload.groupId) !== String(state.activeGroupId)) {
        const other = state.groups.find((g) => String(g.id) === String(payload.groupId));
        if (other) other.unreadCount = (Number(other.unreadCount) || 0) + 1;
        draw();
        return;
      }
      const item = await decorate(payload, payload.groupId);
      item.sending = false;
      if (item.channel) {
        const prefs = loadPrefs(paths);
        rememberChannel(payload.groupId, item.channel, prefs);
        savePrefs(prefs, paths);
        state.channels = listChannels(payload.groupId, paths);
      }
      upsertMessage(item);
      draw();
      return;
    }
    if (event === 'message_edited' && payload) {
      const idx = state.messages.findIndex((m) => String(m.msg.id) === String(payload.id));
      if (idx >= 0) {
        const item = await decorate(payload, payload.groupId || state.activeGroupId);
        state.messages[idx] = item;
        draw();
      }
      return;
    }
    if (event === 'message_deleted' && payload) {
      state.messages = state.messages.filter((m) => String(m.msg.id) !== String(payload.id || payload.messageId));
      if (String(state.hoverMessageId) === String(payload.id || payload.messageId)) {
        state.hoverMessageId = null;
        state.hoverAction = null;
      }
      draw();
      return;
    }
    if (event === 'channel_announce' && payload?.channel && payload.groupId) {
      if (String(payload.groupId) !== String(state.activeGroupId)) return;
      const prefs = loadPrefs(paths);
      rememberChannel(payload.groupId, payload.channel, prefs);
      savePrefs(prefs, paths);
      state.channels = listChannels(payload.groupId, paths);
      draw();
      return;
    }
    if (event === 'user_typing' && payload?.username) {
      if (payload.username === state.username) return;
      state.typing = { username: payload.username, until: Date.now() + 3000 };
      startPulse();
      draw();
      return;
    }
    if (event === 'user_stop_typing') {
      if (payload?.username && state.typing && state.typing.username === payload.username) {
        state.typing = null;
        draw();
      }
    }
  }

  function findMessage(id) {
    return state.messages.find((m) => String(m.msg.id) === String(id)) || null;
  }

  function applyHover(hit) {
    if (state.overlay && state.overlay.type === 'delete') return false;
    const nextId = hit && (hit.type === 'message' || hit.type === 'action' || hit.type === 'card')
      ? String(hit.id)
      : null;
    const nextAction = hit && hit.type === 'action' ? hit.action : null;
    const nextChannel = hit && (hit.type === 'channel' || hit.type === 'create-channel')
      ? String(hit.name || '+')
      : null;
    const key = `${nextId || ''}:${nextAction || ''}:${nextChannel || ''}`;
    if (key === lastHoverKey) return false;
    lastHoverKey = key;
    state.hoverMessageId = nextId;
    state.hoverAction = nextAction;
    state.hoverChannel = nextChannel;
    return true;
  }

  function clearSelection() {
    state.selectedMessageId = null;
    state.hoverAction = null;
    if (state.overlay && state.overlay.type === 'delete') state.overlay = null;
  }

  function selectMessage(item) {
    if (!item) return;
    state.selectedMessageId = String(item.msg.id);
  }

  function shortcutsArmed() {
    return !!(state.selectedMessageId && !state.composer && !state.editingId
      && !state.creatingChannel && !state.overlay && !state.channelMenu && !state.renamingChannel);
  }

  async function beginReply(item) {
    if (!item) return;
    state.editingId = null;
    state.replyTo = {
      id: item.msg.id,
      name: item.msg.senderName || item.msg.senderId || 'reply',
      preview: (item.text || item.attach?.filename || '').slice(0, 40),
    };
  }

  function beginEdit(item) {
    if (!item || isAttach(item)) return;
    state.replyTo = null;
    state.editingId = item.msg.id;
    state.composer = item.text || '';
    state.composerCaret = state.composer.length;
  }

  function isAttach(item) {
    return item?.msg?.type === 'image' || item?.msg?.type === 'file';
  }

  function cancelComposeMode() {
    state.replyTo = null;
    state.editingId = null;
  }

  function closeOverlay() {
    state.overlay = null;
  }

  function evictMedia() {
    while (mediaCache.size > MEDIA_CACHE_MAX) {
      const oldest = mediaCache.keys().next().value;
      const entry = mediaCache.get(oldest);
      mediaCache.delete(oldest);
      if (entry?.path) {
        try { fs.unlinkSync(entry.path); } catch { /* ignore */ }
      }
    }
  }

  async function materializeAttachment(item) {
    const id = String(item.msg.id);
    if (mediaCache.has(id)) return mediaCache.get(id);
    const secret = client.getSecret(state.activeGroupId);
    if (!secret) throw new Error('missing encryption key');
    const { bytes, metadata } = await decryptAttachment(item.msg, secret, state.activeGroupId);
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const filename = path.basename(metadata.filename || (item.msg.type === 'image' ? 'image' : 'file'));
    const target = path.join(MEDIA_DIR, `${id.slice(0, 8)}-${filename}`);
    fs.writeFileSync(target, bytes);
    const entry = {
      path: target,
      filename,
      mimeType: metadata.mimeType || '',
      size: bytes.length,
      bytes,
    };
    mediaCache.set(id, entry);
    evictMedia();
    item.attach = { ...item.attach, ...metadata, size: bytes.length };
    return entry;
  }

  function previewPath(target) {
    const plat = process.platform;
    try {
      if (plat === 'darwin') {
        spawn('qlmanage', ['-p', target], { detached: true, stdio: 'ignore' }).unref();
        return true;
      }
      return openPath(target);
    } catch {
      return false;
    }
  }

  function openPath(target) {
    const plat = process.platform;
    try {
      if (plat === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
      else if (plat === 'win32') spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref();
      else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
      return true;
    } catch {
      return false;
    }
  }

  async function previewAttachment(item) {
    if (!item) return;
    try {
      const entry = await materializeAttachment(item);
      if (!previewPath(entry.path)) setError('could not preview');
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  async function saveAttachmentTo(item, dest) {
    const entry = await materializeAttachment(item);
    const target = path.resolve(dest || entry.filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(entry.path, target);
    return target;
  }

  async function uploadLocalFile(filePath, filename) {
    if (!state.activeGroupId) {
      setError('No chat open');
      return;
    }
    const tempId = `pending-${Date.now()}`;
    upsertMessage({
      msg: {
        id: tempId,
        groupId: state.activeGroupId,
        senderId: state.userId,
        senderName: state.username,
        type: 'image',
        createdAt: new Date().toISOString(),
      },
      text: null,
      channel: state.activeChannel || 'main',
      error: null,
      attach: { filename: filename || path.basename(filePath), mimeType: 'image/png' },
      sending: true,
    });
    state.scrollOffset = 0;
    startPulse();
    draw();
    try {
      const result = await client.uploadFile(state.activeGroupId, filePath, { type: 'image' });
      const live = findMessage(tempId);
      if (live) {
        live.msg.id = result.messageId;
        live.sending = false;
        live.attach = { ...live.attach, filename: result.filename || live.attach.filename };
      }
    } catch (err) {
      state.messages = state.messages.filter((m) => String(m.msg.id) !== tempId);
      setError(err.message || String(err));
    }
    draw();
  }

  async function uploadPastedImage() {
    const clip = await readClipboardImage();
    if (!clip) return false;
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const dest = path.join(MEDIA_DIR, clip.filename || 'paste.png');
    fs.writeFileSync(dest, clip.bytes);
    await uploadLocalFile(dest, clip.filename || 'paste.png');
    return true;
  }

  async function handlePasteText(text) {
    const file = looksLikeImagePath(text);
    if (file) {
      await uploadLocalFile(file, path.basename(file));
      return true;
    }
    return uploadPastedImage();
  }

  function pokeTyping() {
    if (!state.activeGroupId || !client.emitTyping) return;
    if (!typingSent) {
      try { client.emitTyping(state.activeGroupId, false); } catch { /* ignore */ }
      typingSent = true;
    }
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      typingSent = false;
      try { client.emitTyping(state.activeGroupId, true); } catch { /* ignore */ }
    }, 2000);
  }

  async function confirmDelete(item) {
    if (!item) return;
    state.selectedMessageId = String(item.msg.id);
    state.overlay = { type: 'delete', messageId: item.msg.id };
    startPulse();
  }

  async function performDelete(messageId) {
    try {
      await client.deleteMessage(state.activeGroupId, messageId);
      state.messages = state.messages.filter((m) => String(m.msg.id) !== String(messageId));
      closeOverlay();
      clearSelection();
    } catch (err) {
      state.overlay = { type: 'error', message: err.message || String(err) };
    }
  }

  async function submitComposer() {
    const text = String(state.composer || '').trim();
    if (!text) return;
    if (!state.activeGroupId) {
      setError('No chat open');
      return;
    }
    if (text.startsWith(':') || text.startsWith('/')) {
      await runSlash(text.slice(1).trim());
      return;
    }
    try {
      if (state.editingId) {
        await client.editMessage(state.activeGroupId, state.editingId, text);
        const item = findMessage(state.editingId);
        if (item) item.text = text;
        state.composer = '';
        state.composerCaret = 0;
        state.editingId = null;
        return;
      }
      const replyTo = state.replyTo;
      const tempId = `pending-${Date.now()}`;
      const pending = {
        msg: {
          id: tempId,
          groupId: state.activeGroupId,
          senderId: state.userId,
          senderName: state.username,
          type: 'text',
          createdAt: new Date().toISOString(),
          replyToId: replyTo?.id || null,
        },
        text,
        channel: state.activeChannel || 'main',
        error: null,
        attach: null,
        sending: true,
        replyTo: replyTo ? { id: replyTo.id, name: replyTo.name, preview: replyTo.preview } : null,
      };
      upsertMessage(pending);
      state.composer = '';
      state.composerCaret = 0;
      state.replyTo = null;
      state.scrollOffset = 0;
      startPulse();
      draw();
      try {
        const result = await client.sendText({
          groupId: state.activeGroupId,
          text,
          replyToId: replyTo?.id || null,
          replyPreview: replyTo ? `${replyTo.name}: ${replyTo.preview || ''}`.trim() : null,
        });
        const live = findMessage(tempId);
        if (live) {
          live.msg.id = result.messageId;
          live.sending = false;
        }
      } catch (err) {
        state.messages = state.messages.filter((m) => String(m.msg.id) !== tempId);
        throw err;
      }
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  async function runSlash(body) {
    const [name, ...rest] = String(body || '').split(/\s+/);
    const arg = rest.join(' ');
    if (name === 'q' || name === 'quit' || name === 'exit') {
      if (typeof onQuit === 'function') onQuit();
      return;
    }
    if (name === 'channel' && rest[0]) {
      await switchChannel(rest[0]);
      state.composer = '';
      state.composerCaret = 0;
      return;
    }
    if (name === 'open' && arg) {
      const group = state.groups.find((g) => String(g.name).toLowerCase() === arg.toLowerCase()
        || String(g.id) === arg);
      if (group) await loadGroup(group);
      state.composer = '';
      state.composerCaret = 0;
      return;
    }
    setError(`unknown :${name}`);
    state.composer = '';
    state.composerCaret = 0;
  }

  async function runAction(action, item) {
    if (action === 'clear') {
      clearSelection();
      return;
    }
    if (!item) return;
    if (action === 'reply') await beginReply(item);
    else if (action === 'edit') beginEdit(item);
    else if (action === 'delete') await confirmDelete(item);
    else if (action === 'preview') await previewAttachment(item);
  }

  function startChannelRename(name) {
    if (!name || name === 'main') {
      setError('cannot rename #main');
      return;
    }
    state.renamingChannel = name;
    state.channelMenu = name;
    state.channelDraft = name;
  }

  async function finishChannelRename() {
    const from = state.renamingChannel;
    const to = normalizeChannel(state.channelDraft);
    state.renamingChannel = null;
    state.channelDraft = '';
    if (!from || !to || to === from || !state.activeGroupId) {
      state.channelMenu = null;
      return;
    }
    const next = state.channels.map((c) => (c === from ? to : c));
    state.channels = setChannelOrder(state.activeGroupId, next, paths);
    try {
      await client.connectSocket();
      client.announceChannel(state.activeGroupId, to, 'create');
    } catch { /* local rename still applies */ }
    if (state.activeChannel === from) await switchChannel(to);
    state.channelMenu = null;
  }

  async function deleteChannel(name) {
    if (!name || name === 'main') {
      setError('cannot delete #main');
      return;
    }
    if (!state.activeGroupId) return;
    try {
      await client.connectSocket();
      client.announceChannel(state.activeGroupId, name, 'delete');
    } catch { /* still drop locally */ }
    state.channels = setChannelOrder(
      state.activeGroupId,
      state.channels.filter((c) => c !== name),
      paths
    );
    state.channelMenu = null;
    if (state.activeChannel === name) await switchChannel('main');
  }

  function reorderChannelsByX(x) {
    if (!channelDrag || !lastFrame || !state.activeGroupId) return;
    const chips = lastFrame.hits.filter((h) => h.type === 'channel').sort((a, b) => a.x - b.x);
    if (chips.length < 2) return;
    let insertAt = chips.length - 1;
    for (let i = 0; i < chips.length; i += 1) {
      if (x < chips[i].x + chips[i].w / 2) {
        insertAt = i;
        break;
      }
    }
    const from = state.channels.indexOf(channelDrag.name);
    if (from < 0 || from === insertAt) return;
    const next = state.channels.slice();
    const [moved] = next.splice(from, 1);
    next.splice(insertAt > from ? insertAt - 1 : insertAt, 0, moved);
    state.channels = setChannelOrder(state.activeGroupId, next, paths);
  }

  async function createChannel(name) {
    const normalized = normalizeChannel(name);
    if (!normalized || !state.activeGroupId) {
      state.creatingChannel = false;
      state.channelDraft = '';
      return;
    }
    try {
      await client.connectSocket();
      client.announceChannel(state.activeGroupId, normalized, 'create');
      state.channels = listChannels(state.activeGroupId, paths);
      if (!state.channels.includes(normalized)) {
        const prefs = loadPrefs(paths);
        rememberChannel(state.activeGroupId, normalized, prefs);
        savePrefs(prefs, paths);
        state.channels = listChannels(state.activeGroupId, paths);
      }
      await switchChannel(normalized);
    } catch (err) {
      setError(err.message || String(err));
    }
    state.creatingChannel = false;
    state.channelDraft = '';
  }

  async function handleClick(hit) {
    if (!hit) {
      if (state.overlay && state.overlay.type === 'delete') closeOverlay();
      return;
    }
    if (state.overlay && state.overlay.type === 'delete') {
      if (hit.type === 'confirm-delete') {
        await performDelete(state.overlay.messageId);
        clearSelection();
      } else if (hit.type !== 'message' || String(hit.id) !== String(state.overlay.messageId)) {
        closeOverlay();
      }
      return;
    }
    if (hit.type === 'group') {
      const group = state.groups.find((g) => String(g.id) === String(hit.id));
      if (group) await loadGroup(group);
      return;
    }
    if (hit.type === 'sidebar-empty') {
      await loadGroup(null);
      return;
    }
    if (hit.type === 'channel-action') {
      if (hit.action === 'rename') startChannelRename(hit.name);
      else if (hit.action === 'delete') await deleteChannel(hit.name);
      return;
    }
    if (hit.type === 'channel') {
      if (hit.name === state.activeChannel) {
        state.channelMenu = state.channelMenu === hit.name ? null : hit.name;
        clearSelection();
        return;
      }
      state.channelMenu = null;
      await switchChannel(hit.name);
      return;
    }
    if (hit.type === 'create-channel') {
      state.creatingChannel = true;
      state.channelDraft = '';
      return;
    }
    if (hit.type === 'scrollbar') {
      if (!lastFrame) return;
      state.scrollOffset = scrollOffsetFromY(hit._y, lastFrame.regions.scrollbar, lastFrame.maxScroll);
      draggingScroll = true;
      return;
    }
    if (hit.type === 'gap') {
      clearSelection();
      return;
    }
    if (hit.type === 'action') {
      const item = findMessage(hit.id) || findMessage(state.selectedMessageId);
      await runAction(hit.action, item);
      return;
    }
    if (hit.type === 'card' || hit.type === 'message') {
      const item = findMessage(hit.id);
      if (!item) return;
      if (hit.type === 'card' && String(state.selectedMessageId) === String(item.msg.id)) {
        await previewAttachment(item);
        return;
      }
      selectMessage(item);
    }
  }

  function handleMouse(mouse) {
    if (!lastFrame) lastFrame = buildChatFrame(size().cols, size().rows, state);
    const x = mouse.x - 1;
    const y = mouse.y - 1;
    const hit = hitTest(lastFrame.hits, x, y);
    if (hit && hit.type === 'scrollbar') hit._y = y;

    if (mouse.kind === 'wheel') {
      const region = lastFrame.regions.transcript;
      const bar = lastFrame.regions.scrollbar;
      const over = (region && x >= region.x && x < region.x + region.w && y >= region.y && y < region.y + region.h)
        || (bar && x >= bar.x && x < bar.x + bar.w && y >= bar.y && y < bar.y + bar.h);
      if (over) {
        applyScroll(mouse.wheel < 0 ? WHEEL_LINES : -WHEEL_LINES);
        return true;
      }
      return false;
    }

    if (mouse.kind === 'release' && mouse.button === 0) {
      draggingScroll = false;
      if (channelDrag) {
        const dragged = channelDrag.moved;
        const name = channelDrag.name;
        channelDrag = null;
        if (dragged) return true;
        handleClick({ type: 'channel', name }).then(() => draw()).catch(() => draw());
        return false;
      }
      return false;
    }

    if (mouse.kind === 'move' && channelDrag && mouse.button === 0) {
      if (Math.abs(x - channelDrag.startX) >= 2) {
        channelDrag.moved = true;
        reorderChannelsByX(x);
        return true;
      }
      return false;
    }

    if (mouse.kind === 'move' && (draggingScroll || (mouse.motion && mouse.button === 0 && lastFrame.regions.scrollbar
      && x >= lastFrame.regions.scrollbar.x))) {
      draggingScroll = true;
      state.scrollOffset = scrollOffsetFromY(y, lastFrame.regions.scrollbar, lastFrame.maxScroll);
      if (state.overlay && state.overlay.type === 'delete') {
        state.scrollOffset = clampScrollForMessage(
          state.scrollOffset,
          lastFrame.messageBounds,
          lastFrame.totalLines,
          lastFrame.regions.transcript.h
        );
      }
      return true;
    }

    if (mouse.kind === 'move') {
      if (state.overlay && state.overlay.type === 'delete') return false;
      return applyHover(hit);
    }

    if (mouse.kind === 'press' && mouse.button === 0) {
      if (hit && hit.type === 'channel') {
        channelDrag = { name: hit.name, startX: x, moved: false };
        return false;
      }
      handleClick(hit).then(() => draw()).catch(() => draw());
      return false;
    }
    return false;
  }

  function insertComposer(ch) {
    if (state.overlay && state.overlay.type === 'save') {
      const value = state.overlay.value || '';
      const at = state.overlay.caret || value.length;
      state.overlay.value = value.slice(0, at) + ch + value.slice(at);
      state.overlay.caret = at + 1;
      return;
    }
    if (state.composer.length >= MAX_COMPOSER) return;
    const at = state.composerCaret;
    state.composer = state.composer.slice(0, at) + ch + state.composer.slice(at);
    state.composerCaret = at + 1;
  }

  function backspaceComposer() {
    if (state.overlay && state.overlay.type === 'save') {
      const value = state.overlay.value || '';
      const at = state.overlay.caret || value.length;
      if (at > 0) {
        state.overlay.value = value.slice(0, at - 1) + value.slice(at);
        state.overlay.caret = at - 1;
      }
      return;
    }
    const at = state.composerCaret;
    if (at > 0) {
      state.composer = state.composer.slice(0, at - 1) + state.composer.slice(at);
      state.composerCaret = at - 1;
    }
  }

  function applyScroll(delta) {
    if (!lastFrame) lastFrame = buildChatFrame(size().cols, size().rows, state);
    let next = Math.max(0, Math.min(lastFrame.maxScroll, (state.scrollOffset || 0) + delta));
    if (state.overlay && state.overlay.type === 'delete' && lastFrame.messageBounds) {
      next = clampScrollForMessage(
        next,
        lastFrame.messageBounds,
        lastFrame.totalLines,
        lastFrame.regions.transcript.h
      );
    }
    state.scrollOffset = next;
  }

  function moveComposer(delta) {
    if (state.overlay && state.overlay.type === 'save') {
      const len = (state.overlay.value || '').length;
      state.overlay.caret = Math.max(0, Math.min(len, (state.overlay.caret || 0) + delta));
      return;
    }
    state.composerCaret = Math.max(0, Math.min(state.composer.length, state.composerCaret + delta));
  }

  function consumeEscape(sequence) {
    if (sequence.startsWith('\u001b[200~') || sequence.startsWith('\u001b[201~')) return 0;
    const match = String(sequence).match(/^\u001b\[[0-9;<=>?]*[@-~]/);
    if (!match) return 0;
    const seq = match[0];
    if (seq.startsWith('\u001b[<')) {
      const mouse = ansi.parseSgrMouse(seq);
      if (mouse) {
        const changed = handleMouse(mouse);
        if (changed) draw();
      }
    } else {
      const motion = seq.match(/^\u001b\[(\d*)([ABCD])$/);
      if (motion) {
        const count = motion[1] ? Number(motion[1]) : 1;
        if (motion[2] === 'D') moveComposer(-count);
        else if (motion[2] === 'C') moveComposer(count);
        else if (motion[2] === 'A') {
          if (state.creatingChannel) { /* ignore */ }
          else applyScroll(1);
        } else if (motion[2] === 'B') {
          applyScroll(-1);
        }
        draw();
      } else if (seq === '\u001b[H') {
        state.composerCaret = 0;
        draw();
      } else if (seq === '\u001b[F') {
        state.composerCaret = state.composer.length;
        draw();
      } else if (seq === '\u001b[5~') {
        applyScroll(10);
        draw();
      } else if (seq === '\u001b[6~') {
        applyScroll(-10);
        draw();
      } else if (seq === '\u001b[Z') {
        if (!(state.overlay && state.overlay.type === 'delete')) {
          cycleChannel(-1).then(() => draw()).catch(() => draw());
        }
      }
    }
    return seq.length;
  }

  function handleKey(ch) {
    if (ch === '\u001b') {
      if (state.overlay) {
        closeOverlay();
        draw();
        return;
      }
      if (state.renamingChannel) {
        state.renamingChannel = null;
        state.channelDraft = '';
        state.channelMenu = null;
        draw();
        return;
      }
      if (state.creatingChannel) {
        state.creatingChannel = false;
        state.channelDraft = '';
        draw();
        return;
      }
      if (state.channelMenu) {
        state.channelMenu = null;
        draw();
        return;
      }
      if (state.replyTo || state.editingId) {
        cancelComposeMode();
        draw();
        return;
      }
      if (state.selectedMessageId) {
        clearSelection();
        draw();
        return;
      }
      if (state.activeGroupId) {
        loadGroup(null).then(() => draw()).catch(() => draw());
      }
      return;
    }
    if (state.overlay && state.overlay.type === 'delete') {
      if (ch === '\r' || ch === '\n') {
        performDelete(state.overlay.messageId).then(() => draw()).catch(() => draw());
      }
      return;
    }
    if (state.renamingChannel) {
      if (ch === '\r' || ch === '\n') {
        finishChannelRename().then(() => draw()).catch(() => draw());
        return;
      }
      if (ch === '\u007f' || ch === '\b') {
        state.channelDraft = state.channelDraft.slice(0, -1);
        draw();
        return;
      }
      if (ch >= ' ' && state.channelDraft.length < 12) {
        state.channelDraft += ch;
        draw();
      }
      return;
    }
    if (state.channelMenu && !state.renamingChannel) {
      if (ch === 'r') { startChannelRename(state.channelMenu); draw(); return; }
      if (ch === 'd') { deleteChannel(state.channelMenu).then(() => draw()).catch(() => draw()); return; }
    }
    if (state.creatingChannel) {
      if (ch === '\r' || ch === '\n') {
        createChannel(state.channelDraft).then(() => draw()).catch(() => draw());
        return;
      }
      if (ch === '\u007f' || ch === '\b') {
        state.channelDraft = state.channelDraft.slice(0, -1);
        draw();
        return;
      }
      if (ch >= ' ' && state.channelDraft.length < 12) {
        state.channelDraft += ch;
        draw();
      }
      return;
    }
    if (ch === '\r') {
      submitComposer().then(() => draw()).catch((err) => {
        setError(err.message || String(err));
        draw();
      });
      return;
    }
    if (ch === '\n') {
      insertComposer('\n');
      draw();
      return;
    }
    if (ch === '\t') {
      if (state.overlay && state.overlay.type === 'delete') return;
      cycleChannel(1).then(() => draw()).catch(() => draw());
      return;
    }
    if (ch === '\u0016') {
      uploadPastedImage().then((ok) => { if (!ok) draw(); }).catch(() => draw());
      return;
    }
    if (ch === '\u007f' || ch === '\b') {
      backspaceComposer();
      draw();
      return;
    }
    if (ch < ' ') return;
    if (shortcutsArmed()) {
      const item = findMessage(state.selectedMessageId);
      if (ch === 'r') { runAction('reply', item).then(() => draw()); return; }
      if (ch === 'e') { runAction('edit', item).then(() => draw()); return; }
      if (ch === 'd') { runAction('delete', item).then(() => draw()); return; }
      if (ch === 'p') { runAction('preview', item).then(() => draw()); return; }
    }
    pokeTyping();
    insertComposer(ch);
    draw();
  }

  function pushInput(str) {
    let rest = inputBuffer + String(str);
    inputBuffer = '';
    const pasteOpen = rest.indexOf('\u001b[200~');
    if (pasteOpen !== -1) {
      const close = rest.indexOf('\u001b[201~', pasteOpen);
      if (close === -1) {
        inputBuffer = rest.slice(0, 8192);
        return;
      }
      const before = rest.slice(0, pasteOpen);
      const pasted = rest.slice(pasteOpen + 6, close);
      const after = rest.slice(close + 6);
      if (before) pushInput(before);
      handlePasteText(pasted).then((used) => {
        if (!used) {
          for (const ch of pasted) handleKey(ch);
        }
        if (after) pushInput(after);
        draw();
      }).catch(() => draw());
      return;
    }
    while (rest.length > 0) {
      const escAt = rest.indexOf('\u001b');
      if (escAt === -1) {
        for (const ch of rest) handleKey(ch);
        return;
      }
      if (escAt > 0) {
        for (const ch of rest.slice(0, escAt)) handleKey(ch);
        rest = rest.slice(escAt);
        continue;
      }
      if (rest === '\u001b') {
        handleKey('\u001b');
        return;
      }
      if (rest.startsWith('\u001b[200~')) {
        inputBuffer = rest.slice(0, 8192);
        return;
      }
      const consumed = consumeEscape(rest);
      if (consumed === 0) {
        inputBuffer = rest.slice(0, 64);
        return;
      }
      rest = rest.slice(consumed);
    }
  }

  return {
    state,
    start,
    stop,
    draw,
    pushInput,
    handleMouse,
    loadGroup,
    switchChannel,
    beginReply,
    beginEdit,
    previewAttachment,
    findMessage,
  };
}

/** Kept so older callers that imported runChatTui still resolve. */
async function runChatTui() {
  throw new Error('runChatTui is now driven by app.js via createChatController');
}

module.exports = {
  createChatController,
  defaultChatState,
  runChatTui,
};
