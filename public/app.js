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

async function sha256Hex(text) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
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

function readFileAsDataUrl(file, callbacks = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (typeof callbacks.onProgress === 'function') callbacks.onProgress(event);
    };
    reader.onerror = () => reject(new Error('Unable to read image'));
    reader.onload = (event) => {
      const result = String(event.target?.result || '');
      if (!result) {
        reject(new Error('Unable to read image'));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
}

async function prepareWallpaperFile(file) {
  if (!file || !file.type.startsWith('image/')) return file;
  if (file.size <= 2 * 1024 * 1024) return file;
  const optimized = await compressImage(file);
  if (optimized instanceof Blob && optimized.size > 0 && optimized.size < file.size) return optimized;
  return file;
}

// ── CSRF ──────────────────────────────────────────────────────────────────────
let csrfToken = null;
let appVersionLabel = 'v—';
let currentAppVersion = null;
let hostedAppUpdateTimer = null;
let hostedAppReloadPending = false;
const HOSTED_APP_UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const MESSAGE_VIEW_BASE_DELAY_MS = 2200;
const MESSAGE_VIEW_PER_CHAR_MS = 200;
const MESSAGE_VIEW_MAX_DELAY_MS = 18000;
const MIN_DISAPPEARING_DURATION_MS = 6000;
const DISAPPEARING_DURATION_PER_CHAR_MS = 180;
const MAX_DISAPPEARING_DURATION_MS = 45000;
async function fetchCsrfToken() {
  try {
    const r = await fetch('/api/auth/csrf');
    const d = await r.json();
    csrfToken = d.csrfToken;
  } catch { /* will retry */ }
}

function apiHeaders(options = {}) {
  const h = {};
  if (options.json !== false) h['Content-Type'] = 'application/json';
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

function capturePreservedLocalStorageEntries() {
  const entries = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('gk:')) continue;
      entries.push([key, localStorage.getItem(key)]);
    }
  } catch {
    return [];
  }
  return entries;
}

function restorePreservedLocalStorageEntries(entries = []) {
  for (const [key, value] of entries) {
    if (!key || value == null) continue;
    try {
      localStorage.setItem(key, value);
    } catch {
      // best effort only
    }
  }
}

const LOCAL_CACHE_PREFIX = 'gchat:cache:group:';
const LEGACY_LOCAL_SETTINGS_KEY = 'gchat:local-settings';
const ACTIVE_LOCAL_SETTINGS_KEY = 'gchat:active-local-settings';
const LOCAL_SETTINGS_KEY_PREFIX = 'gchat:local-settings:user:';
const DEFAULT_WALLPAPER = "url('gchat_wallpaper.jpg')";
const DEFAULT_WALLPAPER_PREVIEW_SRC = 'gchat_wallpaper.jpg';
const DEFAULT_WALLPAPER_BLUR = 0;
const DEFAULT_WALLPAPER_TRANSPARENCY = 100;
const WALLPAPER_SELECT_FIRST_MSG = 'Please choose an image first';
const WALLPAPER_INVALID_TYPE_MSG = 'Please choose an image file';
const WALLPAPER_TOO_LARGE_MSG = 'Wallpaper too large (max 10MB)';
const ATTACHMENT_TOO_LARGE_MSG = 'Attachment too large (max 15MB)';
const PROFILE_PICTURE_TOO_LARGE_MSG = 'Image too large (max 2MB)';
const WALLPAPER_READ_FAIL_MSG = 'Unable to read image';
const WALLPAPER_SAVE_SYNC_FAIL_MSG = 'Wallpaper saved locally but could not sync to server. Changes may not appear on other devices.';
const WALLPAPER_RESET_SYNC_FAIL_MSG = 'Wallpaper reset locally but could not sync to server. Changes may not appear on other devices.';
const WALLPAPER_SAVE_SUCCESS_MSG = 'Wallpaper saved';
const WALLPAPER_RESET_SUCCESS_MSG = 'Wallpaper reset';
const MAX_WALLPAPER_BYTES = 10 * 1024 * 1024;
const MAX_PROFILE_PICTURE_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_MESSAGE_BYTES = 64 * 1024;
const GROK_CONTEXT_MESSAGE_LIMIT = 40;
const GROK_CONTEXT_TOTAL_CHARS = 24000;
const AI_ASSISTANT_USER_ID = '__gchat_ai_grok__';
const AI_ASSISTANT_NAME = 'AI';
const AI_ASSISTANT_COLOR = '#8d7bff';
const AI_ASSISTANT_PROFILE_PICTURE = '/grok.webp';
const AI_MODEL_PROFILE_PICTURES = {
  'deepseek/deepseek-v4-flash': '/deepseek.webp',
  'x-ai/grok-4.3': '/grok.webp',
};
const AI_MODEL_TAGS = {
  'deepseek/deepseek-v4-flash': 'deepseek',
  'x-ai/grok-4.3': 'grok',
};
const APP_OWNER_USERNAME = 'Furina';
const AI_RESET_TIME_LABEL = '4:00 AM Shanghai time';
const AI_USAGE_RESET_LABEL = `Resets at ${AI_RESET_TIME_LABEL}`;
const USD_TO_RMB_RATE = 7.2;
const AI_TOKEN_AMOUNT_DECIMALS = 4;
const MIN_DISPLAYABLE_TOKEN_AMOUNT = 0.01;
const MIN_CURRENCY_DISPLAY_THRESHOLD = 0.01;
const SMALL_CURRENCY_PRECISION = 4;
const AI_MODEL_OPTIONS = {
  'deepseek/deepseek-v4-flash': 'DeepSeek V4 Flash',
  'x-ai/grok-4.3': 'Grok 4.3',
};
const DEFAULT_AI_MODEL = 'deepseek/deepseek-v4-flash';
const AI_MODE_LABELS = {
  fast: 'Fast',
  thinking: 'Context',
};
const DEFAULT_AI_MODE = 'thinking';
const AI_TONE_LABELS = {
  casual: 'Casual',
  professional: 'Professional',
  playful: 'Playful',
};
const DEFAULT_AI_TONE = 'casual';
const ALLOWED_UPLOAD_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const wallpaperTheme = window.GChatWallpaperTheme || null;
const localTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const integerFormatter = new Intl.NumberFormat();
const tokenAmountFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const localDayFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
const DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY = 'gchat:desktop-sidebar-width';
const DESKTOP_RIGHT_PANEL_STORAGE_KEY = 'gchat:desktop-right-panel-expanded';
const DESKTOP_DEFAULT_SIDEBAR_WIDTH = 260;
// Keeps the desktop minimum near 60% of the old 220px floor while still fitting the icon and refresh control.
const DESKTOP_MIN_SIDEBAR_WIDTH = 132;
const DESKTOP_BRAND_ONLY_SIDEBAR_WIDTH = 172;
const DESKTOP_ICON_ONLY_SIDEBAR_WIDTH = 148;
const GENERIC_NOTIFICATION_TITLE = 'GChat';
const GENERIC_NOTIFICATION_FALLBACK_BODY = 'You have unread messages in GChat.';
const PUSH_NOTIFICATION_TAG = 'gchat-unread';
const APP_BADGE_UNSUPPORTED = Symbol('app-badge-unsupported');

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
      messages: getCacheableMessages(cache.messages || []),
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

async function clearBrowserRuntimeCaches({ includeLocalData = false } = {}) {
  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch {
      // best effort only
    }
  }

  if ('serviceWorker' in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    } catch {
      // best effort only
    }
  }

  if (!includeLocalData) return;

  const preservedLocalEntries = capturePreservedLocalStorageEntries();
  try { sessionStorage.clear(); } catch { /* ignore */ }
  try { localStorage.clear(); } catch { /* ignore */ }
  restorePreservedLocalStorageEntries(preservedLocalEntries);
  derivedKeyCache.clear();
  clearAllMessageVisibilityTimers();
  groupDataCache.clear();
  groupPreloadPromises.clear();
  hiddenDisappearingMessageIds = new Set();
}

function buildReloadUrl() {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set('_gchat_reload', String(Date.now()));
  return nextUrl.toString();
}

async function reloadAppShell() {
  if (window.electronAPI?.reloadHostedApp) {
    try {
      const reloaded = await window.electronAPI.reloadHostedApp();
      if (reloaded) return;
    } catch {
      // fall back to browser reload below
    }
  }
  window.location.replace(buildReloadUrl());
}

async function clearCacheAndRestartApp() {
  await clearBrowserRuntimeCaches({ includeLocalData: true });
  if (window.electronAPI?.clearCacheAndRestart) {
    await window.electronAPI.clearCacheAndRestart();
    return;
  }
  await reloadAppShell();
}

async function fetchAppVersionInfo() {
  try {
    const versionRes = await fetch('/api/meta/version', { cache: 'no-store' });
    if (!versionRes.ok) return null;
    const info = await versionRes.json().catch(() => null);
    return info && typeof info.version === 'string' ? info : null;
  } catch {
    return null;
  }
}

async function checkForHostedAppUpdate() {
  const info = await fetchAppVersionInfo();
  if (!info) return false;
  currentAppVersion = currentAppVersion || info.version;
  appVersionLabel = 'v' + info.version;
  $('app-version-label').textContent = appVersionLabel;
  if (currentAppVersion === info.version || hostedAppReloadPending) return false;
  currentAppVersion = info.version;
  hostedAppReloadPending = true;
  showToast('New version detected. Refreshing…');
  await reloadAppShell();
  return true;
}

function startHostedAppUpdatePolling() {
  if (hostedAppUpdateTimer) clearInterval(hostedAppUpdateTimer);
  hostedAppUpdateTimer = setInterval(() => {
    void checkForHostedAppUpdate();
  }, HOSTED_APP_UPDATE_CHECK_INTERVAL_MS);
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
function isAllowedUploadImageType(type) {
  return typeof type === 'string' && ALLOWED_UPLOAD_IMAGE_TYPES.has(type.toLowerCase());
}
function estimateBase64Bytes(value) {
  if (typeof value !== 'string' || !value) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}
function getLocalDayKey(iso) {
  if (!iso) return '';
  const date = parseMessageDate(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function parseMessageDate(iso) {
  return new Date(normalizeIsoTime(iso));
}
function formatTime(iso) {
  if (!iso) return '';
  return localTimeFormatter.format(parseMessageDate(iso));
}
function formatDay(iso) {
  if (!iso) return '';
  return localDayFormatter.format(parseMessageDate(iso));
}
function isSameMessageDay(a, b) {
  if (!a || !b) return false;
  return getLocalDayKey(a) === getLocalDayKey(b);
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

function isAiAssistantMessage(msg) {
  return String(msg?.senderId || '') === AI_ASSISTANT_USER_ID;
}

function roundAiTokenAmount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  const scale = 10 ** AI_TOKEN_AMOUNT_DECIMALS;
  return Math.round(parsed * scale) / scale;
}

function formatAiTokenAmount(value) {
  const normalized = roundAiTokenAmount(value);
  if (normalized > 0 && normalized < MIN_DISPLAYABLE_TOKEN_AMOUNT) return `<${MIN_DISPLAYABLE_TOKEN_AMOUNT.toFixed(2)}`;
  return tokenAmountFormatter.format(normalized);
}

function normalizeAiMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const promptTokens = roundAiTokenAmount(meta.promptTokens);
  const completionTokens = roundAiTokenAmount(meta.completionTokens);
  const totalTokens = Math.max(
    promptTokens + completionTokens,
    roundAiTokenAmount(meta.totalTokens)
  );
  const rawPromptTokens = Math.max(0, Math.round(Number(meta.rawPromptTokens) || 0));
  const rawCompletionTokens = Math.max(0, Math.round(Number(meta.rawCompletionTokens) || 0));
  const rawTotalTokens = Math.max(
    rawPromptTokens + rawCompletionTokens,
    Math.max(0, Math.round(Number(meta.rawTotalTokens) || 0))
  );
  const estimatedCostUsdRaw = Number(meta.estimatedCostUsd);
  const estimatedCostUsd = Number.isFinite(estimatedCostUsdRaw) && estimatedCostUsdRaw >= 0
    ? estimatedCostUsdRaw
    : null;
  const estimatedCostRmbRaw = Number(meta.estimatedCostRmb);
  const estimatedCostRmb = Number.isFinite(estimatedCostRmbRaw) && estimatedCostRmbRaw >= 0
    ? estimatedCostRmbRaw
    : (estimatedCostUsd != null ? estimatedCostUsd * USD_TO_RMB_RATE : null);
  const modelKey = String(meta.model || '').trim();
  const modeKey = String(meta.mode || '').trim().toLowerCase();
  const toneKey = String(meta.tone || '').trim().toLowerCase();
  const webSearchRequestsRaw = Number(meta.webSearchRequests ?? meta.web_search_requests);
  const webSearchRequests = Number.isFinite(webSearchRequestsRaw) && webSearchRequestsRaw > 0
    ? Math.max(0, Math.round(webSearchRequestsRaw))
    : 0;
  return {
    model: modelKey || DEFAULT_AI_MODEL,
    mode: AI_MODE_LABELS[modeKey] ? modeKey : DEFAULT_AI_MODE,
    tone: AI_TONE_LABELS[toneKey] ? toneKey : DEFAULT_AI_TONE,
    webSearchEnabled: meta.webSearchEnabled === true || meta.web_search_enabled === true,
    webSearchRequests,
    promptTokens,
    completionTokens,
    totalTokens,
    rawPromptTokens,
    rawCompletionTokens,
    rawTotalTokens,
    estimatedCostUsd,
    estimatedCostRmb,
  };
}

function formatCurrencyValue(value, symbol) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return '';
  if (amount > 0 && amount < MIN_CURRENCY_DISPLAY_THRESHOLD) {
    return `${symbol}${amount.toFixed(SMALL_CURRENCY_PRECISION)}`;
  }
  return `${symbol}${amount.toFixed(2)}`;
}

function formatRmbCost(value) {
  return formatCurrencyValue(value, '¥');
}

function getAiModelLabel(model) {
  return AI_MODEL_OPTIONS[String(model || '').trim()] || String(model || '').trim() || AI_MODEL_OPTIONS[DEFAULT_AI_MODEL];
}

function slugifyAiTagPart(value, fallback = 'ai') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function getAiModelTag(model) {
  const normalizedModel = String(model || '').trim();
  if (AI_MODEL_TAGS[normalizedModel]) return AI_MODEL_TAGS[normalizedModel];
  return slugifyAiTagPart(getAiModelLabel(normalizedModel));
}

function getAiModeLabel(mode) {
  const normalizedMode = String(mode || '').trim().toLowerCase();
  if (normalizedMode === 'context') return AI_MODE_LABELS.thinking;
  return AI_MODE_LABELS[normalizedMode] || AI_MODE_LABELS[DEFAULT_AI_MODE];
}

function getAiModeTag(mode) {
  const normalizedMode = String(mode || '').trim().toLowerCase();
  if (normalizedMode === 'thinking' || normalizedMode === 'context') return 'context';
  return normalizedMode === 'fast' ? 'fast' : 'context';
}

function getAiToneLabel(tone) {
  return AI_TONE_LABELS[String(tone || '').trim().toLowerCase()] || AI_TONE_LABELS[DEFAULT_AI_TONE];
}

function getAiAssistantProfilePicture(model) {
  const normalizedModel = String(model || '').trim();
  return AI_MODEL_PROFILE_PICTURES[normalizedModel] || AI_ASSISTANT_PROFILE_PICTURE;
}

function buildAiMentionLabel(meta) {
  const normalized = normalizeAiMeta(meta);
  if (!normalized) return '@AI';
  return `@${getAiModelTag(normalized.model)}-${getAiModeTag(normalized.mode)}-${normalized.tone}`;
}

function buildAiMetaDisplay(meta) {
  const normalized = normalizeAiMeta(meta);
  if (!normalized) return null;
  const infoParts = [
    getAiModelLabel(normalized.model),
    getAiModeLabel(normalized.mode),
    getAiToneLabel(normalized.tone),
  ];
  const statsParts = [];
  if (normalized.totalTokens > 0) {
    statsParts.push(`${formatAiTokenAmount(normalized.totalTokens)} tokens`);
  }
  const costText = formatRmbCost(normalized.estimatedCostRmb);
  if (costText) statsParts.push(costText);
  if (normalized.webSearchRequests > 0) {
    statsParts.push(`${normalized.webSearchRequests} web search${normalized.webSearchRequests === 1 ? '' : 'es'}`);
  } else if (normalized.webSearchEnabled) {
    statsParts.push('web search enabled');
  }
  return {
    info: infoParts.join(', '),
    stats: statsParts.join(' — '),
  };
}

function formatAiMetaSummary(meta) {
  const display = buildAiMetaDisplay(meta);
  if (!display) return '';
  return [display.info, display.stats].filter(Boolean).join(' — ');
}

function createAiMentionChip(meta) {
  const chip = document.createElement('span');
  chip.className = 'msg-ai-chip';
  chip.textContent = buildAiMentionLabel(meta);
  return chip;
}

function createAiMetaElement(meta) {
  const display = buildAiMetaDisplay(meta);
  if (!display) return null;
  const el = document.createElement('div');
  el.className = 'msg-ai-meta';
  const info = document.createElement('span');
  info.className = 'msg-ai-meta-info';
  info.textContent = display.info;
  const stats = document.createElement('span');
  stats.className = 'msg-ai-meta-stats';
  stats.textContent = display.stats;
  el.append(info, stats);
  return el;
}

function normalizeAiUsageSection(value) {
  if (!value || typeof value !== 'object') return null;
  const dailyLimit = Math.max(0, Math.round(Number(value.dailyLimit) || 0));
  const usedTokens = roundAiTokenAmount(value.usedTokens);
  return {
    ...value,
    dailyLimit,
    usedTokens,
    remainingTokens: roundAiTokenAmount(
      Number.isFinite(Number(value.remainingTokens)) ? Number(value.remainingTokens) : (dailyLimit - usedTokens)
    ),
    exceeded: !!value.exceeded || dailyLimit <= 0 || usedTokens >= dailyLimit,
  };
}

function normalizeAiUsageSummary(value) {
  if (!value || typeof value !== 'object') return null;
  const currentUserUsage = normalizeAiUsageSection(value.currentUser);
  const globalUsage = normalizeAiUsageSection(value.global);
  return {
    currentUser: currentUserUsage,
    global: globalUsage,
    window: value.window && typeof value.window === 'object' ? value.window : {},
    canStartRequest: value.canStartRequest !== undefined
      ? !!value.canStartRequest
      : !(currentUserUsage?.exceeded || globalUsage?.exceeded),
  };
}

function formatAiUsageValue(section) {
  if (!section) return '0 / 0 tokens';
  return `${formatAiTokenAmount(section.usedTokens)} / ${integerFormatter.format(section.dailyLimit)} tokens`;
}

function getAiUsagePercent(section) {
  if (!section) return 0;
  if (section.dailyLimit <= 0) return 100;
  return Math.max(0, Math.min(100, (section.usedTokens / section.dailyLimit) * 100));
}

function getAiQuotaBlockedMessage(summary = aiUsageSummary) {
  if (!summary) return '';
  if (summary.global?.exceeded) return `Global daily AI token limit reached. Try again after ${AI_RESET_TIME_LABEL}.`;
  if (summary.currentUser?.exceeded) return `Your daily AI token limit reached. Try again after ${AI_RESET_TIME_LABEL}.`;
  return '';
}

function renderUsageBar(fillEl, valueEl, noteEl, section, options = {}) {
  if (fillEl) fillEl.style.width = `${getAiUsagePercent(section)}%`;
  if (valueEl) valueEl.textContent = formatAiUsageValue(section);
  if (noteEl) {
    const blockedMessage = options.blockedMessage || '';
    noteEl.textContent = blockedMessage || options.note || AI_USAGE_RESET_LABEL;
  }
}

function renderProfileAiUsage() {
  const card = $('profile-ai-usage-card');
  if (!card) return;
  const blockedMessage = getAiQuotaBlockedMessage();
  renderUsageBar(
    $('profile-ai-usage-fill'),
    $('profile-ai-usage-value'),
    $('profile-ai-usage-note'),
    aiUsageSummary?.currentUser || null,
    { blockedMessage }
  );
  card.classList.toggle('is-blocked', !!blockedMessage);
}

function setAiUsageSummary(summary) {
  aiUsageSummary = normalizeAiUsageSummary(summary);
  renderProfileAiUsage();
  updateAiControls();
  if ($('user-management-modal') && !$('user-management-modal').hidden) {
    void loadUserManagementSummary();
  }
}

async function refreshAiUsageSummary() {
  try {
    const res = await fetch('/api/ai/usage');
    if (!res.ok) return null;
    const data = await res.json();
    setAiUsageSummary(data);
    return aiUsageSummary;
  } catch {
    return null;
  }
}

function normalizeManagedUserSummary(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    users: Array.isArray(value.users) ? value.users.map((user) => ({
      id: user.id,
      username: String(user.username || 'Unknown'),
      iconColor: user.iconColor || '#4A90D9',
      profilePicture: user.profilePicture || null,
      aiDailyTokenLimit: Math.max(0, Math.round(Number(user.aiDailyTokenLimit) || 0)),
      aiTokensUsedToday: roundAiTokenAmount(user.aiTokensUsedToday),
      aiLimitExceeded: !!user.aiLimitExceeded,
    })) : [],
    viewerCanManageAiLimits: !!value.viewerCanManageAiLimits,
    viewerCanDeleteUsers: !!value.viewerCanDeleteUsers,
    global: normalizeAiUsageSection(value.global),
    window: value.window && typeof value.window === 'object' ? value.window : {},
  };
}

function setUserManagementLoading(message = 'Loading users…') {
  const list = $('user-management-list');
  if (!list) return;
  list.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'user-management-empty';
  empty.textContent = message;
  list.appendChild(empty);
}

function renderUserManagementPanel() {
  const summary = userManagementSummary;
  renderUsageBar(
    $('user-management-global-fill'),
    $('user-management-global-value'),
    $('user-management-reset-note'),
    summary?.global || null,
    { blockedMessage: summary?.global?.exceeded ? 'Global limit reached until the next Shanghai reset.' : '' }
  );
  $('user-management-global-actions').hidden = !summary?.viewerCanManageAiLimits;
  if (summary?.viewerCanManageAiLimits) {
    $('user-management-global-limit-input').value = String(summary.global?.dailyLimit || 0);
  }
  const list = $('user-management-list');
  if (!list) return;
  list.replaceChildren();
  const users = summary?.users || [];
  if (!users.length) {
    setUserManagementLoading('No users found');
    return;
  }
  for (const user of users) {
    const row = document.createElement('div');
    row.className = 'user-management-user';
    row.dataset.userId = user.id;

    const avatar = document.createElement('div');
    avatar.className = 'member-avatar';
    renderAvatarElement(avatar, user);

    const main = document.createElement('div');
    main.className = 'user-management-user-main';

    const head = document.createElement('div');
    head.className = 'user-management-user-head';

    const name = document.createElement('div');
    name.className = 'user-management-user-name';
    name.textContent = user.username;

    const value = document.createElement('div');
    value.className = 'user-management-user-value';
    value.textContent = `${formatAiTokenAmount(user.aiTokensUsedToday)} / ${integerFormatter.format(user.aiDailyTokenLimit)} tokens`;

    const usage = document.createElement('div');
    usage.className = 'user-management-user-usage';
    const track = document.createElement('div');
    track.className = 'usage-bar-track user-management-user-track';
    const fill = document.createElement('div');
    fill.className = 'usage-bar-fill';
    fill.style.width = `${getAiUsagePercent({
      usedTokens: user.aiTokensUsedToday,
      dailyLimit: user.aiDailyTokenLimit,
    })}%`;
    track.appendChild(fill);
    usage.append(value, track);

    head.append(name, usage);
    main.append(head);

    if (summary.viewerCanManageAiLimits || (summary.viewerCanDeleteUsers && user.username !== APP_OWNER_USERNAME)) {
      const actions = document.createElement('div');
      actions.className = 'user-management-user-actions';
      if (summary.viewerCanManageAiLimits) {
        const limitInput = document.createElement('input');
        limitInput.type = 'number';
        limitInput.min = '0';
        limitInput.step = '1';
        limitInput.value = String(user.aiDailyTokenLimit);
        limitInput.setAttribute('aria-label', `${user.username} daily AI token limit`);
        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn-primary btn-sm user-management-save-btn';
        saveBtn.textContent = 'Save limit';
        saveBtn.addEventListener('click', async () => {
          $('user-management-error').textContent = '';
          const res = await fetch(`/api/users/${encodeURIComponent(user.id)}/ai-limit`, {
            method: 'PATCH',
            headers: apiHeaders(),
            body: JSON.stringify({ dailyLimit: limitInput.value }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            $('user-management-error').textContent = data.error || 'Failed to save user limit';
            return;
          }
          await Promise.all([loadUserManagementSummary(), refreshAiUsageSummary()]);
        });
        actions.append(limitInput, saveBtn);
      }
      if (summary.viewerCanDeleteUsers && user.username !== APP_OWNER_USERNAME) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn-danger btn-sm user-management-delete-btn';
        deleteBtn.textContent = 'Delete user';
        deleteBtn.addEventListener('click', () => {
          showConfirm('Delete User', `Delete ${user.username}? This cannot be undone.`, async () => {
            const res = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
              method: 'DELETE',
              headers: apiHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              $('user-management-error').textContent = data.error || 'Failed to delete user';
              return;
            }
            await Promise.all([loadUserManagementSummary(), refreshAiUsageSummary()]);
          });
        });
        actions.appendChild(deleteBtn);
      }
      main.appendChild(actions);
    }

    row.append(avatar, main);
    list.appendChild(row);
  }
}

async function loadUserManagementSummary() {
  try {
    const res = await fetch('/api/users/management');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('user-management-error').textContent = data.error || 'Failed to load users';
      return null;
    }
    userManagementSummary = normalizeManagedUserSummary(data);
    $('user-management-error').textContent = '';
    renderUserManagementPanel();
    return userManagementSummary;
  } catch {
    $('user-management-error').textContent = 'Failed to load users';
    return null;
  }
}

function isStandalonePwaMode() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function getClientPlatformLabel() {
  return navigator.userAgentData?.platform || navigator.platform || '';
}

function getPushPlatformHint() {
  const userAgent = navigator.userAgent || '';
  const platform = getClientPlatformLabel();
  const isAppleMobile = /iPad|iPhone|iPod/.test(userAgent)
    || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isAppleMobile && !isStandalonePwaMode()) {
    return 'Install GChat to Home Screen and open it from the icon before enabling notifications on iPhone or iPad.';
  }
  return '';
}

function normalizePushStatusPayload(value) {
  const notificationSupported = 'Notification' in window;
  const serviceWorkerSupported = 'serviceWorker' in navigator;
  const pushManagerSupported = 'PushManager' in window;
  return {
    supported: notificationSupported && serviceWorkerSupported && pushManagerSupported,
    configured: !!value?.configured,
    permission: getNotificationPermissionState(),
    subscriptionActive: !!value?.subscriptionActive,
    vapidPublicKey: typeof value?.vapidPublicKey === 'string' ? value.vapidPublicKey : '',
    totalUnreadCount: Math.max(0, Number(value?.totalUnreadCount) || 0),
  };
}

function renderPushSettings() {
  const statusEl = $('push-status-text');
  const permissionEl = $('push-permission-pill');
  const hintEl = $('push-platform-hint');
  const metaEl = $('push-unread-meta');
  const enableBtn = $('enable-push-btn');
  const disableBtn = $('disable-push-btn');
  if (!statusEl || !permissionEl || !hintEl || !metaEl || !enableBtn || !disableBtn) return;

  const badgeSupported = typeof navigator.setAppBadge === 'function' || typeof navigator.clearAppBadge === 'function';
  const installHint = getPushPlatformHint();
  let statusText = 'Notifications are unavailable on this browser.';
  if (pushStatus.supported && !pushStatus.configured) {
    statusText = 'Push notifications are not configured on this server yet.';
  } else if (pushStatus.subscriptionActive) {
    statusText = 'Notifications are enabled for this device.';
  } else if (pushStatus.permission === 'denied') {
    statusText = 'Notifications are blocked in browser settings for this device.';
  } else if (pushStatus.supported) {
    statusText = 'Notifications are available but currently disabled.';
  }

  statusEl.textContent = statusText;
  permissionEl.textContent = pushStatus.permission === 'unsupported' ? 'Unsupported' : pushStatus.permission;
  hintEl.hidden = !installHint;
  hintEl.textContent = installHint;
  metaEl.textContent = `${pushStatus.totalUnreadCount > 0 ? `${pushStatus.totalUnreadCount} unread message${pushStatus.totalUnreadCount === 1 ? '' : 's'} total.` : 'No unread messages right now.'} ${badgeSupported ? 'App icon badges update when your browser supports them.' : 'App icon badges are not supported on this browser.'}`;
  enableBtn.disabled = !pushStatus.supported || !pushStatus.configured || pushStatus.permission === 'denied' || (!!installHint);
  disableBtn.hidden = !pushStatus.subscriptionActive;
  enableBtn.hidden = pushStatus.subscriptionActive;
}

async function loadPushStatus() {
  pushStatus = normalizePushStatusPayload(pushStatus);
  renderPushSettings();
  try {
    const res = await fetch('/api/push/status');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to load notification status');
    pushStatus = normalizePushStatusPayload(data);
    renderPushSettings();
    if (Object.keys(unreadCounts).length === 0) syncUnreadIndicators(pushStatus.totalUnreadCount);
    return pushStatus;
  } catch {
    renderPushSettings();
    return pushStatus;
  }
}

function urlBase64ToUint8Array(base64String) {
  // Web Push exposes the VAPID applicationServerKey in base64url form.
  // PushManager.subscribe requires the decoded Uint8Array bytes instead.
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0));
}

async function enablePushNotifications() {
  if (!pushStatus.supported) {
    showToast('This browser does not support push notifications', 'error');
    return;
  }
  if (!pushStatus.configured) {
    showToast('Push notifications are not configured on this server', 'error');
    return;
  }
  const installHint = getPushPlatformHint();
  if (installHint) {
    showToast(installHint, 'info');
    renderPushSettings();
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    pushStatus.permission = permission || getNotificationPermissionState();
    renderPushSettings();
    if (permission !== 'granted') {
      showToast('Notification permission was not granted', 'info');
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const vapidPublicKey = pushStatus.vapidPublicKey || await fetch('/api/push/vapid-public-key')
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Failed to load VAPID key');
        return String(data.publicKey || '');
      });
    if (!vapidPublicKey) throw new Error('Push key is unavailable');
    const existingSubscription = await registration.pushManager.getSubscription();
    const subscription = existingSubscription || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        userAgent: navigator.userAgent || '',
        platform: getClientPlatformLabel(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to save push subscription');
    pushStatus = normalizePushStatusPayload({
      ...pushStatus,
      configured: true,
      subscriptionActive: true,
      vapidPublicKey,
      totalUnreadCount: data.totalUnreadCount,
    });
    renderPushSettings();
    syncUnreadIndicators(pushStatus.totalUnreadCount);
    showToast('Notifications enabled', 'success');
  } catch (err) {
    showToast(String(err && err.message ? err.message : 'Failed to enable notifications'), 'error');
    void loadPushStatus();
  }
}

async function disablePushNotifications() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    const endpoint = subscription?.endpoint || null;
    if (!endpoint) {
      pushStatus = normalizePushStatusPayload({ ...pushStatus, subscriptionActive: false });
      renderPushSettings();
      showToast('Notifications are already disabled', 'info');
      return;
    }
    const res = await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ endpoint }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to disable notifications');
    if (subscription) await subscription.unsubscribe().catch(() => {});
    pushStatus = normalizePushStatusPayload({
      ...pushStatus,
      subscriptionActive: false,
      totalUnreadCount: data.totalUnreadCount,
    });
    renderPushSettings();
    showToast('Notifications disabled', 'success');
  } catch (err) {
    showToast(String(err && err.message ? err.message : 'Failed to disable notifications'), 'error');
    void loadPushStatus();
  }
}

function clearMarkdownRenderState(target) {
  if (!target) return;
  target.classList.remove('markdown-rendered');
  delete target.dataset.markdownSource;
}

function renderPlainText(target, text) {
  if (!target) return;
  clearMarkdownRenderState(target);
  target.textContent = text || '';
}

function normalizeMarkdownLinkUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function appendMarkdownInline(target, text) {
  const source = String(text || '');
  let plain = '';
  const flushPlain = () => {
    if (!plain) return;
    target.appendChild(document.createTextNode(plain));
    plain = '';
  };
  for (let i = 0; i < source.length; i += 1) {
    if (source.startsWith('**', i)) {
      const end = source.indexOf('**', i + 2);
      if (end > i + 2) {
        flushPlain();
        const strong = document.createElement('strong');
        strong.textContent = source.slice(i + 2, end);
        target.appendChild(strong);
        i = end + 1;
        continue;
      }
    }
    if (source[i] === '*' && source[i + 1] !== '*') {
      const end = source.indexOf('*', i + 1);
      if (end > i + 1) {
        flushPlain();
        const em = document.createElement('em');
        em.textContent = source.slice(i + 1, end);
        target.appendChild(em);
        i = end;
        continue;
      }
    }
    if (source[i] === '`') {
      const end = source.indexOf('`', i + 1);
      if (end > i + 1) {
        flushPlain();
        const code = document.createElement('code');
        code.textContent = source.slice(i + 1, end);
        target.appendChild(code);
        i = end;
        continue;
      }
    }
    if (source.startsWith('~~', i)) {
      const end = source.indexOf('~~', i + 2);
      if (end > i + 2) {
        flushPlain();
        const del = document.createElement('del');
        del.textContent = source.slice(i + 2, end);
        target.appendChild(del);
        i = end + 1;
        continue;
      }
    }
    if (source[i] === '[') {
      const labelEnd = source.indexOf(']', i + 1);
      const hasUrl = labelEnd > i + 1 && source[labelEnd + 1] === '(';
      if (hasUrl) {
        const urlEnd = source.indexOf(')', labelEnd + 2);
        if (urlEnd > labelEnd + 2) {
          const href = normalizeMarkdownLinkUrl(source.slice(labelEnd + 2, urlEnd).trim());
          if (href) {
            flushPlain();
            const link = document.createElement('a');
            link.href = href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = source.slice(i + 1, labelEnd);
            target.appendChild(link);
            i = urlEnd;
            continue;
          }
        }
      }
    }
    plain += source[i];
  }
  flushPlain();
}

function buildMarkdownTable(lines) {
  const parseRow = (line) => (
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())
  );
  const wrap = document.createElement('div');
  wrap.className = 'markdown-table-wrap';
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const body = document.createElement('tbody');
  const headerCells = parseRow(lines[0] || '');
  const headerRow = document.createElement('tr');
  for (const cellText of headerCells) {
    const cell = document.createElement('th');
    appendMarkdownInline(cell, cellText);
    headerRow.appendChild(cell);
  }
  head.appendChild(headerRow);
  for (let i = 2; i < lines.length; i += 1) {
    const row = document.createElement('tr');
    for (const cellText of parseRow(lines[i])) {
      const cell = document.createElement('td');
      appendMarkdownInline(cell, cellText);
      row.appendChild(cell);
    }
    body.appendChild(row);
  }
  table.append(head, body);
  wrap.appendChild(table);
  return wrap;
}

function renderMarkdownBlock(target, text) {
  const wrapper = document.createElement('div');
  renderMarkdown(wrapper, text);
  wrapper.classList.remove('markdown-rendered');
  target.append(...wrapper.childNodes);
}

function renderMarkdown(target, text) {
  if (!target) return;
  target.replaceChildren();
  target.classList.add('markdown-rendered');
  target.dataset.markdownSource = String(text || '');

  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let paragraphLines = [];
  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    const paragraph = document.createElement('p');
    appendMarkdownInline(paragraph, paragraphLines.join(' '));
    target.appendChild(paragraph);
    paragraphLines = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushParagraph();
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (headingMatch) {
      flushParagraph();
      const headingLevel = Number(headingMatch[1].length);
      if (!Number.isInteger(headingLevel) || headingLevel < 1 || headingLevel > 6) {
        paragraphLines.push(trimmed);
        continue;
      }
      const heading = document.createElement(`h${headingLevel}`);
      appendMarkdownInline(heading, headingMatch[2]);
      target.appendChild(heading);
      continue;
    }

    if (/^```/.test(trimmed)) {
      flushParagraph();
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i += 1;
      }
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = codeLines.join('\n');
      pre.appendChild(code);
      target.appendChild(pre);
      continue;
    }

    if (/^([-*_])(?:\s*\1){2,}$/.test(trimmed)) {
      flushParagraph();
      target.appendChild(document.createElement('hr'));
      continue;
    }

    const separatorLine = lines[i + 1] ? lines[i + 1].trim() : '';
    if (
      trimmed.includes('|')
      && /^\|?[\s:-]+\|[\s|:-]*$/.test(separatorLine)
    ) {
      flushParagraph();
      const tableLines = [trimmed, separatorLine];
      let tableIndex = i + 2;
      while (tableIndex < lines.length) {
        const candidate = lines[tableIndex].trim();
        if (!candidate || !candidate.includes('|')) break;
        tableLines.push(candidate);
        tableIndex += 1;
      }
      target.appendChild(buildMarkdownTable(tableLines));
      i = tableIndex - 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      i -= 1;
      const blockquote = document.createElement('blockquote');
      renderMarkdownBlock(blockquote, quoteLines.join('\n'));
      target.appendChild(blockquote);
      continue;
    }

    const bulletMatch = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bulletMatch) {
      flushParagraph();
      const list = document.createElement('ul');
      while (i < lines.length) {
        const itemMatch = /^[-*]\s+(.*)$/.exec(lines[i].trim());
        if (!itemMatch) break;
        const item = document.createElement('li');
        appendMarkdownInline(item, itemMatch[1]);
        list.appendChild(item);
        i += 1;
      }
      i -= 1;
      target.appendChild(list);
      continue;
    }

    const numberedMatch = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (numberedMatch) {
      flushParagraph();
      const list = document.createElement('ol');
      while (i < lines.length) {
        const itemMatch = /^\d+\.\s+(.*)$/.exec(lines[i].trim());
        if (!itemMatch) break;
        const item = document.createElement('li');
        appendMarkdownInline(item, itemMatch[1]);
        list.appendChild(item);
        i += 1;
      }
      i -= 1;
      target.appendChild(list);
      continue;
    }

    paragraphLines.push(trimmed);
  }

  flushParagraph();
  if (!target.childNodes.length) renderPlainText(target, text);
}

function emitSocketWithAck(event, payload, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    if (!socket) {
      reject(new Error('Connection unavailable'));
      return;
    }
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Request timed out'));
    }, timeoutMs);
    socket.emit(event, payload, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (response && response.ok) {
        resolve(response);
        return;
      }
      reject(new Error(response?.error || 'Request failed'));
    });
  });
}

function normalizeCommandUsername(value) {
  return String(value || '').trim().replace(/\s+/g, '_').toLowerCase();
}

function normalizeHashtagTopic(value) {
  if (value == null || value === '') return null;
  const trimmed = String(value).trim().replace(/^#/, '').toLowerCase();
  if (!trimmed || trimmed.length > 64) return null;
  return /^[a-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

function formatHashtagLabel(topic) {
  return topic ? `#${topic}` : '';
}

function createHashtagChip(topic) {
  const chip = document.createElement('span');
  chip.className = 'msg-hashtag-chip';
  chip.textContent = formatHashtagLabel(topic);
  return chip;
}

function getMessageHashtagKey(msg) {
  return normalizeHashtagTopic(msg && msg.hashtag);
}

function getMessageHashtagPrefix(msg) {
  const topic = getMessageHashtagKey(msg);
  return topic ? `${formatHashtagLabel(topic)} ` : '';
}

function isDisappearingMessage(msg) {
  return !!(msg && msg.isDisappearing);
}

function computeMessageViewportDelayMs(text) {
  const normalized = String(text || '').trim();
  const chars = normalized.length;
  return Math.max(
    MESSAGE_VIEW_BASE_DELAY_MS,
    Math.min(MESSAGE_VIEW_MAX_DELAY_MS, chars * MESSAGE_VIEW_PER_CHAR_MS)
  );
}

function computeDisappearingDurationMs(text) {
  const normalized = String(text || '').trim();
  const chars = normalized.length;
  return Math.max(
    MIN_DISAPPEARING_DURATION_MS,
    Math.min(
      MAX_DISAPPEARING_DURATION_MS,
      MIN_DISAPPEARING_DURATION_MS + (chars * DISAPPEARING_DURATION_PER_CHAR_MS)
    )
  );
}

function getHiddenDisappearingStorageKey(userId = currentUser && currentUser.id) {
  return userId ? `gchat:disappearing-hidden:user:${userId}` : null;
}

function loadHiddenDisappearingMessageIds(userId = currentUser && currentUser.id) {
  const key = getHiddenDisappearingStorageKey(userId);
  if (!key) return new Set();
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function persistHiddenDisappearingMessageIds(userId = currentUser && currentUser.id) {
  const key = getHiddenDisappearingStorageKey(userId);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify([...hiddenDisappearingMessageIds]));
  } catch {
    // best effort only
  }
}

function isMessageHiddenForCurrentUser(msg) {
  return !!(
    msg &&
    currentUser &&
    msg.senderId !== currentUser.id &&
    isDisappearingMessage(msg) &&
    (msg.disappearingHiddenAt || hiddenDisappearingMessageIds.has(String(msg.id)))
  );
}

function getCacheableMessages(messages = []) {
  return (messages || []).filter((msg) => !isDisappearingMessage(msg));
}

function getMessageTypePreviewLabel(msg) {
  if (!msg) return '';
  if (msg.type === 'image') return '[Image]';
  if (msg.type === 'file') return '[File: ' + (msg.filename || '') + ']';
  if (msg.type === 'whisper') return '[Whisper]';
  return '';
}

function wallpaperCssValue(dataUrl) {
  if (wallpaperTheme) return wallpaperTheme.wallpaperCssValue(dataUrl);
  if (!dataUrl) return DEFAULT_WALLPAPER;
  return `url(${JSON.stringify(String(dataUrl))})`;
}

function normalizeWallpaperSettings(settings = {}) {
  if (wallpaperTheme) return wallpaperTheme.normalizeSettings(settings);
  return {
    ...settings,
    wallpaperDataUrl: typeof settings.wallpaperDataUrl === 'string' && settings.wallpaperDataUrl ? settings.wallpaperDataUrl : null,
    wallpaperBlur: DEFAULT_WALLPAPER_BLUR,
    wallpaperTransparency: DEFAULT_WALLPAPER_TRANSPARENCY,
  };
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function getWallpaperSettings(settings = appLocalSettings) {
  const normalized = normalizeWallpaperSettings(settings);
  return {
    wallpaperDataUrl: normalized.wallpaperDataUrl,
    wallpaperBlur: normalized.wallpaperBlur,
    wallpaperTransparency: normalized.wallpaperTransparency,
  };
}

function wallpaperSettingsEqual(left, right) {
  const a = getWallpaperSettings(left);
  const b = getWallpaperSettings(right);
  return a.wallpaperDataUrl === b.wallpaperDataUrl
    && a.wallpaperBlur === b.wallpaperBlur
    && a.wallpaperTransparency === b.wallpaperTransparency;
}

function applyWallpaperPreviewStyle(dataUrl, blur, transparency) {
  const preview = $('wallpaper-current-preview');
  const overlay = $('wallpaper-current-preview-overlay');
  if (preview) {
    preview.src = dataUrl || DEFAULT_WALLPAPER_PREVIEW_SRC;
    preview.style.filter = `blur(${blur}px)`;
    preview.style.transform = blur > 0 ? 'scale(1.08)' : 'scale(1)';
  }
  if (overlay) {
    overlay.style.background = `rgba(0,0,0,${(100 - transparency) / 100})`;
  }
}

function syncWallpaperDraftControls(settings = appLocalSettings) {
  const normalized = getWallpaperSettings(settings);
  const blurInput = $('wallpaper-blur-input');
  const blurValue = $('wallpaper-blur-value');
  const transparencyInput = $('wallpaper-transparency-input');
  const transparencyValue = $('wallpaper-transparency-value');
  if (blurInput) blurInput.value = String(normalized.wallpaperBlur);
  if (blurValue) blurValue.textContent = `${normalized.wallpaperBlur}px`;
  if (transparencyInput) transparencyInput.value = String(normalized.wallpaperTransparency);
  if (transparencyValue) transparencyValue.textContent = `${normalized.wallpaperTransparency}%`;
}

function buildWallpaperDraft(overrides = {}) {
  return {
    ...getWallpaperSettings(appLocalSettings),
    ...(wallpaperDraft || {}),
    ...overrides,
  };
}

function applyWallpaperFromSettings() {
  const wallpaperSettings = getWallpaperSettings(appLocalSettings);
  if (wallpaperTheme) {
    wallpaperTheme.applyToRoot(wallpaperSettings);
  } else {
    const cssValue = wallpaperCssValue(wallpaperSettings.wallpaperDataUrl);
    document.documentElement.style.setProperty('--chat-wallpaper', cssValue);
    document.documentElement.style.setProperty('--auth-wallpaper', cssValue);
    document.documentElement.style.setProperty('--wallpaper-blur', `${wallpaperSettings.wallpaperBlur}px`);
    document.documentElement.style.setProperty('--wallpaper-overlay-opacity', String((100 - wallpaperSettings.wallpaperTransparency) / 100));
  }
  applyWallpaperPreviewStyle(wallpaperSettings.wallpaperDataUrl, wallpaperSettings.wallpaperBlur, wallpaperSettings.wallpaperTransparency);
  syncWallpaperDraftControls(wallpaperSettings);
}

async function saveSettingsToServer(options = {}) {
  if (!currentUser) return { ok: false, networkError: true, error: 'Not signed in' };
  const payload = {
    wallpaperDataUrl: appLocalSettings.wallpaperDataUrl || null,
    wallpaperBlur: getWallpaperSettings(appLocalSettings).wallpaperBlur,
    wallpaperTransparency: getWallpaperSettings(appLocalSettings).wallpaperTransparency,
    hideProfileDot: !!appLocalSettings.hideProfileDot,
  };
  const body = JSON.stringify(payload);
  if (typeof options.onUploadProgress === 'function' || typeof options.onUploadComplete === 'function') {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PATCH', '/api/auth/settings');
      const headers = apiHeaders();
      for (const [key, val] of Object.entries(headers)) xhr.setRequestHeader(key, val);
      xhr.upload.onprogress = (evt) => {
        if (!evt.lengthComputable || typeof options.onUploadProgress !== 'function') return;
        options.onUploadProgress(evt.loaded, evt.total);
      };
      xhr.upload.onloadend = () => {
        if (typeof options.onUploadComplete === 'function') options.onUploadComplete();
      };
      xhr.onerror = () => resolve({ ok: false, networkError: true, error: 'Network error. Please try again.' });
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* ignore parse errors */ }
        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          error: data.error || null,
          networkError: false,
        });
      };
      xhr.send(body);
    });
  }
  try {
    const res = await fetch('/api/auth/settings', {
      method: 'PATCH',
      headers: apiHeaders(),
      body,
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: res.ok,
      status: res.status,
      error: data.error || null,
      networkError: false,
    };
  } catch {
    return { ok: false, networkError: true, error: 'Network error. Please try again.' };
  }
}

async function loadSettingsFromServer() {
  try {
    const res = await fetch('/api/auth/settings');
    if (!res.ok) return;
    const data = normalizeWallpaperSettings(await res.json());
    appLocalSettings.wallpaperDataUrl = data.wallpaperDataUrl || null;
    appLocalSettings.wallpaperBlur = data.wallpaperBlur;
    appLocalSettings.wallpaperTransparency = data.wallpaperTransparency;
    if (typeof data.hideProfileDot === 'boolean') appLocalSettings.hideProfileDot = data.hideProfileDot;
  } catch {
    // ignore and use local settings
  }
}

function loadMergedLocalSettings(userId = currentUser && currentUser.id) {
  const local = normalizeWallpaperSettings(readLocalSettings(userId));
  appLocalSettings.wallpaperDataUrl = local.wallpaperDataUrl || null;
  appLocalSettings.wallpaperBlur = local.wallpaperBlur;
  appLocalSettings.wallpaperTransparency = local.wallpaperTransparency;
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

function clearMessageVisibilityTimer(messageId) {
  const key = String(messageId || '');
  const timer = messageVisibilityTimers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  messageVisibilityTimers.delete(key);
}

function clearAllMessageVisibilityTimers() {
  for (const [messageId, timer] of messageVisibilityTimers.entries()) {
    clearTimeout(timer);
    messageVisibilityTimers.delete(messageId);
  }
}

function isRowVisibleInMessagesViewport(row) {
  const area = messagesArea();
  if (!area || !row || row.hidden) return false;
  const areaRect = area.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  return rowRect.bottom > areaRect.top && rowRect.top < areaRect.bottom;
}

function completeViewportTrackingForRow(row) {
  if (!row || !row.isConnected || !socket || !currentGroupId || document.visibilityState !== 'visible') return;
  const messageId = row.dataset.msgId;
  if (!messageId) return;

  if (!pendingReadMessageIds.has(messageId) && row.dataset.hasRead !== '1') {
    pendingReadMessageIds.add(messageId);
    row.classList.remove('unseen');
    row.dataset.hasRead = '1';
    setLocalMessageReadState(currentGroupId, messageId, true);
    syncGroupUnreadCount(currentGroupId);
    socket.emit('mark_message_read', { groupId: currentGroupId, messageId });
  }

  if (row.dataset.disappearing === '1' && row.dataset.senderId !== String(currentUser?.id) && row.dataset.disappearingHidden !== '1') {
    row.dataset.disappearingHidden = '1';
    void hideDisappearingMessageLocally(messageId, currentGroupId, { notifyServer: true });
    return;
  }

  if (row.dataset.hasRead === '1') {
    readObserver?.unobserve(row);
  }
}

function syncViewportTrackingForRow(row, isIntersecting) {
  const messageId = row?.dataset?.msgId;
  if (!messageId) return;
  if (!isIntersecting || document.visibilityState !== 'visible') {
    clearMessageVisibilityTimer(messageId);
    return;
  }
  completeViewportTrackingForRow(row);
}

function ensureReadObserver() {
  if (readObserver) return;
  readObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const row = entry.target;
      syncViewportTrackingForRow(row, entry.isIntersecting && isRowVisibleInMessagesViewport(row));
      if (row?.dataset?.hasRead === '1' && row?.dataset?.disappearing !== '1') {
        readObserver.unobserve(row);
      }
    }
  }, {
    root: messagesArea(),
    threshold: 0,
  });
}

function observeMessageForRead(row, msg) {
  if (!row || row.nodeType !== 1 || !canObserveMessageVisibility(msg)) return;
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
      id: row.dataset.msgId,
      isDisappearing: row.dataset.disappearing === '1',
      disappearingHiddenAt: row.dataset.disappearingHidden === '1' ? new Date().toISOString() : null,
    });
  }
  for (const row of rows) {
    if (row.dataset.senderId === currentUser.id) continue;
    syncViewportTrackingForRow(row, isRowVisibleInMessagesViewport(row));
  }
}

function resetReadTracking() {
  pendingReadMessageIds = new Set();
  pendingDisappearingStartMessageIds = new Set();
  clearAllMessageVisibilityTimers();
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
function getNotificationPermissionState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission || 'default';
}

function isNotificationPermissionGranted() {
  return getNotificationPermissionState() === 'granted';
}

function getGenericUnreadNotificationBody(unreadCount) {
  const safeCount = Math.max(0, Number(unreadCount) || 0);
  if (safeCount > 0) {
    return `You have ${safeCount} unread message${safeCount === 1 ? '' : 's'} in GChat.`;
  }
  return GENERIC_NOTIFICATION_FALLBACK_BODY;
}

function getTotalUnreadCount() {
  return Object.values(unreadCounts).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0);
}

async function updateAppBadge(count) {
  const safeCount = Math.max(0, Number(count) || 0);
  const badgeTarget = typeof navigator !== 'undefined' && navigator ? navigator : null;
  if (!badgeTarget) return;
  if (safeCount > 0 && typeof badgeTarget.setAppBadge === 'function') {
    try {
      await badgeTarget.setAppBadge(safeCount);
      badgeApiState = safeCount;
    } catch {
      badgeApiState = APP_BADGE_UNSUPPORTED;
    }
    return;
  }
  if (typeof badgeTarget.clearAppBadge === 'function') {
    try {
      await badgeTarget.clearAppBadge();
      badgeApiState = 0;
    } catch {
      badgeApiState = APP_BADGE_UNSUPPORTED;
    }
  }
}

function syncUnreadIndicators(forcedTotal = null) {
  const totalUnread = forcedTotal == null
    ? getTotalUnreadCount()
    : Math.max(0, Number(forcedTotal) || 0);
  void updateAppBadge(totalUnread);
  window.electronAPI?.setUnreadCount(totalUnread);
  return totalUnread;
}

function sendNativeNotification(unreadCount, groupId) {
  if (window.electronAPI) {
    window.electronAPI.showNotification({
      title: GENERIC_NOTIFICATION_TITLE,
      body: getGenericUnreadNotificationBody(unreadCount),
      groupId,
    });
    return;
  }
  if (pushStatus.subscriptionActive || !isNotificationPermissionGranted()) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(GENERIC_NOTIFICATION_TITLE, {
        body: getGenericUnreadNotificationBody(unreadCount),
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: PUSH_NOTIFICATION_TAG,
      });
      n.addEventListener('click', () => { window.focus(); });
    } catch { /* notifications not supported */ }
  }
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
let pendingDisappearingStartMessageIds = new Set();
const groupDataCache = new Map();
const groupPreloadPromises = new Map();
const pendingAttachmentRows = new Map();
let hiddenDisappearingMessageIds = new Set();
const disappearingMessageTimers = new Map();
const messageVisibilityTimers = new Map();
let imageViewerZoom = 1;
let pushStatus = {
  supported: false,
  configured: false,
  permission: 'default',
  subscriptionActive: false,
  vapidPublicKey: '',
  totalUnreadCount: 0,
};
let badgeApiState = APP_BADGE_UNSUPPORTED;
const appLocalSettings = {
  wallpaperDataUrl: null,
  wallpaperBlur: DEFAULT_WALLPAPER_BLUR,
  wallpaperTransparency: DEFAULT_WALLPAPER_TRANSPARENCY,
  hideProfileDot: true,
};
let wallpaperDraft = null;
let desktopSidebarWidth = DESKTOP_DEFAULT_SIDEBAR_WIDTH;
let desktopRightPanelExpanded = true;
let activeTagFilter = null;
let grokRequestInFlight = false;
let grokResponseDraft = '';
let grokResponseModel = '';
let grokResponseMeta = null;
let grokRequestSource = 'panel';
let grokRequestHashtag = null;
let aiUsageSummary = null;
let userManagementSummary = null;
let aiMessageRequestInFlight = false;
const composerTokens = {
  whisper: null,
  hashtag: null,
  ai: null,
};

function renderCurrentUserAvatar(user = currentUser) {
  const avatar = $('user-avatar');
  if (!avatar || !user) return;
  renderAvatarElement(avatar, user);
}

function ensureGroupCacheEntry(groupId) {
  if (!groupDataCache.has(groupId)) {
    const local = readLocalGroupCache(groupId);
    const localMessages = (local?.messages || []).filter((msg) => !isMessageHiddenForCurrentUser(msg));
    groupDataCache.set(groupId, {
      messages: localMessages.length ? localMessages : (local?.messages ? [] : null),
      messageRows: null,
      members: local?.members || null,
      oldestMessageId: local?.oldestMessageId || null,
      rowsDirty: !!local?.messages,
    });
  }
  return groupDataCache.get(groupId);
}

function getMemberProfile(groupId, userId) {
  if (String(userId) === AI_ASSISTANT_USER_ID) {
    return {
      id: AI_ASSISTANT_USER_ID,
      username: AI_ASSISTANT_NAME,
      iconColor: AI_ASSISTANT_COLOR,
      profilePicture: AI_ASSISTANT_PROFILE_PICTURE,
    };
  }
  const cache = ensureGroupCacheEntry(groupId);
  const groupMembers = cache.members || [];
  const groupMember = groupMembers.find((member) => member.id === userId);
  if (groupMember) return groupMember;
  const activeMember = members.find((member) => member.id === userId);
  if (activeMember) return activeMember;
  return null;
}

function getGroupMemberCount(groupId = currentGroupId) {
  if (!groupId) return 0;
  const cache = ensureGroupCacheEntry(groupId);
  if (Array.isArray(cache?.members) && cache.members.length) return cache.members.length;
  if (groupId === currentGroupId && Array.isArray(members)) return members.length;
  return 0;
}

function resolveDeliveryRecipientCount(msg, groupId = currentGroupId) {
  const total = Math.max(0, Number(msg?.totalRecipients) || 0);
  if (!msg || msg.type === 'whisper') return total;
  if (isAiAssistantMessage(msg)) return total;
  const memberCount = getGroupMemberCount(groupId);
  if (memberCount > 0 && total >= memberCount) return Math.max(0, memberCount - 1);
  return total;
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

async function removeTagMessagesFromCache(groupId, hashtag) {
  const normalizedTag = normalizeHashtagTopic(hashtag);
  if (!normalizedTag) return false;
  const cache = ensureGroupCacheEntry(groupId);
  if (!cache.messages) return false;
  const isCurrentGroup = groupId === currentGroupId;

  const removedIds = [];
  cache.messages = cache.messages.filter((msg) => {
    const shouldKeep = getMessageHashtagKey(msg) !== normalizedTag;
    if (!shouldKeep) removedIds.push(String(msg.id));
    return shouldKeep;
  });
  if (removedIds.length === 0) return false;

  for (const messageId of removedIds) {
    pendingReadMessageIds.delete(messageId);
    pendingDisappearingStartMessageIds.delete(messageId);
    clearDisappearingTimer(messageId);
    clearMessageVisibilityTimer(messageId);
    hiddenDisappearingMessageIds.delete(messageId);
    if (isCurrentGroup) {
      const row = document.querySelector(`[data-msg-id="${CSS.escape(messageId)}"]`);
      if (row) readObserver?.unobserve(row);
    }
  }
  persistHiddenDisappearingMessageIds();

  if (isCurrentGroup) allMessages = cache.messages;
  cache.oldestMessageId = cache.messages.length ? cache.messages[0].id : null;
  cache.rowsDirty = true;
  syncGroupUnreadCount(groupId);
  if (isCurrentGroup) {
    await rebuildGroupMessageRows(groupId);
    renderGroupFromCache(groupId);
    observeCurrentGroupRowsForRead();
    addSystemMessage(`${formatHashtagLabel(normalizedTag)} was cleared`);
  }
  writeLocalGroupCache(groupId, cache);
  await updateGroupPreviewFromMessage(groupId, cache.messages[cache.messages.length - 1] || null);
  return true;
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
  for (const msg of allMessages) scheduleDisappearingTimerForMessage(msg);
  $('chat-member-count').textContent = members.length + ' member' + (members.length !== 1 ? 's' : '');
  renderMembersList();
  renderWhisperPicker();
  renderTagFilters();
  applyActiveTagFilterToRenderedMessages();
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

  const preload = (async () => {
    if (cache.messages && cache.members && cache.rowsDirty) {
      await rebuildGroupMessageRows(groupId);
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

function resolveSlashWhisperTarget(rawTarget) {
  const normalizedTarget = normalizeCommandUsername(rawTarget);
  if (!normalizedTarget) return null;
  return members.find((member) => normalizeCommandUsername(member.username) === normalizedTarget) || null;
}

function setComposerShellDisabled(disabled) {
  const shell = $('message-composer-shell');
  if (!shell) return;
  shell.classList.toggle('is-disabled', !!disabled);
}

function setWhisperTokenFromMember(member, rawTarget = member && member.username) {
  if (!member) return false;
  composerTokens.whisper = {
    memberId: member.id,
    username: member.username,
    raw: `/w ${rawTarget} `,
    label: `Whisper → ${member.username}`,
  };
  whisperRecipients = [member.id];
  messageMode = 'whisper';
  return true;
}

function clearWhisperToken({ restoreText = false } = {}) {
  const token = composerTokens.whisper;
  if (!token) return;
  composerTokens.whisper = null;
  whisperRecipients = [];
  messageMode = 'normal';
  if (restoreText) {
    const input = $('message-input');
    if (input) {
      input.value = token.raw + input.value;
      input.selectionStart = input.selectionEnd = token.raw.length;
    }
  }
}

function setHashtagToken(topic, options = {}) {
  const normalizedTopic = normalizeHashtagTopic(topic);
  if (!normalizedTopic) return false;
  composerTokens.hashtag = {
    topic: normalizedTopic,
    raw: `/# ${normalizedTopic} `,
    label: formatHashtagLabel(normalizedTopic),
    linkedToFilter: !!options.linkedToFilter,
  };
  return true;
}

function clearHashtagToken({ restoreText = false } = {}) {
  const token = composerTokens.hashtag;
  if (!token) return;
  composerTokens.hashtag = null;
  if (restoreText) {
    const input = $('message-input');
    if (input) {
      input.value = token.raw + input.value;
      input.selectionStart = input.selectionEnd = token.raw.length;
    }
  }
  if (activeTagFilter && token.topic === activeTagFilter) {
    activeTagFilter = null;
    renderTagFilters();
    applyActiveTagFilterToRenderedMessages();
  }
}

function setAiToken() {
  composerTokens.ai = {
    raw: '/ai ',
    label: 'AI',
  };
  return true;
}

function clearAiToken({ restoreText = false } = {}) {
  const token = composerTokens.ai;
  if (!token) return;
  composerTokens.ai = null;
  if (restoreText) {
    const input = $('message-input');
    if (input) {
      input.value = token.raw + input.value;
      input.selectionStart = input.selectionEnd = token.raw.length;
    }
  }
}

function syncComposerTokens() {
  const strip = $('message-token-strip');
  if (!strip) return;
  strip.replaceChildren();
  const tokens = [];
  if (composerTokens.whisper) {
    const token = document.createElement('span');
    token.className = 'message-token message-token-whisper';
    token.textContent = composerTokens.whisper.label;
    tokens.push(token);
  }
  if (composerTokens.hashtag) {
    const token = document.createElement('span');
    token.className = 'message-token message-token-hashtag';
    token.textContent = composerTokens.hashtag.label;
    tokens.push(token);
  }
  if (composerTokens.ai) {
    const token = document.createElement('span');
    token.className = 'message-token message-token-ai';
    token.textContent = composerTokens.ai.label;
    tokens.push(token);
  }
  strip.hidden = tokens.length === 0;
  strip.append(...tokens);
}

function updateSlashCommandMenu() {
  const menu = $('slash-command-menu');
  const input = $('message-input');
  if (!menu || !input) return;
  const match = /^\/([^\s]*)$/.exec(input.value);
  const commandQuery = match ? match[1].toLowerCase() : null;
  const shouldShow = !composerTokens.whisper
    && !composerTokens.hashtag
    && !composerTokens.ai
    && commandQuery != null
    && ['w', '#', 'd', 'ai'].some((command) => command.startsWith(commandQuery));
  menu.hidden = !shouldShow;
}

function isAiModeEnabled(groupData = currentGroupData) {
  return !!(groupData && groupData.aiEnabled);
}

function getAiDisabledMessage() {
  return 'AI mode is disabled by the group owner';
}

function getWhisperCombinationError({ hasHashtag = false, hasAi = false } = {}) {
  if (hasHashtag && hasAi) return 'AI requests and tags cannot be combined with whispers';
  if (hasAi) return 'AI requests cannot be combined with whispers';
  return 'Tags cannot be combined with whispers';
}

function canUseAiInCurrentGroup({ showError = false } = {}) {
  if (!currentGroupId || !currentGroupData) {
    if (showError) showToast('Select a group first', 'error');
    return false;
  }
  if (!isAiModeEnabled()) {
    if (showError) showToast(getAiDisabledMessage(), 'error');
    return false;
  }
  const quotaMessage = getAiQuotaBlockedMessage();
  if (quotaMessage) {
    if (showError) showToast(quotaMessage, 'error');
    return false;
  }
  return true;
}

function updateAiControls() {
  const quotaMessage = getAiQuotaBlockedMessage();
  const enabled = !!currentGroupId && isAiModeEnabled() && !quotaMessage;
  const disabledReason = !isAiModeEnabled() ? getAiDisabledMessage() : quotaMessage;
  const askBtn = $('ask-grok-btn');
  if (askBtn) {
    askBtn.disabled = !enabled;
    askBtn.classList.toggle('is-disabled', !enabled);
    askBtn.title = enabled ? 'Ask AI' : (disabledReason || 'Ask AI');
    askBtn.setAttribute('aria-label', enabled ? 'Ask AI' : (disabledReason || 'Ask AI'));
  }
  const slashAiBtn = $('slash-command-ai-item');
  if (slashAiBtn) {
    slashAiBtn.disabled = !enabled;
    slashAiBtn.title = enabled ? 'Ask AI' : (disabledReason || 'Ask AI');
  }
  if (!enabled && !$('grok-modal').hidden) closeGrokModal();
}

function messageMatchesActiveTag(msg) {
  if (!activeTagFilter) return true;
  return getMessageHashtagKey(msg) === activeTagFilter;
}

function rowMatchesActiveTag(row) {
  if (!activeTagFilter) return true;
  return String(row?.dataset?.hashtag || '') === activeTagFilter;
}

function applyActiveTagFilterToRenderedMessages() {
  const area = messagesArea();
  if (!area) return;
  const rows = Array.from(area.children);
  for (const child of rows) {
    if (child.classList.contains('load-more-indicator')) continue;
    if (child.classList.contains('msg-row')) {
      child.hidden = !rowMatchesActiveTag(child);
      continue;
    }
    if (child.classList.contains('msg-system')) {
      child.hidden = !!activeTagFilter;
    }
  }
  let divider = null;
  let hasVisibleMessageAfterDivider = false;
  for (const child of rows) {
    if (child.classList.contains('msg-date-divider')) {
      if (divider) divider.hidden = !hasVisibleMessageAfterDivider;
      divider = child;
      hasVisibleMessageAfterDivider = false;
      child.hidden = true;
      continue;
    }
    if (child.classList.contains('msg-row') && !child.hidden) {
      hasVisibleMessageAfterDivider = true;
      if (divider) divider.hidden = false;
    }
  }
  if (divider) divider.hidden = !hasVisibleMessageAfterDivider;
  for (const child of rows) {
    if (child.classList.contains('msg-row')) {
      syncViewportTrackingForRow(child, isRowVisibleInMessagesViewport(child));
    }
  }
}

function getAvailableGroupTags(groupId = currentGroupId) {
  if (!groupId) return [];
  const cache = ensureGroupCacheEntry(groupId);
  const tags = new Map();
  for (const msg of cache.messages || []) {
    const topic = getMessageHashtagKey(msg);
    if (!topic || tags.has(topic)) continue;
    tags.set(topic, formatHashtagLabel(topic));
  }
  return [...tags.entries()].map(([topic, label]) => ({ topic, label }));
}

function renderTagFilters() {
  const wrap = $('chat-tag-filters');
  if (!wrap) return;
  const tags = getAvailableGroupTags();
  if (activeTagFilter && !tags.some((tag) => tag.topic === activeTagFilter)) {
    activeTagFilter = null;
  }
  wrap.replaceChildren();
  wrap.hidden = tags.length === 0;
  for (const tag of tags) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-tag-filter-btn';
    btn.dataset.tagTopic = tag.topic;
    if (tag.topic === activeTagFilter) btn.classList.add('active');
    btn.textContent = tag.label;
    btn.addEventListener('click', () => {
      activeTagFilter = activeTagFilter === tag.topic ? null : tag.topic;
      if (activeTagFilter) {
        clearWhisperToken();
        whisperRecipients = [];
        messageMode = 'normal';
        updateWhisperBtn();
      }
      if (activeTagFilter) setHashtagToken(activeTagFilter, { linkedToFilter: true });
      else composerTokens.hashtag = null;
      syncComposerTokens();
      renderTagFilters();
      applyActiveTagFilterToRenderedMessages();
      updateSlashCommandMenu();
      autoResizeTextarea($('message-input'));
      $('message-input').focus();
    });
    btn.addEventListener('contextmenu', (event) => {
      if (!canCurrentUserClearTag()) return;
      event.preventDefault();
      showTagContextMenu(event, tag.topic);
    });
    wrap.appendChild(btn);
  }
}

function handleComposerBackspace(input) {
  if (!input || input.value || input.selectionStart !== 0 || input.selectionEnd !== 0) return false;
  if (composerTokens.ai) {
    clearAiToken({ restoreText: true });
    syncComposerTokens();
    updateSlashCommandMenu();
    autoResizeTextarea(input);
    return true;
  }
  if (composerTokens.hashtag) {
    clearHashtagToken({ restoreText: true });
    syncComposerTokens();
    renderTagFilters();
    applyActiveTagFilterToRenderedMessages();
    updateSlashCommandMenu();
    autoResizeTextarea(input);
    return true;
  }
  if (composerTokens.whisper) {
    clearWhisperToken({ restoreText: true });
    syncComposerTokens();
    updateWhisperBtn();
    updateSlashCommandMenu();
    autoResizeTextarea(input);
    return true;
  }
  return false;
}

function maybeTokenizeSlashCommand(input) {
  if (!input) return false;
  const whisperMatch = /^\/w\s+([^\s]+)\s$/.exec(input.value);
  if (whisperMatch) {
    if (composerTokens.hashtag || composerTokens.ai) {
      showToast(getWhisperCombinationError({
        hasHashtag: !!composerTokens.hashtag,
        hasAi: !!composerTokens.ai,
      }), 'error');
      return false;
    }
    const member = resolveSlashWhisperTarget(whisperMatch[1]);
    if (!member) {
      showToast('Whisper user not found in this group', 'error');
      return false;
    }
    setWhisperTokenFromMember(member, whisperMatch[1]);
    input.value = '';
    syncComposerTokens();
    updateWhisperBtn();
    updateSlashCommandMenu();
    autoResizeTextarea(input);
    return true;
  }
  const hashtagMatch = /^\/#\s+([^\s]+)\s$/.exec(input.value);
  if (hashtagMatch) {
    if (composerTokens.whisper || (messageMode === 'whisper' && whisperRecipients.length > 0)) {
      showToast('Tags cannot be combined with whispers', 'error');
      return false;
    }
    if (composerTokens.ai) {
      showToast('Use /# before /ai', 'error');
      return false;
    }
    const topic = normalizeHashtagTopic(hashtagMatch[1]);
    if (!topic) {
      showToast('Hashtag topics can use letters, numbers, underscores, and dashes', 'error');
      return false;
    }
    if (activeTagFilter && activeTagFilter !== topic) activeTagFilter = null;
    setHashtagToken(topic);
    input.value = '';
    syncComposerTokens();
    renderTagFilters();
    applyActiveTagFilterToRenderedMessages();
    updateSlashCommandMenu();
    autoResizeTextarea(input);
    return true;
  }
  const aiMatch = /^\/ai\s$/.exec(input.value);
  if (aiMatch) {
    if (composerTokens.whisper || (messageMode === 'whisper' && whisperRecipients.length > 0)) {
      showToast('AI requests cannot be combined with whispers', 'error');
      return false;
    }
    if (!canUseAiInCurrentGroup({ showError: true })) return false;
    input.value = '';
    syncComposerTokens();
    updateSlashCommandMenu();
    autoResizeTextarea(input);
    openGrokModal({
      source: 'chat',
      hashtag: composerTokens.hashtag ? composerTokens.hashtag.topic : null,
    });
    return true;
  }
  return false;
}

function parseCommandToken(body, command) {
  const match = new RegExp(`^\\/${command}\\s+([^\\s]+)(?:\\s+|$)`).exec(body);
  if (!match) return null;
  return {
    value: match[1],
    rest: body.slice(match[0].length).trim(),
  };
}

function parseAiCommand(body) {
  const match = /^\/ai(?:\s+|$)([\s\S]*)$/.exec(body);
  if (!match) return null;
  return {
    prompt: match[1].trim(),
  };
}

function parseComposerMessageInput(rawText) {
  let body = String(rawText || '').trim();
  let whisperRecipientIds = composerTokens.whisper
    ? [composerTokens.whisper.memberId]
    : (messageMode === 'whisper' && whisperRecipients.length ? [...whisperRecipients] : []);
  let hashtag = composerTokens.hashtag ? composerTokens.hashtag.topic : null;
  let isAiPrompt = !!composerTokens.ai;
  let isDisappearing = false;

  if (messageMode === 'whisper' && !composerTokens.whisper && whisperRecipients.length === 0) {
    return { ok: false, error: 'Select at least one whisper recipient' };
  }

  if (whisperRecipientIds.length && (hashtag || isAiPrompt)) {
    return { ok: false, error: getWhisperCombinationError({ hasHashtag: !!hashtag, hasAi: !!isAiPrompt }) };
  }

  if (!whisperRecipientIds.length && !hashtag) {
    const hashtagToken = parseCommandToken(body, '#');
    if (hashtagToken) {
      const topic = normalizeHashtagTopic(hashtagToken.value);
      if (!topic) return { ok: false, error: 'Invalid hashtag topic' };
      hashtag = topic;
      body = hashtagToken.rest;
      const invalidWhisper = parseCommandToken(body, 'w');
      if (invalidWhisper) return { ok: false, error: 'Tags cannot be combined with whispers' };
      const aiToken = parseAiCommand(body);
      if (aiToken) {
        isAiPrompt = true;
        body = aiToken.prompt;
      }
    } else {
      const aiToken = parseAiCommand(body);
      if (aiToken) {
        isAiPrompt = true;
        body = aiToken.prompt;
        const invalidHashtag = parseCommandToken(body, '#');
        if (invalidHashtag) return { ok: false, error: 'Use /# before /ai' };
        const invalidWhisper = parseCommandToken(body, 'w');
        if (invalidWhisper) return { ok: false, error: 'AI requests cannot be combined with whispers' };
      } else {
        const whisperToken = parseCommandToken(body, 'w');
        if (whisperToken) {
          const member = resolveSlashWhisperTarget(whisperToken.value);
          if (!member) return { ok: false, error: 'Whisper user not found in this group' };
          whisperRecipientIds = [member.id];
          body = whisperToken.rest;
          const invalidHashtag = parseCommandToken(body, '#');
          if (invalidHashtag) return { ok: false, error: 'Tags cannot be combined with whispers' };
        }
      }
    }
  } else if (whisperRecipientIds.length && (parseCommandToken(body, '#') || parseAiCommand(body))) {
    return {
      ok: false,
      error: getWhisperCombinationError({
        hasHashtag: !!parseCommandToken(body, '#'),
        hasAi: !!parseAiCommand(body),
      }),
    };
  } else {
    if (hashtag && !isAiPrompt) {
      const aiToken = parseAiCommand(body);
      if (aiToken) {
        isAiPrompt = true;
        body = aiToken.prompt;
      }
    }
    if (hashtag && parseCommandToken(body, 'w')) {
      return { ok: false, error: 'Tags cannot be combined with whispers' };
    }
    if (isAiPrompt && parseCommandToken(body, 'w')) {
      return { ok: false, error: 'AI requests cannot be combined with whispers' };
    }
  }

  if (isAiPrompt) {
    if (!canUseAiInCurrentGroup()) {
      return { ok: false, error: getAiDisabledMessage() };
    }
    if (/^\/d\s+/.test(body)) {
      return { ok: false, error: 'AI requests cannot be combined with disappearing messages' };
    }
    if (!body) return { ok: false, error: 'AI prompt is required' };
    return {
      ok: true,
      text: body,
      whisperRecipientIds: [],
      hashtag,
      isAiPrompt: true,
      isDisappearing: false,
      disappearingDurationMs: 0,
    };
  }

  if (/^\/d\s+/.test(body)) {
    isDisappearing = true;
    body = body.replace(/^\/d\s+/, '').trim();
  }

  if (!body) return { ok: false, error: 'Message text is required' };

  return {
    ok: true,
    text: body,
    whisperRecipientIds,
    hashtag,
    isAiPrompt: false,
    isDisappearing,
    disappearingDurationMs: isDisappearing ? computeDisappearingDurationMs(body) : 0,
  };
}

function canTrackDisappearingMessage(msg) {
  return !!(
    msg &&
    currentUser &&
    msg.groupId === currentGroupId &&
    msg.senderId !== currentUser.id &&
    isDisappearingMessage(msg) &&
    !isMessageHiddenForCurrentUser(msg)
  );
}

function canObserveMessageVisibility(msg) {
  return canTrackMessageRead(msg) || canTrackDisappearingMessage(msg);
}

function clearDisappearingTimer(messageId) {
  const key = String(messageId || '');
  const timer = disappearingMessageTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    disappearingMessageTimers.delete(key);
  }
}

async function refreshGroupPreviewAfterHide(groupId) {
  const cache = ensureGroupCacheEntry(groupId);
  const lastMsg = cache.messages && cache.messages.length ? cache.messages[cache.messages.length - 1] : null;
  await updateGroupPreviewFromMessage(groupId, lastMsg);
}

async function hideDisappearingMessageLocally(messageId, groupId = currentGroupId, options = {}) {
  const normalizedId = String(messageId || '');
  if (!normalizedId) return;
  clearDisappearingTimer(normalizedId);
  clearMessageVisibilityTimer(normalizedId);
  hiddenDisappearingMessageIds.add(normalizedId);
  persistHiddenDisappearingMessageIds();
  if (options.notifyServer && socket && currentGroupId) {
    socket.emit('hide_disappearing_message', { groupId: groupId || currentGroupId, messageId: normalizedId });
  }

  const row = document.querySelector(`[data-msg-id="${CSS.escape(normalizedId)}"]`);
  if (row) {
    readObserver?.unobserve(row);
    row.remove();
  }

  for (const [cacheGroupId, cache] of groupDataCache.entries()) {
    if (!cache.messages) continue;
    const nextMessages = cache.messages.filter((msg) => String(msg.id) !== normalizedId);
    if (nextMessages.length === cache.messages.length) continue;
    cache.messages = nextMessages;
    if (cache.messageRows) {
      cache.messageRows = cache.messageRows.filter((entry) => String(entry?.dataset?.msgId || '') !== normalizedId);
    }
    cache.rowsDirty = true;
    cache.oldestMessageId = cache.messages.length ? cache.messages[0].id : null;
    syncGroupUnreadCount(cacheGroupId);
    writeLocalGroupCache(cacheGroupId, cache);
    if (cacheGroupId === currentGroupId) {
      allMessages = cache.messages;
      renderTagFilters();
      applyActiveTagFilterToRenderedMessages();
    }
    await refreshGroupPreviewAfterHide(cacheGroupId);
    break;
  }
}

function scheduleDisappearingTimerForMessage(msg) {
  if (!canTrackDisappearingMessage(msg) || !msg.disappearingExpiresAt) return;
  const remainingMs = Date.parse(msg.disappearingExpiresAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    void hideDisappearingMessageLocally(msg.id, msg.groupId, { notifyServer: true });
    return;
  }
  const key = String(msg.id);
  if (disappearingMessageTimers.has(key)) return;
  disappearingMessageTimers.set(key, setTimeout(() => {
    disappearingMessageTimers.delete(key);
    void hideDisappearingMessageLocally(msg.id, msg.groupId, { notifyServer: true });
  }, remainingMs));
}

function requestDisappearingTimerStart(messageId, groupId = currentGroupId) {
  const normalizedId = String(messageId || '');
  if (!normalizedId || !socket || !groupId || pendingDisappearingStartMessageIds.has(normalizedId)) return;
  pendingDisappearingStartMessageIds.add(normalizedId);
  socket.emit('start_disappearing_timer', { groupId, messageId: normalizedId });
}

function applyDisappearingStateUpdate({ groupId, messageId, startedAt, expiresAt, hiddenAt }) {
  const normalizedId = String(messageId || '');
  pendingDisappearingStartMessageIds.delete(normalizedId);
  for (const [cacheGroupId, cache] of groupDataCache.entries()) {
    const target = cache.messages ? cache.messages.find((msg) => String(msg.id) === normalizedId) : null;
    if (!target) continue;
    target.disappearingStartedAt = startedAt || null;
    target.disappearingExpiresAt = expiresAt || null;
    target.disappearingHiddenAt = hiddenAt || null;
    if (hiddenAt) {
      void hideDisappearingMessageLocally(normalizedId, cacheGroupId, { notifyServer: false });
      return;
    }
    if (cacheGroupId === currentGroupId) {
      const row = document.querySelector(`[data-msg-id="${CSS.escape(normalizedId)}"]`);
      if (row) {
        row.dataset.disappearingStarted = startedAt ? '1' : '0';
        if (row.dataset.hasRead === '1') readObserver?.unobserve(row);
      }
    }
    scheduleDisappearingTimerForMessage(target);
    writeLocalGroupCache(cacheGroupId, cache);
    break;
  }
}

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
  sparkles: [
    ['path', { d: 'M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z' }],
    ['path', { d: 'M18.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z' }],
    ['path', { d: 'M5.5 13l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z' }],
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
  if (resolvedLabel) {
    el.dataset.iconLabel = resolvedLabel;
    if (iconOnly) {
      el.title = resolvedLabel;
      el.setAttribute('aria-label', resolvedLabel);
    }
  }
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

function syncAppViewportHeight() {
  const height = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight;
  document.documentElement.style.setProperty('--app-viewport-height', `${Math.max(320, Math.round(height))}px`);
}

function bindViewportHeightTracking() {
  syncAppViewportHeight();
  window.addEventListener('resize', syncAppViewportHeight);
  window.addEventListener('orientationchange', syncAppViewportHeight);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncAppViewportHeight);
    window.visualViewport.addEventListener('scroll', syncAppViewportHeight);
  }
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
    document.body.classList.remove('sidebar-narrow', 'sidebar-compact', 'sidebar-resizing');
    document.documentElement.style.setProperty('--sidebar-width', `${DESKTOP_DEFAULT_SIDEBAR_WIDTH}px`);
    return;
  }
  const { min, max } = desktopSidebarBounds();
  desktopSidebarWidth = Math.min(max, Math.max(min, Math.round(desktopSidebarWidth || DESKTOP_DEFAULT_SIDEBAR_WIDTH)));
  document.documentElement.style.setProperty('--sidebar-width', `${desktopSidebarWidth}px`);
  document.body.classList.toggle('sidebar-narrow', desktopSidebarWidth <= DESKTOP_BRAND_ONLY_SIDEBAR_WIDTH);
  document.body.classList.toggle('sidebar-compact', desktopSidebarWidth <= DESKTOP_ICON_ONLY_SIDEBAR_WIDTH);
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
  bindViewportHeightTracking();
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
  hiddenDisappearingMessageIds = loadHiddenDisappearingMessageIds(currentUser.id);
  $('user-username').textContent = currentUser.username;
  renderCurrentUserAvatar(currentUser);
  loadMergedLocalSettings(currentUser.id);
  await loadSettingsFromServer();
  applyWallpaperFromSettings();
  writeLocalSettings(appLocalSettings, currentUser.id);
  const versionInfo = await fetchAppVersionInfo();
  if (versionInfo) {
    currentAppVersion = versionInfo.version;
    appVersionLabel = 'v' + versionInfo.version;
  }
  $('app-version-label').textContent = appVersionLabel;

  await loadPushStatus();
  await refreshAiUsageSummary();
  await loadGroups();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type !== 'push-unread-count') return;
      pushStatus.totalUnreadCount = Math.max(0, Number(event.data.totalUnreadCount) || 0);
      syncUnreadIndicators(pushStatus.totalUnreadCount);
      renderPushSettings();
    });
  }
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
  startHostedAppUpdatePolling();

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
    void checkForHostedAppUpdate();
  });
  window.addEventListener('blur', () => {
    clearAllMessageVisibilityTimers();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      observeCurrentGroupRowsForRead();
      void checkForHostedAppUpdate();
      return;
    }
    clearAllMessageVisibilityTimers();
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
    const hiddenKey = getHiddenDisappearingStorageKey(currentUser && currentUser.id);
    if (event.key === hiddenKey) {
      hiddenDisappearingMessageIds = loadHiddenDisappearingMessageIds(currentUser && currentUser.id);
      for (const cache of groupDataCache.values()) {
        if (cache.messages) cache.rowsDirty = true;
      }
      if (currentGroupId) {
        void rebuildGroupMessageRows(currentGroupId).then(() => renderGroupFromCache(currentGroupId));
      }
      return;
    }
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
    unreadCounts = {};
    for (const group of groups) {
      unreadCounts[group.id] = Math.max(0, Number(group.unreadCount) || 0);
    }
    pushStatus.totalUnreadCount = getTotalUnreadCount();
    renderGroupList();
    syncUnreadIndicators();
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

function formatUnreadBadgeCount(count) {
  const safeCount = Math.max(0, Number(count) || 0);
  if (safeCount <= 0) return '';
  return safeCount > 99 ? '99+' : integerFormatter.format(safeCount);
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
  badge.textContent = formatUnreadBadgeCount(cnt);
  badge.hidden = cnt === 0;

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

function canCurrentUserClearTag() {
  if (!currentGroupData || !currentUser) return false;
  if (currentGroupData.createdBy === currentUser.id) return true;
  return !!(currentGroupData.allowMemberClear || currentGroupData.allowMemberClearTag);
}

function syncAllowMemberClearTagToggleState() {
  const clearToggle = $('allow-member-clear-toggle');
  const tagToggle = $('allow-member-clear-tag-toggle');
  if (!clearToggle || !tagToggle) return;
  const forcedOn = !!clearToggle.checked;
  tagToggle.checked = forcedOn || !!currentGroupData?.allowMemberClearTag;
  tagToggle.disabled = forcedOn;
}

async function clearTagMessages(topic) {
  const normalizedTopic = normalizeHashtagTopic(topic);
  if (!normalizedTopic || !currentGroupId) return;
  const res = await fetch(`/api/groups/${currentGroupId}/tags/${encodeURIComponent(normalizedTopic)}/messages`, {
    method: 'DELETE',
    headers: apiHeaders(),
  });
  if (res.ok) return;
  const data = await res.json().catch(() => ({}));
  showToast(data.error || 'Failed to clear hashtag', 'error');
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
  const aiMentionPrefix = msg.aiMention ? `${buildAiMentionLabel(msg.aiMeta)} ` : '';
  const prefix = getMessageHashtagPrefix(msg);
  const typeLabel = getMessageTypePreviewLabel(msg);
  if (typeLabel) return aiMentionPrefix + prefix + typeLabel;
  const key = getGroupKey(groupId);
  if (!key || msg.type !== 'text') return aiMentionPrefix + prefix + '[encrypted]';
  const plaintext = await decryptMessage(msg.encryptedContent, msg.iv, key, groupId);
  return aiMentionPrefix + prefix + (plaintext || '[encrypted]');
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

function setLocalMessageReadState(groupId, messageId, hasRead = true) {
  const normalizedGroupId = String(groupId || '');
  const normalizedMessageId = String(messageId || '');
  if (!normalizedGroupId || !normalizedMessageId) return;
  const cache = ensureGroupCacheEntry(normalizedGroupId);
  let changed = false;
  for (const msg of cache.messages || []) {
    if (String(msg.id) !== normalizedMessageId) continue;
    if (msg.hasRead !== hasRead) {
      msg.hasRead = hasRead;
      changed = true;
    }
    break;
  }
  if (changed) writeLocalGroupCache(normalizedGroupId, cache);
}

function updateUnreadBadge(groupId, count) {
  const badge = $('badge-' + groupId);
  if (badge) {
    badge.textContent = formatUnreadBadgeCount(count);
    badge.hidden = (Number(count) || 0) === 0;
  }
  pushStatus.totalUnreadCount = syncUnreadIndicators();
}

function updateGroupUnseenCount(groupId, messages = []) {
  const unseen = (messages || []).reduce((acc, msg) => {
    if (!msg || msg.senderId === currentUser?.id) return acc;
    return acc + (msg.hasRead === true ? 0 : 1);
  }, 0);
  unreadCounts[groupId] = unseen;
  updateUnreadBadge(groupId, unseen);
}

function syncGroupUnreadCount(groupId) {
  const cache = ensureGroupCacheEntry(groupId);
  const messages = cache.messages || (groupId === currentGroupId ? allMessages : null);
  if (!messages) return;
  updateGroupUnseenCount(groupId, messages);
}

// ── Select group ──────────────────────────────────────────────────────────────
async function selectGroup(groupId) {
  currentGroupId = groupId;
  currentGroupData = groups.find(g => g.id === groupId) || null;
  replyingTo = null;
  pendingAttachmentRows.clear();
  whisperRecipients = [];
  messageMode = 'normal';
  activeTagFilter = null;
  composerTokens.whisper = null;
  composerTokens.hashtag = null;
  syncComposerTokens();
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
  renderTagFilters();

  // Owner controls
  const isOwner = currentGroupData && currentGroupData.createdBy === currentUser.id;
  $('owner-actions').hidden = !isOwner;
  $('set-group-color-btn').hidden = !isOwner;
  $('common-actions').hidden = false;
  if (currentGroupData) {
    $('allow-member-clear-toggle').checked = !!currentGroupData.allowMemberClear;
    $('allow-member-clear-tag-toggle').checked = !!currentGroupData.allowMemberClearTag;
    $('allow-member-export-toggle').checked = !!currentGroupData.allowMemberExport;
    $('allow-member-kick-toggle').checked = !!currentGroupData.allowMemberKick;
    $('ai-mode-toggle').checked = !!currentGroupData.aiEnabled;
  }
  syncAllowMemberClearTagToggleState();
  updateAiControls();
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
  const modalBlockingInput = !$('grok-modal').hidden;
  const input = $('message-input');
  const sendBtn = $('send-btn');
  const blockedStatus = $('composer-blocked-status');
  setElementIcon($('set-key-btn'), 'key-round', { iconOnly: true, label: hasKey ? 'Change Key' : 'Set Key' });
  input.disabled = !hasKey || modalBlockingInput;
  input.placeholder = !hasKey
    ? 'Enter group key to continue'
    : (modalBlockingInput ? 'Complete Ask AI first…' : 'Type a message…');
  if (modalBlockingInput) input.setAttribute('aria-describedby', 'composer-blocked-status');
  else input.removeAttribute('aria-describedby');
  sendBtn.disabled = !hasKey || modalBlockingInput;
  setComposerShellDisabled(!hasKey || modalBlockingInput);
  if (blockedStatus) {
    blockedStatus.textContent = modalBlockingInput ? 'Chat input is temporarily disabled while the Ask AI modal is open.' : '';
  }
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
    const rawMsgs = await res.json();
    const msgs = rawMsgs.filter((msg) => !isMessageHiddenForCurrentUser(msg));
    if (!before) {
      const cache = ensureGroupCacheEntry(groupId);
      cache.messages = msgs;
      cache.messageRows = await buildMessageRows(msgs, groupId);
      cache.oldestMessageId = rawMsgs.length > 0 ? rawMsgs[0].id : null;
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
      cache.oldestMessageId = rawMsgs[0].id;
      cache.rowsDirty = false;
      writeLocalGroupCache(groupId, cache);
      // Restore scroll position
      area.scrollTop = area.scrollHeight - prevScrollHeight;
    }
    if (!before && groupId === currentGroupId && rawMsgs.length > 0) {
      oldestMessageId = rawMsgs[0].id;
    }
    if (groupId === currentGroupId) {
      renderTagFilters();
      applyActiveTagFilterToRenderedMessages();
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
  const isAiAssistant = isAiAssistantMessage(msg);
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
  if (isMessageHiddenForCurrentUser(msg)) return null;

  const row = document.createElement('div');
  row.className = 'msg-row'
    + (isOwn ? ' own' : '')
    + (msg.type === 'whisper' ? ' whisper' : '')
    + (isDisappearingMessage(msg) ? ' disappearing' : '');
  row.dataset.msgId = msg.id;
  row.dataset.senderId = msg.senderId;
  row.dataset.hashtag = getMessageHashtagKey(msg) || '';
  row.dataset.disappearing = isDisappearingMessage(msg) ? '1' : '0';
  row.dataset.disappearingStarted = msg.disappearingStartedAt ? '1' : '0';
  row.dataset.disappearingHidden = msg.disappearingHiddenAt ? '1' : '0';
  row.dataset.hasRead = isReadByMe ? '1' : '0';
  if (!isReadByMe) row.classList.add('unseen');

  const av = document.createElement('div');
  av.className = 'msg-avatar';
  const memberProfile = getMemberProfile(groupId, msg.senderId);
  renderAvatarElement(av, {
    username: memberProfile?.username || msg.senderName,
    iconColor: memberProfile?.iconColor || msg.senderColor,
    profilePicture: isAiAssistant
      ? getAiAssistantProfilePicture(msg.aiMeta?.model)
      : (memberProfile?.profilePicture || msg.profilePicture || null),
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

  const prefixRow = document.createElement('div');
  prefixRow.className = 'msg-prefix-row';
  let hasPrefixContent = false;

  // Whisper label
  if (msg.type === 'whisper') {
    const wl = document.createElement('span');
    wl.className = 'whisper-label';
    wl.textContent = 'Whisper' + (msg.whisperTo ? ' (private)' : '');
    prefixRow.appendChild(wl);
    hasPrefixContent = true;
  }

  if (isDisappearingMessage(msg)) {
    const disappearingLabel = document.createElement('span');
    disappearingLabel.className = 'disappearing-label';
    disappearingLabel.textContent = 'Disappearing';
    prefixRow.appendChild(disappearingLabel);
    hasPrefixContent = true;
  }

  const inlinePrefixChips = [];
  if (msg.aiMention && msg.type === 'text') inlinePrefixChips.push(createAiMentionChip(msg.aiMeta));
  if (msg.hashtag && msg.type === 'text') inlinePrefixChips.push(createHashtagChip(msg.hashtag));

  if (msg.hashtag && msg.type !== 'text') {
    const hashtagChip = createHashtagChip(msg.hashtag);
    prefixRow.appendChild(hashtagChip);
    hasPrefixContent = true;
  }

  if (hasPrefixContent) bubble.appendChild(prefixRow);

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
  const textEl = document.createElement(isAiAssistant ? 'div' : 'span');
  textEl.className = 'msg-text';
  await renderMsgContent(msg, textEl, bubble, groupId);

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
  if (isOwn || isAiAssistant) {
    const del = document.createElement('span');
    del.className = 'msg-delivery';
    del.id = 'del-' + msg.id;
    const { total, read } = normalizeDeliveryCounts(resolveDeliveryRecipientCount(msg, groupId), msg.readCount);
    del.dataset.totalRecipients = String(total);
    del.dataset.readCount = String(read);
    renderDeliveryTicks(del, total, read);
    meta.appendChild(del);
  }

  const inlineChipsForRow = isAiAssistant ? [] : inlinePrefixChips;
  if (isAiAssistant && inlinePrefixChips.length) {
    const prefix = document.createElement('div');
    prefix.className = 'msg-text-prefix';
    prefix.append(...inlinePrefixChips);
    textEl.prepend(prefix);
  }
  if (msg.type === 'text') {
    const bodyRow = document.createElement('div');
    bodyRow.className = 'msg-body-row';
    if (inlineChipsForRow.length) {
      const inlineRow = document.createElement('div');
      inlineRow.className = 'msg-inline-row';
      inlineRow.append(...inlineChipsForRow, textEl);
      bodyRow.append(inlineRow, meta);
    } else {
      bodyRow.append(textEl, meta);
    }
    bubble.appendChild(bodyRow);
  } else {
    bubble.appendChild(textEl);
    bubble.appendChild(meta);
  }

  const aiMetaEl = isAiAssistant ? createAiMetaElement(msg.aiMeta) : null;
  if (aiMetaEl) bubble.appendChild(aiMetaEl);

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

  scheduleDisappearingTimerForMessage(msg);

  return row;
}

async function renderMsgContent(msg, textEl, bubble, groupId = currentGroupId) {
  const key = groupId ? getGroupKey(groupId) : null;

  if (!encryptionVisible) {
    if (msg.type === 'image') renderPlainText(textEl, '[encrypted image]');
    else if (msg.type === 'file') renderPlainText(textEl, '[encrypted file: ' + (msg.filename || '') + ']');
    else renderPlainText(textEl, msg.encryptedContent || '[no content]');
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
    renderPlainText(textEl, MSG_NO_KEY);
    return;
  }

  const plaintext = await decryptMessage(msg.encryptedContent, msg.iv, key, groupId);
  if (plaintext === null) {
    renderPlainText(textEl, MSG_DECRYPT_FAIL);
  } else {
    if (isAiAssistantMessage(msg)) renderMarkdown(textEl, plaintext);
    else renderPlainText(textEl, plaintext);
  }
}

async function appendMessageBubble(msg, scroll, groupId = currentGroupId) {
  const previousMessage = allMessages.length ? allMessages[allMessages.length - 1] : null;
  const showSenderName = !shouldContinueSeries(previousMessage, msg);
  const row = await buildMessageRow(msg, groupId, { showSenderName });
  if (!row) return;

  const area = messagesArea();
  const cache = ensureGroupCacheEntry(groupId);
  const wasNearBottom = area
    ? (area.scrollHeight - area.scrollTop - area.clientHeight < 150)
    : false;

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
  renderTagFilters();
  applyActiveTagFilterToRenderedMessages();
  const isVisibleInCurrentView = messageMatchesActiveTag(msg);
  if (activeTagFilter && !isVisibleInCurrentView) return row;

  // Scroll behavior
  if (scroll !== false) {
    if (msg.senderId === currentUser.id) {
      scrollToBottom(true);
      return row;
    }
    if (wasNearBottom) {
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

function resetComposerAfterSend() {
  clearTimeout(window._myTypingTimer);
  socket.emit('stop_typing', { groupId: currentGroupId });
  replyingTo = null;
  $('reply-preview-bar').hidden = true;
  const inp = $('message-input');
  inp.value = '';
  clearAiToken();
  if (!activeTagFilter) composerTokens.hashtag = null;
  composerTokens.whisper = null;
  whisperRecipients = [];
  messageMode = 'normal';
  if (activeTagFilter) setHashtagToken(activeTagFilter, { linkedToFilter: true });
  syncComposerTokens();
  updateWhisperBtn();
  updateSlashCommandMenu();
  renderTagFilters();
  autoResizeTextarea(inp);
  scrollToBottom(true);
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
let ctxTagTopic = null;
function showContextMenu(e, msg, text) {
  ctxMsg = msg; ctxText = text;
  hideTagContextMenu();
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

function showTagContextMenu(e, topic) {
  ctxTagTopic = normalizeHashtagTopic(topic);
  if (!ctxTagTopic) return;
  hideContextMenu();
  const menu = $('tag-ctx-menu');
  const deleteBtn = $('tag-ctx-delete');
  deleteBtn.textContent = `Delete ${formatHashtagLabel(ctxTagTopic)}`;
  setElementIcon(deleteBtn, 'trash-2', { label: `Delete ${formatHashtagLabel(ctxTagTopic)}` });
  menu.hidden = false;
  menu.style.left = Math.min(e.clientX, window.innerWidth - 170) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
}

function hideTagContextMenu() {
  $('tag-ctx-menu').hidden = true;
  ctxTagTopic = null;
}

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

function setWallpaperBusyState(busy) {
  const saveBtn = $('wallpaper-save-btn');
  const resetBtn = $('wallpaper-reset-btn');
  const closeBtn = $('wallpaper-close-btn');
  const input = $('wallpaper-input');
  if (saveBtn) saveBtn.disabled = !!busy || !wallpaperDraft || wallpaperSettingsEqual(wallpaperDraft, appLocalSettings);
  if (resetBtn) resetBtn.disabled = !!busy;
  if (closeBtn) closeBtn.disabled = !!busy;
  if (input) input.disabled = !!busy;
}

function setWallpaperProgress(percent, label) {
  const wrap = $('wallpaper-progress');
  const fill = $('wallpaper-progress-fill');
  const text = $('wallpaper-progress-label');
  if (!wrap || !fill || !text) return;
  if (percent === null || percent === undefined) {
    wrap.hidden = true;
    fill.style.width = '0%';
    text.textContent = '';
    return;
  }
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  wrap.hidden = false;
  fill.style.width = safePercent + '%';
  text.textContent = label || '';
}

function resetWallpaperProgress() {
  setWallpaperProgress(null, '');
}

function resetWallpaperDraft() {
  wallpaperDraft = null;
  $('wallpaper-error').textContent = '';
  $('wallpaper-input').value = '';
  resetWallpaperProgress();
  setWallpaperBusyState(false);
  setWallpaperSaveState(false);
  applyWallpaperFromSettings();
}

async function saveWallpaperDraft() {
  if (!wallpaperDraft || wallpaperSettingsEqual(wallpaperDraft, appLocalSettings)) {
    $('wallpaper-error').textContent = WALLPAPER_SELECT_FIRST_MSG;
    return;
  }
  const previousWallpaperSettings = getWallpaperSettings(appLocalSettings);
  const nextWallpaperSettings = getWallpaperSettings(wallpaperDraft);
  setWallpaperBusyState(true);
  setWallpaperProgress(4, 'Uploading wallpaper…');
  appLocalSettings.wallpaperDataUrl = nextWallpaperSettings.wallpaperDataUrl;
  appLocalSettings.wallpaperBlur = nextWallpaperSettings.wallpaperBlur;
  appLocalSettings.wallpaperTransparency = nextWallpaperSettings.wallpaperTransparency;
  applyWallpaperFromSettings();
  writeLocalSettings(appLocalSettings, currentUser && currentUser.id);
  const result = await saveSettingsToServer({
    onUploadProgress: (loaded, total) => {
      const ratio = total > 0 ? loaded / total : 0;
      setWallpaperProgress(Math.max(4, Math.round(ratio * 88)), 'Uploading wallpaper…');
    },
    onUploadComplete: () => {
      setWallpaperProgress(92, 'Saving wallpaper…');
    },
  });
  if (!result.ok && !result.networkError) {
    appLocalSettings.wallpaperDataUrl = previousWallpaperSettings.wallpaperDataUrl || null;
    appLocalSettings.wallpaperBlur = previousWallpaperSettings.wallpaperBlur;
    appLocalSettings.wallpaperTransparency = previousWallpaperSettings.wallpaperTransparency;
    applyWallpaperFromSettings();
    writeLocalSettings(appLocalSettings, currentUser && currentUser.id);
    $('wallpaper-error').textContent = result.error || 'Failed to save wallpaper';
    setWallpaperBusyState(false);
    resetWallpaperProgress();
    setWallpaperSaveState(true);
    return;
  }
  setWallpaperProgress(100, result.ok ? 'Wallpaper saved' : 'Wallpaper saved locally');
  $('wallpaper-modal').hidden = true;
  resetWallpaperDraft();
  showToast(result.ok ? WALLPAPER_SAVE_SUCCESS_MSG : WALLPAPER_SAVE_SYNC_FAIL_MSG, result.ok ? 'success' : 'info');
}

function applyWallpaperDraftPreview(dataUrl) {
  const draft = getWallpaperSettings({
    ...appLocalSettings,
    ...(wallpaperDraft || {}),
    wallpaperDataUrl: dataUrl !== undefined ? dataUrl : (wallpaperDraft ? wallpaperDraft.wallpaperDataUrl : appLocalSettings.wallpaperDataUrl),
  });
  applyWallpaperPreviewStyle(draft.wallpaperDataUrl, draft.wallpaperBlur, draft.wallpaperTransparency);
  syncWallpaperDraftControls(draft);
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
  const parsedMessage = parseComposerMessageInput(text);
  if (!parsedMessage.ok) {
    showToast(parsedMessage.error, 'error');
    return;
  }
  if (parsedMessage.isAiPrompt) {
    openGrokModal({
      source: 'chat',
      prompt: parsedMessage.text,
      hashtag: parsedMessage.hashtag || null,
    });
    return;
  }
  const messageText = parsedMessage.text;
  const hasNewline = /[\r\n]/.test(messageText);
  const normalizedText = messageText.trim().replace(/\s+/g, ' ');
  const normalizedSignatureText = normalizedText.toLowerCase();
  const shouldInspectShortSpam = !hasNewline && normalizedText.length <= 80;
  const shortSpamChars = shouldInspectShortSpam
    ? Array.from(normalizedText).filter((char) => char.trim())
    : [];
  if (shouldInspectShortSpam) {
    const uniqueVisibleChars = new Set(shortSpamChars.map((char) => char.toLowerCase()));
    if (shortSpamChars.length >= 8 && uniqueVisibleChars.size <= 2) {
      showToast('Please avoid sending repetitive short messages', 'error');
      return;
    }
    const shortTokens = normalizedText.split(' ').filter(Boolean);
    if (shortTokens.length >= 4 && shortTokens.length <= 24) {
      const tokenSet = new Set(shortTokens.map((token) => token.toLowerCase()));
      if (tokenSet.size === 1 && shortTokens[0].length <= 8) {
        showToast('Please avoid repeating the same short message', 'error');
        return;
      }
    }
  }

  // Client-side rate limiting
  const now = Date.now();
  clientRateLimiter.times = clientRateLimiter.times.filter(t => now - t < 3000);
  if (clientRateLimiter.times.length >= 5) {
    showToast('Sending too fast, slow down', 'error');
    return;
  }
  // Repeated message check
  if (normalizedText === clientRateLimiter.lastContent) {
    clientRateLimiter.repeatCount = (clientRateLimiter.repeatCount || 0) + 1;
    if (clientRateLimiter.repeatCount >= 3) {
      showToast("Don't send the same message repeatedly", 'error');
      return;
    }
  } else {
    clientRateLimiter.repeatCount = 0;
    clientRateLimiter.lastContent = normalizedText;
  }
  clientRateLimiter.times.push(now);

  try {
    const { encryptedContent, iv } = await encryptMessage(messageText, key, currentGroupId);
    if (estimateBase64Bytes(encryptedContent) > MAX_TEXT_MESSAGE_BYTES) {
      showToast('Message too large', 'error');
      return;
    }
    const spamSignature = shouldInspectShortSpam ? await sha256Hex(normalizedSignatureText) : null;
    const hashtag = parsedMessage.hashtag || null;

    // Build replyTo data
    let replyToData = null;
    if (replyingTo) {
      replyToData = JSON.stringify({
        id: replyingTo.id,
        senderName: replyingTo.senderName,
        preview: replyingTo.preview,
      });
    }

    if (parsedMessage.whisperRecipientIds && parsedMessage.whisperRecipientIds.length > 0) {
      socket.emit('send_whisper', {
        groupId: currentGroupId,
        encryptedContent, iv,
        whisperTo: parsedMessage.whisperRecipientIds,
        replyTo: replyToData,
        hashtag,
        isDisappearing: parsedMessage.isDisappearing,
        disappearingDurationMs: parsedMessage.disappearingDurationMs,
        spamSignature,
      });
    } else {
      socket.emit('send_message', {
        groupId: currentGroupId,
        encryptedContent,
        iv,
        replyTo: replyToData,
        hashtag,
        isDisappearing: parsedMessage.isDisappearing,
        disappearingDurationMs: parsedMessage.disappearingDurationMs,
        spamSignature,
      });
    }
    resetComposerAfterSend();
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

async function updateGroupSettingRequest(payload) {
  const res = await fetch('/api/groups/' + currentGroupId + '/settings', {
    method: 'PATCH',
    headers: apiHeaders(),
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, error: data.error || null };
}

function uploadEncryptedAttachment(groupId, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/groups/${groupId}/upload`);
    const isBinaryUpload = body && body.encryptedBytes instanceof Uint8Array;
    const headers = apiHeaders({ json: !isBinaryUpload });
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
    if (isBinaryUpload) {
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Upload-IV', body.iv);
      xhr.setRequestHeader('X-Upload-Type', body.type);
      xhr.setRequestHeader('X-Upload-Filename', encodeURIComponent(body.filename || 'file'));
      xhr.setRequestHeader('X-Client-Upload-Id', body.clientUploadId || '');
      if (body.hashtag) xhr.setRequestHeader('X-Upload-Hashtag', body.hashtag);
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
  if (composerTokens.hashtag && (composerTokens.whisper || (messageMode === 'whisper' && whisperRecipients.length > 0))) {
    showToast('Tags cannot be combined with whispers', 'error');
    return;
  }
  const uploadId = createUploadId();

  let processedFile = file;
  const isImage = isAllowedUploadImageType(file.type);

  if (isImage) {
    processedFile = await compressImage(file);
    if (processedFile.size > MAX_ATTACHMENT_BYTES) {
      showToast(ATTACHMENT_TOO_LARGE_MSG, 'error');
      return;
    }
  } else {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      showToast(ATTACHMENT_TOO_LARGE_MSG, 'error');
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
    const hashtag = composerTokens.hashtag ? composerTokens.hashtag.topic : null;
    if (hashtag) body.hashtag = hashtag;
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
    removePendingAttachment(uploadId);
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
    pendingDisappearingStartMessageIds = new Set();
    clearAllMessageVisibilityTimers();
  });

  socket.on('connect_error', () => {
    $('conn-dot').className = 'conn-dot';
    $('conn-label').textContent = 'Connection error';
  });

  socket.on('attachment_upload_progress', (payload) => {
    if (!payload || payload.groupId !== currentGroupId) return;
    if (payload.senderId === currentUser?.id && !pendingAttachmentRows.has(payload.uploadId)) return;
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
      if (msg.senderId !== currentUser.id) {
        if (cache.messages) {
          syncGroupUnreadCount(msg.groupId);
        } else {
          unreadCounts[msg.groupId] = (unreadCounts[msg.groupId] || 0) + 1;
          updateUnreadBadge(msg.groupId, unreadCounts[msg.groupId]);
        }
        playNotifSound();
      }
      // Update last message preview
      const preview = await getMessagePreviewText(msg, msg.groupId);
      updateGroupPreview(msg.groupId, preview, msg.createdAt);
      // Send native OS notification when a message arrives in a background group.
      if (msg.senderId !== currentUser.id) {
        const totalUnread = getTotalUnreadCount();
        pushStatus.totalUnreadCount = totalUnread;
        sendNativeNotification(totalUnread, msg.groupId);
      }
      return;
    }
    applyCurrentUserReadState(msg);
    await appendMessageBubble(msg, true, msg.groupId);
    if (msg.senderId !== currentUser.id) {
      observeCurrentGroupRowsForRead();
      syncGroupUnreadCount(msg.groupId);
    }
    // Update preview
    const preview2 = await getMessagePreviewText(msg, msg.groupId);
    updateGroupPreview(msg.groupId, preview2, msg.createdAt);
    // Send native OS notification when the window is not focused (active group)
    if (!document.hasFocus() && msg.senderId !== currentUser.id) {
      const totalUnread = getTotalUnreadCount();
      pushStatus.totalUnreadCount = totalUnread;
      sendNativeNotification(totalUnread, msg.groupId);
    }
  });

  socket.on('message_read_update', ({ messageId, readCount }) => {
    pendingReadMessageIds.delete(messageId);
    updateDeliveryForMessage(messageId, readCount);
    const stored = allMessages.find(m => m.id === messageId);
    if (stored) stored.readCount = Math.max(0, Number(readCount) || 0);
  });

  socket.on('disappearing_state_updated', (payload) => {
    applyDisappearingStateUpdate(payload || {});
  });

  socket.on('message_deleted', ({ messageId }) => {
    clearDisappearingTimer(messageId);
    clearMessageVisibilityTimer(messageId);
    if (hiddenDisappearingMessageIds.delete(String(messageId))) persistHiddenDisappearingMessageIds();
    const row = document.querySelector('[data-msg-id="' + messageId + '"]');
    if (row) {
      readObserver?.unobserve(row);
      row.remove();
    }
    pendingReadMessageIds.delete(messageId);
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
      syncGroupUnreadCount(groupId);
      writeLocalGroupCache(groupId, cache);
      if (groupId === currentGroupId) {
        allMessages = cache.messages;
        renderTagFilters();
        applyActiveTagFilterToRenderedMessages();
      }
      void refreshGroupPreviewAfterHide(groupId);
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
    for (const msg of cache.messages || []) {
      clearDisappearingTimer(msg.id);
      clearMessageVisibilityTimer(msg.id);
      hiddenDisappearingMessageIds.delete(String(msg.id));
    }
    persistHiddenDisappearingMessageIds();
    cache.messages = [];
    cache.messageRows = [];
    cache.members = cache.members || [];
    cache.oldestMessageId = null;
    cache.rowsDirty = false;
    updateGroupUnseenCount(groupId, cache.messages);
    writeLocalGroupCache(groupId, cache);
    if (groupId !== currentGroupId) return;
    renderGroupFromCache(groupId);
    renderTagFilters();
    addSystemMessage('Chat history was cleared');
  });

  socket.on('tag_cleared', ({ groupId, hashtag }) => {
    void removeTagMessagesFromCache(groupId, hashtag);
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

  socket.on('group_settings_updated', ({ groupId, allowMemberClear, allowMemberClearTag, allowMemberExport, allowMemberKick, aiEnabled, groupColor }) => {
    const group = groups.find((g) => g.id === groupId);
    if (group) {
      if (allowMemberClear !== undefined) group.allowMemberClear = !!allowMemberClear;
      if (allowMemberClearTag !== undefined) group.allowMemberClearTag = !!allowMemberClearTag;
      if (allowMemberExport !== undefined) group.allowMemberExport = !!allowMemberExport;
      if (allowMemberKick !== undefined) group.allowMemberKick = !!allowMemberKick;
      if (aiEnabled !== undefined) group.aiEnabled = !!aiEnabled;
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
      if (allowMemberClearTag !== undefined) currentGroupData.allowMemberClearTag = !!allowMemberClearTag;
      if (allowMemberExport !== undefined) currentGroupData.allowMemberExport = !!allowMemberExport;
      if (allowMemberKick !== undefined) currentGroupData.allowMemberKick = !!allowMemberKick;
      if (aiEnabled !== undefined) currentGroupData.aiEnabled = !!aiEnabled;
      if (groupColor !== undefined) currentGroupData.groupColor = groupColor || null;
    }
    const isOwner = currentGroupData && currentGroupData.createdBy === currentUser.id;
    if (isOwner) {
      $('allow-member-clear-toggle').checked = !!currentGroupData.allowMemberClear;
      $('allow-member-clear-tag-toggle').checked = !!currentGroupData.allowMemberClearTag;
      $('allow-member-export-toggle').checked = !!currentGroupData.allowMemberExport;
      $('allow-member-kick-toggle').checked = !!currentGroupData.allowMemberKick;
      $('ai-mode-toggle').checked = !!currentGroupData.aiEnabled;
    }
    syncAllowMemberClearTagToggleState();
    updateAiControls();
    updateGroupActionButtons(isOwner);
    renderMembersList();
    renderGroupList();
  });

  socket.on('group_owner_transferred', ({ groupId, createdBy }) => {
    const group = groups.find((g) => g.id === groupId);
    if (group) group.createdBy = createdBy;
    if (groupId === currentGroupId && currentGroupData) {
      currentGroupData.createdBy = createdBy;
      const isOwner = currentGroupData.createdBy === currentUser.id;
      $('owner-actions').hidden = !isOwner;
      $('set-group-color-btn').hidden = !isOwner;
      updateGroupActionButtons(isOwner);
      renderMembersList();
    }
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
      delete unreadCounts[groupId];
      pushStatus.totalUnreadCount = syncUnreadIndicators();
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
    delete unreadCounts[groupId];
    pushStatus.totalUnreadCount = syncUnreadIndicators();
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
      renderProfileAiUsage();
      updateAiControls();
    }
    // Update avatars and sender names in visible message bubbles
    document.querySelectorAll('.msg-row[data-sender-id="' + CSS.escape(String(user.id)) + '"]').forEach(row => {
      const av = row.querySelector('.msg-avatar');
      if (av && user.username) renderAvatarElement(av, user);
      const nameEl = row.querySelector('.msg-sender-name');
      if (nameEl && user.username) nameEl.textContent = user.username;
    });
    if (!$('user-management-modal').hidden) void loadUserManagementSummary();
  });

  socket.on('user_deleted', ({ userId }) => {
    if (String(userId) === String(currentUser?.id)) {
      window.location.href = 'index.html';
      return;
    }
    if (!$('user-management-modal').hidden) void loadUserManagementSummary();
  });

  socket.on('account_deleted', ({ userId }) => {
    if (String(userId) !== String(currentUser?.id)) return;
    window.location.href = 'index.html';
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
    pendingDisappearingStartMessageIds = new Set();
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
      document.querySelectorAll('.modal-overlay:not([hidden])').forEach((m) => {
        if (m.id === 'grok-modal') {
          closeGrokModal();
          return;
        }
        m.hidden = true;
      });
      $('ctx-menu').hidden = true;
      $('emoji-picker').hidden = true;
      $('whisper-picker').hidden = true;
      $('slash-command-menu').hidden = true;
      // Close image viewer
      hideImageViewer();
      // Cancel reply
      replyingTo = null;
      $('reply-preview-bar').hidden = true;
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
  const whisperActive = messageMode === 'whisper' || !!composerTokens.whisper;
  if (whisperActive) {
    setElementIcon(btn, 'megaphone', { iconOnly: true });
    btn.classList.add('whisper-active');
    $('whisper-picker').hidden = !!composerTokens.whisper;
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
    { iconOnly: true, label: encryptionVisible ? 'Hide Encryption' : 'Show Encrypted' }
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
    const markdownSource = textEl.dataset.markdownSource;
    if (markdownSource != null) renderMarkdown(textEl, markdownSource);
    else renderPlainText(textEl, textEl.textContent);
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
    if (isDisappearingMessage(msg)) continue;
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

function resetGrokModalState() {
  grokResponseDraft = '';
  grokResponseModel = '';
  grokResponseMeta = null;
  grokRequestSource = 'panel';
  grokRequestHashtag = null;
  $('grok-prompt-input').value = '';
  $('grok-model-input').value = DEFAULT_AI_MODEL;
  $('grok-mode-input').value = '1';
  $('grok-tone-input').value = '0';
  $('grok-web-search-toggle').checked = false;
  $('grok-error').textContent = '';
  $('grok-status').textContent = '';
  $('grok-status').hidden = true;
  $('grok-response-wrap').hidden = true;
  renderPlainText($('grok-response'), '');
  $('grok-response').classList.remove('is-error');
  $('grok-response-model').textContent = '';
  $('grok-response-meta').replaceChildren();
  $('grok-response-meta').hidden = true;
  $('grok-copy-btn').disabled = true;
  $('grok-insert-btn').disabled = true;
  $('grok-submit-btn').textContent = 'Ask AI';
  $('grok-cancel-btn').disabled = false;
  $('grok-close-btn').disabled = false;
  syncAiModalSelectionUi();
  updateAskAiSubmitButton();
}

function getSelectedAiModel() {
  const selected = String($('grok-model-input').value || '').trim();
  return AI_MODEL_OPTIONS[selected] ? selected : DEFAULT_AI_MODEL;
}

function getSelectedAiMode() {
  return String($('grok-mode-input').value) === '0' ? 'fast' : 'thinking';
}

function getSelectedAiTone() {
  const value = String($('grok-tone-input').value);
  if (value === '1') return 'professional';
  if (value === '2') return 'playful';
  return 'casual';
}

function getSelectedAiWebSearchEnabled() {
  return !!$('grok-web-search-toggle').checked;
}

function syncAiModalSelectionUi() {
  const selectedModel = getSelectedAiModel();
  document.querySelectorAll('.grok-model-option').forEach((button) => {
    const isActive = button.dataset.model === selectedModel;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  const selectedMode = getSelectedAiMode();
  $('grok-mode-fast-label').classList.toggle('active', selectedMode === 'fast');
  $('grok-mode-thinking-label').classList.toggle('active', selectedMode === 'thinking');

  const selectedTone = getSelectedAiTone();
  $('grok-tone-casual-label').classList.toggle('active', selectedTone === 'casual');
  $('grok-tone-professional-label').classList.toggle('active', selectedTone === 'professional');
  $('grok-tone-playful-label').classList.toggle('active', selectedTone === 'playful');
}

function updateAskAiSubmitButton() {
  const hasPrompt = !!$('grok-prompt-input').value.trim();
  const hasSelections = !!AI_MODEL_OPTIONS[getSelectedAiModel()]
    && !!AI_MODE_LABELS[getSelectedAiMode()]
    && !!AI_TONE_LABELS[getSelectedAiTone()];
  $('grok-submit-btn').disabled = grokRequestInFlight || !hasPrompt || !hasSelections;
}

function setGrokBusy(isBusy, statusText = '') {
  grokRequestInFlight = !!isBusy;
  $('grok-submit-btn').textContent = isBusy ? 'Working…' : 'Ask AI';
  $('grok-cancel-btn').disabled = !!isBusy;
  $('grok-close-btn').disabled = !!isBusy;
  $('grok-copy-btn').disabled = isBusy || !grokResponseDraft;
  $('grok-insert-btn').disabled = isBusy || !grokResponseDraft;
  $('grok-status').textContent = statusText || '';
  $('grok-status').hidden = !statusText;
  updateAskAiSubmitButton();
}

function renderGrokResponseMeta(meta) {
  const metaEl = $('grok-response-meta');
  metaEl.replaceChildren();
  const display = buildAiMetaDisplay(meta);
  if (!display) {
    metaEl.hidden = true;
    return;
  }
  const info = document.createElement('span');
  info.className = 'msg-ai-meta-info';
  info.textContent = display.info;
  const stats = document.createElement('span');
  stats.className = 'msg-ai-meta-stats';
  stats.textContent = display.stats;
  metaEl.append(info, stats);
  metaEl.hidden = false;
}

function setGrokResponse(text, model = '', meta = null, { isError = false } = {}) {
  const response = $('grok-response');
  if (isError) renderPlainText(response, text || '');
  else renderMarkdown(response, text || '');
  response.classList.toggle('is-error', !!isError);
  $('grok-response-wrap').hidden = !text;
  $('grok-response-model').textContent = model ? getAiModelLabel(model) : '';
  renderGrokResponseMeta(meta);
  $('grok-copy-btn').disabled = !text || !!isError || grokRequestInFlight;
  $('grok-insert-btn').disabled = !text || !!isError || grokRequestInFlight;
}

function closeGrokModal() {
  if (grokRequestInFlight) return;
  $('grok-modal').hidden = true;
  resetGrokModalState();
  updateKeyState();
}

function openGrokModal(options = {}) {
  if (!currentGroupId || !currentGroupData) {
    showToast('Select a group first', 'error');
    return;
  }
  if (!canUseAiInCurrentGroup({ showError: true })) return;
  if (!getGroupKey(currentGroupId)) {
    showToast('Set group key first', 'error');
    return;
  }
  resetGrokModalState();
  grokRequestSource = options.source === 'chat' ? 'chat' : 'panel';
  grokRequestHashtag = normalizeHashtagTopic(options.hashtag || null);
  $('grok-group-name').textContent = currentGroupData.name;
  $('grok-prompt-input').value = String(options.prompt || '').trim();
  $('grok-modal').hidden = false;
  syncAiModalSelectionUi();
  updateAskAiSubmitButton();
  updateKeyState();
  $('grok-prompt-input').focus();
}

async function buildGrokContextMessages(groupId, options = {}) {
  const key = getGroupKey(groupId);
  if (!key) throw new Error('Set group key first');

  const normalizedTag = normalizeHashtagTopic(options.tagFilter || null);
  const snapshot = Array.isArray(options.sourceMessages) ? options.sourceMessages : allMessages;
  const sourceMessages = (snapshot || [])
    .filter((msg) => !normalizedTag || getMessageHashtagKey(msg) === normalizedTag)
    .slice(-GROK_CONTEXT_MESSAGE_LIMIT);
  const resolved = await Promise.all(sourceMessages.map(async (msg) => {
    if (!msg) return null;
    if (msg.type === 'whisper' || msg.type === 'image' || msg.type === 'file' || isDisappearingMessage(msg)) return null;

    let content = '';
    const plaintext = await decryptMessage(msg.encryptedContent, msg.iv, key, groupId);
    if (!plaintext) return null;
    content = plaintext.trim();
    if (!content) return null;

    const hashtag = getMessageHashtagKey(msg);

    return {
      senderName: msg.senderName || 'Unknown',
      createdAt: msg.createdAt || '',
      content,
      type: msg.type || 'text',
      hashtag: hashtag || null,
      isDisappearing: !!msg.isDisappearing,
    };
  }));

  const compact = [];
  let remaining = GROK_CONTEXT_TOTAL_CHARS;
  for (let i = resolved.length - 1; i >= 0; i -= 1) {
    const entry = resolved[i];
    if (!entry || !entry.content) continue;
    if (remaining <= 0) break;
    const text = String(entry.content).trim();
    if (!text) continue;
    const trimmedContent = text.length > remaining ? text.slice(0, remaining) : text;
    compact.push({ ...entry, content: trimmedContent });
    remaining -= trimmedContent.length;
  }
  compact.reverse();
  return compact;
}

async function requestAiResponse(groupId, options = {}) {
  const mode = options.mode || DEFAULT_AI_MODE;
  const model = options.model || DEFAULT_AI_MODEL;
  const tone = options.tone || DEFAULT_AI_TONE;
  const webSearchEnabled = !!options.webSearchEnabled;
  const contextMessages = mode === 'thinking'
    ? await buildGrokContextMessages(groupId, {
      sourceMessages: options.sourceMessages,
      tagFilter: options.tagFilter || null,
    })
    : [];
  if (!options.skipBusyUi) {
    const modelLabel = getAiModelLabel(model);
    const modeLabel = getAiModeLabel(mode);
    setGrokBusy(true, mode === 'thinking'
      ? (contextMessages.length
        ? `Asking ${modelLabel} in ${modeLabel} mode…`
        : `Asking ${modelLabel} in ${modeLabel} mode without chat context…`)
      : `Asking ${modelLabel} in ${modeLabel} mode…`);
  }
  const res = await fetch(`/api/groups/${groupId}/ai/chat`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      groupName: options.groupName,
      prompt: options.prompt,
      contextMessages,
      model,
      mode,
      tone,
      webSearchEnabled,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'AI request failed');
  return {
    answer: String(data.answer || '').trim(),
    model: String(data.model || model),
    aiMeta: normalizeAiMeta(data.aiMeta),
    aiUsage: data.aiUsage || null,
  };
}

async function sendAiReplyInBackground(request) {
  try {
    const result = await requestAiResponse(request.groupId, {
      groupName: request.groupName,
      prompt: request.prompt,
      model: request.model,
      mode: request.mode,
      tone: request.tone,
      webSearchEnabled: request.webSearchEnabled,
      tagFilter: request.tagFilter,
      sourceMessages: request.sourceMessages,
      skipBusyUi: true,
    });
    if (!result.answer) throw new Error('AI returned an empty response');
    if (result.aiUsage) setAiUsageSummary(result.aiUsage);

    const { encryptedContent, iv } = await encryptMessage(result.answer, request.key, request.groupId);
    if (estimateBase64Bytes(encryptedContent) > MAX_TEXT_MESSAGE_BYTES) {
      throw new Error('AI response is too large to send');
    }

    await emitSocketWithAck('send_ai_message', {
      groupId: request.groupId,
      encryptedContent,
      iv,
      replyTo: request.replyToData,
      hashtag: request.tagFilter || null,
      aiMeta: result.aiMeta,
    });
    showToast('AI reply sent', 'success');
  } catch (err) {
    const message = String(err && err.message ? err.message : 'AI request failed');
    if (/daily AI token limit/i.test(message) || /global daily AI token limit/i.test(message)) {
      void refreshAiUsageSummary();
    }
    showToast(message, 'error');
  }
}

async function submitGrokPrompt() {
  if (grokRequestInFlight || !currentGroupId || !currentGroupData) return;
  if (!canUseAiInCurrentGroup()) {
    $('grok-error').textContent = getAiQuotaBlockedMessage() || getAiDisabledMessage();
    return;
  }
  const prompt = $('grok-prompt-input').value.trim();
  if (!prompt) {
    $('grok-error').textContent = 'Prompt cannot be empty';
    updateAskAiSubmitButton();
    return;
  }

  const groupId = currentGroupId;
  const groupName = currentGroupData.name;
  const sourceMessagesSnapshot = [...allMessages];
  const requestSource = grokRequestSource;
  const model = getSelectedAiModel();
  const mode = getSelectedAiMode();
  const tone = getSelectedAiTone();
  const webSearchEnabled = getSelectedAiWebSearchEnabled();
  const tagFilter = grokRequestHashtag || null;
  grokResponseDraft = '';
  grokResponseModel = '';
  grokResponseMeta = null;
  $('grok-error').textContent = '';
  setGrokResponse('', '', null);
  setGrokBusy(true, 'Preparing AI message…');

  try {
    const key = getGroupKey(groupId);
    if (!key) throw new Error('Set group key first');

    let replyToData = null;
    if (replyingTo) {
      replyToData = JSON.stringify({
        id: replyingTo.id,
        senderName: replyingTo.senderName,
        preview: replyingTo.preview,
      });
    }

    const { encryptedContent: promptEncryptedContent, iv: promptIv } = await encryptMessage(prompt, key, groupId);
    if (estimateBase64Bytes(promptEncryptedContent) > MAX_TEXT_MESSAGE_BYTES) {
      throw new Error('Message too large');
    }

    await emitSocketWithAck('send_message', {
      groupId,
      encryptedContent: promptEncryptedContent,
      iv: promptIv,
      replyTo: replyToData,
      hashtag: tagFilter,
      isDisappearing: false,
      disappearingDurationMs: 0,
      aiMention: true,
      aiMeta: { model, mode, tone, webSearchEnabled },
    });

    resetComposerAfterSend();
    setGrokBusy(false);
    closeGrokModal();
    showToast('AI request sent', 'success');

    if (requestSource === 'chat') {
      void sendAiReplyInBackground({
        groupId,
        groupName,
        prompt,
        model,
        mode,
        tone,
        webSearchEnabled,
        tagFilter,
        sourceMessages: sourceMessagesSnapshot,
        replyToData,
        key,
      });
      return;
    }

    const result = await requestAiResponse(groupId, {
      groupName,
      prompt,
      model,
      mode,
      tone,
      webSearchEnabled,
      tagFilter,
      sourceMessages: sourceMessagesSnapshot,
    });
    if (!result.answer) throw new Error('AI returned an empty response');
    if (result.aiUsage) setAiUsageSummary(result.aiUsage);
    grokResponseDraft = result.answer;
    grokResponseModel = result.model;
    grokResponseMeta = result.aiMeta;
    setGrokResponse(grokResponseDraft, grokResponseModel, grokResponseMeta);
    showToast('AI response ready', 'success');
  } catch (err) {
    const message = String(err && err.message ? err.message : 'AI request failed');
    $('grok-error').textContent = message;
    if (/daily AI token limit/i.test(message) || /global daily AI token limit/i.test(message)) {
      void refreshAiUsageSummary();
    }
    if (requestSource === 'panel') setGrokResponse(message, '', null, { isError: true });
    else showToast(message, 'error');
  } finally {
    setGrokBusy(false);
  }
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
  $('wallpaper-modal').addEventListener('click', (e) => {
    if (e.target !== $('wallpaper-modal')) return;
    $('wallpaper-modal').hidden = true;
    resetWallpaperDraft();
  });
  $('wallpaper-save-btn').addEventListener('click', saveWallpaperDraft);
  $('wallpaper-reset-btn').addEventListener('click', async () => {
    const previousWallpaperSettings = getWallpaperSettings(appLocalSettings);
    appLocalSettings.wallpaperDataUrl = null;
    appLocalSettings.wallpaperBlur = DEFAULT_WALLPAPER_BLUR;
    appLocalSettings.wallpaperTransparency = DEFAULT_WALLPAPER_TRANSPARENCY;
    applyWallpaperFromSettings();
    writeLocalSettings(appLocalSettings, currentUser && currentUser.id);
    const result = await saveSettingsToServer();
    if (!result.ok && !result.networkError) {
      appLocalSettings.wallpaperDataUrl = previousWallpaperSettings.wallpaperDataUrl || null;
      appLocalSettings.wallpaperBlur = previousWallpaperSettings.wallpaperBlur;
      appLocalSettings.wallpaperTransparency = previousWallpaperSettings.wallpaperTransparency;
      applyWallpaperFromSettings();
      writeLocalSettings(appLocalSettings, currentUser && currentUser.id);
      $('wallpaper-error').textContent = result.error || 'Failed to reset wallpaper';
      return;
    }
    $('wallpaper-modal').hidden = true;
    resetWallpaperDraft();
    showToast(result.ok ? WALLPAPER_RESET_SUCCESS_MSG : WALLPAPER_RESET_SYNC_FAIL_MSG, result.ok ? 'success' : 'info');
  });
  $('wallpaper-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('wallpaper-error').textContent = '';
    wallpaperDraft = buildWallpaperDraft({ wallpaperDataUrl: null });
    resetWallpaperProgress();
    if (!isAllowedUploadImageType(file.type)) {
      $('wallpaper-error').textContent = 'Please choose a JPEG, PNG, GIF, or WebP image';
      setWallpaperSaveState(false);
      return;
    }
    if (file.size > MAX_WALLPAPER_BYTES) {
      $('wallpaper-error').textContent = WALLPAPER_TOO_LARGE_MSG;
      setWallpaperSaveState(false);
      return;
    }
    setWallpaperSaveState(false);
    try {
      setWallpaperProgress(3, 'Preparing wallpaper…');
      const preparedFile = await prepareWallpaperFile(file);
      wallpaperDraft.wallpaperDataUrl = await readFileAsDataUrl(preparedFile, {
        onProgress: (event) => {
          if (!event.lengthComputable) return;
          const percent = Math.round((event.loaded / event.total) * 100);
          setWallpaperProgress(percent, `Reading wallpaper… ${percent}%`);
        },
      });
      setWallpaperProgress(100, 'Ready to save');
      applyWallpaperDraftPreview(wallpaperDraft.wallpaperDataUrl);
      setWallpaperSaveState(!wallpaperSettingsEqual(wallpaperDraft, appLocalSettings));
    } catch {
      wallpaperDraft.wallpaperDataUrl = null;
      $('wallpaper-error').textContent = WALLPAPER_READ_FAIL_MSG;
      resetWallpaperProgress();
      setWallpaperSaveState(false);
    }
  });
  $('wallpaper-blur-input').addEventListener('input', (e) => {
    const maxWallpaperBlur = wallpaperTheme ? wallpaperTheme.MAX_WALLPAPER_BLUR : 24;
    wallpaperDraft = buildWallpaperDraft({
      wallpaperBlur: clampInteger(e.target.value, DEFAULT_WALLPAPER_BLUR, maxWallpaperBlur, DEFAULT_WALLPAPER_BLUR),
    });
    applyWallpaperDraftPreview();
    setWallpaperSaveState(!wallpaperSettingsEqual(wallpaperDraft, appLocalSettings));
  });
  $('wallpaper-transparency-input').addEventListener('input', (e) => {
    wallpaperDraft = buildWallpaperDraft({
      wallpaperTransparency: clampInteger(e.target.value, 0, 100, DEFAULT_WALLPAPER_TRANSPARENCY),
    });
    applyWallpaperDraftPreview();
    setWallpaperSaveState(!wallpaperSettingsEqual(wallpaperDraft, appLocalSettings));
  });

  $('user-list-btn').addEventListener('click', async () => {
    $('user-management-error').textContent = '';
    setUserManagementLoading();
    $('user-management-modal').hidden = false;
    await loadUserManagementSummary();
  });
  $('user-management-close-btn').addEventListener('click', () => { $('user-management-modal').hidden = true; });
  $('user-management-modal').addEventListener('click', (e) => {
    if (e.target !== $('user-management-modal')) return;
    $('user-management-modal').hidden = true;
  });
  $('user-management-global-limit-save').addEventListener('click', async () => {
    const res = await fetch('/api/ai/global-limit', {
      method: 'PATCH',
      headers: apiHeaders(),
      body: JSON.stringify({ dailyLimit: $('user-management-global-limit-input').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('user-management-error').textContent = data.error || 'Failed to save global limit';
      return;
    }
    await Promise.all([loadUserManagementSummary(), refreshAiUsageSummary()]);
  });

  // Profile modal
  $('sidebar-user-btn').addEventListener('click', () => {
    void refreshAiUsageSummary();
    void loadPushStatus();
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
    renderProfileAiUsage();
    renderPushSettings();
    $('profile-modal').hidden = false;
  });
  $('profile-close-btn').addEventListener('click', () => $('profile-modal').hidden = true);
  $('enable-push-btn').addEventListener('click', () => { void enablePushNotifications(); });
  $('disable-push-btn').addEventListener('click', () => { void disablePushNotifications(); });

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
    updateAiControls();
    if (!$('user-management-modal').hidden) void loadUserManagementSummary();
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
    if (!$('user-management-modal').hidden) void loadUserManagementSummary();
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
    if (!isAllowedUploadImageType(file.type)) {
      $('profile-error').textContent = 'Only JPEG, PNG, GIF, and WebP images are supported';
      return;
    }
    if (file.size > MAX_PROFILE_PICTURE_BYTES) {
      $('profile-error').textContent = PROFILE_PICTURE_TOO_LARGE_MSG;
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      $('profile-error').textContent = 'Failed to read the selected image. Please try a different file.';
    };
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
    if (!isAllowedUploadImageType(file.type)) {
      $('profile-error').textContent = 'Only JPEG, PNG, GIF, and WebP images are supported';
      return;
    }
    if (file.size > MAX_PROFILE_PICTURE_BYTES) {
      $('profile-error').textContent = PROFILE_PICTURE_TOO_LARGE_MSG;
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => {
      $('profile-error').textContent = 'Failed to read the selected image. Please try a different file.';
    };
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
      if (!$('user-management-modal').hidden) void loadUserManagementSummary();
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
    if (!$('user-management-modal').hidden) void loadUserManagementSummary();
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
    unreadCounts[d.id] = Math.max(0, Number(d.unreadCount) || 0);
    renderGroupList();
    syncUnreadIndicators();
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
  $('clear-cache-btn').addEventListener('click', () => {
    showConfirm(
      'Clear Cache and Restart',
      'This will clear local cache and restart GChat. Stored group keys will be kept. Continue?',
      async () => {
        await clearCacheAndRestartApp();
      }
    );
  });
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
    if (!groups.find(g => g.id === d.id)) {
      groups.unshift(d);
      unreadCounts[d.id] = Math.max(0, Number(d.unreadCount) || 0);
      renderGroupList();
      syncUnreadIndicators();
    }
    await selectGroup(d.id);
    addSystemMessage('You joined "' + d.name + '".');
  });

  // Set group key
  $('set-key-btn').addEventListener('click', () => {
    $('group-key-input').value = currentGroupId ? (getGroupKey(currentGroupId) || '') : '';
    $('group-key-error').textContent = '';
    $('group-key-modal').hidden = false;
  });
  $('ask-grok-btn').addEventListener('click', () => openGrokModal({ source: 'chat' }));
  $('grok-close-btn').addEventListener('click', closeGrokModal);
  $('grok-cancel-btn').addEventListener('click', closeGrokModal);
  $('grok-modal').addEventListener('click', (e) => {
    if (e.target !== $('grok-modal')) return;
    closeGrokModal();
  });
  document.querySelectorAll('.grok-model-option').forEach((button) => {
    button.addEventListener('click', () => {
      $('grok-model-input').value = button.dataset.model || DEFAULT_AI_MODEL;
      syncAiModalSelectionUi();
      updateAskAiSubmitButton();
    });
  });
  $('grok-submit-btn').addEventListener('click', () => { void submitGrokPrompt(); });
  $('grok-prompt-input').addEventListener('input', updateAskAiSubmitButton);
  $('grok-mode-input').addEventListener('input', () => {
    syncAiModalSelectionUi();
    updateAskAiSubmitButton();
  });
  $('grok-tone-input').addEventListener('input', () => {
    syncAiModalSelectionUi();
    updateAskAiSubmitButton();
  });
  $('grok-prompt-input').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void submitGrokPrompt();
    }
  });
  $('grok-copy-btn').addEventListener('click', async () => {
    if (!grokResponseDraft) return;
    try {
      await navigator.clipboard.writeText(grokResponseDraft);
      showToast('Copied to clipboard', 'success');
    } catch {
      showToast('Failed to copy response', 'error');
    }
  });
  $('grok-insert-btn').addEventListener('click', () => {
    if (!grokResponseDraft) return;
    const input = $('message-input');
    if (!input || !getGroupKey(currentGroupId)) {
      showToast('Set group key first', 'error');
      return;
    }
    input.value = input.value
      ? `${input.value.trimEnd()}\n\n${grokResponseDraft}`
      : grokResponseDraft;
    autoResizeTextarea(input);
    closeGrokModal();
    if (!input.disabled) input.focus();
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
    const nextChecked = e.target.checked;
    const result = await updateGroupSettingRequest({ allowMemberClear: nextChecked });
    if (!result.ok) {
      e.target.checked = !nextChecked;
      syncAllowMemberClearTagToggleState();
      showToast(result.error || 'Failed to update group settings', 'error');
      return;
    }
    if (currentGroupData) {
      currentGroupData.allowMemberClear = e.target.checked;
      if (e.target.checked) currentGroupData.allowMemberClearTag = true;
      syncAllowMemberClearTagToggleState();
      updateGroupActionButtons(currentGroupData.createdBy === currentUser.id);
    }
  });

  $('allow-member-clear-tag-toggle').addEventListener('change', async (e) => {
    const nextChecked = e.target.checked;
    const result = await updateGroupSettingRequest({ allowMemberClearTag: nextChecked });
    if (!result.ok) {
      e.target.checked = !nextChecked;
      syncAllowMemberClearTagToggleState();
      showToast(result.error || 'Failed to update group settings', 'error');
      return;
    }
    if (currentGroupData) {
      currentGroupData.allowMemberClearTag = nextChecked;
      syncAllowMemberClearTagToggleState();
      updateGroupActionButtons(currentGroupData.createdBy === currentUser.id);
    }
  });

  $('allow-member-export-toggle').addEventListener('change', async (e) => {
    const nextChecked = e.target.checked;
    const result = await updateGroupSettingRequest({ allowMemberExport: nextChecked });
    if (!result.ok) {
      e.target.checked = !nextChecked;
      showToast(result.error || 'Failed to update group settings', 'error');
      return;
    }
    if (currentGroupData) {
      currentGroupData.allowMemberExport = e.target.checked;
      updateGroupActionButtons(currentGroupData.createdBy === currentUser.id);
    }
  });

  $('allow-member-kick-toggle').addEventListener('change', async (e) => {
    const nextChecked = e.target.checked;
    const result = await updateGroupSettingRequest({ allowMemberKick: nextChecked });
    if (!result.ok) {
      e.target.checked = !nextChecked;
      showToast(result.error || 'Failed to update group settings', 'error');
      return;
    }
    if (currentGroupData) {
      currentGroupData.allowMemberKick = e.target.checked;
    }
  });

  $('ai-mode-toggle').addEventListener('change', async (e) => {
    const nextChecked = e.target.checked;
    const result = await updateGroupSettingRequest({ aiEnabled: nextChecked });
    if (!result.ok) {
      e.target.checked = !nextChecked;
      showToast(result.error || 'Failed to update group settings', 'error');
      return;
    }
    if (currentGroupData) currentGroupData.aiEnabled = nextChecked;
    updateAiControls();
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
        delete unreadCounts[currentGroupId];
        groups = groups.filter(g => g.id !== currentGroupId);
        pushStatus.totalUnreadCount = syncUnreadIndicators();
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

  $('tag-ctx-delete').addEventListener('click', () => {
    if (!ctxTagTopic || !canCurrentUserClearTag()) return;
    const topic = ctxTagTopic;
    hideTagContextMenu();
    showConfirm(
      `Delete ${formatHashtagLabel(topic)}`,
      `This will permanently delete every ${formatHashtagLabel(topic)} message for everyone. Continue?`,
      async () => {
        await clearTagMessages(topic);
      }
    );
  });

  document.addEventListener('click', (e) => {
    if (!$('ctx-menu').contains(e.target)) hideContextMenu();
    if (!$('tag-ctx-menu').contains(e.target)) hideTagContextMenu();
    if (!$('emoji-picker').contains(e.target) && e.target !== $('emoji-btn')) {
      $('emoji-picker').hidden = true;
    }
    if (!$('slash-command-menu').contains(e.target) && e.target !== $('message-input')) {
      $('slash-command-menu').hidden = true;
    }
  });

  // Reply cancel
  $('reply-cancel-btn').addEventListener('click', () => {
    replyingTo = null;
    $('reply-preview-bar').hidden = true;
  });

  // Message input
  const msgInput = $('message-input');

  document.querySelectorAll('.slash-command-item').forEach((item) => {
    item.addEventListener('click', () => {
      if ((item.dataset.command || '') === '/ai ') {
        msgInput.value = '';
        syncComposerTokens();
        updateSlashCommandMenu();
        autoResizeTextarea(msgInput);
        openGrokModal({
          source: 'chat',
          hashtag: composerTokens.hashtag ? composerTokens.hashtag.topic : null,
        });
        return;
      }
      msgInput.value = item.dataset.command || '/';
      msgInput.focus();
      msgInput.selectionStart = msgInput.selectionEnd = msgInput.value.length;
      updateSlashCommandMenu();
      autoResizeTextarea(msgInput);
    });
  });

  msgInput.addEventListener('input', () => {
    maybeTokenizeSlashCommand(msgInput);
    syncComposerTokens();
    updateSlashCommandMenu();
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
    if (e.key === 'Backspace' && handleComposerBackspace(msgInput)) {
      e.preventDefault();
      return;
    }
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
    if (composerTokens.hashtag) {
      showToast('Tags cannot be combined with whispers', 'error');
      return;
    }
    if (composerTokens.whisper) {
      clearWhisperToken();
      syncComposerTokens();
      updateSlashCommandMenu();
    } else {
      messageMode = messageMode === 'normal' ? 'whisper' : 'normal';
      if (messageMode !== 'whisper') whisperRecipients = [];
    }
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
    const rawMsgs = await res.json();
    const msgs = rawMsgs.filter((msg) => !isMessageHiddenForCurrentUser(msg));
    if (!rawMsgs.length) {
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
    oldestMessageId = rawMsgs[0].id;
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
