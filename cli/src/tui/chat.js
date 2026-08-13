'use strict';

/**
 * Mini GChat screen: groups | channels | transcript | composer.
 *
 * Hover lights the whole message and reveals Unicode actions on the right
 * (↩ reply, ✎ edit, × delete). A click on an attachment card decrypts it
 * and opens a reveal overlay (open / save).
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
  formatBytes,
} = require('./chat-layout');
const { clampScroll } = require('./landing');
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
      };
    }
    const dec = await decryptServerMessage(msg, secret, groupId);
    return { msg, ...dec, attach: null };
  }

  async function loadGroup(group) {
    if (!group) {
      state.activeGroupId = null;
      state.messages = [];
      state.channels = ['main'];
      state.activeChannel = 'main';
      setStatus(state.groups.length ? 'pick a chat' : 'no chats yet');
      return;
    }
    state.loading = true;
    state.activeGroupId = group.id;
    client.setActiveGroup(group.id);
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
      state.channels = listChannels(group.id, paths);
      state.activeChannel = getActiveChannel(group.id, paths) || 'main';
      state.scrollOffset = 0;
      state.hoverMessageId = null;
      state.hoverAction = null;
      state.loading = false;
      setStatus(`${group.name || 'chat'}  #${state.activeChannel}`);
    } catch (err) {
      state.loading = false;
      setError(err.message || String(err));
    }
  }

  async function switchChannel(name) {
    if (!state.activeGroupId) return;
    const next = client.switchChannel(state.activeGroupId, name);
    state.activeChannel = next;
    state.scrollOffset = 0;
    const group = state.groups.find((g) => String(g.id) === String(state.activeGroupId));
    setStatus(`${group?.name || 'chat'}  #${next}`);
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
    draw();
  }

  function stop() {
    running = false;
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
      if (String(payload.groupId) !== String(state.activeGroupId)) return;
      const item = await decorate(payload, payload.groupId);
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
    }
  }

  function findMessage(id) {
    return state.messages.find((m) => String(m.msg.id) === String(id)) || null;
  }

  function applyHover(hit) {
    const nextId = hit && (hit.type === 'message' || hit.type === 'action' || hit.type === 'card')
      ? String(hit.id)
      : null;
    const nextAction = hit && hit.type === 'action' ? hit.action : null;
    const key = `${nextId || ''}:${nextAction || ''}`;
    if (key === lastHoverKey) return false;
    lastHoverKey = key;
    state.hoverMessageId = nextId;
    state.hoverAction = nextAction;
    return true;
  }

  async function beginReply(item) {
    if (!item) return;
    state.editingId = null;
    state.replyTo = {
      id: item.msg.id,
      name: item.msg.senderName || item.msg.senderId || 'reply',
      preview: (item.text || item.attach?.filename || '').slice(0, 40),
    };
    setStatus(`↩  ${state.replyTo.name}`);
  }

  function beginEdit(item) {
    if (!item || isAttach(item)) return;
    state.replyTo = null;
    state.editingId = item.msg.id;
    state.composer = item.text || '';
    state.composerCaret = state.composer.length;
    setStatus('editing');
  }

  function isAttach(item) {
    return item?.msg?.type === 'image' || item?.msg?.type === 'file';
  }

  function cancelComposeMode() {
    state.replyTo = null;
    state.editingId = null;
    setStatus(statusForGroup());
  }

  function statusForGroup() {
    const group = state.groups.find((g) => String(g.id) === String(state.activeGroupId));
    if (!group) return state.groups.length ? 'pick a chat' : 'no chats yet';
    return `${group.name || 'chat'}  #${state.activeChannel || 'main'}`;
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

  async function revealAttachment(item) {
    state.overlay = {
      type: 'reveal',
      messageId: item.msg.id,
      filename: item.attach?.filename || (item.msg.type === 'image' ? 'image' : 'file'),
      kind: item.msg.type === 'image' ? 'image' : 'file',
      size: item.attach?.size != null ? formatBytes(item.attach.size) : '',
      opened: false,
      error: null,
    };
    draw();
    try {
      const entry = await materializeAttachment(item);
      state.overlay.filename = entry.filename;
      state.overlay.size = formatBytes(entry.size);
      state.overlay.kind = item.msg.type === 'image' ? 'image' : 'file';
      state.overlay.opened = openPath(entry.path);
      if (!state.overlay.opened) state.overlay.error = 'could not open';
    } catch (err) {
      state.overlay.error = err.message || String(err);
    }
    draw();
  }

  async function saveAttachmentTo(item, dest) {
    const entry = await materializeAttachment(item);
    const target = path.resolve(dest || entry.filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(entry.path, target);
    return target;
  }

  async function confirmDelete(item) {
    state.overlay = { type: 'delete', messageId: item.msg.id };
  }

  async function performDelete(messageId) {
    try {
      await client.deleteMessage(state.activeGroupId, messageId);
      state.messages = state.messages.filter((m) => String(m.msg.id) !== String(messageId));
      closeOverlay();
      setStatus(statusForGroup());
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
        setStatus(statusForGroup());
        return;
      }
      const result = await client.sendText({
        groupId: state.activeGroupId,
        text,
        replyToId: state.replyTo?.id || null,
      });
      upsertMessage({
        msg: {
          id: result.messageId,
          groupId: state.activeGroupId,
          senderId: state.userId,
          senderName: state.username,
          type: 'text',
          createdAt: new Date().toISOString(),
        },
        text,
        channel: state.activeChannel || 'main',
        error: null,
        attach: null,
      });
      state.composer = '';
      state.composerCaret = 0;
      state.replyTo = null;
      state.scrollOffset = 0;
      setStatus(statusForGroup());
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

  async function handleOverlayButton(action) {
    const overlay = state.overlay;
    if (!overlay) return;
    if (action === 'cancel') {
      closeOverlay();
      return;
    }
    if (overlay.type === 'delete' && action === 'confirm') {
      await performDelete(overlay.messageId);
      return;
    }
    if (overlay.type === 'reveal') {
      const item = findMessage(overlay.messageId);
      if (!item) return;
      if (action === 'open') {
        await revealAttachment(item);
        return;
      }
      if (action === 'save') {
        const filename = item.attach?.filename || overlay.filename || 'file';
        const home = os.homedir();
        const downloads = path.join(home, 'Downloads');
        const dir = fs.existsSync(downloads) ? downloads : home;
        state.overlay = {
          type: 'save',
          messageId: item.msg.id,
          filename,
          value: path.join(dir, filename),
          caret: path.join(dir, filename).length,
        };
      }
      return;
    }
    if (overlay.type === 'save' && action === 'confirm') {
      const item = findMessage(overlay.messageId);
      if (!item) return;
      try {
        const dest = await saveAttachmentTo(item, overlay.value || overlay.filename);
        state.overlay = {
          type: 'reveal',
          messageId: item.msg.id,
          filename: path.basename(dest),
          kind: item.msg.type === 'image' ? 'image' : 'file',
          size: item.attach?.size != null ? formatBytes(item.attach.size) : '',
          opened: false,
          error: `saved ${dest}`,
        };
      } catch (err) {
        state.overlay = { type: 'error', message: err.message || String(err) };
      }
    }
  }

  async function handleClick(hit) {
    if (!hit) return;
    if (hit.type === 'overlay-button') {
      await handleOverlayButton(hit.action);
      return;
    }
    if (hit.type === 'overlay') return;
    if (state.overlay) {
      closeOverlay();
      return;
    }
    if (hit.type === 'group') {
      const group = state.groups.find((g) => String(g.id) === String(hit.id));
      if (group) await loadGroup(group);
      return;
    }
    if (hit.type === 'channel') {
      await switchChannel(hit.name);
      return;
    }
    if (hit.type === 'action') {
      const item = findMessage(hit.id);
      if (!item) return;
      if (hit.action === 'reply') await beginReply(item);
      else if (hit.action === 'edit') beginEdit(item);
      else if (hit.action === 'delete') await confirmDelete(item);
      return;
    }
    if (hit.type === 'card') {
      const item = findMessage(hit.id);
      if (item) await revealAttachment(item);
    }
  }

  function handleMouse(mouse) {
    if (!lastFrame) lastFrame = buildChatFrame(size().cols, size().rows, state);
    const x = mouse.x - 1;
    const y = mouse.y - 1;
    const hit = hitTest(lastFrame.hits, x, y);

    if (mouse.kind === 'wheel') {
      if (state.overlay) return false;
      const region = lastFrame.regions.transcript;
      if (x >= region.x && x < region.x + region.w && y >= region.y && y < region.y + region.h) {
        const next = (state.scrollOffset || 0) + (mouse.wheel < 0 ? 1 : -1);
        state.scrollOffset = Math.max(0, Math.min(lastFrame.maxScroll, next));
        return true;
      }
      return false;
    }

    if (mouse.kind === 'move') {
      if (state.overlay) return false;
      return applyHover(hit);
    }

    if (mouse.kind === 'press' && mouse.button === 0) {
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
    const { cols } = size();
    const mainW = Math.max(1, cols - (lastFrame ? lastFrame.regions.transcript.x : 0));
    state.composerScroll = clampScroll(state.composerScroll, state.composerCaret, state.composer.length, mainW);
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

  function moveComposer(delta) {
    if (state.overlay && state.overlay.type === 'save') {
      const len = (state.overlay.value || '').length;
      state.overlay.caret = Math.max(0, Math.min(len, (state.overlay.caret || 0) + delta));
      return;
    }
    state.composerCaret = Math.max(0, Math.min(state.composer.length, state.composerCaret + delta));
  }

  function consumeEscape(sequence) {
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
          state.scrollOffset = Math.min((lastFrame?.maxScroll || 0), (state.scrollOffset || 0) + 1);
        } else if (motion[2] === 'B') {
          state.scrollOffset = Math.max(0, (state.scrollOffset || 0) - 1);
        }
        draw();
      } else if (seq === '\u001b[H') {
        state.composerCaret = 0;
        draw();
      } else if (seq === '\u001b[F') {
        state.composerCaret = state.composer.length;
        draw();
      } else if (seq === '\u001b[5~') {
        state.scrollOffset = Math.min((lastFrame?.maxScroll || 0), (state.scrollOffset || 0) + 10);
        draw();
      } else if (seq === '\u001b[6~') {
        state.scrollOffset = Math.max(0, (state.scrollOffset || 0) - 10);
        draw();
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
      if (state.replyTo || state.editingId) {
        cancelComposeMode();
        if (state.editingId) {
          /* already cleared */
        }
        state.editingId = null;
        draw();
      }
      return;
    }
    if (ch === '\r' || ch === '\n') {
      if (state.overlay) {
        if (state.overlay.type === 'delete') performDelete(state.overlay.messageId).then(() => draw()).catch(() => draw());
        else if (state.overlay.type === 'save') handleOverlayButton('confirm').then(() => draw()).catch(() => draw());
        else closeOverlay();
        draw();
        return;
      }
      submitComposer().then(() => draw()).catch((err) => {
        setError(err.message || String(err));
        draw();
      });
      return;
    }
    if (ch === '\t') return;
    if (ch === '\u007f' || ch === '\b') {
      backspaceComposer();
      draw();
      return;
    }
    if (ch < ' ') return;
    insertComposer(ch);
    draw();
  }

  function pushInput(str) {
    let rest = inputBuffer + String(str);
    inputBuffer = '';
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
    revealAttachment,
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
