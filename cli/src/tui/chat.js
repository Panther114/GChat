'use strict';

/**
 * GChat CLI screen: groups | channels | transcript | composer.
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
  hitTest,
  TRANSITION_MS,
  scrollOffsetFromDrag,
  scrollOffsetFromY,
  clampScrollForMessage,
  filterMessages,
  CHANNEL_EXPAND_FRAMES,
  PROFILE_FRAMES,
  HISTORY_PAGE,
  SCROLL_TWEEN_MS,
  BIRD_FLIGHT_MS,
  idleBirdOrigin,
  composerMetrics,
  offsetToShowMessage,
  nameColor,
  hashNameColor,
  WHEEL_LINES,
} = require('./chat-layout');
const { looksLikeImagePath, readClipboardImage } = require('./clipboard-image');
const { loadConfig, setConfigKey } = require('../store/config');
const { normalizeTheme, nextTheme } = require('./theme');
const { createScreenPainter } = require('./paint');
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
  forgetChannel,
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

function createChatController({ client, paths, stdout, getSize, onDraw, onQuit, onLogout, painter } = {}) {
  const storedTheme = paths ? loadConfig(paths).theme : 'dark';
  const state = defaultChatState({
    username: client?.user?.username || '',
    userId: client?.user?.id || null,
    status: 'connecting',
    theme: normalizeTheme(storedTheme),
  });

  let lastFrame = null;
  let lastHoverKey = '';
  let inputBuffer = '';
  let escTimer = null;
  let running = false;
  let pulseTimer = null;
  const screen = painter || createScreenPainter();
  const PULSE_MS = 50;
  let coalescedMove = null;
  let coalesceTimer = null;
  let allowAutoLoad = true;
  let draggingScroll = null;
  let draggingComposer = null;
  let selectMode = false;
  let textDrag = null;
  let groupLoadSeq = 0;
  let channelDrag = null;
  let typingTimer = null;
  let typingSent = false;
  const markedRead = new Set();
  const mediaCache = new Map(); // messageId -> { path, filename, mimeType, size, bytes }

  function size() {
    if (typeof getSize === 'function') return getSize();
    return {
      cols: (stdout && stdout.columns) || 80,
      rows: (stdout && stdout.rows) || 24,
    };
  }

  function draw(opts = {}) {
    const { cols, rows } = size();
    lastFrame = buildChatFrame(cols, rows, state);
    if (lastFrame.composerMetrics) {
      state.composerScroll = lastFrame.composerMetrics.lineScroll;
    }
    if (stdout) {
      const bytes = screen.paintRaw(lastFrame.lines, cols, rows, {
        theme: state.theme,
        force: !!opts.force,
        scene: 'chat',
      });
      if (bytes) stdout.write(bytes);
    }
    if (typeof onDraw === 'function') onDraw(lastFrame);
    if (lastFrame.shouldLoadMore && !state.loadingMore) {
      loadOlderMessages().then(() => draw()).catch(() => draw());
    }
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

  function isFrozen() {
    return !!(state.overlay && state.overlay.type === 'delete');
  }

  function needsPulse() {
    if (state.transition) return true;
    if (state.loadingGroup) return true;
    if (state.typing) return true;
    if (state.overlay && state.overlay.type === 'delete') return true;
    if (state.loadingMore) return true;
    if (state.scrollTween) return true;
    if (state.birdFlight) return true;
    if (state.hoverLogout && (state.profileOpen || state.profileExpandFrame)) return true;
    if (state.hoverTheme && (state.profileOpen || state.profileExpandFrame)) return true;
    if (state.profileClosing && (state.profileExpandFrame || 0) > 0) return true;
    if (state.profileOpen && (state.profileExpandFrame || 0) < PROFILE_FRAMES) return true;
    if (state.channelClosing && (state.channelExpandFrame || 0) > 0) return true;
    if (state.channelMenu && !state.channelClosing && (state.channelExpandFrame || 0) < CHANNEL_EXPAND_FRAMES) {
      return true;
    }
    return (state.messages || []).some((item) => item.sending);
  }

  function startPulse() {
    if (pulseTimer) return;
    pulseTimer = setInterval(() => {
      state.animFrame = (state.animFrame || 0) + 1;
      if (state.transition && Date.now() >= state.transition.until && !state.loadingGroup) {
        state.transition = null;
      }
      if (state.typing && state.typing.until && Date.now() >= state.typing.until) {
        state.typing = null;
      }
      if (state.birdFlight) {
        const flight = state.birdFlight;
        if (Date.now() >= Number(flight.at || 0) + Number(flight.ms || BIRD_FLIGHT_MS)) {
          state.birdFlight = null;
        }
      }
      if (state.scrollTween) {
        const tween = state.scrollTween;
        const t = Math.min(1, (Date.now() - tween.at) / Math.max(1, tween.ms));
        const eased = 1 - (1 - t) * (1 - t);
        state.scrollOffset = Math.round(tween.from + (tween.to - tween.from) * eased);
        if (t >= 1) state.scrollTween = null;
      }
      if (state.profileClosing) {
        if ((state.profileExpandFrame || 0) > 0) state.profileExpandFrame -= 1;
        else {
          state.profileOpen = false;
          state.profileClosing = false;
        }
      } else if (state.profileOpen && (state.profileExpandFrame || 0) < PROFILE_FRAMES) {
        state.profileExpandFrame = (state.profileExpandFrame || 0) + 1;
      }
      if (state.channelClosing) {
        if ((state.channelExpandFrame || 0) > 0) {
          state.channelExpandFrame -= 1;
        } else {
          snapCloseChannelMenu();
        }
      } else if (state.channelMenu && (state.channelExpandFrame || 0) < CHANNEL_EXPAND_FRAMES) {
        state.channelExpandFrame = (state.channelExpandFrame || 0) + 1;
      }
      if (!needsPulse()) {
        clearInterval(pulseTimer);
        pulseTimer = null;
      }
      draw();
    }, PULSE_MS);
  }

  function beginTransition(kind = 'group') {
    state.transition = { until: Date.now() + TRANSITION_MS, kind };
    startPulse();
  }

  async function refreshMemberCount(groupId = state.activeGroupId) {
    if (!groupId || typeof client.listMembers !== 'function') return;
    try {
      const members = await client.listMembers(groupId);
      state.memberCount = Array.isArray(members) ? members.length : 0;
    } catch {
      /* keep last known count */
    }
  }

  function markVisibleRead() {
    if (!state.activeGroupId || typeof client.markRead !== 'function') return;
    const list = filterMessages(state.messages, state.activeChannel);
    let n = 0;
    for (let i = list.length - 1; i >= 0 && n < 20; i -= 1) {
      const item = list[i];
      const id = item?.msg?.id;
      if (!id || item.sending) continue;
      if (state.userId && String(item.msg.senderId) === String(state.userId)) continue;
      const key = String(id);
      if (item.msg.hasRead || markedRead.has(key)) continue;
      try { client.markRead(state.activeGroupId, id); } catch { /* ignore */ }
      markedRead.add(key);
      item.msg.hasRead = true;
      n += 1;
    }
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
    if (state.messages.length > 500) {
      state.messages.splice(0, state.messages.length - 500);
      state.hasMoreHistory = true;
    }
  }

  async function loadOlderMessages() {
    if (isFrozen() || state.loadingMore || !state.hasMoreHistory || !state.activeGroupId) return;
    const oldest = state.messages.find((item) => item?.msg?.id && !item.sending);
    if (!oldest) {
      state.hasMoreHistory = false;
      return;
    }
    const forGroup = String(state.activeGroupId);
    const seq = groupLoadSeq;
    state.loadingMore = true;
    startPulse();
    const prevOffset = state.scrollOffset || 0;
    try {
      const page = await client.fetchMessages(state.activeGroupId, {
        limit: HISTORY_PAGE,
        before: oldest.msg.id,
      });
      if (seq !== groupLoadSeq || String(state.activeGroupId) !== forGroup) {
        state.loadingMore = false;
        return;
      }
      const incoming = [];
      for (const msg of page || []) {
        if (seq !== groupLoadSeq || String(state.activeGroupId) !== forGroup) {
          state.loadingMore = false;
          return;
        }
        incoming.push(await decorate(msg, state.activeGroupId));
      }
      if (seq !== groupLoadSeq || String(state.activeGroupId) !== forGroup) {
        state.loadingMore = false;
        return;
      }
      for (const item of incoming) upsertMessage(item);
      state.hasMoreHistory = (page || []).length >= HISTORY_PAGE;
      lastFrame = buildChatFrame(size().cols, size().rows, state);
      state.scrollOffset = Math.max(0, Math.min(lastFrame.maxScroll, prevOffset));
      if (state.pendingFocusId && findMessage(state.pendingFocusId)) {
        const id = state.pendingFocusId;
        state.pendingFocusId = null;
        beginScrollToMessage(id);
      }
    } catch (err) {
      state.hasMoreHistory = false;
      setError(err.message || String(err));
    }
    state.loadingMore = false;
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
    const resolvedName = name || (preview && rest.length ? maybeName.trim() : 'message');
    return {
      id: replyId,
      name: resolvedName,
      preview: rest.length ? rest.join(':').trim() : text,
      color: original ? nameColor(original) : hashNameColor(resolvedName),
    };
  }

  async function loadGroup(group) {
    if (state.overlay && state.overlay.type === 'delete') return;
    const seq = ++groupLoadSeq;
    const stillCurrent = () => seq === groupLoadSeq;
    if (!group) {
      state.activeGroupId = null;
      state.messages = [];
      state.channels = ['main'];
      state.activeChannel = 'main';
      state.hoverMessageId = null;
      state.channelMenu = null;
      state.channelExpandFrame = CHANNEL_EXPAND_FRAMES;
      state.memberCount = 0;
      state.loadingGroup = false;
      state.hasMoreHistory = false;
      state.loadingMore = false;
      state.transition = null;
      const prefs = loadPrefs(paths);
      prefs.activeGroupId = null;
      savePrefs(prefs, paths);
      return;
    }
    state.activeGroupId = group.id;
    state.messages = [];
    state.channels = [];
    state.hoverMessageId = null;
    state.hoverAction = null;
    state.selectedMessageId = null;
    state.channelMenu = null;
    state.channelExpandFrame = CHANNEL_EXPAND_FRAMES;
    state.memberCount = 0;
    state.scrollOffset = 0;
    state.loadingGroup = true;
    markedRead.clear();
    client.setActiveGroup(group.id);
    const groupRef = state.groups.find((g) => String(g.id) === String(group.id));
    if (groupRef) groupRef.unreadCount = 0;
    beginTransition('group');
    draw();
    try {
      const opened = await client.openGroup(group.id);
      if (!stillCurrent()) return;
      await refreshMemberCount(group.id);
      if (!stillCurrent()) return;
      const decrypted = [];
      for (const msg of opened.messages || []) {
        if (!stillCurrent()) return;
        decrypted.push(await decorate(msg, group.id));
      }
      if (!stillCurrent()) return;
      state.messages = decrypted;
      const prefs = loadPrefs(paths);
      for (const item of decrypted) {
        if (item.channel) rememberChannel(group.id, item.channel, prefs);
      }
      savePrefs(prefs, paths);
      const nextChannels = listChannels(group.id, paths);
      const nextActive = getActiveChannel(group.id, paths) || 'main';
      await waitTransition();
      if (!stillCurrent()) return;
      state.channels = nextChannels;
      state.activeChannel = nextActive;
      state.hasMoreHistory = (opened.messages || []).length >= HISTORY_PAGE;
      state.loadingMore = false;
      state.loadingGroup = false;
      state.transition = null;
      markVisibleRead();
    } catch (err) {
      if (!stillCurrent()) return;
      state.loadingGroup = false;
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
    beginTransition('channel');
    draw();
    await waitTransition();
    markVisibleRead();
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
    if (isFrozen()) return;
    if (delta) {
      allowAutoLoad = true;
      state.scrollTween = null;
    }
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

  function moveSelection(delta) {
    const list = filterMessages(state.messages, state.activeChannel);
    if (!list.length) return;
    const idx = list.findIndex((m) => String(m.msg?.id) === String(state.selectedMessageId));
    const next = idx < 0 ? (delta > 0 ? 0 : list.length - 1) : idx + delta;
    if (next < 0 || next >= list.length) return;
    selectMessage(list[next]);
    lastFrame = buildChatFrame(size().cols, size().rows, state);
    if (lastFrame.selectedBounds) {
      state.scrollOffset = clampScrollForMessage(
        state.scrollOffset,
        lastFrame.selectedBounds,
        lastFrame.totalLines,
        lastFrame.regions.transcript.h
      );
    }
  }

  async function refreshGroups() {
    try {
      state.groups = await client.listGroups();
    } catch (err) {
      state.groups = state.groups || [];
      setError(err.message || String(err));
    }
  }

  async function start(opts = {}) {
    running = true;
    state.status = 'connecting';
    state.username = client.user?.username || state.username;
    state.userId = client.user?.id || state.userId;
    state.iconColor = client.user?.iconColor || state.iconColor;
    client.onEvent = (event, payload) => {
      handleEvent(event, payload).catch(() => {});
    };
    if (opts.birdFrom && Number.isFinite(opts.birdFrom.x) && Number.isFinite(opts.birdFrom.y)) {
      const dest = idleBirdOrigin(size().cols, size().rows, state);
      state.birdFlight = {
        fromX: opts.birdFrom.x,
        fromY: dest.y,
        toX: dest.x,
        toY: dest.y,
        at: Date.now(),
        ms: BIRD_FLIGHT_MS,
      };
      startPulse();
    }
    // Clean first chrome paint, then the bird hops middle → right.
    draw({ force: !!opts.forcePaint });
    try {
      const me = client.user || (typeof client.me === 'function' ? await client.me() : null);
      if (me) {
        state.username = me.username;
        state.userId = me.id;
        state.iconColor = me.iconColor || me.senderColor || state.iconColor;
      }
    } catch {
      /* session may already be warm */
    }
    await refreshGroups();
    state.status = '';
    draw();
    if (typeof client.connectSocket === 'function') {
      client.connectSocket().then(() => {
        if (!running) return;
        state.connected = true;
        draw();
      }).catch((err) => {
        if (!running) return;
        state.connected = false;
        setError(err.message || 'socket failed');
        draw();
      });
    }
    await loadGroup(null);
    if (needsPulse()) startPulse();
    draw();
  }

  function stop() {
    running = false;
    if (pulseTimer) {
      clearInterval(pulseTimer);
      pulseTimer = null;
    }
    if (coalesceTimer) {
      clearImmediate(coalesceTimer);
      coalesceTimer = null;
    }
    coalescedMove = null;
    setSelectMode(false);
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
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
      markVisibleRead();
      draw();
      return;
    }
    if (event === 'message_read_update' && payload?.messageId) {
      const item = findMessage(payload.messageId);
      if (item?.msg) {
        item.msg.readCount = Math.max(0, Number(payload.readCount) || 0);
        draw();
      }
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
    if ((event === 'channel_announced' || event === 'channel_announce') && payload?.channel && payload.groupId) {
      if (String(payload.groupId) !== String(state.activeGroupId)) return;
      const action = payload.action === 'remove' || payload.action === 'delete' ? 'remove' : 'add';
      if (action === 'remove') {
        state.channels = forgetChannel(payload.groupId, payload.channel, paths);
        if (state.activeChannel === payload.channel) await switchChannel('main');
      } else {
        const prefs = loadPrefs(paths);
        rememberChannel(payload.groupId, payload.channel, prefs, { force: true });
        savePrefs(prefs, paths);
        state.channels = listChannels(payload.groupId, paths);
      }
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
      return;
    }
    if (event === 'member_joined' || event === 'member_left' || event === 'member_kicked') {
      if (payload?.groupId && String(payload.groupId) === String(state.activeGroupId)) {
        await refreshMemberCount(payload.groupId);
        draw();
      }
    }
  }

  function findMessage(id) {
    return state.messages.find((m) => String(m.msg.id) === String(id)) || null;
  }

  function clearHover() {
    const had = !!(
      state.hoverMessageId
      || state.hoverAction
      || state.hoverChannel
      || state.hoverLogout
      || state.hoverTheme
      || state.hoverReply
    );
    if (!had && lastHoverKey === '') return false;
    state.hoverMessageId = null;
    state.hoverAction = null;
    state.hoverChannel = null;
    state.hoverLogout = false;
    state.hoverTheme = false;
    state.hoverReply = false;
    lastHoverKey = '';
    return had;
  }

  function applyHover(hit) {
    if (state.overlay && state.overlay.type === 'delete') return false;
    if (draggingScroll || channelDrag || (screen && typeof screen.isOverloaded === 'function' && screen.isOverloaded())) {
      return clearHover();
    }
    const nextId = hit && (hit.type === 'message' || hit.type === 'message-text' || hit.type === 'action' || hit.type === 'card' || hit.type === 'reply-ref')
      ? String(hit.type === 'reply-ref' ? hit.parentId : hit.id)
      : null;
    const nextAction = hit && hit.type === 'action' ? hit.action : null;
    const nextChannel = hit && (hit.type === 'channel' || hit.type === 'create-channel')
      ? String(hit.name || '+')
      : null;
    const nextLogout = !!(hit && hit.type === 'logout');
    const nextThemeHit = !!(hit && hit.type === 'theme');
    const nextReply = !!(hit && hit.type === 'reply-ref');
    const key = `${nextId || ''}:${nextAction || ''}:${nextChannel || ''}:${nextLogout ? 'out' : ''}:${nextThemeHit ? 'theme' : ''}:${nextReply ? 'reply' : ''}`;
    if (key === lastHoverKey) return false;
    lastHoverKey = key;
    state.hoverMessageId = nextId;
    state.hoverAction = nextAction;
    state.hoverChannel = nextChannel;
    state.hoverLogout = nextLogout;
    state.hoverTheme = nextThemeHit;
    state.hoverReply = nextReply;
    if (nextLogout || nextThemeHit) startPulse();
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

  function beginScrollToMessage(id) {
    const item = findMessage(id);
    if (!item) {
      state.pendingFocusId = id;
      allowAutoLoad = true;
      if (state.hasMoreHistory && !state.loadingMore) {
        loadOlderMessages().then(() => draw()).catch(() => draw());
      }
      return;
    }
    selectMessage(item);
    lastFrame = buildChatFrame(size().cols, size().rows, state);
    const bounds = lastFrame.selectedBounds;
    if (!bounds) return;
    const to = offsetToShowMessage(bounds, lastFrame.totalLines, lastFrame.regions.transcript.h);
    const from = state.scrollOffset || 0;
    if (from === to) return;
    state.scrollTween = { from, to, at: Date.now(), ms: SCROLL_TWEEN_MS };
    startPulse();
  }

  function toggleProfile() {
    if (state.profileOpen && !state.profileClosing) {
      state.profileClosing = true;
      startPulse();
      return;
    }
    state.profileOpen = true;
    state.profileClosing = false;
    state.profileExpandFrame = 0;
    startPulse();
  }

  async function logout() {
    try {
      if (typeof client.logout === 'function') await client.logout();
    } catch {
      /* still clear locally */
    }
    if (typeof onLogout === 'function') onLogout();
    else if (typeof onQuit === 'function') onQuit();
  }

  function toggleTheme() {
    state.theme = nextTheme(state.theme);
    try {
      if (paths) setConfigKey('theme', state.theme, paths);
    } catch {
      /* keep the in-session switch even if config cannot be written */
    }
  }

  function shortcutsArmed() {
    return !!(state.selectedMessageId && !state.composer && !state.editingId
      && !state.creatingChannel && !state.overlay && !state.channelMenu);
  }

  async function beginReply(item) {
    if (!item) return;
    if (state.editingId) cancelComposeMode();
    state.replyTo = {
      id: item.msg.id,
      name: item.msg.senderName || item.msg.senderId || 'reply',
      preview: (item.text || item.attach?.filename || '').slice(0, 40),
      color: nameColor(item),
    };
  }

  function beginEdit(item) {
    if (!item || isAttach(item)) return;
    state.replyTo = null;
    if (!state.editingId) {
      state.composerBeforeEdit = {
        text: state.composer || '',
        caret: state.composerCaret || 0,
      };
    }
    state.editingId = item.msg.id;
    state.composer = item.text || '';
    state.composerCaret = state.composer.length;
  }

  function isAttach(item) {
    return item?.msg?.type === 'image' || item?.msg?.type === 'file';
  }

  function cancelComposeMode() {
    if (state.editingId) {
      const prev = state.composerBeforeEdit;
      state.composer = prev ? prev.text : '';
      state.composerCaret = prev ? prev.caret : 0;
    }
    state.composerBeforeEdit = null;
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
        state.editingId = null;
        const prev = state.composerBeforeEdit;
        state.composer = prev ? prev.text : '';
        state.composerCaret = prev ? prev.caret : 0;
        state.composerBeforeEdit = null;
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

  function snapCloseChannelMenu() {
    state.channelMenu = null;
    state.channelClosing = false;
    state.channelExpandFrame = CHANNEL_EXPAND_FRAMES;
  }

  function beginChannelClose() {
    if (!state.channelMenu) return;
    state.channelClosing = true;
    if ((state.channelExpandFrame || 0) > CHANNEL_EXPAND_FRAMES) {
      state.channelExpandFrame = CHANNEL_EXPAND_FRAMES;
    }
    if ((state.channelExpandFrame || 0) <= 0) {
      snapCloseChannelMenu();
      return;
    }
    startPulse();
  }

  function openChannelMenu(name) {
    state.channelMenu = name;
    state.channelClosing = false;
    state.channelExpandFrame = 0;
    startPulse();
  }

  async function deleteChannel(name) {
    if (!name || name === 'main') {
      setError('cannot delete #main');
      return;
    }
    if (!state.activeGroupId) return;
    try {
      await client.connectSocket();
      client.announceChannel(state.activeGroupId, name, 'remove');
    } catch { /* still drop locally */ }
    state.channels = forgetChannel(state.activeGroupId, name, paths);
    snapCloseChannelMenu();
    if (state.activeChannel === name) await switchChannel('main');
  }

  function reorderChannelsByX(x) {
    if (!channelDrag || !lastFrame || !state.activeGroupId) return;
    if (channelDrag.name === 'main') return;
    const chips = lastFrame.hits.filter((h) => h.type === 'channel').sort((a, b) => a.x - b.x);
    if (chips.length < 2) return;
    let insertAt = chips.length - 1;
    for (let i = 0; i < chips.length; i += 1) {
      if (x < chips[i].x + chips[i].w / 2) {
        insertAt = i;
        break;
      }
    }
    if (insertAt < 1) insertAt = 1;
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
        rememberChannel(state.activeGroupId, normalized, prefs, { force: true });
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
    if (isFrozen()) {
      if (hit && hit.type === 'action' && hit.action === 'clear') {
        closeOverlay();
        clearSelection();
      }
      return;
    }
    if (!hit) return;
    if (hit.type === 'message-text') {
      hit = { ...hit, type: 'message' };
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
    if (hit.type === 'profile') {
      toggleProfile();
      return;
    }
    if (hit.type === 'logout') {
      await logout();
      return;
    }
    if (hit.type === 'theme') {
      toggleTheme();
      return;
    }
    if (hit.type === 'reply-ref') {
      beginScrollToMessage(hit.id);
      return;
    }
    if (hit.type === 'channel-action') {
      if (hit.action === 'delete' && hit.name !== 'main') await deleteChannel(hit.name);
      return;
    }
    if (hit.type === 'channel') {
      if (hit.name === 'main' && hit.name === state.activeChannel) {
        clearSelection();
        return;
      }
      if (hit.name === state.activeChannel) {
        if (state.channelMenu === hit.name && !state.channelClosing) {
          beginChannelClose();
        } else {
          openChannelMenu(hit.name);
        }
        clearSelection();
        return;
      }
      snapCloseChannelMenu();
      await switchChannel(hit.name);
      return;
    }
    if (hit.type === 'create-channel') {
      state.creatingChannel = true;
      state.channelDraft = '';
      state.channelDraftCaret = 0;
      return;
    }
    if (hit.type === 'cancel-create') {
      state.creatingChannel = false;
      state.channelDraft = '';
      state.channelDraftCaret = 0;
      return;
    }
    if (hit.type === 'scrollbar') {
      if (!lastFrame) return;
      draggingScroll = {
        startY: hit._y,
        startOffset: state.scrollOffset || 0,
      };
      return;
    }
    if (hit.type === 'gap') {
      clearSelection();
      beginChannelClose();
      return;
    }
    if (hit.type === 'action') {
      if (hit.action === 'delete-channel' && state.channelMenu && state.channelMenu !== 'main') {
        await deleteChannel(state.channelMenu);
        return;
      }
      if (hit.action === 'clear') {
        clearSelection();
        beginChannelClose();
        return;
      }
      const item = findMessage(hit.id) || findMessage(state.selectedMessageId);
      await runAction(hit.action, item);
      return;
    }
    if (hit.type === 'card' || hit.type === 'message') {
      const item = findMessage(hit.id);
      if (!item) return;
      if (String(state.selectedMessageId) === String(item.msg.id)) {
        clearSelection();
        return;
      }
      snapCloseChannelMenu();
      selectMessage(item);
    }
  }

  function flushCoalescedMove() {
    if (coalesceTimer) {
      clearImmediate(coalesceTimer);
      coalesceTimer = null;
    }
    const pending = coalescedMove;
    coalescedMove = null;
    return pending;
  }

  function queueMouse(mouse) {
    if (mouse.kind === 'move') {
      coalescedMove = mouse;
      if (!coalesceTimer) {
        coalesceTimer = setImmediate(() => {
          coalesceTimer = null;
          const pending = coalescedMove;
          coalescedMove = null;
          if (pending && handleMouse(pending)) draw();
        });
      }
      return;
    }
    const pending = flushCoalescedMove();
    let changed = false;
    // A press/wheel/release is higher priority than a stale hover move.
    // Keep a pending drag/scroll move; drop hover-only motion.
    if (pending && (draggingScroll || channelDrag || mouse.kind === 'release' || mouse.kind === 'wheel')) {
      changed = handleMouse(pending) || changed;
    }
    changed = handleMouse(mouse) || changed;
    if (changed) draw();
  }

  function handleMouse(mouse) {
    if (isFrozen()) {
      if (!lastFrame) lastFrame = buildChatFrame(size().cols, size().rows, state);
      const x = mouse.x - 1;
      const y = mouse.y - 1;
      const hit = hitTest(lastFrame.hits, x, y);
      if (mouse.kind === 'press' && mouse.button === 0 && hit && hit.type === 'action' && hit.action === 'clear') {
        handleClick(hit).then(() => draw()).catch(() => draw());
      }
      return false;
    }
    if (!lastFrame) lastFrame = buildChatFrame(size().cols, size().rows, state);
    const x = mouse.x - 1;
    const y = mouse.y - 1;
    const hit = hitTest(lastFrame.hits, x, y);
    if (hit && hit.type === 'scrollbar') hit._y = y;

    if (mouse.kind === 'wheel') {
      const comp = lastFrame.regions.composer;
      const metrics = lastFrame.composerMetrics;
      if (comp && metrics && metrics.overflow && x >= comp.x && x < comp.x + comp.w && y >= comp.y && y < comp.y + comp.h) {
        const max = Math.max(0, metrics.total - metrics.innerH);
        const next = Math.max(0, Math.min(max, (state.composerScroll || 0) + (mouse.wheel < 0 ? -1 : 1)));
        if (next === (state.composerScroll || 0)) return false;
        state.composerFollowCaret = false;
        state.composerScroll = next;
        return true;
      }
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
      draggingScroll = null;
      draggingComposer = null;
      textDrag = null;
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

    if (mouse.kind === 'move' && draggingComposer) {
      const metrics = lastFrame.composerMetrics;
      const region = lastFrame.regions.composer;
      if (metrics && region) {
        const max = Math.max(0, metrics.total - metrics.innerH);
        const t = region.h <= 1 ? 0 : Math.max(0, Math.min(1, (y - region.y) / Math.max(1, region.h - 1)));
        state.composerFollowCaret = false;
        state.composerScroll = Math.round(t * max);
        return true;
      }
      return false;
    }

    if (mouse.kind === 'move' && draggingScroll) {
      clearHover();
      state.scrollOffset = scrollOffsetFromDrag(
        draggingScroll.startOffset,
        draggingScroll.startY,
        y,
        lastFrame.regions.scrollbar,
        lastFrame.maxScroll
      );
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
      if (screen && typeof screen.isOverloaded === 'function' && screen.isOverloaded()) {
        return clearHover();
      }
      if (textDrag && mouse.button === 0) {
        if (Math.abs(x - textDrag.x) + Math.abs(y - textDrag.y) >= 1) {
          setSelectMode(true);
        }
        return false;
      }
      return applyHover(hit);
    }

    if (mouse.kind === 'press' && mouse.button === 0) {
      if (hit && hit.type === 'composer-scrollbar') {
        const metrics = lastFrame.composerMetrics;
        const region = lastFrame.regions.composer;
        if (metrics && region) {
          const max = Math.max(0, metrics.total - metrics.innerH);
          const t = region.h <= 1 ? 0 : Math.max(0, Math.min(1, (y - region.y) / Math.max(1, region.h - 1)));
          state.composerFollowCaret = false;
          state.composerScroll = Math.round(t * max);
          draggingComposer = true;
          return true;
        }
      }
      if (hit && hit.type === 'composer') {
        placeComposerCaret(x, y);
        return true;
      }
      if (hit && hit.type === 'message-text') {
        textDrag = { x, y };
      } else {
        textDrag = null;
        setSelectMode(false);
      }
      if (hit && hit.type === 'scrollbar') {
        const thumb = lastFrame.scrollbarThumb;
        const onThumb = !!(thumb && y >= thumb.y && y < thumb.y + thumb.h);
        if (!onThumb) {
          state.scrollOffset = scrollOffsetFromY(y, lastFrame.regions.scrollbar, lastFrame.maxScroll);
          if (state.overlay && state.overlay.type === 'delete') {
            state.scrollOffset = clampScrollForMessage(
              state.scrollOffset,
              lastFrame.messageBounds,
              lastFrame.totalLines,
              lastFrame.regions.transcript.h
            );
          }
        }
        draggingScroll = {
          startY: y,
          startOffset: state.scrollOffset || 0,
        };
        const droppedHover = clearHover();
        return !onThumb || droppedHover;
      }
      if (hit && hit.type === 'channel') {
        if (hit.name === 'main') {
          handleClick(hit).then(() => draw()).catch(() => draw());
          return false;
        }
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
    state.composerFollowCaret = true;
    const at = state.composerCaret;
    const piece = String(ch);
    state.composer = state.composer.slice(0, at) + piece + state.composer.slice(at);
    state.composerCaret = at + piece.length;
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
      state.composerFollowCaret = true;
      const prev = ansi.stepCodePoint(state.composer, at, -1);
      state.composer = state.composer.slice(0, prev) + state.composer.slice(at);
      state.composerCaret = prev;
    }
  }

  function composerBoxWidth() {
    if (lastFrame && lastFrame.regions && lastFrame.regions.composer) return lastFrame.regions.composer.w;
    const cols = size().cols;
    return Math.max(8, cols - 24);
  }

  function composerUsesArrows() {
    if (channelDraftEditing() || state.selectedMessageId) return false;
    if (!state.activeGroupId || state.transition || state.loadingGroup) return false;
    if (String(state.composer || '').includes('\n')) return true;
    const metrics = lastFrame && lastFrame.composerMetrics
      ? lastFrame.composerMetrics
      : composerMetrics(state, composerBoxWidth());
    return (metrics.total || 1) > 1;
  }

  function moveComposerLine(dir) {
    const metrics = composerMetrics(state, composerBoxWidth());
    const lines = metrics.wrapped || [];
    if (!lines.length) return;
    const nextLine = Math.max(0, Math.min(lines.length - 1, (metrics.caretLine || 0) + dir));
    const line = lines[nextLine];
    if (!line) return;
    const targetCol = metrics.caretCol || 0;
    let i = 0;
    let used = 0;
    for (const ch of String(line.text || '')) {
      const w = ansi.charWidth(ch);
      if (used + w > targetCol) break;
      used += w;
      i += ch.length;
    }
    state.composerFollowCaret = true;
    state.composerCaret = (line.start || 0) + i;
  }

  function placeComposerCaret(x, y) {
    const metrics = lastFrame && lastFrame.composerMetrics
      ? lastFrame.composerMetrics
      : composerMetrics(state, composerBoxWidth());
    const region = lastFrame && lastFrame.regions && lastFrame.regions.composer;
    if (!region || !metrics.wrapped || !metrics.wrapped.length) {
      state.composerCaret = (state.composer || '').length;
      return;
    }
    const lineIdx = Math.max(0, Math.min(
      metrics.wrapped.length - 1,
      (metrics.lineScroll || 0) + (y - region.y)
    ));
    const line = metrics.wrapped[lineIdx];
    const col = Math.max(0, x - region.x);
    let i = 0;
    let used = 0;
    for (const ch of String(line.text || '')) {
      const w = ansi.charWidth(ch);
      if (used + w > col) break;
      used += w;
      i += ch.length;
    }
    state.composerFollowCaret = true;
    state.composerCaret = (line.start || 0) + i;
  }

  function setSelectMode(on) {
    if (!stdout || selectMode === on) return;
    selectMode = on;
    stdout.write(on ? ansi.mouseClicksOnly() : ansi.mouseEnable());
  }

  function moveComposer(delta) {
    if (state.overlay && state.overlay.type === 'save') {
      const len = (state.overlay.value || '').length;
      state.overlay.caret = Math.max(0, Math.min(len, (state.overlay.caret || 0) + delta));
      return;
    }
    state.composerFollowCaret = true;
    const dir = delta < 0 ? -1 : 1;
    let at = state.composerCaret;
    for (let n = 0; n < Math.abs(delta); n += 1) {
      at = ansi.stepCodePoint(state.composer, at, dir);
    }
    state.composerCaret = Math.max(0, Math.min(state.composer.length, at));
  }

  function channelDraftEditing() {
    return !!state.creatingChannel;
  }

  function moveChannelDraft(delta) {
    const len = (state.channelDraft || '').length;
    state.channelDraftCaret = Math.max(0, Math.min(len, (state.channelDraftCaret || 0) + delta));
  }

  function insertChannelDraft(ch) {
    const draft = state.channelDraft || '';
    if (draft.length >= 12) return;
    const at = Math.max(0, Math.min(state.channelDraftCaret || 0, draft.length));
    state.channelDraft = draft.slice(0, at) + ch + draft.slice(at);
    state.channelDraftCaret = at + 1;
  }

  function backspaceChannelDraft() {
    const draft = state.channelDraft || '';
    const at = Math.max(0, Math.min(state.channelDraftCaret || 0, draft.length));
    if (at > 0) {
      state.channelDraft = draft.slice(0, at - 1) + draft.slice(at);
      state.channelDraftCaret = at - 1;
    }
  }

  function deleteWordIn(text, at) {
    let i = Math.max(0, Math.min(at, text.length));
    while (i > 0 && /\s/.test(text[i - 1])) i -= 1;
    while (i > 0 && !/\s/.test(text[i - 1])) i -= 1;
    return { text: text.slice(0, i) + text.slice(at), caret: i };
  }

  function deleteWord() {
    if (channelDraftEditing()) {
      const next = deleteWordIn(state.channelDraft || '', state.channelDraftCaret || 0);
      state.channelDraft = next.text;
      state.channelDraftCaret = next.caret;
      return;
    }
    const next = deleteWordIn(state.composer || '', state.composerCaret || 0);
    state.composer = next.text;
    state.composerCaret = next.caret;
    state.composerFollowCaret = true;
  }

  function insertNewline() {
    if (channelDraftEditing()) return;
    insertComposer('\n');
  }

  function consumeEscape(sequence) {
    if (isFrozen()) {
      const frozen = String(sequence).match(/^\u001b\[[0-9;<=>?]*[@-~]/);
      if (frozen) return frozen[0].length;
      if (sequence.startsWith('\u001b\r') || sequence.startsWith('\u001b\n') || sequence.startsWith('\u001b\u007f')) {
        return 2;
      }
      return 0;
    }
    if (sequence.startsWith('\u001b[200~') || sequence.startsWith('\u001b[201~')) return 0;
    if (ansi.isAltEnter(sequence.slice(0, 2)) || sequence.startsWith('\u001b\r') || sequence.startsWith('\u001b\n')) {
      insertNewline();
      draw();
      return 2;
    }
    if (sequence.startsWith('\u001b\u007f') || sequence.startsWith('\u001b\b')) {
      deleteWord();
      draw();
      return 2;
    }
    const match = String(sequence).match(/^\u001b\[[0-9;<=>?]*[@-~]/);
    if (!match) return 0;
    const seq = match[0];
    if (seq.startsWith('\u001b[<')) {
      const mouse = ansi.parseSgrMouse(seq);
      if (mouse) queueMouse(mouse);
    } else if (ansi.isAltEnter(seq)) {
      insertNewline();
      draw();
    } else if (ansi.isAltBackspace(seq)) {
      deleteWord();
      draw();
    } else {
      const motion = seq.match(/^\u001b\[(\d*)([ABCD])$/);
      if (motion) {
        const count = motion[1] ? Number(motion[1]) : 1;
        if (motion[2] === 'D') {
          if (channelDraftEditing()) moveChannelDraft(-count);
          else moveComposer(-count);
        } else if (motion[2] === 'C') {
          if (channelDraftEditing()) moveChannelDraft(count);
          else moveComposer(count);
        } else if (motion[2] === 'A') {
          if (channelDraftEditing()) { /* stay in the chip */ }
          else if (composerUsesArrows()) moveComposerLine(-1);
          else if (state.selectedMessageId && !state.overlay) moveSelection(-1);
          else applyScroll(1);
        } else if (motion[2] === 'B') {
          if (channelDraftEditing()) { /* stay in the chip */ }
          else if (composerUsesArrows()) moveComposerLine(1);
          else if (state.selectedMessageId && !state.overlay) moveSelection(1);
          else applyScroll(-1);
        }
        draw();
      } else if (seq === '\u001b[H') {
        if (channelDraftEditing()) state.channelDraftCaret = 0;
        else state.composerCaret = 0;
        draw();
      } else if (seq === '\u001b[F') {
        if (channelDraftEditing()) state.channelDraftCaret = (state.channelDraft || '').length;
        else state.composerCaret = state.composer.length;
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
    if (isFrozen()) {
      if (ch === '\u001b') {
        closeOverlay();
        draw();
        return;
      }
      if (ch === '\r' || ch === '\n') {
        performDelete(state.overlay.messageId).then(() => {
          clearSelection();
          draw();
        }).catch(() => draw());
      }
      return;
    }
    if (ch === '\u001b') {
      if (state.overlay) {
        closeOverlay();
        draw();
        return;
      }
      if (state.profileOpen || state.profileClosing) {
        state.profileClosing = true;
        state.profileOpen = true;
        startPulse();
        draw();
        return;
      }
      if (state.creatingChannel) {
        state.creatingChannel = false;
        state.channelDraft = '';
        state.channelDraftCaret = 0;
        draw();
        return;
      }
      if (state.channelMenu) {
        beginChannelClose();
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
    if (state.channelMenu) {
      if (ch === 'd' && state.channelMenu !== 'main') {
        deleteChannel(state.channelMenu).then(() => draw()).catch(() => draw());
        return;
      }
    }
    if (state.creatingChannel) {
      if (ch === '\r' || ch === '\n') {
        createChannel(state.channelDraft).then(() => draw()).catch(() => draw());
        return;
      }
      if (ch === '\u007f' || ch === '\b') {
        backspaceChannelDraft();
        draw();
        return;
      }
      if (ch >= ' ') {
        insertChannelDraft(ch);
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
    if (ch === '\u0017') {
      deleteWord();
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

  function armEscFlush() {
    if (escTimer) clearTimeout(escTimer);
    escTimer = setTimeout(() => {
      escTimer = null;
      if (inputBuffer === '\u001b') {
        inputBuffer = '';
        handleKey('\u001b');
        draw();
      }
    }, 30);
  }

  function pushInput(str) {
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    let rest = inputBuffer + String(str).replace(/\r\n/g, '\r');
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
        inputBuffer = '\u001b';
        armEscFlush();
        return;
      }
      if (rest.startsWith('\u001b[200~')) {
        inputBuffer = rest.slice(0, 8192);
        return;
      }
      const consumed = consumeEscape(rest);
      if (consumed === 0) {
        if (rest.startsWith('\u001b') && rest.length > 1 && rest[1] !== '[') {
          handleKey('\u001b');
          rest = rest.slice(1);
          continue;
        }
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
    handleClick,
    handleKey,
    moveSelection,
    cancelComposeMode,
    deleteWord,
    beginChannelClose,
    loadGroup,
    switchChannel,
    beginReply,
    beginEdit,
    beginScrollToMessage,
    previewAttachment,
    findMessage,
    toggleTheme,
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
