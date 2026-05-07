'use strict';

// ── Crypto Helpers ───────────────────────────────────────────────────────────

// Cache derived keys to avoid running 100 000 PBKDF2 iterations for every
// individual message encrypt/decrypt operation (#21).
const derivedKeyCache = new Map(); // `${passphrase}\x00${groupId}` -> CryptoKey

async function deriveKey(passphrase, groupId) {
  const cacheKey = passphrase + '\x00' + groupId;
  if (derivedKeyCache.has(cacheKey)) return derivedKeyCache.get(cacheKey);
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(groupId), iterations: 100000, hash: 'SHA-256' },
    keyMat,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  derivedKeyCache.set(cacheKey, key);
  return key;
}

// Convert a Uint8Array to a base64 string without using spread (which blows
// the call stack for large buffers, #1).
function uint8ToBase64(bytes) {
  let binary = '';
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function encryptMessage(text, passphrase, groupId) {
  const key = await deriveKey(passphrase, groupId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return {
    encryptedContent: uint8ToBase64(new Uint8Array(buf)),
    iv: uint8ToBase64(iv),
  };
}

async function decryptMessage(encryptedContent, ivB64, passphrase, groupId) {
  try {
    const key = await deriveKey(passphrase, groupId);
    const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
    const buf = Uint8Array.from(atob(encryptedContent), c => c.charCodeAt(0));
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, buf);
    return new TextDecoder().decode(dec);
  } catch {
    return null;
  }
}

async function encryptBytes(buffer, passphrase, groupId) {
  const key = await deriveKey(passphrase, groupId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
  return {
    encryptedContent: uint8ToBase64(new Uint8Array(encrypted)),
    iv: uint8ToBase64(iv),
  };
}

async function encryptBytesRaw(buffer, passphrase, groupId) {
  const key = await deriveKey(passphrase, groupId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
  return {
    encryptedBytes: new Uint8Array(encrypted),
    iv: uint8ToBase64(iv),
  };
}

async function decryptBytes(encryptedContent, ivB64, passphrase, groupId) {
  try {
    const key = await deriveKey(passphrase, groupId);
    const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
    const buf = Uint8Array.from(atob(encryptedContent), c => c.charCodeAt(0));
    return await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, buf);
  } catch {
    return null;
  }
}

// ── Image MIME type detection ──────────────────────────────────────────────────
function detectImageMime(buf) {
  const ab = buf instanceof ArrayBuffer ? buf : buf.buffer;
  const bytes = new Uint8Array(ab, 0, Math.min(12, ab.byteLength));
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  // WebP: 'RIFF' at 0 + 'WEBP' at 8
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

// ── Compression Helper ────────────────────────────────────────────────────────
async function compressImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1200;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.75);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// ── CSRF ──────────────────────────────────────────────────────────────────────
let csrfToken = null;
let appVersionLabel = 'v—';
async function fetchCsrfToken() {
  try {
    const r = await fetch('/api/auth/csrf');
    const d = await r.json();
    csrfToken = d.csrfToken;
  } catch { /* will retry */ }
}

function apiHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (csrfToken) h['X-CSRF-Token'] = csrfToken;
  return h;
}

// ── Per-group key storage ────────────────────────────────────────────────────
function getGroupKey(groupId) { return localStorage.getItem('gk:' + groupId) || null; }
function setGroupKey(groupId, key) { localStorage.setItem('gk:' + groupId, key); }
function clearGroupKey(groupId) {
  // Evict the cached CryptoKey so re-entry uses a fresh derivation
  const old = localStorage.getItem('gk:' + groupId);
  if (old) derivedKeyCache.delete(old + '\x00' + groupId);
  localStorage.removeItem('gk:' + groupId);
}

const LOCAL_CACHE_PREFIX = 'gchat:cache:group:';
const LEGACY_LOCAL_SETTINGS_KEY = 'gchat:local-settings';
const ACTIVE_LOCAL_SETTINGS_KEY = 'gchat:active-local-settings';
const LOCAL_SETTINGS_KEY_PREFIX = 'gchat:local-settings:user:';
const DEFAULT_WALLPAPER = "url('gchat_wallpaper.jpg')";
const DEFAULT_WALLPAPER_PREVIEW_SRC = 'gchat_wallpaper.jpg';
const WALLPAPER_SELECT_FIRST_MSG = 'Please choose an image first';
const WALLPAPER_INVALID_TYPE_MSG = 'Please choose an image file';
const WALLPAPER_TOO_LARGE_MSG = 'Wallpaper too large (max 10MB)';
const WALLPAPER_READ_FAIL_MSG = 'Unable to read image';
const WALLPAPER_SAVE_SYNC_FAIL_MSG = 'Wallpaper saved locally but could not sync to server. Changes may not appear on other devices.';
const WALLPAPER_RESET_SYNC_FAIL_MSG = 'Wallpaper reset locally but could not sync to server. Changes may not appear on other devices.';
const WALLPAPER_SAVE_SUCCESS_MSG = 'Wallpaper saved';
const WALLPAPER_RESET_SUCCESS_MSG = 'Wallpaper reset';
const DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY = 'gchat:desktop-sidebar-width';
const DESKTOP_RIGHT_PANEL_STORAGE_KEY = 'gchat:desktop-right-panel-expanded';
const DESKTOP_DEFAULT_SIDEBAR_WIDTH = 260;
const DESKTOP_MIN_SIDEBAR_WIDTH = 220;
const DESKTOP_COMPACT_SIDEBAR_WIDTH = 236;

function readLocalGroupCache(groupId) {
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_PREFIX + groupId);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLocalGroupCache(groupId, cache) {
  try {
    localStorage.setItem(LOCAL_CACHE_PREFIX + groupId, JSON.stringify({
      messages: cache.messages || [],
      members: cache.members || [],
      oldestMessageId: cache.oldestMessageId || null,
      updatedAt: Date.now(),
    }));
  } catch {
    // best effort only
  }
}

function readStoredJson(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getUserSettingsStorageKey(userId = currentUser && currentUser.id) {
  return userId ? `${LOCAL_SETTINGS_KEY_PREFIX}${userId}` : null;
}

function readLocalSettings(userId = currentUser && currentUser.id) {
  const userKey = getUserSettingsStorageKey(userId);
  if (userKey) {
    const scoped = readStoredJson(userKey);
    if (Object.keys(scoped).length > 0) return scoped;
  }
  const active = readStoredJson(ACTIVE_LOCAL_SETTINGS_KEY);
  if (Object.keys(active).length > 0) return active;
  return readStoredJson(LEGACY_LOCAL_SETTINGS_KEY);
}

function writeLocalSettings(settings, userId = currentUser && currentUser.id) {
  const payload = JSON.stringify(settings);
  try {
    const userKey = getUserSettingsStorageKey(userId);
    if (userKey) localStorage.setItem(userKey, payload);
    localStorage.setItem(ACTIVE_LOCAL_SETTINGS_KEY, payload);
    localStorage.removeItem(LEGACY_LOCAL_SETTINGS_KEY);
  } catch {
    // best effort only
  }
}

function migrateLegacyLocalSettings(userId = currentUser && currentUser.id) {
  const userKey = getUserSettingsStorageKey(userId);
  if (!userKey) return;
  const legacy = readStoredJson(LEGACY_LOCAL_SETTINGS_KEY);
  if (Object.keys(legacy).length === 0) return;
  const existing = readStoredJson(userKey);
  const next = Object.keys(existing).length > 0 ? existing : legacy;
  writeLocalSettings(next, userId);
}

function createUploadId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : s; }
function normalizeIsoTime(iso) {
  if (!iso) return '';
  const str = String(iso).replace(' ', 'T');
  return (str.endsWith('Z') || str.includes('+')) ? str : str + 'Z';
}
function parseMessageDate(iso) {
  return new Date(normalizeIsoTime(iso));
}
function formatTime(iso) {
  if (!iso) return '';
  return parseMessageDate(iso).toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
function formatDay(iso) {
  if (!iso) return '';
  return parseMessageDate(iso).toLocaleDateString('en-US', { timeZone: 'Asia/Shanghai' });
}
function isSameMessageDay(a, b) {
  if (!a || !b) return false;
  return formatDay(a) === formatDay(b);
}
function shouldContinueSeries(prevMsg, currentMsg) {
  if (!prevMsg || !currentMsg) return false;
  if (prevMsg.type === 'system' || currentMsg.type === 'system') return false;
  if (prevMsg.senderId !== currentMsg.senderId) return false;
  if (!isSameMessageDay(prevMsg.createdAt, currentMsg.createdAt)) return false;
  const prevTime = parseMessageDate(prevMsg.createdAt).getTime();
  const currentTime = parseMessageDate(currentMsg.createdAt).getTime();
  const gapMinutes = (currentTime - prevTime) / 60000;
  return gapMinutes >= 0 && gapMinutes <= 10;
}
function createDateDivider(iso) {
  const el = document.createElement('div');
  el.className = 'msg-date-divider';
  el.textContent = formatDay(iso);
  return el;
}
function renderAvatarElement(target, userLike = {}) {
  if (!target) return;
  target.replaceChildren();
  const username = userLike.username || userLike.senderName || '?';
  if (userLike.profilePicture) {
    target.style.background = 'none';
    target.textContent = '';
    target.appendChild(createAvatarImage(userLike.profilePicture));
    return;
  }
  target.style.background = userLike.iconColor || userLike.senderColor || '#4A90D9';
  target.textContent = username[0].toUpperCase();
}

function formatBytes(bytes) {
  const size = Math.max(0, Number(bytes) || 0);
  if (size === 0) return '0 B';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[idx]}`;
}

function wallpaperCssValue(dataUrl) {
  if (!dataUrl) return DEFAULT_WALLPAPER;
  return `url("${String(dataUrl).replace(/"/g, '\\"')}")`;
}

function applyWallpaperFromSettings() {
  const wallpaper = appLocalSettings.wallpaperDataUrl;
  const cssValue = wallpaperCssValue(wallpaper);
  document.documentElement.style.setProperty('--chat-wallpaper', cssValue);
  document.documentElement.style.setProperty('--auth-wallpaper', cssValue);
  const preview = $('wallpaper-current-preview');
  if (preview) preview.src = wallpaper || DEFAULT_WALLPAPER_PREVIEW_SRC;
}

async function saveSettingsToServer() {
  if (!currentUser) return false;
  const payload = {
    wallpaperDataUrl: appLocalSettings.wallpaperDataUrl || null,
    hideProfileDot: !!appLocalSettings.hideProfileDot,
  };
  try {
    const res = await fetch('/api/auth/settings', {
      method: 'PATCH',
      headers: apiHeaders(),
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function loadSettingsFromServer() {
  try {
    const res = await fetch('/api/auth/settings');
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.wallpaperDataUrl === 'string') appLocalSettings.wallpaperDataUrl = data.wallpaperDataUrl || null;
    if (typeof data.hideProfileDot === 'boolean') appLocalSettings.hideProfileDot = data.hideProfileDot;
  } catch {
    // ignore and use local settings
  }
}

function loadMergedLocalSettings() {
  const local = readLocalSettings();
  if (typeof local.wallpaperDataUrl === 'string') appLocalSettings.wallpaperDataUrl = local.wallpaperDataUrl || null;
  if (typeof local.hideProfileDot === 'boolean') appLocalSettings.hideProfileDot = local.hideProfileDot;
  applyWallpaperFromSettings();
}

function normalizeDeliveryCounts(totalRecipients, readCount) {
  const total = Math.max(0, Number(totalRecipients) || 0);
  const read = Math.min(total, Math.max(0, Number(readCount) || 0));
  return { total, read };
}

function renderDeliveryTicks(el, totalRecipients, readCount) {
  if (!el) return;
  const { total, read } = normalizeDeliveryCounts(totalRecipients, readCount);
  el.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const tick = document.createElement('span');
    tick.className = 'msg-delivery-tick' + (i < read ? ' read' : '');
    tick.textContent = '✓';
    el.appendChild(tick);
  }
}

function updateDeliveryForMessage(messageId, readCount) {
  const del = $('del-' + messageId);
  if (!del) return;
  const totalRecipients = Number(del.dataset.totalRecipients) || 0;
  del.dataset.readCount = String(Math.max(0, Number(readCount) || 0));
  renderDeliveryTicks(del, totalRecipients, readCount);
}

function canTrackMessageRead(msg) {
  return !!(
    msg &&
    currentUser &&
    msg.groupId === currentGroupId &&
    msg.senderId !== currentUser.id &&
    msg.hasRead !== true
  );
}

function ensureReadObserver() {
  if (readObserver) return;
  readObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || entry.intersectionRatio < 0.75) continue;
      if (!socket || !currentGroupId || document.visibilityState !== 'visible' || !document.hasFocus()) continue;
      const row = entry.target;
      const messageId = row?.dataset?.msgId;
      if (!messageId || pendingReadMessageIds.has(messageId) || pendingReadTimers.has(messageId)) continue;
      const timer = setTimeout(() => {
        pendingReadTimers.delete(messageId);
        if (!row?.isConnected) return;
        pendingReadMessageIds.add(messageId);
        row.classList.remove('unseen');
        row.dataset.hasRead = '1';
        if (currentGroupId) {
          unreadCounts[currentGroupId] = Math.max(0, (unreadCounts[currentGroupId] || 0) - 1);
          updateUnreadBadge(currentGroupId, unreadCounts[currentGroupId]);
        }
        readObserver.unobserve(row);
        socket.emit('mark_message_read', { groupId: currentGroupId, messageId });
      }, 1000);
      pendingReadTimers.set(messageId, timer);
    }
    for (const entry of entries) {
      if (entry.isIntersecting && entry.intersectionRatio >= 0.75) continue;
      const row = entry.target;
      const messageId = row?.dataset?.msgId;
      if (!messageId) continue;
      const timer = pendingReadTimers.get(messageId);
      if (!timer) continue;
      clearTimeout(timer);
      pendingReadTimers.delete(messageId);
    }
  }, {
    root: messagesArea(),
    threshold: [0.75],
  });
}

function observeMessageForRead(row, msg) {
  if (!row || row.nodeType !== 1 || !canTrackMessageRead(msg)) return;
  ensureReadObserver();
  readObserver.observe(row);
}

function observeCurrentGroupRowsForRead() {
  const area = messagesArea();
  if (!area || !currentGroupId || !currentUser) return;
  const rows = area.querySelectorAll('.msg-row[data-msg-id]');
  for (const row of rows) {
    if (row.dataset.senderId === currentUser.id) continue;
    observeMessageForRead(row, {
      groupId: currentGroupId,
      senderId: row.dataset.senderId,
      hasRead: row.dataset.hasRead === '1',
    });
  }
}

function resetReadTracking() {
  for (const timer of pendingReadTimers.values()) clearTimeout(timer);
  pendingReadTimers = new Map();
  pendingReadMessageIds = new Set();
  if (readObserver) {
    readObserver.disconnect();
    readObserver = null;
  }
}

// ── Audio: notification sound via Web Audio ──────────────────────────────────
let audioCtx = null;
function playNotifSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.18);
    osc.start(); osc.stop(audioCtx.currentTime + 0.18);
  } catch { /* audio not available */ }
}

// ── Native OS Notifications (browser + Electron desktop) ─────────────────────
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function sendNativeNotification(title, body, groupId) {
  // In Electron the main process handles it via IPC for full OS integration
  // (Action Center, notification click → focus window + group).
  if (window.electronAPI) {
    window.electronAPI.showNotification({ title, body, groupId });
    return;
  }
  // In a plain browser fall back to the Web Notification API.
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, { body, icon: '/gchat_icon.png', tag: groupId });
      n.addEventListener('click', () => { window.focus(); });
    } catch { /* notifications not supported */ }
  }
}

// Build the notification body text for a message, using the decrypted preview
// when available and falling back to type-based labels for media/encrypted content.
function getNotificationBody(msg, preview) {
  if (msg.type === 'image') return '[Image]';
  if (msg.type === 'file') return '[File: ' + (msg.filename || '') + ']';
  if (msg.type === 'whisper') return '[Whisper]';
  return preview !== '[encrypted]' ? preview : 'New message';
}

// ── Page title notification ──────────────────────────────────────────────────
function updatePageTitleNotification() {
  if (unreadNotificationCount > 0) {
    if (!titleBlinkInterval) {
      let showingNotif = true;
      titleBlinkInterval = setInterval(() => {
        if (showingNotif) {
          document.title = `(${unreadNotificationCount}) New ${unreadNotificationCount === 1 ? 'message' : 'messages'}`;
        } else {
          document.title = originalPageTitle;
        }
        showingNotif = !showingNotif;
      }, 1500);
    }
  } else {
    if (titleBlinkInterval) {
      clearInterval(titleBlinkInterval);
      titleBlinkInterval = null;
    }
    document.title = originalPageTitle;
  }
  // Keep Electron taskbar badge in sync with total unread count
  window.electronAPI?.setUnreadCount(unreadNotificationCount);
}

function clearPageTitleNotification() {
  unreadNotificationCount = 0;
  updatePageTitleNotification();
}

// ── Image Viewer ──────────────────────────────────────────────────────────────
function showImageViewer(imageUrl) {
  const modal = $('image-viewer-modal');
  const img = $('image-viewer-img');
  img.src = imageUrl;
  imageViewerZoom = 1;
  img.style.transform = 'scale(1)';
  modal.hidden = false;
}

function hideImageViewer() {
  const modal = $('image-viewer-modal');
  const img = $('image-viewer-img');
  modal.hidden = true;
  img.src = '';
  img.style.transform = 'scale(1)';
  imageViewerZoom = 1;
}

function updateImageViewerZoom(nextZoom) {
  const img = $('image-viewer-img');
  imageViewerZoom = Math.max(1, Math.min(6, nextZoom));
  img.style.transform = `scale(${imageViewerZoom})`;
  img.style.cursor = imageViewerZoom > 1 ? 'zoom-out' : 'zoom-in';
}

function isMessagesPinnedToBottom() {
  const area = messagesArea();
  if (!area) return false;
  return area.scrollHeight - area.scrollTop - area.clientHeight < 40;
}

function pinMessagesToBottom(instant = true) {
  const area = messagesArea();
  if (!area) return;
  area.scrollTo({ top: area.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
}

function createAvatarImage(src) {
  const img = document.createElement('img');
  img.src = src;
  img.style.width = '100%';
  img.style.height = '100%';
  img.style.objectFit = 'cover';
  img.style.borderRadius = '50%';
  return img;
}

function setProfilePictureMode(mode) {
  const slider = $('profile-picture-mode-slider');
  if (!slider) return;
  const isImage = mode === 'image';
  slider.value = isImage ? '1' : '0';
  $('profile-picture-color-section').hidden = isImage;
  $('profile-picture-upload-section').hidden = !isImage;
  $('profile-mode-color-label').classList.toggle('active', !isImage);
  $('profile-mode-image-label').classList.toggle('active', isImage);
}

function syncProfilePictureModeUI() {
  setProfilePictureMode(currentUser && currentUser.profilePicture ? 'image' : 'color');
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser = null;
let currentGroupId = null;
let currentGroupData = null;
let groups = [];
let members = [];
let socket = null;
let encryptionVisible = true;
let messageMode = 'normal'; // 'normal' | 'whisper'
let whisperRecipients = [];
let replyingTo = null;
let unreadCounts = {};
let scrollUnreadCount = 0;
let onlineUsers = new Set();
let allMessages = [];
let oldestMessageId = null;
let loadingOlder = false;
let clientRateLimiter = { times: [], lastContent: '', repeatCount: 0 };
let originalPageTitle = 'GChat ';
let unreadNotificationCount = 0;
let titleBlinkInterval = null;
let readObserver = null;
let pendingReadMessageIds = new Set();
let pendingReadTimers = new Map();
const groupDataCache = new Map();
const groupPreloadPromises = new Map();
const pendingAttachmentRows = new Map();
let imageViewerZoom = 1;
const appLocalSettings = {
  wallpaperDataUrl: null,
  hideProfileDot: true,
};
let pendingWallpaperDataUrl = null;
let desktopSidebarWidth = DESKTOP_DEFAULT_SIDEBAR_WIDTH;
let desktopRightPanelExpanded = true;

function renderCurrentUserAvatar(user = currentUser) {
  const avatar = $('user-avatar');
  if (!avatar || !user) return;
  renderAvatarElement(avatar, user);
}

function ensureGroupCacheEntry(groupId) {
  if (!groupDataCache.has(groupId)) {
    const local = readLocalGroupCache(groupId);
    groupDataCache.set(groupId, {
      messages: local?.messages || null,
      messageRows: null,
      members: local?.members || null,
      oldestMessageId: local?.oldestMessageId || null,
      rowsDirty: !!local?.messages,
    });
  }
  return groupDataCache.get(groupId);
}

function getMemberProfile(groupId, userId) {
  const cache = ensureGroupCacheEntry(groupId);
  const groupMembers = cache.members || [];
  const groupMember = groupMembers.find((member) => member.id === userId);
  if (groupMember) return groupMember;
  const activeMember = members.find((member) => member.id === userId);
  if (activeMember) return activeMember;
  return null;
}

function createLoadMoreIndicator() {
  const indicator = document.createElement('div');
  indicator.className = 'load-more-indicator';
  indicator.id = 'load-more-indicator';
  indicator.hidden = true;
  indicator.textContent = 'Loading older messages…';
  return indicator;
}

async function buildMessageRows(messages, groupId) {
  const rows = [];
  let prevMessage = null;
  for (const msg of messages) {
    const showSenderName = !shouldContinueSeries(prevMessage, msg);
    try {
      const row = await buildMessageRow(msg, groupId, { showSenderName });
      if (row) {
        if (!prevMessage || !isSameMessageDay(prevMessage.createdAt, msg.createdAt)) {
          rows.push(createDateDivider(msg.createdAt));
        }
        rows.push(row);
        if (msg.type !== 'system') prevMessage = msg;
      }
    } catch (err) {
      console.error('buildMessageRow failed:', msg?.id, err);
    }
  }
  return rows;
}

async function rebuildGroupMessageRows(groupId) {
  const cache = ensureGroupCacheEntry(groupId);
  if (!cache.messages) return;
  cache.messageRows = await buildMessageRows(cache.messages, groupId);
  cache.oldestMessageId = cache.messages.length ? cache.messages[0].id : null;
  cache.rowsDirty = false;
}

function renderGroupFromCache(groupId) {
  const cache = ensureGroupCacheEntry(groupId);
  const area = messagesArea();
  if (!area) return;

  area.replaceChildren(createLoadMoreIndicator());
  if (cache.messageRows && cache.messageRows.length) {
    for (const row of cache.messageRows) {
      if (row) area.appendChild(row);
    }
  }

  allMessages = cache.messages || [];
  oldestMessageId = cache.oldestMessageId;
  members = cache.members || [];
  $('chat-member-count').textContent = members.length + ' member' + (members.length !== 1 ? 's' : '');
  renderMembersList();
  renderWhisperPicker();
}

function preloadAllGroups() {
  for (const group of groups) {
    void ensureGroupDataPreloaded(group.id).catch((err) => {
      console.error('Background preload failed:', group.id, err);
    });
  }
}

async function ensureGroupDataPreloaded(groupId) {
  if (groupPreloadPromises.has(groupId)) return groupPreloadPromises.get(groupId);
  const cache = ensureGroupCacheEntry(groupId);
  if (cache.messages && cache.members && cache.messageRows && !cache.rowsDirty) return cache;

  const preload = (async () => {
    if (cache.messages && cache.members && cache.rowsDirty) {
      await rebuildGroupMessageRows(groupId);
      return ensureGroupCacheEntry(groupId);
    }
    const results = await Promise.allSettled([loadMessages(groupId), loadMembers(groupId)]);
    for (const result of results) {
      if (result.status === 'rejected') console.error('Group preload failed:', groupId, result.reason);
    }
    return ensureGroupCacheEntry(groupId);
  })();

  groupPreloadPromises.set(groupId, preload);
  try {
    return await preload;
  } finally {
    groupPreloadPromises.delete(groupId);
  }
}

// Decryption failure text constants (must match renderMsgContent output)
const MSG_NO_KEY = '[No key — set group key to decrypt]';
const MSG_DECRYPT_FAIL = '[Unable to decrypt]';

// Scroll threshold (px from top) that triggers loading older messages
const SCROLL_LOAD_THRESHOLD = 1;
const MOBILE_BREAKPOINT = 768;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const messagesArea = () => $('messages-area');
const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_SPECS = {
  plus: [
    ['path', { d: 'M12 5v14' }],
    ['path', { d: 'M5 12h14' }],
  ],
  'log-in': [
    ['path', { d: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4' }],
    ['polyline', { points: '10 17 15 12 10 7' }],
    ['line', { x1: '15', y1: '12', x2: '3', y2: '12' }],
  ],
  'log-out': [
    ['path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' }],
    ['polyline', { points: '16 17 21 12 16 7' }],
    ['line', { x1: '21', y1: '12', x2: '9', y2: '12' }],
  ],
  menu: [
    ['line', { x1: '4', y1: '6', x2: '20', y2: '6' }],
    ['line', { x1: '4', y1: '12', x2: '20', y2: '12' }],
    ['line', { x1: '4', y1: '18', x2: '20', y2: '18' }],
  ],
  'panel-right': [
    ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }],
    ['line', { x1: '15', y1: '4', x2: '15', y2: '20' }],
  ],
  info: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['line', { x1: '12', y1: '16', x2: '12', y2: '12' }],
    ['line', { x1: '12', y1: '8', x2: '12.01', y2: '8' }],
  ],
  'arrow-up': [
    ['line', { x1: '12', y1: '19', x2: '12', y2: '5' }],
    ['polyline', { points: '5 12 12 5 19 12' }],
  ],
  'refresh-cw': [
    ['polyline', { points: '23 4 23 10 17 10' }],
    ['polyline', { points: '1 20 1 14 7 14' }],
    ['path', { d: 'M3.51 9a9 9 0 0 1 14.13-3.36L23 10' }],
    ['path', { d: 'M20.49 15a9 9 0 0 1-14.13 3.36L1 14' }],
  ],
  x: [
    ['line', { x1: '18', y1: '6', x2: '6', y2: '18' }],
    ['line', { x1: '6', y1: '6', x2: '18', y2: '18' }],
  ],
  megaphone: [
    ['path', { d: 'M3 11v2' }],
    ['path', { d: 'M6 10v4' }],
    ['path', { d: 'M11 5l8 4v6l-8 4Z' }],
    ['path', { d: 'M6 14l1.5 5' }],
  ],
  smile: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M8 14s1.5 2 4 2 4-2 4-2' }],
    ['line', { x1: '9', y1: '9', x2: '9.01', y2: '9' }],
    ['line', { x1: '15', y1: '9', x2: '15.01', y2: '9' }],
  ],
  paperclip: [
    ['path', { d: 'M21.44 11.05l-8.49 8.49a6 6 0 0 1-8.49-8.49l8.49-8.48a4 4 0 1 1 5.66 5.65l-8.49 8.49a2 2 0 1 1-2.83-2.83l7.78-7.78' }],
  ],
  send: [
    ['line', { x1: '22', y1: '2', x2: '11', y2: '13' }],
    ['polygon', { points: '22 2 15 22 11 13 2 9 22 2' }],
  ],
  'message-square': [
    ['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z' }],
  ],
  pencil: [
    ['path', { d: 'M12 20h9' }],
    ['path', { d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z' }],
  ],
  copy: [
    ['rect', { x: '9', y: '9', width: '13', height: '13', rx: '2' }],
    ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }],
  ],
  'key-round': [
    ['circle', { cx: '7.5', cy: '15.5', r: '5.5' }],
    ['path', { d: 'M21 2l-9.6 9.6' }],
    ['path', { d: 'M15.5 7.5 17 9' }],
    ['path', { d: 'M18 5l1.5 1.5' }],
  ],
  key: [
    ['circle', { cx: '7.5', cy: '15.5', r: '5.5' }],
    ['path', { d: 'M13 15.5h8' }],
    ['path', { d: 'M16 12.5v6' }],
  ],
  lock: [
    ['rect', { x: '5', y: '11', width: '14', height: '10', rx: '2' }],
    ['path', { d: 'M8 11V8a4 4 0 1 1 8 0v3' }],
  ],
  unlock: [
    ['rect', { x: '5', y: '11', width: '14', height: '10', rx: '2' }],
    ['path', { d: 'M8 11V8a4 4 0 0 1 7.5-2' }],
  ],
  search: [
    ['circle', { cx: '11', cy: '11', r: '7' }],
    ['line', { x1: '21', y1: '21', x2: '16.65', y2: '16.65' }],
  ],
  download: [
    ['path', { d: 'M12 3v12' }],
    ['polyline', { points: '7 10 12 15 17 10' }],
    ['path', { d: 'M5 21h14' }],
  ],
  'alert-triangle': [
    ['path', { d: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z' }],
    ['line', { x1: '12', y1: '9', x2: '12', y2: '13' }],
    ['line', { x1: '12', y1: '17', x2: '12.01', y2: '17' }],
  ],
  'door-open': [
    ['path', { d: 'M13 4h6a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-6' }],
    ['path', { d: 'M3 12h13' }],
    ['polyline', { points: '8 7 3 12 8 17' }],
  ],
  'trash-2': [
    ['path', { d: 'M3 6h18' }],
    ['path', { d: 'M8 6V4h8v2' }],
    ['path', { d: 'M19 6l-1 14H6L5 6' }],
    ['line', { x1: '10', y1: '11', x2: '10', y2: '17' }],
    ['line', { x1: '14', y1: '11', x2: '14', y2: '17' }],
  ],
  keyboard: [
    ['rect', { x: '2', y: '5', width: '20', height: '14', rx: '2' }],
    ['path', { d: 'M6 9h.01M10 9h.01M14 9h.01M18 9h.01M8 13h.01M12 13h.01M16 13h.01M8 17h8' }],
  ],
  user: [
    ['path', { d: 'M20 21a8 8 0 0 0-16 0' }],
    ['circle', { cx: '12', cy: '7', r: '4' }],
  ],
  image: [
    ['rect', { x: '3', y: '5', width: '18', height: '14', rx: '2' }],
    ['circle', { cx: '9', cy: '10', r: '1.5' }],
    ['path', { d: 'm21 15-5-5L5 21' }],
  ],
  reply: [
    ['polyline', { points: '9 17 4 12 9 7' }],
    ['path', { d: 'M20 18v-2a4 4 0 0 0-4-4H4' }],
  ],
  check: [
    ['polyline', { points: '20 6 9 17 4 12' }],
  ],
  'chevrons-down': [
    ['polyline', { points: '7 6 12 11 17 6' }],
    ['polyline', { points: '7 13 12 18 17 13' }],
  ],
};

function createIcon(name) {
  const spec = ICON_SPECS[name];
  if (!spec) return document.createTextNode('');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ui-icon');
  for (const [tag, attrs] of spec) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.appendChild(node);
  }
  return svg;
}

function setElementIcon(el, name, options = {}) {
  if (!el) return;
  const { iconOnly = false, position = 'start' } = options;
  const existingLabel = el.dataset.iconLabel ?? el.textContent.trim();
  const resolvedLabel = options.label ?? existingLabel;
  if (resolvedLabel) el.dataset.iconLabel = resolvedLabel;
  el.replaceChildren();
  if (!iconOnly && position === 'start') el.appendChild(createIcon(name));
  if (!iconOnly && resolvedLabel) {
    const text = document.createElement('span');
    text.className = 'icon-label';
    text.textContent = resolvedLabel;
    el.appendChild(text);
  }
  if (!iconOnly && position === 'end') el.appendChild(createIcon(name));
  if (iconOnly) el.appendChild(createIcon(name));
  el.classList.add('has-icon');
  el.classList.toggle('icon-only', iconOnly);
}

function applyStaticIcons() {
  document.querySelectorAll('[data-icon]').forEach((el) => {
    setElementIcon(el, el.dataset.icon, {
      iconOnly: el.dataset.iconOnly === 'true',
      position: el.dataset.iconPosition || 'start',
    });
  });
}

function isMobileLayout() {
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

function desktopSidebarBounds() {
  const maxWidth = Math.max(DESKTOP_MIN_SIDEBAR_WIDTH, Math.floor(window.innerWidth / 3));
  return {
    min: DESKTOP_MIN_SIDEBAR_WIDTH,
    max: maxWidth,
  };
}

function readDesktopSidebarWidth() {
  const stored = Number(localStorage.getItem(DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : DESKTOP_DEFAULT_SIDEBAR_WIDTH;
}

function applyDesktopSidebarState() {
  if (isMobileLayout()) {
    document.body.classList.remove('sidebar-compact', 'sidebar-resizing');
    document.documentElement.style.setProperty('--sidebar-width', `${DESKTOP_DEFAULT_SIDEBAR_WIDTH}px`);
    return;
  }
  const { min, max } = desktopSidebarBounds();
  desktopSidebarWidth = Math.min(max, Math.max(min, Math.round(desktopSidebarWidth || DESKTOP_DEFAULT_SIDEBAR_WIDTH)));
  document.documentElement.style.setProperty('--sidebar-width', `${desktopSidebarWidth}px`);
  document.body.classList.toggle('sidebar-compact', desktopSidebarWidth <= DESKTOP_COMPACT_SIDEBAR_WIDTH);
  localStorage.setItem(DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY, String(desktopSidebarWidth));
}

function updateRightPanelToggleButtons() {
  const expanded = isMobileLayout()
    ? $('right-panel').classList.contains('open')
    : desktopRightPanelExpanded;
  ['right-panel-toggle', 'right-panel-toggle-empty'].forEach((id) => {
    const button = $(id);
    if (!button) return;
    button.classList.toggle('active', expanded);
    button.setAttribute('aria-pressed', expanded ? 'true' : 'false');
  });
}

function applyDesktopRightPanelState() {
  const panel = $('right-panel');
  if (!panel) return;
  panel.classList.toggle('desktop-collapsed', !desktopRightPanelExpanded && !isMobileLayout());
  updateRightPanelToggleButtons();
}

function startSidebarResize(event) {
  if (isMobileLayout()) return;
  event.preventDefault();
  document.body.classList.add('sidebar-resizing');

  const onMove = (moveEvent) => {
    desktopSidebarWidth = moveEvent.clientX;
    applyDesktopSidebarState();
  };

  const onUp = () => {
    document.body.classList.remove('sidebar-resizing');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function updateMobilePanelOverlay() {
  const isOpen = $('sidebar').classList.contains('open') || $('right-panel').classList.contains('open');
  $('sidebar-overlay').hidden = !isMobileLayout() || !isOpen;
  updateRightPanelToggleButtons();
}

function closeSidebar() {
  $('sidebar').classList.remove('open');
  updateMobilePanelOverlay();
}

function closeRightPanel() {
  $('right-panel').classList.remove('open');
  updateMobilePanelOverlay();
}

function closeMobilePanels() {
  closeSidebar();
  closeRightPanel();
}

function toggleSidebar() {
  if (!isMobileLayout()) return;
  const sidebar = $('sidebar');
  const opening = !sidebar.classList.contains('open');
  closeRightPanel();
  if (opening) sidebar.classList.add('open');
  updateMobilePanelOverlay();
}

function toggleRightPanel() {
  if (!isMobileLayout()) {
    desktopRightPanelExpanded = !desktopRightPanelExpanded;
    localStorage.setItem(DESKTOP_RIGHT_PANEL_STORAGE_KEY, desktopRightPanelExpanded ? '1' : '0');
    applyDesktopRightPanelState();
    return;
  }
  const panel = $('right-panel');
  const opening = !panel.classList.contains('open');
  closeSidebar();
  if (opening) panel.classList.add('open');
  updateMobilePanelOverlay();
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  applyStaticIcons();
  desktopSidebarWidth = readDesktopSidebarWidth();
  desktopRightPanelExpanded = localStorage.getItem(DESKTOP_RIGHT_PANEL_STORAGE_KEY) !== '0';
  loadMergedLocalSettings();
  applyDesktopSidebarState();
  applyDesktopRightPanelState();
  await fetchCsrfToken();
  try {
    const res = await fetch('/api/auth/me');
    if (res.status === 401) { window.location.href = 'index.html'; return; }
    if (!res.ok) throw new Error();
    currentUser = await res.json();
  } catch {
    window.location.href = 'index.html'; return;
  }

  // Set user display
  migrateLegacyLocalSettings(currentUser.id);
  $('user-username').textContent = currentUser.username;
  renderCurrentUserAvatar(currentUser);
  loadMergedLocalSettings();
  await loadSettingsFromServer();
  applyWallpaperFromSettings();
  writeLocalSettings(appLocalSettings, currentUser.id);
  try {
    const versionRes = await fetch('/api/meta/version');
    if (versionRes.ok) {
      const info = await versionRes.json();
      if (info && typeof info.version === 'string') appVersionLabel = 'v' + info.version;
    }
  } catch {
    // keep fallback
  }
  $('app-version-label').textContent = appVersionLabel;

  await loadGroups();
  preloadAllGroups();
  initSocket();
  setupEventListeners();
  syncProfilePictureModeUI();
  setupEmojiPicker();
  setupKeyboardShortcuts();
  updateWhisperBtn();
  toggleEncryptionButton();
  updateMobilePanelOverlay();
  applyDesktopSidebarState();
  applyDesktopRightPanelState();

  // Request permission to show native OS notifications
  requestNotificationPermission();

  // When running in the Electron desktop app, listen for notification-click
  // events from the main process so we can switch to the right group.
  if (window.electronAPI) {
    window.electronAPI.onFocusGroup((groupId) => {
      const target = groups.find(g => g.id === groupId);
      if (target) selectGroup(target.id);
    });
  }

  // Clear page title notification when page is focused
  window.addEventListener('focus', () => {
    clearPageTitleNotification();
    observeCurrentGroupRowsForRead();
  });
  window.addEventListener('blur', () => {
    // Start tracking unread when page loses focus
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') observeCurrentGroupRowsForRead();
  });
  window.addEventListener('resize', () => {
    if (!isMobileLayout()) {
      $('sidebar').classList.remove('open');
      $('right-panel').classList.remove('open');
    }
    updateMobilePanelOverlay();
    applyDesktopSidebarState();
    applyDesktopRightPanelState();
  });
  window.addEventListener('storage', (event) => {
    const userKey = getUserSettingsStorageKey(currentUser && currentUser.id);
    if (event.key !== ACTIVE_LOCAL_SETTINGS_KEY && event.key !== LEGACY_LOCAL_SETTINGS_KEY && event.key !== userKey) return;
    loadMergedLocalSettings();
    renderGroupList();
  });
});

// ── Load groups ───────────────────────────────────────────────────────────────
async function loadGroups() {
  try {
    const res = await fetch('/api/groups/mine');
    if (!res.ok) return;
    groups = await res.json();
    renderGroupList();
  } catch(err) { console.error('loadGroups error:', err); }
}

function renderGroupList() {
  const list = $('group-list');
  const empty = $('empty-groups');
  list.innerHTML = '';
  list.appendChild(empty);
  if (groups.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const g of groups) {
    list.appendChild(buildGroupItem(g));
  }
}

function buildGroupItem(g) {
  const item = document.createElement('div');
  item.className = 'group-item' + (g.id === currentGroupId ? ' active' : '');
  item.dataset.groupId = g.id;

  const av = document.createElement('div');
  av.className = 'group-item-avatar';
  av.style.background = groupAvatarColor(g);
  av.textContent = g.name[0].toUpperCase();

  const info = document.createElement('div');
  info.className = 'group-item-info';

  const name = document.createElement('div');
  name.className = 'group-item-name';
  name.textContent = g.name;

  const preview = document.createElement('div');
  preview.className = 'group-item-preview';
  preview.id = 'preview-' + g.id;
  preview.textContent = g._lastPreview || '';

  info.append(name, preview);

  const badge = document.createElement('span');
  badge.className = 'group-item-badge';
  badge.id = 'badge-' + g.id;
  const cnt = unreadCounts[g.id] || 0;
  badge.textContent = '';
  badge.hidden = appLocalSettings.hideProfileDot || cnt === 0;

  item.append(av, info, badge);
  item.addEventListener('click', () => selectGroup(g.id));
  return item;
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i);
  return h;
}

function groupAvatarColor(group) {
  if (group && group.groupColor) return group.groupColor;
  return '#' + Math.abs(hashCode(group && group.name ? group.name : 'group')).toString(16).slice(0, 6).padStart(6, '5');
}

function updateQuickActionButtonState(button, { enabled, labelEnabled }) {
  if (!button) return;
  button.disabled = !enabled;
  button.dataset.label = enabled ? labelEnabled : 'Feature disabled by owner';
  button.title = enabled ? labelEnabled : 'Feature disabled by owner';
}

function updateGroupActionButtons(isOwner) {
  const exportBtn = $('export-btn');
  const clearBtn = $('clear-history-btn');
  const leaveBtn = $('leave-group-btn');
  const disbandBtn = $('disband-btn');

  const canMemberExport = !!(currentGroupData && currentGroupData.allowMemberExport);
  const canMemberClear = !!(currentGroupData && currentGroupData.allowMemberClear);

  if (isOwner) {
    updateQuickActionButtonState(exportBtn, { enabled: true, labelEnabled: 'Export chat as TXT' });
    updateQuickActionButtonState(clearBtn, { enabled: true, labelEnabled: 'Clear chat history' });
  } else {
    updateQuickActionButtonState(exportBtn, { enabled: canMemberExport, labelEnabled: 'Export chat as TXT' });
    updateQuickActionButtonState(clearBtn, { enabled: canMemberClear, labelEnabled: 'Clear chat history' });
  }

  if (leaveBtn) {
    leaveBtn.hidden = !!isOwner;
    leaveBtn.dataset.label = 'Exit group';
  }
  if (disbandBtn) {
    disbandBtn.hidden = !isOwner;
    disbandBtn.dataset.label = 'Disband group';
  }
}

function canCurrentUserKickMember(targetUserId) {
  if (!currentGroupData || !currentUser) return false;
  if (String(targetUserId) === String(currentUser.id)) return false;
  if (String(targetUserId) === String(currentGroupData.createdBy)) return false;
  const isOwner = String(currentGroupData.createdBy) === String(currentUser.id);
  if (isOwner) return true;
  return !!currentGroupData.allowMemberKick;
}

function updateGroupPreview(groupId, text, time) {
  const el = $('preview-' + groupId);
  if (el) el.textContent = (time ? formatTime(time) + ' ' : '') + truncate(text, 35);
  const g = groups.find(x => x.id === groupId);
  if (g) g._lastPreview = (time ? formatTime(time) + ' ' : '') + truncate(text, 35);
}

async function getMessagePreviewText(msg, groupId = msg.groupId) {
  if (!msg) return '';
  if (msg.type === 'image') return '[Image]';
  if (msg.type === 'file') return '[File: ' + (msg.filename || '') + ']';
  if (msg.type === 'whisper') return '[Whisper]';
  const key = getGroupKey(groupId);
  if (!key || msg.type !== 'text') return '[encrypted]';
  const plaintext = await decryptMessage(msg.encryptedContent, msg.iv, key, groupId);
  return plaintext || '[encrypted]';
}

async function updateGroupPreviewFromMessage(groupId, msg) {
  if (!msg) {
    updateGroupPreview(groupId, '', null);
    return;
  }
  const preview = await getMessagePreviewText(msg, groupId);
  updateGroupPreview(groupId, preview, msg.createdAt);
}

function applyCurrentUserReadState(msg) {
  if (!msg) return;
  if (msg.senderId === currentUser.id) {
    msg.hasRead = true;
    return;
  }
  if (typeof msg.hasRead !== 'boolean') {
    msg.hasRead = false;
  }
}

function updateUnreadBadge(groupId, count) {
  const badge = $('badge-' + groupId);
  if (!badge) return;
  badge.textContent = '';
  badge.hidden = appLocalSettings.hideProfileDot || count === 0;
}

function updateGroupUnseenCount(groupId, messages = []) {
  const unseen = (messages || []).reduce((acc, msg) => {
    if (!msg || msg.senderId === currentUser?.id) return acc;
    return acc + (msg.hasRead === true ? 0 : 1);
  }, 0);
  unreadCounts[groupId] = unseen;
  updateUnreadBadge(groupId, unseen);
}

// ── Select group ──────────────────────────────────────────────────────────────
async function selectGroup(groupId) {
  currentGroupId = groupId;
  currentGroupData = groups.find(g => g.id === groupId) || null;
  replyingTo = null;
  pendingAttachmentRows.clear();
  whisperRecipients = [];
  messageMode = 'normal';
  updateWhisperBtn();
  resetReadTracking();

  scrollUnreadCount = 0;
  updateScrollBadge();

  // Update sidebar active state
  document.querySelectorAll('.group-item').forEach(el => {
    el.classList.toggle('active', el.dataset.groupId === groupId);
  });

  // Show chat area
  $('chat-empty').hidden = true;
  $('chat-active').hidden = false;
  $('reply-preview-bar').hidden = true;

  // Set header
  $('chat-group-name').textContent = currentGroupData ? currentGroupData.name : '';
  $('edit-group-name-input').value = currentGroupData ? currentGroupData.name : '';
  $('right-group-code').textContent = currentGroupData ? currentGroupData.code : '';
  $('right-panel-content').hidden = false;
  $('right-panel-empty').hidden = true;

  // Owner controls
  const isOwner = currentGroupData && currentGroupData.createdBy === currentUser.id;
  $('owner-actions').hidden = !isOwner;
  $('set-group-color-btn').hidden = !isOwner;
  $('common-actions').hidden = false;
  if (currentGroupData) {
    $('allow-member-clear-toggle').checked = !!currentGroupData.allowMemberClear;
    $('allow-member-export-toggle').checked = !!currentGroupData.allowMemberExport;
    $('allow-member-kick-toggle').checked = !!currentGroupData.allowMemberKick;
  }
  updateGroupActionButtons(isOwner);

  // Key state
  updateKeyState();

  // Socket room
  if (socket) socket.emit('join_room', groupId);

  const cache = ensureGroupCacheEntry(groupId);
  if (!cache.messages || !cache.members || !cache.messageRows) {
    messagesArea().replaceChildren(createLoadMoreIndicator());
    members = [];
    renderMembersList();
    renderWhisperPicker();
    $('chat-member-count').textContent = 'Loading…';
    await ensureGroupDataPreloaded(groupId);
    if (currentGroupId !== groupId) return;
  }
  renderGroupFromCache(groupId);
  updateGroupUnseenCount(groupId, allMessages);
  observeCurrentGroupRowsForRead();
  scrollToBottom(true);
  $('scroll-bottom-btn').hidden = true;

  // Close mobile panels
  if (isMobileLayout()) closeMobilePanels();
}

function updateKeyState() {
  const key = currentGroupId ? getGroupKey(currentGroupId) : null;
  const hasKey = !!key;
  const input = $('message-input');
  const sendBtn = $('send-btn');
  setElementIcon($('set-key-btn'), 'key-round', { label: hasKey ? 'Change Key' : 'Set Key' });
  input.disabled = !hasKey;
  input.placeholder = hasKey ? 'Type a message…' : 'Enter group key to continue';
  sendBtn.disabled = !hasKey;
}

// ── Load messages ─────────────────────────────────────────────────────────────
async function loadMessages(groupId, before) {
  // Guard: prevent the scroll handler from triggering loadOlderMessages while
  // the initial (non-paginated) load is still in flight (#2).
  if (!before && groupId === currentGroupId) loadingOlder = true;
  try {
    const url = `/api/groups/${groupId}/messages` + (before ? `?before=${before}&limit=50` : '?limit=50');
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 401) { window.location.href = 'index.html'; return; }
      return;
    }
    const msgs = await res.json();
    if (!before) {
      const cache = ensureGroupCacheEntry(groupId);
      cache.messages = msgs;
      cache.messageRows = await buildMessageRows(msgs, groupId);
      cache.oldestMessageId = msgs.length > 0 ? msgs[0].id : null;
      cache.rowsDirty = false;
      writeLocalGroupCache(groupId, cache);
      updateGroupUnseenCount(groupId, msgs);
      await updateGroupPreviewFromMessage(groupId, msgs.length ? msgs[msgs.length - 1] : null);
    } else {
      // Prepend older messages
      const area = messagesArea();
      const prevScrollHeight = area.scrollHeight;
      const rows = await buildMessageRows(msgs, groupId);
      const fragment = document.createDocumentFragment();
      for (const row of rows) {
        if (!row) continue;
        if (row.classList && row.classList.contains('msg-row')) {
          const msgId = row.dataset.msgId;
          const srcMsg = msgs.find((m) => String(m.id) === String(msgId));
          if (srcMsg) observeMessageForRead(row, srcMsg);
        }
        fragment.appendChild(row);
      }
      const oldFirst = area.querySelector('.msg-row, .msg-system');
      if (oldFirst) area.insertBefore(fragment, oldFirst);
      else area.appendChild(fragment);
      allMessages = [...msgs, ...allMessages];
      const cache = ensureGroupCacheEntry(groupId);
      cache.messages = allMessages;
      cache.messageRows = [...rows, ...(cache.messageRows || [])];
      cache.oldestMessageId = msgs[0].id;
      cache.rowsDirty = false;
      writeLocalGroupCache(groupId, cache);
      // Restore scroll position
      area.scrollTop = area.scrollHeight - prevScrollHeight;
    }
    if (!before && groupId === currentGroupId && msgs.length > 0) {
      oldestMessageId = msgs[0].id;
    }
  } catch(err) { console.error('loadMessages error:', err); }
  finally { if (!before && groupId === currentGroupId) loadingOlder = false; }
}

// ── Load members ──────────────────────────────────────────────────────────────
async function loadMembers(groupId) {
  try {
    const res = await fetch(`/api/groups/${groupId}/members`);
    if (!res.ok) return;
    const cache = ensureGroupCacheEntry(groupId);
    cache.members = await res.json();
    writeLocalGroupCache(groupId, cache);
  } catch(err) { console.error('loadMembers error:', err); }
}

function renderMembersList() {
  const list = $('members-list');
  list.innerHTML = '';
  for (const m of members) {
    const li = document.createElement('li');
    li.className = 'member-item';
    li.dataset.userId = m.id;

    const av = document.createElement('div');
    av.className = 'member-avatar';
    renderAvatarElement(av, m);

    if (onlineUsers.has(m.id)) {
      const dot = document.createElement('span');
      dot.className = 'member-online-dot';
      av.appendChild(dot);
    }

    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = m.username;

    li.append(av, name);

    if (currentGroupData && m.id === currentGroupData.createdBy) {
      const tag = document.createElement('span');
      tag.className = 'member-owner-tag';
      tag.textContent = 'Owner';
      li.appendChild(tag);
    }

    if (canCurrentUserKickMember(m.id)) {
      const kickBtn = document.createElement('button');
      kickBtn.className = 'member-kick-btn';
      kickBtn.title = 'Kick member';
      kickBtn.setAttribute('aria-label', 'Kick member');
      setElementIcon(kickBtn, 'x', { iconOnly: true });
      kickBtn.addEventListener('click', (e) => { e.stopPropagation(); kickMember(m.id, m.username); });
      li.appendChild(kickBtn);
    }

    list.appendChild(li);
  }
}

function renderWhisperPicker() {
  const list = $('whisper-picker-list');
  list.innerHTML = '';
  for (const m of members) {
    if (m.id === currentUser.id) continue;
    const item = document.createElement('div');
    item.className = 'whisper-picker-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'wp-' + m.id;
    cb.value = m.id;
    cb.checked = whisperRecipients.includes(m.id);
    cb.addEventListener('change', () => {
      if (cb.checked) { if (!whisperRecipients.includes(m.id)) whisperRecipients.push(m.id); }
      else whisperRecipients = whisperRecipients.filter(id => id !== m.id);
    });
    const lbl = document.createElement('label');
    lbl.htmlFor = 'wp-' + m.id;
    lbl.textContent = m.username;
    item.append(cb, lbl);
    list.appendChild(item);
  }
}

// ── Build & append message bubbles ────────────────────────────────────────────
async function buildMessageRow(msg, groupId = msg.groupId || currentGroupId, options = {}) {
  const isOwn = msg.senderId === currentUser.id;
  const showSenderName = options.showSenderName !== false;
  const isReadByMe = isOwn || msg.hasRead === true;

  // System message
  if (msg.type === 'system') {
    const div = document.createElement('div');
    div.className = 'msg-system';
    div.textContent = msg.encryptedContent;
    return div;
  }

  // Whisper — hide if not recipient or sender
  if (msg.type === 'whisper') {
    let recipients = [];
    if (msg.whisperTo) {
      try { recipients = JSON.parse(msg.whisperTo); } catch { recipients = msg.whisperTo.split(','); }
    }
    const normalizedRecipients = recipients.map((id) => String(id));
    if (!isOwn && !normalizedRecipients.includes(String(currentUser.id))) return null;
  }

  const row = document.createElement('div');
  row.className = 'msg-row' + (isOwn ? ' own' : '') + (msg.type === 'whisper' ? ' whisper' : '');
  row.dataset.msgId = msg.id;
  row.dataset.senderId = msg.senderId;
  row.dataset.hasRead = isReadByMe ? '1' : '0';
  if (!isReadByMe) row.classList.add('unseen');

  const av = document.createElement('div');
  av.className = 'msg-avatar';
  const memberProfile = getMemberProfile(groupId, msg.senderId);
  renderAvatarElement(av, {
    username: memberProfile?.username || msg.senderName,
    iconColor: memberProfile?.iconColor || msg.senderColor,
    profilePicture: memberProfile?.profilePicture || null,
  });

  const content = document.createElement('div');
  content.className = 'msg-content';

  // Sender name (for others)
  if (!isOwn && showSenderName) {
    const nameEl = document.createElement('div');
    nameEl.className = 'msg-sender-name';
    nameEl.textContent = memberProfile?.username || msg.senderName || 'Unknown';
    content.appendChild(nameEl);
  } else if (!isOwn && !showSenderName) {
    row.classList.add('series-continued');
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.dataset.encContent = msg.encryptedContent || '';
  bubble.dataset.iv = msg.iv || '';

  // Whisper label
  if (msg.type === 'whisper') {
    const wl = document.createElement('span');
    wl.className = 'whisper-label';
    wl.textContent = 'Whisper' + (msg.whisperTo ? ' (private)' : '');
    bubble.appendChild(wl);
  }

  // Reply quote
  if (msg.replyTo) {
    try {
      const rData = typeof msg.replyTo === 'string' ? JSON.parse(msg.replyTo) : msg.replyTo;
      const rb = document.createElement('div');
      rb.className = 'msg-reply-box';
      rb.innerHTML = '<span class="msg-reply-sender">' + escapeHtml(rData.senderName || '') + '</span>' + escapeHtml(truncate(rData.preview || '', 60));
      rb.addEventListener('click', () => scrollToMessage(rData.id));
      bubble.appendChild(rb);
    } catch { /* malformed reply data */ }
  }

  // Message content
  const textEl = document.createElement('span');
  textEl.className = 'msg-text';
  await renderMsgContent(msg, textEl, bubble, groupId);

  bubble.appendChild(textEl);

  // Timestamp + delivery + edited badge
  const meta = document.createElement('span');
  meta.className = 'msg-meta';
  meta.textContent = formatTime(msg.createdAt);
  if (msg.editedAt) {
    const editedBadge = document.createElement('span');
    editedBadge.className = 'msg-edited-badge';
    editedBadge.textContent = ' (edited)';
    meta.appendChild(editedBadge);
  }
  if (isOwn) {
    const del = document.createElement('span');
    del.className = 'msg-delivery';
    del.id = 'del-' + msg.id;
    const { total, read } = normalizeDeliveryCounts(msg.totalRecipients, msg.readCount);
    del.dataset.totalRecipients = String(total);
    del.dataset.readCount = String(read);
    renderDeliveryTicks(del, total, read);
    meta.appendChild(del);
  }
  bubble.appendChild(meta);

  content.appendChild(bubble);

  // Right-click context menu
  bubble.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e, msg, textEl.textContent);
  });

  // Long-press for mobile
  let longPressTimer;
  bubble.addEventListener('touchstart', () => {
    longPressTimer = setTimeout(() => showContextMenu(null, msg, textEl.textContent), 600);
  });
  bubble.addEventListener('touchend', () => clearTimeout(longPressTimer));

  if (isOwn) {
    row.append(content);
  } else {
    row.append(av, content);
  }

  return row;
}

async function renderMsgContent(msg, textEl, bubble, groupId = currentGroupId) {
  const key = groupId ? getGroupKey(groupId) : null;

  if (!encryptionVisible) {
    if (msg.type === 'image') textEl.textContent = '[encrypted image]';
    else if (msg.type === 'file') textEl.textContent = '[encrypted file: ' + (msg.filename || '') + ']';
    else textEl.textContent = msg.encryptedContent || '[no content]';
    return;
  }

  if (msg.type === 'image') {
    if (!key) {
      const locked = document.createElement('div');
      locked.className = 'msg-image-locked';
      locked.appendChild(createIcon('lock'));
      bubble.appendChild(locked);
    } else {
      const buf = await decryptBytes(msg.encryptedContent, msg.iv, key, groupId);
      if (buf) {
        const mimeType = detectImageMime(buf) || 'image/jpeg';
        const blob = new Blob([buf], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const img = document.createElement('img');
        img.className = 'msg-image';
        img.src = url;
        img.alt = 'image';
        img.style.cursor = 'pointer';
        img.addEventListener('click', (e) => {
          e.stopPropagation();
          showImageViewer(url);
        });
        bubble.appendChild(img);
      } else {
        const locked = document.createElement('div');
        locked.className = 'msg-image-locked';
        locked.appendChild(createIcon('lock'));
        bubble.appendChild(locked);
      }
    }
    return;
  }

  if (msg.type === 'file') {
    if (!key) {
      textEl.textContent = 'Locked: ' + (msg.filename || 'file');
    } else {
      const buf = await decryptBytes(msg.encryptedContent, msg.iv, key, groupId);
      if (buf) {
        const btn = document.createElement('a');
        btn.className = 'msg-file-btn';
        const fileIcon = document.createElement('span');
        fileIcon.className = 'msg-file-icon';
        fileIcon.appendChild(createIcon('paperclip'));
        btn.appendChild(fileIcon);
        const info = document.createElement('span');
        info.textContent = msg.filename || 'file';
        btn.appendChild(info);
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const blob = new Blob([buf]);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = msg.filename || 'download';
          a.click(); URL.revokeObjectURL(url);
        });
        bubble.appendChild(btn);
      } else {
        textEl.textContent = 'Locked: ' + (msg.filename || 'file');
      }
    }
    return;
  }

  // Text message
  if (!key) {
    textEl.textContent = MSG_NO_KEY;
    return;
  }

  const plaintext = await decryptMessage(msg.encryptedContent, msg.iv, key, groupId);
  if (plaintext === null) {
    textEl.textContent = MSG_DECRYPT_FAIL;
  } else {
    textEl.textContent = plaintext;
  }
}

async function appendMessageBubble(msg, scroll, groupId = currentGroupId) {
  const previousMessage = allMessages.length ? allMessages[allMessages.length - 1] : null;
  const showSenderName = !shouldContinueSeries(previousMessage, msg);
  const row = await buildMessageRow(msg, groupId, { showSenderName });
  if (!row) return;

  const area = messagesArea();
  const cache = ensureGroupCacheEntry(groupId);

  if (!previousMessage || !isSameMessageDay(previousMessage.createdAt, msg.createdAt)) {
    const dayDivider = createDateDivider(msg.createdAt);
    area.appendChild(dayDivider);
    cache.messageRows = cache.messageRows || [];
    cache.messageRows.push(dayDivider);
  }

  area.appendChild(row);
  observeMessageForRead(row, msg);
  allMessages.push(msg);
  cache.messages = allMessages;
  cache.messageRows = cache.messageRows || [];
  cache.messageRows.push(row);
  cache.oldestMessageId = allMessages.length ? allMessages[0].id : null;
  cache.rowsDirty = false;
  writeLocalGroupCache(groupId, cache);

  // Scroll behavior
  if (scroll !== false) {
    if (msg.senderId === currentUser.id) {
      scrollToBottom(true);
      return row;
    }
    const isAtBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 150;
    if (isAtBottom) {
      scrollToBottom();
    } else {
      // User is scrolled up — increment badge
      scrollUnreadCount++;
      updateScrollBadge();
      if (msg.senderId !== currentUser.id) playNotifSound();
    }
  }
  return row;
}

function updateScrollBadge() {
  const btn = $('scroll-bottom-btn');
  const badge = $('scroll-unread-badge');
  btn.hidden = false;
  badge.textContent = scrollUnreadCount;
  badge.hidden = scrollUnreadCount === 0;
}

function scrollToBottom(instant) {
  const area = messagesArea();
  if (!area) return;
  area.scrollTo({ top: area.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
  scrollUnreadCount = 0;
  updateScrollBadge();
  $('scroll-bottom-btn').hidden = true;
}

function scrollToMessage(msgId) {
  const row = document.querySelector('[data-msg-id="' + msgId + '"]');
  if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Context menu ──────────────────────────────────────────────────────────────
let ctxMsg = null;
let ctxText = '';
function showContextMenu(e, msg, text) {
  ctxMsg = msg; ctxText = text;
  const menu = $('ctx-menu');
  const isAttachment = msg.type === 'image' || msg.type === 'file';
  $('ctx-reply').hidden = false;
  $('ctx-download').hidden = !isAttachment;
  $('ctx-copy').hidden = isAttachment;
  setElementIcon($('ctx-copy'), 'copy', { label: 'Copy Text' });
  menu.hidden = false;
  if (e) {
    menu.style.left = Math.min(e.clientX, window.innerWidth - 160) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
  } else {
    menu.style.left = '50%'; menu.style.top = '50%';
  }
}

function hideContextMenu() { $('ctx-menu').hidden = true; ctxMsg = null; }

async function getAttachmentData(msg) {
  if (!msg || (msg.type !== 'image' && msg.type !== 'file')) return null;
  const key = currentGroupId ? getGroupKey(currentGroupId) : null;
  if (!key) {
    showToast('Set group key first', 'error');
    return null;
  }
  const bytes = await decryptBytes(msg.encryptedContent, msg.iv, key, currentGroupId);
  if (!bytes) {
    showToast('Unable to decrypt file', 'error');
    return null;
  }
  const detectedImageMime = msg.type === 'image' ? detectImageMime(bytes) : null;
  const mimeType = detectedImageMime || 'application/octet-stream';
  const blob = new Blob([bytes], { type: mimeType });
  let filename = msg.filename;
  if (!filename) {
    if (detectedImageMime === 'image/png') filename = 'image.png';
    else if (detectedImageMime === 'image/gif') filename = 'image.gif';
    else if (detectedImageMime === 'image/webp') filename = 'image.webp';
    else filename = msg.type === 'image' ? 'image.jpg' : 'file.bin';
  }
  return { blob, filename, mimeType };
}

async function copyAttachmentToClipboard(msg) {
  const data = await getAttachmentData(msg);
  if (!data) return;
  try {
    if (window.electronAPI?.copyBinaryToClipboard) {
      const ab = await data.blob.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let binary = '';
      const step = 32768;
      for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode(...bytes.subarray(i, i + step));
      }
      const ok = await window.electronAPI.copyBinaryToClipboard({
        base64: btoa(binary),
        mimeType: data.mimeType,
        filename: data.filename,
      });
      if (ok) {
        showToast('Copied to clipboard', 'success');
        return;
      }
    }

    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      const item = new ClipboardItem({
        [data.mimeType]: data.blob,
        'text/plain': new Blob([data.filename], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      showToast('Copied to clipboard', 'success');
      return;
    }

    if (typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(data.filename);
      showToast('Filename copied to clipboard', 'success');
      return;
    }

    const fallback = document.createElement('textarea');
    fallback.value = data.filename;
    fallback.setAttribute('readonly', '');
    fallback.style.position = 'fixed';
    fallback.style.left = '-9999px';
    document.body.appendChild(fallback);
    fallback.select();
    console.warn('Using deprecated execCommand clipboard fallback');
    const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
    document.body.removeChild(fallback);
    if (copied) {
      showToast('Filename copied to clipboard', 'success');
      return;
    }

    showToast('Failed to copy file to clipboard', 'error');
    return;
  } catch (err) {
    console.error('copyAttachmentToClipboard error:', err);
    showToast('Failed to copy file to clipboard', 'error');
  }
}

function setWallpaperSaveState(enabled) {
  const saveBtn = $('wallpaper-save-btn');
  if (!saveBtn) return;
  saveBtn.disabled = !enabled;
}

function resetWallpaperDraft() {
  pendingWallpaperDataUrl = null;
  $('wallpaper-error').textContent = '';
  $('wallpaper-input').value = '';
  setWallpaperSaveState(false);
  applyWallpaperFromSettings();
}

async function saveWallpaperDraft() {
  if (!pendingWallpaperDataUrl) {
    $('wallpaper-error').textContent = WALLPAPER_SELECT_FIRST_MSG;
    return;
  }
  appLocalSettings.wallpaperDataUrl = pendingWallpaperDataUrl;
  applyWallpaperFromSettings();
  writeLocalSettings(appLocalSettings, currentUser && currentUser.id);
  const saved = await saveSettingsToServer();
  if (!saved) {
    showToast(WALLPAPER_SAVE_SYNC_FAIL_MSG, 'info');
  }
  $('wallpaper-modal').hidden = true;
  resetWallpaperDraft();
  showToast(WALLPAPER_SAVE_SUCCESS_MSG, 'success');
}

function applyWallpaperDraftPreview(dataUrl) {
  const preview = $('wallpaper-current-preview');
  if (preview) {
    preview.src = dataUrl || appLocalSettings.wallpaperDataUrl || DEFAULT_WALLPAPER_PREVIEW_SRC;
  }
}

async function downloadAttachment(msg) {
  const data = await getAttachmentData(msg);
  if (!data) return;
  const url = URL.createObjectURL(data.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = data.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

// ── Edit message ──────────────────────────────────────────────────────────────
async function startEditMessage(msg, currentPlaintext) {
  const row = document.querySelector('[data-msg-id="' + msg.id + '"]');
  if (!row) return;
  const bubble = row.querySelector('.msg-bubble');
  const textEl = row.querySelector('.msg-text');
  if (!bubble || !textEl) return;

  // Replace text span with an inline edit form
  const editForm = document.createElement('div');
  editForm.className = 'msg-edit-form';
  const editInput = document.createElement('textarea');
  editInput.className = 'msg-edit-input';
  editInput.value = currentPlaintext;
  const CHARS_PER_ROW = 50; // approximate chars per row for initial textarea height
  editInput.rows = Math.max(1, Math.ceil(currentPlaintext.length / CHARS_PER_ROW));
  const editSave = document.createElement('button');
  editSave.className = 'msg-edit-save';
  editSave.textContent = 'Save';
  const editCancel = document.createElement('button');
  editCancel.className = 'msg-edit-cancel';
  editCancel.textContent = 'Cancel';
  editForm.append(editInput, editSave, editCancel);

  // Hide the text span, inject form
  textEl.hidden = true;
  bubble.insertBefore(editForm, textEl);
  editInput.focus();
  editInput.setSelectionRange(editInput.value.length, editInput.value.length);

  const cancelEdit = () => {
    editForm.remove();
    textEl.hidden = false;
  };

  editCancel.addEventListener('click', cancelEdit);
  editInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelEdit();
  });

  editSave.addEventListener('click', async () => {
    const newText = editInput.value.trim();
    if (!newText || newText === currentPlaintext) { cancelEdit(); return; }
    const key = getGroupKey(currentGroupId);
    if (!key) { showToast('Set group key first', 'error'); cancelEdit(); return; }
    editSave.disabled = true;
    try {
      const { encryptedContent, iv } = await encryptMessage(newText, key, currentGroupId);
      const res = await fetch(`/api/groups/${currentGroupId}/messages/${msg.id}`, {
        method: 'PATCH',
        headers: apiHeaders(),
        body: JSON.stringify({ encryptedContent, iv }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        showToast(d.error || 'Edit failed', 'error');
        editSave.disabled = false;
      } else {
        cancelEdit();
        // The message_edited socket event will update the bubble for everyone
      }
    } catch(err) {
      console.error('Edit error:', err);
      showToast('Edit failed', 'error');
      editSave.disabled = false;
    }
  });
}

// ── Send message ──────────────────────────────────────────────────────────────
async function doSend(text) {
  if (!currentGroupId || !socket) return;
  const key = getGroupKey(currentGroupId);
  if (!key) return;
  if (!text.trim()) return;

  // Client-side rate limiting
  const now = Date.now();
  clientRateLimiter.times = clientRateLimiter.times.filter(t => now - t < 3000);
  if (clientRateLimiter.times.length >= 5) {
    showToast('Sending too fast, slow down', 'error');
    return;
  }
  // Repeated message check
  if (text === clientRateLimiter.lastContent) {
    clientRateLimiter.repeatCount = (clientRateLimiter.repeatCount || 0) + 1;
    if (clientRateLimiter.repeatCount >= 3) {
      showToast("Don't send the same message repeatedly", 'error');
      return;
    }
  } else {
    clientRateLimiter.repeatCount = 0;
    clientRateLimiter.lastContent = text;
  }
  clientRateLimiter.times.push(now);

  try {
    const { encryptedContent, iv } = await encryptMessage(text, key, currentGroupId);

    // Build replyTo data
    let replyToData = null;
    if (replyingTo) {
      replyToData = JSON.stringify({
        id: replyingTo.id,
        senderName: replyingTo.senderName,
        preview: replyingTo.preview,
      });
    }

    if (messageMode === 'whisper' && whisperRecipients.length > 0) {
      socket.emit('send_whisper', {
        groupId: currentGroupId,
        encryptedContent, iv,
        whisperTo: whisperRecipients,
        replyTo: replyToData,
      });
    } else {
      socket.emit('send_message', { groupId: currentGroupId, encryptedContent, iv, replyTo: replyToData });
    }

    // Stop typing indicator
    clearTimeout(window._myTypingTimer);
    socket.emit('stop_typing', { groupId: currentGroupId });

    // Clear reply
    replyingTo = null;
    $('reply-preview-bar').hidden = true;

    // Clear input
    const inp = $('message-input');
    inp.value = '';
    autoResizeTextarea(inp);
    scrollToBottom(true);
  } catch(err) {
    console.error('Encryption failed:', err);
    showToast('Failed to send message', 'error');
  }
}

// ── Toast notification ────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  // Stack toasts: offset each new one above the previous
  const existing = document.querySelectorAll('.toast');
  const offset = existing.length * 52;
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  el.style.bottom = (24 + offset) + 'px';
  document.body.appendChild(el);
  const remove = () => {
    el.classList.add('hiding');
    setTimeout(() => el.remove(), 320);
  };
  setTimeout(remove, 3000);
}

// ── File / Image upload ───────────────────────────────────────────────────────
function ensurePendingAttachmentRow(payload) {
  const { uploadId, senderId, senderName, senderColor, type, filename, totalBytes } = payload;
  if (!uploadId || pendingAttachmentRows.has(uploadId) || payload.groupId !== currentGroupId) return;

  const isOwn = senderId === currentUser.id;
  const row = document.createElement('div');
  row.className = 'msg-row pending' + (isOwn ? ' own' : '');
  row.dataset.uploadId = uploadId;

  const content = document.createElement('div');
  content.className = 'msg-content';
  if (!isOwn) {
    const nameEl = document.createElement('div');
    nameEl.className = 'msg-sender-name';
    nameEl.textContent = senderName || 'Unknown';
    content.appendChild(nameEl);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  const progressWrap = document.createElement('div');
  progressWrap.className = 'msg-attachment-progress';
  const progressTrack = document.createElement('div');
  progressTrack.className = 'msg-attachment-progress-track';
  const progressFill = document.createElement('div');
  progressFill.className = 'msg-attachment-progress-fill';
  const progressLabel = document.createElement('span');
  progressLabel.className = 'msg-attachment-progress-label';
  progressLabel.textContent = `0 B / ${formatBytes(totalBytes)}`;
  progressTrack.appendChild(progressFill);
  progressWrap.append(progressTrack, progressLabel);
  bubble.appendChild(progressWrap);

  if (type === 'image') {
    const locked = document.createElement('div');
    locked.className = 'msg-image-locked';
    locked.appendChild(createIcon('image'));
    bubble.appendChild(locked);
  } else {
    const text = document.createElement('span');
    text.className = 'msg-text';
    text.textContent = filename || 'file';
    bubble.appendChild(text);
  }

  const meta = document.createElement('span');
  meta.className = 'msg-meta';
  meta.textContent = 'Preparing…';
  bubble.appendChild(meta);
  content.appendChild(bubble);

  if (isOwn) {
    row.append(content);
  } else {
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    renderAvatarElement(avatar, { username: senderName, iconColor: senderColor });
    row.append(avatar, content);
  }
  messagesArea().appendChild(row);
  pendingAttachmentRows.set(uploadId, row);
  pinMessagesToBottom(true);
}

function updatePendingAttachmentProgress(uploadId, loadedBytes, totalBytes) {
  const row = pendingAttachmentRows.get(uploadId);
  if (!row) return;
  const fill = row.querySelector('.msg-attachment-progress-fill');
  const label = row.querySelector('.msg-attachment-progress-label');
  const total = Math.max(1, Number(totalBytes) || 1);
  const loaded = Math.max(0, Math.min(total, Number(loadedBytes) || 0));
  if (fill) fill.style.width = `${(loaded / total) * 100}%`;
  if (label) label.textContent = `${formatBytes(loaded)} / ${formatBytes(total)}`;
}

function setPendingAttachmentStatus(uploadId, statusText) {
  const row = pendingAttachmentRows.get(uploadId);
  if (!row) return;
  const meta = row.querySelector('.msg-meta');
  if (meta) meta.textContent = statusText;
}

function removePendingAttachment(uploadId) {
  const row = pendingAttachmentRows.get(uploadId);
  if (!row) return;
  row.remove();
  pendingAttachmentRows.delete(uploadId);
}

function uploadEncryptedAttachment(groupId, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/groups/${groupId}/upload`);
    const headers = apiHeaders();
    for (const [key, val] of Object.entries(headers)) xhr.setRequestHeader(key, val);
    xhr.upload.onprogress = (evt) => {
      if (!evt.lengthComputable || typeof onProgress !== 'function') return;
      onProgress(evt.loaded, evt.total);
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.onload = () => {
      const raw = xhr.responseText || '{}';
      let data = {};
      try { data = JSON.parse(raw); } catch { /* ignore parse errors */ }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };
    if (body && body.encryptedBytes instanceof Uint8Array) {
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Upload-IV', body.iv);
      xhr.setRequestHeader('X-Upload-Type', body.type);
      xhr.setRequestHeader('X-Upload-Filename', encodeURIComponent(body.filename || 'file'));
      xhr.setRequestHeader('X-Client-Upload-Id', body.clientUploadId || '');
      xhr.send(body.encryptedBytes);
      return;
    }
    xhr.send(JSON.stringify(body));
  });
}

async function handleFileUpload(file) {
  if (!currentGroupId || !socket) return;
  const key = getGroupKey(currentGroupId);
  if (!key) {
    showToast('Set group key first', 'error');
    return;
  }
  const uploadId = createUploadId();

  const MAX_RAW = 25 * 1024 * 1024 * 1024; // 25GB

  let processedFile = file;
  const isImage = file.type.startsWith('image/');

  if (isImage) {
    processedFile = await compressImage(file);
    if (processedFile.size > MAX_RAW) {
      showToast('Image too large (max 25GB after compression)', 'error');
      return;
    }
  } else {
    if (file.size > MAX_RAW) {
      showToast('File too large (max 25GB)', 'error');
      return;
    }
  }

  try {
    const totalBytes = processedFile.size;
    const progressPayload = {
      groupId: currentGroupId,
      uploadId,
      type: isImage ? 'image' : 'file',
      filename: file.name,
      totalBytes,
      loadedBytes: 0,
      senderId: currentUser.id,
      senderName: currentUser.username,
      senderColor: currentUser.iconColor,
    };
    ensurePendingAttachmentRow(progressPayload);
    socket.emit('attachment_upload_progress', progressPayload);
    setPendingAttachmentStatus(uploadId, 'Preparing…');

    const buffer = await processedFile.arrayBuffer();
    updatePendingAttachmentProgress(uploadId, Math.max(1, Math.round(totalBytes * 0.2)), totalBytes);
    setPendingAttachmentStatus(uploadId, 'Encrypting…');
    const { encryptedBytes, iv } = await encryptBytesRaw(buffer, key, currentGroupId);

    let lastBroadcastLoaded = 0;
    let lastBroadcastAt = 0;
    const emitProgress = (loaded, total, force = false) => {
      const now = Date.now();
      const shouldEmit = force
        || loaded === 0
        || loaded >= total
        || now - lastBroadcastAt >= 120
        || loaded - lastBroadcastLoaded >= Math.max(32768, total * 0.05);
      if (!shouldEmit) return;
      lastBroadcastLoaded = loaded;
      lastBroadcastAt = now;
      socket.emit('attachment_upload_progress', {
        ...progressPayload,
        loadedBytes: loaded,
        totalBytes: total,
      });
    };

    const body = { encryptedBytes, iv, type: isImage ? 'image' : 'file', filename: file.name, clientUploadId: uploadId };
    const res = await uploadEncryptedAttachment(currentGroupId, body, (loaded, total) => {
      updatePendingAttachmentProgress(uploadId, loaded, total);
      setPendingAttachmentStatus(uploadId, 'Uploading…');
      emitProgress(loaded, total || totalBytes);
    });

    if (!res.ok) {
      removePendingAttachment(uploadId);
      socket.emit('attachment_upload_failed', { groupId: currentGroupId, uploadId });
      const d = res.data || {};
      showToast(d.error || 'Upload failed', 'error');
      return;
    }
    updatePendingAttachmentProgress(uploadId, totalBytes, totalBytes);
    setPendingAttachmentStatus(uploadId, 'Finalizing…');
    emitProgress(totalBytes, totalBytes, true);
  } catch(err) {
    console.error('File upload error:', err);
    removePendingAttachment(uploadId);
    socket.emit('attachment_upload_failed', { groupId: currentGroupId, uploadId });
    showToast('Upload failed', 'error');
  }
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────
function initSocket() {
  socket = io({ transports: ['polling', 'websocket'] });

  socket.on('connect', () => {
    $('conn-dot').className = 'conn-dot connected';
    $('conn-label').textContent = 'Connected';
    $('reconnect-banner').hidden = true;
    if (currentGroupId) socket.emit('join_room', currentGroupId);
  });

  socket.on('disconnect', () => {
    $('conn-dot').className = 'conn-dot';
    $('conn-label').textContent = 'Disconnected';
    $('reconnect-banner').hidden = false;
  });

  socket.on('connect_error', () => {
    $('conn-dot').className = 'conn-dot';
    $('conn-label').textContent = 'Connection error';
  });

  socket.on('attachment_upload_progress', (payload) => {
    if (!payload || payload.groupId !== currentGroupId) return;
    ensurePendingAttachmentRow(payload);
    updatePendingAttachmentProgress(payload.uploadId, payload.loadedBytes, payload.totalBytes);
  });

  socket.on('attachment_upload_failed', ({ groupId, uploadId }) => {
    if (groupId !== currentGroupId) return;
    removePendingAttachment(uploadId);
  });

  socket.on('new_message', async (msg) => {
    if (msg.clientUploadId) removePendingAttachment(msg.clientUploadId);
    // Increment page title notification if document is not focused
    if (!document.hasFocus() && msg.senderId !== currentUser.id) {
      unreadNotificationCount++;
      updatePageTitleNotification();
    }

    if (msg.groupId !== currentGroupId) {
      applyCurrentUserReadState(msg);
      const cache = ensureGroupCacheEntry(msg.groupId);
      if (cache.messages) {
        cache.messages.push(msg);
        cache.oldestMessageId = cache.messages.length ? cache.messages[0].id : null;
        writeLocalGroupCache(msg.groupId, cache);
      }
      if (cache.messageRows && !cache.rowsDirty) {
        const prevMsg = cache.messages && cache.messages.length > 1 ? cache.messages[cache.messages.length - 2] : null;
        const row = await buildMessageRow(msg, msg.groupId, { showSenderName: !shouldContinueSeries(prevMsg, msg) });
        if (row) {
          if (!prevMsg || !isSameMessageDay(prevMsg.createdAt, msg.createdAt)) {
            cache.messageRows.push(createDateDivider(msg.createdAt));
          }
          cache.messageRows.push(row);
        }
      }
      // Increment unseen for non-active group (only messages from others)
      if (msg.senderId !== currentUser.id) {
        unreadCounts[msg.groupId] = (unreadCounts[msg.groupId] || 0) + 1;
        updateUnreadBadge(msg.groupId, unreadCounts[msg.groupId]);
        playNotifSound();
      }
      // Update last message preview
      const preview = await getMessagePreviewText(msg, msg.groupId);
      updateGroupPreview(msg.groupId, preview, msg.createdAt);
      // Send native OS notification when a message arrives in a background group
      if (msg.senderId !== currentUser.id) {
        const groupData = groups.find(g => g.id === msg.groupId);
        const groupName = groupData ? groupData.name : 'GChat';
        sendNativeNotification(
          `${msg.senderName} in ${groupName}`,
          getNotificationBody(msg, preview),
          msg.groupId
        );
      }
      return;
    }
    applyCurrentUserReadState(msg);
    if (msg.senderId !== currentUser.id) {
      unreadCounts[msg.groupId] = (unreadCounts[msg.groupId] || 0) + 1;
      updateUnreadBadge(msg.groupId, unreadCounts[msg.groupId]);
    }
    await appendMessageBubble(msg, true, msg.groupId);
    // Update preview
    const preview2 = await getMessagePreviewText(msg, msg.groupId);
    updateGroupPreview(msg.groupId, preview2, msg.createdAt);
    // Send native OS notification when the window is not focused (active group)
    if (!document.hasFocus() && msg.senderId !== currentUser.id) {
      const groupData = groups.find(g => g.id === msg.groupId);
      const groupName = groupData ? groupData.name : 'GChat';
      sendNativeNotification(
        `${msg.senderName} in ${groupName}`,
        getNotificationBody(msg, preview2),
        msg.groupId
      );
    }
  });

  socket.on('message_read_update', ({ messageId, readCount }) => {
    pendingReadMessageIds.delete(messageId);
    updateDeliveryForMessage(messageId, readCount);
    const stored = allMessages.find(m => m.id === messageId);
    if (stored) stored.readCount = Math.max(0, Number(readCount) || 0);
  });

  socket.on('message_deleted', ({ messageId }) => {
    const row = document.querySelector('[data-msg-id="' + messageId + '"]');
    if (row) row.remove();
    for (const [groupId, cache] of groupDataCache.entries()) {
      const index = cache.messages ? cache.messages.findIndex((msg) => msg.id === messageId) : -1;
      if (index === -1) continue;
      cache.messages.splice(index, 1);
      if (groupId === currentGroupId && cache.messageRows) {
        cache.messageRows = cache.messageRows.filter((msgRow) => msgRow?.dataset?.msgId !== messageId);
      } else {
        cache.rowsDirty = true;
      }
      cache.oldestMessageId = cache.messages.length ? cache.messages[0].id : null;
      writeLocalGroupCache(groupId, cache);
      if (groupId === currentGroupId) {
        allMessages = cache.messages;
      }
      break;
    }
  });

  socket.on('message_edited', async ({ messageId, encryptedContent, iv, editedAt }) => {
    const row = document.querySelector('[data-msg-id="' + messageId + '"]');
    if (row) {
      const bubble = row.querySelector('.msg-bubble');
      const textEl = row.querySelector('.msg-text');
      if (bubble && textEl) {
        // Update the stored ciphertext on the bubble dataset
        bubble.dataset.encContent = encryptedContent;
        bubble.dataset.iv = iv;

        // Re-decrypt and update display text
        const key = currentGroupId ? getGroupKey(currentGroupId) : null;
        if (key) {
          const pt = await decryptMessage(encryptedContent, iv, key, currentGroupId);
          textEl.textContent = pt !== null ? pt : MSG_DECRYPT_FAIL;
        } else {
          textEl.textContent = MSG_NO_KEY;
        }

        // Add or update the "(edited)" badge in the meta line
        const metaEl = bubble.querySelector('.msg-meta');
        if (metaEl && !metaEl.querySelector('.msg-edited-badge')) {
          const badge = document.createElement('span');
          badge.className = 'msg-edited-badge';
          badge.textContent = ' (edited)';
          // Insert before delivery receipt if present
          const delEl = metaEl.querySelector('.msg-delivery');
          if (delEl) metaEl.insertBefore(badge, delEl);
          else metaEl.appendChild(badge);
        }
      }
    }

    // Keep caches in sync
    for (const [groupId, cache] of groupDataCache.entries()) {
      const stored = cache.messages ? cache.messages.find((msg) => msg.id === messageId) : null;
      if (!stored) continue;
      stored.encryptedContent = encryptedContent;
      stored.iv = iv;
      stored.editedAt = editedAt;
      if (groupId !== currentGroupId) cache.rowsDirty = true;
      if (groupId === currentGroupId) allMessages = cache.messages;
      writeLocalGroupCache(groupId, cache);
      break;
    }
  });

  socket.on('chat_cleared', ({ groupId }) => {
    const cache = ensureGroupCacheEntry(groupId);
    cache.messages = [];
    cache.messageRows = [];
    cache.members = cache.members || [];
    cache.oldestMessageId = null;
    cache.rowsDirty = false;
    writeLocalGroupCache(groupId, cache);
    if (groupId !== currentGroupId) return;
    renderGroupFromCache(groupId);
    addSystemMessage('Chat history was cleared');
  });

  socket.on('group_renamed', ({ groupId, newName }) => {
    const g = groups.find(x => x.id === groupId);
    if (g) g.name = newName;
    if (groupId === currentGroupId) {
      $('chat-group-name').textContent = newName;
      $('edit-group-name-input').value = newName;
    }
    renderGroupList();
  });

  socket.on('group_settings_updated', ({ groupId, allowMemberClear, allowMemberExport, allowMemberKick, groupColor }) => {
    const group = groups.find((g) => g.id === groupId);
    if (group) {
      if (allowMemberClear !== undefined) group.allowMemberClear = !!allowMemberClear;
      if (allowMemberExport !== undefined) group.allowMemberExport = !!allowMemberExport;
      if (allowMemberKick !== undefined) group.allowMemberKick = !!allowMemberKick;
      if (groupColor !== undefined) group.groupColor = groupColor || null;
    }
    const cache = ensureGroupCacheEntry(groupId);
    if (cache && cache.messages) cache.rowsDirty = true;
    if (groupId !== currentGroupId) {
      renderGroupList();
      return;
    }
    if (currentGroupData) {
      if (allowMemberClear !== undefined) currentGroupData.allowMemberClear = !!allowMemberClear;
      if (allowMemberExport !== undefined) currentGroupData.allowMemberExport = !!allowMemberExport;
      if (allowMemberKick !== undefined) currentGroupData.allowMemberKick = !!allowMemberKick;
      if (groupColor !== undefined) currentGroupData.groupColor = groupColor || null;
    }
    const isOwner = currentGroupData && currentGroupData.createdBy === currentUser.id;
    if (isOwner) {
      $('allow-member-clear-toggle').checked = !!currentGroupData.allowMemberClear;
      $('allow-member-export-toggle').checked = !!currentGroupData.allowMemberExport;
      $('allow-member-kick-toggle').checked = !!currentGroupData.allowMemberKick;
    }
    updateGroupActionButtons(isOwner);
    renderMembersList();
    renderGroupList();
  });

  socket.on('member_joined', ({ userId, username, iconColor, profilePicture, groupId }) => {
    const cache = ensureGroupCacheEntry(groupId);
    if (cache.members && !cache.members.find(m => m.id === userId)) {
      cache.members.push({ id: userId, username, iconColor, profilePicture: profilePicture || null });
      writeLocalGroupCache(groupId, cache);
    }
    if (groupId !== currentGroupId) return;
    addSystemMessage(username + ' joined the group');
    members = cache.members || members;
    renderMembersList();
    renderWhisperPicker();
    $('chat-member-count').textContent = members.length + ' member' + (members.length !== 1 ? 's' : '');
  });

  socket.on('member_left', ({ userId, username, groupId }) => {
    const cache = ensureGroupCacheEntry(groupId);
    if (cache.members) {
      cache.members = cache.members.filter((member) => member.id !== userId);
      writeLocalGroupCache(groupId, cache);
    }
    if (groupId !== currentGroupId) return;
    addSystemMessage(username + ' left the group');
    members = cache.members || members.filter(m => m.id !== userId);
    renderMembersList();
    renderWhisperPicker();
    $('chat-member-count').textContent = members.length + ' member' + (members.length !== 1 ? 's' : '');
  });

  socket.on('member_kicked', ({ userId, groupId }) => {
    if (userId === currentUser.id) {
      // We were kicked
      groups = groups.filter(g => g.id !== groupId);
      renderGroupList();
      if (groupId === currentGroupId) {
        currentGroupId = null; currentGroupData = null;
        $('chat-active').hidden = true;
        $('chat-empty').hidden = false;
      }
      return;
    }
    if (groupId !== currentGroupId) return;
    const m = members.find(x => x.id === userId);
    if (m) addSystemMessage('🚫 ' + m.username + ' was removed from the group');
    members = members.filter(x => x.id !== userId);
    renderMembersList();
    renderWhisperPicker();
  });

  socket.on('group_disbanded', ({ groupId }) => {
    groups = groups.filter(g => g.id !== groupId);
    renderGroupList();
    if (groupId === currentGroupId) {
      currentGroupId = null; currentGroupData = null;
      members = [];
      $('chat-active').hidden = true;
      $('chat-empty').hidden = false;
      $('right-panel-content').hidden = true;
      $('right-panel-empty').hidden = false;
      addSystemMessage('This group has been disbanded');
    }
  });

  socket.on('presence_update', ({ groupId, onlineUserIds }) => {
    if (groupId !== currentGroupId) return;
    onlineUsers = new Set(onlineUserIds);
    renderMembersList();
  });

  socket.on('user_updated', (user) => {
    // Update member display names if affected
    for (const cache of groupDataCache.values()) {
      const cachedMember = cache.members ? cache.members.find((member) => member.id === user.id) : null;
      if (cachedMember) {
        cachedMember.username = user.username;
        cachedMember.iconColor = user.iconColor;
        cachedMember.profilePicture = user.profilePicture || null;
      }
      const cachedMessageUsers = cache.messages || [];
      for (const message of cachedMessageUsers) {
        if (message.senderId !== user.id) continue;
        message.senderName = user.username;
        message.senderColor = user.iconColor;
      }
      if (cachedMember) cache.rowsDirty = true;
    }
    const m = members.find(x => x.id === user.id);
    if (m) {
      m.username = user.username;
      m.iconColor = user.iconColor;
      m.profilePicture = user.profilePicture || null;
      renderMembersList();
    }
    if (user.id === currentUser.id) {
      currentUser = user;
      $('user-username').textContent = user.username;
      renderCurrentUserAvatar(user);
      syncProfilePictureModeUI();
    }
    // Update avatars and sender names in visible message bubbles
    document.querySelectorAll('.msg-row[data-sender-id="' + CSS.escape(String(user.id)) + '"]').forEach(row => {
      const av = row.querySelector('.msg-avatar');
      if (av && user.username) renderAvatarElement(av, user);
      const nameEl = row.querySelector('.msg-sender-name');
      if (nameEl && user.username) nameEl.textContent = user.username;
    });
  });

  socket.on('user_typing', ({ username }) => {
    $('typing-user').textContent = username;
    $('typing-indicator').hidden = false;
    clearTimeout(window._typingTimer);
    window._typingTimer = setTimeout(() => $('typing-indicator').hidden = true, 3000);
  });

  socket.on('user_stop_typing', () => {
    $('typing-indicator').hidden = true;
  });

  socket.on('error', ({ message }) => {
    showToast(message || 'An error occurred', 'error');
  });
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'msg-system';
  div.textContent = text;
  messagesArea().appendChild(div);
  scrollToBottom();
}

// ── Emoji picker ──────────────────────────────────────────────────────────────
function setupEmojiPicker() {
  const emojis = ['😀','😂','🥰','😍','😎','🤩','🥳','😭','😤','🤔','😏','😇','🙄','😴','🤗','🥺','😱','😜','🤪','😝','🤑','😈','👹','💀','💩','👽','👻','👾','🙈','🐶','🐱','🐭','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐙','🦋','🌺','🌸','🍎','🍕','🎂','🎉','🎊','🎁','❤️','🧡','💛','💚','💙','💜','🖤','💔','✨','⭐','🌟','🔥','💫','🌈','☀️','🌙','❄️','🎵','🎶','🏆','👑','💎','🗝️','🔑','🌍','🚀','🎭','👋','🤝','👍','👎','🙏','💪','✌️','🤞','🤟','👆','👇','👈','👉'];
  const picker = $('emoji-picker');
  for (const em of emojis) {
    const btn = document.createElement('button');
    btn.className = 'emoji-btn-item';
    btn.textContent = em;
    btn.addEventListener('click', () => insertEmoji(em));
    picker.appendChild(btn);
  }
}

function insertEmoji(em) {
  const inp = $('message-input');
  const start = inp.selectionStart;
  const end = inp.selectionEnd;
  inp.value = inp.value.slice(0, start) + em + inp.value.slice(end);
  inp.selectionStart = inp.selectionEnd = start + em.length;
  inp.focus();
  autoResizeTextarea(inp);
  $('emoji-picker').hidden = true;
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Close modals
      document.querySelectorAll('.modal-overlay:not([hidden])').forEach(m => m.hidden = true);
      $('ctx-menu').hidden = true;
      $('emoji-picker').hidden = true;
      $('whisper-picker').hidden = true;
      // Close image viewer
      hideImageViewer();
      // Cancel reply
      replyingTo = null;
      $('reply-preview-bar').hidden = true;
    }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && document.activeElement !== $('message-input')) {
      $('shortcuts-modal').hidden = false;
    }
  });
}

// ── Auto-resize textarea ──────────────────────────────────────────────────────
function autoResizeTextarea(el) {
  const keepBottomPinned = isMessagesPinnedToBottom();
  el.style.height = 'auto';
  const maxH = 5 * 20 + 18; // ~5 lines
  el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
  if (keepBottomPinned) pinMessagesToBottom();
}

// ── Whisper mode ──────────────────────────────────────────────────────────────
function updateWhisperBtn() {
  const keepBottomPinned = isMessagesPinnedToBottom();
  const btn = $('whisper-mode-btn');
  if (messageMode === 'whisper') {
    setElementIcon(btn, 'megaphone', { iconOnly: true });
    btn.classList.add('whisper-active');
    $('whisper-picker').hidden = false;
  } else {
    setElementIcon(btn, 'message-square', { iconOnly: true });
    btn.classList.remove('whisper-active');
    $('whisper-picker').hidden = true;
  }
  if (keepBottomPinned) pinMessagesToBottom();
}

// ── Toggle encryption display ─────────────────────────────────────────────────
function toggleEncryptionButton() {
  setElementIcon(
    $('enc-toggle-btn'),
    encryptionVisible ? 'lock' : 'unlock',
    { label: encryptionVisible ? 'Hide Encryption' : 'Show Encrypted' }
  );
}

async function toggleEncryption() {
  encryptionVisible = !encryptionVisible;
  toggleEncryptionButton();
  // Re-render all messages
  if (!currentGroupId) return;
  await loadMessages(currentGroupId);
  renderGroupFromCache(currentGroupId);
  observeCurrentGroupRowsForRead();
}

// ── Forget key ────────────────────────────────────────────────────────────────
function forgetKey() {
  showConfirm(
    'Forget Encryption Key',
    'This will remove your encryption key for this group. You won\'t be able to read or send messages until you re-enter it. Continue?',
    async () => {
      clearGroupKey(currentGroupId);
      updateKeyState();
      await loadMessages(currentGroupId);
      renderGroupFromCache(currentGroupId);
      observeCurrentGroupRowsForRead();
      showToast('Key forgotten — messages are now locked', 'info');
    }
  );
}

// ── Kick member ───────────────────────────────────────────────────────────────
async function kickMember(userId, username) {
  showConfirm('Kick Member', 'Remove ' + username + ' from this group?', async () => {
    const res = await fetch('/api/groups/' + currentGroupId + '/members/' + userId, {
      method: 'DELETE', headers: apiHeaders(),
    });
    if (res.ok) {
      showToast('Kicked ' + username, 'success');
    } else {
      const d = await res.json().catch(() => ({}));
      showToast(d.error || 'Failed to kick member', 'error');
    }
  });
}

// ── Generic confirm modal ─────────────────────────────────────────────────────
let confirmCallback = null;
function showConfirm(title, message, onConfirm) {
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-modal').hidden = false;
  confirmCallback = onConfirm;
}

// ── Search messages ───────────────────────────────────────────────────────────
function highlightText(el, term) {
  // DOM-based highlighting — no innerHTML with user content
  el.textContent = el.textContent; // reset to plain text
  if (!term) return;
  const text = el.textContent;
  const lc = text.toLowerCase();
  const tl = term.toLowerCase();
  el.textContent = '';
  let idx = 0;
  let found;
  while ((found = lc.indexOf(tl, idx)) !== -1) {
    if (found > idx) el.appendChild(document.createTextNode(text.slice(idx, found)));
    const mark = document.createElement('mark');
    mark.className = 'search-highlight';
    mark.textContent = text.slice(found, found + term.length);
    el.appendChild(mark);
    idx = found + term.length;
  }
  if (idx < text.length) el.appendChild(document.createTextNode(text.slice(idx)));
}

function searchMessages(term) {
  const rows = messagesArea().querySelectorAll('.msg-row');
  let count = 0;
  rows.forEach(row => {
    const textEl = row.querySelector('.msg-text');
    if (!textEl) return;
    // Restore plain text first (remove marks)
    textEl.textContent = textEl.textContent;
    if (!term) { row.style.display = ''; return; }
    const text = textEl.textContent;
    if (text.toLowerCase().includes(term.toLowerCase())) {
      count++;
      row.style.display = '';
      highlightText(textEl, term);
    } else {
      row.style.display = 'none';
    }
  });
  $('search-results-count').textContent = term ? count + ' result' + (count !== 1 ? 's' : '') : '';
}

// ── Export chat ───────────────────────────────────────────────────────────────
async function exportChat() {
  const key = getGroupKey(currentGroupId);
  const lines = [];
  for (const msg of allMessages) {
    const time = formatTime(msg.createdAt);
    let content = '';
    if (msg.type === 'image') content = '[Image]';
    else if (msg.type === 'file') content = '[File: ' + (msg.filename || '') + ']';
    else if (key) {
      const pt = await decryptMessage(msg.encryptedContent, msg.iv, key, currentGroupId);
      content = pt || MSG_DECRYPT_FAIL;
    } else {
      content = MSG_NO_KEY;
    }
    lines.push('[' + time + '] ' + (msg.senderName || 'Unknown') + ': ' + content);
  }
  if (!lines.length) { showToast('No messages to export', 'info'); return; }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  const gname = (currentGroupData ? currentGroupData.name : 'chat').replace(/[^a-zA-Z0-9]/g, '-');
  a.href = url; a.download = 'Gchat-' + gname + '-' + date + '.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Event listeners ───────────────────────────────────────────────────────────
function setupEventListeners() {
  // Logout
  $('logout-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    await fetch('/api/auth/logout', { method: 'POST', headers: apiHeaders() });
    window.location.href = 'index.html';
  });
  $('wallpaper-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    resetWallpaperDraft();
    applyWallpaperFromSettings();
    $('wallpaper-modal').hidden = false;
  });
  $('wallpaper-close-btn').addEventListener('click', () => {
    $('wallpaper-modal').hidden = true;
    resetWallpaperDraft();
  });
  $('wallpaper-save-btn').addEventListener('click', saveWallpaperDraft);
  $('wallpaper-reset-btn').addEventListener('click', async () => {
    appLocalSettings.wallpaperDataUrl = null;
    applyWallpaperFromSettings();
    writeLocalSettings(appLocalSettings, currentUser && currentUser.id);
    const saved = await saveSettingsToServer();
    if (!saved) {
      showToast(WALLPAPER_RESET_SYNC_FAIL_MSG, 'info');
    }
    $('wallpaper-modal').hidden = true;
    resetWallpaperDraft();
    showToast(WALLPAPER_RESET_SUCCESS_MSG, 'success');
  });
  $('wallpaper-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('wallpaper-error').textContent = '';
    if (!file.type.startsWith('image/')) {
      $('wallpaper-error').textContent = WALLPAPER_INVALID_TYPE_MSG;
      setWallpaperSaveState(false);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      $('wallpaper-error').textContent = WALLPAPER_TOO_LARGE_MSG;
      setWallpaperSaveState(false);
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      pendingWallpaperDataUrl = String(ev.target.result || '');
      if (!pendingWallpaperDataUrl) {
        $('wallpaper-error').textContent = WALLPAPER_READ_FAIL_MSG;
        setWallpaperSaveState(false);
        return;
      }
      applyWallpaperDraftPreview(pendingWallpaperDataUrl);
      setWallpaperSaveState(true);
    };
    reader.readAsDataURL(file);
  });

  // Profile modal
  $('sidebar-user-btn').addEventListener('click', () => {
    $('profile-username').value = currentUser.username;
    $('profile-color').value = currentUser.iconColor;
    $('profile-error').textContent = '';
    $('profile-picture-input').value = '';
    if (currentUser.profilePicture) {
      $('profile-picture-preview-img').src = currentUser.profilePicture;
      $('profile-picture-preview').hidden = false;
    } else {
      $('profile-picture-preview').hidden = true;
    }
    syncProfilePictureModeUI();
    $('profile-modal').hidden = false;
  });
  $('profile-close-btn').addEventListener('click', () => $('profile-modal').hidden = true);

  $('profile-save-username').addEventListener('click', async () => {
    const username = $('profile-username').value.trim();
    if (!username) return;
    const res = await fetch('/api/auth/profile', {
      method: 'PATCH', headers: apiHeaders(),
      body: JSON.stringify({ username }),
    });
    const d = await res.json();
    if (!res.ok) { $('profile-error').textContent = d.error || 'Failed'; return; }
    currentUser = d;
    $('user-username').textContent = d.username;
    renderCurrentUserAvatar(d);
    syncProfilePictureModeUI();
    $('profile-error').textContent = '✓ Saved';
  });

  $('profile-save-color').addEventListener('click', async () => {
    const iconColor = $('profile-color').value;
    const res = await fetch('/api/auth/profile', {
      method: 'PATCH', headers: apiHeaders(),
      body: JSON.stringify({ iconColor }),
    });
    const d = await res.json();
    if (!res.ok) { $('profile-error').textContent = d.error || 'Failed'; return; }
    currentUser = d;
    renderCurrentUserAvatar(d);
    syncProfilePictureModeUI();
    $('profile-error').textContent = '✓ Saved';
  });

  // Profile picture mode slider
  $('profile-picture-mode-slider').addEventListener('input', () => {
    setProfilePictureMode($('profile-picture-mode-slider').value === '1' ? 'image' : 'color');
  });

  // Profile picture upload preview
  $('profile-picture-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      $('profile-error').textContent = 'Image too large (max 2MB)';
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      $('profile-picture-preview-img').src = e.target.result;
      $('profile-picture-preview').hidden = false;
    };
    reader.readAsDataURL(file);
  });

  // Save profile picture
  $('profile-save-picture').addEventListener('click', async () => {
    const file = $('profile-picture-input').files[0];
    if (!file) { $('profile-error').textContent = 'Please select an image'; return; }
    if (file.size > 2 * 1024 * 1024) {
      $('profile-error').textContent = 'Image too large (max 2MB)';
      return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      const profilePicture = e.target.result;
      const res = await fetch('/api/auth/profile', {
        method: 'PATCH', headers: apiHeaders(),
        body: JSON.stringify({ profilePicture }),
      });
      const d = await res.json();
      if (!res.ok) { $('profile-error').textContent = d.error || 'Failed'; return; }
      currentUser = d;
      renderCurrentUserAvatar(d);
      syncProfilePictureModeUI();
      $('profile-error').textContent = '✓ Saved';
    };
    reader.readAsDataURL(file);
  });

  // Remove profile picture
  $('profile-remove-picture').addEventListener('click', async () => {
    const res = await fetch('/api/auth/profile', {
      method: 'PATCH', headers: apiHeaders(),
      body: JSON.stringify({ profilePicture: null }),
    });
    const d = await res.json();
    if (!res.ok) { $('profile-error').textContent = d.error || 'Failed'; return; }
    currentUser = d;
    renderCurrentUserAvatar(d);
    $('profile-picture-preview').hidden = true;
    $('profile-picture-input').value = '';
    syncProfilePictureModeUI();
    $('profile-error').textContent = '✓ Removed';
  });

  $('profile-delete-btn').addEventListener('click', () => {
    showConfirm('Delete Account', 'Permanently delete your account? This cannot be undone.', async () => {
      $('profile-modal').hidden = true;
      const res = await fetch('/api/auth/account', { method: 'DELETE', headers: apiHeaders() });
      if (res.ok) window.location.href = 'index.html';
    });
  });

  // Create group
  $('new-group-btn').addEventListener('click', () => {
    $('create-group-name').value = '';
    $('create-group-code').value = '';
    $('create-error').textContent = '';
    $('create-modal').hidden = false;
  });
  $('create-cancel-btn').addEventListener('click', () => $('create-modal').hidden = true);
  $('create-confirm-btn').addEventListener('click', async () => {
    const name = $('create-group-name').value.trim();
    const code = $('create-group-code').value.trim();
    $('create-error').textContent = '';
    if (!name || !code) { $('create-error').textContent = 'Both fields are required'; return; }
    const res = await fetch('/api/groups/create', {
      method: 'POST', headers: apiHeaders(),
      body: JSON.stringify({ name, code }),
    });
    const d = await res.json();
    if (!res.ok) { $('create-error').textContent = d.error || 'Failed'; return; }
    $('create-modal').hidden = true;
    groups.unshift(d);
    renderGroupList();
    await selectGroup(d.id);
    addSystemMessage('Group "' + d.name + '" created.');
  });

  // Join group
  $('join-group-btn').addEventListener('click', () => {
    $('join-group-code').value = '';
    $('join-error').textContent = '';
    $('join-modal').hidden = false;
  });
  $('join-cancel-btn').addEventListener('click', () => $('join-modal').hidden = true);
  $('join-confirm-btn').addEventListener('click', async () => {
    const code = $('join-group-code').value.trim();
    $('join-error').textContent = '';
    if (!code) { $('join-error').textContent = 'Enter a group code'; return; }
    const res = await fetch('/api/groups/join', {
      method: 'POST', headers: apiHeaders(),
      body: JSON.stringify({ code }),
    });
    const d = await res.json();
    if (!res.ok) { $('join-error').textContent = d.error || 'Failed'; return; }
    $('join-modal').hidden = true;
    if (!groups.find(g => g.id === d.id)) { groups.unshift(d); renderGroupList(); }
    await selectGroup(d.id);
    addSystemMessage('You joined "' + d.name + '".');
  });

  // Set group key
  $('set-key-btn').addEventListener('click', () => {
    $('group-key-input').value = currentGroupId ? (getGroupKey(currentGroupId) || '') : '';
    $('group-key-error').textContent = '';
    $('group-key-modal').hidden = false;
  });
  $('group-key-cancel-btn').addEventListener('click', () => $('group-key-modal').hidden = true);
  $('group-key-save-btn').addEventListener('click', async () => {
    const key = $('group-key-input').value;
    if (!key) { $('group-key-error').textContent = 'Key cannot be empty'; return; }
    setGroupKey(currentGroupId, key);
    $('group-key-modal').hidden = true;
    updateKeyState();
    await loadMessages(currentGroupId);
    renderGroupFromCache(currentGroupId);
    observeCurrentGroupRowsForRead();
  });

  // Encryption toggle
  $('enc-toggle-btn').addEventListener('click', toggleEncryption);

  // Forget key
  $('forget-key-btn').addEventListener('click', forgetKey);

  // Copy code
  $('copy-code-btn').addEventListener('click', () => {
    if (!currentGroupData) return;
    navigator.clipboard.writeText(currentGroupData.code).catch(() => {});
    setElementIcon($('copy-code-btn'), 'check', { iconOnly: true });
    setTimeout(() => setElementIcon($('copy-code-btn'), 'copy', { iconOnly: true }), 1500);
  });

  // Edit group name
  let groupRenameInFlight = false;
  const saveGroupName = async () => {
    const name = $('edit-group-name-input').value.trim();
    if (!name || !currentGroupId || groupRenameInFlight) return;
    if (currentGroupData && name === currentGroupData.name) return;
    groupRenameInFlight = true;
    const res = await fetch('/api/groups/' + currentGroupId + '/name', {
      method: 'PATCH', headers: apiHeaders(),
      body: JSON.stringify({ name }),
    });
    groupRenameInFlight = false;
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      showToast(d.error || 'Failed to rename', 'error');
      $('edit-group-name-input').value = currentGroupData ? currentGroupData.name : '';
    }
  };
  $('edit-group-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveGroupName();
    }
  });
  $('edit-group-name-input').addEventListener('blur', saveGroupName);

  // Group color
  $('set-group-color-btn').addEventListener('click', () => {
    if (!currentGroupId) return;
    $('group-color-input').value = (currentGroupData && currentGroupData.groupColor) || '#4a90d9';
    $('group-color-modal').hidden = false;
  });
  $('group-color-cancel-btn').addEventListener('click', () => { $('group-color-modal').hidden = true; });
  $('group-color-save-btn').addEventListener('click', async () => {
    const groupColor = $('group-color-input').value;
    const res = await fetch('/api/groups/' + currentGroupId + '/settings', {
      method: 'PATCH', headers: apiHeaders(),
      body: JSON.stringify({ groupColor }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      showToast(d.error || 'Failed to set group color', 'error');
      return;
    }
    $('group-color-modal').hidden = true;
  });

  // Clear chat history
  $('clear-history-btn').addEventListener('click', () => {
    if ($('clear-history-btn').disabled) return;
    showConfirm(
      'Clear Chat History',
      'This will permanently delete all messages for everyone. Continue?',
      async () => {
        const res = await fetch('/api/groups/' + currentGroupId + '/messages', {
          method: 'DELETE', headers: apiHeaders(),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          showToast(d.error || 'Failed', 'error');
        }
      }
    );
  });

  // Allow member clear toggle
  $('allow-member-clear-toggle').addEventListener('change', async (e) => {
    await fetch('/api/groups/' + currentGroupId + '/settings', {
      method: 'PATCH', headers: apiHeaders(),
      body: JSON.stringify({ allowMemberClear: e.target.checked }),
    });
    if (currentGroupData) {
      currentGroupData.allowMemberClear = e.target.checked;
      updateGroupActionButtons(currentGroupData.createdBy === currentUser.id);
    }
  });

  $('allow-member-export-toggle').addEventListener('change', async (e) => {
    await fetch('/api/groups/' + currentGroupId + '/settings', {
      method: 'PATCH', headers: apiHeaders(),
      body: JSON.stringify({ allowMemberExport: e.target.checked }),
    });
    if (currentGroupData) {
      currentGroupData.allowMemberExport = e.target.checked;
      updateGroupActionButtons(currentGroupData.createdBy === currentUser.id);
    }
  });

  $('allow-member-kick-toggle').addEventListener('change', async (e) => {
    await fetch('/api/groups/' + currentGroupId + '/settings', {
      method: 'PATCH', headers: apiHeaders(),
      body: JSON.stringify({ allowMemberKick: e.target.checked }),
    });
    if (currentGroupData) {
      currentGroupData.allowMemberKick = e.target.checked;
    }
  });

  // Export chat
  $('export-btn').addEventListener('click', () => {
    if ($('export-btn').disabled) return;
    exportChat();
  });

  // Disband group
  $('disband-btn').addEventListener('click', () => {
    if ($('disband-btn').disabled) return;
    showConfirm('Disband Group', 'Permanently disband this group and delete all messages?', async () => {
      const res = await fetch('/api/groups/' + currentGroupId, {
        method: 'DELETE', headers: apiHeaders(),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        showToast(d.error || 'Failed', 'error');
      }
    });
  });

  // Leave group
  $('leave-group-btn').addEventListener('click', () => {
    if ($('leave-group-btn').disabled) return;
    showConfirm('Leave Group', 'Are you sure you want to leave this group?', async () => {
      const res = await fetch('/api/groups/' + currentGroupId + '/leave', {
        method: 'DELETE', headers: apiHeaders(),
      });
      if (res.ok) {
        groups = groups.filter(g => g.id !== currentGroupId);
        renderGroupList();
        currentGroupId = null; currentGroupData = null;
        $('chat-active').hidden = true;
        $('chat-empty').hidden = false;
        $('right-panel-content').hidden = true;
        $('right-panel-empty').hidden = false;
        closeRightPanel();
        showToast('Left group', 'success');
      } else {
        const d = await res.json().catch(() => ({}));
        showToast(d.error || 'Failed', 'error');
      }
    });
  });

  // Confirm modal
  $('confirm-cancel-btn').addEventListener('click', () => { $('confirm-modal').hidden = true; confirmCallback = null; });
  $('confirm-ok-btn').addEventListener('click', () => {
    $('confirm-modal').hidden = true;
    if (confirmCallback) { confirmCallback(); confirmCallback = null; }
  });

  // Shortcuts modal
  $('shortcuts-close-btn').addEventListener('click', () => $('shortcuts-modal').hidden = true);

  // Context menu actions
  $('ctx-reply').addEventListener('click', () => {
    if (!ctxMsg) return;
    const msg = ctxMsg;
    const text = ctxText;
    hideContextMenu();
    const isDecryptFail = text === MSG_NO_KEY || text === MSG_DECRYPT_FAIL;
    let preview;
    if (text && !isDecryptFail) {
      preview = text;
    } else if (msg.type === 'image') {
      preview = '[image]';
    } else if (msg.type === 'file') {
      preview = '[file: ' + (msg.filename || '') + ']';
    } else {
      preview = '[encrypted]';
    }
    replyingTo = {
      id: msg.id,
      senderName: msg.senderName,
      preview,
    };
    $('reply-preview-name').textContent = msg.senderName;
    $('reply-preview-text').textContent = truncate(replyingTo.preview, 80);
    $('reply-preview-bar').hidden = false;
    $('message-input').focus();
  });

  $('ctx-copy').addEventListener('click', () => {
    if (ctxText) {
      navigator.clipboard.writeText(ctxText).catch(() => {});
    }
    hideContextMenu();
  });

  $('ctx-download').addEventListener('click', () => {
    if (!ctxMsg || (ctxMsg.type !== 'image' && ctxMsg.type !== 'file')) return;
    downloadAttachment(ctxMsg);
    hideContextMenu();
  });

  document.addEventListener('click', (e) => {
    if (!$('ctx-menu').contains(e.target)) hideContextMenu();
    if (!$('emoji-picker').contains(e.target) && e.target !== $('emoji-btn')) {
      $('emoji-picker').hidden = true;
    }
  });

  // Reply cancel
  $('reply-cancel-btn').addEventListener('click', () => {
    replyingTo = null;
    $('reply-preview-bar').hidden = true;
  });

  // Message input
  const msgInput = $('message-input');

  msgInput.addEventListener('input', () => {
    autoResizeTextarea(msgInput);
    if (currentGroupId && socket) {
      socket.emit('typing', { groupId: currentGroupId });
      clearTimeout(window._myTypingTimer);
      window._myTypingTimer = setTimeout(() => {
        socket.emit('stop_typing', { groupId: currentGroupId });
      }, 1500);
    }
  });

  msgInput.addEventListener('blur', () => {
    clearTimeout(window._myTypingTimer);
    if (currentGroupId && socket) socket.emit('stop_typing', { groupId: currentGroupId });
  });

  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend(msgInput.value);
    }
  });

  $('send-btn').addEventListener('click', () => doSend(msgInput.value));

  // File input
  $('file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) { handleFileUpload(file); e.target.value = ''; }
  });

  // Paste files from clipboard
  msgInput.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file') {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) await handleFileUpload(file);
        return;
      }
    }
  });

  // Emoji button
  $('emoji-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('emoji-picker').hidden = !$('emoji-picker').hidden;
  });

  // Whisper mode toggle
  $('whisper-mode-btn').addEventListener('click', () => {
    messageMode = messageMode === 'normal' ? 'whisper' : 'normal';
    updateWhisperBtn();
  });

  // Scroll to bottom button
  $('scroll-bottom-btn').addEventListener('click', () => scrollToBottom());

  // Scroll listener for pagination + scroll-to-bottom visibility
  messagesArea().addEventListener('scroll', () => {
    const area = messagesArea();
    const isAtBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 150;
    $('scroll-bottom-btn').hidden = isAtBottom;
    if (isAtBottom) {
      scrollUnreadCount = 0;
      $('scroll-unread-badge').hidden = true;
    }
    // Infinite scroll up
    if (area.scrollTop <= SCROLL_LOAD_THRESHOLD && !loadingOlder && oldestMessageId) {
      loadOlderMessages();
    }
  });

  $('sidebar-resizer').addEventListener('mousedown', startSidebarResize);

  // Right panel toggle
  $('right-panel-toggle').addEventListener('click', toggleRightPanel);

  // Mobile empty state toggles
  $('sidebar-toggle-empty').addEventListener('click', toggleSidebar);

  $('right-panel-toggle-empty').addEventListener('click', toggleRightPanel);

  // Mobile sidebar
  $('sidebar-toggle').addEventListener('click', toggleSidebar);
  $('right-panel-close').addEventListener('click', closeRightPanel);
  $('sidebar-overlay').addEventListener('click', closeMobilePanels);

  // Search
  $('search-input').addEventListener('input', (e) => searchMessages(e.target.value));
  $('clear-search-btn').addEventListener('click', () => {
    $('search-input').value = '';
    searchMessages('');
  });

  // Unread jump button
  $('unread-jump-btn').addEventListener('click', () => {
    const first = messagesArea().querySelector('.msg-row.unseen');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // Image viewer
  $('image-viewer-overlay').addEventListener('click', hideImageViewer);
  $('image-viewer-img').addEventListener('click', () => {
    updateImageViewerZoom(imageViewerZoom > 1 ? 1 : imageViewerZoom + 1);
  });
  $('image-viewer-img').addEventListener('wheel', (e) => {
    e.preventDefault();
    updateImageViewerZoom(imageViewerZoom + (e.deltaY < 0 ? 0.2 : -0.2));
  }, { passive: false });
}

async function loadOlderMessages() {
  if (loadingOlder || !oldestMessageId || !currentGroupId) return;
  loadingOlder = true;
  const indicator = $('load-more-indicator');
  if (indicator) indicator.hidden = false;
  try {
    const url = `/api/groups/${currentGroupId}/messages?before=${oldestMessageId}&limit=50`;
    const res = await fetch(url);
    if (!res.ok) return;
    const msgs = await res.json();
    if (!msgs.length) {
      oldestMessageId = null; // no more older messages
      return;
    }

    const area = messagesArea();
    const prevScrollHeight = area.scrollHeight;

    const rows = await buildMessageRows(msgs, currentGroupId);

    // Assemble into a fragment (single DOM mutation, no scroll drift)
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      if (!row) continue;
      if (row.classList && row.classList.contains('msg-row')) {
        const msgId = row.dataset.msgId;
        const srcMsg = msgs.find((m) => String(m.id) === String(msgId));
        if (srcMsg) observeMessageForRead(row, srcMsg);
      }
      fragment.appendChild(row);
    }

    // Single DOM mutation — prepend the whole fragment
    const oldFirst = area.querySelector('.msg-row, .msg-system');
    if (oldFirst) {
      area.insertBefore(fragment, oldFirst);
    } else {
      area.appendChild(fragment);
    }

    allMessages = [...msgs, ...allMessages];
    oldestMessageId = msgs[0].id;
    const cache = ensureGroupCacheEntry(currentGroupId);
    cache.messages = allMessages;
    cache.messageRows = [...rows, ...(cache.messageRows || [])];
    cache.oldestMessageId = oldestMessageId;
    cache.rowsDirty = false;
    writeLocalGroupCache(currentGroupId, cache);

    // Restore scroll position in one step
    area.scrollTop = area.scrollHeight - prevScrollHeight;
  } catch(err) {
    console.error('loadOlderMessages error:', err);
  } finally {
    loadingOlder = false;
    if (indicator) indicator.hidden = true;
  }
}
