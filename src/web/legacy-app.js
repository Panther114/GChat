'use strict';

import * as GChatCryptoV2 from './crypto-v2.js';

// ── Crypto Helpers ───────────────────────────────────────────────────────────

// Cache derived keys to avoid running 100 000 PBKDF2 iterations for every
// individual message encrypt/decrypt operation (#21).
// Cap size to prevent unbounded memory growth in long-lived tabs.
const derivedKeyCache = new Map(); // `${passphrase}\x00${groupId}` -> CryptoKey
const DERIVED_KEY_CACHE_MAX = 64;

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
  // Evict oldest entry when cache is full (simple FIFO eviction)
  if (derivedKeyCache.size >= DERIVED_KEY_CACHE_MAX) {
    const firstKey = derivedKeyCache.keys().next().value;
    derivedKeyCache.delete(firstKey);
  }
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
let aiFeatureEnabled = false;
let hostedAppUpdateTimer = null;
let hostedAppReloadPending = false;
const HOSTED_APP_UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const MESSAGE_VIEW_BASE_DELAY_MS = 2200;
const MESSAGE_VIEW_PER_CHAR_MS = 200;
const MESSAGE_VIEW_MAX_DELAY_MS = 18000;
const MIN_DISAPPEARING_DURATION_MS = 3000;
const DISAPPEARING_DURATION_PER_CHAR_MS = 90;
const MAX_DISAPPEARING_DURATION_MS = 22500;
function buildAuthRedirectUrl() { return 'index.html'; }
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

// ── Per-group encryption secret resolution ───────────────────────────────────
const groupKeyVaultCache = new Map();
for (let index = localStorage.length - 1; index >= 0; index -= 1) {
  const key = localStorage.key(index);
  if (key?.startsWith('gk:')) localStorage.removeItem(key);
}

function getGroupKey(groupId) {
  const normalizedGroupId = String(groupId || '');
  if (!normalizedGroupId) return null;
  return groupKeyVaultCache.get(normalizedGroupId)?.secret || null;
}

async function loadGroupKeyVaultEntries() {
  const groupsById = new Map(groups.map((group) => [String(group.id), group]));
  const localEntries = await Promise.all(groups.map(async (group) => {
    try {
      return [group, await GChatCryptoV2.keyVault.get(group.id)];
    } catch {
      return [group, null];
    }
  }));
  for (const [group, entry] of localEntries) {
    if (!entry?.secret) continue;
    const normalizedEntry = { ...entry, groupId: String(group.id) };
    groupKeyVaultCache.set(String(group.id), normalizedEntry);
  }

  try {
    const response = await fetch('/api/groups/keys', { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    const recoveredEntries = Array.isArray(payload?.keys) ? payload.keys : [];
    for (const recovered of recoveredEntries) {
      const groupId = String(recovered?.groupId || '');
      const group = groupsById.get(groupId);
      if (!group || typeof recovered?.secret !== 'string' || typeof recovered?.joinCode !== 'string') continue;
      const commitment = await GChatCryptoV2.keyCommitment(recovered.secret);
      if (commitment !== group.keyCommitment) continue;
      const entry = { groupId, secret: recovered.secret, joinCode: recovered.joinCode };
      await GChatCryptoV2.keyVault.put(entry);
      groupKeyVaultCache.set(groupId, entry);
    }
  } catch {
    // A local vault entry remains usable if key recovery is temporarily unavailable.
  }
}

function v2Aad(msg, revision = msg.revision || 1) {
  return GChatCryptoV2.messageAad({
    groupId: msg.groupId || currentGroupId,
    id: msg.id,
    senderId: msg.senderId,
    type: msg.type || 'text',
    keyVersion: msg.keyVersion || 1,
    revision,
  });
}

async function encryptV2Message(text, metadata, msg, secret) {
  const aad = v2Aad(msg);
  const content = await GChatCryptoV2.encryptJson({ text }, secret, msg.groupId, 'content', aad);
  const encryptedMetadata = await GChatCryptoV2.encryptJson(metadata || {}, secret, msg.groupId, 'metadata', aad);
  return {
    encryptedContent: content.encryptedContent,
    iv: content.iv,
    encryptedMetadata: encryptedMetadata.encryptedContent,
    metadataIv: encryptedMetadata.iv,
  };
}

async function decryptV2Message(msg, secret, groupId) {
  const normalized = { ...msg, groupId: msg.groupId || groupId };
  const content = await GChatCryptoV2.decryptJson(msg.encryptedContent, msg.iv, secret, groupId, 'content', v2Aad(normalized));
  if (msg.encryptedMetadata && msg.metadataIv) {
    const metadata = await GChatCryptoV2.decryptJson(msg.encryptedMetadata, msg.metadataIv, secret, groupId, 'metadata', v2Aad(normalized));
    Object.assign(msg, metadata);
  }
  return content.text;
}

async function decryptMessageText(msg, secret, groupId = currentGroupId) {
  if (!secret) return null;
  const version = Number(msg.encryptionVersion);
  // Prefer the declared path, then fall back so mis-tagged / mixed-era history still recovers.
  if (version === 2) {
    try {
      const v2 = await decryptV2Message(msg, secret, groupId);
      if (v2 != null) return v2;
    } catch {
      /* try legacy path below */
    }
    return decryptMessage(msg.encryptedContent, msg.iv, secret, groupId);
  }
  const v1 = await decryptMessage(msg.encryptedContent, msg.iv, secret, groupId);
  if (v1 != null) return v1;
  // Ambiguous or missing encryptionVersion: attempt v2 as a recovery path.
  try {
    return await decryptV2Message(msg, secret, groupId);
  } catch {
    return null;
  }
}

async function decryptAttachmentBytes(msg, secret, groupId) {
  const version = Number(msg.encryptionVersion);
  if (version === 2) {
    try {
      const bytes = GChatCryptoV2.base64UrlToBytes(msg.encryptedContent);
      return await GChatCryptoV2.decryptBytes(bytes, msg.iv, secret, groupId, v2Aad({ ...msg, groupId }));
    } catch {
      return decryptBytes(msg.encryptedContent, msg.iv, secret, groupId);
    }
  }
  const legacy = await decryptBytes(msg.encryptedContent, msg.iv, secret, groupId);
  if (legacy != null) return legacy;
  try {
    const bytes = GChatCryptoV2.base64UrlToBytes(msg.encryptedContent);
    return await GChatCryptoV2.decryptBytes(bytes, msg.iv, secret, groupId, v2Aad({ ...msg, groupId }));
  } catch {
    return null;
  }
}

// Keep only long-lived user essentials across a local reset: legacy group keys
// plus the current/legacy wallpaper and other per-user local settings payloads.
function shouldPreserveLocalStorageEntry(key) {
  return !!(
    key
    && (
      key === ACTIVE_LOCAL_SETTINGS_KEY
      || key === LEGACY_LOCAL_SETTINGS_KEY
      || key.startsWith(LOCAL_SETTINGS_KEY_PREFIX)
    )
  );
}

function capturePreservedLocalStorageEntries() {
  const entries = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!shouldPreserveLocalStorageEntry(key)) continue;
      entries.push([key, localStorage.getItem(key)]);
    }
  } catch {
    return [];
  }
  return entries;
}

function clearAccessibleCookies() {
  if (typeof document === 'undefined') return;
  const rawCookies = typeof document.cookie === 'string' ? document.cookie : '';
  if (!rawCookies) return;
  const hostname = window.location.hostname || '';
  const domainParts = hostname.split('.').filter(Boolean);
  const domains = [''];
  // Also try parent domains so cookies set on `.example.com` are cleared from
  // subdomains such as `app.example.com`.
  for (let i = 0; i < domainParts.length - 1; i += 1) {
    domains.push('.' + domainParts.slice(i).join('.'));
  }
  for (const cookie of rawCookies.split(';')) {
    const [namePart] = cookie.split('=');
    const cookieName = namePart ? namePart.trim() : '';
    if (!cookieName || PRESERVED_COOKIE_NAMES.has(cookieName)) continue;
    document.cookie = `${cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    for (const domain of domains) {
      if (!domain) continue;
      document.cookie = `${cookieName}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${domain}`;
    }
  }
}

function deleteIndexedDbDatabase(name) {
  return new Promise((resolve) => {
    if (!name) {
      resolve();
      return;
    }
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function clearIndexedDbDatabases() {
  if (!('indexedDB' in window) || typeof indexedDB.deleteDatabase !== 'function') return;
  if (typeof indexedDB.databases !== 'function') return;
  try {
    const databases = await indexedDB.databases();
    await Promise.allSettled((databases || []).map((database) => {
      const name = typeof database?.name === 'string' ? database.name : '';
      return deleteIndexedDbDatabase(name);
    }));
  } catch {
    // best effort only
  }
}

function getVisibleWhisperRecipientIds(msg) {
  if (!msg || msg.type !== 'whisper') return [];
  if (!msg.whisperTo) return [];
  try {
    const parsed = JSON.parse(msg.whisperTo);
    return Array.isArray(parsed) ? parsed.map((id) => String(id)) : [];
  } catch {
    // Keep older cached payloads readable if they still store whisper IDs as CSV.
    return String(msg.whisperTo)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }
}

function canCurrentUserAccessMessage(msg, userId = currentUser?.id) {
  if (!msg || !userId) return false;
  if (msg.senderId === userId) return true;
  if (msg.type !== 'whisper') return true;
  return getVisibleWhisperRecipientIds(msg).includes(String(userId));
}

function filterMessagesVisibleToCurrentUser(messages = [], userId = currentUser?.id) {
  return (messages || []).filter((msg) => canCurrentUserAccessMessage(msg, userId) && !isMessageHiddenForCurrentUser(msg));
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
  'grok-4-1-fast-non-reasoning': '/grok.webp',
};
const AI_MODEL_TAGS = {
  'deepseek/deepseek-v4-flash': 'deepseek',
  'grok-4-1-fast-non-reasoning': 'grok',
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
  'grok-4-1-fast-non-reasoning': 'Grok 4.1 Fast',
};
const DEFAULT_AI_MODEL = 'grok-4-1-fast-non-reasoning';
const AI_MODE_LABELS = {
  fast: 'Context-less',
  thinking: 'Context',
};
const DEFAULT_AI_MODE = 'fast';
let AI_TONE_LABELS = {
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
  month: 'numeric',
  day: 'numeric',
});
const DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY = 'gchat:desktop-sidebar-width';
const DESKTOP_RIGHT_PANEL_STORAGE_KEY = 'gchat:desktop-right-panel-expanded';
const DESKTOP_DEFAULT_SIDEBAR_WIDTH = 260;
// Keeps the desktop minimum near 60% of the old 220px floor while still fitting the icon and refresh control.
// Min width ≈ bottom bar: avatar + theme + logout (+ padding/gaps). Labels may collapse.
const DESKTOP_MIN_SIDEBAR_WIDTH = 104;
const DESKTOP_BRAND_ONLY_SIDEBAR_WIDTH = 140;
const DESKTOP_ICON_ONLY_SIDEBAR_WIDTH = 120;
/** Below this, New Group / Join Group collapse to icon-only so labels are not clipped. */
const DESKTOP_ACTIONS_ICON_SIDEBAR_WIDTH = 180;
/** Hide brand refresh control early so it never clips as a half-icon. */
const DESKTOP_HIDE_CACHE_BTN_WIDTH = 220;
const GENERIC_NOTIFICATION_TITLE = 'GChat';
const GENERIC_NOTIFICATION_FALLBACK_BODY = 'You have unread messages in GChat.';
const PUSH_NOTIFICATION_TAG = 'gchat-unread';
const APP_BADGE_UNSUPPORTED = Symbol('app-badge-unsupported');
const PRESERVED_COOKIE_NAMES = new Set(['connect.sid', '__Host-connect.sid', '__Secure-connect.sid']);

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
      // Bound the localStorage mirror to the newest window; full history lives
      // in the IndexedDB history store (historyStore* helpers below).
      messages: getCacheableMessages(cache.messages || []).slice(-MAX_CACHED_MESSAGES_PER_GROUP),
      members: cache.members || [],
      oldestMessageId: cache.oldestMessageId || null,
      updatedAt: Date.now(),
    }));
  } catch {
    // best effort only
  }
}

// ── Durable history store (IndexedDB) ────────────────────────────────────────
// Per-group encrypted message history plus a forward sync cursor. This is the
// stable local history layer: it survives reloads, reconnects, and localStorage
// pressure, and it enables cheap incremental (`since`) syncs from the server.
const HISTORY_DB_NAME = 'gchat-history-v1';
const HISTORY_DB_VERSION = 1;
const HISTORY_MESSAGES_STORE = 'messages';
const HISTORY_META_STORE = 'meta';
const HISTORY_MAX_MESSAGES_PER_GROUP = 2000;
let historyDbPromise = null;
let historyDbSupported = typeof indexedDB !== 'undefined';

function openHistoryDb() {
  if (!historyDbSupported) return Promise.resolve(null);
  if (historyDbPromise) return historyDbPromise;
  historyDbPromise = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
    } catch {
      historyDbSupported = false;
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HISTORY_MESSAGES_STORE)) {
        const store = db.createObjectStore(HISTORY_MESSAGES_STORE, { keyPath: 'id' });
        store.createIndex('groupId', 'groupId', { unique: false });
      }
      if (!db.objectStoreNames.contains(HISTORY_META_STORE)) {
        db.createObjectStore(HISTORY_META_STORE, { keyPath: 'groupId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      historyDbSupported = false;
      resolve(null);
    };
    request.onblocked = () => {
      historyDbSupported = false;
      resolve(null);
    };
  });
  return historyDbPromise;
}

function runHistoryStore(storeName, mode, worker) {
  return openHistoryDb().then((db) => {
    if (!db) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = db.transaction(storeName, mode);
      } catch (error) {
        reject(error);
        return;
      }
      const store = transaction.objectStore(storeName);
      let result;
      try {
        result = worker(store);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error('history store error'));
      transaction.onabort = () => reject(transaction.error || new Error('history store aborted'));
    });
  }).catch(() => null);
}

function persistHistoryMessages(groupId, messages) {
  if (!messages || !messages.length) return Promise.resolve();
  const cacheable = getCacheableMessages(messages);
  return runHistoryStore(HISTORY_MESSAGES_STORE, 'readwrite', (store) => {
    for (const msg of cacheable) {
      store.put({ id: String(msg.id), groupId: String(groupId), createdAt: msg.createdAt || '', msg });
    }
  });
}

function readHistoryMessages(groupId) {
  return runHistoryStore(HISTORY_MESSAGES_STORE, 'readonly', (store) => {
    const request = store.index('groupId').getAll(String(groupId));
    request.onsuccess = () => {
      const rows = request.result || [];
      const messages = rows
        .map((row) => row.msg)
        .filter(Boolean)
        .sort((a, b) => {
          const timeDiff = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
          return timeDiff !== 0 ? timeDiff : String(a.id).localeCompare(String(b.id));
        });
      if (messages.length > HISTORY_MAX_MESSAGES_PER_GROUP) {
        messages.splice(0, messages.length - HISTORY_MAX_MESSAGES_PER_GROUP);
      }
      request._messages = messages;
    };
  }).then((request) => (request && request._messages ? request._messages : []));
}

function readHistoryCursor(groupId) {
  return runHistoryStore(HISTORY_META_STORE, 'readonly', (store) => {
    const request = store.get(String(groupId));
    request.onsuccess = () => { request._cursor = request.result?.lastSyncedAt || null; };
  }).then((request) => (request && request._cursor ? request._cursor : null));
}

function writeHistoryCursor(groupId, createdAt) {
  if (!createdAt) return Promise.resolve();
  return runHistoryStore(HISTORY_META_STORE, 'readwrite', (store) => {
    store.put({ groupId: String(groupId), lastSyncedAt: String(createdAt), updatedAt: Date.now() });
  });
}

function clearGroupHistoryStore(groupId) {
  const messageClear = runHistoryStore(HISTORY_MESSAGES_STORE, 'readwrite', (store) => {
    const request = store.index('groupId').openKeyCursor(String(groupId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
  const metaClear = runHistoryStore(HISTORY_META_STORE, 'readwrite', (store) => store.delete(String(groupId)));
  return Promise.all([messageClear, metaClear]).then(() => null);
}

// One-time migration: fold existing localStorage per-group caches into the
// durable history store so no history is lost when caches are bounded.
let historyMigrationStarted = false;
async function migrateLocalCachesToHistory() {
  if (historyMigrationStarted || !historyDbSupported) return;
  historyMigrationStarted = true;
  const db = await openHistoryDb();
  if (!db) return;
  const tasks = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(LOCAL_CACHE_PREFIX)) continue;
    const groupId = key.slice(LOCAL_CACHE_PREFIX.length);
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || 'null');
      if (parsed && Array.isArray(parsed.messages) && parsed.messages.length) {
        tasks.push(persistHistoryMessages(groupId, parsed.messages));
      }
    } catch { /* best effort */ }
  }
  await Promise.allSettled(tasks);
}

// ── Merge helpers (dedup by message id, never replace) ───────────────────────
// Every cache update goes through these so socket echoes, REST fetches, and
// pagination can never duplicate or drop messages.
function sortMessagesChronologically(messages) {
  return [...messages].sort((a, b) => {
    const timeDiff = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    return timeDiff !== 0 ? timeDiff : String(a.id).localeCompare(String(b.id));
  });
}

function mergeMessagesIntoCache(groupId, incoming, { persist = true } = {}) {
  const cache = ensureGroupCacheEntry(groupId);
  const existing = Array.isArray(cache.messages) ? cache.messages : [];
  const byId = new Map(existing.map((m) => [String(m.id), m]));
  for (const m of incoming) byId.set(String(m.id), m);
  const merged = sortMessagesChronologically([...byId.values()]);
  // Server-provided rows with hasRead=true are confirmed read state.
  for (const m of merged) {
    if (m.hasRead === true && m.readConfirmed !== true) m.readConfirmed = true;
  }
  cache.messages = merged;
  cache.oldestMessageId = merged.length ? merged[0].id : null;
  cache.rowsDirty = true;
  if (persist) {
    writeLocalGroupCache(groupId, cache);
    if (historyDbSupported) void persistHistoryMessages(groupId, merged);
  }
  return merged;
}

function cacheHasMessage(groupId, messageId) {
  const cache = ensureGroupCacheEntry(groupId);
  return Array.isArray(cache.messages) && cache.messages.some((m) => String(m.id) === String(messageId));
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
  await clearIndexedDbDatabases();
  clearAccessibleCookies();
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

// v1.3.9: a session that expired while the app was backgrounded must not yank
// the UI to the login page mid-background (that looked like a crash/refresh).
// Defer the redirect until the user actually returns to the app.
let sessionExpiredPending = false;
function handleSessionExpired() {
  if (document.hidden) {
    sessionExpiredPending = true;
    return;
  }
  window.location.href = buildAuthRedirectUrl();
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
  // v1.3.9: never auto-reload the shell (especially while hidden in the tray
  // or backgrounded) — surface a user-confirmed in-app banner instead. This
  // kills the "app refreshes and reloads all history by itself" behavior.
  showUpdateAvailableBanner();
  return true;
}

function showUpdateAvailableBanner() {
  const banner = $('update-available-banner');
  if (!banner) return;
  const text = $('update-available-text');
  if (text) text.textContent = `GChat ${currentAppVersion} is available.`;
  banner.hidden = false;
}

function startHostedAppUpdatePolling() {
  if (hostedAppUpdateTimer) clearInterval(hostedAppUpdateTimer);
  hostedAppUpdateTimer = setInterval(() => {
    // Skip the version check entirely while hidden — nothing may reload in
    // the background.
    if (document.hidden) return;
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
function formatFullMessageTime(iso) {
  const date = parseMessageDate(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = localTimeFormatter.format(date);
  if (getLocalDayKey(iso) === getLocalDayKey(now.toISOString())) return `Today at ${time}`;
  if (getLocalDayKey(iso) === getLocalDayKey(yesterday.toISOString())) return `Yesterday at ${time}`;
  return `${localDayFormatter.format(date)} at ${time}`;
}
function formatDay(iso) {
  if (!iso) return '';
  // Prefer compact numeric form (e.g. 7/15/2026).
  const date = parseMessageDate(iso);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}
function isSameMessageDay(a, b) {
  if (!a || !b) return false;
  return getLocalDayKey(a) === getLocalDayKey(b);
}
function shouldContinueSeries(prevMsg, currentMsg) {
  if (!prevMsg || !currentMsg) return false;
  if (prevMsg.type === 'system' || currentMsg.type === 'system') return false;
  if (prevMsg.senderId !== currentMsg.senderId) return false;
  if (resolveMessageTagTopic(prevMsg) !== resolveMessageTagTopic(currentMsg)) return false;
  if (!isSameMessageDay(prevMsg.createdAt, currentMsg.createdAt)) return false;
  const prevTime = parseMessageDate(prevMsg.createdAt).getTime();
  const currentTime = parseMessageDate(currentMsg.createdAt).getTime();
  // Group consecutive messages from the same author within ~7 minutes.
  const gapMinutes = (currentTime - prevTime) / 60000;
  return gapMinutes >= 0 && gapMinutes <= 7;
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
  if (!aiFeatureEnabled) return null;
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
  if (message === 'Loading users…') {
    for (let i = 0; i < 4; i += 1) {
      const row = document.createElement('div');
      row.className = 'user-management-user user-management-user-skeleton';
      row.innerHTML = '<div class="member-avatar"></div><div class="user-management-user-main"><div class="user-management-user-head"><div class="user-management-user-summary"><div class="user-management-skeleton-line user-management-skeleton-line-title"></div><div class="user-management-skeleton-line"></div></div></div></div>';
      list.appendChild(row);
    }
    return;
  }
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

    const summaryText = document.createElement('div');
    summaryText.className = 'user-management-user-summary';

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

    summaryText.append(name);
    head.append(summaryText, usage);
    main.append(head);

    if (summary.viewerCanManageAiLimits || (summary.viewerCanDeleteUsers && user.username !== APP_OWNER_USERNAME)) {
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'btn-icon user-management-expand-btn';
      toggleBtn.setAttribute('aria-expanded', 'false');
      setElementIcon(toggleBtn, 'panel-right', {
        iconOnly: true,
        label: `Show actions for ${user.username}`,
      });
      toggleBtn.addEventListener('click', () => {
        const expanded = row.classList.toggle('expanded');
        toggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        toggleBtn.setAttribute('aria-label', `${expanded ? 'Hide' : 'Show'} actions for ${user.username}`);
        toggleBtn.title = `${expanded ? 'Hide' : 'Show'} actions for ${user.username}`;
      });
      head.appendChild(toggleBtn);

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

    const numberedMatch = /^(\d+)\.\s+(.*)$/.exec(trimmed);
    if (numberedMatch) {
      flushParagraph();
      const startNum = parseInt(numberedMatch[1], 10) || 1;
      const list = document.createElement('ol');
      if (startNum !== 1) list.setAttribute('start', String(startNum));
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

function normalizeId(value) {
  return String(value || '');
}

/** Default sub-chat channel for every group. Always present; always selected unless user picks another. */
const DEFAULT_TAG_TOPIC = 'main';
const MAX_TAG_TOPIC_LENGTH = 12;
const CHANNEL_PREF_KEY_PREFIX = 'gchat:active-channel:';

// ── GChat Global (permanent, admin-less global channel) ───────────────────────
const GLOBAL_GROUP_ID = 'gchat-global';
const GLOBAL_GROUP_NAME = 'GChat Global';
const GLOBAL_GROUP_ICON_SRC = '/gchat_icon.png';

function isGlobalGroupId(groupId) {
  return String(groupId || '') === GLOBAL_GROUP_ID;
}

function isGlobalGroup(group) {
  return !!(group && (group.isGlobal === true || isGlobalGroupId(group.id)));
}

function isCurrentGroupGlobal() {
  return isGlobalGroup(currentGroupData) || isGlobalGroupId(currentGroupId);
}

function normalizeHashtagTopic(value) {
  if (value == null || value === '') return null;
  const trimmed = String(value).trim().replace(/^#/, '').toLowerCase();
  if (!trimmed || trimmed.length > MAX_TAG_TOPIC_LENGTH) return null;
  return /^[a-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

function channelPrefKey(groupId, userId = currentUser && currentUser.id) {
  if (!groupId || !userId) return null;
  return `${CHANNEL_PREF_KEY_PREFIX}${userId}:${groupId}`;
}

function readStoredChannel(groupId) {
  const key = channelPrefKey(groupId);
  if (!key) return DEFAULT_TAG_TOPIC;
  try {
    return normalizeHashtagTopic(localStorage.getItem(key)) || DEFAULT_TAG_TOPIC;
  } catch {
    return DEFAULT_TAG_TOPIC;
  }
}

function writeStoredChannel(groupId, topic) {
  const key = channelPrefKey(groupId);
  if (!key) return;
  try {
    localStorage.setItem(key, normalizeHashtagTopic(topic) || DEFAULT_TAG_TOPIC);
  } catch {
    /* ignore */
  }
}

function ensureActiveTag(topic) {
  const normalized = normalizeHashtagTopic(topic) || DEFAULT_TAG_TOPIC;
  activeTagFilter = normalized;
  if (currentGroupId) writeStoredChannel(currentGroupId, normalized);
  return activeTagFilter;
}

function getActiveTagTopic() {
  return normalizeHashtagTopic(activeTagFilter) || DEFAULT_TAG_TOPIC;
}

/** Untagged legacy messages live in #main. */
function resolveMessageTagTopic(msg) {
  return getMessageHashtagKey(msg) || DEFAULT_TAG_TOPIC;
}

/**
 * Ensure channel topic is resolved on the message object after decrypt.
 * V2 messages keep hashtag only in encrypted metadata (server hashtag is null).
 */
async function hydrateMessageChannel(msg, groupId = msg?.groupId || currentGroupId) {
  if (!msg) return DEFAULT_TAG_TOPIC;
  if (!getMessageHashtagKey(msg) && Number(msg.encryptionVersion) === 2) {
    const key = groupId ? getGroupKey(groupId) : null;
    if (key && msg.encryptedMetadata && msg.metadataIv) {
      try {
        if (msg.type === 'image' || msg.type === 'file') {
          const metadata = await GChatCryptoV2.decryptJson(
            msg.encryptedMetadata,
            msg.metadataIv,
            key,
            groupId,
            'metadata',
            v2Aad({ ...msg, groupId }),
          );
          Object.assign(msg, metadata);
        } else {
          await decryptV2Message(msg, key, groupId);
        }
      } catch {
        /* keep fallback */
      }
    }
  }
  const topic = resolveMessageTagTopic(msg);
  msg.hashtag = topic;
  if (groupId) rememberChannel(groupId, topic);
  // Keep tagIndex in sync so server delete / tag_cleared matching works.
  if (!msg.tagIndex && groupId && topic) {
    const key = getGroupKey(groupId);
    if (key) {
      try {
        msg.tagIndex = await GChatCryptoV2.blindIndex(topic, key, groupId, 'tag-index');
      } catch {
        /* ignore */
      }
    }
  }
  return topic;
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
  // Chat surfaces use solid Discord fills — never paint a wallpaper image layer.
  document.documentElement.style.setProperty('--chat-wallpaper', 'none');
  document.documentElement.style.setProperty('--auth-wallpaper', 'none');
  document.documentElement.style.setProperty('--wallpaper-blur', '0px');
  document.documentElement.style.setProperty('--wallpaper-overlay-opacity', '0');
  if (wallpaperTheme) {
    wallpaperTheme.applyToRoot({
      wallpaperDataUrl: null,
      wallpaperBlur: 0,
      wallpaperTransparency: 100,
      theme: appLocalSettings.theme || 'light',
    });
  }
  applyWallpaperPreviewStyle(null, 0, 100);
  syncWallpaperDraftControls({ wallpaperDataUrl: null, wallpaperBlur: 0, wallpaperTransparency: 100 });
}

function resolveThemePreference(preference) {
  const selected = ['system', 'dark', 'light'].includes(preference) ? preference : 'system';
  if (selected !== 'system') return selected;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function themeToggleButtons() {
  return Array.from(document.querySelectorAll('.theme-toggle-btn'));
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Unable to read image'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

function syncDesktopBrandIcon() {
  const icon = document.querySelector('.brand-icon');
  if (!icon) return;
  const isLightTheme = document.documentElement.dataset.theme === 'light';
  const nextSrc = isLightTheme ? icon.dataset.lightSrc : icon.dataset.darkSrc;
  if (nextSrc && icon.getAttribute('src') !== nextSrc) icon.src = nextSrc;
}

async function copyTextToClipboard(text) {
  if (typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through for desktop and non-secure contexts where Clipboard API access is unavailable.
    }
  }

  const copyTarget = document.createElement('textarea');
  copyTarget.value = text;
  copyTarget.setAttribute('readonly', '');
  copyTarget.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
  document.body.append(copyTarget);
  copyTarget.select();
  const copied = document.execCommand('copy');
  copyTarget.remove();
  return copied;
}

function syncThemeToggleControl() {
  const preference = ['dark', 'light'].includes(appLocalSettings.theme)
    ? appLocalSettings.theme
    : resolveThemePreference(appLocalSettings.theme || 'light');
  const resolved = resolveThemePreference(preference);
  // Show the destination mode icon (sun = switch to light, moon = switch to dark).
  const nextIcon = resolved === 'dark' ? 'sun' : 'moon';
  const nextLabel = resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  for (const btn of themeToggleButtons()) {
    btn.dataset.themeState = resolved;
    setElementIcon(btn, nextIcon, {
      iconOnly: btn.classList.contains('btn-icon'),
      label: btn.classList.contains('btn-icon') ? nextLabel : 'Theme',
    });
    btn.title = nextLabel;
    btn.setAttribute('aria-label', nextLabel);
  }
  syncDesktopBrandIcon();
}

async function applyThemePreference(next) {
  const theme = next === 'light' ? 'light' : 'dark';
  appLocalSettings.theme = theme;
  wallpaperTheme?.applyTheme(theme);
  syncThemeToggleControl();
  writeLocalSettings(appLocalSettings, currentUser?.id);
  const result = await saveSettingsToServer();
  if (!result.ok) showToast(result.error || 'Theme could not be synced', 'error');
  return result;
}

function bindThemeToggleControl() {
  for (const btn of themeToggleButtons()) {
    if (btn.dataset.bound === '1') continue;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = resolveThemePreference(appLocalSettings.theme || 'light');
      await applyThemePreference(current === 'dark' ? 'light' : 'dark');
    });
  }
  syncThemeToggleControl();
}

async function saveSettingsToServer(options = {}) {
  if (!currentUser) return { ok: false, networkError: true, error: 'Not signed in' };
  const payload = {
    wallpaperDataUrl: appLocalSettings.wallpaperDataUrl || null,
    wallpaperBlur: getWallpaperSettings(appLocalSettings).wallpaperBlur,
    wallpaperTransparency: getWallpaperSettings(appLocalSettings).wallpaperTransparency,
    hideProfileDot: !!appLocalSettings.hideProfileDot,
    theme: appLocalSettings.theme || 'light',
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
    if (['system', 'dark', 'light'].includes(data.theme)) appLocalSettings.theme = data.theme;
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
  appLocalSettings.theme = ['system', 'dark', 'light'].includes(local.theme) ? local.theme : 'light';
  applyWallpaperFromSettings();
  wallpaperTheme?.applyTheme(appLocalSettings.theme);
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
  if (!row || !row.isConnected || !socket || document.visibilityState !== 'visible') return;
  const messageId = row.dataset.msgId;
  const rowGroupId = String(row.dataset.groupId || currentGroupId || '');
  if (!rowGroupId) return;
  if (!messageId) return;

  // v1.3.9: decide on the server-confirmed state (readConfirmed), not the
  // local dataset flag — a receipt emitted into a dying socket must be retried
  // after the reconnect instead of being silently dropped.
  if (!pendingReadMessageIds.has(messageId)) {
    const cache = ensureGroupCacheEntry(rowGroupId);
    const cachedMsg = (cache.messages || []).find((m) => String(m.id) === messageId);
    if (!cachedMsg || cachedMsg.readConfirmed !== true) {
      pendingReadMessageIds.add(messageId);
      row.classList.remove('unseen');
      row.dataset.hasRead = '1';
      markMessageReadLocal(rowGroupId, messageId);
      queueMarkReadEmit(rowGroupId, messageId);
    }
  }

  if (
    row.dataset.disappearing === '1'
    && row.dataset.senderId !== String(currentUser?.id)
    && row.dataset.disappearingHidden !== '1'
    && row.dataset.disappearingStarted !== '1'
  ) {
    requestDisappearingTimerStart(messageId, rowGroupId);
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

// v1.3.9: notifications carry the sender and message content when the client
// has already decrypted the message locally (never for server-side web push,
// which cannot decrypt E2E content).
function formatNotificationBody(unreadCount, notification) {
  if (notification && notification.senderName) {
    const preview = truncate(String(notification.preview || ''), 70);
    return preview ? `${notification.senderName}: ${preview}` : `New message from ${notification.senderName}`;
  }
  return getGenericUnreadNotificationBody(unreadCount);
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

function sendNativeNotification(unreadCount, groupId, notification = null) {
  const body = formatNotificationBody(unreadCount, notification);
  if (window.electronAPI) {
    window.electronAPI.showNotification({
      title: GENERIC_NOTIFICATION_TITLE,
      body,
      groupId,
    });
    return;
  }
  if (pushStatus.subscriptionActive || !isNotificationPermissionGranted()) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(GENERIC_NOTIFICATION_TITLE, {
        body,
        icon: '/gchat_icon.png',
        badge: '/gchat_icon.png',
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
let imageViewerData = null;

// v1.3.8: message-image object URLs are revoked whenever their DOM node leaves
// the transcript, so long sessions don't accumulate blob URLs.
function revokeBlobUrlsIn(root) {
  if (!root) return;
  try {
    if (root.tagName === 'IMG' && (root.src || '').startsWith('blob:')) {
      URL.revokeObjectURL(root.src);
      root.removeAttribute('src');
    }
    for (const img of root.querySelectorAll('img[src^="blob:"]')) {
      URL.revokeObjectURL(img.src);
      img.removeAttribute('src');
    }
  } catch { /* already-revoked or unusable URLs are harmless */ }
}

function showImageViewer(blob, filename = 'image') {
  const modal = $('image-viewer-modal');
  const img = $('image-viewer-img');
  // Replace rather than leak: revoke the previously opened image's URL.
  if (imageViewerData?.imageUrl) {
    URL.revokeObjectURL(imageViewerData.imageUrl);
  }
  const imageUrl = URL.createObjectURL(blob);
  imageViewerData = { blob, filename, imageUrl };
  img.src = imageUrl;
  imageViewerZoom = 1;
  img.style.transform = 'scale(1)';
  modal.hidden = false;
}

function hideImageViewer() {
  const modal = $('image-viewer-modal');
  const img = $('image-viewer-img');
  modal.hidden = true;
  if (imageViewerData?.imageUrl) URL.revokeObjectURL(imageViewerData.imageUrl);
  imageViewerData = null;
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

// Legacy alias used by focus / reconnect handlers.
function isNearBottom() {
  return isMessagesPinnedToBottom();
}

function pinMessagesToBottom(skipAnimation = true) {
  const area = messagesArea();
  if (!area) return;
  area.scrollTo({ top: area.scrollHeight, behavior: skipAnimation ? 'auto' : 'smooth' });
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

function clearProfilePictureSelection({ keepSavedPreview = false } = {}) {
  const input = $('profile-picture-input');
  const preview = $('profile-picture-preview');
  const img = $('profile-picture-preview-img');
  const nameEl = $('profile-picture-file-name');
  if (input) input.value = '';
  if (preview) preview.hidden = !(keepSavedPreview && !!currentUser?.profilePicture);
  if (img) {
    if (keepSavedPreview && currentUser?.profilePicture) {
      img.src = currentUser.profilePicture;
      img.alt = 'Current avatar preview';
    } else {
      img.removeAttribute('src');
      img.alt = 'Selected image preview';
    }
  }
  if (nameEl) nameEl.textContent = 'Max 2MB';
  const saveButton = $('profile-save-picture');
  if (saveButton) saveButton.disabled = true;
}

function updateProfileRemoveButton() {
  const removeBtn = $('profile-remove-picture');
  if (!removeBtn) return;
  // Only relevant in image mode when the user already has a saved picture
  const hasSaved = !!(currentUser && currentUser.profilePicture);
  removeBtn.hidden = !hasSaved;
}

/** Exclusive avatar mode: color panel XOR image panel, with a preview for a saved or newly chosen image. */
function setProfilePictureMode(mode) {
  const slider = $('profile-picture-mode-slider');
  const colorSection = $('profile-picture-color-section');
  const uploadSection = $('profile-picture-upload-section');
  if (!slider || !colorSection || !uploadSection) return;

  const isImage = mode === 'image';
  slider.value = isImage ? '1' : '0';
  slider.closest('.profile-mode-tabs')?.setAttribute('data-mode', isImage ? 'image' : 'color');

  // Color mode: hide all image controls. Image mode: hide all color controls.
  colorSection.hidden = isImage;
  uploadSection.hidden = !isImage;

  const colorChip = $('profile-mode-color-label');
  const imageChip = $('profile-mode-image-label');
  colorChip?.classList.toggle('active', !isImage);
  imageChip?.classList.toggle('active', isImage);
  colorChip?.setAttribute('aria-selected', String(!isImage));
  imageChip?.setAttribute('aria-selected', String(isImage));

  if (!isImage) {
    // Leaving image mode clears any unsaved file pick and its preview.
    clearProfilePictureSelection();
  } else {
    clearProfilePictureSelection({ keepSavedPreview: true });
    updateProfileRemoveButton();
  }
}

function syncProfilePictureModeUI() {
  setProfilePictureMode(currentUser && currentUser.profilePicture ? 'image' : 'color');
}

function setUploadProgress(containerId, labelId, { visible, label }) {
  const container = $(containerId);
  const labelElement = $(labelId);
  if (container) container.hidden = !visible;
  if (labelElement && label) labelElement.textContent = label;
}

function setButtonBusy(button, busy, busyLabel, idleLabel) {
  if (!button) return;
  button.disabled = !!busy;
  button.classList.toggle('is-loading', !!busy);
  button.setAttribute('aria-busy', String(!!busy));
  button.textContent = busy ? busyLabel : idleLabel;
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentUser = null;
let currentGroupId = null;
let currentGroupData = null;
let groups = [];
let members = [];
let socket = null;
let messageMode = 'normal'; // 'normal' | 'whisper' | 'disappearing'
let whisperRecipients = [];
let replyingTo = null;
let unreadCounts = {};
let scrollUnreadCount = 0;
let onlineUsers = new Set();
let allMessages = [];
let oldestMessageId = null;
let loadingOlder = false;
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
  theme: 'light',
};
let wallpaperDraft = null;
let desktopSidebarWidth = DESKTOP_DEFAULT_SIDEBAR_WIDTH;
let desktopRightPanelExpanded = true;
let activeTagFilter = DEFAULT_TAG_TOPIC;
let grokRequestInFlight = false;
let grokResponseDraft = '';
let grokResponseModel = '';
let grokResponseMeta = null;
let grokRequestSource = 'panel';
let grokRequestHashtag = null;
let aiUsageSummary = null;
let userManagementSummary = null;
let aiMessageRequestInFlight = false;
let whisperPickerMode = null;
let pendingWhisperCommandStart = null;
// Light-sphere / pointer-follow glow permanently removed in v1.3.7 (no mousemove CSS vars).
const composerTokens = {
  whisper: null,
  hashtag: null,
  ai: null,
};
const socketDiagnostics = {
  connectionState: 'connecting',
  healthStatus: 'unknown',
  healthLatencyMs: null,
  healthCheckedAt: '',
  healthEdge: '',
  healthRequestId: '',
  healthServerTime: '',
  healthEnvironment: '',
  socketTransport: 'unknown',
  socketId: '',
  lastConnectAt: '',
  lastDisconnectReason: '',
  lastDisconnectAt: '',
  lastConnectError: '',
  lastConnectErrorAt: '',
  reconnectAttempts: 0,
  reconnectFailed: false,
  isBrowserOnline: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
};

function renderCurrentUserAvatar(user = currentUser) {
  const avatar = $('user-avatar');
  if (!avatar || !user) return;
  renderAvatarElement(avatar, user);
}

function readKnownChannels(groupId) {
  const key = channelPrefKey(groupId);
  if (!key) return [DEFAULT_TAG_TOPIC];
  try {
    const raw = localStorage.getItem(`${key}:channels`);
    const parsed = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? parsed : [];
    const set = new Set([DEFAULT_TAG_TOPIC]);
    for (const topic of list) {
      const normalized = normalizeHashtagTopic(topic);
      if (normalized) set.add(normalized);
    }
    return [...set];
  } catch {
    return [DEFAULT_TAG_TOPIC];
  }
}

function writeKnownChannels(groupId, topics) {
  const key = channelPrefKey(groupId);
  if (!key) return;
  try {
    const unique = [...new Set(
      (topics || [])
        .map((topic) => normalizeHashtagTopic(topic) || DEFAULT_TAG_TOPIC)
        .filter(Boolean)
    )];
    if (!unique.includes(DEFAULT_TAG_TOPIC)) unique.unshift(DEFAULT_TAG_TOPIC);
    localStorage.setItem(`${key}:channels`, JSON.stringify(unique));
  } catch {
    /* ignore */
  }
}

function getKnownChannels(groupId) {
  const cache = ensureGroupCacheEntry(groupId);
  if (!(cache.knownChannels instanceof Set)) {
    cache.knownChannels = new Set(readKnownChannels(groupId));
  }
  cache.knownChannels.add(DEFAULT_TAG_TOPIC);
  return cache.knownChannels;
}

function rememberChannel(groupId, topic) {
  if (!groupId) return;
  const normalized = normalizeHashtagTopic(topic) || DEFAULT_TAG_TOPIC;
  const known = getKnownChannels(groupId);
  known.add(normalized);
  writeKnownChannels(groupId, [...known]);
}

function forgetChannel(groupId, topic) {
  if (!groupId) return;
  const normalized = normalizeHashtagTopic(topic);
  if (!normalized || normalized === DEFAULT_TAG_TOPIC) return;
  const known = getKnownChannels(groupId);
  known.delete(normalized);
  writeKnownChannels(groupId, [...known]);
}

function ensureGroupCacheEntry(groupId) {
  if (!groupDataCache.has(groupId)) {
    const local = readLocalGroupCache(groupId);
    const localMessages = filterMessagesVisibleToCurrentUser(local?.messages || []);
    groupDataCache.set(groupId, {
      messages: localMessages.length ? localMessages : (local?.messages ? [] : null),
      messageRows: null,
      members: local?.members || null,
      oldestMessageId: local?.oldestMessageId || null,
      rowsDirty: !!local?.messages,
      knownChannels: new Set(readKnownChannels(groupId)),
    });
  }
  const entry = groupDataCache.get(groupId);
  if (!(entry.knownChannels instanceof Set)) {
    entry.knownChannels = new Set(readKnownChannels(groupId));
  }
  return entry;
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
    try {
      // Hydrate channel before series logic so sub-chats do not merge senders across channels.
      await hydrateMessageChannel(msg, groupId);
      const showSenderName = !shouldContinueSeries(prevMessage, msg);
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
  if (!Array.isArray(cache.messages)) cache.messages = [];
  const isCurrentGroup = groupId === currentGroupId;

  for (const msg of cache.messages) {
    await hydrateMessageChannel(msg, groupId);
  }

  const removedIds = [];
  cache.messages = cache.messages.filter((msg) => {
    const shouldKeep = resolveMessageTagTopic(msg) !== normalizedTag;
    if (!shouldKeep) removedIds.push(String(msg.id));
    return shouldKeep;
  });

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
  forgetChannel(groupId, normalizedTag);

  if (isCurrentGroup) allMessages = cache.messages;
  cache.oldestMessageId = cache.messages.length ? cache.messages[0].id : null;
  cache.rowsDirty = true;
  cache.messageRows = null;
  syncGroupUnreadCount(groupId);
  writeLocalGroupCache(groupId, cache);
  await updateGroupPreviewFromMessage(groupId, cache.messages[cache.messages.length - 1] || null);
  return removedIds.length > 0;
}

function renderGroupFromCache(groupId) {
  const cache = ensureGroupCacheEntry(groupId);
  allMessages = cache.messages || [];
  oldestMessageId = cache.oldestMessageId;
  members = cache.members || [];
  for (const msg of allMessages) scheduleDisappearingTimerForMessage(msg);
  $('chat-member-count').textContent = members.length + ' member' + (members.length !== 1 ? 's' : '');
  renderMembersList();
  renderWhisperPicker();
  renderTagFilters();
  // Always paint only the active channel stream (independent history).
  void renderActiveChannelStream();
}

// v1.3.8: background-group caches must stay bounded now that every group room
// feeds realtime messages. The open group's transcript is never trimmed.
const MAX_CACHED_MESSAGES_PER_GROUP = 500;

function trimBackgroundGroupCache(cache) {
  const messages = cache.messages;
  if (!Array.isArray(messages) || messages.length <= MAX_CACHED_MESSAGES_PER_GROUP) return;
  cache.messages = messages.slice(-MAX_CACHED_MESSAGES_PER_GROUP);
  cache.messageRows = null;
  cache.rowsDirty = true;
  cache.oldestMessageId = cache.messages.length ? cache.messages[0].id : null;
}

function preloadAllGroups() {
  for (const group of groups) {
    void ensureGroupDataPreloaded(group.id).catch((err) => {
      console.error('Background preload failed:', group.id, err);
    });
  }
}

// v1.3.8: join every group room so realtime delivery, unread badges, previews,
// and notifications stay synchronized for background groups — not just the one
// currently open. Bounded by the group cap (MAX_GROUPS_PER_USER + global) and
// deduplicated so repeated loadGroups calls never re-broadcast join_room.
let joinedRoomIds = new Set();

function joinAllGroupRooms() {
  if (!socket) return;
  const next = new Set(joinedRoomIds);
  for (const group of groups) {
    const id = String(group.id || '');
    if (!id || next.has(id)) continue;
    next.add(id);
    socket.emit('join_room', id);
  }
  joinedRoomIds = next;
}

function trackJoinedRoom(groupId) {
  const id = String(groupId || '');
  if (!id) return;
  joinedRoomIds.add(id);
}

// v1.3.8: silently resync the open group from the server. Guards against stale
// in-memory caches when messages were missed while the tab was backgrounded,
// the device slept, or the socket was temporarily down.
async function refreshCurrentGroupFromServer() {
  const groupId = currentGroupId;
  if (!groupId) return;
  try {
    const cache = ensureGroupCacheEntry(groupId);
    const hasCached = Array.isArray(cache.messages) && cache.messages.length > 0;
    // v1.3.9: incremental sync — only fetch messages newer than the local
    // cursor when we already have history, instead of re-fetching the window.
    let url = `/api/groups/${groupId}/messages?limit=100`;
    if (hasCached) {
      const cursor = await readHistoryCursor(groupId);
      const since = cursor || cache.messages[cache.messages.length - 1].createdAt;
      if (since) url = `/api/groups/${groupId}/messages?since=${encodeURIComponent(since)}&limit=100`;
    }
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return;
    const rawMsgs = await res.json();
    if (String(currentGroupId) !== groupId) return;
    const msgs = filterMessagesVisibleToCurrentUser(rawMsgs);
    const entry = ensureGroupCacheEntry(groupId);
    // Merge instead of replace: preserve older paginated history the user has
    // already loaded, while refreshing/inserting the newest server messages.
    const existing = Array.isArray(entry.messages) ? entry.messages : [];
    const byId = new Map(existing.map((m) => [String(m.id), m]));
    for (const m of msgs) byId.set(String(m.id), m);
    const merged = sortMessagesChronologically([...byId.values()]);
    const knownIds = new Set(existing.map((m) => String(m.id)));
    const changed = msgs.some((fresh) => {
      if (!knownIds.has(String(fresh.id))) return true;
      const old = byId.get(String(fresh.id));
      return (old.editedAt || null) !== (fresh.editedAt || null)
        || Number(old.revision || 0) !== Number(fresh.revision || 0);
    });
    if (!changed) return;
    entry.messages = merged;
    entry.messageRows = null;
    entry.rowsDirty = true;
    writeLocalGroupCache(groupId, entry);
    if (historyDbSupported) {
      void persistHistoryMessages(groupId, msgs);
      if (msgs.length) void writeHistoryCursor(groupId, msgs[msgs.length - 1].createdAt);
    }
    if (String(currentGroupId) !== groupId) return;
    allMessages = merged;
    updateGroupUnseenCount(groupId, merged);
    void updateGroupPreviewFromMessage(groupId, merged.length ? merged[merged.length - 1] : null);
    // Re-render only when the user isn't mid-scroll through older history, and
    // preserve their reading position (renderActiveChannelStream scrolls down).
    const nearBottom = isNearBottom();
    if (nearBottom || messagesArea().scrollTop <= 0) {
      const area = messagesArea();
      const prevScrollTop = area.scrollTop;
      const prevScrollHeight = area.scrollHeight;
      await renderActiveChannelStream();
      if (!nearBottom && prevScrollTop > 0) {
        area.scrollTop = prevScrollTop + (area.scrollHeight - prevScrollHeight);
      }
      observeCurrentGroupRowsForRead();
    }
  } catch (err) {
    console.warn('refreshCurrentGroupFromServer failed:', err);
  }
}

async function ensureGroupDataPreloaded(groupId) {
  if (groupPreloadPromises.has(groupId)) return groupPreloadPromises.get(groupId);
  const cache = ensureGroupCacheEntry(groupId);

  const preload = (async () => {
    if (cache.messages && cache.members) {
      if (cache.rowsDirty || !cache.messageRows) {
        await rebuildGroupMessageRows(groupId);
      }
      return ensureGroupCacheEntry(groupId);
    }
    const pending = [];
    if (!cache.messages) pending.push(loadMessages(groupId));
    if (!cache.members) pending.push(loadMembers(groupId));
    const results = await Promise.allSettled(pending);
    for (const result of results) {
      if (result.status === 'rejected') console.error('Group preload failed:', groupId, result.reason);
    }
    const refreshed = ensureGroupCacheEntry(groupId);
    if (refreshed.messages && refreshed.members && (refreshed.rowsDirty || !refreshed.messageRows)) {
      await rebuildGroupMessageRows(groupId);
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
const MSG_CONTENT_UNAVAILABLE = 'Unable to decrypt this message';
const GROUP_PREVIEW_EMPTY_TEXT = 'No messages yet';

// Scroll threshold (px from top) that triggers loading older messages
const SCROLL_LOAD_THRESHOLD = 1;
const MOBILE_BREAKPOINT = 768;
const MOBILE_KEYBOARD_MIN_HEIGHT = 120;
const VIEWPORT_SYNC_DEBOUNCE_MS = 45;
const MOBILE_KEYBOARD_FOCUS_DELAY_MS = 80;
const WHISPER_COMMAND_PENDING_PATTERN = /(?:^|\s)(\/w\s)$/;
const WHISPER_COMMAND_TARGET_PATTERN = /(?:^|\s)\/w\s+([^\s]+)\s$/;
let mobileViewState = 'list';
let viewportHeightSyncFrame = 0;
let viewportHeightSyncTimer = 0;
let largestViewportHeight = 0;
let composerNearBottomBeforeFocus = true;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function resolveSlashWhisperTarget(rawTarget) {
  const normalizedTarget = normalizeCommandUsername(rawTarget);
  if (!normalizedTarget) return null;
  return members.find((member) => normalizeCommandUsername(member.username) === normalizedTarget) || null;
}

function getUniqueWhisperRecipientIds(ids = []) {
  const seen = new Set();
  const result = [];
  for (const id of ids) {
    const key = normalizeId(id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function getActiveWhisperRecipientIds() {
  return getUniqueWhisperRecipientIds(whisperRecipients);
}

function getWhisperRecipientMembers(recipientIds, groupId = currentGroupId) {
  return (recipientIds || getActiveWhisperRecipientIds())
    .map((id) => getMemberProfile(groupId, id))
    .filter(Boolean);
}

function formatWhisperRecipientLabel(recipientIds, groupId = currentGroupId, { fallback = 'Whisper', prefix = 'Whisper → ' } = {}) {
  const names = getWhisperRecipientMembers(recipientIds || getActiveWhisperRecipientIds(), groupId)
    .map((member) => member.username)
    .filter(Boolean);
  if (!names.length) return fallback;
  if (names.length <= 2) return `${prefix}${names.join(', ')}`;
  return `${prefix}${names[0]}, ${names[1]} +${names.length - 2}`;
}

function formatWhisperMessageLabel(msg, groupId = currentGroupId) {
  const names = getWhisperRecipientMembers(getVisibleWhisperRecipientIds(msg), groupId)
    .map((member) => member.username)
    .filter(Boolean);
  if (!names.length) return 'Whisper';
  if (names.length <= 3) return `Whisper to ${names.join(', ')}`;
  return `Whisper to ${names[0]}, ${names[1]}, ${names[2]} +${names.length - 3}`;
}

function consumePendingWhisperCommand() {
  const input = $('message-input');
  if (!input || pendingWhisperCommandStart == null) return;
  input.value = input.value.slice(0, pendingWhisperCommandStart);
  input.selectionStart = input.selectionEnd = input.value.length;
  pendingWhisperCommandStart = null;
  autoResizeTextarea(input);
}

function showWhisperPicker(mode = 'button', commandStart = null) {
  const picker = $('whisper-picker');
  if (!picker) return;
  whisperPickerMode = mode;
  pendingWhisperCommandStart = Number.isInteger(commandStart) ? commandStart : null;
  renderWhisperPicker();
  picker.hidden = false;
}

function hideWhisperPicker() {
  const picker = $('whisper-picker');
  if (!picker) return;
  picker.hidden = true;
  whisperPickerMode = null;
  pendingWhisperCommandStart = null;
}

function syncWhisperPickerStatus(recipientCount = getActiveWhisperRecipientIds().length, hasPendingCommand = pendingWhisperCommandStart != null) {
  const status = $('whisper-picker-status');
  if (!status) return;
  if (!recipientCount) {
    status.textContent = hasPendingCommand ? 'Select recipients' : 'No recipients selected';
    return;
  }
  status.textContent = recipientCount === 1 ? '1 recipient selected' : `${recipientCount} recipients selected`;
}

/** Desktop chrome class only — no pointer light-sphere or parallax. */
function setDesktopEffectsEnabled(enabled) {
  document.body.classList.toggle('electron-desktop-effects', !!enabled);
  document.body.classList.remove('desktop-pointer-glow');
  document.body.style.removeProperty('--desktop-pointer-x');
  document.body.style.removeProperty('--desktop-pointer-y');
  document.body.style.removeProperty('--desktop-panel-shift-x');
  document.body.style.removeProperty('--desktop-panel-shift-y');
}

function bindDesktopPointerEffects() {
  // Intentionally empty: mouse-follow light sphere removed in v1.3.7.
}

function setComposerShellDisabled(disabled) {
  const shell = $('message-composer-shell');
  if (!shell) return;
  shell.classList.toggle('is-disabled', !!disabled);
}

function setWhisperTokenFromMember(member, rawTarget = member && member.username) {
  if (!member) return false;
  if (!whisperRecipients.some((id) => normalizeId(id) === normalizeId(member.id))) {
    whisperRecipients.push(member.id);
  }
  whisperRecipients = getUniqueWhisperRecipientIds(whisperRecipients);
  messageMode = 'whisper';
  return true;
}

function clearWhisperToken({ restoreText = false } = {}) {
  composerTokens.whisper = null;
  whisperRecipients = [];
  messageMode = 'normal';
}

function cancelWhisperSelection() {
  const picker = $('whisper-picker');
  if (!picker || picker.hidden) return false;
  hideWhisperPicker();
  whisperRecipients = [];
  composerTokens.whisper = null;
  messageMode = 'normal';
  syncComposerTokens();
  updateWhisperBtn();
  updateSlashCommandMenu();
  return true;
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
  // Never clear the active sub-chat channel when dropping a composer token.
  ensureActiveTag(activeTagFilter || DEFAULT_TAG_TOPIC);
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
  const availableCommands = aiFeatureEnabled ? ['ai'] : [];
  const shouldShow = !composerTokens.ai
    && commandQuery != null
    && availableCommands.some((command) => command.startsWith(commandQuery));
  menu.hidden = !shouldShow;
}

function isAiModeEnabled(groupData = currentGroupData) {
  return !!(groupData && groupData.aiEnabled);
}

function getAiDisabledMessage() {
  return 'AI mode is disabled by the group owner';
}

function canUseAiInCurrentGroup({ showError = false } = {}) {
  if (!aiFeatureEnabled) {
    if (showError) showToast('AI is temporarily unavailable', 'error');
    return false;
  }
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
  const slashAiBtn = $('slash-command-ai-item');
  if (slashAiBtn) {
    slashAiBtn.hidden = !aiFeatureEnabled;
    slashAiBtn.disabled = !enabled;
    slashAiBtn.title = enabled ? 'Ask AI' : (disabledReason || 'Ask AI');
  }
  if (!enabled && !$('grok-modal').hidden) closeGrokModal();
}

function messageMatchesActiveTag(msg) {
  const active = getActiveTagTopic();
  return resolveMessageTagTopic(msg) === active;
}

function rowMatchesActiveTag(row) {
  const active = getActiveTagTopic();
  const rowTag = normalizeHashtagTopic(row?.dataset?.hashtag) || DEFAULT_TAG_TOPIC;
  return rowTag === active;
}

function applyActiveTagFilterToRenderedMessages() {
  const area = messagesArea();
  if (!area) return;
  const rows = Array.from(area.children);
  for (const child of rows) {
    if (child.classList.contains('load-more-indicator')) continue;
    if (child.classList.contains('channel-empty-state')) continue;
    if (child.classList.contains('msg-row')) {
      // Re-sync dataset from stored message when available (post-decrypt hashtag).
      const msgId = child.dataset.msgId;
      if (msgId) {
        const cached = (allMessages || []).find((m) => m.id === msgId);
        if (cached) child.dataset.hashtag = resolveMessageTagTopic(cached);
      }
      child.hidden = !rowMatchesActiveTag(child);
      continue;
    }
    // System notices stay in every channel (non-destructive).
    if (child.classList.contains('msg-system')) {
      child.hidden = false;
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

  // Re-resolve series class among *visible* rows so sub-chats look continuous.
  let prevVisible = null;
  let prevCreatedAt = null;
  for (const child of rows) {
    if (!child.classList.contains('msg-row') || child.hidden) continue;
    const createdAt = child.querySelector('time')?.dateTime || child.querySelector('.msg-header-time')?.dateTime || null;
    let continueSeries = false;
    if (
      prevVisible
      && prevVisible.dataset.senderId
      && prevVisible.dataset.senderId === child.dataset.senderId
      && (prevVisible.dataset.hashtag || DEFAULT_TAG_TOPIC) === (child.dataset.hashtag || DEFAULT_TAG_TOPIC)
      && prevCreatedAt
      && createdAt
    ) {
      const prevTime = parseMessageDate(prevCreatedAt).getTime();
      const currentTime = parseMessageDate(createdAt).getTime();
      const gapMinutes = (currentTime - prevTime) / 60000;
      continueSeries = gapMinutes >= 0 && gapMinutes <= 7 && isSameMessageDay(prevCreatedAt, createdAt);
    }
    child.classList.toggle('series-continued', continueSeries);
    const header = child.querySelector('.msg-header');
    if (header) header.hidden = continueSeries;
    const avatar = child.querySelector('.msg-avatar');
    if (avatar) {
      if (continueSeries) {
        let clock = avatar.querySelector('.msg-continuation-time');
        if (!clock) {
          clock = document.createElement('time');
          clock.className = 'msg-continuation-time';
          if (createdAt) {
            clock.dateTime = createdAt;
            clock.textContent = formatTime(createdAt);
            clock.title = formatFullMessageTime(createdAt);
          }
        }
        avatar.replaceChildren(clock);
        avatar.style.background = 'transparent';
        avatar.style.color = 'transparent';
      } else {
        // Ensure header is visible again if series membership flipped off.
        if (header) header.hidden = false;
        // Restore the avatar itself: a flipped-off continuation keeps the
        // transparent style + clock child from its series state otherwise.
        const clock = avatar.querySelector('.msg-continuation-time');
        if (clock) {
          const senderId = child.dataset.senderId;
          const senderNameEl = child.querySelector('.msg-sender-name');
          const memberProfile = getMemberProfile(currentGroupId, senderId);
          renderAvatarElement(avatar, {
            username: memberProfile?.username || (senderNameEl && senderNameEl.textContent) || '?',
            iconColor: memberProfile?.iconColor || null,
            profilePicture: memberProfile?.profilePicture || null,
          });
          avatar.style.background = '';
          avatar.style.color = '';
        }
      }
    }
    prevVisible = child;
    prevCreatedAt = createdAt;
  }

  for (const child of rows) {
    if (child.classList.contains('msg-row')) {
      syncViewportTrackingForRow(child, isRowVisibleInMessagesViewport(child));
    }
  }
  syncChannelEmptyState();
}

function getAvailableGroupTags(groupId = currentGroupId) {
  const tags = new Map();
  // #main is always first — every group is a multi-channel sub-chat surface.
  tags.set(DEFAULT_TAG_TOPIC, formatHashtagLabel(DEFAULT_TAG_TOPIC));
  if (!groupId) {
    return [...tags.entries()].map(([topic, label]) => ({ topic, label }));
  }
  for (const topic of getKnownChannels(groupId)) {
    tags.set(topic, formatHashtagLabel(topic));
  }
  const cache = ensureGroupCacheEntry(groupId);
  for (const msg of cache.messages || []) {
    const topic = resolveMessageTagTopic(msg);
    if (!topic || tags.has(topic)) continue;
    tags.set(topic, formatHashtagLabel(topic));
    rememberChannel(groupId, topic);
  }
  const active = getActiveTagTopic();
  if (active && !tags.has(active)) tags.set(active, formatHashtagLabel(active));
  return [...tags.entries()].map(([topic, label]) => ({ topic, label }));
}

/**
 * Fully replace the rendered transcript with only the active channel's messages.
 * Does not hide rows in a shared history — channels are independent streams.
 */
async function renderActiveChannelStream() {
  const area = messagesArea();
  if (!area || !currentGroupId) return;
  const cache = ensureGroupCacheEntry(currentGroupId);
  const channel = getActiveTagTopic();
  const all = cache.messages || [];

  for (const msg of all) {
    await hydrateMessageChannel(msg, currentGroupId);
  }

  const channelMsgs = all.filter((msg) => resolveMessageTagTopic(msg) === channel);
  // The whole stream is replaced below — release the outgoing images' URLs.
  revokeBlobUrlsIn(area);
  area.replaceChildren(createLoadMoreIndicator());

  if (!channelMsgs.length) {
    syncChannelEmptyState();
    return;
  }

  const rows = await buildMessageRows(channelMsgs, currentGroupId);
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    if (!row) continue;
    // Rows built for a single channel are all visible.
    if (row.classList?.contains('msg-row')) {
      row.hidden = false;
      const msgId = row.dataset.msgId;
      const srcMsg = channelMsgs.find((m) => String(m.id) === String(msgId));
      if (srcMsg) observeMessageForRead(row, srcMsg);
    }
    fragment.appendChild(row);
  }
  area.appendChild(fragment);
  // Keep full-group cache rows dirty-safe; channel DOM is rebuilt on switch.
  cache.messageRows = null;
  cache.rowsDirty = true;
  syncChannelEmptyState();
  scrollToBottom(true);
}

function selectTagChannel(topic, { focusComposer = true } = {}) {
  const next = ensureActiveTag(topic);
  rememberChannel(currentGroupId, next);
  // Tags are sub-chats: never show a hashtag chip in the composer.
  clearHashtagToken();
  clearWhisperToken();
  whisperRecipients = [];
  messageMode = 'normal';
  // Quotes are channel-scoped: a reply composed in one channel must not be
  // sent against a message from another channel.
  if (replyingTo) {
    replyingTo = null;
    const replyBar = $('reply-preview-bar');
    if (replyBar) replyBar.hidden = true;
  }
  updateWhisperBtn();
  syncComposerTokens();
  renderTagFilters();
  // Replace the entire transcript — do not append/filter a shared history.
  void renderActiveChannelStream().then(() => {
    updateKeyState();
    updateSlashCommandMenu();
    if (focusComposer) {
      const input = $('message-input');
      if (input) {
        autoResizeTextarea(input);
        input.focus();
      }
    }
  });
  return next;
}

function countVisibleChannelMessages() {
  const area = messagesArea();
  if (!area) return 0;
  return Array.from(area.querySelectorAll('.msg-row')).filter((row) => !row.hidden).length;
}

function syncChannelEmptyState() {
  const area = messagesArea();
  if (!area || !currentGroupId) return;
  let empty = area.querySelector('.channel-empty-state');
  const visible = countVisibleChannelMessages();
  if (visible > 0) {
    if (empty) empty.remove();
    return;
  }
  if (!empty) {
    empty = document.createElement('div');
    empty.className = 'channel-empty-state';
    area.appendChild(empty);
  }
  const channel = formatHashtagLabel(getActiveTagTopic());
  empty.innerHTML = '';
  const title = document.createElement('p');
  title.className = 'channel-empty-title';
  title.textContent = `${channel} is empty`;
  const sub = document.createElement('p');
  sub.className = 'channel-empty-sub';
  sub.textContent = 'Messages here stay in this channel only. Start the conversation.';
  empty.append(title, sub);
}

function openChannelCreateModal() {
  const modal = $('channel-modal');
  const input = $('channel-name-input');
  const err = $('channel-error');
  if (!modal || !input) return;
  if (err) err.textContent = '';
  input.value = '';
  modal.hidden = false;
  setTimeout(() => input.focus(), 30);
}

function closeChannelCreateModal() {
  const modal = $('channel-modal');
  if (modal) modal.hidden = true;
  const err = $('channel-error');
  if (err) err.textContent = '';
}

function announceChannelChange(groupId, topic, action) {
  if (!socket || !groupId || !topic || topic === DEFAULT_TAG_TOPIC) return;
  try {
    socket.emit('channel_announce', {
      groupId: String(groupId),
      channel: topic,
      action: action === 'remove' ? 'remove' : 'add',
    });
  } catch {
    /* ignore offline announce failures */
  }
}

function confirmChannelCreate() {
  const input = $('channel-name-input');
  const err = $('channel-error');
  const raw = input ? input.value : '';
  const topic = normalizeHashtagTopic(raw);
  if (!topic) {
    if (err) {
      err.textContent = `Use up to ${MAX_TAG_TOPIC_LENGTH} letters, numbers, _ or -`;
    }
    input?.focus();
    return;
  }
  closeChannelCreateModal();
  rememberChannel(currentGroupId, topic);
  announceChannelChange(currentGroupId, topic, 'add');
  // New channel starts empty — switch stream immediately.
  selectTagChannel(topic);
}

function promptCreateTagChannel() {
  openChannelCreateModal();
}

function renderTagFilters() {
  const wrap = $('chat-tag-filters');
  if (!wrap) return;
  ensureActiveTag(activeTagFilter || DEFAULT_TAG_TOPIC);
  const tags = getAvailableGroupTags();
  const active = getActiveTagTopic();
  wrap.replaceChildren();
  wrap.hidden = false;
  for (const tag of tags) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-tag-filter-btn';
    btn.dataset.tagTopic = tag.topic;
    if (tag.topic === active) {
      btn.classList.add('active');
      btn.setAttribute('aria-current', 'true');
    }
    btn.textContent = tag.label;
    btn.title = `Open ${tag.label} channel`;
    btn.addEventListener('click', () => {
      // Cannot untoggle — selecting the active channel is a no-op switch.
      if (tag.topic === getActiveTagTopic()) return;
      selectTagChannel(tag.topic);
    });
    btn.addEventListener('contextmenu', (event) => {
      // #main cannot be deleted — no context menu.
      if (tag.topic === DEFAULT_TAG_TOPIC) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      showTagContextMenu(event, tag.topic);
    });
    wrap.appendChild(btn);
  }
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'chat-tag-add-btn';
  addBtn.title = 'Create channel';
  addBtn.setAttribute('aria-label', 'Create channel');
  addBtn.textContent = '+ Create';
  addBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openChannelCreateModal();
  });
  wrap.appendChild(addBtn);
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
  return false;
}

function maybeTokenizeSlashCommand(input) {
  if (!input) return false;
  // Channel creation is UI-only (Create channel modal). No /# command in composer.
  if (/^\/#(\s|$)/.test(input.value)) {
    showToast('Use + Create channel in the top bar', 'info');
    input.value = input.value.replace(/^\/#\s*/, '');
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
  let whisperRecipientIds = getActiveWhisperRecipientIds();
  // Every message is stamped with the active sub-chat channel (default #main).
  let hashtag = getActiveTagTopic();
  let isAiPrompt = !!composerTokens.ai;
  let isDisappearing = messageMode === 'disappearing';

  if (messageMode === 'whisper' && !composerTokens.whisper && whisperRecipients.length === 0) {
    return { ok: false, error: 'Select at least one whisper recipient' };
  }

  // Active channel stamps every message. No inline /# channel switch from composer.
  if (!whisperRecipientIds.length) {
    if (parseCommandToken(body, '#')) {
      return { ok: false, error: 'Use + Create channel to make a new channel' };
    }
    const aiToken = parseAiCommand(body);
    if (aiToken) {
      isAiPrompt = true;
      body = aiToken.prompt;
      const invalidWhisper = parseCommandToken(body, 'w');
      if (invalidWhisper) return { ok: false, error: 'AI requests cannot be combined with whispers' };
    }
  }

  if (isAiPrompt) {
    if (!canUseAiInCurrentGroup()) {
      return { ok: false, error: getAiDisabledMessage() };
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
  if (options.notifyServer && socket && groupId) {
    socket.emit('hide_disappearing_message', { groupId, messageId: normalizedId });
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
      await rebuildGroupMessageRows(cacheGroupId);
      renderGroupFromCache(cacheGroupId);
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
  'more-horizontal': [
    ['circle', { cx: '5', cy: '12', r: '1' }],
    ['circle', { cx: '12', cy: '12', r: '1' }],
    ['circle', { cx: '19', cy: '12', r: '1' }],
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
  activity: [
    ['polyline', { points: '22 12 18 12 15 21 9 3 6 12 2 12' }],
  ],
  'arrow-left': [
    ['line', { x1: '19', y1: '12', x2: '5', y2: '12' }],
    ['polyline', { points: '12 19 5 12 12 5' }],
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
  users: [
    ['path', { d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }],
    ['circle', { cx: '9', cy: '7', r: '4' }],
    ['path', { d: 'M23 21v-2a4 4 0 0 0-3-3.87' }],
    ['path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' }],
  ],
  'user-plus': [
    ['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }],
    ['circle', { cx: '8.5', cy: '7', r: '4' }],
    ['line', { x1: '19', y1: '8', x2: '19', y2: '14' }],
    ['line', { x1: '22', y1: '11', x2: '16', y2: '11' }],
  ],
  'shield-plus': [
    ['path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z' }],
    ['path', { d: 'M12 8v8' }],
    ['path', { d: 'M8 12h8' }],
  ],
  'shield-minus': [
    ['path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z' }],
    ['path', { d: 'M8 12h8' }],
  ],
  image: [
    ['rect', { x: '3', y: '5', width: '18', height: '14', rx: '2' }],
    ['circle', { cx: '9', cy: '10', r: '1.5' }],
    ['path', { d: 'm21 15-5-5L5 21' }],
  ],
  file: [
    ['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z' }],
    ['polyline', { points: '14 2 14 8 20 8' }],
    ['line', { x1: '8', y1: '13', x2: '16', y2: '13' }],
    ['line', { x1: '8', y1: '17', x2: '14', y2: '17' }],
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
  sun: [
    ['circle', { cx: '12', cy: '12', r: '4' }],
    ['path', { d: 'M12 2v2' }],
    ['path', { d: 'M12 20v2' }],
    ['path', { d: 'm4.93 4.93 1.41 1.41' }],
    ['path', { d: 'm17.66 17.66 1.41 1.41' }],
    ['path', { d: 'M2 12h2' }],
    ['path', { d: 'M20 12h2' }],
    ['path', { d: 'm6.34 17.66-1.41 1.41' }],
    ['path', { d: 'm19.07 4.93-1.41 1.41' }],
  ],
  moon: [
    ['path', { d: 'M21 14.5A8.5 8.5 0 1 1 9.5 3a7 7 0 0 0 11.5 11.5Z' }],
  ],
  timer: [
    ['circle', { cx: '12', cy: '13', r: '8' }],
    ['path', { d: 'M12 9v4l3 2' }],
    ['path', { d: 'M9 2h6' }],
    ['path', { d: 'M12 2v3' }],
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

function normalizeMobileView(view) {
  if (view === 'details' && currentGroupId) return 'details';
  if (view === 'chat' && currentGroupId) return 'chat';
  return 'list';
}

function syncRightPanelMobileTitle() {
  const title = $('right-panel-mobile-title');
  if (!title) return;
  title.textContent = currentGroupData?.name || 'Details';
}

function updateChatNavigationButton() {
  const button = $('sidebar-toggle');
  if (!button) return;
  setElementIcon(button, isMobileLayout() ? 'arrow-left' : 'menu', {
    iconOnly: true,
    label: isMobileLayout() ? 'Back to chats' : 'Menu',
  });
}

function updateDetailsNavigationButton() {
  const button = $('right-panel-close');
  if (!button) return;
  setElementIcon(button, isMobileLayout() ? 'arrow-left' : 'x', {
    iconOnly: true,
    label: isMobileLayout() ? 'Back to chat' : 'Close details',
  });
}

function syncMobileNavigationState() {
  const body = document.body;
  const sidebar = $('sidebar');
  const rightPanel = $('right-panel');
  const overlay = $('sidebar-overlay');
  if (!body || !sidebar || !rightPanel || !overlay) return;
  const mobile = isMobileLayout();
  const view = normalizeMobileView(mobileViewState);
  body.classList.toggle('mobile-layout', mobile);
  body.classList.toggle('mobile-list-view', mobile && view === 'list');
  body.classList.toggle('mobile-chat-view', mobile && view === 'chat');
  body.classList.toggle('mobile-details-view', mobile && view === 'details');
  sidebar.classList.toggle('open', mobile && view === 'list');
  rightPanel.classList.toggle('open', mobile && view === 'details');
  overlay.hidden = true;
  if (!mobile || view !== 'list') closeMobileActionMenu();
  updateChatNavigationButton();
  updateDetailsNavigationButton();
  updateRightPanelToggleButtons();
  syncRightPanelMobileTitle();
}

function setMobileView(view) {
  mobileViewState = normalizeMobileView(view);
  syncMobileNavigationState();
}

function closeMobileActionMenu() {
  const menu = $('mobile-sidebar-actions-menu');
  const toggle = $('sidebar-mobile-actions-btn');
  if (!menu || !toggle) return;
  menu.hidden = true;
  toggle.classList.remove('active');
  toggle.setAttribute('aria-expanded', 'false');
}

function toggleMobileActionMenu() {
  const menu = $('mobile-sidebar-actions-menu');
  const toggle = $('sidebar-mobile-actions-btn');
  if (!menu || !toggle) return;
  const nextHidden = !menu.hidden;
  menu.hidden = nextHidden;
  toggle.classList.toggle('active', !nextHidden);
  toggle.setAttribute('aria-expanded', nextHidden ? 'false' : 'true');
}

function isEditableElement(el = document.activeElement) {
  const tag = el?.tagName || '';
  return /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || el?.isContentEditable === true;
}

function updateKeyboardInset(activeElement = document.activeElement) {
  const vv = window.visualViewport;
  if (!isMobileLayout() || !vv) {
    document.documentElement.style.setProperty('--keyboard-inset', '0px');
    return 0;
  }
  const fallbackHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const layoutHeight = Math.max(largestViewportHeight || 0, fallbackHeight || 0, Math.round(vv.height) || 0);
  const visibleBottom = Math.round(vv.height + vv.offsetTop);
  const overlap = Math.max(0, Math.round(layoutHeight - visibleBottom));
  const keyboardOpen = isEditableElement(activeElement) && overlap >= MOBILE_KEYBOARD_MIN_HEIGHT;
  const inset = keyboardOpen ? overlap : 0;
  document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`);
  return inset;
}

function syncAppViewportHeight() {
  const vv = window.visualViewport;
  const fallbackHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const activeElement = document.activeElement;
  const nextHeight = getViewportHeightForLayout({ visualViewport: vv, fallbackHeight });
  if (isEditableElement(activeElement)) {
    largestViewportHeight = Math.max(largestViewportHeight || 0, nextHeight || 0);
  } else {
    largestViewportHeight = Math.max(320, nextHeight || 0);
  }
  const stableLayoutHeight = Math.max(320, nextHeight, largestViewportHeight);
  document.documentElement.style.setProperty('--app-viewport-height', `${stableLayoutHeight}px`);
  updateKeyboardInset(activeElement);
}

function bindViewportHeightTracking() {
  const scheduleViewportSync = () => {
    if (viewportHeightSyncTimer) clearTimeout(viewportHeightSyncTimer);
    viewportHeightSyncTimer = setTimeout(() => {
      viewportHeightSyncTimer = 0;
      if (viewportHeightSyncFrame) cancelAnimationFrame(viewportHeightSyncFrame);
      viewportHeightSyncFrame = requestAnimationFrame(() => {
        viewportHeightSyncFrame = 0;
        syncAppViewportHeight();
      });
    }, VIEWPORT_SYNC_DEBOUNCE_MS);
  };
  scheduleViewportSync();
  window.addEventListener('resize', scheduleViewportSync);
  window.addEventListener('orientationchange', scheduleViewportSync);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleViewportSync);
    window.visualViewport.addEventListener('scroll', scheduleViewportSync);
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
    document.body.classList.remove('sidebar-narrow', 'sidebar-compact', 'sidebar-actions-icons', 'sidebar-hide-cache', 'sidebar-resizing');
    document.documentElement.style.setProperty('--sidebar-width', `${DESKTOP_DEFAULT_SIDEBAR_WIDTH}px`);
    return;
  }
  const { min, max } = desktopSidebarBounds();
  desktopSidebarWidth = Math.min(max, Math.max(min, Math.round(desktopSidebarWidth || DESKTOP_DEFAULT_SIDEBAR_WIDTH)));
  document.documentElement.style.setProperty('--sidebar-width', `${desktopSidebarWidth}px`);
  document.body.classList.toggle('sidebar-narrow', desktopSidebarWidth <= DESKTOP_BRAND_ONLY_SIDEBAR_WIDTH);
  document.body.classList.toggle('sidebar-compact', desktopSidebarWidth <= DESKTOP_ICON_ONLY_SIDEBAR_WIDTH);
  document.body.classList.toggle('sidebar-actions-icons', desktopSidebarWidth <= DESKTOP_ACTIONS_ICON_SIDEBAR_WIDTH);
  document.body.classList.toggle('sidebar-hide-cache', desktopSidebarWidth <= DESKTOP_HIDE_CACHE_BTN_WIDTH);
  localStorage.setItem(DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY, String(desktopSidebarWidth));
}

function updateRightPanelToggleButtons() {
  const expanded = isMobileLayout()
    ? normalizeMobileView(mobileViewState) === 'details'
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
  syncMobileNavigationState();
}

function closeSidebar() {
  if (isMobileLayout()) {
    setMobileView(currentGroupId ? 'chat' : 'list');
    return;
  }
  $('sidebar').classList.remove('open');
}

function closeRightPanel() {
  closeMobileActionMenu();
  if (isMobileLayout()) {
    setMobileView(currentGroupId ? 'chat' : 'list');
    return;
  }
  $('right-panel').classList.remove('open');
}

function closeMobilePanels() {
  closeMobileActionMenu();
  setMobileView(currentGroupId ? 'chat' : 'list');
}

function toggleSidebar() {
  if (!isMobileLayout()) return;
  closeMobileActionMenu();
  setMobileView('list');
}

function toggleRightPanel() {
  closeMobileActionMenu();
  if (!isMobileLayout()) {
    desktopRightPanelExpanded = !desktopRightPanelExpanded;
    localStorage.setItem(DESKTOP_RIGHT_PANEL_STORAGE_KEY, desktopRightPanelExpanded ? '1' : '0');
    applyDesktopRightPanelState();
    return;
  }
  if (!currentGroupId) return;
  setMobileView(normalizeMobileView(mobileViewState) === 'details' ? 'chat' : 'details');
}

function syncResponsiveUiState() {
  setDesktopEffectsEnabled(!!window.electronAPI && !isMobileLayout());
  if (!isMobileLayout()) {
    document.body.classList.remove('mobile-layout', 'mobile-list-view', 'mobile-chat-view', 'mobile-details-view');
    $('sidebar')?.classList.remove('open');
    $('right-panel')?.classList.remove('open');
    closeMobileActionMenu();
  } else if (!currentGroupId && mobileViewState !== 'list') {
    mobileViewState = 'list';
  }
  applyDesktopSidebarState();
  applyDesktopRightPanelState();
  syncMobileNavigationState();
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  applyStaticIcons();
  bindViewportHeightTracking();
  bindDesktopPointerEffects();
  desktopSidebarWidth = readDesktopSidebarWidth();
  desktopRightPanelExpanded = localStorage.getItem(DESKTOP_RIGHT_PANEL_STORAGE_KEY) !== '0';
  loadMergedLocalSettings();
  syncResponsiveUiState();
  await fetchCsrfToken();
  try {
    const res = await fetch('/api/auth/me', { cache: 'no-store' });
    if (res.status === 401) { window.location.href = buildAuthRedirectUrl(); return; }
    if (!res.ok) throw new Error();
    currentUser = await res.json();
  } catch {
    window.location.href = buildAuthRedirectUrl(); return;
  }

  // Set user display
  migrateLegacyLocalSettings(currentUser.id);
  hiddenDisappearingMessageIds = loadHiddenDisappearingMessageIds(currentUser.id);
  $('user-username').textContent = currentUser.username;
  renderCurrentUserAvatar(currentUser);
  loadMergedLocalSettings(currentUser.id);
  await loadSettingsFromServer();
  applyWallpaperFromSettings();
  wallpaperTheme?.applyTheme(appLocalSettings.theme);
  bindThemeToggleControl();
  writeLocalSettings(appLocalSettings, currentUser.id);
  const versionInfo = await fetchAppVersionInfo();
  if (versionInfo) {
    currentAppVersion = versionInfo.version;
    appVersionLabel = 'v' + versionInfo.version;
    aiFeatureEnabled = versionInfo.aiEnabled === true;
  }
  $('app-version-label').textContent = appVersionLabel;

  if (aiFeatureEnabled) {
    await refreshAiUsageSummary();
    void loadAndRenderAiTones();
  }
  await loadGroups();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type !== 'push-unread-count') return;
      pushStatus.totalUnreadCount = Math.max(0, Number(event.data.totalUnreadCount) || 0);
      syncUnreadIndicators(pushStatus.totalUnreadCount);
    });
  }
  initSocket();
  bindOnlineOfflineListeners();
  setupEventListeners();
  syncProfilePictureModeUI();
  setupEmojiPicker();
  setupKeyboardShortcuts();
  updateWhisperBtn();
  syncResponsiveUiState();
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
    syncStateOnFocus();
  });
  window.addEventListener('blur', () => {
    clearAllMessageVisibilityTimers();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (sessionExpiredPending) {
        sessionExpiredPending = false;
        window.location.href = buildAuthRedirectUrl();
        return;
      }
      observeCurrentGroupRowsForRead();
      void checkForHostedAppUpdate();
      syncStateOnFocus();
      return;
    }
    clearAllMessageVisibilityTimers();
  });
  window.addEventListener('resize', () => {
    syncResponsiveUiState();
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
async function loadGroups({ withBackendPreload = false } = {}) {
  try {
    const previousPreviewByGroupId = new Map(
      groups.map((group) => [group.id, { text: group._lastPreviewText, time: group._lastPreviewTime }])
    );
    const endpoint = withBackendPreload ? '/api/groups/preload?limit=50' : '/api/groups/mine';
    const res = await fetch(endpoint);
    if (!res.ok) return false;
    groups = await res.json();
    unreadCounts = {};
    for (const group of groups) {
      unreadCounts[group.id] = Math.max(0, Number(group.unreadCount) || 0);
      const previousPreview = previousPreviewByGroupId.get(group.id);
      if (previousPreview) {
        group._lastPreviewText = previousPreview.text;
        group._lastPreviewTime = previousPreview.time;
      }
      if (group.preloaded && typeof group.preloaded === 'object') {
        const cache = ensureGroupCacheEntry(group.id);
        const preloadedMessages = Array.isArray(group.preloaded.messages)
          ? filterMessagesVisibleToCurrentUser(group.preloaded.messages)
          : [];
        // Merge instead of replace so paginated history survives reconnects
        // and focus resyncs (dedup by message id).
        mergeMessagesIntoCache(group.id, preloadedMessages, { persist: false });
        cache.members = Array.isArray(group.preloaded.members) ? group.preloaded.members : [];
        cache.messageRows = null;
        cache.rowsDirty = true;
        writeLocalGroupCache(group.id, cache);
        if (preloadedMessages.length) {
          void persistHistoryMessages(group.id, preloadedMessages);
          void writeHistoryCursor(group.id, preloadedMessages[preloadedMessages.length - 1].createdAt);
        }
      }
      if (!group._lastPreviewText) {
        const cache = ensureGroupCacheEntry(group.id);
        const cachedMessages = cache.messages || [];
        const lastMessage = cachedMessages.length ? cachedMessages[cachedMessages.length - 1] : null;
        if (lastMessage) {
          group._lastPreviewText = truncate(getMessagePreviewFallbackText(lastMessage), 35);
          group._lastPreviewTime = lastMessage.createdAt ? formatTime(lastMessage.createdAt) : '';
        }
      }
    }
    await loadGroupKeyVaultEntries();
    pushStatus.totalUnreadCount = getTotalUnreadCount();
    renderGroupList();
    // Stay subscribed to every group's room so background groups keep syncing.
    joinAllGroupRooms();
    void refreshGroupPreviewsFromCache(groups.map((group) => group.id));
    syncUnreadIndicators();
    if (isMobileLayout() && !currentGroupId) setMobileView('list');
    return true;
  } catch(err) {
    console.error('loadGroups error:', err);
    return false;
  }
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
  renderGroupAvatarElement(av, g);

  const info = document.createElement('div');
  info.className = 'group-item-info';

  const row = document.createElement('div');
  row.className = 'group-item-row';

  const name = document.createElement('div');
  name.className = 'group-item-name';
  name.textContent = g.name;

  const time = document.createElement('div');
  time.className = 'group-item-time';
  time.id = 'preview-time-' + g.id;
  time.textContent = g._lastPreviewTime || '';
  time.hidden = !g._lastPreviewTime;

  const preview = document.createElement('div');
  preview.className = 'group-item-preview';
  preview.id = 'preview-' + g.id;
  const cache = ensureGroupCacheEntry(g.id);
  preview.textContent = g._lastPreviewText ?? (cache.messages === null ? 'Loading…' : GROUP_PREVIEW_EMPTY_TEXT);

  row.append(name, time);
  info.append(row, preview);

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

function renderGroupAvatarElement(target, group = {}) {
  if (!target) return;
  target.replaceChildren();
  if (isGlobalGroup(group)) {
    target.style.background = 'none';
    target.appendChild(createAvatarImage(GLOBAL_GROUP_ICON_SRC));
    return;
  }
  if (group.groupIcon) {
    target.style.background = 'none';
    target.appendChild(createAvatarImage(group.groupIcon));
    return;
  }
  target.style.background = groupAvatarColor(group);
  target.textContent = String(group.name || '?')[0].toUpperCase();
}

function updateQuickActionButtonState(button, { enabled, labelEnabled }) {
  if (!button) return;
  button.disabled = !enabled;
  button.dataset.label = enabled ? labelEnabled : 'Feature disabled by owner';
  button.title = enabled ? labelEnabled : 'Feature disabled by owner';
}

function canCurrentUserManageGroup() {
  if (!currentGroupData || !currentUser) return false;
  return String(currentGroupData.createdBy) === String(currentUser.id) || !!currentGroupData.viewerIsAdmin;
}

function updateGroupColorAction(canManage) {
  const button = $('set-group-color-btn');
  if (!button) return;
  if (isCurrentGroupGlobal()) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  button.disabled = !canManage;
  button.title = canManage ? 'Change group icon' : 'Only the group owner or an administrator can change the group icon';
}

function updateGroupActionButtons(isOwner) {
  const exportBtn = $('export-btn');
  const clearBtn = $('clear-history-btn');
  const leaveBtn = $('leave-group-btn');
  const disbandBtn = $('disband-btn');

  const isGlobal = isCurrentGroupGlobal();

  // In GChat Global there is no owner or administrator: everyone can export,
  // nobody can clear the full history, and nobody can leave or disband.
  if (isGlobal) {
    updateQuickActionButtonState(exportBtn, { enabled: true, labelEnabled: 'Export chat as TXT' });
    updateQuickActionButtonState(clearBtn, { enabled: false, labelEnabled: 'Clear chat history' });
    if (leaveBtn) {
      leaveBtn.hidden = true;
      leaveBtn.dataset.label = 'Exit group';
    }
    if (disbandBtn) {
      disbandBtn.hidden = true;
      disbandBtn.dataset.label = 'Disband group';
    }
    return;
  }

  const canMemberExport = !!(currentGroupData && currentGroupData.allowMemberExport);
  const canMemberClear = !!(currentGroupData && currentGroupData.allowMemberClear);

  const isAdministrator = !!currentGroupData?.viewerIsAdmin;
  if (isOwner || isAdministrator) {
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
  if (currentGroupData.viewerIsAdmin) return true;
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
  if (normalizedTopic === DEFAULT_TAG_TOPIC) {
    showToast('Cannot delete #main', 'error');
    return;
  }

  const cache = ensureGroupCacheEntry(currentGroupId);
  const msgs = cache.messages || [];
  for (const msg of msgs) await hydrateMessageChannel(msg, currentGroupId);
  const channelMsgs = msgs.filter((msg) => resolveMessageTagTopic(msg) === normalizedTopic);
  const hasMessages = channelMsgs.length > 0;

  if (hasMessages) {
    if (!canCurrentUserClearTag()) {
      showToast('You do not have permission to delete this channel', 'error');
      return;
    }
    const key = getGroupKey(currentGroupId);
    if (!key) return showToast('Chat content is not ready yet', 'error');
    const tagIndex = await GChatCryptoV2.blindIndex(normalizedTopic, key, currentGroupId, 'tag-index');
    const res = await fetch(`/api/groups/${currentGroupId}/tags/${encodeURIComponent(tagIndex)}/messages`, {
      method: 'DELETE',
      headers: apiHeaders(),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'Failed to delete channel', 'error');
      return;
    }
  }

  // Always drop local channel state (works for empty newly created channels too).
  await removeTagMessagesFromCache(currentGroupId, normalizedTopic);
  forgetChannel(currentGroupId, normalizedTopic);
  announceChannelChange(currentGroupId, normalizedTopic, 'remove');
  if (getActiveTagTopic() === normalizedTopic) {
    selectTagChannel(DEFAULT_TAG_TOPIC, { focusComposer: false });
  } else {
    renderTagFilters();
    await renderActiveChannelStream();
  }
  showToast(`Deleted ${formatHashtagLabel(normalizedTopic)}`, 'success');
}

function canCurrentUserKickMember(targetUserId) {
  if (!currentGroupData || !currentUser) return false;
  if (String(targetUserId) === String(currentUser.id)) return false;
  if (String(targetUserId) === String(currentGroupData.createdBy)) return false;
  const isOwner = String(currentGroupData.createdBy) === String(currentUser.id);
  if (isOwner) return true;
  const target = members.find((member) => String(member.id) === String(targetUserId));
  if (target?.isAdministrator) return false;
  if (currentGroupData.viewerIsAdmin) return true;
  return !!currentGroupData.allowMemberKick;
}

function canCurrentUserInviteMembers() {
  if (!currentGroupData || !currentUser) return false;
  if (String(currentGroupData.createdBy) === String(currentUser.id)) return true;
  if (currentGroupData.viewerIsAdmin) return true;
  return currentGroupData.allowMemberInvite !== false;
}

function syncGroupPermissionControls() {
  if (!currentGroupData || !currentUser) return;
  const isGlobal = isCurrentGroupGlobal();
  const canManage = canCurrentUserManageGroup();
  const ownerActions = $('owner-actions');
  const lock = $('owner-permissions-lock');
  if (ownerActions) {
    // GChat Global has no owner or administrator — hide the permissions panel.
    ownerActions.hidden = isGlobal;
    ownerActions.classList.toggle('is-locked', !canManage);
  }
  if (lock) lock.hidden = canManage;
  [
    'allow-member-clear-toggle',
    'allow-member-clear-tag-toggle',
    'allow-member-export-toggle',
    'allow-member-kick-toggle',
    'allow-member-invite-toggle',
  ].forEach((id) => {
    const input = $(id);
    if (input) input.disabled = !canManage;
  });
  if (canManage) syncAllowMemberClearTagToggleState();
}

function updateGroupPreview(groupId, text, time) {
  const el = $('preview-' + groupId);
  const timeLabel = time ? formatTime(time) : '';
  const previewText = truncate(text, 35) || GROUP_PREVIEW_EMPTY_TEXT;
  if (el) el.textContent = previewText;
  const timeEl = $('preview-time-' + groupId);
  if (timeEl) {
    timeEl.textContent = timeLabel;
    timeEl.hidden = !timeLabel;
  }
  const g = groups.find(x => x.id === groupId);
  if (g) {
    g._lastPreviewTime = timeLabel;
    g._lastPreviewText = previewText;
  }
}

function getMessagePreviewFallbackText(msg) {
  if (!msg) return '';
  const aiMentionPrefix = msg.aiMention ? `${buildAiMentionLabel(msg.aiMeta)} ` : '';
  const typeLabel = getMessageTypePreviewLabel(msg);
  return typeLabel ? aiMentionPrefix + typeLabel : aiMentionPrefix + MSG_CONTENT_UNAVAILABLE;
}

async function getMessagePreviewText(msg, groupId = msg.groupId) {
  if (!msg) return '';
  const fallbackPreview = getMessagePreviewFallbackText(msg);
  const key = getGroupKey(groupId);
  if (!key || msg.type !== 'text') return fallbackPreview;
  const aiMentionPrefix = msg.aiMention ? `${buildAiMentionLabel(msg.aiMeta)} ` : '';
  const plaintext = await decryptMessageText(msg, key, groupId).catch(() => null);
  return aiMentionPrefix + (plaintext ?? MSG_CONTENT_UNAVAILABLE);
}

async function updateGroupPreviewFromMessage(groupId, msg) {
  if (!msg) {
    updateGroupPreview(groupId, '', null);
    return;
  }
  const preview = await getMessagePreviewText(msg, groupId);
  updateGroupPreview(groupId, preview, msg.createdAt);
}

async function refreshGroupPreviewsFromCache(groupIds) {
  const targetGroupIds = Array.isArray(groupIds) ? groupIds : groups.map((group) => group.id);
  const tasks = [];
  for (const groupId of targetGroupIds) {
    const cache = ensureGroupCacheEntry(groupId);
    const lastMessage = cache.messages && cache.messages.length ? cache.messages[cache.messages.length - 1] : null;
    if (!lastMessage) continue;
    tasks.push(updateGroupPreviewFromMessage(groupId, lastMessage));
  }
  if (tasks.length) await Promise.allSettled(tasks);
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

// Mark-read state is batched: viewport flushes mark many rows at once, and a
// full-cache localStorage write + unread recompute per row is O(n²). Instead,
// accumulate per group and flush once per microtask.
let pendingBatchReads = new Map(); // groupId -> Set<messageId>
let batchReadFlushScheduled = false;

function scheduleBatchReadFlush() {
  if (batchReadFlushScheduled) return;
  batchReadFlushScheduled = true;
  queueMicrotask(() => {
    batchReadFlushScheduled = false;
    flushBatchReads();
  });
}

function flushBatchReads() {
  if (!pendingBatchReads.size) return;
  const byGroup = pendingBatchReads;
  pendingBatchReads = new Map();
  for (const [groupId, messageIds] of byGroup) {
    const cache = ensureGroupCacheEntry(groupId);
    let changed = false;
    for (const msg of cache.messages || []) {
      if (!messageIds.has(String(msg.id))) continue;
      if (msg.hasRead !== true) {
        msg.hasRead = true;
        changed = true;
      }
    }
    if (changed) {
      writeLocalGroupCache(groupId, cache);
      syncGroupUnreadCount(groupId);
    }
  }
}

function markMessageReadLocal(groupId, messageId) {
  const normalizedGroupId = String(groupId || '');
  const normalizedMessageId = String(messageId || '');
  if (!normalizedGroupId || !normalizedMessageId) return;
  let ids = pendingBatchReads.get(normalizedGroupId);
  if (!ids) {
    ids = new Set();
    pendingBatchReads.set(normalizedGroupId, ids);
  }
  ids.add(normalizedMessageId);
  scheduleBatchReadFlush();
}

// v1.3.9: batched read-receipt emission — one packet per group per tick instead
// of one socket emit per row. Buffered while disconnected; flushed on reconnect.
let pendingReadEmits = new Map();
let readEmitTimer = null;
function queueMarkReadEmit(groupId, messageId) {
  let ids = pendingReadEmits.get(groupId);
  if (!ids) {
    ids = new Set();
    pendingReadEmits.set(groupId, ids);
  }
  ids.add(messageId);
  if (readEmitTimer) return;
  readEmitTimer = setTimeout(() => {
    readEmitTimer = null;
    flushMarkReadEmits();
  }, 250);
}

function flushMarkReadEmits() {
  if (readEmitTimer) {
    clearTimeout(readEmitTimer);
    readEmitTimer = null;
  }
  if (!pendingReadEmits.size) return;
  const byGroup = pendingReadEmits;
  pendingReadEmits = new Map();
  for (const [groupId, messageIds] of byGroup) {
    if (!socket || !socket.connected) continue;
    socket.emit('mark_messages_read', { groupId, messageIds: [...messageIds] });
  }
}

function markMessageReadConfirmed(messageId) {
  const stored = allMessages.find((m) => String(m.id) === String(messageId));
  if (stored) stored.readConfirmed = true;
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
    if (!msg || !canCurrentUserAccessMessage(msg) || isMessageHiddenForCurrentUser(msg) || msg.senderId === currentUser?.id) return acc;
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
  const normalizedGroupId = String(groupId || '');
  if (!normalizedGroupId) return;
  currentGroupId = normalizedGroupId;
  currentGroupData = groups.find(g => String(g.id) === normalizedGroupId) || null;
  replyingTo = null;
  pendingAttachmentRows.clear();
  whisperRecipients = [];
  messageMode = 'normal';
  // Restore the last channel the user had open in this group (default #main).
  ensureActiveTag(readStoredChannel(normalizedGroupId));
  composerTokens.whisper = null;
  composerTokens.hashtag = null;
  syncComposerTokens();
  updateWhisperBtn();
  resetReadTracking();

  scrollUnreadCount = 0;
  updateScrollBadge();

  // Update sidebar active state
  document.querySelectorAll('.group-item').forEach(el => {
    el.classList.toggle('active', el.dataset.groupId === normalizedGroupId);
  });

  // Show chat area
  $('chat-empty').hidden = true;
  $('chat-active').hidden = false;
  $('reply-preview-bar').hidden = true;

  // Set header
  $('chat-group-name').textContent = currentGroupData ? currentGroupData.name : '';
  $('edit-group-name-input').value = currentGroupData ? currentGroupData.name : '';
  // GChat Global cannot be renamed.
  $('edit-group-name-input').readOnly = isCurrentGroupGlobal();
  syncRightPanelMobileTitle();
  $('right-panel-content').hidden = false;
  $('right-panel-empty').hidden = true;
  renderTagFilters();

  // GChat Global has no invite code to share — every user is already in it.
  const isGlobal = isCurrentGroupGlobal();
  const copyCodeBtn = $('copy-code-btn');
  if (copyCodeBtn) copyCodeBtn.hidden = isGlobal;

  // Owner controls
  const isOwner = currentGroupData && currentGroupData.createdBy === currentUser.id;
  syncGroupPermissionControls();
  updateGroupColorAction(canCurrentUserManageGroup());
  $('common-actions').hidden = false;
  if (currentGroupData) {
    $('allow-member-clear-toggle').checked = !!currentGroupData.allowMemberClear;
    $('allow-member-clear-tag-toggle').checked = !!currentGroupData.allowMemberClearTag;
    $('allow-member-export-toggle').checked = !!currentGroupData.allowMemberExport;
    $('allow-member-kick-toggle').checked = !!currentGroupData.allowMemberKick;
    $('allow-member-invite-toggle').checked = currentGroupData.allowMemberInvite !== false;
    $('ai-mode-toggle').checked = !!currentGroupData.aiEnabled;
  }
  syncAllowMemberClearTagToggleState();
  syncGroupPermissionControls();
  updateAiControls();
  updateGroupActionButtons(isOwner);

  // Key state
  updateKeyState();

  // Socket room
  if (socket) {
    socket.emit('join_room', normalizedGroupId);
    trackJoinedRoom(normalizedGroupId);
  }

  const cache = ensureGroupCacheEntry(normalizedGroupId);
  // v1.3.9: hydrate durable IndexedDB history before first render so the
  // transcript is never blank while the server window loads.
  if (!cache.messages || cache.messages.length === 0) {
    const history = await readHistoryMessages(normalizedGroupId);
    if (history && history.length) {
      cache.messages = mergeMessagesIntoCache(normalizedGroupId, history, { persist: false });
      cache.rowsDirty = true;
    }
  }
  const hadCompleteCache = !!(cache.messages && cache.members && cache.messageRows);
  if (!cache.messages || !cache.members || !cache.messageRows) {
    messagesArea().replaceChildren(createLoadMoreIndicator());
    members = [];
    renderMembersList();
    renderWhisperPicker();
    $('chat-member-count').textContent = 'Loading…';
    await ensureGroupDataPreloaded(normalizedGroupId);
    if (currentGroupId !== normalizedGroupId) return;
  }
  renderGroupFromCache(normalizedGroupId);
  updateGroupUnseenCount(normalizedGroupId, allMessages);
  observeCurrentGroupRowsForRead();
  scrollToBottom(true);
  $('scroll-bottom-btn').hidden = true;
  // v1.3.9: reading the group counts as "seen" — stop the title blink even if
  // the window itself isn't focused (e.g. multiple windows on one account).
  if (document.hasFocus()) clearPageTitleNotification();
  // v1.3.8: a fully-cached group may be stale (messages missed while the tab
  // was backgrounded or the app tray-hidden) — silently resync from the server.
  if (hadCompleteCache) void refreshCurrentGroupFromServer();

  closeMobileActionMenu();
  if (isMobileLayout()) setMobileView('chat');
}

function updateKeyState() {
  const modalBlockingInput = !$('grok-modal').hidden;
  const input = $('message-input');
  const sendBtn = $('send-btn');
  const blockedStatus = $('composer-blocked-status');
  input.disabled = modalBlockingInput;
  const groupName = currentGroupData?.name ? String(currentGroupData.name) : 'group';
  const channel = formatHashtagLabel(getActiveTagTopic());
  const whisperRecipients = getActiveWhisperRecipientIds();
  if (modalBlockingInput) {
    input.placeholder = 'Complete Ask AI first…';
  } else if (messageMode === 'whisper' && whisperRecipients.length) {
    input.placeholder = `Whisper to ${formatWhisperRecipientLabel(whisperRecipients, currentGroupId, { prefix: '' })} · ${channel} · ${groupName}`;
  } else if (messageMode === 'disappearing') {
    input.placeholder = `Disappearing message ${channel} · ${groupName}`;
  } else {
    input.placeholder = `Message ${channel} · ${groupName}`;
  }
  if (modalBlockingInput) input.setAttribute('aria-describedby', 'composer-blocked-status');
  else input.removeAttribute('aria-describedby');
  sendBtn.disabled = modalBlockingInput;
  setComposerShellDisabled(modalBlockingInput);
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
      if (res.status === 401) { handleSessionExpired(); return; }
      return;
    }
    const rawMsgs = await res.json();
    const msgs = filterMessagesVisibleToCurrentUser(rawMsgs);
    if (!before) {
      const cache = ensureGroupCacheEntry(groupId);
      // Merge instead of replace: preserve previously paginated history while
      // refreshing the newest server window (dedup by message id).
      const merged = mergeMessagesIntoCache(groupId, msgs);
      cache.messageRows = await buildMessageRows(merged, groupId);
      cache.oldestMessageId = merged.length ? merged[0].id : null;
      cache.rowsDirty = false;
      writeLocalGroupCache(groupId, cache);
      updateGroupUnseenCount(groupId, merged);
      await updateGroupPreviewFromMessage(groupId, merged.length ? merged[merged.length - 1] : null);
      if (msgs.length) void writeHistoryCursor(groupId, msgs[msgs.length - 1].createdAt);
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
      const cache = ensureGroupCacheEntry(groupId);
      cache.messages = mergeMessagesIntoCache(groupId, msgs, { persist: false });
      cache.messageRows = [...rows, ...(cache.messageRows || [])];
      cache.oldestMessageId = rawMsgs[0].id;
      cache.rowsDirty = false;
      writeLocalGroupCache(groupId, cache);
      // Restore scroll position
      area.scrollTop = area.scrollHeight - prevScrollHeight;
    }
    if (groupId === currentGroupId) {
      allMessages = ensureGroupCacheEntry(groupId).messages || allMessages;
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

    // Role/kick actions are placed BEFORE the role tag so the tag stays flush
    // right on every row — "Admin" must align with "Owner" even while the
    // hover-reveal action buttons occupy space.
    const isOwner = String(currentGroupData?.createdBy) === String(currentUser?.id);
    if (isOwner && String(m.id) !== String(currentGroupData?.createdBy)) {
      const roleBtn = document.createElement('button');
      roleBtn.className = `member-role-btn ${m.isAdministrator ? 'is-demote' : 'is-promote'}`;
      const roleLabel = m.isAdministrator ? 'Remove administrator privilege' : 'Promote to administrator';
      roleBtn.title = roleLabel;
      roleBtn.setAttribute('aria-label', roleLabel);
      setElementIcon(roleBtn, m.isAdministrator ? 'shield-minus' : 'shield-plus', { iconOnly: true });
      roleBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        updateMemberAdministrator(m, !m.isAdministrator);
      });
      li.appendChild(roleBtn);
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

    if (currentGroupData && m.id === currentGroupData.createdBy) {
      const tag = document.createElement('span');
      tag.className = 'member-owner-tag';
      tag.textContent = 'Owner';
      li.appendChild(tag);
    } else if (m.isAdministrator) {
      const tag = document.createElement('span');
      tag.className = 'member-owner-tag';
      tag.textContent = 'Admin';
      li.appendChild(tag);
    }

    list.appendChild(li);
  }
}

function renderWhisperPicker() {
  const list = $('whisper-picker-list');
  if (!list) return;
  list.innerHTML = '';
  const activeRecipientIds = getActiveWhisperRecipientIds();
  syncWhisperPickerStatus(activeRecipientIds.length, pendingWhisperCommandStart != null);
  for (const m of members) {
    if (m.id === currentUser.id) continue;
    const item = document.createElement('div');
    item.className = 'whisper-picker-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'wp-' + m.id;
    cb.value = m.id;
    cb.checked = activeRecipientIds.some((id) => normalizeId(id) === normalizeId(m.id));
    cb.addEventListener('change', () => {
      if (pendingWhisperCommandStart != null) consumePendingWhisperCommand();
      if (cb.checked) {
        setWhisperTokenFromMember(m);
      } else {
        whisperRecipients = whisperRecipients.filter((id) => normalizeId(id) !== normalizeId(m.id));
      }
      whisperRecipients = getUniqueWhisperRecipientIds(whisperRecipients);
      syncComposerTokens();
      syncWhisperPickerStatus();
      updateWhisperBtn();
      updateSlashCommandMenu();
    });
    const lbl = document.createElement('label');
    lbl.htmlFor = 'wp-' + m.id;
    const avatar = document.createElement('span');
    avatar.className = 'whisper-picker-avatar';
    renderAvatarElement(avatar, m);
    const name = document.createElement('span');
    name.className = 'whisper-picker-name';
    name.textContent = m.username;
    lbl.append(avatar, name);
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
  if (!canCurrentUserAccessMessage(msg, currentUser?.id)) return null;
  if (isMessageHiddenForCurrentUser(msg)) return null;
  const messageKey = groupId ? getGroupKey(groupId) : null;
  if (Number(msg.encryptionVersion) === 2 && messageKey) {
    msg._decryptedText = await decryptV2Message(msg, messageKey, groupId).catch(() => null);
  }
  // Channel is part of encrypted metadata for v2 — hydrate before filtering.
  await hydrateMessageChannel(msg, groupId);

  const row = document.createElement('div');
  row.className = 'msg-row'
    + (isOwn ? ' own' : '')
    + (msg.type === 'whisper' ? ' whisper' : '')
    // A recipient must not be able to distinguish a disappearing message.
    + (isOwn && isDisappearingMessage(msg) ? ' disappearing' : '');
  row.dataset.msgId = msg.id;
  row.dataset.groupId = groupId;
  row.dataset.senderId = msg.senderId;
  row.dataset.hashtag = resolveMessageTagTopic(msg);
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

  // A compact author header starts each series. All messages remain left aligned (Discord).
  if (showSenderName) {
    const nameEl = document.createElement('span');
    nameEl.className = 'msg-sender-name';
    nameEl.textContent = memberProfile?.username || msg.senderName || 'Unknown';
    const nameColor = memberProfile?.iconColor || msg.senderColor || null;
    if (nameColor) nameEl.style.color = nameColor;
    const headerTime = document.createElement('time');
    headerTime.className = 'msg-header-time';
    headerTime.dateTime = msg.createdAt;
    headerTime.textContent = formatTime(msg.createdAt);
    headerTime.title = formatFullMessageTime(msg.createdAt);
    const header = document.createElement('div');
    header.className = 'msg-header';
    header.append(nameEl, headerTime);
    content.appendChild(header);
  } else {
    row.classList.add('series-continued');
    const continuationTime = document.createElement('time');
    continuationTime.className = 'msg-continuation-time';
    continuationTime.dateTime = msg.createdAt;
    continuationTime.textContent = formatTime(msg.createdAt);
    continuationTime.title = formatFullMessageTime(msg.createdAt);
    av.replaceChildren(continuationTime);
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
    wl.textContent = formatWhisperMessageLabel(msg, groupId);
    prefixRow.appendChild(wl);
    hasPrefixContent = true;
  }

  if (isOwn && isDisappearingMessage(msg)) {
    const disappearingLabel = document.createElement('span');
    disappearingLabel.className = 'disappearing-label';
    const seconds = Math.max(1, Math.round((Number(msg.disappearingDurationMs) || MIN_DISAPPEARING_DURATION_MS) / 1000));
    disappearingLabel.textContent = `Disappears ${seconds}s after read`;
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
  if (msg.replyToId) {
    const groupMessages = ensureGroupCacheEntry(groupId).messages || allMessages;
    const targetExists = groupMessages.some((entry) => entry.id === msg.replyToId);
    const replyPreview = msg.replyPreview;
    const rb = document.createElement('div');
    rb.className = 'msg-reply-box';
    const renderReplyPreview = () => {
      const senderName = replyPreview && replyPreview.senderName ? replyPreview.senderName : 'a message';
      const preview = replyPreview && replyPreview.preview ? truncate(replyPreview.preview, 60) : '';
      rb.innerHTML = '<span class="msg-reply-sender">Replying to ' + escapeHtml(senderName) + '</span> ' + escapeHtml(preview);
      rb.addEventListener('click', () => scrollToMessage(msg.replyToId));
    };
    if (!targetExists) {
      // The target is outside the loaded window or was deleted. Render the
      // self-contained preview from this message's metadata instead of an
      // error, and hydrate the target in the background when it still exists.
      if (replyPreview) {
        rb.innerHTML = '<span class="msg-reply-sender">Replying to ' + escapeHtml(replyPreview.senderName || '') + '</span> ' + escapeHtml(truncate(replyPreview.preview || '', 60));
        rb.classList.add('msg-reply-unavailable');
      } else if (msg.replyTargetMissing) {
        rb.textContent = 'Replying to a deleted message';
      } else {
        rb.textContent = 'Replying to, original message unavailable';
      }
      if (!msg.replyTargetMissing) {
        void hydrateMissingReplyTarget(groupId, msg.replyToId).then((target) => {
          if (!target) return;
          rb.classList.remove('msg-reply-unavailable');
          if (replyPreview) renderReplyPreview();
          else {
            const fallbackPreview = target.type === 'text' ? '' : '[attachment]';
            rb.innerHTML = '<span class="msg-reply-sender">Replying to ' + escapeHtml(target.senderName || '') + '</span> ' + escapeHtml(fallbackPreview);
            rb.addEventListener('click', () => scrollToMessage(msg.replyToId));
          }
        });
      }
    } else if (replyPreview) {
      renderReplyPreview();
    }
    bubble.appendChild(rb);
  } else if (msg.replyTo) {
    try {
      const rData = typeof msg.replyTo === 'string' ? JSON.parse(msg.replyTo) : msg.replyTo;
      const rb = document.createElement('div');
      rb.className = 'msg-reply-box';
      rb.innerHTML = '<span class="msg-reply-sender">Replying to ' + escapeHtml(rData.senderName || '') + '</span> ' + escapeHtml(truncate(rData.preview || '', 60));
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
  meta.title = formatFullMessageTime(msg.createdAt);
  if (msg.editedAt) {
    const editedBadge = document.createElement('span');
    editedBadge.className = 'msg-edited-badge';
    editedBadge.textContent = ' (edited)';
    meta.appendChild(editedBadge);
  }
  const deliveryEl = document.createElement('span');
  deliveryEl.className = 'msg-delivery';
  deliveryEl.id = 'del-' + msg.id;
  const { total, read } = normalizeDeliveryCounts(resolveDeliveryRecipientCount(msg, groupId), msg.readCount);
  deliveryEl.dataset.totalRecipients = String(total);
  deliveryEl.dataset.readCount = String(read);
  renderDeliveryTicks(deliveryEl, total, read);
  meta.appendChild(deliveryEl);

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
    const attachmentRow = document.createElement('div');
    attachmentRow.className = 'msg-attachment-row';
    attachmentRow.append(textEl, meta);
    bubble.appendChild(attachmentRow);
  }

  const aiMetaEl = isAiAssistant ? createAiMetaElement(msg.aiMeta) : null;
  if (aiMetaEl) bubble.appendChild(aiMetaEl);

  content.appendChild(bubble);

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const addAction = (label, icon, handler) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'msg-action-btn';
    button.title = label;
    button.setAttribute('aria-label', label);
    setElementIcon(button, icon, { iconOnly: true });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      showContextMenu(null, msg, textEl.textContent);
      handler();
    });
    actions.appendChild(button);
  };
  if (!isDisappearingMessage(msg)) addAction('Reply', 'reply', () => $('ctx-reply').click());
  if (!isDisappearingMessage(msg) && isOwn && ['text', 'whisper'].includes(msg.type)) addAction('Edit', 'pencil', () => $('ctx-edit').click());
  if (!isDisappearingMessage(msg) && isOwn) addAction('Delete', 'trash-2', () => $('ctx-delete').click());
  if (!isDisappearingMessage(msg)) {
    const mobileActionsButton = document.createElement('button');
    mobileActionsButton.type = 'button';
    mobileActionsButton.className = 'msg-action-btn msg-mobile-actions-btn';
    mobileActionsButton.title = 'Message actions';
    mobileActionsButton.setAttribute('aria-label', 'Message actions');
    setElementIcon(mobileActionsButton, 'more-horizontal', { iconOnly: true });
    mobileActionsButton.addEventListener('click', (event) => {
      event.stopPropagation();
      showContextMenu(null, msg, textEl.textContent);
    });
    actions.appendChild(mobileActionsButton);
  }
  content.appendChild(actions);

  // Right-click context menu
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e, msg, textEl.textContent);
  });

  // Long-press for mobile
  let longPressTimer;
  bubble.addEventListener('touchstart', () => {
    longPressTimer = setTimeout(() => showContextMenu(null, msg, textEl.textContent), 600);
  });
  bubble.addEventListener('touchend', () => clearTimeout(longPressTimer));
  bubble.addEventListener('touchcancel', () => clearTimeout(longPressTimer));
  bubble.addEventListener('touchmove', () => clearTimeout(longPressTimer), { passive: true });

  row.append(av, content);

  scheduleDisappearingTimerForMessage(msg);

  return row;
}

async function renderMsgContent(msg, textEl, bubble, groupId = currentGroupId) {
  const key = groupId ? getGroupKey(groupId) : null;

  if (msg.type === 'image') {
    if (!key) {
      const locked = document.createElement('div');
      locked.className = 'msg-image-locked';
      locked.appendChild(createIcon('lock'));
      textEl.appendChild(locked);
    } else {
      const buf = await decryptAttachmentBytes(msg, key, groupId);
      if (buf) {
        const mimeType = detectImageMime(buf) || 'image/jpeg';
        const blob = new Blob([buf], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const img = document.createElement('img');
        img.className = 'msg-image';
        img.src = url;
        img.alt = 'image';
        img.style.cursor = 'pointer';
        await new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        });
        img.addEventListener('click', (e) => {
          e.stopPropagation();
          showImageViewer(blob, msg.filename || 'image');
        });
        textEl.appendChild(img);
      } else {
        const locked = document.createElement('div');
        locked.className = 'msg-image-locked';
        locked.appendChild(createIcon('lock'));
        textEl.appendChild(locked);
      }
    }
    return;
  }

  if (msg.type === 'file') {
    if (!key) {
      textEl.textContent = 'File unavailable: ' + (msg.filename || 'file');
    } else {
      const buf = await decryptAttachmentBytes(msg, key, groupId);
      if (buf) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'msg-file-btn';
        const fileIcon = document.createElement('span');
        fileIcon.className = 'msg-file-icon';
        fileIcon.appendChild(createIcon('file'));
        btn.appendChild(fileIcon);
        const info = document.createElement('span');
        info.className = 'msg-file-info';
        const fileName = document.createElement('strong');
        fileName.textContent = msg.filename || 'file';
        const fileMeta = document.createElement('small');
        const extension = (msg.filename || '').split('.').pop()?.toUpperCase() || 'FILE';
        fileMeta.textContent = `${extension} · ${formatBytes(buf.byteLength)}`;
        info.append(fileName, fileMeta);
        btn.appendChild(info);
        const downloadLabel = document.createElement('span');
        downloadLabel.className = 'msg-file-download-label';
        downloadLabel.textContent = 'Download';
        btn.appendChild(downloadLabel);
        btn.addEventListener('click', (e) => {
          const blob = new Blob([buf]);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = msg.filename || 'download';
          a.click(); URL.revokeObjectURL(url);
        });
        textEl.appendChild(btn);
      } else {
        textEl.textContent = 'File unavailable: ' + (msg.filename || 'file');
      }
    }
    return;
  }

  // Text message
  if (!key) {
    renderPlainText(textEl, MSG_CONTENT_UNAVAILABLE);
    return;
  }

  const plaintext = msg._decryptedText ?? await decryptMessageText(msg, key, groupId).catch(() => null);
  if (plaintext === null) {
    renderPlainText(textEl, MSG_CONTENT_UNAVAILABLE);
  } else {
    if (isAiAssistantMessage(msg)) renderMarkdown(textEl, plaintext);
    else renderPlainText(textEl, plaintext);
  }
}

async function appendMessageBubble(msg, scroll, groupId = currentGroupId) {
  await hydrateMessageChannel(msg, groupId);
  const channel = resolveMessageTagTopic(msg);

  // During a group switch, `allMessages` may still reference the previous
  // group's array — anchor it to THIS group's own cache before reading/writing
  // so a realtime message can never corrupt the new group's transcript.
  const cache = ensureGroupCacheEntry(groupId);
  if (groupId === currentGroupId) {
    allMessages = Array.isArray(cache.messages) ? cache.messages : [];
  }

  // Series against last message *in this channel*, not the whole group timeline.
  let previousInChannel = null;
  for (let i = allMessages.length - 1; i >= 0; i -= 1) {
    if (resolveMessageTagTopic(allMessages[i]) === channel) {
      previousInChannel = allMessages[i];
      break;
    }
  }
  const showSenderName = !shouldContinueSeries(previousInChannel, msg);
  const row = await buildMessageRow(msg, groupId, { showSenderName });
  if (!row) return;

  const area = messagesArea();
  const wasNearBottom = area
    ? (area.scrollHeight - area.scrollTop - area.clientHeight < 150)
    : false;

  // v1.3.9: merge (dedup by id) instead of append so a late socket echo can
  // never produce a duplicate row; sorted insert keeps ordering stable.
  allMessages = mergeMessagesIntoCache(groupId, [msg]);
  cache.rowsDirty = true;
  cache.messageRows = null;
  if (historyDbSupported) void persistHistoryMessages(groupId, [msg]);
  rememberChannel(groupId, channel);
  renderTagFilters();

  // Independent channel streams: only paint into the DOM when it belongs here.
  if (groupId !== currentGroupId || !messageMatchesActiveTag(msg)) return row;
  if (!area) return row;

  // Remove empty state if present.
  area.querySelector('.channel-empty-state')?.remove();

  if (!previousInChannel || !isSameMessageDay(previousInChannel.createdAt, msg.createdAt)) {
    area.appendChild(createDateDivider(msg.createdAt));
  }
  row.hidden = false;
  area.appendChild(row);
  observeMessageForRead(row, msg);

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
  composerTokens.hashtag = null;
  composerTokens.whisper = null;
  whisperRecipients = [];
  messageMode = 'normal';
  hideWhisperPicker();
  ensureActiveTag(activeTagFilter || DEFAULT_TAG_TOPIC);
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

function scrollToBottom(skipAnimation) {
  const area = messagesArea();
  if (!area) return;
  area.scrollTo({ top: area.scrollHeight, behavior: skipAnimation ? 'auto' : 'smooth' });
  scrollUnreadCount = 0;
  updateScrollBadge();
  $('scroll-bottom-btn').hidden = true;
}

function scrollToMessage(msgId) {
  const row = document.querySelector('[data-msg-id="' + msgId + '"]');
  if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Fetches a single message that is referenced by a quote but missing from the
// bounded local cache (e.g. older than the loaded window) and merges it in.
async function hydrateMissingReplyTarget(groupId, messageId) {
  try {
    const res = await fetch(`/api/groups/${groupId}/messages/${encodeURIComponent(messageId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.id) return null;
    const cache = ensureGroupCacheEntry(groupId);
    if (cache.messages && !cache.messages.some((entry) => entry.id === data.id)) {
      cache.messages.push(data);
      cache.messages.sort((a, b) => {
        const timeDiff = String(a.createdAt).localeCompare(String(b.createdAt));
        return timeDiff !== 0 ? timeDiff : String(a.id).localeCompare(String(b.id));
      });
      writeLocalGroupCache(groupId, cache);
    }
    return data;
  } catch {
    return null;
  }
}

// ── Context menu ──────────────────────────────────────────────────────────────
let ctxMsg = null;
let ctxText = '';
let ctxTagTopic = null;
function showContextMenu(e, msg, text) {
  ctxMsg = msg; ctxText = text;
  hideTagContextMenu();
  hideAvatarContextMenu();
  const menu = $('ctx-menu');
  const isAuthor = msg.senderId === currentUser?.id;
  const isAttachment = msg.type === 'image' || msg.type === 'file';
  const isDisappearing = isDisappearingMessage(msg);
  // In GChat Global every member may delete any message.
  const isGlobalMessageGroup = isGlobalGroupId(msg.groupId || currentGroupId);
  $('ctx-reply').hidden = isDisappearing;
  $('ctx-edit').hidden = isDisappearing || !isAuthor || !['text', 'whisper'].includes(msg.type);
  $('ctx-delete').hidden = isDisappearing || (!isAuthor && !isGlobalMessageGroup);
  $('ctx-download').hidden = true;
  $('ctx-copy').hidden = isAttachment || isDisappearing;
  setElementIcon($('ctx-copy'), 'copy', { label: 'Copy' });
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
  hideAvatarContextMenu();
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

// ── Avatar actions (right-click a profile picture → invite to chat) ──────────
let avatarCtxUserId = null;
let avatarCtxUsername = '';

function showAvatarContextMenu(e, userId, username) {
  avatarCtxUserId = userId;
  avatarCtxUsername = username || 'this user';
  hideContextMenu();
  hideTagContextMenu();
  const menu = $('avatar-ctx-menu');
  const inviteBtn = $('avatar-ctx-invite');
  setElementIcon(inviteBtn, 'user-plus', { label: `Invite ${avatarCtxUsername} to chat` });
  menu.hidden = false;
  if (e) {
    menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
  } else {
    menu.style.left = '50%';
    menu.style.top = '50%';
  }
}

function hideAvatarContextMenu() {
  const menu = $('avatar-ctx-menu');
  if (menu) menu.hidden = true;
  avatarCtxUserId = null;
}

async function openInviteModal() {
  const targetUserId = avatarCtxUserId;
  const targetName = avatarCtxUsername;
  hideAvatarContextMenu();
  if (!targetUserId || !currentUser) return;
  const modal = $('invite-modal');
  const list = $('invite-list');
  const desc = $('invite-desc');
  const errorEl = $('invite-error');
  errorEl.textContent = '';
  $('invite-target-name').textContent = targetName;
  modal.hidden = false;
  list.innerHTML = '<div class="invite-list-empty">Loading chats…</div>';
  try {
    const res = await fetch(`/api/groups/invite-candidates/${encodeURIComponent(targetUserId)}`, { cache: 'no-store' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to load chats');
    }
    const candidateGroups = await res.json();
    if (!Array.isArray(candidateGroups) || !candidateGroups.length) {
      list.innerHTML = `<div class="invite-list-empty">${escapeHtml(targetName)} is already in all of your chats.</div>`;
      return;
    }
    renderInviteCandidateList(list, candidateGroups, targetUserId, targetName);
  } catch (err) {
    errorEl.textContent = err.message || 'Failed to load chats';
    list.innerHTML = '';
  }
}

function renderInviteCandidateList(list, candidateGroups, targetUserId, targetName) {
  list.innerHTML = '';
  for (const group of candidateGroups) {
    const item = document.createElement('div');
    item.className = 'invite-item';
    item.dataset.groupId = group.id;

    const av = document.createElement('div');
    av.className = 'invite-item-avatar';
    if (group.isGlobal || isGlobalGroupId(group.id)) {
      av.style.background = 'none';
      av.appendChild(createAvatarImage(GLOBAL_GROUP_ICON_SRC));
    } else if (group.groupIcon) {
      av.style.background = 'none';
      av.appendChild(createAvatarImage(group.groupIcon));
    } else {
      av.style.background = groupAvatarColor(group);
      av.textContent = String(group.name || '?')[0].toUpperCase();
    }

    const meta = document.createElement('div');
    meta.className = 'invite-item-meta';
    const nameEl = document.createElement('div');
    nameEl.className = 'invite-item-name';
    nameEl.textContent = group.name;
    meta.appendChild(nameEl);
    if (group.isGlobal) {
      const hint = document.createElement('div');
      hint.className = 'invite-item-hint';
      hint.textContent = 'Global channel';
      meta.appendChild(hint);
    }

    const button = document.createElement('button');
    button.className = 'btn-primary btn-sm invite-item-btn';
    button.type = 'button';
    setElementIcon(button, 'user-plus', { label: 'Invite' });
    button.addEventListener('click', () => {
      confirmInviteMember(group, targetUserId, targetName, item);
    });

    item.append(av, meta, button);
    list.appendChild(item);
  }
}

function confirmInviteMember(group, targetUserId, targetName, item) {
  showConfirm(
    'Invite to Chat',
    `Do you want to invite ${targetName} into ${group.name}?`,
    async () => {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.id)}/invite`, {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ userId: targetUserId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || 'Failed to invite member', 'error');
        return;
      }
      showToast(`${targetName} joined ${group.name}`, 'success');
      item.remove();
      const list = $('invite-list');
      if (list && !list.children.length) {
        list.innerHTML = `<div class="invite-list-empty">${escapeHtml(targetName)} is now in all of your chats.</div>`;
      }
    }
  );
}

async function getAttachmentData(msg) {
  if (msg?._viewerData) {
    return {
      blob: msg._viewerData.blob,
      filename: msg._viewerData.filename || 'image',
      mimeType: msg._viewerData.blob.type || 'image/png',
    };
  }
  if (!msg || (msg.type !== 'image' && msg.type !== 'file')) return null;
  const key = currentGroupId ? getGroupKey(currentGroupId) : null;
  if (!key) {
    showToast('Chat content is not ready yet', 'error');
    return null;
  }
  const bytes = await decryptAttachmentBytes(msg, key, currentGroupId);
  if (!bytes) {
    showToast('File unavailable', 'error');
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

async function convertImageBlobToPng(blob) {
  if (blob.type === 'image/png') return blob;
  if (!blob.type.startsWith('image/') || typeof createImageBitmap !== 'function') return null;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } finally {
    bitmap.close?.();
  }
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
      const clipboardBlob = await convertImageBlobToPng(data.blob);
      if (!clipboardBlob) return;
      await navigator.clipboard.write([
        new ClipboardItem({ [clipboardBlob.type]: clipboardBlob }),
      ]);
      showToast('Image copied to clipboard', 'success');
    }
  } catch (err) {
    console.error('copyAttachmentToClipboard error:', err);
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

  // The text node lives inside .msg-body-row, not directly in the bubble.
  // Insert beside it so the editor replaces the message in place.
  textEl.hidden = true;
  textEl.parentNode.insertBefore(editForm, textEl);
  editInput.focus();
  editInput.setSelectionRange(editInput.value.length, editInput.value.length);

  let isSaving = false;
  let isFinished = false;
  const cancelEdit = () => {
    if (isFinished) return;
    isFinished = true;
    editForm.remove();
    textEl.hidden = false;
  };

  const saveEdit = async () => {
    if (isSaving || isFinished) return;
    const newText = editInput.value.trim();
    if (!newText || newText === currentPlaintext) { cancelEdit(); return; }
    const key = getGroupKey(currentGroupId);
    if (!key) { showToast('Chat content is not ready yet', 'error'); cancelEdit(); return; }
    isSaving = true;
    editSave.disabled = true;
    try {
      const nextRevision = Number(msg.revision || 1) + 1;
      const replacement = await encryptV2Message(newText, {
        hashtag: msg.hashtag || null,
        filename: msg.filename || null,
      }, { ...msg, groupId: currentGroupId, revision: nextRevision }, key);
      const tagIndex = msg.hashtag
        ? await GChatCryptoV2.blindIndex(msg.hashtag, key, currentGroupId, 'tag-index')
        : null;
      const spamSignature = await GChatCryptoV2.blindIndex(newText, key, currentGroupId, 'spam-signature');
      const res = await fetch(`/api/groups/${currentGroupId}/messages/${msg.id}`, {
        method: 'PATCH',
        headers: apiHeaders(),
        body: JSON.stringify({
          ...replacement,
          expectedRevision: Number(msg.revision || 1),
          encryptionVersion: 2,
          keyVersion: 1,
          tagIndex,
          spamSignature,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        if (res.status === 409 && d.latest) {
          const cache = ensureGroupCacheEntry(currentGroupId);
          const index = (cache.messages || []).findIndex((entry) => entry.id === msg.id);
          if (index >= 0) cache.messages[index] = d.latest;
          cache.rowsDirty = true;
          await rebuildGroupMessageRows(currentGroupId);
          renderGroupFromCache(currentGroupId);
        }
        showToast(d.error || 'Edit failed', 'error');
        isSaving = false;
        editSave.disabled = false;
        return;
      }
      cancelEdit();
      // The message_edited socket event updates every rendered copy of the message.
    } catch (err) {
      console.error('Edit error:', err);
      showToast('Edit failed', 'error');
      isSaving = false;
      editSave.disabled = false;
    }
  };

  // Keep a Cancel click from blurring the input first (blur saves by design).
  editCancel.addEventListener('mousedown', (e) => e.preventDefault());
  editCancel.addEventListener('click', cancelEdit);
  editInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelEdit();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void saveEdit();
    }
  });
  editInput.addEventListener('blur', () => void saveEdit());
  editSave.addEventListener('click', () => void saveEdit());
}

// ── Send message ──────────────────────────────────────────────────────────────
async function doSend(text) {
  if (!currentGroupId || !socket) return;
  const key = getGroupKey(currentGroupId);
  if (!key) {
    showToast('Chat content is not ready yet', 'error');
    return;
  }
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
  try {
    const messageId = crypto.randomUUID();
    const type = parsedMessage.whisperRecipientIds?.length ? 'whisper' : 'text';
    const messageIdentity = {
      id: messageId,
      groupId: currentGroupId,
      senderId: currentUser.id,
      type,
      encryptionVersion: 2,
      keyVersion: 1,
      revision: 1,
    };
    const metadata = {
      hashtag: parsedMessage.hashtag || null,
      replyPreview: replyingTo ? { senderName: replyingTo.senderName, preview: replyingTo.preview } : null,
    };
    const encrypted = await encryptV2Message(messageText, metadata, messageIdentity, key);
    const { encryptedContent, iv, encryptedMetadata, metadataIv } = encrypted;
    if (estimateBase64Bytes(encryptedContent) > MAX_TEXT_MESSAGE_BYTES) {
      showToast('Message too large', 'error');
      return;
    }
    const hashtag = parsedMessage.hashtag || null;
    const tagIndex = hashtag ? await GChatCryptoV2.blindIndex(hashtag, key, currentGroupId, 'tag-index') : null;
    const replyToId = replyingTo?.id || null;
    const envelope = {
      ...messageIdentity,
      encryptedContent,
      iv,
      encryptedMetadata,
      metadataIv,
      replyToId,
      tagIndex,
      isDisappearing: parsedMessage.isDisappearing,
      disappearingDurationMs: parsedMessage.disappearingDurationMs,
    };

    if (parsedMessage.whisperRecipientIds && parsedMessage.whisperRecipientIds.length > 0) {
      socket.emit('send_whisper', {
        ...envelope,
        whisperTo: parsedMessage.whisperRecipientIds,
      });
    } else {
      socket.emit('send_message', envelope);
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

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  const memberProfile = getMemberProfile(currentGroupId, senderId);
  renderAvatarElement(avatar, {
    username: memberProfile?.username || senderName || currentUser?.username,
    iconColor: memberProfile?.iconColor || senderColor || currentUser?.iconColor,
    profilePicture: memberProfile?.profilePicture || currentUser?.profilePicture || null,
  });

  const content = document.createElement('div');
  content.className = 'msg-content';
  const header = document.createElement('div');
  header.className = 'msg-header';
  const nameEl = document.createElement('div');
  nameEl.className = 'msg-sender-name';
  nameEl.textContent = memberProfile?.username || senderName || currentUser?.username || 'Unknown';
  header.appendChild(nameEl);
  content.appendChild(header);

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
  row.append(avatar, content);
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
      xhr.setRequestHeader('X-Message-Id', body.id);
      xhr.setRequestHeader('X-Encrypted-Metadata', body.encryptedMetadata);
      xhr.setRequestHeader('X-Metadata-IV', body.metadataIv);
      xhr.setRequestHeader('X-Encryption-Version', '2');
      xhr.setRequestHeader('X-Key-Version', '1');
      xhr.setRequestHeader('X-Client-Upload-Id', body.clientUploadId || '');
      if (body.tagIndex) xhr.setRequestHeader('X-Tag-Index', body.tagIndex);
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
    showToast('Chat content is not ready yet', 'error');
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
    socket.emit('attachment_upload_progress', { ...progressPayload, filename: null });
    setPendingAttachmentStatus(uploadId, 'Preparing…');

    const buffer = await processedFile.arrayBuffer();
    updatePendingAttachmentProgress(uploadId, Math.max(1, Math.round(totalBytes * 0.2)), totalBytes);
    setPendingAttachmentStatus(uploadId, 'Encrypting…');
    const messageId = crypto.randomUUID();
    const messageIdentity = { id: messageId, groupId: currentGroupId, senderId: currentUser.id, type: isImage ? 'image' : 'file', keyVersion: 1, revision: 1 };
    const aad = v2Aad(messageIdentity);
    const { encryptedBytes, iv } = await GChatCryptoV2.encryptBytes(buffer, key, currentGroupId, aad);
    // Attachments belong to the active channel (sub-chat), same as text messages.
    const hashtag = getActiveTagTopic();
    const metadataEnvelope = await GChatCryptoV2.encryptJson({ filename: file.name, hashtag }, key, currentGroupId, 'metadata', aad);
    const tagIndex = hashtag ? await GChatCryptoV2.blindIndex(hashtag, key, currentGroupId, 'tag-index') : null;

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
        filename: null,
        loadedBytes: loaded,
        totalBytes: total,
      });
    };

    const body = {
      id: messageId,
      encryptedBytes,
      iv,
      type: isImage ? 'image' : 'file',
      encryptedMetadata: metadataEnvelope.encryptedContent,
      metadataIv: metadataEnvelope.iv,
      tagIndex,
      clientUploadId: uploadId,
    };
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

function formatDiagnosticsValue(value) {
  if (value == null || value === '') return '—';
  return String(value);
}

function formatDiagnosticsTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function getDisplayModeLabel() {
  if (window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true) return 'standalone';
  if (window.matchMedia?.('(display-mode: minimal-ui)').matches) return 'minimal-ui';
  if (window.matchMedia?.('(display-mode: fullscreen)').matches) return 'fullscreen';
  return 'browser';
}

function getServiceWorkerStatusLabel() {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  return navigator.serviceWorker.controller ? 'controlled' : 'not controlled';
}

function getViewportSizeLabel() {
  return `${window.innerWidth} × ${window.innerHeight}`;
}

function getVisualViewportSizeLabel() {
  const vv = window.visualViewport;
  if (!vv) return 'unavailable';
  return `${Math.round(vv.width)} × ${Math.round(vv.height)} @ ${Math.round(vv.offsetTop)}`;
}

function getSafeAreaLabel() {
  const style = getComputedStyle(document.documentElement);
  return [
    `top ${style.getPropertyValue('--safe-area-top').trim() || '0px'}`,
    `right ${style.getPropertyValue('--safe-area-right').trim() || '0px'}`,
    `bottom ${style.getPropertyValue('--safe-area-bottom').trim() || '0px'}`,
    `left ${style.getPropertyValue('--safe-area-left').trim() || '0px'}`,
  ].join(' · ');
}

function resolveConnectionStateLabel() {
  if (socket?.connected) return { state: 'connected', label: 'Connected' };
  if (!socketDiagnostics.isBrowserOnline) return { state: 'offline', label: 'Offline' };
  if (socketDiagnostics.reconnectFailed) return { state: 'disconnected', label: 'Reconnect failed' };
  if (socketDiagnostics.reconnectAttempts > 0) return { state: 'reconnecting', label: `Reconnecting (${socketDiagnostics.reconnectAttempts})` };
  if (socketDiagnostics.lastConnectError) return { state: 'error', label: 'Connection error' };
  return { state: 'connecting', label: 'Connecting…' };
}

function updateConnectionTransport() {
  socketDiagnostics.socketTransport = socket?.io?.engine?.transport?.name || 'unknown';
  socketDiagnostics.socketId = socket?.id || '';
}

function updateReconnectBanner() {
  const banner = $('reconnect-banner');
  const text = $('reconnect-banner-text');
  if (!banner || !text) return;
  if (socket?.connected) {
    banner.hidden = true;
    return;
  }
  const parts = [];
  if (!socketDiagnostics.isBrowserOnline) {
    parts.push('Offline');
  } else if (socketDiagnostics.reconnectFailed) {
    parts.push('Reconnect failed');
  } else if (socketDiagnostics.reconnectAttempts > 0) {
    parts.push(`Reconnecting… (${socketDiagnostics.reconnectAttempts})`);
  } else {
    parts.push('Reconnecting…');
  }
  if (socketDiagnostics.lastDisconnectReason) {
    parts.push(socketDiagnostics.lastDisconnectReason);
  }
  text.textContent = parts.filter(Boolean).join(' · ');
  banner.hidden = false;
}

function updateConnectionStatusUi(stateOverride, labelOverride) {
  const stateInfo = stateOverride
    ? { state: stateOverride, label: labelOverride || resolveConnectionStateLabel().label }
    : resolveConnectionStateLabel();
  socketDiagnostics.connectionState = stateInfo.state;
  const status = $('conn-status');
  const label = $('conn-label');
  $('conn-dot').className = stateInfo.state === 'connected' ? 'conn-dot connected' : 'conn-dot';
  if (status) {
    status.dataset.state = stateInfo.state;
    status.classList.add('is-actionable');
  }
  if (label) label.textContent = stateInfo.label;
  updateReconnectBanner();
}

function renderDiagnosticsPanel() {
  const grid = $('diagnostics-grid');
  if (!grid) return;
  const fields = [
    ['App version', appVersionLabel],
    ['Display mode', getDisplayModeLabel()],
    ['Current URL', window.location.href],
    ['Service worker', getServiceWorkerStatusLabel()],
    ['Online status', socketDiagnostics.isBrowserOnline ? 'online' : 'offline'],
    ['Health status', socketDiagnostics.healthStatus],
    ['Health latency', socketDiagnostics.healthLatencyMs == null ? '—' : `${socketDiagnostics.healthLatencyMs} ms`],
    ['Health checked', formatDiagnosticsTime(socketDiagnostics.healthCheckedAt)],
    ['Health edge', socketDiagnostics.healthEdge || '—'],
    ['Health request id', socketDiagnostics.healthRequestId || '—'],
    ['Server time', formatDiagnosticsTime(socketDiagnostics.healthServerTime)],
    ['Railway environment', socketDiagnostics.healthEnvironment || '—'],
    ['Socket connected', socket?.connected ? 'true' : 'false'],
    ['Socket id', socketDiagnostics.socketId || '—'],
    ['Transport', socketDiagnostics.socketTransport],
    ['Last connect', formatDiagnosticsTime(socketDiagnostics.lastConnectAt)],
    ['Last disconnect', formatDiagnosticsTime(socketDiagnostics.lastDisconnectAt)],
    ['Last disconnect reason', socketDiagnostics.lastDisconnectReason || '—'],
    ['Last connect error', socketDiagnostics.lastConnectError || '—'],
    ['Last error time', formatDiagnosticsTime(socketDiagnostics.lastConnectErrorAt)],
    ['Reconnect attempts', socketDiagnostics.reconnectAttempts],
    ['Viewport', getViewportSizeLabel()],
    ['Visual viewport', getVisualViewportSizeLabel()],
    ['Safe area', getSafeAreaLabel()],
    ['User agent', navigator.userAgent],
  ];
  grid.innerHTML = '';
  for (const [label, value] of fields) {
    const item = document.createElement('div');
    item.className = 'diagnostics-item';
    const labelEl = document.createElement('span');
    labelEl.className = 'diagnostics-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = 'diagnostics-value';
    valueEl.textContent = formatDiagnosticsValue(value);
    item.append(labelEl, valueEl);
    grid.appendChild(item);
  }
}

async function refreshDiagnosticsHealth() {
  const startedAt = performance.now();
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const latency = Math.max(0, Math.round(performance.now() - startedAt));
    const data = await res.json().catch(() => ({}));
    const diagnostics = data?.diagnostics && typeof data.diagnostics === 'object' ? data.diagnostics : {};
    if (res.ok && data.ok === true) socketDiagnostics.healthStatus = 'ok';
    else if (res.ok) socketDiagnostics.healthStatus = 'degraded';
    else socketDiagnostics.healthStatus = 'error';
    socketDiagnostics.healthLatencyMs = latency;
    socketDiagnostics.healthCheckedAt = data?.checkedAt || new Date().toISOString();
    socketDiagnostics.healthEdge = diagnostics.railwayEdge || '';
    socketDiagnostics.healthRequestId = diagnostics.railwayRequestId || '';
    socketDiagnostics.healthServerTime = diagnostics.serverTime || '';
    socketDiagnostics.healthEnvironment = diagnostics.railwayEnvironment || '';
  } catch {
    socketDiagnostics.healthStatus = 'unreachable';
    socketDiagnostics.healthLatencyMs = null;
    socketDiagnostics.healthCheckedAt = new Date().toISOString();
    socketDiagnostics.healthEdge = '';
    socketDiagnostics.healthRequestId = '';
    socketDiagnostics.healthServerTime = '';
    socketDiagnostics.healthEnvironment = '';
  }
  renderDiagnosticsPanel();
}

function openDiagnosticsModal() {
  $('diagnostics-modal').hidden = false;
  updateConnectionTransport();
  renderDiagnosticsPanel();
  void refreshDiagnosticsHealth();
}

function closeDiagnosticsModal() {
  $('diagnostics-modal').hidden = true;
}

let socketHasConnectedOnce = false;

async function refreshCurrentGroupAfterReconnect({ fullSync = false } = {}) {
  try {
    // A genuine reconnect resyncs every group in one bounded request (preload
    // refreshes message tails, members, previews, and unread counts). The
    // initial boot keeps the light path — no eager transcript hydration.
    await loadGroups({ withBackendPreload: fullSync });
    if (!currentGroupId) return;
    await Promise.all([loadMessages(currentGroupId), loadMembers(currentGroupId)]);
    if (currentGroupId) {
      renderGroupFromCache(currentGroupId);
      observeCurrentGroupRowsForRead();
      if (composerNearBottomBeforeFocus || isNearBottom()) scrollToBottom(true);
    }
  } catch (err) {
    console.warn('Failed to refresh current group after reconnect:', err);
  }
}

let lastFocusStateSyncAt = 0;

// v1.3.8: when the tab regains focus after being backgrounded and the socket
// is down, resync everything so nothing was missed. Throttled to bound load.
function syncStateOnFocus() {
  const now = Date.now();
  if (now - lastFocusStateSyncAt < 30 * 1000) return;
  lastFocusStateSyncAt = now;
  if (!socket?.connected) {
    void loadGroups({ withBackendPreload: true });
    if (currentGroupId) void refreshCurrentGroupFromServer();
  }
}

function manualReconnectSocket() {
  if (!socket) return;
  socketDiagnostics.reconnectAttempts = 0;
  socketDiagnostics.reconnectFailed = false;
  socketDiagnostics.lastConnectError = '';
  socketDiagnostics.lastConnectErrorAt = '';
  updateConnectionStatusUi('connecting', 'Reconnecting…');
  socket.disconnect();
  socket.connect();
}

function bindOnlineOfflineListeners() {
  const syncOnlineState = () => {
    socketDiagnostics.isBrowserOnline = navigator.onLine !== false;
    if (!socketDiagnostics.isBrowserOnline) {
      updateConnectionStatusUi('offline');
    } else if (socket?.connected) {
      updateConnectionStatusUi('connected');
    } else {
      updateConnectionStatusUi(socketDiagnostics.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
      if (socket) socket.connect();
    }
    renderDiagnosticsPanel();
  };
  window.addEventListener('online', syncOnlineState);
  window.addEventListener('offline', syncOnlineState);
  syncOnlineState();
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────
function initSocket() {
  socket = io({
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 900,
    reconnectionDelayMax: 8000,
    timeout: 20000,
  });
  updateConnectionTransport();
  renderDiagnosticsPanel();

  socket.on('connect', () => {
    socketDiagnostics.connectionState = 'connected';
    socketDiagnostics.lastConnectError = '';
    socketDiagnostics.lastConnectErrorAt = '';
    socketDiagnostics.lastConnectAt = new Date().toISOString();
    socketDiagnostics.reconnectAttempts = 0;
    socketDiagnostics.reconnectFailed = false;
    updateConnectionTransport();
    updateConnectionStatusUi('connected', 'Connected');
    console.info('[socket] connect', {
      id: socket.id,
      transport: socketDiagnostics.socketTransport,
    });
    if (currentGroupId) socket.emit('join_room', currentGroupId);
    joinAllGroupRooms();
    // v1.3.9: flush any read receipts that were queued while offline.
    flushMarkReadEmits();
    if (socketHasConnectedOnce) {
      // Real reconnect: full resync so messages missed while offline appear.
      void refreshCurrentGroupAfterReconnect({ fullSync: true });
    } else {
      socketHasConnectedOnce = true;
      void refreshCurrentGroupAfterReconnect();
    }
    renderDiagnosticsPanel();
  });

  socket.on('disconnect', (reason) => {
    socketDiagnostics.lastDisconnectReason = reason || 'unknown';
    socketDiagnostics.lastDisconnectAt = new Date().toISOString();
    // Server-side rooms die with the socket — re-join everything on reconnect.
    joinedRoomIds = new Set();
    updateConnectionTransport();
    updateConnectionStatusUi(socketDiagnostics.isBrowserOnline ? 'disconnected' : 'offline', socketDiagnostics.isBrowserOnline ? 'Disconnected' : 'Offline');
    console.warn('[socket] disconnect', { reason });
    pendingDisappearingStartMessageIds = new Set();
    // v1.3.9: receipts emitted into a dying socket must be retried after the
    // reconnect — clear the pending set so visible rows re-emit.
    pendingReadMessageIds.clear();
    clearAllMessageVisibilityTimers();
    renderDiagnosticsPanel();
  });

  socket.on('connect_error', (error) => {
    socketDiagnostics.lastConnectError = error?.message || 'unknown';
    socketDiagnostics.lastConnectErrorAt = new Date().toISOString();
    updateConnectionStatusUi(socketDiagnostics.isBrowserOnline ? 'error' : 'offline', socketDiagnostics.isBrowserOnline ? 'Connection error' : 'Offline');
    console.warn('[socket] connect_error', { message: socketDiagnostics.lastConnectError });
    renderDiagnosticsPanel();
  });

  socket.io.on('reconnect_attempt', (attempt) => {
    socketDiagnostics.reconnectAttempts = Number(attempt) || socketDiagnostics.reconnectAttempts + 1;
    updateConnectionStatusUi('reconnecting');
    updateReconnectBanner();
    console.info('[socket] reconnect_attempt', { attempt: socketDiagnostics.reconnectAttempts });
    renderDiagnosticsPanel();
  });

  socket.io.on('reconnect', (attempt) => {
    socketDiagnostics.reconnectAttempts = Number(attempt) || 0;
    socketDiagnostics.reconnectFailed = false;
    updateConnectionTransport();
    updateConnectionStatusUi('connected', 'Connected');
    console.info('[socket] reconnect', {
      attempt: socketDiagnostics.reconnectAttempts,
      transport: socketDiagnostics.socketTransport,
    });
    renderDiagnosticsPanel();
  });

  socket.io.on('reconnect_failed', () => {
    socketDiagnostics.reconnectFailed = true;
    updateConnectionStatusUi('disconnected', 'Reconnect failed');
    updateReconnectBanner();
    console.warn('[socket] reconnect_failed');
    renderDiagnosticsPanel();
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
    // Increment page title notification if document is not focused
    if (!document.hasFocus() && msg.senderId !== currentUser.id) {
      unreadNotificationCount++;
      updatePageTitleNotification();
    }

    // v1.3.9: dedup — a socket echo can overlap a REST fetch that already
    // contains the same message id; never insert a duplicate.
    if (cacheHasMessage(msg.groupId, msg.id)) {
      if (msg.clientUploadId) removePendingAttachment(msg.clientUploadId);
      return;
    }

    if (msg.groupId !== currentGroupId) {
      applyCurrentUserReadState(msg);
      const cache = ensureGroupCacheEntry(msg.groupId);
      if (cache.messages) {
        mergeMessagesIntoCache(msg.groupId, [msg]);
        trimBackgroundGroupCache(cache);
        writeLocalGroupCache(msg.groupId, cache);
      } else {
        mergeMessagesIntoCache(msg.groupId, [msg], { persist: false });
      }
      if (historyDbSupported) void persistHistoryMessages(msg.groupId, [msg]);
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
        sendNativeNotification(totalUnread, msg.groupId, { senderName: msg.senderName, preview });
      }
      if (msg.clientUploadId) removePendingAttachment(msg.clientUploadId);
      return;
    }
    applyCurrentUserReadState(msg);
    await appendMessageBubble(msg, true, msg.groupId);
    if (msg.clientUploadId) removePendingAttachment(msg.clientUploadId);
    if (msg.senderId !== currentUser.id) {
      observeCurrentGroupRowsForRead();
      syncGroupUnreadCount(msg.groupId);
    }
    // Update preview
    const preview2 = await getMessagePreviewText(msg, msg.groupId);
    updateGroupPreview(msg.groupId, preview2, msg.createdAt);
    // Desktop notifications are shown for every incoming message, including
    // the active group. The native app decides how the popup is presented.
    if (msg.senderId !== currentUser.id) {
      const totalUnread = getTotalUnreadCount();
      pushStatus.totalUnreadCount = totalUnread;
      sendNativeNotification(totalUnread, msg.groupId, { senderName: msg.senderName, preview: preview2 });
    }
  });

  socket.on('message_read_update', ({ messageId, readCount }) => {
    pendingReadMessageIds.delete(messageId);
    markMessageReadConfirmed(messageId);
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
      revokeBlobUrlsIn(row);
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

  socket.on('message_edited', async (updated) => {
    const messageId = updated.id || updated.messageId;
    const { encryptedContent, iv, editedAt, revision } = updated;
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
          const pt = await decryptMessageText(updated, key, currentGroupId).catch(() => null);
          textEl.textContent = pt !== null ? pt : MSG_CONTENT_UNAVAILABLE;
        } else {
          textEl.textContent = MSG_CONTENT_UNAVAILABLE;
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
      // Edits re-encrypt BOTH content and metadata with AAD revision N+1 —
      // the stale metadata ciphertext would fail GCM auth on the next render.
      stored.encryptedContent = encryptedContent;
      stored.iv = iv;
      stored.encryptedMetadata = updated.encryptedMetadata ?? stored.encryptedMetadata;
      stored.metadataIv = updated.metadataIv ?? stored.metadataIv;
      if (updated.tagIndex !== undefined) stored.tagIndex = updated.tagIndex;
      stored.editedAt = editedAt;
      stored.revision = revision;
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
    if (historyDbSupported) void clearGroupHistoryStore(groupId);
    if (groupId !== currentGroupId) return;
    renderGroupFromCache(groupId);
    renderTagFilters();
    addSystemMessage('Chat history was cleared');
  });

  socket.on('tag_cleared', async ({ groupId, tagIndex }) => {
    const cache = ensureGroupCacheEntry(groupId);
    const msgs = cache.messages || [];
    for (const message of msgs) await hydrateMessageChannel(message, groupId);
    let removedTopic = null;
    cache.messages = msgs.filter((message) => {
      if (tagIndex && message.tagIndex && message.tagIndex === tagIndex) {
        removedTopic = resolveMessageTagTopic(message);
        return false;
      }
      return true;
    });
    if (removedTopic) forgetChannel(groupId, removedTopic);
    cache.rowsDirty = true;
    cache.messageRows = null;
    writeLocalGroupCache(groupId, cache);
    if (groupId === currentGroupId) {
      allMessages = cache.messages;
      if (removedTopic && getActiveTagTopic() === removedTopic) {
        selectTagChannel(DEFAULT_TAG_TOPIC, { focusComposer: false });
      } else {
        renderTagFilters();
        await renderActiveChannelStream();
      }
    }
  });

  socket.on('group_renamed', ({ groupId, newName }) => {
    const g = groups.find(x => x.id === groupId);
    if (g) g.name = newName;
    if (groupId === currentGroupId) {
      $('chat-group-name').textContent = newName;
      $('edit-group-name-input').value = newName;
      syncRightPanelMobileTitle();
    }
    renderGroupList();
  });

  socket.on('group_settings_updated', ({ groupId, allowMemberClear, allowMemberClearTag, allowMemberExport, allowMemberKick, allowMemberInvite, aiEnabled, groupColor, groupIcon }) => {
    const group = groups.find((g) => g.id === groupId);
    if (group) {
      if (allowMemberClear !== undefined) group.allowMemberClear = !!allowMemberClear;
      if (allowMemberClearTag !== undefined) group.allowMemberClearTag = !!allowMemberClearTag;
      if (allowMemberExport !== undefined) group.allowMemberExport = !!allowMemberExport;
      if (allowMemberKick !== undefined) group.allowMemberKick = !!allowMemberKick;
      if (allowMemberInvite !== undefined) group.allowMemberInvite = !!allowMemberInvite;
      if (aiEnabled !== undefined) group.aiEnabled = !!aiEnabled;
      if (groupColor !== undefined) group.groupColor = groupColor || null;
      if (groupIcon !== undefined) group.groupIcon = groupIcon || null;
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
      if (allowMemberInvite !== undefined) currentGroupData.allowMemberInvite = !!allowMemberInvite;
      if (aiEnabled !== undefined) currentGroupData.aiEnabled = !!aiEnabled;
      if (groupColor !== undefined) currentGroupData.groupColor = groupColor || null;
      if (groupIcon !== undefined) currentGroupData.groupIcon = groupIcon || null;
    }
    const isOwner = currentGroupData && currentGroupData.createdBy === currentUser.id;
    if (canCurrentUserManageGroup()) {
      $('allow-member-clear-toggle').checked = !!currentGroupData.allowMemberClear;
      $('allow-member-clear-tag-toggle').checked = !!currentGroupData.allowMemberClearTag;
      $('allow-member-export-toggle').checked = !!currentGroupData.allowMemberExport;
      $('allow-member-kick-toggle').checked = !!currentGroupData.allowMemberKick;
      $('allow-member-invite-toggle').checked = currentGroupData.allowMemberInvite !== false;
      $('ai-mode-toggle').checked = !!currentGroupData.aiEnabled;
    }
    syncAllowMemberClearTagToggleState();
    syncGroupPermissionControls();
    updateGroupColorAction(canCurrentUserManageGroup());
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
      syncGroupPermissionControls();
      updateGroupColorAction(canCurrentUserManageGroup());
      updateGroupActionButtons(isOwner);
      renderMembersList();
    }
    renderGroupList();
  });

  socket.on('member_joined', ({ userId, username, iconColor, profilePicture, groupId }) => {
    const cache = ensureGroupCacheEntry(groupId);
    if (cache.members && !cache.members.find(m => m.id === userId)) {
      cache.members.push({ id: userId, username, iconColor, profilePicture: profilePicture || null, isAdministrator: false });
      writeLocalGroupCache(groupId, cache);
    }
    if (groupId !== currentGroupId) return;
    addSystemMessage(username + ' joined the group');
    members = cache.members || members;
    renderMembersList();
    renderWhisperPicker();
    $('chat-member-count').textContent = members.length + ' member' + (members.length !== 1 ? 's' : '');
  });

  socket.on('group_invited', async (groupPayload) => {
    if (!groupPayload || !groupPayload.id || !groupPayload.secret || !currentUser) return;
    const normalizedGroupId = String(groupPayload.id);
    if (groups.some((group) => String(group.id) === normalizedGroupId)) return;
    groups.push({
      ...groupPayload,
      id: normalizedGroupId,
      _lastPreviewText: GROUP_PREVIEW_EMPTY_TEXT,
      _lastPreviewTime: '',
    });
    unreadCounts[normalizedGroupId] = 0;
    const entry = { groupId: normalizedGroupId, secret: groupPayload.secret, joinCode: groupPayload.joinCode || null };
    try {
      await GChatCryptoV2.keyVault.put(entry);
    } catch { /* vault failure falls back to /api/groups/keys recovery */ }
    groupKeyVaultCache.set(normalizedGroupId, entry);
    // Subscribe to the new group's room so its messages arrive in realtime.
    if (socket) {
      socket.emit('join_room', normalizedGroupId);
      trackJoinedRoom(normalizedGroupId);
    }
    renderGroupList();
    syncUnreadIndicators();
    pushStatus.totalUnreadCount = getTotalUnreadCount();
    showToast(`You were invited to ${groupPayload.name || 'a new chat'}`, 'success');
  });

  socket.on('member_role_updated', ({ userId, groupId, isAdministrator }) => {
    const cache = ensureGroupCacheEntry(groupId);
    const cachedMember = cache.members?.find((member) => String(member.id) === String(userId));
    if (cachedMember) cachedMember.isAdministrator = !!isAdministrator;
    writeLocalGroupCache(groupId, cache);
    if (groupId !== currentGroupId) return;
    const currentMember = members.find((member) => String(member.id) === String(userId));
    if (currentMember) currentMember.isAdministrator = !!isAdministrator;
    if (String(userId) === String(currentUser?.id) && currentGroupData) {
      currentGroupData.viewerIsAdmin = !!isAdministrator;
      const group = groups.find((item) => String(item.id) === String(groupId));
      if (group) group.viewerIsAdmin = !!isAdministrator;
      syncGroupPermissionControls();
      updateGroupColorAction(canCurrentUserManageGroup());
      updateGroupActionButtons(currentGroupData.createdBy === currentUser.id);
    }
    renderMembersList();
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
        setMobileView('list');
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
      setMobileView('list');
      addSystemMessage('This group has been disbanded');
    }
  });

  socket.on('group_join_denied', async ({ groupId }) => {
    const normalizedGroupId = String(groupId || '');
    if (!normalizedGroupId) return;
  await loadGroups();
  // v1.3.9: fold existing localStorage caches into the durable IndexedDB
  // history store (one-time, best-effort).
  void migrateLocalCachesToHistory();
    if (currentGroupId !== normalizedGroupId) return;
    if (groups.some((group) => String(group.id) === normalizedGroupId)) return;
    currentGroupId = null;
    currentGroupData = null;
    members = [];
    $('chat-active').hidden = true;
    $('chat-empty').hidden = false;
    $('right-panel-content').hidden = true;
    $('right-panel-empty').hidden = false;
    renderMembersList();
    renderWhisperPicker();
    setMobileView('list');
  });

  socket.on('presence_update', ({ groupId, onlineUserIds }) => {
    if (groupId !== currentGroupId) return;
    onlineUsers = new Set(onlineUserIds);
    renderMembersList();
  });

  socket.on('channel_announced', ({ groupId, channel, action }) => {
    const topic = normalizeHashtagTopic(channel);
    if (!groupId || !topic || topic === DEFAULT_TAG_TOPIC) return;
    if (action === 'remove') {
      forgetChannel(groupId, topic);
      if (String(currentGroupId) === String(groupId) && getActiveTagTopic() === topic) {
        selectTagChannel(DEFAULT_TAG_TOPIC, { focusComposer: false });
        return;
      }
    } else {
      rememberChannel(groupId, topic);
    }
    if (String(currentGroupId) === String(groupId)) {
      renderTagFilters();
    }
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
    $('typing-indicator').classList.add('is-visible');
    clearTimeout(window._typingTimer);
    window._typingTimer = setTimeout(() => $('typing-indicator').classList.remove('is-visible'), 3000);
  });

  socket.on('user_stop_typing', () => {
    $('typing-indicator').classList.remove('is-visible');
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
      cancelWhisperSelection();
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
  const isMobileLayout = typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 768px)').matches;
  const maxH = Math.min(Math.floor(window.innerHeight * 0.4), isMobileLayout ? 220 : 180);
  el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
  if (keepBottomPinned) pinMessagesToBottom();
}

// ── Whisper mode ──────────────────────────────────────────────────────────────
function updateWhisperBtn() {
  const keepBottomPinned = isMessagesPinnedToBottom();
  const btn = $('whisper-mode-btn');
  const whisperActive = messageMode === 'whisper';
  const disappearingActive = messageMode === 'disappearing';
  if (whisperActive) {
    setElementIcon(btn, 'megaphone', { iconOnly: true, label: 'Whisper message mode' });
    btn.classList.add('whisper-active');
    btn.classList.remove('disappearing-active');
    if (!whisperRecipients.length && whisperPickerMode == null) $('whisper-picker').hidden = true;
  } else if (disappearingActive) {
    setElementIcon(btn, 'timer', { iconOnly: true, label: 'Disappearing message mode' });
    btn.classList.remove('whisper-active');
    btn.classList.add('disappearing-active');
    hideWhisperPicker();
  } else {
    setElementIcon(btn, 'message-square', { iconOnly: true });
    btn.classList.remove('whisper-active');
    btn.classList.remove('disappearing-active');
    hideWhisperPicker();
  }
  const composer = $('message-input-bar');
  composer?.classList.toggle('whisper-mode-active', whisperActive);
  composer?.classList.toggle('disappearing-mode-active', disappearingActive);
  updateKeyState();
  syncWhisperPickerStatus();
  if (keepBottomPinned) pinMessagesToBottom();
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

async function updateMemberAdministrator(member, isAdministrator) {
  if (!member || !currentGroupId) return;
  const action = isAdministrator ? 'Promote' : 'Demote';
  const description = isAdministrator
    ? `Give ${member.username} administrator access to group permissions and moderation?`
    : `Remove administrator access from ${member.username}?`;
  showConfirm(`${action} member`, description, async () => {
    const res = await fetch(`/api/groups/${currentGroupId}/members/${member.id}/administrator`, {
      method: 'PATCH',
      headers: apiHeaders(),
      body: JSON.stringify({ isAdministrator }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || `Failed to ${action.toLowerCase()} member`, 'error');
      return;
    }
    showToast(
      isAdministrator ? `${member.username} is now an administrator` : `${member.username} is now a group member`,
      'success'
    );
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
  const normalizedTerm = term ? term.toLowerCase() : '';
  rows.forEach(row => {
    const textEl = row.querySelector('.msg-text');
    if (!textEl) { row.style.display = ''; return; }
    if (!normalizedTerm) {
      // When clearing search, just show all rows without expensive re-rendering.
      // Only re-render if a highlight was previously applied.
      if (row.dataset.searchHighlighted) {
        delete row.dataset.searchHighlighted;
        const markdownSource = textEl.dataset.markdownSource;
        if (markdownSource != null) renderMarkdown(textEl, markdownSource);
        else renderPlainText(textEl, textEl.textContent);
      }
      row.style.display = '';
      return;
    }
    const text = textEl.textContent;
    if (text.toLowerCase().includes(normalizedTerm)) {
      count++;
      row.style.display = '';
      const markdownSource = textEl.dataset.markdownSource;
      if (markdownSource != null) renderMarkdown(textEl, markdownSource);
      else renderPlainText(textEl, textEl.textContent);
      highlightText(textEl, term);
      row.dataset.searchHighlighted = '1';
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
      const pt = await decryptMessageText(msg, key, currentGroupId).catch(() => null);
      content = pt ?? MSG_CONTENT_UNAVAILABLE;
    } else {
      content = MSG_CONTENT_UNAVAILABLE;
    }
    let replyPrefix = '';
    const reply = msg.replyPreview || (() => {
      try { return msg.replyTo ? (typeof msg.replyTo === 'string' ? JSON.parse(msg.replyTo) : msg.replyTo) : null; } catch { return null; }
    })();
    if (msg.replyToId || reply) {
      replyPrefix = 'Replying to, ' + (reply?.senderName || 'original message') + ': ' + (reply?.preview || 'Original message unavailable') + ' — ';
    }
    lines.push('[' + time + '] ' + (msg.senderName || 'Unknown') + ': ' + replyPrefix + content);
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

async function loadAndRenderAiTones() {
  if (!aiFeatureEnabled) return;
  try {
    const res = await fetch('/api/ai/tones');
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (!data.tones || typeof data.tones !== 'object') return;
    const tones = data.tones;
    const keys = Object.keys(tones);
    if (!keys.length) return;
    // Update AI_TONE_LABELS with fetched data
    for (const key of keys) {
      if (tones[key] && typeof tones[key].label === 'string') {
        AI_TONE_LABELS[key] = tones[key].label;
      }
    }
    // Remove old keys no longer in server tones
    for (const key of Object.keys(AI_TONE_LABELS)) {
      if (!tones[key]) delete AI_TONE_LABELS[key];
    }
    // Render tone buttons into the container
    const container = $('grok-tone-toggle');
    if (!container) return;
    container.replaceChildren();
    for (const key of keys) {
      const label = (tones[key] && tones[key].label) || (key.charAt(0).toUpperCase() + key.slice(1));
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'grok-model-option grok-tone-option';
      btn.dataset.tone = key;
      btn.setAttribute('aria-pressed', 'false');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        $('grok-tone-input').value = key;
        syncAiModalSelectionUi();
        updateAskAiSubmitButton();
      });
      container.appendChild(btn);
    }
    syncAiModalSelectionUi();
  } catch {
    // best effort — default tone buttons remain if fetch fails
  }
}

function resetGrokModalState() {
  grokResponseDraft = '';
  grokResponseModel = '';
  grokResponseMeta = null;
  grokRequestSource = 'panel';
  grokRequestHashtag = null;
  $('grok-prompt-input').value = '';
  $('grok-model-input').value = DEFAULT_AI_MODEL;
  $('grok-mode-input').value = DEFAULT_AI_MODE === 'fast' ? '0' : '1';
  $('grok-tone-input').value = DEFAULT_AI_TONE;
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
  const value = String($('grok-tone-input').value || DEFAULT_AI_TONE).trim().toLowerCase();
  return AI_TONE_LABELS[value] ? value : DEFAULT_AI_TONE;
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
  document.querySelectorAll('.grok-tone-option').forEach((button) => {
    const isActive = button.dataset.tone === selectedTone;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
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

function formatDesktopUpdateStatus(status) {
  if (!status || typeof status !== 'object') {
    return 'Check for desktop updates when connected.';
  }
  if (status.state === 'error') return status.error || 'Update check failed.';
  if (status.message) return status.message;
  switch (status.state) {
    case 'checking':
      return 'Checking for updates…';
    case 'up-to-date':
      return 'You are up to date.';
    case 'available':
      return status.availableVersion
        ? `Update ${status.availableVersion} is available.`
        : 'An update is available.';
    case 'downloading':
      return Number.isFinite(status.percent)
        ? `Downloading… ${status.percent}%`
        : 'Downloading update…';
    case 'ready':
      return 'Update ready to install.';
    case 'idle':
    default:
      return status.currentVersion
        ? `Version ${status.currentVersion}`
        : 'Check for desktop updates when connected.';
  }
}

let desktopUpdateCheckTimeout = null;

function renderDesktopUpdateStatus(status) {
  const row = $('desktop-update-row');
  const statusEl = $('desktop-update-status');
  const checkBtn = $('desktop-check-update-btn');
  const installBtn = $('desktop-install-update-btn');
  const releaseBtn = $('desktop-open-release-btn');
  if (!row || !statusEl) return;

  if (!window.electronAPI?.checkForUpdates) {
    row.hidden = true;
    return;
  }

  row.hidden = false;
  statusEl.textContent = formatDesktopUpdateStatus(status);
  statusEl.dataset.state = status?.state || 'idle';

  // v1.3.9: watchdog — a check stuck in 'checking' (e.g. no HTTP timeout on
  // some shells) must not disable the button forever.
  if (desktopUpdateCheckTimeout) {
    clearTimeout(desktopUpdateCheckTimeout);
    desktopUpdateCheckTimeout = null;
  }
  if (status?.state === 'checking' || status?.state === 'downloading') {
    desktopUpdateCheckTimeout = setTimeout(() => {
      desktopUpdateCheckTimeout = null;
      if (document.visibilityState === 'hidden') return;
      renderDesktopUpdateStatus({ state: 'error', error: 'Update check timed out. Try again.' });
    }, 45_000);
  }

  if (checkBtn) {
    checkBtn.disabled = status?.state === 'checking' || status?.state === 'downloading';
  }
  if (installBtn) {
    // v1.3.9: the install button is the primary action while an update is
    // available (both shells download+install in one click). Previously it
    // only appeared at state==='ready', which Tauri never published — so the
    // button was unclickable/never shown even when an update was available.
    const showInstall = status?.state === 'available' || status?.state === 'ready';
    installBtn.hidden = !showInstall;
    installBtn.disabled = status?.state === 'downloading' || status?.state === 'checking';
  }
  if (releaseBtn) {
    const showRelease = status?.state === 'available'
      || status?.state === 'ready'
      || status?.state === 'error';
    releaseBtn.hidden = !showRelease;
  }
}

function bindDesktopUpdateUi() {
  const row = $('desktop-update-row');
  if (!row || !window.electronAPI?.checkForUpdates) {
    if (row) row.hidden = true;
    return;
  }

  row.hidden = false;
  renderDesktopUpdateStatus({ state: 'idle' });

  if (typeof window.electronAPI.getUpdateStatus === 'function') {
    void window.electronAPI.getUpdateStatus().then((status) => {
      renderDesktopUpdateStatus(status);
    }).catch(() => {
      renderDesktopUpdateStatus({ state: 'idle' });
    });
  }

  if (typeof window.electronAPI.onUpdateStatus === 'function') {
    window.electronAPI.onUpdateStatus((status) => {
      renderDesktopUpdateStatus(status);
    });
  }

  $('desktop-check-update-btn')?.addEventListener('click', async () => {
    renderDesktopUpdateStatus({ state: 'checking', message: 'Checking for updates…' });
    try {
      const status = await window.electronAPI.checkForUpdates();
      renderDesktopUpdateStatus(status || { state: 'error', error: 'No response from updater.' });
      if (status?.state === 'up-to-date') {
        showToast('You are up to date', 'success');
      } else if (status?.state === 'available' || status?.state === 'ready') {
        showToast(formatDesktopUpdateStatus(status), 'success');
      } else if (status?.state === 'error') {
        showToast(status.error || 'Update check failed', 'error');
      }
    } catch (error) {
      const message = error?.message || 'Update check failed';
      renderDesktopUpdateStatus({ state: 'error', error: message });
      showToast(message, 'error');
    }
  });

  $('desktop-install-update-btn')?.addEventListener('click', async () => {
    try {
      const ok = await window.electronAPI.installUpdate?.();
      if (!ok) showToast('Install is not ready yet', 'error');
    } catch (error) {
      showToast(error?.message || 'Failed to install update', 'error');
    }
  });

  $('desktop-open-release-btn')?.addEventListener('click', async () => {
    try {
      await window.electronAPI.openLatestRelease?.();
    } catch (error) {
      showToast(error?.message || 'Could not open release page', 'error');
    }
  });
}

function openProfileModal() {
  closeMobileActionMenu();
  void refreshAiUsageSummary();
  $('profile-username').value = currentUser.username;
  $('profile-color').value = currentUser.iconColor;
  $('profile-error').textContent = '';
  // Reset an unfinished pick; image mode immediately restores the saved-avatar preview.
  clearProfilePictureSelection();
  syncProfilePictureModeUI();
  updateProfileRemoveButton();
  const colorInput = $('profile-color');
  const swatch = $('profile-color-swatch');
  const value = $('profile-color-value');
  if (colorInput && swatch) swatch.style.background = colorInput.value;
  if (colorInput && value) value.textContent = String(colorInput.value || '').toUpperCase();
  renderProfileAiUsage();
  if (window.electronAPI?.getUpdateStatus) {
    void window.electronAPI.getUpdateStatus().then(renderDesktopUpdateStatus).catch(() => {});
  } else {
    renderDesktopUpdateStatus(null);
  }
  $('profile-modal').hidden = false;
}

async function logoutCurrentUser() {
  await fetch('/api/auth/logout', { method: 'POST', headers: apiHeaders() });
  window.location.href = 'index.html';
}

async function buildGrokContextMessages(groupId, options = {}) {
  const key = getGroupKey(groupId);
  if (!key) throw new Error('Chat content is not ready yet');

  const normalizedTag = normalizeHashtagTopic(options.tagFilter || null);
  const snapshot = Array.isArray(options.sourceMessages) ? options.sourceMessages : allMessages;
  const sourceMessages = (snapshot || [])
    .filter((msg) => !normalizedTag || getMessageHashtagKey(msg) === normalizedTag)
    .slice(-GROK_CONTEXT_MESSAGE_LIMIT);
  const resolved = await Promise.all(sourceMessages.map(async (msg) => {
    if (!msg) return null;
    if (msg.type === 'whisper' || msg.type === 'image' || msg.type === 'file' || isDisappearingMessage(msg)) return null;

    let content = '';
    const plaintext = await decryptMessageText(msg, key, groupId).catch(() => null);
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
  const tagFilter = grokRequestHashtag || null;
  grokResponseDraft = '';
  grokResponseModel = '';
  grokResponseMeta = null;
  $('grok-error').textContent = '';
  setGrokResponse('', '', null);
  setGrokBusy(true, 'Preparing AI message…');

  try {
    const key = getGroupKey(groupId);
    if (!key) throw new Error('Chat content is not ready yet');

    let replyToData = null;
    if (replyingTo) {
      replyToData = JSON.stringify({
        id: replyingTo.id,
        senderName: replyingTo.senderName,
        preview: replyingTo.preview,
      });
    }

    // v1.3.9: the Ask-AI prompt is a normal v2 message with AI markers — build
    // the full v2 envelope (previously the send_message payload was missing
    // id/encryptedMetadata/metadataIv/replyToId/tagIndex and always failed).
    const messageId = crypto.randomUUID();
    const messageIdentity = {
      id: messageId,
      groupId,
      senderId: currentUser.id,
      type: 'text',
      encryptionVersion: 2,
      keyVersion: 1,
      revision: 1,
    };
    const metadata = {
      hashtag: tagFilter,
      replyPreview: replyingTo ? { senderName: replyingTo.senderName, preview: replyingTo.preview } : null,
    };
    const encryptedPrompt = await encryptV2Message(prompt, metadata, messageIdentity, key);
    if (estimateBase64Bytes(encryptedPrompt.encryptedContent) > MAX_TEXT_MESSAGE_BYTES) {
      throw new Error('Message too large');
    }
    const tagIndex = tagFilter ? await GChatCryptoV2.blindIndex(tagFilter, key, groupId, 'tag-index') : null;

    await emitSocketWithAck('send_message', {
      ...messageIdentity,
      encryptedContent: encryptedPrompt.encryptedContent,
      iv: encryptedPrompt.iv,
      encryptedMetadata: encryptedPrompt.encryptedMetadata,
      metadataIv: encryptedPrompt.metadataIv,
      replyToId: replyingTo?.id || null,
      tagIndex,
      isDisappearing: false,
      disappearingDurationMs: 0,
      aiMention: true,
      aiMeta: { model, mode, tone, webSearchEnabled: false },
    });

    resetComposerAfterSend();

    if (requestSource === 'chat') {
      // Chat mode: close modal immediately, fire-and-forget background request
      setGrokBusy(false);
      closeGrokModal();
      showToast('AI request sent', 'success');
      void sendAiReplyInBackground({
        groupId,
        groupName,
        prompt,
        model,
        mode,
        tone,
        tagFilter,
        sourceMessages: sourceMessagesSnapshot,
        replyToData,
        key,
      });
      return;
    }

    // Panel mode: keep modal open and await AI response
    const modelLabel = getAiModelLabel(model);
    const modeLabel = getAiModeLabel(mode);
    setGrokBusy(true, `Asking ${modelLabel} in ${modeLabel} mode…`);
    const result = await requestAiResponse(groupId, {
      groupName,
      prompt,
      model,
      mode,
      tone,
      tagFilter,
      sourceMessages: sourceMessagesSnapshot,
      skipBusyUi: true,
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

async function openUserManagementModal() {
  closeMobileActionMenu();
  $('user-management-error').textContent = '';
  setUserManagementLoading();
  $('user-management-modal').hidden = false;
  await loadUserManagementSummary();
}

// ── Event listeners ───────────────────────────────────────────────────────────
function setupEventListeners() {
  // Logout
  $('logout-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    await logoutCurrentUser();
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
  $('open-diagnostics-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openDiagnosticsModal();
  });
  $('conn-status').addEventListener('click', (event) => {
    if (event.target.closest('#open-diagnostics-btn')) return;
    openDiagnosticsModal();
  });
  $('reconnect-diagnostics-btn').addEventListener('click', openDiagnosticsModal);
  $('reconnect-now-btn').addEventListener('click', () => {
    manualReconnectSocket();
    void refreshDiagnosticsHealth();
  });
  $('update-reload-btn').addEventListener('click', () => {
    const banner = $('update-available-banner');
    if (banner) banner.hidden = true;
    hostedAppReloadPending = false;
    void reloadAppShell();
  });
  $('diagnostics-refresh-btn').addEventListener('click', () => {
    updateConnectionTransport();
    renderDiagnosticsPanel();
    void refreshDiagnosticsHealth();
  });
  $('diagnostics-reconnect-btn').addEventListener('click', () => {
    manualReconnectSocket();
    void refreshDiagnosticsHealth();
  });
  $('diagnostics-close-btn').addEventListener('click', closeDiagnosticsModal);
  $('diagnostics-close-footer-btn').addEventListener('click', closeDiagnosticsModal);
  $('diagnostics-modal').addEventListener('click', (e) => {
    if (e.target !== $('diagnostics-modal')) return;
    closeDiagnosticsModal();
  });
  // User-list entry is desktop-hidden; mobile menu still opens management if present.
  const userListBtn = $('sidebar-user-list-btn');
  if (userListBtn) {
    userListBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await openUserManagementModal();
    });
  }
  $('channel-cancel-btn')?.addEventListener('click', closeChannelCreateModal);
  $('channel-confirm-btn')?.addEventListener('click', confirmChannelCreate);
  $('channel-modal')?.addEventListener('click', (e) => {
    if (e.target === $('channel-modal')) closeChannelCreateModal();
  });
  $('channel-name-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmChannelCreate();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeChannelCreateModal();
    }
  });
  $('sidebar-mobile-actions-btn')?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMobileActionMenu();
  });
  $('mobile-user-list-btn').addEventListener('click', async () => {
    closeMobileActionMenu();
    await openUserManagementModal();
  });
  $('mobile-diagnostics-btn').addEventListener('click', () => {
    closeMobileActionMenu();
    openDiagnosticsModal();
  });
  $('mobile-bottom-profile-btn').addEventListener('click', () => {
    openProfileModal();
  });
  $('mobile-bottom-logout-btn').addEventListener('click', async () => {
    await logoutCurrentUser();
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('#mobile-sidebar-actions-menu') || event.target.closest('#sidebar-mobile-actions-btn')) return;
    closeMobileActionMenu();
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
  $('sidebar-user-btn').addEventListener('click', openProfileModal);
  $('profile-close-btn').addEventListener('click', () => $('profile-modal').hidden = true);
  bindDesktopUpdateUi();

  document.querySelectorAll('.modal-overlay').forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target !== modal) return;
      if (modal.id === 'grok-modal') {
        closeGrokModal();
      } else if (modal.id === 'channel-modal') {
        closeChannelCreateModal();
      } else {
        modal.hidden = true;
      }
    });
  });

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

  // Profile picture mode: Color XOR Image (never both)
  $('profile-picture-mode-slider')?.addEventListener('input', () => {
    setProfilePictureMode($('profile-picture-mode-slider').value === '1' ? 'image' : 'color');
  });
  $('profile-mode-color-label')?.addEventListener('click', () => {
    setProfilePictureMode('color');
  });
  $('profile-mode-image-label')?.addEventListener('click', () => {
    setProfilePictureMode('image');
  });

  const syncProfileColorUi = () => {
    const colorInput = $('profile-color');
    const swatch = $('profile-color-swatch');
    const value = $('profile-color-value');
    if (!colorInput) return;
    const hex = String(colorInput.value || '#4A90D9').toUpperCase();
    if (swatch) swatch.style.background = hex;
    if (value) value.textContent = hex;
  };
  $('profile-color')?.addEventListener('input', syncProfileColorUi);
  syncProfileColorUi();

  $('profile-picture-pick-btn')?.addEventListener('click', () => {
    $('profile-picture-input')?.click();
  });

  // Preview appears ONLY after the user chooses a file — never empty placeholder
  $('profile-picture-input')?.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    const nameEl = $('profile-picture-file-name');
    const preview = $('profile-picture-preview');
    const img = $('profile-picture-preview-img');

    if (!file) {
      if (nameEl) nameEl.textContent = 'Max 2MB';
      if (preview) preview.hidden = true;
      if (img) img.removeAttribute('src');
      $('profile-save-picture').disabled = true;
      setUploadProgress('profile-picture-progress', 'profile-picture-progress-label', { visible: false });
      return;
    }

    if (nameEl) nameEl.textContent = file.name;
    $('profile-save-picture').disabled = true;
    if (!isAllowedUploadImageType(file.type)) {
      $('profile-error').textContent = 'Only JPEG, PNG, GIF, and WebP images are supported';
      if (preview) preview.hidden = true;
      setUploadProgress('profile-picture-progress', 'profile-picture-progress-label', { visible: false });
      return;
    }
    if (file.size > MAX_PROFILE_PICTURE_BYTES) {
      $('profile-error').textContent = PROFILE_PICTURE_TOO_LARGE_MSG;
      if (preview) preview.hidden = true;
      setUploadProgress('profile-picture-progress', 'profile-picture-progress-label', { visible: false });
      return;
    }
    $('profile-error').textContent = '';
    setUploadProgress('profile-picture-progress', 'profile-picture-progress-label', {
      visible: true,
      label: 'Preparing preview…',
    });
    const reader = new FileReader();
    reader.onerror = () => {
      $('profile-error').textContent = 'Failed to read the selected image. Please try a different file.';
      if (preview) preview.hidden = true;
      $('profile-save-picture').disabled = true;
      setUploadProgress('profile-picture-progress', 'profile-picture-progress-label', { visible: false });
    };
    reader.onload = (ev) => {
      if (!img || !preview) return;
      img.src = ev.target.result;
      preview.hidden = false;
      $('profile-save-picture').disabled = false;
      setUploadProgress('profile-picture-progress', 'profile-picture-progress-label', { visible: false });
    };
    reader.readAsDataURL(file);
  });

  // Save profile picture
  $('profile-save-picture').addEventListener('click', async () => {
    const saveButton = $('profile-save-picture');
    if (saveButton.disabled) return;
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

    setButtonBusy(saveButton, true, 'Uploading…', 'Save');
    setUploadProgress('profile-picture-progress', 'profile-picture-progress-label', {
      visible: true,
      label: 'Uploading image…',
    });
    try {
      const profilePicture = await readFileAsDataURL(file);
      const res = await fetch('/api/auth/profile', {
        method: 'PATCH', headers: apiHeaders(),
        body: JSON.stringify({ profilePicture }),
      });
      const d = await res.json();
      if (!res.ok) { $('profile-error').textContent = d.error || 'Failed'; return; }
      currentUser = d;
      renderCurrentUserAvatar(d);
      clearProfilePictureSelection();
      syncProfilePictureModeUI();
      updateProfileRemoveButton();
      if (!$('user-management-modal').hidden) void loadUserManagementSummary();
      $('profile-error').textContent = '✓ Saved';
    } catch {
      $('profile-error').textContent = 'Could not upload the image. Check your connection and try again.';
    } finally {
      setUploadProgress('profile-picture-progress', 'profile-picture-progress-label', { visible: false });
      setButtonBusy(saveButton, false, 'Uploading…', 'Save');
      saveButton.disabled = !$('profile-picture-input').files[0];
    }
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
    clearProfilePictureSelection();
    syncProfilePictureModeUI();
    updateProfileRemoveButton();
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
    $('create-error').textContent = '';
    $('create-modal').hidden = false;
  });
  $('create-cancel-btn').addEventListener('click', () => $('create-modal').hidden = true);
  $('create-confirm-btn').addEventListener('click', async () => {
    const name = $('create-group-name').value.trim();
    $('create-error').textContent = '';
    if (!name) { $('create-error').textContent = 'Group name is required'; return; }
    const secret = GChatCryptoV2.generateGroupSecret();
    const keyCommitment = await GChatCryptoV2.keyCommitment(secret);
    let code = '';
    let res;
    let d;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      code = GChatCryptoV2.generateInviteCode();
      res = await fetch('/api/groups/create', {
        method: 'POST', headers: apiHeaders(),
        body: JSON.stringify({ name, code, secret, keyCommitment }),
      });
      d = await res.json();
      if (res.ok || res.status !== 409 || d.error !== 'Group code already in use') break;
    }
    if (!res.ok) { $('create-error').textContent = d.error || 'Failed'; return; }
    const vaultEntry = { groupId: d.id, secret, joinCode: code };
    await GChatCryptoV2.keyVault.put(vaultEntry);
    groupKeyVaultCache.set(String(d.id), vaultEntry);
    $('create-modal').hidden = true;
    groups.unshift(d);
    unreadCounts[d.id] = Math.max(0, Number(d.unreadCount) || 0);
    renderGroupList();
    syncUnreadIndicators();
    await selectGroup(d.id);
    addSystemMessage('Group "' + d.name + '" created.');
    const copied = await copyTextToClipboard(code);
    showToast(copied ? 'Invite code copied' : 'Could not copy invite code', copied ? 'info' : 'error');
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
      'This will reset local GChat data and restart the app. Your login session and local user settings will be kept. Continue?',
      async () => {
        await clearCacheAndRestartApp();
      }
    );
  });
  let joinGroupInFlight = false;
  $('join-confirm-btn').addEventListener('click', async () => {
    if (joinGroupInFlight) return;
    const inviteInput = $('join-group-code').value.trim();
    $('join-error').textContent = '';
    if (!inviteInput) { $('join-error').textContent = 'Enter an invite code'; return; }
    const code = inviteInput.toLowerCase();
    joinGroupInFlight = true;
    setButtonBusy($('join-confirm-btn'), true, 'Joining…', 'Join');
    try {
      const res = await fetch('/api/groups/join', {
        method: 'POST', headers: apiHeaders(),
        body: JSON.stringify({ code }),
      });
      const d = await res.json();
      if (!res.ok) { $('join-error').textContent = d.error || 'Failed'; return; }
      const commitment = await GChatCryptoV2.keyCommitment(d.secret);
      if (commitment !== d.keyCommitment) {
        $('join-error').textContent = 'This invite code returned the wrong encryption key';
        return;
      }
      const vaultEntry = { groupId: d.id, secret: d.secret, joinCode: code };
      await GChatCryptoV2.keyVault.put(vaultEntry);
      groupKeyVaultCache.set(String(d.id), vaultEntry);
      $('join-modal').hidden = true;
      if (!groups.find(g => g.id === d.id)) {
        groups.unshift(d);
        unreadCounts[d.id] = Math.max(0, Number(d.unreadCount) || 0);
        renderGroupList();
        syncUnreadIndicators();
      }
      await selectGroup(d.id);
      addSystemMessage(d.alreadyJoined ? `You are already a member of "${d.name}".` : `You joined "${d.name}".`);
    } catch {
      $('join-error').textContent = 'Could not join the group. Check your connection and try again.';
    } finally {
      joinGroupInFlight = false;
      setButtonBusy($('join-confirm-btn'), false, 'Joining…', 'Join');
    }
  });

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
    if (!input) {
      return;
    }
    input.value = input.value
      ? `${input.value.trimEnd()}\n\n${grokResponseDraft}`
      : grokResponseDraft;
    autoResizeTextarea(input);
    closeGrokModal();
    if (!input.disabled) input.focus();
  });
  // Copy the stable, human-shareable group invite code.
  $('copy-code-btn').addEventListener('click', async () => {
    if (!currentGroupData) return;
    let entry = groupKeyVaultCache.get(String(currentGroupData.id));
    if (!entry?.secret) {
      await loadGroupKeyVaultEntries();
      entry = groupKeyVaultCache.get(String(currentGroupData.id));
    }
    if (!entry?.joinCode) {
      showToast('Invite code is not ready yet', 'error');
      return;
    }
    if (!await copyTextToClipboard(entry.joinCode)) {
      showToast('Could not copy invite code', 'error');
      return;
    }
    setElementIcon($('copy-code-btn'), 'check', { label: 'Copied' });
    setTimeout(() => setElementIcon($('copy-code-btn'), 'key-round', { label: 'Invite' }), 1500);
  });

  // Edit group name
  let groupRenameInFlight = false;
  const saveGroupName = async () => {
    const name = $('edit-group-name-input').value.trim();
    if (!name || !currentGroupId || groupRenameInFlight) return;
    if (currentGroupData && name === currentGroupData.name) return;
    groupRenameInFlight = true;
    try {
      const res = await fetch('/api/groups/' + currentGroupId + '/name', {
        method: 'PATCH', headers: apiHeaders(),
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        showToast(d.error || 'Failed to rename', 'error');
        $('edit-group-name-input').value = currentGroupData ? currentGroupData.name : '';
      }
    } catch {
      showToast('Could not rename the group. Check your connection and try again.', 'error');
      $('edit-group-name-input').value = currentGroupData ? currentGroupData.name : '';
    } finally {
      groupRenameInFlight = false;
    }
  };
  $('edit-group-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveGroupName();
    }
  });
  $('edit-group-name-input').addEventListener('blur', saveGroupName);

  // Group icon
  let groupIconMode = 'color';
  const syncGroupIconMode = (mode) => {
    groupIconMode = mode;
    const isImage = mode === 'image';
    document.querySelector('.group-icon-mode-tabs')?.setAttribute('data-mode', isImage ? 'image' : 'color');
    $('group-icon-color-section').hidden = isImage;
    $('group-icon-image-section').hidden = !isImage;
    $('group-icon-mode-color').classList.toggle('active', !isImage);
    $('group-icon-mode-image').classList.toggle('active', isImage);
    $('group-icon-mode-color').setAttribute('aria-selected', String(!isImage));
    $('group-icon-mode-image').setAttribute('aria-selected', String(isImage));
    $('group-color-save-btn').disabled = isImage && !$('group-icon-input').files?.[0] && !currentGroupData?.groupIcon;
  };
  $('set-group-color-btn').addEventListener('click', () => {
    if (!currentGroupId || $('set-group-color-btn').disabled) return;
    $('group-color-input').value = (currentGroupData && currentGroupData.groupColor) || '#4a90d9';
    $('group-icon-input').value = '';
    $('group-icon-file-name').textContent = 'JPEG, PNG, GIF, or WebP · max 2MB';
    $('group-icon-preview').hidden = true;
    setUploadProgress('group-icon-progress', 'group-icon-progress-label', { visible: false });
    syncGroupIconMode(currentGroupData?.groupIcon ? 'image' : 'color');
    $('group-color-modal').hidden = false;
  });
  $('group-color-cancel-btn').addEventListener('click', () => { $('group-color-modal').hidden = true; });
  $('group-icon-mode-color').addEventListener('click', () => syncGroupIconMode('color'));
  $('group-icon-mode-image').addEventListener('click', () => syncGroupIconMode('image'));
  $('group-icon-pick-btn').addEventListener('click', () => $('group-icon-input').click());
  $('group-icon-input').addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!isAllowedUploadImageType(file.type) || file.size > MAX_PROFILE_PICTURE_BYTES) {
      showToast(!isAllowedUploadImageType(file.type) ? 'Only JPEG, PNG, GIF, and WebP images are supported' : PROFILE_PICTURE_TOO_LARGE_MSG, 'error');
      event.target.value = '';
      $('group-color-save-btn').disabled = !currentGroupData?.groupIcon;
      return;
    }
    $('group-icon-file-name').textContent = file.name;
    $('group-color-save-btn').disabled = true;
    setUploadProgress('group-icon-progress', 'group-icon-progress-label', {
      visible: true,
      label: 'Preparing preview…',
    });
    const reader = new FileReader();
    reader.onerror = () => {
      showToast('Failed to read the selected image. Please try a different file.', 'error');
      event.target.value = '';
      $('group-icon-preview').hidden = true;
      $('group-color-save-btn').disabled = !currentGroupData?.groupIcon;
      setUploadProgress('group-icon-progress', 'group-icon-progress-label', { visible: false });
    };
    reader.onload = () => {
      $('group-icon-preview-img').src = String(reader.result || '');
      $('group-icon-preview').hidden = false;
      $('group-color-save-btn').disabled = false;
      setUploadProgress('group-icon-progress', 'group-icon-progress-label', { visible: false });
    };
    reader.readAsDataURL(file);
  });
  $('group-color-save-btn').addEventListener('click', async () => {
    const saveButton = $('group-color-save-btn');
    if (saveButton.disabled) return;
    setButtonBusy(saveButton, true, groupIconMode === 'image' ? 'Uploading…' : 'Saving…', 'Confirm');
    setUploadProgress('group-icon-progress', 'group-icon-progress-label', {
      visible: true,
      label: groupIconMode === 'image' ? 'Uploading group icon…' : 'Saving icon color…',
    });
    let payload;
    try {
      if (groupIconMode === 'image') {
        const file = $('group-icon-input').files?.[0];
        if (!file) {
          if (currentGroupData?.groupIcon) payload = { groupIcon: currentGroupData.groupIcon };
          else { showToast('Choose an image for the group icon', 'error'); return; }
        } else {
          const groupIcon = await readFileAsDataURL(file);
          payload = { groupIcon };
        }
      } else {
        payload = { groupColor: $('group-color-input').value, groupIcon: null };
      }
      const res = await fetch('/api/groups/' + currentGroupId + '/settings', {
        method: 'PATCH', headers: apiHeaders(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        showToast(d.error || 'Failed to set group icon', 'error');
        return;
      }
      $('group-color-modal').hidden = true;
    } catch {
      showToast('Could not upload the group icon. Check your connection and try again.', 'error');
    } finally {
      setUploadProgress('group-icon-progress', 'group-icon-progress-label', { visible: false });
      setButtonBusy(saveButton, false, 'Uploading…', 'Confirm');
      saveButton.disabled = groupIconMode === 'image'
        && !$('group-icon-input').files?.[0]
        && !currentGroupData?.groupIcon;
    }
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

  $('allow-member-invite-toggle').addEventListener('change', async (e) => {
    const nextChecked = e.target.checked;
    const result = await updateGroupSettingRequest({ allowMemberInvite: nextChecked });
    if (!result.ok) {
      e.target.checked = !nextChecked;
      showToast(result.error || 'Failed to update group settings', 'error');
      return;
    }
    if (currentGroupData) {
      currentGroupData.allowMemberInvite = nextChecked;
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
        setMobileView('list');
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
    if (isDisappearingMessage(msg)) {
      hideContextMenu();
      return;
    }
    const text = ctxText;
    hideContextMenu();
    const isDecryptFail = text === MSG_CONTENT_UNAVAILABLE;
    let preview;
    if (text && !isDecryptFail) {
      preview = text;
    } else if (msg.type === 'image') {
      preview = '[image]';
    } else if (msg.type === 'file') {
      preview = '[file: ' + (msg.filename || '') + ']';
    } else {
      preview = MSG_CONTENT_UNAVAILABLE;
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

  $('ctx-edit').addEventListener('click', () => {
    if (!ctxMsg || ctxMsg.senderId !== currentUser?.id) return;
    const msg = ctxMsg;
    const text = ctxText;
    hideContextMenu();
    void startEditMessage(msg, text);
  });

  $('ctx-delete').addEventListener('click', () => {
    // v1.3.9: GChat Global allows any member to delete any message — match the
    // context-menu visibility rule instead of silently blocking non-authors.
    if (!ctxMsg) return;
    const isAuthor = ctxMsg.senderId === currentUser?.id;
    const isGlobal = isGlobalGroupId(ctxMsg.groupId || currentGroupId);
    if (!isAuthor && !isGlobal) return;
    const msg = ctxMsg;
    hideContextMenu();
    showConfirm('Delete message', 'Delete this message for everyone? This cannot be undone.', async () => {
      const res = await fetch(`/api/groups/${msg.groupId || currentGroupId}/messages/${msg.id}`, {
        method: 'DELETE',
        headers: apiHeaders(),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Delete failed', 'error');
      }
    });
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
    if (!ctxTagTopic) return;
    const topic = ctxTagTopic;
    hideTagContextMenu();
    if (topic === DEFAULT_TAG_TOPIC) {
      showToast('Cannot delete #main', 'error');
      return;
    }
    // Empty channels can always be dismissed locally; message wipe needs permission.
    const cache = ensureGroupCacheEntry(currentGroupId);
    const hasMessages = (cache.messages || []).some((msg) => resolveMessageTagTopic(msg) === topic);
    if (hasMessages && !canCurrentUserClearTag()) {
      showToast('You do not have permission to delete this channel', 'error');
      return;
    }
    showConfirm(
      `Delete ${formatHashtagLabel(topic)}`,
      hasMessages
        ? `This will permanently delete every ${formatHashtagLabel(topic)} message for everyone. Continue?`
        : `Remove empty channel ${formatHashtagLabel(topic)}?`,
      async () => {
        await clearTagMessages(topic);
      }
    );
  });

  $('avatar-ctx-invite').addEventListener('click', () => {
    openInviteModal();
  });

  $('invite-close-btn').addEventListener('click', () => {
    $('invite-modal').hidden = true;
  });
  $('invite-modal').addEventListener('click', (e) => {
    if (e.target === $('invite-modal')) $('invite-modal').hidden = true;
  });

  // Right-click a profile picture (members list or chat bubble) to invite the
  // person into one of your other chats.
  document.addEventListener('contextmenu', (event) => {
    const avatar = event.target.closest('.msg-avatar, .member-avatar');
    if (!avatar) return;
    const row = avatar.closest('.msg-row, .member-item');
    if (!row) return;
    const userId = row.dataset.senderId || row.dataset.userId;
    if (!userId || !currentUser || String(userId) === String(currentUser.id)) return;
    if (String(userId) === AI_ASSISTANT_USER_ID) return;
    event.preventDefault();
    let username = '';
    const member = members.find((m) => String(m.id) === String(userId));
    if (member) {
      username = member.username;
    } else {
      const nameEl = row.querySelector('.msg-sender-name');
      if (nameEl) username = nameEl.textContent || '';
    }
    showAvatarContextMenu(event, userId, username || 'this user');
  });

  document.addEventListener('click', (e) => {
    if (!$('ctx-menu').contains(e.target)) hideContextMenu();
    if (!$('tag-ctx-menu').contains(e.target)) hideTagContextMenu();
    if (!$('avatar-ctx-menu').contains(e.target)) hideAvatarContextMenu();
    if (!$('emoji-picker').contains(e.target) && e.target !== $('emoji-btn')) {
      $('emoji-picker').hidden = true;
    }
    if (!$('slash-command-menu').contains(e.target) && e.target !== $('message-input')) {
      $('slash-command-menu').hidden = true;
    }
    if (!$('whisper-picker').contains(e.target) && !$('whisper-mode-btn').contains(e.target) && e.target !== $('message-input')) {
      cancelWhisperSelection();
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
      maybeTokenizeSlashCommand(msgInput);
      syncComposerTokens();
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

  msgInput.addEventListener('focus', () => {
    composerNearBottomBeforeFocus = isNearBottom();
    if (!isMobileLayout()) return;
    setTimeout(() => {
      syncAppViewportHeight();
      window.scrollTo(0, 0);
      if (composerNearBottomBeforeFocus) scrollToBottom(true);
    }, MOBILE_KEYBOARD_FOCUS_DELAY_MS);
  });

  msgInput.addEventListener('blur', () => {
    clearTimeout(window._myTypingTimer);
    if (currentGroupId && socket) socket.emit('stop_typing', { groupId: currentGroupId });
    composerNearBottomBeforeFocus = true;
    syncAppViewportHeight();
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

  // Paste files from clipboard — upload EVERY pasted file, one by one.
  msgInput.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    if (files.length > 1) showToast(`Sending ${files.length} files…`, 'info');
    for (const file of files) {
      await handleFileUpload(file);
    }
  });

  // Emoji button
  $('emoji-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('emoji-picker').hidden = !$('emoji-picker').hidden;
  });

  // Whisper mode toggle
  $('whisper-mode-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    if (messageMode === 'normal') messageMode = 'whisper';
    else if (messageMode === 'whisper') {
      messageMode = 'disappearing';
      whisperRecipients = [];
      composerTokens.whisper = null;
    } else messageMode = 'normal';
    if (messageMode === 'whisper') showWhisperPicker('button');
    else hideWhisperPicker();
    syncComposerTokens();
    updateWhisperBtn();
  });
  $('whisper-picker-confirm').addEventListener('click', () => {
    if (!getActiveWhisperRecipientIds().length) {
      showToast('Select at least one recipient', 'error');
      return;
    }
    hideWhisperPicker();
    syncComposerTokens();
    updateWhisperBtn();
  });
  $('whisper-picker-cancel').addEventListener('click', cancelWhisperSelection);

  // Scroll to bottom button
  $('scroll-bottom-btn').addEventListener('click', () => scrollToBottom());

  // Scroll listener for pagination + scroll-to-bottom visibility (throttled via rAF)
  let scrollRafPending = false;
  messagesArea().addEventListener('scroll', () => {
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
      scrollRafPending = false;
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
  }, { passive: true });

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

  // Search (debounced to avoid expensive DOM re-renders on every keystroke)
  let searchDebounceTimer = 0;
  $('search-input').addEventListener('input', (e) => {
    const value = e.target.value;
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = 0;
      searchMessages(value);
    }, 180);
  });
  $('clear-search-btn').addEventListener('click', () => {
    if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = 0; }
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
  $('image-viewer-download-btn').addEventListener('click', async () => {
    if (!imageViewerData) return;
    const url = URL.createObjectURL(imageViewerData.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = imageViewerData.filename || 'image';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  });
  $('image-viewer-copy-btn').addEventListener('click', async () => {
    if (!imageViewerData) return;
    await copyAttachmentToClipboard({
      type: 'image',
      _viewerData: imageViewerData,
    });
  });
}

async function loadOlderMessages(cursorOverride = null, retried = false) {
  const cursor = cursorOverride || oldestMessageId;
  if (loadingOlder || !cursor || !currentGroupId) return;
  loadingOlder = true;
  const indicator = $('load-more-indicator');
  if (indicator) indicator.hidden = false;
  try {
    const url = `/api/groups/${currentGroupId}/messages?before=${cursor}&limit=50`;
    const res = await fetch(url);
    if (!res.ok) return;
    const rawMsgs = await res.json();
    if (!rawMsgs.length) {
      // v1.3.9: the cursor message may have been hard-deleted on the server,
      // which makes the `before` query return nothing even though older
      // messages exist. Re-derive the cursor from the cache and retry once.
      if (!retried) {
        const cache = ensureGroupCacheEntry(currentGroupId);
        const fallback = (cache.messages || []).find((m) => String(m.id) !== String(cursor));
        if (fallback) {
          oldestMessageId = fallback.id;
          return loadOlderMessages(fallback.id, true);
        }
      }
      oldestMessageId = null; // no more older messages
      return;
    }

    // v1.3.9: apply the full visibility filter (whisper scoping), matching the
    // initial-load path.
    const msgs = filterMessagesVisibleToCurrentUser(rawMsgs);

    // Channels are separate sub-chats: only the active channel's messages may
    // enter the visible transcript — everything else stays in the group cache
    // for its own channel stream.
    for (const msg of msgs) await hydrateMessageChannel(msg, currentGroupId);
    const channel = getActiveTagTopic();
    const channelMsgs = msgs.filter((msg) => resolveMessageTagTopic(msg) === channel);

    const area = messagesArea();
    const prevScrollHeight = area.scrollHeight;

    const rows = await buildMessageRows(channelMsgs, currentGroupId);

    // Assemble into a fragment (single DOM mutation, no scroll drift)
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      if (!row) continue;
      if (row.classList && row.classList.contains('msg-row')) {
        const msgId = row.dataset.msgId;
        const srcMsg = channelMsgs.find((m) => String(m.id) === String(msgId));
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

    // v1.3.9: dedup-merge (never concat) so pagination can't duplicate rows.
    allMessages = mergeMessagesIntoCache(currentGroupId, msgs, { persist: false });
    oldestMessageId = rawMsgs[0].id;
    const cache = ensureGroupCacheEntry(currentGroupId);
    cache.messages = allMessages;
    cache.messageRows = rows.concat(cache.messageRows || []);
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
function getViewportHeightForLayout({ visualViewport, fallbackHeight }) {
  const visualHeight = visualViewport ? Math.round(visualViewport.height) : 0;
  // Keep layout viewport stable; keyboard movement is handled separately via
  // --keyboard-inset so iOS focus does not collapse the full app shell.
  return Math.max(fallbackHeight, visualHeight || 0);
}
