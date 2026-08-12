(() => {
  // src/web/crypto-v2.js
  var encoder = new TextEncoder();
  var decoder = new TextDecoder();
  var VAULT_DB = "gchat-key-vault-v2";
  var VAULT_STORE = "group-keys";
  var ENCRYPTION_VERSION = 2;
  var KEY_VERSION = 1;
  function bytesToBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  function base64UrlToBytes(value) {
    const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  function generateGroupSecret() {
    return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  }
  function generateInviteCode() {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    let code = "";
    while (code.length < 6) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      for (const byte of bytes) {
        if (byte >= 252) continue;
        code += alphabet[byte % alphabet.length];
        if (code.length === 6) break;
      }
    }
    return code;
  }
  async function keyCommitment(secret) {
    const digest = await crypto.subtle.digest("SHA-256", base64UrlToBytes(secret));
    return bytesToBase64Url(new Uint8Array(digest));
  }
  async function deriveKey(secret, groupId, purpose, usage) {
    const material = await crypto.subtle.importKey("raw", base64UrlToBytes(secret), "HKDF", false, ["deriveKey"]);
    const algorithm = {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(groupId),
      info: encoder.encode(`gchat-${purpose}-v2`)
    };
    if (purpose === "content" || purpose === "metadata") {
      return crypto.subtle.deriveKey(algorithm, material, { name: "AES-GCM", length: 256 }, false, usage);
    }
    return crypto.subtle.deriveKey(algorithm, material, { name: "HMAC", hash: "SHA-256", length: 256 }, false, usage);
  }
  function messageAad({ groupId, id, senderId, type = "text", keyVersion = KEY_VERSION, revision = 1 }) {
    return encoder.encode(JSON.stringify({ groupId, id, senderId, type, keyVersion, revision }));
  }
  async function encryptJson(value, secret, groupId, purpose, aad) {
    const key = await deriveKey(secret, groupId, purpose, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, encoder.encode(JSON.stringify(value)));
    return { encryptedContent: bytesToBase64Url(new Uint8Array(ciphertext)), iv: bytesToBase64Url(iv) };
  }
  async function decryptJson(ciphertext, iv, secret, groupId, purpose, aad) {
    const key = await deriveKey(secret, groupId, purpose, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(iv), additionalData: aad }, key, base64UrlToBytes(ciphertext));
    return JSON.parse(decoder.decode(plaintext));
  }
  async function encryptBytes(buffer, secret, groupId, aad) {
    const key = await deriveKey(secret, groupId, "content", ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, buffer);
    return { encryptedBytes: new Uint8Array(ciphertext), iv: bytesToBase64Url(iv) };
  }
  async function decryptBytes(ciphertext, iv, secret, groupId, aad) {
    const key = await deriveKey(secret, groupId, "content", ["decrypt"]);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(iv), additionalData: aad }, key, ciphertext);
  }
  async function blindIndex(value, secret, groupId, purpose = "tag-index") {
    if (!value) return null;
    const key = await deriveKey(secret, groupId, purpose, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(String(value).trim().toLocaleLowerCase()));
    return bytesToBase64Url(new Uint8Array(signature));
  }
  function openVault() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(VAULT_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(VAULT_STORE, { keyPath: "groupId" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function vaultOperation(mode, operation) {
    const db = await openVault();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(VAULT_STORE, mode);
      const request = operation(transaction.objectStore(VAULT_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => db.close();
    });
  }
  var keyVault = {
    get: (groupId) => vaultOperation("readonly", (store) => store.get(groupId)),
    put: (entry) => vaultOperation("readwrite", (store) => store.put({ ...entry, encryptionVersion: ENCRYPTION_VERSION })),
    remove: (groupId) => vaultOperation("readwrite", (store) => store.delete(groupId))
  };

  // src/web/legacy-app.js
  var derivedKeyCache = /* @__PURE__ */ new Map();
  var DERIVED_KEY_CACHE_MAX = 64;
  async function deriveKey2(passphrase, groupId) {
    const cacheKey = passphrase + "\0" + groupId;
    if (derivedKeyCache.has(cacheKey)) return derivedKeyCache.get(cacheKey);
    const enc = new TextEncoder();
    const keyMat = await crypto.subtle.importKey(
      "raw",
      enc.encode(passphrase),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: enc.encode(groupId), iterations: 1e5, hash: "SHA-256" },
      keyMat,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    if (derivedKeyCache.size >= DERIVED_KEY_CACHE_MAX) {
      const firstKey = derivedKeyCache.keys().next().value;
      derivedKeyCache.delete(firstKey);
    }
    derivedKeyCache.set(cacheKey, key);
    return key;
  }
  function uint8ToBase64(bytes) {
    let binary = "";
    const CHUNK = 32768;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }
  async function encryptMessage(text, passphrase, groupId) {
    const key = await deriveKey2(passphrase, groupId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const buf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
    return {
      encryptedContent: uint8ToBase64(new Uint8Array(buf)),
      iv: uint8ToBase64(iv)
    };
  }
  async function decryptMessage(encryptedContent, ivB64, passphrase, groupId) {
    try {
      const key = await deriveKey2(passphrase, groupId);
      const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
      const buf = Uint8Array.from(atob(encryptedContent), (c) => c.charCodeAt(0));
      const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, buf);
      return new TextDecoder().decode(dec);
    } catch {
      return null;
    }
  }
  async function decryptBytes2(encryptedContent, ivB64, passphrase, groupId) {
    try {
      const key = await deriveKey2(passphrase, groupId);
      const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
      const buf = Uint8Array.from(atob(encryptedContent), (c) => c.charCodeAt(0));
      return await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, buf);
    } catch {
      return null;
    }
  }
  function detectImageMime(buf) {
    const ab = buf instanceof ArrayBuffer ? buf : buf.buffer;
    const bytes = new Uint8Array(ab, 0, Math.min(12, ab.byteLength));
    if (bytes[0] === 255 && bytes[1] === 216) return "image/jpeg";
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "image/png";
    if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) return "image/gif";
    if (bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return "image/webp";
    return null;
  }
  async function compressImage(file) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const MAX = 1200;
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > MAX || h > MAX) {
          if (w > h) {
            h = Math.round(h * MAX / w);
            w = MAX;
          } else {
            w = Math.round(w * MAX / h);
            h = MAX;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.75);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }
  function readFileAsDataUrl(file, callbacks = {}) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onprogress = (event) => {
        if (typeof callbacks.onProgress === "function") callbacks.onProgress(event);
      };
      reader.onerror = () => reject(new Error("Unable to read image"));
      reader.onload = (event) => {
        const result = String(event.target?.result || "");
        if (!result) {
          reject(new Error("Unable to read image"));
          return;
        }
        resolve(result);
      };
      reader.readAsDataURL(file);
    });
  }
  async function prepareWallpaperFile(file) {
    if (!file || !file.type.startsWith("image/")) return file;
    if (file.size <= 2 * 1024 * 1024) return file;
    const optimized = await compressImage(file);
    if (optimized instanceof Blob && optimized.size > 0 && optimized.size < file.size) return optimized;
    return file;
  }
  var csrfToken = null;
  var appVersionLabel = "v\u2014";
  var currentAppVersion = null;
  var aiFeatureEnabled = false;
  var hostedAppUpdateTimer = null;
  var hostedAppReloadPending = false;
  var HOSTED_APP_UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1e3;
  var SOCKET_RECOVERY_WINDOW_MS = 2 * 60 * 1e3;
  var MIN_DISAPPEARING_DURATION_MS = 3e3;
  var DISAPPEARING_DURATION_PER_CHAR_MS = 90;
  var MAX_DISAPPEARING_DURATION_MS = 22500;
  function buildAuthRedirectUrl() {
    return "index.html";
  }
  async function fetchCsrfToken() {
    try {
      const r = await fetch("/api/auth/csrf");
      const d = await r.json();
      csrfToken = d.csrfToken;
    } catch {
    }
  }
  function apiHeaders(options = {}) {
    const h = {};
    if (options.json !== false) h["Content-Type"] = "application/json";
    if (csrfToken) h["X-CSRF-Token"] = csrfToken;
    return h;
  }
  var groupKeyVaultCache = /* @__PURE__ */ new Map();
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith("gk:")) localStorage.removeItem(key);
  }
  function getGroupKey(groupId) {
    const normalizedGroupId = String(groupId || "");
    if (!normalizedGroupId) return null;
    return groupKeyVaultCache.get(normalizedGroupId)?.secret || null;
  }
  async function loadGroupKeyVaultEntries() {
    const groupsById = new Map(groups.map((group) => [String(group.id), group]));
    const localEntries = await Promise.all(groups.map(async (group) => {
      try {
        return [group, await keyVault.get(group.id)];
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
      const response = await fetch("/api/groups/keys", { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      const recoveredEntries = Array.isArray(payload?.keys) ? payload.keys : [];
      for (const recovered of recoveredEntries) {
        const groupId = String(recovered?.groupId || "");
        const group = groupsById.get(groupId);
        if (!group || typeof recovered?.secret !== "string" || typeof recovered?.joinCode !== "string") continue;
        const commitment = await keyCommitment(recovered.secret);
        if (commitment !== group.keyCommitment) continue;
        const entry = { groupId, secret: recovered.secret, joinCode: recovered.joinCode };
        await keyVault.put(entry);
        groupKeyVaultCache.set(groupId, entry);
      }
    } catch {
    }
  }
  function v2Aad(msg, revision = msg.revision || 1) {
    return messageAad({
      groupId: msg.groupId || currentGroupId,
      id: msg.id,
      senderId: msg.senderId,
      type: msg.type || "text",
      keyVersion: msg.keyVersion || 1,
      revision
    });
  }
  async function encryptV2Message(text, metadata, msg, secret) {
    const aad = v2Aad(msg);
    const content = await encryptJson({ text }, secret, msg.groupId, "content", aad);
    const encryptedMetadata = await encryptJson(metadata || {}, secret, msg.groupId, "metadata", aad);
    return {
      encryptedContent: content.encryptedContent,
      iv: content.iv,
      encryptedMetadata: encryptedMetadata.encryptedContent,
      metadataIv: encryptedMetadata.iv
    };
  }
  async function decryptV2Message(msg, secret, groupId) {
    const normalized = { ...msg, groupId: msg.groupId || groupId };
    const content = await decryptJson(msg.encryptedContent, msg.iv, secret, groupId, "content", v2Aad(normalized));
    if (msg.encryptedMetadata && msg.metadataIv) {
      const metadata = await decryptJson(msg.encryptedMetadata, msg.metadataIv, secret, groupId, "metadata", v2Aad(normalized));
      Object.assign(msg, metadata);
    }
    return content.text;
  }
  async function decryptMessageText(msg, secret, groupId = currentGroupId) {
    if (!secret) return null;
    const version = Number(msg.encryptionVersion);
    if (version === 2) {
      try {
        const v2 = await decryptV2Message(msg, secret, groupId);
        if (v2 != null) return v2;
      } catch {
      }
      return decryptMessage(msg.encryptedContent, msg.iv, secret, groupId);
    }
    const v1 = await decryptMessage(msg.encryptedContent, msg.iv, secret, groupId);
    if (v1 != null) return v1;
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
        const bytes = base64UrlToBytes(msg.encryptedContent);
        return await decryptBytes(bytes, msg.iv, secret, groupId, v2Aad({ ...msg, groupId }));
      } catch {
        return decryptBytes2(msg.encryptedContent, msg.iv, secret, groupId);
      }
    }
    const legacy = await decryptBytes2(msg.encryptedContent, msg.iv, secret, groupId);
    if (legacy != null) return legacy;
    try {
      const bytes = base64UrlToBytes(msg.encryptedContent);
      return await decryptBytes(bytes, msg.iv, secret, groupId, v2Aad({ ...msg, groupId }));
    } catch {
      return null;
    }
  }
  function shouldPreserveLocalStorageEntry(key) {
    return !!(key && (key === ACTIVE_LOCAL_SETTINGS_KEY || key === LEGACY_LOCAL_SETTINGS_KEY || key.startsWith(LOCAL_SETTINGS_KEY_PREFIX) || key === LAST_SEEN_DEPLOY_KEY || key.startsWith(CHANNEL_PREF_KEY_PREFIX) || key.startsWith("gchat:tag-order:")));
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
    if (typeof document === "undefined") return;
    const rawCookies = typeof document.cookie === "string" ? document.cookie : "";
    if (!rawCookies) return;
    const hostname = window.location.hostname || "";
    const domainParts = hostname.split(".").filter(Boolean);
    const domains = [""];
    for (let i = 0; i < domainParts.length - 1; i += 1) {
      domains.push("." + domainParts.slice(i).join("."));
    }
    for (const cookie of rawCookies.split(";")) {
      const [namePart] = cookie.split("=");
      const cookieName = namePart ? namePart.trim() : "";
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
    if (!("indexedDB" in window) || typeof indexedDB.deleteDatabase !== "function") return;
    if (typeof indexedDB.databases !== "function") return;
    try {
      const databases = await indexedDB.databases();
      await Promise.allSettled((databases || []).map((database) => {
        const name = typeof database?.name === "string" ? database.name : "";
        return deleteIndexedDbDatabase(name);
      }));
    } catch {
    }
  }
  function getVisibleWhisperRecipientIds(msg) {
    if (!msg || msg.type !== "whisper") return [];
    if (!msg.whisperTo) return [];
    try {
      const parsed = JSON.parse(msg.whisperTo);
      return Array.isArray(parsed) ? parsed.map((id) => String(id)) : [];
    } catch {
      return String(msg.whisperTo).split(",").map((value) => value.trim()).filter(Boolean);
    }
  }
  function canCurrentUserAccessMessage(msg, userId = currentUser?.id) {
    if (!msg || !userId) return false;
    if (msg.senderId === userId) return true;
    if (msg.type !== "whisper") return true;
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
      }
    }
  }
  var LOCAL_CACHE_PREFIX = "gchat:cache:group:";
  var LEGACY_LOCAL_SETTINGS_KEY = "gchat:local-settings";
  var ACTIVE_LOCAL_SETTINGS_KEY = "gchat:active-local-settings";
  var LOCAL_SETTINGS_KEY_PREFIX = "gchat:local-settings:user:";
  var DEFAULT_WALLPAPER_PREVIEW_SRC = "gchat_wallpaper.jpg";
  var DEFAULT_WALLPAPER_BLUR = 0;
  var DEFAULT_WALLPAPER_TRANSPARENCY = 100;
  var WALLPAPER_SELECT_FIRST_MSG = "Please choose an image first";
  var WALLPAPER_TOO_LARGE_MSG = "Wallpaper too large (max 10MB)";
  var ATTACHMENT_TOO_LARGE_MSG = "Attachment too large (max 15MB)";
  var PROFILE_PICTURE_TOO_LARGE_MSG = "Image too large (max 2MB)";
  var WALLPAPER_READ_FAIL_MSG = "Unable to read image";
  var WALLPAPER_SAVE_SYNC_FAIL_MSG = "Wallpaper saved locally but could not sync to server. Changes may not appear on other devices.";
  var WALLPAPER_RESET_SYNC_FAIL_MSG = "Wallpaper reset locally but could not sync to server. Changes may not appear on other devices.";
  var WALLPAPER_SAVE_SUCCESS_MSG = "Wallpaper saved";
  var WALLPAPER_RESET_SUCCESS_MSG = "Wallpaper reset";
  var MAX_WALLPAPER_BYTES = 10 * 1024 * 1024;
  var MAX_PROFILE_PICTURE_BYTES = 2 * 1024 * 1024;
  var MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
  var MAX_TEXT_MESSAGE_BYTES = 64 * 1024;
  var MAX_AI_TOOL_ROUNDS = 4;
  var AI_CHANNEL_HISTORY_DEFAULT_LIMIT = 20;
  var AI_CHANNEL_HISTORY_MAX_LIMIT = 40;
  var AI_TOOL_RESULT_MAX_CHARS = 24e3;
  var AI_CHANNEL_LIST_MAX_CHANNELS = 50;
  var AI_TONE_STORAGE_KEY = "gchat:ai-tone";
  var AI_ASSISTANT_USER_ID = "__gchat_ai_grok__";
  var AI_ASSISTANT_NAME = "GChat AI";
  var AI_ASSISTANT_COLOR = "#8d7bff";
  var AI_ASSISTANT_PROFILE_PICTURE = "/deepseek.webp";
  var AI_MODEL_PROFILE_PICTURES = {
    "deepseek-v4-flash": "/deepseek.webp"
  };
  var AI_MODEL_TAGS = {
    "deepseek-v4-flash": "deepseek"
  };
  var AI_MODEL_ALIASES = {
    "deepseek/deepseek-v4-flash": "deepseek-v4-flash"
  };
  var APP_OWNER_USERNAME = "Furina";
  var AI_RESET_TIME_LABEL = "4:00 AM Shanghai time";
  var AI_USAGE_RESET_LABEL = `Resets at ${AI_RESET_TIME_LABEL}`;
  var USD_TO_RMB_RATE = 7.2;
  var AI_TOKEN_AMOUNT_DECIMALS = 4;
  var MIN_DISPLAYABLE_TOKEN_AMOUNT = 0.01;
  var MIN_CURRENCY_DISPLAY_THRESHOLD = 0.01;
  var SMALL_CURRENCY_PRECISION = 4;
  var AI_MODEL_OPTIONS = {
    "deepseek-v4-flash": "DeepSeek V4 Flash"
  };
  var DEFAULT_AI_MODEL = "deepseek-v4-flash";
  var AI_MODE_LABELS = {
    fast: "Context-less",
    thinking: "Context",
    agent: "Agent"
  };
  var DEFAULT_AI_MODE = "agent";
  var AI_TONE_LABELS = {
    casual: "Casual",
    professional: "Professional",
    playful: "Playful"
  };
  var DEFAULT_AI_TONE = "casual";
  var ALLOWED_UPLOAD_IMAGE_TYPES = /* @__PURE__ */ new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
  var wallpaperTheme = window.GChatWallpaperTheme || null;
  var localTimeFormatter = new Intl.DateTimeFormat(void 0, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  var integerFormatter = new Intl.NumberFormat();
  var tokenAmountFormatter = new Intl.NumberFormat(void 0, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });
  var localDayFormatter = new Intl.DateTimeFormat(void 0, {
    year: "numeric",
    month: "numeric",
    day: "numeric"
  });
  var DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY = "gchat:desktop-sidebar-width";
  var DESKTOP_RIGHT_PANEL_STORAGE_KEY = "gchat:desktop-right-panel-expanded";
  var DESKTOP_DEFAULT_SIDEBAR_WIDTH = 260;
  var DESKTOP_MIN_SIDEBAR_WIDTH = 104;
  var DESKTOP_BRAND_ONLY_SIDEBAR_WIDTH = 140;
  var DESKTOP_ICON_ONLY_SIDEBAR_WIDTH = 120;
  var DESKTOP_ACTIONS_ICON_SIDEBAR_WIDTH = 180;
  var DESKTOP_HIDE_CACHE_BTN_WIDTH = 220;
  var GENERIC_NOTIFICATION_TITLE = "GChat";
  var GENERIC_NOTIFICATION_FALLBACK_BODY = "You have unread messages in GChat.";
  var PUSH_NOTIFICATION_TAG = "gchat-unread";
  var APP_BADGE_UNSUPPORTED = Symbol("app-badge-unsupported");
  var PRESERVED_COOKIE_NAMES = /* @__PURE__ */ new Set(["connect.sid", "__Host-connect.sid", "__Secure-connect.sid"]);
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
        // v1.3.13: never persist an empty member list — a write that races the
        // members fetch would poison the mirror and show "0 members" after reload.
        members: Array.isArray(cache.members) && cache.members.length ? cache.members : null,
        oldestMessageId: cache.oldestMessageId || null,
        channelAnchors: cache.channelAnchors || null,
        updatedAt: Date.now()
      }));
    } catch {
    }
  }
  var localCacheWriteTimers = /* @__PURE__ */ new Map();
  function scheduleLocalGroupCacheWrite(groupId, cache) {
    if (localCacheWriteTimers.has(String(groupId))) return;
    localCacheWriteTimers.set(String(groupId), setTimeout(() => {
      localCacheWriteTimers.delete(String(groupId));
      writeLocalGroupCache(groupId, cache);
    }, 400));
  }
  function flushScheduledLocalCacheWrites() {
    for (const [groupId, timer] of localCacheWriteTimers) {
      clearTimeout(timer);
      localCacheWriteTimers.delete(groupId);
      writeLocalGroupCache(groupId, ensureGroupCacheEntry(groupId));
    }
  }
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushScheduledLocalCacheWrites);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushScheduledLocalCacheWrites();
    });
  }
  var READ_CURSORS_STORAGE_KEY = "gchat-read-cursors-v1";
  var readCursors = loadReadCursors();
  function loadReadCursors() {
    try {
      return JSON.parse(localStorage.getItem(READ_CURSORS_STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }
  function persistReadCursors() {
    try {
      localStorage.setItem(READ_CURSORS_STORAGE_KEY, JSON.stringify(readCursors));
    } catch {
    }
  }
  function isCursorNewerThan(at, id, otherAt, otherId) {
    const cmp = String(at || "").localeCompare(String(otherAt || ""));
    if (cmp !== 0) return cmp > 0;
    return String(id || "") > String(otherId || "");
  }
  function setLocalReadCursor(groupId, topic, cursor) {
    const groupKey = String(groupId);
    const channel = topic || DEFAULT_TAG_TOPIC;
    readCursors[groupKey] = readCursors[groupKey] || {};
    const current = readCursors[groupKey][channel];
    if (current && current.at && !isCursorNewerThan(cursor?.at, cursor?.id, current.at, current.id)) {
      return;
    }
    readCursors[groupKey][channel] = { at: cursor?.at || "", id: cursor?.id || "" };
    persistReadCursors();
  }
  function getLocalReadCursor(groupId, topic) {
    return readCursors[String(groupId)]?.[topic || DEFAULT_TAG_TOPIC] || null;
  }
  function isMessageReadByCursor(msg, groupId, channel) {
    if (!msg) return false;
    if (String(msg.senderId) === String(currentUser?.id)) return true;
    const cursor = getLocalReadCursor(groupId, channel || resolveMessageTagTopic(msg));
    if (!cursor || !cursor.at) return false;
    const cmp = String(msg.createdAt || "").localeCompare(String(cursor.at));
    if (cmp !== 0) return cmp < 0;
    return String(msg.id) <= String(cursor.id);
  }
  async function channelTagIndex(topic, groupId) {
    if (!topic || topic === DEFAULT_TAG_TOPIC) return null;
    const key = getGroupKey(groupId);
    if (!key) return null;
    try {
      return await blindIndex(topic, key, groupId, "tag-index");
    } catch {
      return null;
    }
  }
  var HISTORY_DB_NAME = "gchat-history-v1";
  var HISTORY_DB_VERSION = 1;
  var HISTORY_MESSAGES_STORE = "messages";
  var HISTORY_META_STORE = "meta";
  var HISTORY_MAX_MESSAGES_PER_GROUP = 5e3;
  var HISTORY_RENDER_WINDOW = 800;
  var historyDbPromise = null;
  var historyDbSupported = typeof indexedDB !== "undefined";
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
          const store = db.createObjectStore(HISTORY_MESSAGES_STORE, { keyPath: "id" });
          store.createIndex("groupId", "groupId", { unique: false });
        }
        if (!db.objectStoreNames.contains(HISTORY_META_STORE)) {
          db.createObjectStore(HISTORY_META_STORE, { keyPath: "groupId" });
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
        transaction.onerror = () => reject(transaction.error || new Error("history store error"));
        transaction.onabort = () => reject(transaction.error || new Error("history store aborted"));
      });
    }).catch(() => null);
  }
  function persistHistoryMessages(groupId, messages) {
    if (!messages || !messages.length) return Promise.resolve();
    if (!historyDbSupported) return Promise.resolve();
    const cacheable = getCacheableMessages(messages);
    if (!cacheable.length) return Promise.resolve();
    return (async () => {
      const hydrated = [];
      for (const msg of cacheable) {
        if (!getMessageHashtagKey(msg) && Number(msg.encryptionVersion) === 2 && msg.encryptedMetadata && msg.metadataIv) {
          try {
            await hydrateMessageChannel(msg, groupId);
          } catch {
          }
          if (!getMessageHashtagKey(msg)) msg._channelUnknown = true;
        }
        hydrated.push(msg);
      }
      invalidateHistoryReadMemo(groupId);
      await runHistoryStore(HISTORY_MESSAGES_STORE, "readwrite", (store) => {
        for (const msg of hydrated) {
          store.put({ id: String(msg.id), groupId: String(groupId), createdAt: msg.createdAt || "", msg });
        }
      });
      await pruneHistoryMessages(groupId);
    })();
  }
  async function pruneHistoryMessages(groupId) {
    if (!historyDbSupported) return;
    const key = String(groupId);
    try {
      const countRequest = await runHistoryStore(HISTORY_MESSAGES_STORE, "readonly", (store) => {
        const request = store.index("groupId").count(key);
        request.onsuccess = () => {
          request._count = request.result;
        };
        return request;
      });
      if (!countRequest || !Number.isFinite(countRequest._count)) return;
      if (countRequest._count <= HISTORY_MAX_MESSAGES_PER_GROUP) return;
      const messages = await readHistoryMessages(groupId);
      const excess = messages.length - HISTORY_MAX_MESSAGES_PER_GROUP;
      if (excess <= 0) return;
      const excessIds = messages.slice(0, excess).map((m) => String(m.id));
      await runHistoryStore(HISTORY_MESSAGES_STORE, "readwrite", (store) => {
        for (const id of excessIds) store.delete(id);
      });
      invalidateHistoryReadMemo(key);
    } catch {
    }
  }
  var historyReadMemo = /* @__PURE__ */ new Map();
  function invalidateHistoryReadMemo(groupId) {
    historyReadMemo.delete(String(groupId));
  }
  function readHistoryMessages(groupId) {
    const key = String(groupId);
    const memoized = historyReadMemo.get(key);
    if (memoized) return Promise.resolve(memoized);
    return runHistoryStore(HISTORY_MESSAGES_STORE, "readonly", (store) => {
      const request = store.index("groupId").getAll(key);
      request.onsuccess = () => {
        const rows = request.result || [];
        const messages = rows.map((row) => row.msg).filter(Boolean).sort((a, b) => {
          const timeDiff = String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
          return timeDiff !== 0 ? timeDiff : String(a.id).localeCompare(String(b.id));
        });
        if (messages.length > HISTORY_MAX_MESSAGES_PER_GROUP) {
          messages.splice(0, messages.length - HISTORY_MAX_MESSAGES_PER_GROUP);
        }
        request._messages = messages;
      };
    }).then((request) => {
      if (request && request._messages) {
        historyReadMemo.set(key, request._messages);
        return request._messages;
      }
      return [];
    });
  }
  function readHistoryCursor(groupId) {
    return runHistoryStore(HISTORY_META_STORE, "readonly", (store) => {
      const request = store.get(String(groupId));
      request.onsuccess = () => {
        const row = request.result;
        request._cursor = row?.lastSyncedAt ? { at: String(row.lastSyncedAt), id: String(row.lastSyncedId || "") } : null;
      };
    }).then((request) => request && request._cursor ? request._cursor : null);
  }
  function writeHistoryCursor(groupId, cursor) {
    const at = cursor && (cursor.at || cursor);
    const id = cursor && cursor.id || "";
    if (!at) return Promise.resolve();
    return runHistoryStore(HISTORY_META_STORE, "readwrite", (store) => {
      store.put({ groupId: String(groupId), lastSyncedAt: String(at), lastSyncedId: String(id), updatedAt: Date.now() });
    });
  }
  function clearGroupHistoryStore(groupId) {
    invalidateHistoryReadMemo(groupId);
    const messageClear = runHistoryStore(HISTORY_MESSAGES_STORE, "readwrite", (store) => {
      const request = store.index("groupId").openKeyCursor(String(groupId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
    });
    const metaClear = runHistoryStore(HISTORY_META_STORE, "readwrite", (store) => store.delete(String(groupId)));
    return Promise.all([messageClear, metaClear]).then(() => null);
  }
  function deleteHistoryMessage(groupId, messageId) {
    if (!groupId || !messageId) return Promise.resolve();
    invalidateHistoryReadMemo(groupId);
    return runHistoryStore(HISTORY_MESSAGES_STORE, "readwrite", (store) => store.delete(String(messageId)));
  }
  var historyMigrationStarted = false;
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
        const parsed = JSON.parse(localStorage.getItem(key) || "null");
        if (parsed && Array.isArray(parsed.messages) && parsed.messages.length) {
          tasks.push(persistHistoryMessages(groupId, parsed.messages));
        }
      } catch {
      }
    }
    await Promise.allSettled(tasks);
  }
  function sortMessagesChronologically(messages) {
    return [...messages].sort((a, b) => {
      const aTime = parseMessageDate(a.createdAt).getTime();
      const bTime = parseMessageDate(b.createdAt).getTime();
      const timeDiff = (Number.isFinite(aTime) ? aTime : 0) - (Number.isFinite(bTime) ? bTime : 0);
      return timeDiff !== 0 ? timeDiff : String(a.id).localeCompare(String(b.id));
    });
  }
  function mergeMessagesIntoCache(groupId, incoming, { persist = true } = {}) {
    const cache = ensureGroupCacheEntry(groupId);
    const existing = Array.isArray(cache.messages) ? cache.messages : [];
    const byId = new Map(existing.map((m) => [String(m.id), m]));
    for (const m of incoming) byId.set(String(m.id), m);
    const merged = sortMessagesChronologically([...byId.values()]);
    for (const m of merged) {
      if (m.hasRead === true && m.readConfirmed !== true) m.readConfirmed = true;
    }
    cache.messages = merged;
    cache.oldestMessageId = merged.length ? merged[0].id : null;
    cache.rowsDirty = true;
    if (persist) {
      writeLocalGroupCache(groupId, cache);
      if (historyDbSupported && incoming.length) void persistHistoryMessages(groupId, incoming);
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
    if ("caches" in window) {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      } catch {
      }
    }
    if ("serviceWorker" in navigator) {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      } catch {
      }
    }
    if (!includeLocalData) return;
    const preservedLocalEntries = capturePreservedLocalStorageEntries();
    await clearIndexedDbDatabases();
    clearAccessibleCookies();
    try {
      sessionStorage.clear();
    } catch {
    }
    try {
      localStorage.clear();
    } catch {
    }
    restorePreservedLocalStorageEntries(preservedLocalEntries);
    derivedKeyCache.clear();
    clearAllMessageVisibilityTimers();
    groupDataCache.clear();
    groupPreloadPromises.clear();
    hiddenDisappearingMessageIds = /* @__PURE__ */ new Set();
  }
  function buildReloadUrl() {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("_gchat_reload", String(Date.now()));
    return nextUrl.toString();
  }
  async function reloadAppShell() {
    if (window.electronAPI?.reloadHostedApp) {
      try {
        const reloaded = await window.electronAPI.reloadHostedApp();
        if (reloaded) return;
      } catch {
      }
    }
    window.location.replace(buildReloadUrl());
  }
  var sessionExpiredPending = false;
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
  var LAST_SEEN_DEPLOY_KEY = "gchat:last-seen-deploy";
  var autoResetScheduled = false;
  function readLastSeenDeploy() {
    try {
      const raw = localStorage.getItem(LAST_SEEN_DEPLOY_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function writeLastSeenDeploy(version, buildFingerprint) {
    try {
      localStorage.setItem(LAST_SEEN_DEPLOY_KEY, JSON.stringify({
        version: String(version || ""),
        buildFingerprint: String(buildFingerprint || "")
      }));
    } catch {
    }
  }
  function scheduleAutoResetClientCache(info) {
    if (!info || autoResetScheduled) return;
    const lastSeen = readLastSeenDeploy();
    const lastFp = String(lastSeen && lastSeen.buildFingerprint || "");
    const lastVer = String(lastSeen && lastSeen.version || "");
    const newFp = String(info.buildFingerprint || "");
    const newVer = String(info.version || "");
    if (!lastSeen) {
      writeLastSeenDeploy(newVer, newFp);
      return;
    }
    const sameBuild = lastFp ? lastFp === newFp && lastVer === newVer : lastVer === newVer && lastVer !== "";
    if (sameBuild) return;
    autoResetScheduled = true;
    writeLastSeenDeploy(newVer, newFp);
    const jitterMs = 1500 + Math.floor(Math.random() * 8e3);
    setTimeout(() => {
      void clearCacheAndRestartApp();
    }, jitterMs);
  }
  async function fetchAppVersionInfo() {
    try {
      const versionRes = await fetch("/api/meta/version", { cache: "no-store" });
      if (!versionRes.ok) return null;
      const info = await versionRes.json().catch(() => null);
      return info && typeof info.version === "string" ? info : null;
    } catch {
      return null;
    }
  }
  async function checkForHostedAppUpdate() {
    const info = await fetchAppVersionInfo();
    if (!info) return false;
    currentAppVersion = currentAppVersion || info.version;
    appVersionLabel = "v" + info.version;
    $("app-version-label").textContent = appVersionLabel;
    if (currentAppVersion === info.version && hostedAppReloadPending) return false;
    currentAppVersion = info.version;
    hostedAppReloadPending = true;
    scheduleAutoResetClientCache(info);
    return true;
  }
  function startHostedAppUpdatePolling() {
    if (hostedAppUpdateTimer) clearInterval(hostedAppUpdateTimer);
    hostedAppUpdateTimer = setInterval(() => {
      if (document.hidden) return;
      void checkForHostedAppUpdate();
    }, HOSTED_APP_UPDATE_CHECK_INTERVAL_MS);
  }
  function createUploadId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function truncate(s, n) {
    return s && s.length > n ? s.slice(0, n) + "\u2026" : s;
  }
  function normalizeIsoTime(iso) {
    if (!iso) return "";
    const str = String(iso).replace(" ", "T");
    return str.endsWith("Z") || str.includes("+") ? str : str + "Z";
  }
  function isAllowedUploadImageType(type) {
    return typeof type === "string" && ALLOWED_UPLOAD_IMAGE_TYPES.has(type.toLowerCase());
  }
  function estimateBase64Bytes(value) {
    if (typeof value !== "string" || !value) return 0;
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
  }
  function getLocalDayKey(iso) {
    if (!iso) return "";
    const date = parseMessageDate(iso);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  function parseMessageDate(iso) {
    return new Date(normalizeIsoTime(iso));
  }
  function formatTime(iso) {
    if (!iso) return "";
    return localTimeFormatter.format(parseMessageDate(iso));
  }
  function formatFullMessageTime(iso) {
    const date = parseMessageDate(iso);
    const now = /* @__PURE__ */ new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const time = localTimeFormatter.format(date);
    if (getLocalDayKey(iso) === getLocalDayKey(now.toISOString())) return `Today at ${time}`;
    if (getLocalDayKey(iso) === getLocalDayKey(yesterday.toISOString())) return `Yesterday at ${time}`;
    return `${localDayFormatter.format(date)} at ${time}`;
  }
  function formatDay(iso) {
    if (!iso) return "";
    const date = parseMessageDate(iso);
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
  }
  function isSameMessageDay(a, b) {
    if (!a || !b) return false;
    return getLocalDayKey(a) === getLocalDayKey(b);
  }
  function shouldContinueSeries(prevMsg, currentMsg) {
    if (!prevMsg || !currentMsg) return false;
    if (prevMsg.type === "system" || currentMsg.type === "system") return false;
    if (prevMsg.senderId !== currentMsg.senderId) return false;
    if (resolveMessageTagTopic(prevMsg) !== resolveMessageTagTopic(currentMsg)) return false;
    if (!isSameMessageDay(prevMsg.createdAt, currentMsg.createdAt)) return false;
    const prevTime = parseMessageDate(prevMsg.createdAt).getTime();
    const currentTime = parseMessageDate(currentMsg.createdAt).getTime();
    const gapMinutes = (currentTime - prevTime) / 6e4;
    return gapMinutes >= 0 && gapMinutes <= 7;
  }
  function createDateDivider(iso) {
    const el = document.createElement("div");
    el.className = "msg-date-divider";
    el.textContent = formatDay(iso);
    return el;
  }
  function renderAvatarElement(target, userLike = {}) {
    if (!target) return;
    target.replaceChildren();
    const username = userLike.username || userLike.senderName || "?";
    if (userLike.profilePicture) {
      target.style.background = "none";
      target.textContent = "";
      target.appendChild(createAvatarImage(userLike.profilePicture));
      return;
    }
    target.style.background = userLike.iconColor || userLike.senderColor || "#4A90D9";
    target.textContent = username[0].toUpperCase();
  }
  function formatBytes(bytes) {
    const size = Math.max(0, Number(bytes) || 0);
    if (size === 0) return "0 B";
    if (size < 1024) return `${size} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = size / 1024;
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
      value /= 1024;
      idx += 1;
    }
    return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[idx]}`;
  }
  function isAiAssistantMessage(msg) {
    return String(msg?.senderId || "") === AI_ASSISTANT_USER_ID;
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
    if (!meta || typeof meta !== "object") return null;
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
    const estimatedCostUsd = Number.isFinite(estimatedCostUsdRaw) && estimatedCostUsdRaw >= 0 ? estimatedCostUsdRaw : null;
    const estimatedCostRmbRaw = Number(meta.estimatedCostRmb);
    const estimatedCostRmb = Number.isFinite(estimatedCostRmbRaw) && estimatedCostRmbRaw >= 0 ? estimatedCostRmbRaw : estimatedCostUsd != null ? estimatedCostUsd * USD_TO_RMB_RATE : null;
    const modelKey = String(meta.model || "").trim();
    const modeKey = String(meta.mode || "").trim().toLowerCase();
    const toneKey = String(meta.tone || "").trim().toLowerCase();
    const webSearchRequestsRaw = Number(meta.webSearchRequests ?? meta.web_search_requests);
    const webSearchRequests = Number.isFinite(webSearchRequestsRaw) && webSearchRequestsRaw > 0 ? Math.max(0, Math.round(webSearchRequestsRaw)) : 0;
    const toolCallsRaw = Number(meta.toolCalls ?? meta.tool_calls);
    const toolCalls = Number.isFinite(toolCallsRaw) && toolCallsRaw > 0 ? Math.max(0, Math.round(toolCallsRaw)) : 0;
    const toolRoundsRaw = Number(meta.toolRounds ?? meta.tool_rounds);
    const toolRounds = Number.isFinite(toolRoundsRaw) && toolRoundsRaw > 0 ? Math.max(0, Math.round(toolRoundsRaw)) : 0;
    return {
      model: AI_MODEL_ALIASES[modelKey] || modelKey || DEFAULT_AI_MODEL,
      mode: AI_MODE_LABELS[modeKey] ? modeKey : DEFAULT_AI_MODE,
      tone: AI_TONE_LABELS[toneKey] ? toneKey : DEFAULT_AI_TONE,
      webSearchEnabled: meta.webSearchEnabled === true || meta.web_search_enabled === true,
      webSearchRequests,
      toolCalls,
      toolRounds,
      promptTokens,
      completionTokens,
      totalTokens,
      rawPromptTokens,
      rawCompletionTokens,
      rawTotalTokens,
      estimatedCostUsd,
      estimatedCostRmb
    };
  }
  function formatCurrencyValue(value, symbol) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return "";
    if (amount > 0 && amount < MIN_CURRENCY_DISPLAY_THRESHOLD) {
      return `${symbol}${amount.toFixed(SMALL_CURRENCY_PRECISION)}`;
    }
    return `${symbol}${amount.toFixed(2)}`;
  }
  function formatRmbCost(value) {
    return formatCurrencyValue(value, "\xA5");
  }
  function getAiModelLabel(model) {
    const key = String(model || "").trim();
    const canonical = AI_MODEL_ALIASES[key] || key;
    return AI_MODEL_OPTIONS[canonical] || canonical || AI_MODEL_OPTIONS[DEFAULT_AI_MODEL];
  }
  function slugifyAiTagPart(value, fallback = "ai") {
    const slug = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || fallback;
  }
  function getAiModelTag(model) {
    const normalizedModel = String(model || "").trim();
    if (AI_MODEL_TAGS[normalizedModel]) return AI_MODEL_TAGS[normalizedModel];
    return slugifyAiTagPart(getAiModelLabel(normalizedModel));
  }
  function getAiModeLabel(mode) {
    const normalizedMode = String(mode || "").trim().toLowerCase();
    if (normalizedMode === "context") return AI_MODE_LABELS.thinking;
    return AI_MODE_LABELS[normalizedMode] || AI_MODE_LABELS[DEFAULT_AI_MODE];
  }
  function getAiModeTag(mode) {
    const normalizedMode = String(mode || "").trim().toLowerCase();
    if (normalizedMode === "agent") return "agent";
    if (normalizedMode === "thinking" || normalizedMode === "context") return "context";
    return normalizedMode === "fast" ? "fast" : "context";
  }
  function getAiToneLabel(tone) {
    return AI_TONE_LABELS[String(tone || "").trim().toLowerCase()] || AI_TONE_LABELS[DEFAULT_AI_TONE];
  }
  function getAiAssistantProfilePicture(model) {
    const key = String(model || "").trim();
    const canonical = AI_MODEL_ALIASES[key] || key;
    return AI_MODEL_PROFILE_PICTURES[canonical] || AI_ASSISTANT_PROFILE_PICTURE;
  }
  function buildAiMentionLabel(meta) {
    const normalized = normalizeAiMeta(meta);
    if (!normalized) return "@AI";
    return `@${getAiModelTag(normalized.model)}-${getAiModeTag(normalized.mode)}-${normalized.tone}`;
  }
  function buildAiMetaDisplay(meta) {
    const normalized = normalizeAiMeta(meta);
    if (!normalized) return null;
    const infoParts = [
      getAiModelLabel(normalized.model),
      getAiModeLabel(normalized.mode),
      getAiToneLabel(normalized.tone)
    ];
    const statsParts = [];
    if (normalized.totalTokens > 0) {
      statsParts.push(`${formatAiTokenAmount(normalized.totalTokens)} tokens`);
    }
    const costText = formatRmbCost(normalized.estimatedCostRmb);
    if (costText) statsParts.push(costText);
    if (normalized.toolCalls > 0) {
      statsParts.push(`${normalized.toolCalls} tool call${normalized.toolCalls === 1 ? "" : "s"}${normalized.toolRounds > 1 ? ` in ${normalized.toolRounds} rounds` : ""}`);
    }
    if (normalized.webSearchRequests > 0) {
      statsParts.push(`${normalized.webSearchRequests} web search${normalized.webSearchRequests === 1 ? "" : "es"}`);
    } else if (normalized.webSearchEnabled) {
      statsParts.push("web search enabled");
    }
    return {
      info: infoParts.join(", "),
      stats: statsParts.join(" \u2014 ")
    };
  }
  function createAiMentionChip(meta) {
    const chip = document.createElement("span");
    chip.className = "msg-ai-chip";
    chip.textContent = buildAiMentionLabel(meta);
    return chip;
  }
  function createAiMetaElement(meta) {
    const display = buildAiMetaDisplay(meta);
    if (!display) return null;
    const el = document.createElement("div");
    el.className = "msg-ai-meta";
    const info = document.createElement("span");
    info.className = "msg-ai-meta-info";
    info.textContent = display.info;
    const stats = document.createElement("span");
    stats.className = "msg-ai-meta-stats";
    stats.textContent = display.stats;
    el.append(info, stats);
    return el;
  }
  function normalizeAiUsageSection(value) {
    if (!value || typeof value !== "object") return null;
    const dailyLimit = Math.max(0, Math.round(Number(value.dailyLimit) || 0));
    const usedTokens = roundAiTokenAmount(value.usedTokens);
    return {
      ...value,
      dailyLimit,
      usedTokens,
      remainingTokens: roundAiTokenAmount(
        Number.isFinite(Number(value.remainingTokens)) ? Number(value.remainingTokens) : dailyLimit - usedTokens
      ),
      exceeded: !!value.exceeded || dailyLimit <= 0 || usedTokens >= dailyLimit
    };
  }
  function normalizeAiUsageSummary(value) {
    if (!value || typeof value !== "object") return null;
    const currentUserUsage = normalizeAiUsageSection(value.currentUser);
    const globalUsage = normalizeAiUsageSection(value.global);
    return {
      currentUser: currentUserUsage,
      global: globalUsage,
      window: value.window && typeof value.window === "object" ? value.window : {},
      canStartRequest: value.canStartRequest !== void 0 ? !!value.canStartRequest : !(currentUserUsage?.exceeded || globalUsage?.exceeded)
    };
  }
  function formatAiUsageValue(section) {
    if (!section) return "0 / 0 tokens";
    return `${formatAiTokenAmount(section.usedTokens)} / ${integerFormatter.format(section.dailyLimit)} tokens`;
  }
  function getAiUsagePercent(section) {
    if (!section) return 0;
    if (section.dailyLimit <= 0) return 100;
    return Math.max(0, Math.min(100, section.usedTokens / section.dailyLimit * 100));
  }
  function getAiQuotaBlockedMessage(summary = aiUsageSummary) {
    if (!summary) return "";
    if (summary.global?.exceeded) return `Global daily AI token limit reached. Try again after ${AI_RESET_TIME_LABEL}.`;
    if (summary.currentUser?.exceeded) return `Your daily AI token limit reached. Try again after ${AI_RESET_TIME_LABEL}.`;
    return "";
  }
  function renderUsageBar(fillEl, valueEl, noteEl, section, options = {}) {
    if (fillEl) fillEl.style.width = `${getAiUsagePercent(section)}%`;
    if (valueEl) valueEl.textContent = formatAiUsageValue(section);
    if (noteEl) {
      const blockedMessage = options.blockedMessage || "";
      noteEl.textContent = blockedMessage || options.note || AI_USAGE_RESET_LABEL;
    }
  }
  function renderProfileAiUsage() {
    const card = $("profile-ai-usage-card");
    if (!card) return;
    const blockedMessage = getAiQuotaBlockedMessage();
    renderUsageBar(
      $("profile-ai-usage-fill"),
      $("profile-ai-usage-value"),
      $("profile-ai-usage-note"),
      aiUsageSummary?.currentUser || null,
      { blockedMessage }
    );
    card.classList.toggle("is-blocked", !!blockedMessage);
  }
  function setAiUsageSummary(summary) {
    aiUsageSummary = normalizeAiUsageSummary(summary);
    renderProfileAiUsage();
    updateAiControls();
    if ($("user-management-modal") && !$("user-management-modal").hidden) {
      void loadUserManagementSummary();
    }
  }
  async function refreshAiUsageSummary() {
    if (!aiFeatureEnabled) return null;
    try {
      const res = await fetch("/api/ai/usage");
      if (!res.ok) return null;
      const data = await res.json();
      setAiUsageSummary(data);
      return aiUsageSummary;
    } catch {
      return null;
    }
  }
  function normalizeManagedUserSummary(value) {
    if (!value || typeof value !== "object") return null;
    return {
      users: Array.isArray(value.users) ? value.users.map((user) => ({
        id: user.id,
        username: String(user.username || "Unknown"),
        iconColor: user.iconColor || "#4A90D9",
        profilePicture: user.profilePicture || null,
        aiDailyTokenLimit: Math.max(0, Math.round(Number(user.aiDailyTokenLimit) || 0)),
        aiTokensUsedToday: roundAiTokenAmount(user.aiTokensUsedToday),
        aiLimitExceeded: !!user.aiLimitExceeded
      })) : [],
      viewerCanManageAiLimits: !!value.viewerCanManageAiLimits,
      viewerCanDeleteUsers: !!value.viewerCanDeleteUsers,
      global: normalizeAiUsageSection(value.global),
      window: value.window && typeof value.window === "object" ? value.window : {}
    };
  }
  function setUserManagementLoading(message = "Loading users\u2026") {
    const list = $("user-management-list");
    if (!list) return;
    list.replaceChildren();
    if (message === "Loading users\u2026") {
      for (let i = 0; i < 4; i += 1) {
        const row = document.createElement("div");
        row.className = "user-management-user user-management-user-skeleton";
        row.innerHTML = '<div class="member-avatar"></div><div class="user-management-user-main"><div class="user-management-user-head"><div class="user-management-user-summary"><div class="user-management-skeleton-line user-management-skeleton-line-title"></div><div class="user-management-skeleton-line"></div></div></div></div>';
        list.appendChild(row);
      }
      return;
    }
    const empty = document.createElement("div");
    empty.className = "user-management-empty";
    empty.textContent = message;
    list.appendChild(empty);
  }
  function renderUserManagementPanel() {
    const summary = userManagementSummary;
    renderUsageBar(
      $("user-management-global-fill"),
      $("user-management-global-value"),
      $("user-management-reset-note"),
      summary?.global || null,
      { blockedMessage: summary?.global?.exceeded ? "Global limit reached until the next Shanghai reset." : "" }
    );
    $("user-management-global-actions").hidden = !summary?.viewerCanManageAiLimits;
    if (summary?.viewerCanManageAiLimits) {
      $("user-management-global-limit-input").value = String(summary.global?.dailyLimit || 0);
    }
    const list = $("user-management-list");
    if (!list) return;
    list.replaceChildren();
    const users = summary?.users || [];
    if (!users.length) {
      setUserManagementLoading("No users found");
      return;
    }
    for (const user of users) {
      const row = document.createElement("div");
      row.className = "user-management-user";
      row.dataset.userId = user.id;
      const avatar = document.createElement("div");
      avatar.className = "member-avatar";
      renderAvatarElement(avatar, user);
      const main = document.createElement("div");
      main.className = "user-management-user-main";
      const head = document.createElement("div");
      head.className = "user-management-user-head";
      const summaryText = document.createElement("div");
      summaryText.className = "user-management-user-summary";
      const name = document.createElement("div");
      name.className = "user-management-user-name";
      name.textContent = user.username;
      const value = document.createElement("div");
      value.className = "user-management-user-value";
      value.textContent = `${formatAiTokenAmount(user.aiTokensUsedToday)} / ${integerFormatter.format(user.aiDailyTokenLimit)} tokens`;
      const usage = document.createElement("div");
      usage.className = "user-management-user-usage";
      const track = document.createElement("div");
      track.className = "usage-bar-track user-management-user-track";
      const fill = document.createElement("div");
      fill.className = "usage-bar-fill";
      fill.style.width = `${getAiUsagePercent({
        usedTokens: user.aiTokensUsedToday,
        dailyLimit: user.aiDailyTokenLimit
      })}%`;
      track.appendChild(fill);
      usage.append(value, track);
      summaryText.append(name);
      head.append(summaryText, usage);
      main.append(head);
      if (summary.viewerCanManageAiLimits || summary.viewerCanDeleteUsers && user.username !== APP_OWNER_USERNAME) {
        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "btn-icon user-management-expand-btn";
        toggleBtn.setAttribute("aria-expanded", "false");
        setElementIcon(toggleBtn, "panel-right", {
          iconOnly: true,
          label: `Show actions for ${user.username}`
        });
        toggleBtn.addEventListener("click", () => {
          const expanded = row.classList.toggle("expanded");
          toggleBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
          toggleBtn.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} actions for ${user.username}`);
          toggleBtn.title = `${expanded ? "Hide" : "Show"} actions for ${user.username}`;
        });
        head.appendChild(toggleBtn);
        const actions = document.createElement("div");
        actions.className = "user-management-user-actions";
        if (summary.viewerCanManageAiLimits) {
          const limitInput = document.createElement("input");
          limitInput.type = "number";
          limitInput.min = "0";
          limitInput.step = "1";
          limitInput.value = String(user.aiDailyTokenLimit);
          limitInput.setAttribute("aria-label", `${user.username} daily AI token limit`);
          const saveBtn = document.createElement("button");
          saveBtn.className = "btn-primary btn-sm user-management-save-btn";
          saveBtn.textContent = "Save limit";
          saveBtn.addEventListener("click", async () => {
            $("user-management-error").textContent = "";
            const res = await fetch(`/api/users/${encodeURIComponent(user.id)}/ai-limit`, {
              method: "PATCH",
              headers: apiHeaders(),
              body: JSON.stringify({ dailyLimit: limitInput.value })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              $("user-management-error").textContent = data.error || "Failed to save user limit";
              return;
            }
            await Promise.all([loadUserManagementSummary(), refreshAiUsageSummary()]);
          });
          actions.append(limitInput, saveBtn);
        }
        if (summary.viewerCanDeleteUsers && user.username !== APP_OWNER_USERNAME) {
          const deleteBtn = document.createElement("button");
          deleteBtn.className = "btn-danger btn-sm user-management-delete-btn";
          deleteBtn.textContent = "Delete user";
          deleteBtn.addEventListener("click", () => {
            showConfirm("Delete User", `Delete ${user.username}? This cannot be undone.`, async () => {
              const res = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
                method: "DELETE",
                headers: apiHeaders()
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok) {
                $("user-management-error").textContent = data.error || "Failed to delete user";
                return;
              }
              await Promise.all([loadUserManagementSummary(), refreshAiUsageSummary()]);
            }, { destructive: true });
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
      const res = await fetch("/api/users/management");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        $("user-management-error").textContent = data.error || "Failed to load users";
        return null;
      }
      userManagementSummary = normalizeManagedUserSummary(data);
      $("user-management-error").textContent = "";
      renderUserManagementPanel();
      return userManagementSummary;
    } catch {
      $("user-management-error").textContent = "Failed to load users";
      return null;
    }
  }
  function clearMarkdownRenderState(target) {
    if (!target) return;
    target.classList.remove("markdown-rendered");
    delete target.dataset.markdownSource;
  }
  function renderPlainText(target, text) {
    if (!target) return;
    clearMarkdownRenderState(target);
    target.textContent = text || "";
  }
  function normalizeMarkdownLinkUrl(url) {
    if (typeof url !== "string") return null;
    try {
      const parsed = new URL(url);
      return /^https?:$/.test(parsed.protocol) ? parsed.href : null;
    } catch {
      return null;
    }
  }
  function appendMarkdownInline(target, text) {
    const source = String(text || "");
    let plain = "";
    const flushPlain = () => {
      if (!plain) return;
      target.appendChild(document.createTextNode(plain));
      plain = "";
    };
    for (let i = 0; i < source.length; i += 1) {
      if (source.startsWith("**", i)) {
        const end = source.indexOf("**", i + 2);
        if (end > i + 2) {
          flushPlain();
          const strong = document.createElement("strong");
          strong.textContent = source.slice(i + 2, end);
          target.appendChild(strong);
          i = end + 1;
          continue;
        }
      }
      if (source[i] === "*" && source[i + 1] !== "*") {
        const end = source.indexOf("*", i + 1);
        if (end > i + 1) {
          flushPlain();
          const em = document.createElement("em");
          em.textContent = source.slice(i + 1, end);
          target.appendChild(em);
          i = end;
          continue;
        }
      }
      if (source[i] === "`") {
        const end = source.indexOf("`", i + 1);
        if (end > i + 1) {
          flushPlain();
          const code = document.createElement("code");
          code.textContent = source.slice(i + 1, end);
          target.appendChild(code);
          i = end;
          continue;
        }
      }
      if (source.startsWith("~~", i)) {
        const end = source.indexOf("~~", i + 2);
        if (end > i + 2) {
          flushPlain();
          const del = document.createElement("del");
          del.textContent = source.slice(i + 2, end);
          target.appendChild(del);
          i = end + 1;
          continue;
        }
      }
      if (source[i] === "[") {
        const labelEnd = source.indexOf("]", i + 1);
        const hasUrl = labelEnd > i + 1 && source[labelEnd + 1] === "(";
        if (hasUrl) {
          const urlEnd = source.indexOf(")", labelEnd + 2);
          if (urlEnd > labelEnd + 2) {
            const href = normalizeMarkdownLinkUrl(source.slice(labelEnd + 2, urlEnd).trim());
            if (href) {
              flushPlain();
              const link = document.createElement("a");
              link.href = href;
              link.target = "_blank";
              link.rel = "noopener noreferrer";
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
    const parseRow = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    const wrap = document.createElement("div");
    wrap.className = "markdown-table-wrap";
    const table = document.createElement("table");
    const head = document.createElement("thead");
    const body = document.createElement("tbody");
    const headerCells = parseRow(lines[0] || "");
    const headerRow = document.createElement("tr");
    for (const cellText of headerCells) {
      const cell = document.createElement("th");
      appendMarkdownInline(cell, cellText);
      headerRow.appendChild(cell);
    }
    head.appendChild(headerRow);
    for (let i = 2; i < lines.length; i += 1) {
      const row = document.createElement("tr");
      for (const cellText of parseRow(lines[i])) {
        const cell = document.createElement("td");
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
    const wrapper = document.createElement("div");
    renderMarkdown(wrapper, text);
    wrapper.classList.remove("markdown-rendered");
    target.append(...wrapper.childNodes);
  }
  function renderMarkdown(target, text) {
    if (!target) return;
    target.replaceChildren();
    target.classList.add("markdown-rendered");
    target.dataset.markdownSource = String(text || "");
    const lines = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    let paragraphLines = [];
    const flushParagraph = () => {
      if (!paragraphLines.length) return;
      const paragraph = document.createElement("p");
      appendMarkdownInline(paragraph, paragraphLines.join(" "));
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
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = codeLines.join("\n");
        pre.appendChild(code);
        target.appendChild(pre);
        continue;
      }
      if (/^([-*_])(?:\s*\1){2,}$/.test(trimmed)) {
        flushParagraph();
        target.appendChild(document.createElement("hr"));
        continue;
      }
      const separatorLine = lines[i + 1] ? lines[i + 1].trim() : "";
      if (trimmed.includes("|") && /^\|?[\s:-]+\|[\s|:-]*$/.test(separatorLine)) {
        flushParagraph();
        const tableLines = [trimmed, separatorLine];
        let tableIndex = i + 2;
        while (tableIndex < lines.length) {
          const candidate = lines[tableIndex].trim();
          if (!candidate || !candidate.includes("|")) break;
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
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
          i += 1;
        }
        i -= 1;
        const blockquote = document.createElement("blockquote");
        renderMarkdownBlock(blockquote, quoteLines.join("\n"));
        target.appendChild(blockquote);
        continue;
      }
      const bulletMatch = /^[-*]\s+(.*)$/.exec(trimmed);
      if (bulletMatch) {
        flushParagraph();
        const list = document.createElement("ul");
        while (i < lines.length) {
          const itemMatch = /^[-*]\s+(.*)$/.exec(lines[i].trim());
          if (!itemMatch) break;
          const item = document.createElement("li");
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
        const list = document.createElement("ol");
        if (startNum !== 1) list.setAttribute("start", String(startNum));
        while (i < lines.length) {
          const itemMatch = /^\d+\.\s+(.*)$/.exec(lines[i].trim());
          if (!itemMatch) break;
          const item = document.createElement("li");
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
  function emitSocketWithAck(event, payload, timeoutMs = 12e3) {
    return new Promise((resolve, reject) => {
      if (!socket) {
        reject(new Error("Connection unavailable"));
        return;
      }
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Request timed out"));
      }, timeoutMs);
      socket.emit(event, payload, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (response && response.ok) {
          resolve(response);
          return;
        }
        reject(new Error(response?.error || "Request failed"));
      });
    });
  }
  function normalizeId(value) {
    return String(value || "");
  }
  var DEFAULT_TAG_TOPIC = "main";
  var MAX_TAG_TOPIC_LENGTH = 12;
  var CHANNEL_PREF_KEY_PREFIX = "gchat:active-channel:";
  var GLOBAL_GROUP_ID = "gchat-global";
  var GLOBAL_GROUP_ICON_SRC = "/gchat_icon.png";
  function isGlobalGroupId(groupId) {
    return String(groupId || "") === GLOBAL_GROUP_ID;
  }
  function isGlobalGroup(group) {
    return !!(group && (group.isGlobal === true || isGlobalGroupId(group.id)));
  }
  function isCurrentGroupGlobal() {
    return isGlobalGroup(currentGroupData) || isGlobalGroupId(currentGroupId);
  }
  function normalizeHashtagTopic(value) {
    if (value == null || value === "") return null;
    const trimmed = String(value).trim().replace(/^#/, "").toLowerCase();
    if (!trimmed || trimmed.length > MAX_TAG_TOPIC_LENGTH) return null;
    return /^[a-z0-9_-]+$/.test(trimmed) ? trimmed : null;
  }
  function channelPrefKey(groupId, userId = currentUser && currentUser.id) {
    if (!groupId || !userId) return null;
    return `${CHANNEL_PREF_KEY_PREFIX}${userId}:${groupId}`;
  }
  function readTagOrder(groupId) {
    if (!groupId) return null;
    try {
      const raw = localStorage.getItem(`gchat:tag-order:${groupId}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return parsed.filter((topic) => normalizeHashtagTopic(topic) !== null);
    } catch {
      return null;
    }
  }
  function writeTagOrder(groupId, topics) {
    if (!groupId) return;
    const normalized = topics.map(normalizeHashtagTopic).filter((topic) => topic !== null && topic !== DEFAULT_TAG_TOPIC);
    try {
      localStorage.setItem(`gchat:tag-order:${groupId}`, JSON.stringify([DEFAULT_TAG_TOPIC, ...normalized]));
    } catch {
    }
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
    }
  }
  var LAST_GROUP_STORAGE_KEY = "gchat:last-group";
  function readStoredLastGroupId() {
    try {
      return localStorage.getItem(LAST_GROUP_STORAGE_KEY) || null;
    } catch {
      return null;
    }
  }
  function writeStoredLastGroupId(groupId) {
    try {
      localStorage.setItem(LAST_GROUP_STORAGE_KEY, String(groupId));
    } catch {
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
  function resolveMessageTagTopic(msg) {
    return getMessageHashtagKey(msg) || DEFAULT_TAG_TOPIC;
  }
  async function hydrateMessageChannel(msg, groupId = msg?.groupId || currentGroupId) {
    if (!msg) return DEFAULT_TAG_TOPIC;
    if (!getMessageHashtagKey(msg) && Number(msg.encryptionVersion) === 2) {
      const key = groupId ? getGroupKey(groupId) : null;
      if (key && msg.encryptedMetadata && msg.metadataIv) {
        try {
          if (msg.type === "image" || msg.type === "file") {
            const metadata = await decryptJson(
              msg.encryptedMetadata,
              msg.metadataIv,
              key,
              groupId,
              "metadata",
              v2Aad({ ...msg, groupId })
            );
            Object.assign(msg, metadata);
          } else {
            await decryptV2Message(msg, key, groupId);
          }
        } catch {
        }
      }
    }
    const topic = resolveMessageTagTopic(msg);
    msg.hashtag = topic;
    if (groupId) rememberChannel(groupId, topic);
    if (!msg.tagIndex && groupId && topic && topic !== DEFAULT_TAG_TOPIC) {
      const key = getGroupKey(groupId);
      if (key) {
        try {
          msg.tagIndex = await blindIndex(topic, key, groupId, "tag-index");
        } catch {
        }
      }
    }
    return topic;
  }
  function formatHashtagLabel(topic) {
    return topic ? `#${topic}` : "";
  }
  function createHashtagChip(topic) {
    const chip = document.createElement("span");
    chip.className = "msg-hashtag-chip";
    chip.textContent = formatHashtagLabel(topic);
    return chip;
  }
  function getMessageHashtagKey(msg) {
    return normalizeHashtagTopic(msg && msg.hashtag);
  }
  function isDisappearingMessage(msg) {
    return !!(msg && msg.isDisappearing);
  }
  function computeDisappearingDurationMs(text) {
    const normalized = String(text || "").trim();
    const chars = normalized.length;
    return Math.max(
      MIN_DISAPPEARING_DURATION_MS,
      Math.min(
        MAX_DISAPPEARING_DURATION_MS,
        MIN_DISAPPEARING_DURATION_MS + chars * DISAPPEARING_DURATION_PER_CHAR_MS
      )
    );
  }
  function getHiddenDisappearingStorageKey(userId = currentUser && currentUser.id) {
    return userId ? `gchat:disappearing-hidden:user:${userId}` : null;
  }
  function loadHiddenDisappearingMessageIds(userId = currentUser && currentUser.id) {
    const key = getHiddenDisappearingStorageKey(userId);
    if (!key) return /* @__PURE__ */ new Set();
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "[]");
      return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      return /* @__PURE__ */ new Set();
    }
  }
  function persistHiddenDisappearingMessageIds(userId = currentUser && currentUser.id) {
    const key = getHiddenDisappearingStorageKey(userId);
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify([...hiddenDisappearingMessageIds]));
    } catch {
    }
  }
  function isMessageHiddenForCurrentUser(msg) {
    return !!(msg && currentUser && msg.senderId !== currentUser.id && isDisappearingMessage(msg) && (msg.disappearingHiddenAt || hiddenDisappearingMessageIds.has(String(msg.id))));
  }
  function getCacheableMessages(messages = []) {
    return (messages || []).filter((msg) => !isDisappearingMessage(msg));
  }
  function getMessageTypePreviewLabel(msg) {
    if (!msg) return "";
    if (msg.type === "image") return "[Image]";
    if (msg.type === "file") return "[File: " + (msg.filename || "") + "]";
    if (msg.type === "whisper") return "[Whisper]";
    return "";
  }
  function normalizeWallpaperSettings(settings = {}) {
    if (wallpaperTheme) return wallpaperTheme.normalizeSettings(settings);
    return {
      ...settings,
      wallpaperDataUrl: typeof settings.wallpaperDataUrl === "string" && settings.wallpaperDataUrl ? settings.wallpaperDataUrl : null,
      wallpaperBlur: DEFAULT_WALLPAPER_BLUR,
      wallpaperTransparency: DEFAULT_WALLPAPER_TRANSPARENCY
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
      wallpaperTransparency: normalized.wallpaperTransparency
    };
  }
  function wallpaperSettingsEqual(left, right) {
    const a = getWallpaperSettings(left);
    const b = getWallpaperSettings(right);
    return a.wallpaperDataUrl === b.wallpaperDataUrl && a.wallpaperBlur === b.wallpaperBlur && a.wallpaperTransparency === b.wallpaperTransparency;
  }
  function applyWallpaperPreviewStyle(dataUrl, blur, transparency) {
    const preview = $("wallpaper-current-preview");
    const overlay = $("wallpaper-current-preview-overlay");
    if (preview) {
      preview.src = dataUrl || DEFAULT_WALLPAPER_PREVIEW_SRC;
      preview.style.filter = `blur(${blur}px)`;
      preview.style.transform = blur > 0 ? "scale(1.08)" : "scale(1)";
    }
    if (overlay) {
      overlay.style.background = `rgba(0,0,0,${(100 - transparency) / 100})`;
    }
  }
  function syncWallpaperDraftControls(settings = appLocalSettings) {
    const normalized = getWallpaperSettings(settings);
    const blurInput = $("wallpaper-blur-input");
    const blurValue = $("wallpaper-blur-value");
    const transparencyInput = $("wallpaper-transparency-input");
    const transparencyValue = $("wallpaper-transparency-value");
    if (blurInput) blurInput.value = String(normalized.wallpaperBlur);
    if (blurValue) blurValue.textContent = `${normalized.wallpaperBlur}px`;
    if (transparencyInput) transparencyInput.value = String(normalized.wallpaperTransparency);
    if (transparencyValue) transparencyValue.textContent = `${normalized.wallpaperTransparency}%`;
  }
  function buildWallpaperDraft(overrides = {}) {
    return {
      ...getWallpaperSettings(appLocalSettings),
      ...wallpaperDraft || {},
      ...overrides
    };
  }
  function applyWallpaperFromSettings() {
    document.documentElement.style.setProperty("--chat-wallpaper", "none");
    document.documentElement.style.setProperty("--auth-wallpaper", "none");
    document.documentElement.style.setProperty("--wallpaper-blur", "0px");
    document.documentElement.style.setProperty("--wallpaper-overlay-opacity", "0");
    if (wallpaperTheme) {
      wallpaperTheme.applyToRoot({
        wallpaperDataUrl: null,
        wallpaperBlur: 0,
        wallpaperTransparency: 100,
        theme: appLocalSettings.theme || "light"
      });
    }
    applyWallpaperPreviewStyle(null, 0, 100);
    syncWallpaperDraftControls({ wallpaperDataUrl: null, wallpaperBlur: 0, wallpaperTransparency: 100 });
  }
  function resolveThemePreference(preference) {
    const selected = ["system", "dark", "light"].includes(preference) ? preference : "system";
    if (selected !== "system") return selected;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  function themeToggleButtons() {
    return Array.from(document.querySelectorAll(".theme-toggle-btn"));
  }
  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Unable to read image"));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(file);
    });
  }
  function syncDesktopBrandIcon() {
    const icon = document.querySelector(".brand-icon");
    if (!icon) return;
    const isLightTheme = document.documentElement.dataset.theme === "light";
    const nextSrc = isLightTheme ? icon.dataset.lightSrc : icon.dataset.darkSrc;
    if (nextSrc && icon.getAttribute("src") !== nextSrc) icon.src = nextSrc;
  }
  async function copyTextToClipboard(text) {
    if (typeof navigator.clipboard?.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
      }
    }
    const copyTarget = document.createElement("textarea");
    copyTarget.value = text;
    copyTarget.setAttribute("readonly", "");
    copyTarget.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
    document.body.append(copyTarget);
    copyTarget.select();
    const copied = document.execCommand("copy");
    copyTarget.remove();
    return copied;
  }
  function syncThemeToggleControl() {
    const preference = ["dark", "light"].includes(appLocalSettings.theme) ? appLocalSettings.theme : resolveThemePreference(appLocalSettings.theme || "light");
    const resolved = resolveThemePreference(preference);
    const nextIcon = resolved === "dark" ? "sun" : "moon";
    const nextLabel = resolved === "dark" ? "Switch to light mode" : "Switch to dark mode";
    for (const btn of themeToggleButtons()) {
      btn.dataset.themeState = resolved;
      setElementIcon(btn, nextIcon, {
        iconOnly: btn.classList.contains("btn-icon"),
        label: btn.classList.contains("btn-icon") ? nextLabel : "Theme"
      });
      btn.title = nextLabel;
      btn.setAttribute("aria-label", nextLabel);
    }
    syncDesktopBrandIcon();
  }
  async function applyThemePreference(next) {
    const theme = next === "light" ? "light" : "dark";
    appLocalSettings.theme = theme;
    wallpaperTheme?.applyTheme(theme);
    syncThemeToggleControl();
    writeLocalSettings(appLocalSettings, currentUser?.id);
    const result = await saveSettingsToServer();
    if (!result.ok) showToast(result.error || "Theme could not be synced", "error");
    return result;
  }
  function bindThemeToggleControl() {
    for (const btn of themeToggleButtons()) {
      if (btn.dataset.bound === "1") continue;
      btn.dataset.bound = "1";
      btn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const current = resolveThemePreference(appLocalSettings.theme || "light");
        await applyThemePreference(current === "dark" ? "light" : "dark");
      });
    }
    syncThemeToggleControl();
  }
  async function saveSettingsToServer(options = {}) {
    if (!currentUser) return { ok: false, networkError: true, error: "Not signed in" };
    const payload = {
      wallpaperDataUrl: appLocalSettings.wallpaperDataUrl || null,
      wallpaperBlur: getWallpaperSettings(appLocalSettings).wallpaperBlur,
      wallpaperTransparency: getWallpaperSettings(appLocalSettings).wallpaperTransparency,
      hideProfileDot: !!appLocalSettings.hideProfileDot,
      theme: appLocalSettings.theme || "light"
    };
    const body = JSON.stringify(payload);
    if (typeof options.onUploadProgress === "function" || typeof options.onUploadComplete === "function") {
      return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PATCH", "/api/auth/settings");
        const headers = apiHeaders();
        for (const [key, val] of Object.entries(headers)) xhr.setRequestHeader(key, val);
        xhr.upload.onprogress = (evt) => {
          if (!evt.lengthComputable || typeof options.onUploadProgress !== "function") return;
          options.onUploadProgress(evt.loaded, evt.total);
        };
        xhr.upload.onloadend = () => {
          if (typeof options.onUploadComplete === "function") options.onUploadComplete();
        };
        xhr.onerror = () => resolve({ ok: false, networkError: true, error: "Network error. Please try again." });
        xhr.onload = () => {
          let data = {};
          try {
            data = JSON.parse(xhr.responseText || "{}");
          } catch {
          }
          resolve({
            ok: xhr.status >= 200 && xhr.status < 300,
            status: xhr.status,
            error: data.error || null,
            networkError: false
          });
        };
        xhr.send(body);
      });
    }
    try {
      const res = await fetch("/api/auth/settings", {
        method: "PATCH",
        headers: apiHeaders(),
        body
      });
      const data = await res.json().catch(() => ({}));
      return {
        ok: res.ok,
        status: res.status,
        error: data.error || null,
        networkError: false
      };
    } catch {
      return { ok: false, networkError: true, error: "Network error. Please try again." };
    }
  }
  async function loadSettingsFromServer() {
    try {
      const res = await fetch("/api/auth/settings");
      if (!res.ok) return;
      const data = normalizeWallpaperSettings(await res.json());
      appLocalSettings.wallpaperDataUrl = data.wallpaperDataUrl || null;
      appLocalSettings.wallpaperBlur = data.wallpaperBlur;
      appLocalSettings.wallpaperTransparency = data.wallpaperTransparency;
      if (typeof data.hideProfileDot === "boolean") appLocalSettings.hideProfileDot = data.hideProfileDot;
      if (["system", "dark", "light"].includes(data.theme)) appLocalSettings.theme = data.theme;
    } catch {
    }
  }
  function loadMergedLocalSettings(userId = currentUser && currentUser.id) {
    const local = normalizeWallpaperSettings(readLocalSettings(userId));
    appLocalSettings.wallpaperDataUrl = local.wallpaperDataUrl || null;
    appLocalSettings.wallpaperBlur = local.wallpaperBlur;
    appLocalSettings.wallpaperTransparency = local.wallpaperTransparency;
    if (typeof local.hideProfileDot === "boolean") appLocalSettings.hideProfileDot = local.hideProfileDot;
    appLocalSettings.theme = ["system", "dark", "light"].includes(local.theme) ? local.theme : "light";
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
    el.innerHTML = "";
    for (let i = 0; i < total; i++) {
      const tick = document.createElement("span");
      tick.className = "msg-delivery-tick" + (i < read ? " read" : "");
      tick.textContent = "\u2713";
      el.appendChild(tick);
    }
  }
  function updateDeliveryForMessage(messageId, readCount) {
    const del = $("del-" + messageId);
    if (!del) return;
    const totalRecipients = Number(del.dataset.totalRecipients) || 0;
    del.dataset.readCount = String(Math.max(0, Number(readCount) || 0));
    renderDeliveryTicks(del, totalRecipients, readCount);
  }
  function refreshVisibleDeliveryTicks(groupId = currentGroupId) {
    if (!groupId) return;
    const cache = ensureGroupCacheEntry(groupId);
    for (const msg of cache.messages || []) {
      const delEl = $("del-" + msg.id);
      if (!delEl) continue;
      const total = resolveDeliveryRecipientCount(msg, groupId);
      delEl.dataset.totalRecipients = String(total);
      renderDeliveryTicks(delEl, total, Number(msg.readCount) || 0);
    }
    updateFirstUnreadButton();
  }
  function canTrackMessageRead(msg) {
    return !!(msg && currentUser && msg.groupId === currentGroupId && msg.senderId !== currentUser.id && msg.hasRead !== true);
  }
  function clearMessageVisibilityTimer(messageId) {
    const key = String(messageId || "");
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
    if (!row || !row.isConnected || !socket || document.visibilityState !== "visible") return;
    const messageId = row.dataset.msgId;
    const rowGroupId = String(row.dataset.groupId || currentGroupId || "");
    if (!rowGroupId) return;
    if (!messageId) return;
    if (!pendingReadMessageIds.has(messageId)) {
      const cache = ensureGroupCacheEntry(rowGroupId);
      const cachedMsg = (cache.messages || []).find((m) => String(m.id) === messageId);
      if (!cachedMsg || cachedMsg.readConfirmed !== true) {
        pendingReadMessageIds.add(messageId);
        row.classList.remove("unseen");
        row.dataset.hasRead = "1";
        markMessageReadLocal(rowGroupId, messageId);
        queueMarkReadEmit(rowGroupId, messageId);
        if (cachedMsg) scheduleChannelCursorAdvance(rowGroupId, cachedMsg);
      }
    }
    if (row.dataset.disappearing === "1" && row.dataset.senderId !== String(currentUser?.id) && row.dataset.disappearingHidden !== "1" && row.dataset.disappearingStarted !== "1") {
      requestDisappearingTimerStart(messageId, rowGroupId);
    }
    if (row.dataset.hasRead === "1") {
      readObserver?.unobserve(row);
    }
  }
  function syncViewportTrackingForRow(row, isIntersecting) {
    const messageId = row?.dataset?.msgId;
    if (!messageId) return;
    if (!isIntersecting || document.visibilityState !== "visible") {
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
        if (row?.dataset?.hasRead === "1" && row?.dataset?.disappearing !== "1") {
          readObserver.unobserve(row);
        }
      }
    }, {
      root: messagesArea(),
      threshold: 0
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
    const rows = area.querySelectorAll(".msg-row[data-msg-id]");
    for (const row of rows) {
      if (row.dataset.senderId === currentUser.id) continue;
      observeMessageForRead(row, {
        groupId: currentGroupId,
        senderId: row.dataset.senderId,
        hasRead: row.dataset.hasRead === "1",
        id: row.dataset.msgId,
        isDisappearing: row.dataset.disappearing === "1",
        disappearingHiddenAt: row.dataset.disappearingHidden === "1" ? (/* @__PURE__ */ new Date()).toISOString() : null
      });
    }
    for (const row of rows) {
      if (row.dataset.senderId === currentUser.id) continue;
      syncViewportTrackingForRow(row, isRowVisibleInMessagesViewport(row));
    }
  }
  function resetReadTracking() {
    pendingReadMessageIds = /* @__PURE__ */ new Set();
    pendingDisappearingStartMessageIds = /* @__PURE__ */ new Set();
    clearAllMessageVisibilityTimers();
    if (readObserver) {
      readObserver.disconnect();
      readObserver = null;
    }
  }
  var audioCtx = null;
  function playNotifSound() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(1e-3, audioCtx.currentTime + 0.18);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.18);
    } catch {
    }
  }
  function getNotificationPermissionState() {
    if (!("Notification" in window)) return "unsupported";
    return Notification.permission || "default";
  }
  function isNotificationPermissionGranted() {
    return getNotificationPermissionState() === "granted";
  }
  function getGenericUnreadNotificationBody(unreadCount) {
    const safeCount = Math.max(0, Number(unreadCount) || 0);
    if (safeCount > 0) {
      return `You have ${safeCount} unread message${safeCount === 1 ? "" : "s"} in GChat.`;
    }
    return GENERIC_NOTIFICATION_FALLBACK_BODY;
  }
  function formatNotificationBody(unreadCount, notification) {
    if (notification && notification.senderName) {
      const preview = truncate(String(notification.preview || ""), 70);
      return preview ? `${notification.senderName}: ${preview}` : `New message from ${notification.senderName}`;
    }
    return getGenericUnreadNotificationBody(unreadCount);
  }
  function getTotalUnreadCount() {
    return Object.values(unreadCounts).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0);
  }
  async function updateAppBadge(count) {
    const safeCount = Math.max(0, Number(count) || 0);
    const badgeTarget = typeof navigator !== "undefined" && navigator ? navigator : null;
    if (!badgeTarget) return;
    if (safeCount > 0 && typeof badgeTarget.setAppBadge === "function") {
      try {
        await badgeTarget.setAppBadge(safeCount);
        badgeApiState = safeCount;
      } catch {
        badgeApiState = APP_BADGE_UNSUPPORTED;
      }
      return;
    }
    if (typeof badgeTarget.clearAppBadge === "function") {
      try {
        await badgeTarget.clearAppBadge();
        badgeApiState = 0;
      } catch {
        badgeApiState = APP_BADGE_UNSUPPORTED;
      }
    }
  }
  function syncUnreadIndicators(forcedTotal = null) {
    const totalUnread = forcedTotal == null ? getTotalUnreadCount() : Math.max(0, Number(forcedTotal) || 0);
    void updateAppBadge(totalUnread);
    window.electronAPI?.setUnreadCount(totalUnread);
    return totalUnread;
  }
  function sendNativeNotification(unreadCount, groupId, notification = null) {
    if (!isNativeNotificationEnabled()) return;
    const body = formatNotificationBody(unreadCount, notification);
    if (window.electronAPI) {
      window.electronAPI.showNotification({
        title: GENERIC_NOTIFICATION_TITLE,
        body,
        groupId
      });
      return;
    }
    if (pushStatus.subscriptionActive || !isNotificationPermissionGranted()) return;
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        const n = new Notification(GENERIC_NOTIFICATION_TITLE, {
          body,
          icon: "/gchat_icon.png",
          badge: "/gchat_icon.png",
          tag: PUSH_NOTIFICATION_TAG
        });
        n.addEventListener("click", () => {
          window.focus();
        });
      } catch {
      }
    }
  }
  var NOTIFICATIONS_ENABLED_KEY = "gchat:notifications-enabled";
  function isNativeNotificationEnabled() {
    try {
      return localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) !== "0";
    } catch {
      return true;
    }
  }
  function syncNotificationsToggle() {
    const toggle = $("notifications-enabled-toggle");
    if (!toggle) return;
    toggle.checked = isNativeNotificationEnabled();
  }
  function bindNotificationsToggle() {
    const toggle = $("notifications-enabled-toggle");
    if (!toggle || toggle.dataset.bound === "1") return;
    toggle.dataset.bound = "1";
    toggle.addEventListener("change", async () => {
      try {
        localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, toggle.checked ? "1" : "0");
      } catch {
      }
      if (toggle.checked && "Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
        try {
          await Notification.requestPermission();
        } catch {
        }
      }
      if (toggle.checked) showToast("Notifications enabled", "success");
    });
  }
  function updatePageTitleNotification() {
    if (unreadNotificationCount > 0) {
      if (!titleBlinkInterval) {
        let showingNotif = true;
        titleBlinkInterval = setInterval(() => {
          if (showingNotif) {
            document.title = `(${unreadNotificationCount}) New ${unreadNotificationCount === 1 ? "message" : "messages"}`;
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
  var imageViewerData = null;
  function revokeBlobUrlsIn(root) {
    if (!root) return;
    try {
      if (root.tagName === "IMG" && (root.src || "").startsWith("blob:")) {
        URL.revokeObjectURL(root.src);
        root.removeAttribute("src");
      }
      for (const img of root.querySelectorAll('img[src^="blob:"]')) {
        URL.revokeObjectURL(img.src);
        img.removeAttribute("src");
      }
    } catch {
    }
  }
  function showImageViewer(blob, filename = "image") {
    const modal = $("image-viewer-modal");
    const img = $("image-viewer-img");
    if (imageViewerData?.imageUrl) {
      URL.revokeObjectURL(imageViewerData.imageUrl);
    }
    const imageUrl = URL.createObjectURL(blob);
    imageViewerData = { blob, filename, imageUrl };
    img.src = imageUrl;
    imageViewerZoom = 1;
    img.style.transform = "scale(1)";
    modal.hidden = false;
  }
  function hideImageViewer() {
    const modal = $("image-viewer-modal");
    const img = $("image-viewer-img");
    modal.hidden = true;
    if (imageViewerData?.imageUrl) URL.revokeObjectURL(imageViewerData.imageUrl);
    imageViewerData = null;
    img.src = "";
    img.style.transform = "scale(1)";
    imageViewerZoom = 1;
  }
  function updateImageViewerZoom(nextZoom) {
    const img = $("image-viewer-img");
    imageViewerZoom = Math.max(1, Math.min(6, nextZoom));
    img.style.transform = `scale(${imageViewerZoom})`;
    img.style.cursor = imageViewerZoom > 1 ? "zoom-out" : "zoom-in";
  }
  function isMessagesPinnedToBottom() {
    const area = messagesArea();
    if (!area) return false;
    return area.scrollHeight - area.scrollTop - area.clientHeight < 40;
  }
  function isNearBottom() {
    return isMessagesPinnedToBottom();
  }
  function pinMessagesToBottom(skipAnimation = true) {
    const area = messagesArea();
    if (!area) return;
    area.scrollTo({ top: area.scrollHeight, behavior: skipAnimation ? "auto" : "smooth" });
  }
  function createAvatarImage(src) {
    const img = document.createElement("img");
    img.src = src;
    if (src === GLOBAL_GROUP_ICON_SRC) {
      img.className = "gchat-global-icon";
    }
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "cover";
    img.style.borderRadius = "50%";
    return img;
  }
  function clearProfilePictureSelection({ keepSavedPreview = false } = {}) {
    const input = $("profile-picture-input");
    const preview = $("profile-picture-preview");
    const img = $("profile-picture-preview-img");
    const nameEl = $("profile-picture-file-name");
    if (input) input.value = "";
    if (preview) preview.hidden = !(keepSavedPreview && !!currentUser?.profilePicture);
    if (img) {
      if (keepSavedPreview && currentUser?.profilePicture) {
        img.src = currentUser.profilePicture;
        img.alt = "Current avatar preview";
      } else {
        img.removeAttribute("src");
        img.alt = "Selected image preview";
      }
    }
    if (nameEl) nameEl.textContent = "Max 2MB";
    const saveButton = $("profile-save-picture");
    if (saveButton) saveButton.disabled = true;
  }
  function updateProfileRemoveButton() {
    const removeBtn = $("profile-remove-picture");
    if (!removeBtn) return;
    const hasSaved = !!(currentUser && currentUser.profilePicture);
    removeBtn.hidden = !hasSaved;
  }
  function setProfilePictureMode(mode) {
    const slider = $("profile-picture-mode-slider");
    const colorSection = $("profile-picture-color-section");
    const uploadSection = $("profile-picture-upload-section");
    if (!slider || !colorSection || !uploadSection) return;
    const isImage = mode === "image";
    slider.value = isImage ? "1" : "0";
    slider.closest(".profile-mode-tabs")?.setAttribute("data-mode", isImage ? "image" : "color");
    colorSection.hidden = isImage;
    uploadSection.hidden = !isImage;
    const colorChip = $("profile-mode-color-label");
    const imageChip = $("profile-mode-image-label");
    colorChip?.classList.toggle("active", !isImage);
    imageChip?.classList.toggle("active", isImage);
    colorChip?.setAttribute("aria-selected", String(!isImage));
    imageChip?.setAttribute("aria-selected", String(isImage));
    if (!isImage) {
      clearProfilePictureSelection();
    } else {
      clearProfilePictureSelection({ keepSavedPreview: true });
      updateProfileRemoveButton();
    }
  }
  function syncProfilePictureModeUI() {
    setProfilePictureMode(currentUser && currentUser.profilePicture ? "image" : "color");
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
    button.classList.toggle("is-loading", !!busy);
    button.setAttribute("aria-busy", String(!!busy));
    button.textContent = busy ? busyLabel : idleLabel;
  }
  var currentUser = null;
  var currentGroupId = null;
  var currentGroupData = null;
  var groups = [];
  var members = [];
  var socket = null;
  var messageMode = "normal";
  var whisperRecipients = [];
  var replyingTo = null;
  var unreadCounts = {};
  var scrollUnreadCount = 0;
  var onlineUsers = /* @__PURE__ */ new Set();
  var allMessages = [];
  var oldestMessageId = null;
  var loadingOlder = false;
  var disconnectStatusTimer = 0;
  var tagDragState = null;
  var tagDragSuppressUntil = 0;
  var originalPageTitle = "GChat ";
  var unreadNotificationCount = 0;
  var titleBlinkInterval = null;
  var readObserver = null;
  var pendingReadMessageIds = /* @__PURE__ */ new Set();
  var pendingDisappearingStartMessageIds = /* @__PURE__ */ new Set();
  var groupDataCache = /* @__PURE__ */ new Map();
  var groupPreloadPromises = /* @__PURE__ */ new Map();
  var pendingAttachmentRows = /* @__PURE__ */ new Map();
  var hiddenDisappearingMessageIds = /* @__PURE__ */ new Set();
  var disappearingMessageTimers = /* @__PURE__ */ new Map();
  var messageVisibilityTimers = /* @__PURE__ */ new Map();
  var imageViewerZoom = 1;
  var pushStatus = {
    supported: false,
    configured: false,
    permission: "default",
    subscriptionActive: false,
    vapidPublicKey: "",
    totalUnreadCount: 0
  };
  var badgeApiState = APP_BADGE_UNSUPPORTED;
  var appLocalSettings = {
    wallpaperDataUrl: null,
    wallpaperBlur: DEFAULT_WALLPAPER_BLUR,
    wallpaperTransparency: DEFAULT_WALLPAPER_TRANSPARENCY,
    hideProfileDot: true,
    theme: "light"
  };
  var wallpaperDraft = null;
  var desktopSidebarWidth = DESKTOP_DEFAULT_SIDEBAR_WIDTH;
  var desktopRightPanelExpanded = true;
  var activeTagFilter = DEFAULT_TAG_TOPIC;
  var aiRequestInFlight = false;
  var selectedAiTone = readStoredAiTone();
  var aiUsageSummary = null;
  var userManagementSummary = null;
  var whisperPickerMode = null;
  var pendingWhisperCommandStart = null;
  var composerTokens = {
    whisper: null,
    hashtag: null
  };
  var socketDiagnostics = {
    connectionState: "connecting",
    healthStatus: "unknown",
    healthLatencyMs: null,
    healthCheckedAt: "",
    healthEdge: "",
    healthRequestId: "",
    healthServerTime: "",
    healthEnvironment: "",
    socketTransport: "unknown",
    socketId: "",
    lastConnectAt: "",
    lastDisconnectReason: "",
    lastDisconnectAt: "",
    lastConnectError: "",
    lastConnectErrorAt: "",
    reconnectAttempts: 0,
    reconnectFailed: false,
    isBrowserOnline: typeof navigator !== "undefined" ? navigator.onLine !== false : true
  };
  function renderCurrentUserAvatar(user = currentUser) {
    const avatar = $("user-avatar");
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
      const set = /* @__PURE__ */ new Set([DEFAULT_TAG_TOPIC]);
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
        (topics || []).map((topic) => normalizeHashtagTopic(topic) || DEFAULT_TAG_TOPIC).filter(Boolean)
      )];
      if (!unique.includes(DEFAULT_TAG_TOPIC)) unique.unshift(DEFAULT_TAG_TOPIC);
      localStorage.setItem(`${key}:channels`, JSON.stringify(unique));
    } catch {
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
  async function syncServerChannels(groupId) {
    if (!groupId) return;
    try {
      const res = await fetch(`/api/groups/${groupId}/channels`);
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const channels = Array.isArray(data.channels) ? data.channels : [];
      if (!channels.length) return;
      const cache = ensureGroupCacheEntry(groupId);
      const byIndex = /* @__PURE__ */ new Map();
      for (const msg of cache.messages || []) {
        if (msg.tagIndex) byIndex.set(String(msg.tagIndex), msg);
      }
      let changed = false;
      for (const entry of channels) {
        const tagIndex = String(entry.tagIndex || "");
        if (!tagIndex) continue;
        let topic = null;
        const cached = byIndex.get(tagIndex);
        if (cached && !getMessageHashtagKey(cached)) {
          try {
            await hydrateMessageChannel(cached, groupId);
          } catch {
          }
        }
        topic = cached ? getMessageHashtagKey(cached) : null;
        if (!topic && entry.sampleMessageId) {
          try {
            const msgRes = await fetch(`/api/groups/${groupId}/messages/${entry.sampleMessageId}`);
            if (msgRes.ok) {
              const msg = await msgRes.json();
              if (msg && !getMessageHashtagKey(msg)) {
                try {
                  await hydrateMessageChannel(msg, groupId);
                } catch {
                }
              }
              topic = msg ? getMessageHashtagKey(msg) : null;
            }
          } catch {
          }
        }
        if (topic && topic !== DEFAULT_TAG_TOPIC) {
          const known = getKnownChannels(groupId);
          if (!known.has(topic)) {
            rememberChannel(groupId, topic);
            changed = true;
          }
        }
      }
      if (changed && String(groupId) === String(currentGroupId)) renderTagFilters();
    } catch {
    }
  }
  function ensureGroupCacheEntry(groupId) {
    if (!groupDataCache.has(groupId)) {
      const local = readLocalGroupCache(groupId);
      const localMessages = filterMessagesVisibleToCurrentUser(local?.messages || []);
      groupDataCache.set(groupId, {
        messages: localMessages.length ? localMessages : local?.messages ? [] : null,
        messageRows: null,
        // v1.3.13: an EMPTY cached member list is treated as "not loaded" — a
        // mirror write that ran before members arrived used to persist
        // members: [], and the next boot read it as loaded, so groups (notably
        // GChat Global) rendered "0 members" forever until a cache reset.
        members: Array.isArray(local?.members) && local.members.length ? local.members : null,
        // Session-only readiness bit. Cached/durable or realtime messages do not
        // prove that the newest bounded server window has been fetched.
        serverWindowLoaded: false,
        oldestMessageId: local?.oldestMessageId || null,
        rowsDirty: !!local?.messages,
        knownChannels: new Set(readKnownChannels(groupId))
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
        profilePicture: AI_ASSISTANT_PROFILE_PICTURE
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
    if (!msg || msg.type === "whisper") return total;
    if (isAiAssistantMessage(msg)) return total;
    const memberCount = getGroupMemberCount(groupId);
    if (memberCount > 0) return Math.max(0, memberCount - 1);
    return Math.max(0, total - 1);
  }
  function createLoadMoreIndicator(text = "Loading older messages\u2026", { id = "load-more-indicator", hidden = true } = {}) {
    const indicator = document.createElement("div");
    indicator.className = "load-more-indicator";
    if (id) indicator.id = id;
    indicator.hidden = hidden;
    indicator.textContent = text;
    return indicator;
  }
  function createChannelLoadingIndicator() {
    const indicator = createLoadMoreIndicator("Loading messages\u2026", { id: "", hidden: false });
    indicator.className = "load-more-indicator channel-loading-indicator";
    indicator.setAttribute("role", "status");
    indicator.setAttribute("aria-live", "polite");
    return indicator;
  }
  async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    });
    await Promise.all(workers);
    return results;
  }
  async function buildMessageRows(messages, groupId, { prevMessage = null } = {}) {
    const rows = [];
    let prev = prevMessage;
    for (const msg of messages) {
      try {
        await hydrateMessageChannel(msg, groupId);
        const showSenderName = !shouldContinueSeries(prev, msg);
        const row = await buildMessageRow(msg, groupId, { showSenderName });
        if (row) {
          rows.push(row);
          if (msg.type !== "system") prev = msg;
        }
      } catch (err) {
        console.error("buildMessageRow failed:", msg?.id, err);
      }
    }
    return rows;
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
    if (cache.channelRows) delete cache.channelRows[normalizedTag];
    if (String(groupId) === String(currentGroupId) && channelUnreadLoadedForGroup === String(groupId)) {
      const tagIndex = await channelTagIndex(normalizedTag, groupId);
      if (tagIndex) channelUnreadCounts[String(tagIndex)] = 0;
      renderTagFilters();
    }
    writeLocalGroupCache(groupId, cache);
    await updateGroupPreviewFromMessage(groupId, cache.messages[cache.messages.length - 1] || null);
    return removedIds.length > 0;
  }
  function renderGroupFromCache(groupId, { restoreScroll = true } = {}) {
    const cache = ensureGroupCacheEntry(groupId);
    allMessages = cache.messages || [];
    oldestMessageId = cache.oldestMessageId;
    members = cache.members || [];
    for (const msg of allMessages) scheduleDisappearingTimerForMessage(msg);
    $("chat-member-count").textContent = members.length + " member" + (members.length !== 1 ? "s" : "");
    renderMembersList();
    renderWhisperPicker();
    renderTagFilters();
    void renderActiveChannelStream({ restoreScroll });
  }
  var MAX_CACHED_MESSAGES_PER_GROUP = 500;
  function trimBackgroundGroupCache(cache) {
    const messages = cache.messages;
    if (!Array.isArray(messages) || messages.length <= MAX_CACHED_MESSAGES_PER_GROUP) return;
    cache.messages = messages.slice(-MAX_CACHED_MESSAGES_PER_GROUP);
    cache.messageRows = null;
    cache.channelRows = null;
    cache.rowsDirty = true;
    cache.oldestMessageId = cache.messages.length ? cache.messages[0].id : null;
  }
  var joinedRoomIds = /* @__PURE__ */ new Set();
  function joinAllGroupRooms() {
    if (!socket) return;
    const next = new Set(joinedRoomIds);
    for (const group of groups) {
      const id = String(group.id || "");
      if (!id || next.has(id)) continue;
      next.add(id);
      socket.emit("join_room", id);
    }
    joinedRoomIds = next;
  }
  function trackJoinedRoom(groupId) {
    const id = String(groupId || "");
    if (!id) return;
    joinedRoomIds.add(id);
  }
  var MAX_SYNC_PAGES_PER_EVENT = 5;
  var SYNC_PAGE_LIMIT = 100;
  async function refreshCurrentGroupFromServer() {
    const groupId = currentGroupId;
    if (!groupId) return;
    try {
      const cache = ensureGroupCacheEntry(groupId);
      const hasCached = Array.isArray(cache.messages) && cache.messages.length > 0;
      let cursor = await readHistoryCursor(groupId);
      if (!cursor && hasCached) {
        const last = cache.messages[cache.messages.length - 1];
        cursor = { at: last.createdAt, id: last.id };
      }
      if (!cursor) {
        await loadMessages(groupId);
        return;
      }
      const byId = new Map(cache.messages.map((m) => [String(m.id), m]));
      const additions = [];
      const edits = [];
      for (let page = 0; page < MAX_SYNC_PAGES_PER_EVENT; page += 1) {
        const url = `/api/groups/${groupId}/messages?since=${encodeURIComponent(cursor.at)}&sinceId=${encodeURIComponent(cursor.id)}&limit=${SYNC_PAGE_LIMIT}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) break;
        const rawMsgs = await res.json();
        if (String(currentGroupId) !== groupId) return;
        if (!rawMsgs.length) break;
        const msgs = filterMessagesVisibleToCurrentUser(rawMsgs);
        for (const msg of msgs) {
          const known = byId.get(String(msg.id));
          if (!known) {
            byId.set(String(msg.id), msg);
            additions.push(msg);
          } else if ((known.editedAt || null) !== (msg.editedAt || null) || Number(known.revision || 0) !== Number(msg.revision || 0)) {
            byId.set(String(msg.id), msg);
            edits.push(msg);
          }
        }
        const lastFetched = rawMsgs[rawMsgs.length - 1];
        cursor = { at: lastFetched.createdAt, id: lastFetched.id };
        void writeHistoryCursor(groupId, cursor);
        if (rawMsgs.length < SYNC_PAGE_LIMIT) break;
        if (page < MAX_SYNC_PAGES_PER_EVENT - 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      }
      if (!additions.length && !edits.length) return;
      if (edits.length) {
        mergeMessagesIntoCache(groupId, edits);
        const entry = ensureGroupCacheEntry(groupId);
        if (entry.channelRows) {
          const editedIds = new Set(edits.map((m) => String(m.id)));
          for (const memo of Object.values(entry.channelRows)) {
            const kept = memo.rows.filter((row) => !editedIds.has(String(row?.dataset?.msgId)));
            if (kept.length !== memo.rows.length) {
              memo.rows = kept;
              for (const id of editedIds) memo.byId.delete(id);
              memo.firstMsgId = memo.rows.length ? memo.rows[0].dataset?.msgId || null : null;
              memo.lastMsgId = memo.rows.length ? memo.rows[memo.rows.length - 1].dataset?.msgId || null : null;
            }
          }
        }
      }
      if (!additions.length) return;
      mergeMessagesIntoCache(groupId, additions);
      if (String(currentGroupId) !== groupId) return;
      allMessages = ensureGroupCacheEntry(groupId).messages || [];
      void updateGroupPreviewFromMessage(groupId, allMessages.length ? allMessages[allMessages.length - 1] : null);
      renderTagFilters();
      const nearBottom = isNearBottom();
      const area = messagesArea();
      if (!area) return;
      const channel = getActiveTagTopic();
      const channelAdditions = [];
      await mapWithConcurrency(additions, 12, async (msg) => {
        await hydrateMessageChannel(msg, groupId);
        if (resolveMessageTagTopic(msg) === channel) channelAdditions.push(msg);
      });
      if (channelAdditions.length && !edits.length) {
        const lastVisible = getLastRenderedChannelMessage();
        const additionsAreNewer = !lastVisible || channelAdditions.every((msg) => {
          const cmp = String(msg.createdAt || "").localeCompare(String(lastVisible.createdAt || ""));
          return cmp > 0 || cmp === 0 && String(msg.id) > String(lastVisible.id);
        });
        if (additionsAreNewer) {
          const renderedIds = /* @__PURE__ */ new Set();
          for (const existing of area.querySelectorAll(".msg-row[data-msg-id]")) {
            renderedIds.add(String(existing.dataset.msgId));
          }
          const pendingAdditions = channelAdditions.filter((m) => !renderedIds.has(String(m.id)));
          if (pendingAdditions.length) {
            const rows = await buildMessageRows(pendingAdditions, groupId, { prevMessage: lastVisible });
            const fragment = document.createDocumentFragment();
            for (const row of rows) {
              if (!row) continue;
              if (row.classList?.contains("msg-row")) {
                const srcMsg = pendingAdditions.find((m) => String(m.id) === String(row.dataset.msgId));
                if (srcMsg) observeMessageForRead(row, srcMsg);
              }
              fragment.appendChild(row);
            }
            if (nearBottom) {
              area.appendChild(fragment);
              scrollToBottom(true);
            } else {
              area.appendChild(fragment);
            }
            const memo = getChannelRowMemo(ensureGroupCacheEntry(groupId), channel);
            for (const row of rows) {
              if (!row?.classList?.contains("msg-row")) continue;
              memo.rows.push(row);
              memo.byId.set(String(row.dataset.msgId), row);
            }
            memo.lastMsgId = memo.rows.length ? memo.rows[memo.rows.length - 1].dataset?.msgId || memo.lastMsgId : memo.lastMsgId;
            evictChannelRowFront(memo);
          }
          if (nearBottom && pendingAdditions.length) {
            markChannelReadAt(groupId, pendingAdditions[pendingAdditions.length - 1]);
          }
          updateFirstUnreadButton();
          renderTagFilters();
          syncChannelEmptyState();
          observeCurrentGroupRowsForRead();
          applySearchVisibility();
          return;
        }
      }
      if (edits.length || nearBottom || area.scrollTop <= 0) {
        const anchor = captureViewportAnchor(area);
        await renderActiveChannelStream({ restoreScroll: false });
        restoreViewportAnchor(area, anchor);
        observeCurrentGroupRowsForRead();
        if (nearBottom && channelAdditions.length) {
          markChannelReadAt(groupId, channelAdditions[channelAdditions.length - 1]);
        }
      }
    } catch (err) {
      console.warn("refreshCurrentGroupFromServer failed:", err);
    }
  }
  function getLastRenderedChannelMessage() {
    const area = messagesArea();
    if (!area) return null;
    const rows = area.querySelectorAll(".msg-row");
    if (!rows.length) return null;
    const lastRow = rows[rows.length - 1];
    const msgId = lastRow && lastRow.dataset.msgId;
    if (!msgId) return null;
    const cache = ensureGroupCacheEntry(currentGroupId);
    return (cache.messages || []).find((m) => String(m.id) === String(msgId)) || null;
  }
  async function ensureGroupDataPreloaded(groupId) {
    if (groupPreloadPromises.has(groupId)) return groupPreloadPromises.get(groupId);
    const cache = ensureGroupCacheEntry(groupId);
    const preload = (async () => {
      if (cache.serverWindowLoaded && cache.members) {
        return ensureGroupCacheEntry(groupId);
      }
      const pending = [];
      if (!cache.serverWindowLoaded) pending.push(loadMessages(groupId));
      if (!cache.members) pending.push(loadMembers(groupId));
      const results = await Promise.allSettled(pending);
      for (const result of results) {
        if (result.status === "rejected") console.error("Group preload failed:", groupId, result.reason);
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
  var MSG_CONTENT_UNAVAILABLE = "Unable to decrypt this message";
  var GROUP_PREVIEW_EMPTY_TEXT = "No messages yet";
  var SCROLL_LOAD_THRESHOLD = 1;
  var DISCONNECT_STATUS_GRACE_MS = 4e3;
  var MOBILE_BREAKPOINT = 768;
  var MOBILE_KEYBOARD_MIN_HEIGHT = 120;
  var VIEWPORT_SYNC_DEBOUNCE_MS = 45;
  var MOBILE_KEYBOARD_FOCUS_DELAY_MS = 80;
  var mobileViewState = "list";
  var viewportHeightSyncFrame = 0;
  var viewportHeightSyncTimer = 0;
  var largestViewportHeight = 0;
  var composerNearBottomBeforeFocus = true;
  var $ = (id) => document.getElementById(id);
  function getUniqueWhisperRecipientIds(ids = []) {
    const seen = /* @__PURE__ */ new Set();
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
    return (recipientIds || getActiveWhisperRecipientIds()).map((id) => getMemberProfile(groupId, id)).filter(Boolean);
  }
  function formatWhisperRecipientLabel(recipientIds, groupId = currentGroupId, { fallback = "Whisper", prefix = "Whisper \u2192 " } = {}) {
    const names = getWhisperRecipientMembers(recipientIds || getActiveWhisperRecipientIds(), groupId).map((member) => member.username).filter(Boolean);
    if (!names.length) return fallback;
    if (names.length <= 2) return `${prefix}${names.join(", ")}`;
    return `${prefix}${names[0]}, ${names[1]} +${names.length - 2}`;
  }
  function formatWhisperMessageLabel(msg, groupId = currentGroupId) {
    const names = getWhisperRecipientMembers(getVisibleWhisperRecipientIds(msg), groupId).map((member) => member.username).filter(Boolean);
    if (!names.length) return "Whisper";
    if (names.length <= 3) return `Whisper to ${names.join(", ")}`;
    return `Whisper to ${names[0]}, ${names[1]}, ${names[2]} +${names.length - 3}`;
  }
  function consumePendingWhisperCommand() {
    const input = $("message-input");
    if (!input || pendingWhisperCommandStart == null) return;
    input.value = input.value.slice(0, pendingWhisperCommandStart);
    input.selectionStart = input.selectionEnd = input.value.length;
    pendingWhisperCommandStart = null;
    autoResizeTextarea(input);
  }
  function showWhisperPicker(mode = "button", commandStart = null) {
    const picker = $("whisper-picker");
    if (!picker) return;
    whisperPickerMode = mode;
    pendingWhisperCommandStart = Number.isInteger(commandStart) ? commandStart : null;
    renderWhisperPicker();
    picker.hidden = false;
  }
  function hideWhisperPicker() {
    const picker = $("whisper-picker");
    if (!picker) return;
    picker.hidden = true;
    whisperPickerMode = null;
    pendingWhisperCommandStart = null;
  }
  function syncWhisperPickerStatus(recipientCount = getActiveWhisperRecipientIds().length, hasPendingCommand = pendingWhisperCommandStart != null) {
    const status = $("whisper-picker-status");
    if (!status) return;
    if (!recipientCount) {
      status.textContent = hasPendingCommand ? "Select recipients" : "No recipients selected";
      return;
    }
    status.textContent = recipientCount === 1 ? "1 recipient selected" : `${recipientCount} recipients selected`;
  }
  function setDesktopEffectsEnabled(enabled) {
    document.body.classList.toggle("electron-desktop-effects", !!enabled);
    document.body.classList.remove("desktop-pointer-glow");
    document.body.style.removeProperty("--desktop-pointer-x");
    document.body.style.removeProperty("--desktop-pointer-y");
    document.body.style.removeProperty("--desktop-panel-shift-x");
    document.body.style.removeProperty("--desktop-panel-shift-y");
  }
  function bindDesktopPointerEffects() {
  }
  function setComposerShellDisabled(disabled) {
    const shell = $("message-composer-shell");
    if (!shell) return;
    shell.classList.toggle("is-disabled", !!disabled);
  }
  function setWhisperTokenFromMember(member, rawTarget = member && member.username) {
    if (!member) return false;
    if (!whisperRecipients.some((id) => normalizeId(id) === normalizeId(member.id))) {
      whisperRecipients.push(member.id);
    }
    whisperRecipients = getUniqueWhisperRecipientIds(whisperRecipients);
    messageMode = "whisper";
    return true;
  }
  function clearWhisperToken({ restoreText = false } = {}) {
    composerTokens.whisper = null;
    whisperRecipients = [];
    messageMode = "normal";
  }
  function cancelWhisperSelection() {
    const picker = $("whisper-picker");
    if (!picker || picker.hidden) return false;
    hideWhisperPicker();
    whisperRecipients = [];
    composerTokens.whisper = null;
    messageMode = "normal";
    syncComposerTokens();
    updateWhisperBtn();
    return true;
  }
  function clearHashtagToken({ restoreText = false } = {}) {
    const token = composerTokens.hashtag;
    if (!token) return;
    composerTokens.hashtag = null;
    if (restoreText) {
      const input = $("message-input");
      if (input) {
        input.value = token.raw + input.value;
        input.selectionStart = input.selectionEnd = token.raw.length;
      }
    }
    ensureActiveTag(activeTagFilter || DEFAULT_TAG_TOPIC);
  }
  function syncComposerTokens() {
    const strip = $("message-token-strip");
    if (!strip) return;
    strip.replaceChildren();
    strip.hidden = true;
  }
  function isAiModeEnabled(groupData = currentGroupData) {
    return !!(groupData && groupData.aiEnabled);
  }
  function getAiDisabledMessage() {
    return "AI mode is disabled by the group owner";
  }
  function canUseAiInCurrentGroup({ showError = false } = {}) {
    if (!aiFeatureEnabled) {
      if (showError) showToast("AI is temporarily unavailable", "error");
      return false;
    }
    if (!currentGroupId || !currentGroupData) {
      if (showError) showToast("Select a group first", "error");
      return false;
    }
    if (!isAiModeEnabled()) {
      if (showError) showToast(getAiDisabledMessage(), "error");
      return false;
    }
    const quotaMessage = getAiQuotaBlockedMessage();
    if (quotaMessage) {
      if (showError) showToast(quotaMessage, "error");
      return false;
    }
    return true;
  }
  function updateAiControls() {
    if (messageMode === "ai" && !canUseAiInCurrentGroup()) {
      messageMode = "normal";
      syncComposerTokens();
    }
    updateMessageModeBtn();
  }
  function syncAiFeatureVisibility() {
    const show = aiFeatureEnabled;
    document.querySelectorAll("[data-ai-feature]").forEach((el) => {
      el.hidden = !show;
    });
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
      if (child.classList.contains("load-more-indicator")) continue;
      if (child.classList.contains("channel-empty-state")) continue;
      if (child.classList.contains("msg-row")) {
        const msgId = child.dataset.msgId;
        if (msgId) {
          const cached = (allMessages || []).find((m) => m.id === msgId);
          if (cached) child.dataset.hashtag = resolveMessageTagTopic(cached);
        }
        child.hidden = !rowMatchesActiveTag(child);
        continue;
      }
      if (child.classList.contains("msg-system")) {
        child.hidden = false;
      }
    }
    reconcileTranscriptStructure(area, currentGroupId);
    for (const child of rows) {
      if (child.classList.contains("msg-row")) {
        syncViewportTrackingForRow(child, isRowVisibleInMessagesViewport(child));
      }
    }
    syncChannelEmptyState();
  }
  function getAvailableGroupTags(groupId = currentGroupId) {
    const tags = /* @__PURE__ */ new Map();
    tags.set(DEFAULT_TAG_TOPIC, formatHashtagLabel(DEFAULT_TAG_TOPIC));
    if (!groupId) {
      return [...tags.entries()].map(([topic, label]) => ({ topic, label }));
    }
    const knownTopics = /* @__PURE__ */ new Set();
    for (const topic of getKnownChannels(groupId)) knownTopics.add(topic);
    const cache = ensureGroupCacheEntry(groupId);
    for (const msg of cache.messages || []) {
      const topic = resolveMessageTagTopic(msg);
      if (!topic || knownTopics.has(topic)) continue;
      knownTopics.add(topic);
      rememberChannel(groupId, topic);
    }
    const storedOrder = readTagOrder(groupId) || [];
    for (const topic of storedOrder) {
      if (topic === DEFAULT_TAG_TOPIC || !knownTopics.has(topic)) continue;
      tags.set(topic, formatHashtagLabel(topic));
      knownTopics.delete(topic);
    }
    for (const topic of knownTopics) {
      tags.set(topic, formatHashtagLabel(topic));
    }
    const active = getActiveTagTopic();
    if (active && !tags.has(active)) tags.set(active, formatHashtagLabel(active));
    return [...tags.entries()].map(([topic, label]) => ({ topic, label }));
  }
  var CHANNEL_RENDER_WINDOW = 300;
  var transcriptRebuilding = false;
  function getChannelRowMemo(cache, topic) {
    if (!cache.channelRows) cache.channelRows = {};
    let memo = cache.channelRows[topic];
    if (!memo) {
      memo = { rows: [], byId: /* @__PURE__ */ new Map(), firstMsgId: null, lastMsgId: null };
      cache.channelRows[topic] = memo;
    }
    return memo;
  }
  function attachChannelRowsToArea(area, memo) {
    area.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const row of memo.rows) {
      if (!row) continue;
      row.hidden = false;
      fragment.appendChild(row);
    }
    area.replaceChildren(fragment);
    reconcileTranscriptStructure(area, currentGroupId);
  }
  function captureViewportAnchor(area) {
    if (!area) return null;
    const row = Array.from(area.querySelectorAll(".msg-row[data-msg-id]:not([hidden])")).find((r) => {
      const rect2 = r.getBoundingClientRect();
      const aRect2 = area.getBoundingClientRect();
      return rect2.bottom > aRect2.top + 2 && rect2.top < aRect2.bottom;
    });
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    const aRect = area.getBoundingClientRect();
    return { id: String(row.dataset.msgId), offsetFromTop: rect.top - aRect.top };
  }
  function restoreViewportAnchor(area, anchor) {
    if (!area || !anchor) return;
    const row = area.querySelector(`[data-msg-id="${CSS.escape(anchor.id)}"]`);
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const aRect = area.getBoundingClientRect();
    const currentOffset = rect.top - aRect.top;
    area.scrollTop += currentOffset - anchor.offsetFromTop;
  }
  function evictChannelRowFront(memo, keep = CHANNEL_RENDER_WINDOW, max = CHANNEL_RENDER_WINDOW * 2) {
    if (memo.rows.length <= max) return;
    const area = messagesArea();
    const anchor = captureViewportAnchor(area);
    while (memo.rows.length > keep) {
      const first = memo.rows[0];
      if (!first) break;
      if (first.isConnected && area && area.scrollTop > 0) {
        const firstRect = first.getBoundingClientRect();
        const areaRect = area.getBoundingClientRect();
        if (firstRect.bottom > areaRect.top) break;
      }
      const row = memo.rows.shift();
      const msgId = row.dataset?.msgId;
      if (msgId) memo.byId.delete(String(msgId));
      readObserver?.unobserve(row);
      revokeBlobUrlsIn(row);
      row.remove();
    }
    const firstMsgRow = memo.rows.find((r) => r && r.dataset?.msgId);
    memo.firstMsgId = firstMsgRow ? firstMsgRow.dataset.msgId : null;
    if (!memo.rows.length) memo.lastMsgId = null;
    if (area && memo.rows.some((row) => row?.isConnected)) reconcileTranscriptStructure(area, currentGroupId);
    restoreViewportAnchor(area, anchor);
  }
  function evictChannelRowBack(memo, keep = CHANNEL_RENDER_WINDOW * 2) {
    if (memo.rows.length <= keep) return;
    const area = messagesArea();
    while (memo.rows.length > keep) {
      const last = memo.rows[memo.rows.length - 1];
      if (!last) break;
      if (last.isConnected && area) {
        const lastRect = last.getBoundingClientRect();
        const areaRect = area.getBoundingClientRect();
        if (lastRect.top <= areaRect.bottom) break;
      }
      const row = memo.rows.pop();
      const msgId = row.dataset?.msgId;
      if (msgId) memo.byId.delete(String(msgId));
      readObserver?.unobserve(row);
      revokeBlobUrlsIn(row);
      row.remove();
    }
    memo.lastMsgId = memo.rows.length ? memo.rows[memo.rows.length - 1].dataset?.msgId || null : null;
    const lastMsgRow = memo.rows.length ? Array.from(memo.rows).reverse().find((r) => r && r.dataset?.msgId) : null;
    memo.lastMsgId = lastMsgRow ? lastMsgRow.dataset.msgId : null;
    if (!memo.rows.length) memo.firstMsgId = null;
    if (area && memo.rows.some((row) => row?.isConnected)) reconcileTranscriptStructure(area, currentGroupId);
  }
  function restoreOrScrollToBottom() {
    const area = messagesArea();
    if (!area) return;
    const cache = ensureGroupCacheEntry(currentGroupId);
    const anchorId = cache.channelAnchors?.[getActiveTagTopic()] || null;
    if (anchorId) {
      const row = area.querySelector(`[data-msg-id="${CSS.escape(anchorId)}"]`);
      if (row) {
        area.scrollTop = row.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop;
        updateFirstUnreadButton();
        return;
      }
    }
    area.scrollTop = area.scrollHeight;
    scrollUnreadCount = 0;
    updateScrollBadge();
    $("scroll-bottom-btn").hidden = true;
  }
  async function renderActiveChannelStream({ restoreScroll = true } = {}) {
    const area = messagesArea();
    if (!area || !currentGroupId) return;
    const cache = ensureGroupCacheEntry(currentGroupId);
    oldestMessageId = cache.messages && cache.messages.length ? cache.messages[0].id : null;
    const channel = getActiveTagTopic();
    const all = cache.messages || [];
    await mapWithConcurrency(all, 12, (msg) => hydrateMessageChannel(msg, currentGroupId));
    writeLocalGroupCache(currentGroupId, cache);
    const channelMsgs = all.filter((msg) => resolveMessageTagTopic(msg) === channel);
    const windowMsgs = channelMsgs.slice(-CHANNEL_RENDER_WINDOW);
    if (!windowMsgs.length) {
      const memo2 = getChannelRowMemo(cache, channel);
      memo2.rows = [];
      memo2.byId = /* @__PURE__ */ new Map();
      memo2.firstMsgId = null;
      memo2.lastMsgId = null;
      if (!Array.isArray(cache.messages)) {
        area.replaceChildren(createChannelLoadingIndicator());
        return;
      }
      if (all.length === 0) {
        area.replaceChildren(createChannelLoadingIndicator());
      } else {
        area.replaceChildren();
      }
      syncChannelEmptyState();
      updateFirstUnreadButton();
      applySearchVisibility();
      return;
    }
    const memo = getChannelRowMemo(cache, channel);
    const lastWindowId = String(windowMsgs[windowMsgs.length - 1].id);
    if (memo.rows.length > 0 && memo.lastMsgId === lastWindowId) {
      const cacheIds = new Set(all.map((m) => String(m.id)));
      const valid = memo.rows.filter((row) => !!row?.dataset?.msgId && cacheIds.has(String(row.dataset.msgId)));
      if (valid.length !== memo.rows.length) {
        memo.rows = valid;
        memo.byId = new Map(valid.filter((row) => row?.dataset?.msgId).map((row) => [String(row.dataset.msgId), row]));
        const firstMsgRow = valid.find((row) => row?.dataset?.msgId);
        memo.firstMsgId = firstMsgRow ? firstMsgRow.dataset.msgId : null;
        const lastMsgRow = Array.from(valid).reverse().find((row) => row?.dataset?.msgId);
        memo.lastMsgId = lastMsgRow ? lastMsgRow.dataset.msgId : null;
      }
      evictChannelRowFront(memo);
      attachChannelRowsToArea(area, memo);
      if (restoreScroll) restoreOrScrollToBottom();
      observeCurrentGroupRowsForRead();
      syncChannelEmptyState();
      updateFirstUnreadButton();
      applySearchVisibility();
      return;
    }
    transcriptRebuilding = true;
    try {
      const CHUNK_SIZE = 15;
      let prev = null;
      const rows = [];
      for (let i = 0; i < windowMsgs.length; i += CHUNK_SIZE) {
        const slice = windowMsgs.slice(i, i + CHUNK_SIZE);
        const built = await buildMessageRows(slice, currentGroupId, { prevMessage: prev });
        if (!built.length) continue;
        for (const row of built) {
          if (!row) continue;
          rows.push(row);
          if (row.classList?.contains("msg-row")) {
            const msgId = row.dataset.msgId;
            const srcMsg = slice.find((m) => String(m.id) === String(msgId));
            if (srcMsg) observeMessageForRead(row, srcMsg);
          }
        }
        for (let r = built.length - 1; r >= 0; r -= 1) {
          if (built[r].classList?.contains("msg-row")) {
            const srcMsg = slice.find((m) => String(m.id) === String(built[r].dataset.msgId));
            if (srcMsg) prev = srcMsg;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      memo.rows = rows;
      memo.byId = new Map(rows.filter((row) => row?.dataset?.msgId).map((row) => [String(row.dataset.msgId), row]));
      const firstMsgRow = rows.find((row) => row?.dataset?.msgId);
      memo.firstMsgId = firstMsgRow ? firstMsgRow.dataset.msgId : null;
      const lastMsgRow = Array.from(rows).reverse().find((row) => row?.dataset?.msgId);
      memo.lastMsgId = lastMsgRow ? lastMsgRow.dataset.msgId : null;
      evictChannelRowFront(memo);
      attachChannelRowsToArea(area, memo);
      if (restoreScroll) restoreOrScrollToBottom();
      observeCurrentGroupRowsForRead();
    } finally {
      transcriptRebuilding = false;
    }
    cache.rowsDirty = true;
    syncChannelEmptyState();
    updateFirstUnreadButton();
    applySearchVisibility();
  }
  function selectTagChannel(topic, { focusComposer = true } = {}) {
    const next = ensureActiveTag(topic);
    rememberChannel(currentGroupId, next);
    clearActiveSearch({ restoreTranscript: false });
    clearHashtagToken();
    clearWhisperToken();
    whisperRecipients = [];
    messageMode = "normal";
    if (replyingTo) {
      replyingTo = null;
      const replyBar = $("reply-preview-bar");
      if (replyBar) replyBar.hidden = true;
    }
    updateWhisperBtn();
    syncComposerTokens();
    renderTagFilters();
    void markChannelReadOnOpen(currentGroupId);
    void renderActiveChannelStream().then(() => {
      updateKeyState();
      if (focusComposer) {
        const input = $("message-input");
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
    return Array.from(area.querySelectorAll(".msg-row")).filter((row) => !row.hidden).length;
  }
  function syncChannelEmptyState() {
    const area = messagesArea();
    if (!area || !currentGroupId) return;
    let empty = area.querySelector(".channel-empty-state");
    const visible = countVisibleChannelMessages();
    const cache = ensureGroupCacheEntry(currentGroupId);
    if (!Array.isArray(cache.messages)) {
      const loading2 = area.querySelector(".channel-loading-indicator");
      if (!loading2) area.appendChild(createChannelLoadingIndicator());
      if (empty) empty.remove();
      return;
    }
    const loading = area.querySelector(".channel-loading-indicator");
    if (visible > 0) {
      if (empty) empty.remove();
      if (loading) loading.remove();
      return;
    }
    if (loading) loading.remove();
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "channel-empty-state";
      area.appendChild(empty);
    }
    const channel = formatHashtagLabel(getActiveTagTopic());
    empty.innerHTML = "";
    const title = document.createElement("p");
    title.className = "channel-empty-title";
    title.textContent = `${channel} is empty`;
    const sub = document.createElement("p");
    sub.className = "channel-empty-sub";
    sub.textContent = "Messages here stay in this channel only. Start the conversation.";
    empty.append(title, sub);
  }
  function openChannelCreateModal() {
    const modal = $("channel-modal");
    const input = $("channel-name-input");
    const err = $("channel-error");
    if (!modal || !input) return;
    if (err) err.textContent = "";
    input.value = "";
    modal.hidden = false;
    setTimeout(() => input.focus(), 30);
  }
  function closeChannelCreateModal() {
    const modal = $("channel-modal");
    if (modal) modal.hidden = true;
    const err = $("channel-error");
    if (err) err.textContent = "";
  }
  function announceChannelChange(groupId, topic, action) {
    if (!socket || !groupId || !topic || topic === DEFAULT_TAG_TOPIC) return;
    try {
      socket.emit("channel_announce", {
        groupId: String(groupId),
        channel: topic,
        action: action === "remove" ? "remove" : "add"
      });
    } catch {
    }
  }
  function confirmChannelCreate() {
    const input = $("channel-name-input");
    const err = $("channel-error");
    const raw = input ? input.value : "";
    const topic = normalizeHashtagTopic(raw);
    if (!topic) {
      if (err) {
        err.textContent = `Use up to ${MAX_TAG_TOPIC_LENGTH} letters, numbers, _ or -`;
      }
      input?.focus();
      return;
    }
    if (currentGroupId && getAvailableGroupTags(currentGroupId).some((entry) => entry.topic === topic)) {
      if (err) err.textContent = `A channel named ${formatHashtagLabel(topic)} already exists`;
      input?.focus();
      return;
    }
    closeChannelCreateModal();
    rememberChannel(currentGroupId, topic);
    announceChannelChange(currentGroupId, topic, "add");
    selectTagChannel(topic);
  }
  function bindTagFilterDrag() {
    const wrap = $("chat-tag-filters");
    if (!wrap || wrap.dataset.dragBound === "1") return;
    wrap.dataset.dragBound = "1";
    wrap.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const chip = event.target.closest(".chat-tag-filter-btn");
      if (!chip || chip.dataset.tagTopic === DEFAULT_TAG_TOPIC || !currentGroupId) return;
      tagDragState = {
        chip,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        groupId: currentGroupId
      };
      try {
        chip.setPointerCapture(event.pointerId);
      } catch {
      }
    });
    wrap.addEventListener("pointermove", (event) => {
      const drag = tagDragState;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!drag.chip.isConnected) {
        tagDragState = null;
        return;
      }
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
      if (!drag.moved) {
        drag.moved = true;
        drag.chip.classList.add("dragging");
        drag.chip.style.touchAction = "none";
      }
      const wrapRect = wrap.getBoundingClientRect();
      if (event.clientX > wrapRect.right - 28) wrap.scrollLeft += 12;
      else if (event.clientX < wrapRect.left + 28) wrap.scrollLeft -= 12;
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const target = under ? under.closest(".chat-tag-filter-btn") : null;
      if (!target || target === drag.chip || target.dataset.tagTopic === DEFAULT_TAG_TOPIC) return;
      const rect = target.getBoundingClientRect();
      const before = event.clientX < rect.left + rect.width / 2;
      if (before) target.parentNode.insertBefore(drag.chip, target);
      else target.parentNode.insertBefore(drag.chip, target.nextSibling);
    });
    const finishDrag = (event) => {
      const drag = tagDragState;
      if (!drag || drag.pointerId !== event.pointerId) return;
      tagDragState = null;
      drag.chip.classList.remove("dragging");
      drag.chip.style.touchAction = "";
      try {
        drag.chip.releasePointerCapture(event.pointerId);
      } catch {
      }
      if (drag.moved) {
        tagDragSuppressUntil = Date.now() + 400;
        const topics = Array.from(wrap.querySelectorAll(".chat-tag-filter-btn")).map((btn) => btn.dataset.tagTopic).filter(Boolean);
        writeTagOrder(drag.groupId, topics);
      }
    };
    wrap.addEventListener("pointerup", finishDrag);
    wrap.addEventListener("pointercancel", finishDrag);
  }
  function renderTagFilters() {
    const wrap = $("chat-tag-filters");
    if (!wrap) return;
    if (tagDragState) {
      const pending = tagDragState;
      tagDragState = null;
      if (pending.chip) {
        pending.chip.classList.remove("dragging");
        pending.chip.style.touchAction = "";
        try {
          pending.chip.releasePointerCapture(pending.pointerId);
        } catch {
        }
      }
    }
    ensureActiveTag(activeTagFilter || DEFAULT_TAG_TOPIC);
    const tags = getAvailableGroupTags();
    const active = getActiveTagTopic();
    const countForTopic = (topic) => {
      if (channelUnreadLoadedForGroup !== String(currentGroupId || "")) return 0;
      if (topic === DEFAULT_TAG_TOPIC) return Math.max(0, Number(channelUnreadCounts[""]) || 0);
      const tagIndex = channelUnreadTagIndexByTopic.get(topic);
      if (tagIndex == null) return 0;
      return Math.max(0, Number(channelUnreadCounts[String(tagIndex)]) || 0);
    };
    wrap.replaceChildren();
    wrap.hidden = false;
    for (const tag of tags) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-tag-filter-btn";
      btn.dataset.tagTopic = tag.topic;
      if (tag.topic === active) {
        btn.classList.add("active");
        btn.setAttribute("aria-current", "true");
      }
      const unread = countForTopic(tag.topic);
      if (unread > 0) {
        btn.classList.add("has-unread");
        btn.title = `${tag.label} \u2014 ${unread} unread`;
      } else {
        btn.title = `Open ${tag.label} channel`;
      }
      btn.textContent = tag.label;
      btn.addEventListener("click", () => {
        if (Date.now() < tagDragSuppressUntil) return;
        if (tag.topic === getActiveTagTopic()) return;
        selectTagChannel(tag.topic);
      });
      btn.addEventListener("contextmenu", (event) => {
        if (tag.topic === DEFAULT_TAG_TOPIC) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        showTagContextMenu(event, tag.topic);
      });
      wrap.appendChild(btn);
    }
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "chat-tag-add-btn";
    addBtn.title = "Create channel";
    addBtn.setAttribute("aria-label", "Create channel");
    addBtn.textContent = "+ Create";
    addBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openChannelCreateModal();
    });
    wrap.appendChild(addBtn);
  }
  function handleComposerBackspace(input) {
    if (!input || input.value || input.selectionStart !== 0 || input.selectionEnd !== 0) return false;
    if (composerTokens.hashtag) {
      clearHashtagToken({ restoreText: true });
      syncComposerTokens();
      renderTagFilters();
      applyActiveTagFilterToRenderedMessages();
      autoResizeTextarea(input);
      return true;
    }
    return false;
  }
  function parseCommandToken(body, command) {
    const match = new RegExp(`^\\/${command}\\s+([^\\s]+)(?:\\s+|$)`).exec(body);
    if (!match) return null;
    return {
      value: match[1],
      rest: body.slice(match[0].length).trim()
    };
  }
  function parseComposerMessageInput(rawText) {
    let body = String(rawText || "").trim();
    let whisperRecipientIds = getActiveWhisperRecipientIds();
    let hashtag = getActiveTagTopic();
    let isAiPrompt = messageMode === "ai";
    let isDisappearing = messageMode === "disappearing";
    if (messageMode === "whisper" && !composerTokens.whisper && whisperRecipients.length === 0) {
      return { ok: false, error: "Select at least one whisper recipient" };
    }
    if (!whisperRecipientIds.length) {
      if (parseCommandToken(body, "#")) {
        return { ok: false, error: "Use + Create channel to make a new channel" };
      }
    }
    if (isAiPrompt) {
      if (!canUseAiInCurrentGroup()) {
        return { ok: false, error: getAiDisabledMessage() };
      }
      if (!body) return { ok: false, error: "AI prompt is required" };
      return {
        ok: true,
        text: body,
        whisperRecipientIds: [],
        hashtag,
        isAiPrompt: true,
        isDisappearing: false,
        disappearingDurationMs: 0
      };
    }
    if (!body) return { ok: false, error: "Message text is required" };
    return {
      ok: true,
      text: body,
      whisperRecipientIds,
      hashtag,
      isAiPrompt: false,
      isDisappearing,
      disappearingDurationMs: isDisappearing ? computeDisappearingDurationMs(body) : 0
    };
  }
  function canTrackDisappearingMessage(msg) {
    return !!(msg && currentUser && msg.groupId === currentGroupId && msg.senderId !== currentUser.id && isDisappearingMessage(msg) && !isMessageHiddenForCurrentUser(msg));
  }
  function canObserveMessageVisibility(msg) {
    return canTrackMessageRead(msg) || canTrackDisappearingMessage(msg);
  }
  function clearDisappearingTimer(messageId) {
    const key = String(messageId || "");
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
    const normalizedId = String(messageId || "");
    if (!normalizedId) return;
    clearDisappearingTimer(normalizedId);
    clearMessageVisibilityTimer(normalizedId);
    hiddenDisappearingMessageIds.add(normalizedId);
    persistHiddenDisappearingMessageIds();
    if (options.notifyServer && socket && groupId) {
      socket.emit("hide_disappearing_message", { groupId, messageId: normalizedId });
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
        cache.messageRows = cache.messageRows.filter((entry) => String(entry?.dataset?.msgId || "") !== normalizedId);
      }
      if (cache.channelRows) {
        for (const memo of Object.values(cache.channelRows)) {
          const kept = memo.rows.filter((row2) => row2?.dataset?.msgId !== normalizedId);
          if (kept.length !== memo.rows.length) {
            memo.rows = kept;
            memo.byId.delete(normalizedId);
            memo.firstMsgId = memo.rows.length ? memo.rows[0].dataset?.msgId || null : null;
            memo.lastMsgId = memo.rows.length ? memo.rows[memo.rows.length - 1].dataset?.msgId || null : null;
          }
        }
      }
      cache.rowsDirty = true;
      cache.oldestMessageId = cache.messages.length ? cache.messages[0].id : null;
      writeLocalGroupCache(cacheGroupId, cache);
      if (cacheGroupId === currentGroupId) {
        allMessages = cache.messages;
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
    const normalizedId = String(messageId || "");
    if (!normalizedId || !socket || !groupId || pendingDisappearingStartMessageIds.has(normalizedId)) return;
    pendingDisappearingStartMessageIds.add(normalizedId);
    socket.emit("start_disappearing_timer", { groupId, messageId: normalizedId });
  }
  function applyDisappearingStateUpdate({ groupId, messageId, startedAt, expiresAt, hiddenAt }) {
    const normalizedId = String(messageId || "");
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
          row.dataset.disappearingStarted = startedAt ? "1" : "0";
          if (row.dataset.hasRead === "1") readObserver?.unobserve(row);
        }
      }
      scheduleDisappearingTimerForMessage(target);
      writeLocalGroupCache(cacheGroupId, cache);
      break;
    }
  }
  var messagesArea = () => $("messages-area");
  var SVG_NS = "http://www.w3.org/2000/svg";
  var ICON_SPECS = {
    plus: [
      ["path", { d: "M12 5v14" }],
      ["path", { d: "M5 12h14" }]
    ],
    "log-in": [
      ["path", { d: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" }],
      ["polyline", { points: "10 17 15 12 10 7" }],
      ["line", { x1: "15", y1: "12", x2: "3", y2: "12" }]
    ],
    "log-out": [
      ["path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" }],
      ["polyline", { points: "16 17 21 12 16 7" }],
      ["line", { x1: "21", y1: "12", x2: "9", y2: "12" }]
    ],
    menu: [
      ["line", { x1: "4", y1: "6", x2: "20", y2: "6" }],
      ["line", { x1: "4", y1: "12", x2: "20", y2: "12" }],
      ["line", { x1: "4", y1: "18", x2: "20", y2: "18" }]
    ],
    "more-horizontal": [
      ["circle", { cx: "5", cy: "12", r: "1" }],
      ["circle", { cx: "12", cy: "12", r: "1" }],
      ["circle", { cx: "19", cy: "12", r: "1" }]
    ],
    "panel-right": [
      ["rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }],
      ["line", { x1: "15", y1: "4", x2: "15", y2: "20" }]
    ],
    info: [
      ["circle", { cx: "12", cy: "12", r: "10" }],
      ["line", { x1: "12", y1: "16", x2: "12", y2: "12" }],
      ["line", { x1: "12", y1: "8", x2: "12.01", y2: "8" }]
    ],
    activity: [
      ["polyline", { points: "22 12 18 12 15 21 9 3 6 12 2 12" }]
    ],
    "arrow-left": [
      ["line", { x1: "19", y1: "12", x2: "5", y2: "12" }],
      ["polyline", { points: "12 19 5 12 12 5" }]
    ],
    "arrow-up": [
      ["line", { x1: "12", y1: "19", x2: "12", y2: "5" }],
      ["polyline", { points: "5 12 12 5 19 12" }]
    ],
    "refresh-cw": [
      ["polyline", { points: "23 4 23 10 17 10" }],
      ["polyline", { points: "1 20 1 14 7 14" }],
      ["path", { d: "M3.51 9a9 9 0 0 1 14.13-3.36L23 10" }],
      ["path", { d: "M20.49 15a9 9 0 0 1-14.13 3.36L1 14" }]
    ],
    x: [
      ["line", { x1: "18", y1: "6", x2: "6", y2: "18" }],
      ["line", { x1: "6", y1: "6", x2: "18", y2: "18" }]
    ],
    megaphone: [
      ["path", { d: "M3 11v2" }],
      ["path", { d: "M6 10v4" }],
      ["path", { d: "M11 5l8 4v6l-8 4Z" }],
      ["path", { d: "M6 14l1.5 5" }]
    ],
    smile: [
      ["circle", { cx: "12", cy: "12", r: "10" }],
      ["path", { d: "M8 14s1.5 2 4 2 4-2 4-2" }],
      ["line", { x1: "9", y1: "9", x2: "9.01", y2: "9" }],
      ["line", { x1: "15", y1: "9", x2: "15.01", y2: "9" }]
    ],
    paperclip: [
      ["path", { d: "M21.44 11.05l-8.49 8.49a6 6 0 0 1-8.49-8.49l8.49-8.48a4 4 0 1 1 5.66 5.65l-8.49 8.49a2 2 0 1 1-2.83-2.83l7.78-7.78" }]
    ],
    send: [
      ["line", { x1: "22", y1: "2", x2: "11", y2: "13" }],
      ["polygon", { points: "22 2 15 22 11 13 2 9 22 2" }]
    ],
    "message-square": [
      ["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" }]
    ],
    pencil: [
      ["path", { d: "M12 20h9" }],
      ["path", { d: "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" }]
    ],
    copy: [
      ["rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }],
      ["path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }]
    ],
    "key-round": [
      ["circle", { cx: "7.5", cy: "15.5", r: "5.5" }],
      ["path", { d: "M21 2l-9.6 9.6" }],
      ["path", { d: "M15.5 7.5 17 9" }],
      ["path", { d: "M18 5l1.5 1.5" }]
    ],
    key: [
      ["circle", { cx: "7.5", cy: "15.5", r: "5.5" }],
      ["path", { d: "M13 15.5h8" }],
      ["path", { d: "M16 12.5v6" }]
    ],
    lock: [
      ["rect", { x: "5", y: "11", width: "14", height: "10", rx: "2" }],
      ["path", { d: "M8 11V8a4 4 0 1 1 8 0v3" }]
    ],
    unlock: [
      ["rect", { x: "5", y: "11", width: "14", height: "10", rx: "2" }],
      ["path", { d: "M8 11V8a4 4 0 0 1 7.5-2" }]
    ],
    search: [
      ["circle", { cx: "11", cy: "11", r: "7" }],
      ["line", { x1: "21", y1: "21", x2: "16.65", y2: "16.65" }]
    ],
    download: [
      ["path", { d: "M12 3v12" }],
      ["polyline", { points: "7 10 12 15 17 10" }],
      ["path", { d: "M5 21h14" }]
    ],
    "alert-triangle": [
      ["path", { d: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" }],
      ["line", { x1: "12", y1: "9", x2: "12", y2: "13" }],
      ["line", { x1: "12", y1: "17", x2: "12.01", y2: "17" }]
    ],
    "door-open": [
      ["path", { d: "M13 4h6a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-6" }],
      ["path", { d: "M3 12h13" }],
      ["polyline", { points: "8 7 3 12 8 17" }]
    ],
    "trash-2": [
      ["path", { d: "M3 6h18" }],
      ["path", { d: "M8 6V4h8v2" }],
      ["path", { d: "M19 6l-1 14H6L5 6" }],
      ["line", { x1: "10", y1: "11", x2: "10", y2: "17" }],
      ["line", { x1: "14", y1: "11", x2: "14", y2: "17" }]
    ],
    keyboard: [
      ["rect", { x: "2", y: "5", width: "20", height: "14", rx: "2" }],
      ["path", { d: "M6 9h.01M10 9h.01M14 9h.01M18 9h.01M8 13h.01M12 13h.01M16 13h.01M8 17h8" }]
    ],
    user: [
      ["path", { d: "M20 21a8 8 0 0 0-16 0" }],
      ["circle", { cx: "12", cy: "7", r: "4" }]
    ],
    users: [
      ["path", { d: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" }],
      ["circle", { cx: "9", cy: "7", r: "4" }],
      ["path", { d: "M23 21v-2a4 4 0 0 0-3-3.87" }],
      ["path", { d: "M16 3.13a4 4 0 0 1 0 7.75" }]
    ],
    "user-plus": [
      ["path", { d: "M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" }],
      ["circle", { cx: "8.5", cy: "7", r: "4" }],
      ["line", { x1: "19", y1: "8", x2: "19", y2: "14" }],
      ["line", { x1: "22", y1: "11", x2: "16", y2: "11" }]
    ],
    "shield-plus": [
      ["path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" }],
      ["path", { d: "M12 8v8" }],
      ["path", { d: "M8 12h8" }]
    ],
    "shield-minus": [
      ["path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" }],
      ["path", { d: "M8 12h8" }]
    ],
    image: [
      ["rect", { x: "3", y: "5", width: "18", height: "14", rx: "2" }],
      ["circle", { cx: "9", cy: "10", r: "1.5" }],
      ["path", { d: "m21 15-5-5L5 21" }]
    ],
    file: [
      ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }],
      ["polyline", { points: "14 2 14 8 20 8" }],
      ["line", { x1: "8", y1: "13", x2: "16", y2: "13" }],
      ["line", { x1: "8", y1: "17", x2: "14", y2: "17" }]
    ],
    sparkles: [
      ["path", { d: "M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" }],
      ["path", { d: "M18.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" }],
      ["path", { d: "M5.5 13l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" }]
    ],
    // v1.4: professional AI mark — a four-point star inside an orbit ring.
    ai: [
      ["circle", { cx: "12", cy: "12", r: "7.5" }],
      ["path", { d: "M12 8.4l1 3.1 3.1 1-3.1 1-1 3.1-1-3.1-3.1-1 3.1-1 1-3.1z" }]
    ],
    // v1.4.3: AI tone picker icons.
    briefcase: [
      ["rect", { x: "2", y: "7", width: "20", height: "14", rx: "2" }],
      ["path", { d: "M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" }]
    ],
    crown: [
      ["path", { d: "M3 7l3.5 4L12 4l5.5 7L21 7v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" }],
      ["path", { d: "M5 21h14" }]
    ],
    reply: [
      ["polyline", { points: "9 17 4 12 9 7" }],
      ["path", { d: "M20 18v-2a4 4 0 0 0-4-4H4" }]
    ],
    check: [
      ["polyline", { points: "20 6 9 17 4 12" }]
    ],
    "chevrons-down": [
      ["polyline", { points: "7 6 12 11 17 6" }],
      ["polyline", { points: "7 13 12 18 17 13" }]
    ],
    "chevrons-up": [
      ["polyline", { points: "7 13 12 8 17 13" }],
      ["polyline", { points: "7 6 12 11 17 6" }]
    ],
    sun: [
      ["circle", { cx: "12", cy: "12", r: "4" }],
      ["path", { d: "M12 2v2" }],
      ["path", { d: "M12 20v2" }],
      ["path", { d: "m4.93 4.93 1.41 1.41" }],
      ["path", { d: "m17.66 17.66 1.41 1.41" }],
      ["path", { d: "M2 12h2" }],
      ["path", { d: "M20 12h2" }],
      ["path", { d: "m6.34 17.66-1.41 1.41" }],
      ["path", { d: "m19.07 4.93-1.41 1.41" }]
    ],
    moon: [
      ["path", { d: "M21 14.5A8.5 8.5 0 1 1 9.5 3a7 7 0 0 0 11.5 11.5Z" }]
    ],
    timer: [
      ["circle", { cx: "12", cy: "13", r: "8" }],
      ["path", { d: "M12 9v4l3 2" }],
      ["path", { d: "M9 2h6" }],
      ["path", { d: "M12 2v3" }]
    ]
  };
  function createIcon(name) {
    const spec = ICON_SPECS[name];
    if (!spec) return document.createTextNode("");
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("ui-icon");
    for (const [tag, attrs] of spec) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      svg.appendChild(node);
    }
    return svg;
  }
  function setElementIcon(el, name, options = {}) {
    if (!el) return;
    const { iconOnly = false, position = "start" } = options;
    const existingLabel = el.dataset.iconLabel ?? el.textContent.trim();
    const resolvedLabel = options.label ?? existingLabel;
    if (resolvedLabel) {
      el.dataset.iconLabel = resolvedLabel;
      if (iconOnly) {
        el.title = resolvedLabel;
        el.setAttribute("aria-label", resolvedLabel);
      }
    }
    el.replaceChildren();
    if (!iconOnly && position === "start") el.appendChild(createIcon(name));
    if (!iconOnly && resolvedLabel) {
      const text = document.createElement("span");
      text.className = "icon-label";
      text.textContent = resolvedLabel;
      el.appendChild(text);
    }
    if (!iconOnly && position === "end") el.appendChild(createIcon(name));
    if (iconOnly) el.appendChild(createIcon(name));
    el.classList.add("has-icon");
    el.classList.toggle("icon-only", iconOnly);
  }
  function applyStaticIcons() {
    document.querySelectorAll("[data-icon]").forEach((el) => {
      setElementIcon(el, el.dataset.icon, {
        iconOnly: el.dataset.iconOnly === "true",
        position: el.dataset.iconPosition || "start"
      });
    });
  }
  function isMobileLayout() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }
  function normalizeMobileView(view) {
    if (view === "details" && currentGroupId) return "details";
    if (view === "chat" && currentGroupId) return "chat";
    return "list";
  }
  function syncRightPanelMobileTitle() {
    const title = $("right-panel-mobile-title");
    if (!title) return;
    title.textContent = currentGroupData?.name || "Details";
  }
  function updateChatNavigationButton() {
    const button = $("sidebar-toggle");
    if (!button) return;
    setElementIcon(button, isMobileLayout() ? "arrow-left" : "menu", {
      iconOnly: true,
      label: isMobileLayout() ? "Back to chats" : "Menu"
    });
  }
  function updateDetailsNavigationButton() {
    const button = $("right-panel-close");
    if (!button) return;
    setElementIcon(button, isMobileLayout() ? "arrow-left" : "x", {
      iconOnly: true,
      label: isMobileLayout() ? "Back to chat" : "Close details"
    });
  }
  function syncMobileNavigationState() {
    const body = document.body;
    const sidebar = $("sidebar");
    const rightPanel = $("right-panel");
    const overlay = $("sidebar-overlay");
    if (!body || !sidebar || !rightPanel || !overlay) return;
    const mobile = isMobileLayout();
    const view = normalizeMobileView(mobileViewState);
    body.classList.toggle("mobile-layout", mobile);
    body.classList.toggle("mobile-list-view", mobile && view === "list");
    body.classList.toggle("mobile-chat-view", mobile && view === "chat");
    body.classList.toggle("mobile-details-view", mobile && view === "details");
    sidebar.classList.toggle("open", mobile && view === "list");
    rightPanel.classList.toggle("open", mobile && view === "details");
    overlay.hidden = true;
    if (!mobile || view !== "list") closeMobileActionMenu();
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
    const menu = $("mobile-sidebar-actions-menu");
    const toggle = $("sidebar-mobile-actions-btn");
    if (!menu || !toggle) return;
    menu.hidden = true;
    toggle.classList.remove("active");
    toggle.setAttribute("aria-expanded", "false");
  }
  function toggleMobileActionMenu() {
    const menu = $("mobile-sidebar-actions-menu");
    const toggle = $("sidebar-mobile-actions-btn");
    if (!menu || !toggle) return;
    const nextHidden = !menu.hidden;
    menu.hidden = nextHidden;
    toggle.classList.toggle("active", !nextHidden);
    toggle.setAttribute("aria-expanded", nextHidden ? "false" : "true");
  }
  function isEditableElement(el = document.activeElement) {
    const tag = el?.tagName || "";
    return /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || el?.isContentEditable === true;
  }
  function updateKeyboardInset(activeElement = document.activeElement) {
    const vv = window.visualViewport;
    if (!isMobileLayout() || !vv) {
      document.documentElement.style.setProperty("--keyboard-inset", "0px");
      return 0;
    }
    const fallbackHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const layoutHeight = Math.max(largestViewportHeight || 0, fallbackHeight || 0, Math.round(vv.height) || 0);
    const visibleBottom = Math.round(vv.height + vv.offsetTop);
    const overlap = Math.max(0, Math.round(layoutHeight - visibleBottom));
    const keyboardOpen = isEditableElement(activeElement) && overlap >= MOBILE_KEYBOARD_MIN_HEIGHT;
    const inset = keyboardOpen ? overlap : 0;
    document.documentElement.style.setProperty("--keyboard-inset", `${inset}px`);
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
    document.documentElement.style.setProperty("--app-viewport-height", `${stableLayoutHeight}px`);
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
    window.addEventListener("resize", scheduleViewportSync);
    window.addEventListener("orientationchange", scheduleViewportSync);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", scheduleViewportSync);
      window.visualViewport.addEventListener("scroll", scheduleViewportSync);
    }
  }
  function desktopSidebarBounds() {
    const maxWidth = Math.max(DESKTOP_MIN_SIDEBAR_WIDTH, Math.floor(window.innerWidth / 3));
    return {
      min: DESKTOP_MIN_SIDEBAR_WIDTH,
      max: maxWidth
    };
  }
  function readDesktopSidebarWidth() {
    const stored = Number(localStorage.getItem(DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : DESKTOP_DEFAULT_SIDEBAR_WIDTH;
  }
  function applyDesktopSidebarState() {
    if (isMobileLayout()) {
      document.body.classList.remove("sidebar-narrow", "sidebar-compact", "sidebar-actions-icons", "sidebar-hide-cache", "sidebar-resizing");
      document.documentElement.style.setProperty("--sidebar-width", `${DESKTOP_DEFAULT_SIDEBAR_WIDTH}px`);
      return;
    }
    const { min, max } = desktopSidebarBounds();
    desktopSidebarWidth = Math.min(max, Math.max(min, Math.round(desktopSidebarWidth || DESKTOP_DEFAULT_SIDEBAR_WIDTH)));
    document.documentElement.style.setProperty("--sidebar-width", `${desktopSidebarWidth}px`);
    document.body.classList.toggle("sidebar-narrow", desktopSidebarWidth <= DESKTOP_BRAND_ONLY_SIDEBAR_WIDTH);
    document.body.classList.toggle("sidebar-compact", desktopSidebarWidth <= DESKTOP_ICON_ONLY_SIDEBAR_WIDTH);
    document.body.classList.toggle("sidebar-actions-icons", desktopSidebarWidth <= DESKTOP_ACTIONS_ICON_SIDEBAR_WIDTH);
    document.body.classList.toggle("sidebar-hide-cache", desktopSidebarWidth <= DESKTOP_HIDE_CACHE_BTN_WIDTH);
    localStorage.setItem(DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY, String(desktopSidebarWidth));
  }
  function updateRightPanelToggleButtons() {
    const expanded = isMobileLayout() ? normalizeMobileView(mobileViewState) === "details" : desktopRightPanelExpanded;
    ["right-panel-toggle", "right-panel-toggle-empty"].forEach((id) => {
      const button = $(id);
      if (!button) return;
      button.classList.toggle("active", expanded);
      button.setAttribute("aria-pressed", expanded ? "true" : "false");
    });
  }
  function applyDesktopRightPanelState() {
    const panel = $("right-panel");
    if (!panel) return;
    panel.classList.toggle("desktop-collapsed", !desktopRightPanelExpanded && !isMobileLayout());
    updateRightPanelToggleButtons();
  }
  function startSidebarResize(event) {
    if (isMobileLayout()) return;
    event.preventDefault();
    document.body.classList.add("sidebar-resizing");
    const onMove = (moveEvent) => {
      desktopSidebarWidth = moveEvent.clientX;
      applyDesktopSidebarState();
    };
    const onUp = () => {
      document.body.classList.remove("sidebar-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
  function closeRightPanel() {
    closeMobileActionMenu();
    if (isMobileLayout()) {
      setMobileView(currentGroupId ? "chat" : "list");
      return;
    }
    $("right-panel").classList.remove("open");
  }
  function closeMobilePanels() {
    closeMobileActionMenu();
    setMobileView(currentGroupId ? "chat" : "list");
  }
  function toggleSidebar() {
    if (!isMobileLayout()) return;
    closeMobileActionMenu();
    setMobileView("list");
  }
  function toggleRightPanel() {
    closeMobileActionMenu();
    if (!isMobileLayout()) {
      desktopRightPanelExpanded = !desktopRightPanelExpanded;
      localStorage.setItem(DESKTOP_RIGHT_PANEL_STORAGE_KEY, desktopRightPanelExpanded ? "1" : "0");
      applyDesktopRightPanelState();
      return;
    }
    if (!currentGroupId) return;
    setMobileView(normalizeMobileView(mobileViewState) === "details" ? "chat" : "details");
  }
  function syncResponsiveUiState() {
    setDesktopEffectsEnabled(!!window.electronAPI && !isMobileLayout());
    if (!isMobileLayout()) {
      document.body.classList.remove("mobile-layout", "mobile-list-view", "mobile-chat-view", "mobile-details-view");
      $("sidebar")?.classList.remove("open");
      $("right-panel")?.classList.remove("open");
      closeMobileActionMenu();
    } else if (!currentGroupId && mobileViewState !== "list") {
      mobileViewState = "list";
    }
    applyDesktopSidebarState();
    applyDesktopRightPanelState();
    syncMobileNavigationState();
  }
  document.addEventListener("DOMContentLoaded", async () => {
    applyStaticIcons();
    bindViewportHeightTracking();
    bindDesktopPointerEffects();
    desktopSidebarWidth = readDesktopSidebarWidth();
    desktopRightPanelExpanded = localStorage.getItem(DESKTOP_RIGHT_PANEL_STORAGE_KEY) !== "0";
    loadMergedLocalSettings();
    syncResponsiveUiState();
    await fetchCsrfToken();
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      if (res.status === 401) {
        window.location.href = buildAuthRedirectUrl();
        return;
      }
      if (!res.ok) throw new Error();
      currentUser = await res.json();
    } catch {
      window.location.href = buildAuthRedirectUrl();
      return;
    }
    migrateLegacyLocalSettings(currentUser.id);
    hiddenDisappearingMessageIds = loadHiddenDisappearingMessageIds(currentUser.id);
    $("user-username").textContent = currentUser.username;
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
      appVersionLabel = "v" + versionInfo.version;
      aiFeatureEnabled = versionInfo.aiEnabled === true;
      scheduleAutoResetClientCache(versionInfo);
    }
    $("app-version-label").textContent = appVersionLabel;
    syncAiFeatureVisibility();
    if (aiFeatureEnabled) {
      await refreshAiUsageSummary();
      void loadAndRenderAiTones();
    }
    await loadGroups();
    const lastGroupId = readStoredLastGroupId();
    if (lastGroupId && groups.some((g) => String(g.id) === String(lastGroupId))) {
      void selectGroup(lastGroupId);
    }
    void migrateLocalCachesToHistory();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type !== "push-unread-count") return;
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
    updateMessageModeBtn();
    syncResponsiveUiState();
    startHostedAppUpdatePolling();
    if (window.electronAPI) {
      window.electronAPI.onFocusGroup((groupId) => {
        const target = groups.find((g) => g.id === groupId);
        if (target) selectGroup(target.id);
      });
    }
    window.addEventListener("focus", () => {
      clearPageTitleNotification();
      observeCurrentGroupRowsForRead();
      void checkForHostedAppUpdate();
      syncStateOnFocus();
    });
    window.addEventListener("blur", () => {
      clearAllMessageVisibilityTimers();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        if (sessionExpiredPending) {
          sessionExpiredPending = false;
          window.location.href = buildAuthRedirectUrl();
          return;
        }
        observeCurrentGroupRowsForRead();
        void checkForHostedAppUpdate();
        syncStateOnFocus();
        if (!socket?.connected) {
          updateConnectionStatusUi(socketDiagnostics.isBrowserOnline ? "disconnected" : "offline", socketDiagnostics.isBrowserOnline ? "Disconnected" : "Offline");
        } else {
          updateConnectionStatusUi("connected", "Connected");
        }
        return;
      }
      clearAllMessageVisibilityTimers();
    });
    window.addEventListener("resize", () => {
      syncResponsiveUiState();
    });
    window.addEventListener("storage", (event) => {
      const userKey = getUserSettingsStorageKey(currentUser && currentUser.id);
      const hiddenKey = getHiddenDisappearingStorageKey(currentUser && currentUser.id);
      if (event.key === hiddenKey) {
        hiddenDisappearingMessageIds = loadHiddenDisappearingMessageIds(currentUser && currentUser.id);
        for (const cache of groupDataCache.values()) {
          if (cache.messages) cache.rowsDirty = true;
        }
        if (currentGroupId) {
          void renderGroupFromCache(currentGroupId);
        }
        return;
      }
      if (event.key !== ACTIVE_LOCAL_SETTINGS_KEY && event.key !== LEGACY_LOCAL_SETTINGS_KEY && event.key !== userKey) return;
      loadMergedLocalSettings();
      renderGroupList();
    });
  });
  async function loadGroups({ withBackendPreload = false } = {}) {
    try {
      const previousPreviewByGroupId = new Map(
        groups.map((group) => [group.id, { text: group._lastPreviewText, time: group._lastPreviewTime }])
      );
      const endpoint = withBackendPreload ? "/api/groups/preload?limit=50" : "/api/groups/mine";
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
        if (group.preloaded && typeof group.preloaded === "object") {
          const cache = ensureGroupCacheEntry(group.id);
          const preloadedMessages = Array.isArray(group.preloaded.messages) ? filterMessagesVisibleToCurrentUser(group.preloaded.messages) : [];
          mergeMessagesIntoCache(group.id, preloadedMessages, { persist: false });
          cache.members = Array.isArray(group.preloaded.members) && group.preloaded.members.length ? group.preloaded.members : null;
          cache.messageRows = null;
          cache.rowsDirty = true;
          cache.serverWindowLoaded = true;
          writeLocalGroupCache(group.id, cache);
          if (preloadedMessages.length) {
            void persistHistoryMessages(group.id, preloadedMessages);
            const last = preloadedMessages[preloadedMessages.length - 1];
            void writeHistoryCursor(group.id, { at: last.createdAt, id: last.id });
          }
        }
        if (!group._lastPreviewText) {
          const cache = ensureGroupCacheEntry(group.id);
          const cachedMessages = cache.messages || [];
          const lastMessage = cachedMessages.length ? cachedMessages[cachedMessages.length - 1] : null;
          if (lastMessage) {
            group._lastPreviewText = truncate(getMessagePreviewFallbackText(lastMessage), 35);
            group._lastPreviewTime = lastMessage.createdAt ? formatTime(lastMessage.createdAt) : "";
          }
        }
      }
      await loadGroupKeyVaultEntries();
      pushStatus.totalUnreadCount = getTotalUnreadCount();
      renderGroupList();
      joinAllGroupRooms();
      void refreshGroupPreviewsFromCache(groups.map((group) => group.id));
      syncUnreadIndicators();
      if (currentGroupId) {
        void fetchChannelUnreadCounts(currentGroupId);
        void markChannelReadOnOpen(currentGroupId);
      }
      if (isMobileLayout() && !currentGroupId) setMobileView("list");
      return true;
    } catch (err) {
      console.error("loadGroups error:", err);
      return false;
    }
  }
  function renderGroupList() {
    const list = $("group-list");
    const empty = $("empty-groups");
    list.innerHTML = "";
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
    if (safeCount <= 0) return "";
    return safeCount > 99 ? "99+" : integerFormatter.format(safeCount);
  }
  function buildGroupItem(g) {
    const item = document.createElement("div");
    item.className = "group-item" + (g.id === currentGroupId ? " active" : "");
    item.dataset.groupId = g.id;
    const av = document.createElement("div");
    av.className = "group-item-avatar";
    renderGroupAvatarElement(av, g);
    const info = document.createElement("div");
    info.className = "group-item-info";
    const row = document.createElement("div");
    row.className = "group-item-row";
    const name = document.createElement("div");
    name.className = "group-item-name";
    name.textContent = g.name;
    const time = document.createElement("div");
    time.className = "group-item-time";
    time.id = "preview-time-" + g.id;
    time.textContent = g._lastPreviewTime || "";
    time.hidden = !g._lastPreviewTime;
    const preview = document.createElement("div");
    preview.className = "group-item-preview";
    preview.id = "preview-" + g.id;
    const cache = ensureGroupCacheEntry(g.id);
    preview.textContent = g._lastPreviewText ?? (cache.messages === null ? "Loading\u2026" : GROUP_PREVIEW_EMPTY_TEXT);
    row.append(name, time);
    info.append(row, preview);
    const badge = document.createElement("span");
    badge.className = "group-item-badge";
    badge.id = "badge-" + g.id;
    const cnt = unreadCounts[g.id] || 0;
    badge.textContent = formatUnreadBadgeCount(cnt);
    badge.hidden = cnt === 0;
    item.append(av, info, badge);
    item.addEventListener("click", () => selectGroup(g.id));
    return item;
  }
  function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i);
    return h;
  }
  function groupAvatarColor(group) {
    if (group && group.groupColor) return group.groupColor;
    return "#" + Math.abs(hashCode(group && group.name ? group.name : "group")).toString(16).slice(0, 6).padStart(6, "5");
  }
  function renderGroupAvatarElement(target, group = {}) {
    if (!target) return;
    target.replaceChildren();
    if (isGlobalGroup(group)) {
      target.style.background = "none";
      target.appendChild(createAvatarImage(GLOBAL_GROUP_ICON_SRC));
      return;
    }
    if (group.groupIcon) {
      target.style.background = "none";
      target.appendChild(createAvatarImage(group.groupIcon));
      return;
    }
    target.style.background = groupAvatarColor(group);
    target.textContent = String(group.name || "?")[0].toUpperCase();
  }
  function updateQuickActionButtonState(button, { enabled, labelEnabled }) {
    if (!button) return;
    button.disabled = !enabled;
    button.dataset.label = enabled ? labelEnabled : "Feature disabled by owner";
    button.title = enabled ? labelEnabled : "Feature disabled by owner";
  }
  function canCurrentUserManageGroup() {
    if (!currentGroupData || !currentUser) return false;
    return String(currentGroupData.createdBy) === String(currentUser.id) || !!currentGroupData.viewerIsAdmin;
  }
  function isFurinaOwner() {
    return !!currentUser && currentUser.username === "Furina";
  }
  function canCurrentUserClearGlobalHistory() {
    return isCurrentGroupGlobal() && isFurinaOwner();
  }
  function canCurrentUserClearTag() {
    if (canCurrentUserClearGlobalHistory()) return true;
    if (!currentGroupData || !currentUser) return false;
    if (currentGroupData.createdBy === currentUser.id) return true;
    if (currentGroupData.viewerIsAdmin) return true;
    return !!(currentGroupData.allowMemberClear || currentGroupData.allowMemberClearTag);
  }
  function updateGroupColorAction(canManage) {
    const button = $("set-group-color-btn");
    if (!button) return;
    if (isCurrentGroupGlobal()) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    button.disabled = !canManage;
    button.title = canManage ? "Change group icon" : "Only the group owner or an administrator can change the group icon";
  }
  function updateGroupActionButtons(isOwner) {
    const exportBtn = $("export-btn");
    const clearBtn = $("clear-history-btn");
    const leaveBtn = $("leave-group-btn");
    const disbandBtn = $("disband-btn");
    const isGlobal = isCurrentGroupGlobal();
    if (isGlobal) {
      updateQuickActionButtonState(exportBtn, { enabled: true, labelEnabled: "Export chat as TXT" });
      updateQuickActionButtonState(clearBtn, {
        enabled: canCurrentUserClearGlobalHistory(),
        labelEnabled: "Clear chat history"
      });
      if (leaveBtn) {
        leaveBtn.hidden = true;
        leaveBtn.dataset.label = "Exit group";
      }
      if (disbandBtn) {
        disbandBtn.hidden = true;
        disbandBtn.dataset.label = "Disband group";
      }
      return;
    }
    const canMemberExport = !!(currentGroupData && currentGroupData.allowMemberExport);
    const canMemberClear = !!(currentGroupData && currentGroupData.allowMemberClear);
    const isAdministrator = !!currentGroupData?.viewerIsAdmin;
    if (isOwner || isAdministrator) {
      updateQuickActionButtonState(exportBtn, { enabled: true, labelEnabled: "Export chat as TXT" });
      updateQuickActionButtonState(clearBtn, { enabled: true, labelEnabled: "Clear chat history" });
    } else {
      updateQuickActionButtonState(exportBtn, { enabled: canMemberExport, labelEnabled: "Export chat as TXT" });
      updateQuickActionButtonState(clearBtn, { enabled: canMemberClear, labelEnabled: "Clear chat history" });
    }
    if (leaveBtn) {
      leaveBtn.hidden = !!isOwner;
      leaveBtn.dataset.label = "Exit group";
    }
    if (disbandBtn) {
      disbandBtn.hidden = !isOwner;
      disbandBtn.dataset.label = "Disband group";
    }
  }
  function syncAllowMemberClearTagToggleState() {
    const clearToggle = $("allow-member-clear-toggle");
    const tagToggle = $("allow-member-clear-tag-toggle");
    if (!clearToggle || !tagToggle) return;
    const forcedOn = !!clearToggle.checked;
    tagToggle.checked = forcedOn || !!currentGroupData?.allowMemberClearTag;
    tagToggle.disabled = forcedOn;
  }
  async function clearTagMessages(topic) {
    const normalizedTopic = normalizeHashtagTopic(topic);
    if (!normalizedTopic || !currentGroupId) return;
    if (normalizedTopic === DEFAULT_TAG_TOPIC) {
      showToast("Cannot delete #main", "error");
      return;
    }
    const cache = ensureGroupCacheEntry(currentGroupId);
    const msgs = cache.messages || [];
    for (const msg of msgs) await hydrateMessageChannel(msg, currentGroupId);
    const channelMsgs = msgs.filter((msg) => resolveMessageTagTopic(msg) === normalizedTopic);
    const hasMessages = channelMsgs.length > 0;
    if (hasMessages) {
      if (!canCurrentUserClearTag()) {
        showToast("You do not have permission to delete this channel", "error");
        return;
      }
      const key = getGroupKey(currentGroupId);
      if (!key) return showToast("Chat content is not ready yet", "error");
      const tagIndex = await blindIndex(normalizedTopic, key, currentGroupId, "tag-index");
      const res = await fetch(`/api/groups/${currentGroupId}/tags/${encodeURIComponent(tagIndex)}/messages`, {
        method: "DELETE",
        headers: apiHeaders()
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || "Failed to delete channel", "error");
        return;
      }
    }
    await removeTagMessagesFromCache(currentGroupId, normalizedTopic);
    forgetChannel(currentGroupId, normalizedTopic);
    announceChannelChange(currentGroupId, normalizedTopic, "remove");
    if (getActiveTagTopic() === normalizedTopic) {
      selectTagChannel(DEFAULT_TAG_TOPIC, { focusComposer: false });
    } else {
      renderTagFilters();
      await renderActiveChannelStream();
    }
    showToast(`Deleted ${formatHashtagLabel(normalizedTopic)}`, "success");
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
  function syncGroupPermissionControls() {
    if (!currentGroupData || !currentUser) return;
    const isGlobal = isCurrentGroupGlobal();
    const canManage = canCurrentUserManageGroup();
    const ownerActions = $("owner-actions");
    const lock = $("owner-permissions-lock");
    if (ownerActions) {
      ownerActions.hidden = isGlobal;
      ownerActions.classList.toggle("is-locked", !canManage);
    }
    if (lock) lock.hidden = canManage;
    [
      "allow-member-clear-toggle",
      "allow-member-clear-tag-toggle",
      "allow-member-export-toggle",
      "allow-member-kick-toggle",
      "allow-member-invite-toggle",
      "ai-mode-toggle"
    ].forEach((id) => {
      const input = $(id);
      if (input) input.disabled = !canManage;
    });
    if (canManage) syncAllowMemberClearTagToggleState();
  }
  function updateGroupPreview(groupId, text, time) {
    const el = $("preview-" + groupId);
    const timeLabel = time ? formatTime(time) : "";
    const previewText = truncate(text, 35) || GROUP_PREVIEW_EMPTY_TEXT;
    if (el) el.textContent = previewText;
    const timeEl = $("preview-time-" + groupId);
    if (timeEl) {
      timeEl.textContent = timeLabel;
      timeEl.hidden = !timeLabel;
    }
    const g = groups.find((x) => x.id === groupId);
    if (g) {
      g._lastPreviewTime = timeLabel;
      g._lastPreviewText = previewText;
    }
  }
  function getMessagePreviewFallbackText(msg) {
    if (!msg) return "";
    const aiMentionPrefix = msg.aiMention ? `${buildAiMentionLabel(msg.aiMeta)} ` : "";
    const typeLabel = getMessageTypePreviewLabel(msg);
    return typeLabel ? aiMentionPrefix + typeLabel : aiMentionPrefix + MSG_CONTENT_UNAVAILABLE;
  }
  async function getMessagePreviewText(msg, groupId = msg.groupId) {
    if (!msg) return "";
    const fallbackPreview = getMessagePreviewFallbackText(msg);
    const key = getGroupKey(groupId);
    if (!key || msg.type !== "text") return fallbackPreview;
    const aiMentionPrefix = msg.aiMention ? `${buildAiMentionLabel(msg.aiMeta)} ` : "";
    const plaintext = await decryptMessageText(msg, key, groupId).catch(() => null);
    return aiMentionPrefix + (plaintext ?? MSG_CONTENT_UNAVAILABLE);
  }
  async function updateGroupPreviewFromMessage(groupId, msg) {
    if (!msg) {
      updateGroupPreview(groupId, "", null);
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
    if (typeof msg.hasRead !== "boolean") {
      msg.hasRead = false;
    }
  }
  var pendingBatchReads = /* @__PURE__ */ new Map();
  var batchReadFlushScheduled = false;
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
    pendingBatchReads = /* @__PURE__ */ new Map();
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
        scheduleLocalGroupCacheWrite(groupId, cache);
        if (groupId === currentGroupId) {
          renderTagFilters();
          updateFirstUnreadButton();
        }
      }
    }
  }
  function markMessageReadLocal(groupId, messageId) {
    const normalizedGroupId = String(groupId || "");
    const normalizedMessageId = String(messageId || "");
    if (!normalizedGroupId || !normalizedMessageId) return;
    let ids = pendingBatchReads.get(normalizedGroupId);
    if (!ids) {
      ids = /* @__PURE__ */ new Set();
      pendingBatchReads.set(normalizedGroupId, ids);
    }
    ids.add(normalizedMessageId);
    scheduleBatchReadFlush();
  }
  var pendingReadEmits = /* @__PURE__ */ new Map();
  var readEmitTimer = null;
  function queueMarkReadEmit(groupId, messageId) {
    let ids = pendingReadEmits.get(groupId);
    if (!ids) {
      ids = /* @__PURE__ */ new Set();
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
    pendingReadEmits = /* @__PURE__ */ new Map();
    for (const [groupId, messageIds] of byGroup) {
      if (!socket || !socket.connected) continue;
      socket.emit("mark_messages_read", { groupId, messageIds: [...messageIds] });
    }
  }
  function markMessageReadConfirmed(messageId) {
    const stored = allMessages.find((m) => String(m.id) === String(messageId));
    if (stored) stored.readConfirmed = true;
    updateFirstUnreadButton();
  }
  function updateUnreadBadge(groupId, count) {
    const badge = $("badge-" + groupId);
    if (badge) {
      badge.textContent = formatUnreadBadgeCount(count);
      badge.hidden = (Number(count) || 0) === 0;
    }
    pushStatus.totalUnreadCount = syncUnreadIndicators();
  }
  var channelUnreadCounts = {};
  var channelUnreadLoadedForGroup = null;
  var channelUnreadTagIndexByTopic = /* @__PURE__ */ new Map();
  var channelUnreadTopicByTagIndex = /* @__PURE__ */ new Map();
  async function fetchChannelUnreadCounts(groupId) {
    if (String(groupId) !== String(currentGroupId)) return;
    try {
      const cache = ensureGroupCacheEntry(groupId);
      const topics = getAvailableGroupTags(groupId).map((tag) => tag.topic);
      const key = getGroupKey(groupId);
      const tagIndexes = [];
      const topicByTagIndex = /* @__PURE__ */ new Map();
      for (const topic of topics) {
        if (topic === DEFAULT_TAG_TOPIC) continue;
        if (!key) continue;
        let tagIndex;
        try {
          tagIndex = await blindIndex(topic, key, groupId, "tag-index");
        } catch {
          continue;
        }
        tagIndexes.push(tagIndex);
        topicByTagIndex.set(String(tagIndex), topic);
      }
      const res = await fetch(
        `/api/groups/${groupId}/unread?tags=${encodeURIComponent(tagIndexes.join(","))}`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const data = await res.json();
      if (String(currentGroupId) !== String(groupId)) return;
      channelUnreadCounts = data.counts || {};
      channelUnreadTagIndexByTopic = topicByTagIndex;
      channelUnreadTopicByTagIndex = new Map([...topicByTagIndex].map(([tagIndex, topic]) => [String(tagIndex), topic]));
      channelUnreadLoadedForGroup = String(groupId);
      renderTagFilters();
      updateFirstUnreadButton();
    } catch (err) {
      console.warn("fetchChannelUnreadCounts failed:", err);
    }
  }
  function markChannelReadAt(groupId, msg) {
    if (!msg || !socket || !currentUser) return;
    const topic = resolveMessageTagTopic(msg);
    if (String(msg.senderId) === String(currentUser.id)) return;
    const current = getLocalReadCursor(groupId, topic);
    if (current && current.at && !isCursorNewerThan(msg.createdAt, msg.id, current.at, current.id)) {
      return;
    }
    setLocalReadCursor(groupId, topic, { at: msg.createdAt, id: msg.id });
    if (String(groupId) === String(currentGroupId)) refreshUnseenRowClasses();
    void (async () => {
      const tagIndex = await channelTagIndex(topic, groupId);
      socket.emit("mark_channel_read", {
        groupId: String(groupId),
        tagIndex,
        createdAt: msg.createdAt,
        messageId: msg.id
      });
    })();
  }
  var pendingCursorAdvanceTimers = /* @__PURE__ */ new Map();
  var pendingCursorAdvances = /* @__PURE__ */ new Map();
  function scheduleChannelCursorAdvance(groupId, msg) {
    if (!msg || !groupId || !currentUser) return;
    const topic = resolveMessageTagTopic(msg);
    const key = `${String(groupId)}:${topic}`;
    const current = getLocalReadCursor(groupId, topic);
    if (current && current.at && !isCursorNewerThan(msg.createdAt, msg.id, current.at, current.id)) {
      return;
    }
    const previous = pendingCursorAdvances.get(key);
    if (previous && !isCursorNewerThan(msg.createdAt, msg.id, previous.at, previous.id)) {
      return;
    }
    pendingCursorAdvances.set(key, { at: msg.createdAt, id: msg.id });
    if (pendingCursorAdvanceTimers.has(key)) return;
    pendingCursorAdvanceTimers.set(key, setTimeout(() => {
      pendingCursorAdvanceTimers.delete(key);
      const latest = pendingCursorAdvances.get(key);
      pendingCursorAdvances.delete(key);
      if (!latest) return;
      const cache = ensureGroupCacheEntry(groupId);
      const target = (cache.messages || []).find(
        (m) => String(m.id) === String(latest.id) || String(m.createdAt) === String(latest.at)
      );
      if (target) markChannelReadAt(groupId, target);
    }, 250));
  }
  async function markChannelReadOnOpen(groupId) {
    if (!groupId || !socket || !currentUser) return;
    const cache = ensureGroupCacheEntry(groupId);
    const channel = getActiveTagTopic();
    const all = cache.messages || [];
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const msg = all[i];
      await hydrateMessageChannel(msg, groupId);
      if (resolveMessageTagTopic(msg) !== channel) continue;
      if (String(msg.senderId) !== String(currentUser.id)) {
        markChannelReadAt(groupId, msg);
        return;
      }
    }
  }
  async function selectGroup(groupId) {
    const normalizedGroupId = String(groupId || "");
    if (!normalizedGroupId) return;
    currentGroupId = normalizedGroupId;
    currentGroupData = groups.find((g) => String(g.id) === normalizedGroupId) || null;
    clearActiveSearch({ restoreTranscript: false });
    writeStoredLastGroupId(normalizedGroupId);
    replyingTo = null;
    pendingAttachmentRows.clear();
    whisperRecipients = [];
    messageMode = "normal";
    ensureActiveTag(readStoredChannel(normalizedGroupId));
    composerTokens.whisper = null;
    composerTokens.hashtag = null;
    syncComposerTokens();
    updateWhisperBtn();
    resetReadTracking();
    scrollUnreadCount = 0;
    updateScrollBadge();
    document.querySelectorAll(".group-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.groupId === normalizedGroupId);
    });
    $("chat-empty").hidden = true;
    $("chat-active").hidden = false;
    $("reply-preview-bar").hidden = true;
    $("chat-group-name").textContent = currentGroupData ? currentGroupData.name : "";
    $("edit-group-name-input").value = currentGroupData ? currentGroupData.name : "";
    $("edit-group-name-input").readOnly = isCurrentGroupGlobal();
    syncRightPanelMobileTitle();
    $("right-panel-content").hidden = false;
    $("right-panel-empty").hidden = true;
    renderTagFilters();
    const isGlobal = isCurrentGroupGlobal();
    const copyCodeBtn = $("copy-code-btn");
    if (copyCodeBtn) copyCodeBtn.hidden = isGlobal;
    const isOwner = currentGroupData && currentGroupData.createdBy === currentUser.id;
    syncGroupPermissionControls();
    updateGroupColorAction(canCurrentUserManageGroup());
    $("common-actions").hidden = false;
    if (currentGroupData) {
      $("allow-member-clear-toggle").checked = !!currentGroupData.allowMemberClear;
      $("allow-member-clear-tag-toggle").checked = !!currentGroupData.allowMemberClearTag;
      $("allow-member-export-toggle").checked = !!currentGroupData.allowMemberExport;
      $("allow-member-kick-toggle").checked = !!currentGroupData.allowMemberKick;
      $("allow-member-invite-toggle").checked = currentGroupData.allowMemberInvite !== false;
      $("ai-mode-toggle").checked = !!currentGroupData.aiEnabled;
    }
    syncAllowMemberClearTagToggleState();
    syncGroupPermissionControls();
    updateAiControls();
    updateGroupActionButtons(isOwner);
    updateKeyState();
    if (socket) {
      socket.emit("join_room", normalizedGroupId);
      trackJoinedRoom(normalizedGroupId);
    }
    const cache = ensureGroupCacheEntry(normalizedGroupId);
    const history = await readHistoryMessages(normalizedGroupId);
    if (history && history.length && (!cache.messages || history.length > cache.messages.length)) {
      const window2 = history.slice(-HISTORY_RENDER_WINDOW);
      cache.messages = mergeMessagesIntoCache(normalizedGroupId, window2, { persist: false });
      cache.rowsDirty = true;
    }
    const hadCompleteCache = !!(cache.serverWindowLoaded && cache.members);
    if (!cache.serverWindowLoaded || !cache.members) {
      if (!cache.messages) messagesArea().replaceChildren(createChannelLoadingIndicator());
      members = [];
      renderMembersList();
      renderWhisperPicker();
      $("chat-member-count").textContent = "Loading\u2026";
      await ensureGroupDataPreloaded(normalizedGroupId);
      if (currentGroupId !== normalizedGroupId) return;
    }
    renderGroupFromCache(normalizedGroupId);
    void markChannelReadOnOpen(normalizedGroupId);
    void fetchChannelUnreadCounts(normalizedGroupId);
    void syncServerChannels(normalizedGroupId);
    if (document.hasFocus()) clearPageTitleNotification();
    if (hadCompleteCache) void refreshCurrentGroupFromServer();
    closeMobileActionMenu();
    if (isMobileLayout()) setMobileView("chat");
  }
  function updateKeyState() {
    const input = $("message-input");
    const sendBtn = $("send-btn");
    const blockedStatus = $("composer-blocked-status");
    const groupName = currentGroupData?.name ? String(currentGroupData.name) : "group";
    const channel = formatHashtagLabel(getActiveTagTopic());
    const whisperRecipients2 = getActiveWhisperRecipientIds();
    if (messageMode === "whisper" && whisperRecipients2.length) {
      input.placeholder = `Whisper to ${formatWhisperRecipientLabel(whisperRecipients2, currentGroupId, { prefix: "" })} \xB7 ${channel} \xB7 ${groupName}`;
    } else if (messageMode === "disappearing") {
      input.placeholder = `Disappearing message ${channel} \xB7 ${groupName}`;
    } else if (messageMode === "ai") {
      input.placeholder = `Ask GChat AI ${channel} \xB7 ${groupName}`;
    } else {
      input.placeholder = `Message ${channel} \xB7 ${groupName}`;
    }
    sendBtn.disabled = false;
    setComposerShellDisabled(false);
    if (blockedStatus) {
      blockedStatus.textContent = "";
    }
  }
  async function loadMessages(groupId, before) {
    if (!before && groupId === currentGroupId) loadingOlder = true;
    try {
      const url = `/api/groups/${groupId}/messages` + (before ? `?before=${before}&limit=50` : "?limit=50");
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 401) {
          handleSessionExpired();
          return;
        }
        return;
      }
      const rawMsgs = await res.json();
      const msgs = filterMessagesVisibleToCurrentUser(rawMsgs);
      if (!before) {
        const cache = ensureGroupCacheEntry(groupId);
        const merged = mergeMessagesIntoCache(groupId, msgs);
        cache.messageRows = null;
        cache.rowsDirty = true;
        cache.serverWindowLoaded = true;
        cache.oldestMessageId = merged.length ? merged[0].id : null;
        writeLocalGroupCache(groupId, cache);
        await updateGroupPreviewFromMessage(groupId, merged.length ? merged[merged.length - 1] : null);
        if (msgs.length) {
          const last = msgs[msgs.length - 1];
          void writeHistoryCursor(groupId, { at: last.createdAt, id: last.id });
        }
      } else {
        const area = messagesArea();
        const viewportAnchor = captureViewportAnchor(area);
        const rows = await buildMessageRows(msgs, groupId);
        const fragment = document.createDocumentFragment();
        for (const row of rows) {
          if (!row) continue;
          if (row.classList && row.classList.contains("msg-row")) {
            const msgId = row.dataset.msgId;
            const srcMsg = msgs.find((m) => String(m.id) === String(msgId));
            if (srcMsg) observeMessageForRead(row, srcMsg);
          }
          fragment.appendChild(row);
        }
        const oldFirst = area.querySelector(".msg-row, .msg-system");
        if (oldFirst) area.insertBefore(fragment, oldFirst);
        else area.appendChild(fragment);
        const cache = ensureGroupCacheEntry(groupId);
        cache.messages = mergeMessagesIntoCache(groupId, msgs, { persist: true });
        cache.messageRows = [...rows, ...cache.messageRows || []];
        cache.oldestMessageId = rawMsgs[0].id;
        cache.rowsDirty = false;
        writeLocalGroupCache(groupId, cache);
        const memo = getChannelRowMemo(cache, getActiveTagTopic());
        memo.rows = [...rows, ...memo.rows];
        for (const row of rows) {
          const msgId = row?.dataset?.msgId;
          if (msgId) memo.byId.set(String(msgId), row);
        }
        memo.firstMsgId = rows.length ? rows[0].dataset?.msgId || memo.firstMsgId : memo.firstMsgId;
        evictChannelRowBack(memo);
        restoreViewportAnchor(area, viewportAnchor);
        applySearchVisibility();
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
    } catch (err) {
      console.error("loadMessages error:", err);
    } finally {
      if (!before && groupId === currentGroupId) loadingOlder = false;
    }
  }
  async function loadMembers(groupId) {
    try {
      const res = await fetch(`/api/groups/${groupId}/members`);
      if (!res.ok) return;
      const cache = ensureGroupCacheEntry(groupId);
      cache.members = await res.json();
      writeLocalGroupCache(groupId, cache);
    } catch (err) {
      console.error("loadMembers error:", err);
    }
  }
  function renderMembersList() {
    const list = $("members-list");
    list.innerHTML = "";
    for (const m of members) {
      const li = document.createElement("li");
      li.className = "member-item";
      li.dataset.userId = m.id;
      const av = document.createElement("div");
      av.className = "member-avatar";
      renderAvatarElement(av, m);
      if (onlineUsers.has(m.id)) {
        const dot = document.createElement("span");
        dot.className = "member-online-dot";
        av.appendChild(dot);
      }
      const name = document.createElement("span");
      name.className = "member-name";
      name.textContent = m.username;
      li.append(av, name);
      const isOwner = String(currentGroupData?.createdBy) === String(currentUser?.id);
      if (isOwner && String(m.id) !== String(currentGroupData?.createdBy)) {
        const roleBtn = document.createElement("button");
        roleBtn.className = `member-role-btn ${m.isAdministrator ? "is-demote" : "is-promote"}`;
        const roleLabel = m.isAdministrator ? "Remove administrator privilege" : "Promote to administrator";
        roleBtn.title = roleLabel;
        roleBtn.setAttribute("aria-label", roleLabel);
        setElementIcon(roleBtn, m.isAdministrator ? "shield-minus" : "shield-plus", { iconOnly: true });
        roleBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          updateMemberAdministrator(m, !m.isAdministrator);
        });
        li.appendChild(roleBtn);
      }
      if (canCurrentUserKickMember(m.id)) {
        const kickBtn = document.createElement("button");
        kickBtn.className = "member-kick-btn";
        kickBtn.title = "Kick member";
        kickBtn.setAttribute("aria-label", "Kick member");
        setElementIcon(kickBtn, "x", { iconOnly: true });
        kickBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          kickMember(m.id, m.username);
        });
        li.appendChild(kickBtn);
      }
      if (currentGroupData && m.id === currentGroupData.createdBy) {
        const tag = document.createElement("span");
        tag.className = "member-owner-tag";
        tag.textContent = "Owner";
        li.appendChild(tag);
      } else if (m.isAdministrator) {
        const tag = document.createElement("span");
        tag.className = "member-owner-tag";
        tag.textContent = "Admin";
        li.appendChild(tag);
      }
      list.appendChild(li);
    }
  }
  function renderWhisperPicker() {
    const list = $("whisper-picker-list");
    if (!list) return;
    list.innerHTML = "";
    const activeRecipientIds = getActiveWhisperRecipientIds();
    syncWhisperPickerStatus(activeRecipientIds.length, pendingWhisperCommandStart != null);
    for (const m of members) {
      if (m.id === currentUser.id) continue;
      const item = document.createElement("div");
      item.className = "whisper-picker-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = "wp-" + m.id;
      cb.value = m.id;
      cb.checked = activeRecipientIds.some((id) => normalizeId(id) === normalizeId(m.id));
      cb.addEventListener("change", () => {
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
      });
      const lbl = document.createElement("label");
      lbl.htmlFor = "wp-" + m.id;
      const avatar = document.createElement("span");
      avatar.className = "whisper-picker-avatar";
      renderAvatarElement(avatar, m);
      const name = document.createElement("span");
      name.className = "whisper-picker-name";
      name.textContent = m.username;
      lbl.append(avatar, name);
      item.append(cb, lbl);
      list.appendChild(item);
    }
  }
  async function buildMessageRow(msg, groupId = msg.groupId || currentGroupId, options = {}) {
    const isOwn = msg.senderId === currentUser.id;
    const isAiAssistant = isAiAssistantMessage(msg);
    const showSenderName = options.showSenderName !== false;
    const isReadByMe = isOwn || isMessageReadByCursor(msg, groupId, resolveMessageTagTopic(msg));
    if (msg.type === "system") {
      const div = document.createElement("div");
      div.className = "msg-system";
      div.textContent = msg.encryptedContent;
      return div;
    }
    if (!canCurrentUserAccessMessage(msg, currentUser?.id)) return null;
    if (isMessageHiddenForCurrentUser(msg)) return null;
    const messageKey = groupId ? getGroupKey(groupId) : null;
    if (!msg._decryptedText && Number(msg.encryptionVersion) === 2 && messageKey) {
      msg._decryptedText = await decryptV2Message(msg, messageKey, groupId).catch(() => null);
    }
    await hydrateMessageChannel(msg, groupId);
    const row = document.createElement("div");
    row.className = "msg-row" + (isOwn ? " own" : "") + (msg.type === "whisper" ? " whisper" : "") + (isOwn && isDisappearingMessage(msg) ? " disappearing" : "");
    row.dataset.msgId = msg.id;
    row.dataset.groupId = groupId;
    row.dataset.senderId = msg.senderId;
    row.dataset.hashtag = resolveMessageTagTopic(msg);
    row.dataset.disappearing = isDisappearingMessage(msg) ? "1" : "0";
    row.dataset.disappearingStarted = msg.disappearingStartedAt ? "1" : "0";
    row.dataset.disappearingHidden = msg.disappearingHiddenAt ? "1" : "0";
    row.dataset.hasRead = isReadByMe ? "1" : "0";
    if (!isReadByMe) row.classList.add("unseen");
    const av = document.createElement("div");
    av.className = "msg-avatar";
    const avatarIdentity = document.createElement("div");
    avatarIdentity.className = "msg-avatar-identity";
    const memberProfile = getMemberProfile(groupId, msg.senderId);
    renderAvatarElement(avatarIdentity, {
      username: memberProfile?.username || msg.senderName,
      iconColor: memberProfile?.iconColor || msg.senderColor,
      profilePicture: isAiAssistant ? getAiAssistantProfilePicture(msg.aiMeta?.model) : memberProfile?.profilePicture || msg.profilePicture || null
    });
    const continuationTime = document.createElement("time");
    continuationTime.className = "msg-continuation-time";
    continuationTime.dateTime = msg.createdAt;
    continuationTime.textContent = formatTime(msg.createdAt);
    continuationTime.title = formatFullMessageTime(msg.createdAt);
    continuationTime.hidden = showSenderName;
    avatarIdentity.hidden = !showSenderName;
    av.append(avatarIdentity, continuationTime);
    const content = document.createElement("div");
    content.className = "msg-content";
    const nameEl = document.createElement("span");
    nameEl.className = "msg-sender-name";
    nameEl.textContent = memberProfile?.username || msg.senderName || "Unknown";
    const nameColor = memberProfile?.iconColor || msg.senderColor || null;
    if (nameColor) nameEl.style.color = nameColor;
    const headerTime = document.createElement("time");
    headerTime.className = "msg-header-time";
    headerTime.dateTime = msg.createdAt;
    headerTime.textContent = formatTime(msg.createdAt);
    headerTime.title = formatFullMessageTime(msg.createdAt);
    const header = document.createElement("div");
    header.className = "msg-header";
    header.hidden = !showSenderName;
    header.append(nameEl, headerTime);
    content.appendChild(header);
    row.classList.toggle("series-continued", !showSenderName);
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.dataset.encContent = msg.encryptedContent || "";
    bubble.dataset.iv = msg.iv || "";
    const prefixRow = document.createElement("div");
    prefixRow.className = "msg-prefix-row";
    let hasPrefixContent = false;
    if (msg.type === "whisper") {
      const wl = document.createElement("span");
      wl.className = "whisper-label";
      wl.textContent = formatWhisperMessageLabel(msg, groupId);
      prefixRow.appendChild(wl);
      hasPrefixContent = true;
    }
    if (isOwn && isDisappearingMessage(msg)) {
      const disappearingLabel = document.createElement("span");
      disappearingLabel.className = "disappearing-label";
      const seconds = Math.max(1, Math.round((Number(msg.disappearingDurationMs) || MIN_DISAPPEARING_DURATION_MS) / 1e3));
      disappearingLabel.textContent = `Disappears ${seconds}s after read`;
      prefixRow.appendChild(disappearingLabel);
      hasPrefixContent = true;
    }
    const inlinePrefixChips = [];
    if (msg.aiMention && msg.type === "text") inlinePrefixChips.push(createAiMentionChip(msg.aiMeta));
    if (msg.hashtag && msg.type === "text") inlinePrefixChips.push(createHashtagChip(msg.hashtag));
    if (msg.hashtag && msg.type !== "text") {
      const hashtagChip = createHashtagChip(msg.hashtag);
      prefixRow.appendChild(hashtagChip);
      hasPrefixContent = true;
    }
    if (hasPrefixContent) bubble.appendChild(prefixRow);
    if (msg.replyToId) {
      const groupMessages = ensureGroupCacheEntry(groupId).messages || allMessages;
      const targetExists = groupMessages.some((entry) => entry.id === msg.replyToId);
      const replyPreview = msg.replyPreview;
      const rb = document.createElement("div");
      rb.className = "msg-reply-box";
      const renderReplyPreview = () => {
        const senderName = replyPreview && replyPreview.senderName ? replyPreview.senderName : "a message";
        const preview = replyPreview && replyPreview.preview ? truncate(replyPreview.preview, 60) : "";
        rb.innerHTML = '<span class="msg-reply-sender">Replying to ' + escapeHtml(senderName) + "</span> " + escapeHtml(preview);
        rb.addEventListener("click", () => scrollToMessage(msg.replyToId));
      };
      if (!targetExists) {
        if (replyPreview) {
          rb.innerHTML = '<span class="msg-reply-sender">Replying to ' + escapeHtml(replyPreview.senderName || "") + "</span> " + escapeHtml(truncate(replyPreview.preview || "", 60));
          rb.classList.add("msg-reply-unavailable");
        } else if (msg.replyTargetMissing) {
          rb.textContent = "Replying to a deleted message";
        } else {
          rb.textContent = "Replying to, original message unavailable";
        }
        if (!msg.replyTargetMissing) {
          void hydrateMissingReplyTarget(groupId, msg.replyToId).then((target) => {
            if (!target) return;
            rb.classList.remove("msg-reply-unavailable");
            if (replyPreview) renderReplyPreview();
            else {
              const fallbackPreview = target.type === "text" ? "" : "[attachment]";
              rb.innerHTML = '<span class="msg-reply-sender">Replying to ' + escapeHtml(target.senderName || "") + "</span> " + escapeHtml(fallbackPreview);
              rb.addEventListener("click", () => scrollToMessage(msg.replyToId));
            }
          });
        }
      } else if (replyPreview) {
        renderReplyPreview();
      }
      bubble.appendChild(rb);
    } else if (msg.replyTo) {
      try {
        const rData = typeof msg.replyTo === "string" ? JSON.parse(msg.replyTo) : msg.replyTo;
        const rb = document.createElement("div");
        rb.className = "msg-reply-box";
        rb.innerHTML = '<span class="msg-reply-sender">Replying to ' + escapeHtml(rData.senderName || "") + "</span> " + escapeHtml(truncate(rData.preview || "", 60));
        rb.addEventListener("click", () => scrollToMessage(rData.id));
        bubble.appendChild(rb);
      } catch {
      }
    }
    const textEl = document.createElement(isAiAssistant ? "div" : "span");
    textEl.className = "msg-text";
    await renderMsgContent(msg, textEl, bubble, groupId);
    const meta = document.createElement("span");
    meta.className = "msg-meta";
    meta.title = formatFullMessageTime(msg.createdAt);
    const deliveryEl = document.createElement("span");
    deliveryEl.className = "msg-delivery";
    deliveryEl.id = "del-" + msg.id;
    const { total, read } = normalizeDeliveryCounts(resolveDeliveryRecipientCount(msg, groupId), msg.readCount);
    deliveryEl.dataset.totalRecipients = String(total);
    deliveryEl.dataset.readCount = String(read);
    renderDeliveryTicks(deliveryEl, total, read);
    meta.appendChild(deliveryEl);
    const editedBadge = document.createElement("span");
    editedBadge.className = "msg-edited-badge";
    editedBadge.textContent = " (edited)";
    const inlineChipsForRow = isAiAssistant ? [] : inlinePrefixChips;
    if (isAiAssistant && inlinePrefixChips.length) {
      const prefix = document.createElement("div");
      prefix.className = "msg-text-prefix";
      prefix.append(...inlinePrefixChips);
      textEl.prepend(prefix);
    }
    const textFlow = document.createElement("span");
    textFlow.className = "msg-text-inline";
    textFlow.append(textEl);
    if (msg.editedAt) textFlow.append(editedBadge);
    if (msg.type === "text") {
      const bodyRow = document.createElement("div");
      bodyRow.className = "msg-body-row";
      if (inlineChipsForRow.length) {
        const inlineRow = document.createElement("div");
        inlineRow.className = "msg-inline-row";
        inlineRow.append(...inlineChipsForRow, textFlow);
        bodyRow.append(inlineRow, meta);
      } else {
        bodyRow.append(textFlow);
        bodyRow.append(meta);
      }
      bubble.appendChild(bodyRow);
    } else {
      const attachmentRow = document.createElement("div");
      attachmentRow.className = "msg-attachment-row";
      attachmentRow.append(textFlow);
      attachmentRow.append(meta);
      bubble.appendChild(attachmentRow);
    }
    const aiMetaEl = isAiAssistant ? createAiMetaElement(msg.aiMeta) : null;
    if (aiMetaEl) bubble.appendChild(aiMetaEl);
    content.appendChild(bubble);
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    const addAction = (label, icon, handler) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "msg-action-btn";
      button.title = label;
      button.setAttribute("aria-label", label);
      setElementIcon(button, icon, { iconOnly: true });
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        showContextMenu(null, msg, textEl.textContent);
        handler();
      });
      actions.appendChild(button);
    };
    if (!isDisappearingMessage(msg)) addAction("Reply", "reply", () => $("ctx-reply").click());
    if (!isDisappearingMessage(msg) && isOwn && ["text", "whisper"].includes(msg.type)) addAction("Edit", "pencil", () => $("ctx-edit").click());
    if (!isDisappearingMessage(msg) && isOwn) addAction("Delete", "trash-2", () => $("ctx-delete").click());
    if (!isDisappearingMessage(msg)) {
      const mobileActionsButton = document.createElement("button");
      mobileActionsButton.type = "button";
      mobileActionsButton.className = "msg-action-btn msg-mobile-actions-btn";
      mobileActionsButton.title = "Message actions";
      mobileActionsButton.setAttribute("aria-label", "Message actions");
      setElementIcon(mobileActionsButton, "more-horizontal", { iconOnly: true });
      mobileActionsButton.addEventListener("click", (event) => {
        event.stopPropagation();
        showContextMenu(null, msg, textEl.textContent);
      });
      actions.appendChild(mobileActionsButton);
    }
    content.appendChild(actions);
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(e, msg, textEl.textContent);
    });
    let longPressTimer;
    bubble.addEventListener("touchstart", () => {
      longPressTimer = setTimeout(() => showContextMenu(null, msg, textEl.textContent), 600);
    });
    bubble.addEventListener("touchend", () => clearTimeout(longPressTimer));
    bubble.addEventListener("touchcancel", () => clearTimeout(longPressTimer));
    bubble.addEventListener("touchmove", () => clearTimeout(longPressTimer), { passive: true });
    row.append(av, content);
    scheduleDisappearingTimerForMessage(msg);
    return row;
  }
  async function renderMsgContent(msg, textEl, bubble, groupId = currentGroupId) {
    const key = groupId ? getGroupKey(groupId) : null;
    if (msg.type === "image") {
      if (!key) {
        const locked = document.createElement("div");
        locked.className = "msg-image-locked";
        locked.appendChild(createIcon("lock"));
        textEl.appendChild(locked);
      } else {
        const buf = await decryptAttachmentBytes(msg, key, groupId);
        if (buf) {
          const mimeType = detectImageMime(buf) || "image/jpeg";
          const blob = new Blob([buf], { type: mimeType });
          const url = URL.createObjectURL(blob);
          const img = document.createElement("img");
          img.className = "msg-image";
          img.src = url;
          img.alt = "image";
          img.style.cursor = "pointer";
          await new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
          });
          img.addEventListener("click", (e) => {
            e.stopPropagation();
            showImageViewer(blob, msg.filename || "image");
          });
          textEl.appendChild(img);
        } else {
          const locked = document.createElement("div");
          locked.className = "msg-image-locked";
          locked.appendChild(createIcon("lock"));
          textEl.appendChild(locked);
        }
      }
      return;
    }
    if (msg.type === "file") {
      if (!key) {
        textEl.textContent = "File unavailable: " + (msg.filename || "file");
      } else {
        const buf = await decryptAttachmentBytes(msg, key, groupId);
        if (buf) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "msg-file-btn";
          const fileIcon = document.createElement("span");
          fileIcon.className = "msg-file-icon";
          fileIcon.appendChild(createIcon("file"));
          btn.appendChild(fileIcon);
          const info = document.createElement("span");
          info.className = "msg-file-info";
          const fileName = document.createElement("strong");
          fileName.textContent = msg.filename || "file";
          const fileMeta = document.createElement("small");
          const extension = (msg.filename || "").split(".").pop()?.toUpperCase() || "FILE";
          fileMeta.textContent = `${extension} \xB7 ${formatBytes(buf.byteLength)}`;
          info.append(fileName, fileMeta);
          btn.appendChild(info);
          const downloadLabel = document.createElement("span");
          downloadLabel.className = "msg-file-download-label";
          downloadLabel.textContent = "Download";
          btn.appendChild(downloadLabel);
          btn.addEventListener("click", (e) => {
            const blob = new Blob([buf]);
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = msg.filename || "download";
            a.click();
            URL.revokeObjectURL(url);
          });
          textEl.appendChild(btn);
        } else {
          textEl.textContent = "File unavailable: " + (msg.filename || "file");
        }
      }
      return;
    }
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
  function appendOptimisticOwnMessage(msg) {
    if (!msg || !currentUser || String(msg.groupId) !== String(currentGroupId)) return;
    if (resolveMessageTagTopic(msg) !== getActiveTagTopic()) return;
    mergeMessagesIntoCache(msg.groupId, [msg], { persist: false });
    void appendMessageBubble(msg, true, msg.groupId);
  }
  function reconcileOptimisticEcho(serverMsg) {
    if (!serverMsg) return;
    const cache = ensureGroupCacheEntry(serverMsg.groupId);
    const index = (cache.messages || []).findIndex((m) => String(m.id) === String(serverMsg.id));
    if (index < 0) return;
    const local = cache.messages[index];
    if (!local || !local._optimistic) return;
    if (Number(local.revision || 1) > Number(serverMsg.revision || 1)) return;
    const plaintext = local._decryptedText;
    const hashtag = local.hashtag || null;
    Object.assign(local, serverMsg);
    if (plaintext != null) local._decryptedText = plaintext;
    local.hashtag = hashtag || local.hashtag || null;
    delete local._optimistic;
    const row = document.querySelector(`.msg-row[data-msg-id="${CSS.escape(String(serverMsg.id))}"]`);
    if (row) {
      const timeEl = row.querySelector("time");
      if (timeEl) {
        timeEl.dateTime = serverMsg.createdAt || "";
        timeEl.textContent = formatTime(serverMsg.createdAt);
      }
      const delEl = document.getElementById("del-" + serverMsg.id);
      if (delEl) {
        delEl.dataset.totalRecipients = String(Math.max(0, Number(serverMsg.totalRecipients) || 0));
        delEl.dataset.readCount = String(Math.max(0, Number(serverMsg.readCount) || 0));
        renderDeliveryTicks(delEl, Number(delEl.dataset.totalRecipients), Number(delEl.dataset.readCount));
      }
    }
  }
  async function appendMessageBubble(msg, scroll, groupId = currentGroupId) {
    await hydrateMessageChannel(msg, groupId);
    const channel = resolveMessageTagTopic(msg);
    const cache = ensureGroupCacheEntry(groupId);
    if (groupId === currentGroupId) {
      allMessages = Array.isArray(cache.messages) ? cache.messages : [];
    }
    let previousInChannel = null;
    for (let i = allMessages.length - 1; i >= 0; i -= 1) {
      if (String(allMessages[i].id) === String(msg.id)) continue;
      if (resolveMessageTagTopic(allMessages[i]) === channel) {
        previousInChannel = allMessages[i];
        break;
      }
    }
    const showSenderName = !shouldContinueSeries(previousInChannel, msg);
    const row = await buildMessageRow(msg, groupId, { showSenderName });
    if (!row) return;
    const area = messagesArea();
    const wasNearBottom = area ? area.scrollHeight - area.scrollTop - area.clientHeight < 150 : false;
    allMessages = mergeMessagesIntoCache(groupId, [msg]);
    cache.rowsDirty = true;
    cache.messageRows = null;
    rememberChannel(groupId, channel);
    renderTagFilters();
    if (groupId !== currentGroupId || !messageMatchesActiveTag(msg)) return row;
    if (!area) return row;
    area.querySelector(".channel-empty-state")?.remove();
    row.hidden = false;
    area.appendChild(row);
    reconcileTranscriptStructure(area, groupId);
    observeMessageForRead(row, msg);
    const memo = getChannelRowMemo(cache, channel);
    memo.rows.push(row);
    memo.byId.set(String(msg.id), row);
    memo.lastMsgId = String(msg.id);
    evictChannelRowFront(memo);
    if (scroll !== false) {
      if (msg.senderId === currentUser.id) {
        scrollToBottom(true);
        applySearchVisibility();
        return row;
      }
      if (wasNearBottom) {
        scrollToBottom();
      } else {
        scrollUnreadCount++;
        updateScrollBadge();
        if (msg.senderId !== currentUser.id) playNotifSound();
      }
    }
    applySearchVisibility();
    return row;
  }
  function resetComposerAfterSend() {
    clearTimeout(window._myTypingTimer);
    socket.emit("stop_typing", { groupId: currentGroupId });
    replyingTo = null;
    $("reply-preview-bar").hidden = true;
    const inp = $("message-input");
    inp.value = "";
    composerTokens.hashtag = null;
    composerTokens.whisper = null;
    whisperRecipients = [];
    messageMode = "normal";
    hideWhisperPicker();
    ensureActiveTag(activeTagFilter || DEFAULT_TAG_TOPIC);
    syncComposerTokens();
    updateWhisperBtn();
    renderTagFilters();
    autoResizeTextarea(inp);
    scrollToBottom(true);
  }
  function updateScrollBadge() {
    const btn = $("scroll-bottom-btn");
    const badge = $("scroll-unread-badge");
    btn.hidden = false;
    badge.textContent = scrollUnreadCount;
    badge.hidden = scrollUnreadCount === 0;
  }
  function scrollToBottom(skipAnimation) {
    const area = messagesArea();
    if (!area) return;
    area.scrollTo({ top: area.scrollHeight, behavior: skipAnimation ? "auto" : "smooth" });
    scrollUnreadCount = 0;
    updateScrollBadge();
    $("scroll-bottom-btn").hidden = true;
  }
  function scrollToMessage(msgId) {
    const row = document.querySelector('[data-msg-id="' + msgId + '"]');
    if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function getFirstUnreadMessageInChannel() {
    if (!currentGroupId || !currentUser) return null;
    const cache = ensureGroupCacheEntry(currentGroupId);
    const channel = getActiveTagTopic();
    for (const msg of cache.messages || []) {
      if (resolveMessageTagTopic(msg) !== channel) continue;
      if (isMessageReadByCursor(msg, currentGroupId, channel)) continue;
      if (isMessageHiddenForCurrentUser(msg)) continue;
      return msg;
    }
    return null;
  }
  function refreshUnseenRowClasses() {
    const area = messagesArea();
    if (!area || !currentGroupId) return;
    const cache = ensureGroupCacheEntry(currentGroupId);
    const all = cache.messages || [];
    const rows = area.querySelectorAll(".msg-row[data-msg-id]");
    for (const row of rows) {
      const msg = all.find((m) => String(m.id) === String(row.dataset.msgId));
      if (!msg) continue;
      const read = isMessageReadByCursor(msg, currentGroupId, resolveMessageTagTopic(msg));
      row.classList.toggle("unseen", !read);
    }
  }
  function updateFirstUnreadButton() {
    const btn = $("scroll-first-unread-btn");
    if (!btn) return;
    const first = getFirstUnreadMessageInChannel();
    let show = false;
    if (first) {
      btn.dataset.msgId = first.id;
      const area = messagesArea();
      const row = document.querySelector('[data-msg-id="' + first.id + '"]');
      if (row && area) {
        const areaRect = area.getBoundingClientRect();
        show = row.getBoundingClientRect().top < areaRect.top - 8;
      }
    } else {
      delete btn.dataset.msgId;
    }
    btn.hidden = !show;
  }
  function jumpToFirstUnread() {
    const btn = $("scroll-first-unread-btn");
    const msgId = btn && btn.dataset.msgId;
    if (!msgId) return;
    const row = document.querySelector('[data-msg-id="' + msgId + '"]');
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const area = messagesArea();
    if (area) area.scrollTo({ top: 0, behavior: "smooth" });
  }
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
  var ctxMsg = null;
  var ctxText = "";
  var ctxTagTopic = null;
  function positionContextMenu(menu, e) {
    menu.hidden = false;
    const width = menu.offsetWidth || 180;
    const height = menu.offsetHeight || 120;
    const left = Math.max(8, Math.min(e.clientX, window.innerWidth - width - 8));
    const fitsBelow = e.clientY + height + 8 <= window.innerHeight;
    const top = fitsBelow ? e.clientY : Math.max(8, e.clientY - height - 8);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }
  function showContextMenu(e, msg, text) {
    ctxMsg = msg;
    ctxText = text;
    hideTagContextMenu();
    hideAvatarContextMenu();
    const menu = $("ctx-menu");
    const isAuthor = msg.senderId === currentUser?.id;
    const isAttachment = msg.type === "image" || msg.type === "file";
    const isDisappearing = isDisappearingMessage(msg);
    const isGlobalMessageGroup = isGlobalGroupId(msg.groupId || currentGroupId);
    $("ctx-reply").hidden = isDisappearing;
    $("ctx-edit").hidden = isDisappearing || !isAuthor || !["text", "whisper"].includes(msg.type);
    $("ctx-delete").hidden = isDisappearing || !isAuthor && !isGlobalMessageGroup;
    $("ctx-download").hidden = true;
    $("ctx-copy").hidden = isAttachment || isDisappearing;
    setElementIcon($("ctx-copy"), "copy", { label: "Copy" });
    menu.hidden = false;
    if (e) {
      positionContextMenu(menu, e);
    } else {
      menu.style.left = "50%";
      menu.style.top = "50%";
    }
  }
  function hideContextMenu() {
    $("ctx-menu").hidden = true;
    ctxMsg = null;
  }
  function showTagContextMenu(e, topic) {
    ctxTagTopic = normalizeHashtagTopic(topic);
    if (!ctxTagTopic) return;
    hideContextMenu();
    hideAvatarContextMenu();
    const menu = $("tag-ctx-menu");
    const deleteBtn = $("tag-ctx-delete");
    deleteBtn.textContent = `Delete ${formatHashtagLabel(ctxTagTopic)}`;
    setElementIcon(deleteBtn, "trash-2", { label: `Delete ${formatHashtagLabel(ctxTagTopic)}` });
    menu.hidden = false;
    if (e) {
      positionContextMenu(menu, e);
    } else {
      menu.style.left = "50%";
      menu.style.top = "50%";
    }
  }
  function hideTagContextMenu() {
    $("tag-ctx-menu").hidden = true;
    ctxTagTopic = null;
  }
  var avatarCtxUserId = null;
  var avatarCtxUsername = "";
  function showAvatarContextMenu(e, userId, username) {
    avatarCtxUserId = userId;
    avatarCtxUsername = username || "this user";
    hideContextMenu();
    hideTagContextMenu();
    const menu = $("avatar-ctx-menu");
    const inviteBtn = $("avatar-ctx-invite");
    setElementIcon(inviteBtn, "user-plus", { label: `Invite ${avatarCtxUsername} to chat` });
    menu.hidden = false;
    if (e) {
      positionContextMenu(menu, e);
    } else {
      menu.style.left = "50%";
      menu.style.top = "50%";
    }
  }
  function hideAvatarContextMenu() {
    const menu = $("avatar-ctx-menu");
    if (menu) menu.hidden = true;
    avatarCtxUserId = null;
  }
  async function openInviteModal() {
    const targetUserId = avatarCtxUserId;
    const targetName = avatarCtxUsername;
    hideAvatarContextMenu();
    if (!targetUserId || !currentUser) return;
    const modal = $("invite-modal");
    const list = $("invite-list");
    const desc = $("invite-desc");
    const errorEl = $("invite-error");
    errorEl.textContent = "";
    $("invite-target-name").textContent = targetName;
    modal.hidden = false;
    list.innerHTML = '<div class="invite-list-empty">Loading chats\u2026</div>';
    try {
      const res = await fetch(`/api/groups/invite-candidates/${encodeURIComponent(targetUserId)}`, { cache: "no-store" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to load chats");
      }
      const candidateGroups = await res.json();
      if (!Array.isArray(candidateGroups) || !candidateGroups.length) {
        list.innerHTML = `<div class="invite-list-empty">${escapeHtml(targetName)} is already in all of your chats.</div>`;
        return;
      }
      renderInviteCandidateList(list, candidateGroups, targetUserId, targetName);
    } catch (err) {
      errorEl.textContent = err.message || "Failed to load chats";
      list.innerHTML = "";
    }
  }
  function renderInviteCandidateList(list, candidateGroups, targetUserId, targetName) {
    list.innerHTML = "";
    for (const group of candidateGroups) {
      const item = document.createElement("div");
      item.className = "invite-item";
      item.dataset.groupId = group.id;
      const av = document.createElement("div");
      av.className = "invite-item-avatar";
      if (group.isGlobal || isGlobalGroupId(group.id)) {
        av.style.background = "none";
        av.appendChild(createAvatarImage(GLOBAL_GROUP_ICON_SRC));
      } else if (group.groupIcon) {
        av.style.background = "none";
        av.appendChild(createAvatarImage(group.groupIcon));
      } else {
        av.style.background = groupAvatarColor(group);
        av.textContent = String(group.name || "?")[0].toUpperCase();
      }
      const meta = document.createElement("div");
      meta.className = "invite-item-meta";
      const nameEl = document.createElement("div");
      nameEl.className = "invite-item-name";
      nameEl.textContent = group.name;
      meta.appendChild(nameEl);
      if (group.isGlobal) {
        const hint = document.createElement("div");
        hint.className = "invite-item-hint";
        hint.textContent = "Global channel";
        meta.appendChild(hint);
      }
      const button = document.createElement("button");
      button.className = "btn-primary btn-sm invite-item-btn";
      button.type = "button";
      setElementIcon(button, "user-plus", { label: "Invite" });
      button.addEventListener("click", () => {
        confirmInviteMember(group, targetUserId, targetName, item);
      });
      item.append(av, meta, button);
      list.appendChild(item);
    }
  }
  function confirmInviteMember(group, targetUserId, targetName, item) {
    const inviteModal = $("invite-modal");
    if (inviteModal) inviteModal.hidden = true;
    showConfirm(
      "Invite to Chat",
      `Do you want to invite ${targetName} into ${group.name}?`,
      async () => {
        const res = await fetch(`/api/groups/${encodeURIComponent(group.id)}/invite`, {
          method: "POST",
          headers: apiHeaders(),
          body: JSON.stringify({ userId: targetUserId })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showToast(data.error || "Failed to invite member", "error");
          return;
        }
        showToast(`${targetName} joined ${group.name}`, "success");
        item.remove();
        const list = $("invite-list");
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
        filename: msg._viewerData.filename || "image",
        mimeType: msg._viewerData.blob.type || "image/png"
      };
    }
    if (!msg || msg.type !== "image" && msg.type !== "file") return null;
    const key = currentGroupId ? getGroupKey(currentGroupId) : null;
    if (!key) {
      showToast("Chat content is not ready yet", "error");
      return null;
    }
    const bytes = await decryptAttachmentBytes(msg, key, currentGroupId);
    if (!bytes) {
      showToast("File unavailable", "error");
      return null;
    }
    const detectedImageMime = msg.type === "image" ? detectImageMime(bytes) : null;
    const mimeType = detectedImageMime || "application/octet-stream";
    const blob = new Blob([bytes], { type: mimeType });
    let filename = msg.filename;
    if (!filename) {
      if (detectedImageMime === "image/png") filename = "image.png";
      else if (detectedImageMime === "image/gif") filename = "image.gif";
      else if (detectedImageMime === "image/webp") filename = "image.webp";
      else filename = msg.type === "image" ? "image.jpg" : "file.bin";
    }
    return { blob, filename, mimeType };
  }
  async function convertImageBlobToPng(blob) {
    if (blob.type === "image/png") return blob;
    if (!blob.type.startsWith("image/") || typeof createImageBitmap !== "function") return null;
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(bitmap, 0, 0);
      return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
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
        let binary = "";
        const step = 32768;
        for (let i = 0; i < bytes.length; i += step) {
          binary += String.fromCharCode(...bytes.subarray(i, i + step));
        }
        const ok = await window.electronAPI.copyBinaryToClipboard({
          base64: btoa(binary),
          mimeType: data.mimeType,
          filename: data.filename
        });
        if (ok) {
          showToast("Copied to clipboard", "success");
          return;
        }
      }
      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        const clipboardBlob = await convertImageBlobToPng(data.blob);
        if (!clipboardBlob) return;
        await navigator.clipboard.write([
          new ClipboardItem({ [clipboardBlob.type]: clipboardBlob })
        ]);
        showToast("Image copied to clipboard", "success");
      }
    } catch (err) {
      console.error("copyAttachmentToClipboard error:", err);
    }
  }
  function setWallpaperSaveState(enabled) {
    const saveBtn = $("wallpaper-save-btn");
    if (!saveBtn) return;
    saveBtn.disabled = !enabled;
  }
  function setWallpaperBusyState(busy) {
    const saveBtn = $("wallpaper-save-btn");
    const resetBtn = $("wallpaper-reset-btn");
    const closeBtn = $("wallpaper-close-btn");
    const input = $("wallpaper-input");
    if (saveBtn) saveBtn.disabled = !!busy || !wallpaperDraft || wallpaperSettingsEqual(wallpaperDraft, appLocalSettings);
    if (resetBtn) resetBtn.disabled = !!busy;
    if (closeBtn) closeBtn.disabled = !!busy;
    if (input) input.disabled = !!busy;
  }
  function setWallpaperProgress(percent, label) {
    const wrap = $("wallpaper-progress");
    const fill = $("wallpaper-progress-fill");
    const text = $("wallpaper-progress-label");
    if (!wrap || !fill || !text) return;
    if (percent === null || percent === void 0) {
      wrap.hidden = true;
      fill.style.width = "0%";
      text.textContent = "";
      return;
    }
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    wrap.hidden = false;
    fill.style.width = safePercent + "%";
    text.textContent = label || "";
  }
  function resetWallpaperProgress() {
    setWallpaperProgress(null, "");
  }
  function resetWallpaperDraft() {
    wallpaperDraft = null;
    $("wallpaper-error").textContent = "";
    $("wallpaper-input").value = "";
    resetWallpaperProgress();
    setWallpaperBusyState(false);
    setWallpaperSaveState(false);
    applyWallpaperFromSettings();
  }
  async function saveWallpaperDraft() {
    if (!wallpaperDraft || wallpaperSettingsEqual(wallpaperDraft, appLocalSettings)) {
      $("wallpaper-error").textContent = WALLPAPER_SELECT_FIRST_MSG;
      return;
    }
    const previousWallpaperSettings = getWallpaperSettings(appLocalSettings);
    const nextWallpaperSettings = getWallpaperSettings(wallpaperDraft);
    setWallpaperBusyState(true);
    setWallpaperProgress(4, "Uploading wallpaper\u2026");
    appLocalSettings.wallpaperDataUrl = nextWallpaperSettings.wallpaperDataUrl;
    appLocalSettings.wallpaperBlur = nextWallpaperSettings.wallpaperBlur;
    appLocalSettings.wallpaperTransparency = nextWallpaperSettings.wallpaperTransparency;
    applyWallpaperFromSettings();
    writeLocalSettings(appLocalSettings, currentUser && currentUser.id);
    const result = await saveSettingsToServer({
      onUploadProgress: (loaded, total) => {
        const ratio = total > 0 ? loaded / total : 0;
        setWallpaperProgress(Math.max(4, Math.round(ratio * 88)), "Uploading wallpaper\u2026");
      },
      onUploadComplete: () => {
        setWallpaperProgress(92, "Saving wallpaper\u2026");
      }
    });
    if (!result.ok && !result.networkError) {
      appLocalSettings.wallpaperDataUrl = previousWallpaperSettings.wallpaperDataUrl || null;
      appLocalSettings.wallpaperBlur = previousWallpaperSettings.wallpaperBlur;
      appLocalSettings.wallpaperTransparency = previousWallpaperSettings.wallpaperTransparency;
      applyWallpaperFromSettings();
      writeLocalSettings(appLocalSettings, currentUser && currentUser.id);
      $("wallpaper-error").textContent = result.error || "Failed to save wallpaper";
      setWallpaperBusyState(false);
      resetWallpaperProgress();
      setWallpaperSaveState(true);
      return;
    }
    setWallpaperProgress(100, result.ok ? "Wallpaper saved" : "Wallpaper saved locally");
    $("wallpaper-modal").hidden = true;
    resetWallpaperDraft();
    showToast(result.ok ? WALLPAPER_SAVE_SUCCESS_MSG : WALLPAPER_SAVE_SYNC_FAIL_MSG, result.ok ? "success" : "info");
  }
  function applyWallpaperDraftPreview(dataUrl) {
    const draft = getWallpaperSettings({
      ...appLocalSettings,
      ...wallpaperDraft || {},
      wallpaperDataUrl: dataUrl !== void 0 ? dataUrl : wallpaperDraft ? wallpaperDraft.wallpaperDataUrl : appLocalSettings.wallpaperDataUrl
    });
    applyWallpaperPreviewStyle(draft.wallpaperDataUrl, draft.wallpaperBlur, draft.wallpaperTransparency);
    syncWallpaperDraftControls(draft);
  }
  async function downloadAttachment(msg) {
    const data = await getAttachmentData(msg);
    if (!data) return;
    const url = URL.createObjectURL(data.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = data.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }
  async function startEditMessage(msg, currentPlaintext) {
    const row = document.querySelector('[data-msg-id="' + msg.id + '"]');
    if (!row) return;
    const bubble = row.querySelector(".msg-bubble");
    const textEl = row.querySelector(".msg-text");
    if (!bubble || !textEl) return;
    const editForm = document.createElement("div");
    editForm.className = "msg-edit-form";
    const editInput = document.createElement("textarea");
    editInput.className = "msg-edit-input";
    editInput.value = currentPlaintext;
    const CHARS_PER_ROW = 50;
    editInput.rows = Math.max(1, Math.ceil(currentPlaintext.length / CHARS_PER_ROW));
    const editSave = document.createElement("button");
    editSave.className = "msg-edit-save";
    editSave.textContent = "Save";
    const editCancel = document.createElement("button");
    editCancel.className = "msg-edit-cancel";
    editCancel.textContent = "Cancel";
    editForm.append(editInput, editSave, editCancel);
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
      if (!newText || newText === currentPlaintext) {
        cancelEdit();
        return;
      }
      const key = getGroupKey(currentGroupId);
      if (!key) {
        showToast("Chat content is not ready yet", "error");
        cancelEdit();
        return;
      }
      isSaving = true;
      editSave.disabled = true;
      try {
        const nextRevision = Number(msg.revision || 1) + 1;
        const replacement = await encryptV2Message(newText, {
          hashtag: msg.hashtag || null,
          filename: msg.filename || null
        }, { ...msg, groupId: currentGroupId, revision: nextRevision }, key);
        const tagIndex = msg.hashtag ? await blindIndex(msg.hashtag, key, currentGroupId, "tag-index") : null;
        const spamSignature = await blindIndex(newText, key, currentGroupId, "spam-signature");
        const res = await fetch(`/api/groups/${currentGroupId}/messages/${msg.id}`, {
          method: "PATCH",
          headers: apiHeaders(),
          body: JSON.stringify({
            ...replacement,
            expectedRevision: Number(msg.revision || 1),
            encryptionVersion: 2,
            keyVersion: 1,
            tagIndex,
            spamSignature
          })
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          if (res.status === 409 && d.latest) {
            const cache = ensureGroupCacheEntry(currentGroupId);
            const index = (cache.messages || []).findIndex((entry) => entry.id === msg.id);
            if (index >= 0) cache.messages[index] = d.latest;
            cache.rowsDirty = true;
            renderGroupFromCache(currentGroupId);
          }
          showToast(d.error || "Edit failed", "error");
          isSaving = false;
          editSave.disabled = false;
          return;
        }
        cancelEdit();
      } catch (err) {
        console.error("Edit error:", err);
        showToast("Edit failed", "error");
        isSaving = false;
        editSave.disabled = false;
      }
    };
    editCancel.addEventListener("mousedown", (e) => e.preventDefault());
    editCancel.addEventListener("click", cancelEdit);
    editInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") cancelEdit();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void saveEdit();
      }
    });
    editInput.addEventListener("blur", () => void saveEdit());
    editSave.addEventListener("click", () => void saveEdit());
  }
  async function doSend(text) {
    if (!currentGroupId || !socket) return;
    if (aiTonePickOpen) return;
    const key = getGroupKey(currentGroupId);
    if (!key) {
      showToast("Chat content is not ready yet", "error");
      return;
    }
    const parsedMessage = parseComposerMessageInput(text);
    if (!parsedMessage.ok) {
      showToast(parsedMessage.error, "error");
      return;
    }
    if (parsedMessage.isAiPrompt) {
      void sendAiPromptWithTonePicker(parsedMessage);
      return;
    }
    const messageText = parsedMessage.text;
    try {
      const messageId = crypto.randomUUID();
      const type = parsedMessage.whisperRecipientIds?.length ? "whisper" : "text";
      const messageIdentity = {
        id: messageId,
        groupId: currentGroupId,
        senderId: currentUser.id,
        type,
        encryptionVersion: 2,
        keyVersion: 1,
        revision: 1
      };
      const metadata = {
        hashtag: parsedMessage.hashtag || null,
        replyPreview: replyingTo ? { senderName: replyingTo.senderName, preview: replyingTo.preview } : null
      };
      const encrypted = await encryptV2Message(messageText, metadata, messageIdentity, key);
      const { encryptedContent, iv, encryptedMetadata, metadataIv } = encrypted;
      if (estimateBase64Bytes(encryptedContent) > MAX_TEXT_MESSAGE_BYTES) {
        showToast("Message too large", "error");
        return;
      }
      const hashtag = parsedMessage.hashtag || null;
      const tagIndex = hashtag && hashtag !== DEFAULT_TAG_TOPIC ? await blindIndex(hashtag, key, currentGroupId, "tag-index") : null;
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
        disappearingDurationMs: parsedMessage.disappearingDurationMs
      };
      if (parsedMessage.whisperRecipientIds && parsedMessage.whisperRecipientIds.length > 0) {
        socket.emit("send_whisper", {
          ...envelope,
          whisperTo: parsedMessage.whisperRecipientIds
        });
      } else {
        socket.emit("send_message", envelope);
      }
      appendOptimisticOwnMessage({
        id: messageId,
        groupId: currentGroupId,
        senderId: currentUser.id,
        senderName: currentUser.username,
        senderColor: currentUser.iconColor,
        type,
        encryptedContent,
        iv,
        encryptedMetadata,
        metadataIv,
        encryptionVersion: 2,
        keyVersion: 1,
        revision: 1,
        hashtag: parsedMessage.hashtag || null,
        tagIndex,
        replyToId,
        replyPreview: metadata.replyPreview || null,
        whisperTo: parsedMessage.whisperRecipientIds && parsedMessage.whisperRecipientIds.length ? parsedMessage.whisperRecipientIds : null,
        isDisappearing: parsedMessage.isDisappearing,
        disappearingDurationMs: parsedMessage.disappearingDurationMs,
        disappearingStartedAt: null,
        disappearingExpiresAt: null,
        disappearingHiddenAt: null,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        editedAt: null,
        totalRecipients: 0,
        readCount: 0,
        _decryptedText: messageText,
        _optimistic: true
      });
      resetComposerAfterSend();
    } catch (err) {
      console.error("Encryption failed:", err);
      showToast("Failed to send message", "error");
    }
  }
  function showToast(msg, type = "info") {
    const container = $("toast-container");
    if (!container || container.querySelectorAll(".toast:not(.hiding)").length >= 3) return;
    const el = document.createElement("div");
    el.className = "toast toast-" + type;
    el.textContent = msg;
    container.appendChild(el);
    const remove = () => {
      if (!el.isConnected || el.classList.contains("hiding")) return;
      el.classList.add("hiding");
      setTimeout(() => el.remove(), 320);
    };
    setTimeout(remove, 3e3);
  }
  var uploadFinalizeWatchers = /* @__PURE__ */ new Map();
  var UPLOAD_FINALIZE_TIMEOUT_MS = 6e3;
  function watchUploadFinalize(uploadId, groupId) {
    if (uploadFinalizeWatchers.has(uploadId)) return;
    uploadFinalizeWatchers.set(uploadId, setTimeout(() => {
      uploadFinalizeWatchers.delete(uploadId);
      removePendingAttachment(uploadId);
      if (String(groupId) === String(currentGroupId)) {
        void refreshCurrentGroupFromServer();
      }
    }, UPLOAD_FINALIZE_TIMEOUT_MS));
  }
  function clearUploadFinalizeWatch(uploadId) {
    const timer = uploadFinalizeWatchers.get(uploadId);
    if (!timer) return;
    clearTimeout(timer);
    uploadFinalizeWatchers.delete(uploadId);
  }
  function ensurePendingAttachmentRow(payload) {
    const { uploadId, senderId, senderName, senderColor, type, filename, totalBytes } = payload;
    if (!uploadId || pendingAttachmentRows.has(uploadId) || payload.groupId !== currentGroupId) return;
    const isOwn = senderId === currentUser.id;
    const row = document.createElement("div");
    row.className = "msg-row pending" + (isOwn ? " own" : "");
    row.dataset.uploadId = uploadId;
    const avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    const memberProfile = getMemberProfile(currentGroupId, senderId);
    renderAvatarElement(avatar, {
      username: memberProfile?.username || senderName,
      iconColor: memberProfile?.iconColor || senderColor,
      // v1.3.13: never fall back to the CURRENT user's picture for someone
      // else's upload — a member without a profile picture used to render with
      // the viewer's own avatar.
      profilePicture: memberProfile?.profilePicture || payload.senderProfilePicture || null
    });
    const content = document.createElement("div");
    content.className = "msg-content";
    const header = document.createElement("div");
    header.className = "msg-header";
    const nameEl = document.createElement("div");
    nameEl.className = "msg-sender-name";
    nameEl.textContent = memberProfile?.username || senderName || "Unknown";
    header.appendChild(nameEl);
    content.appendChild(header);
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    const progressWrap = document.createElement("div");
    progressWrap.className = "msg-attachment-progress";
    const progressTrack = document.createElement("div");
    progressTrack.className = "msg-attachment-progress-track";
    const progressFill = document.createElement("div");
    progressFill.className = "msg-attachment-progress-fill";
    const progressLabel = document.createElement("span");
    progressLabel.className = "msg-attachment-progress-label";
    progressLabel.textContent = `0 B / ${formatBytes(totalBytes)}`;
    progressTrack.appendChild(progressFill);
    progressWrap.append(progressTrack, progressLabel);
    bubble.appendChild(progressWrap);
    if (type === "image") {
      const locked = document.createElement("div");
      locked.className = "msg-image-locked";
      locked.appendChild(createIcon("image"));
      bubble.appendChild(locked);
    } else {
      const text = document.createElement("span");
      text.className = "msg-text";
      text.textContent = filename || "file";
      bubble.appendChild(text);
    }
    const meta = document.createElement("span");
    meta.className = "msg-meta";
    meta.textContent = "Preparing\u2026";
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
    const fill = row.querySelector(".msg-attachment-progress-fill");
    const label = row.querySelector(".msg-attachment-progress-label");
    const total = Math.max(1, Number(totalBytes) || 1);
    const loaded = Math.max(0, Math.min(total, Number(loadedBytes) || 0));
    const current = Number(fill ? parseFloat(fill.style.width) || 0 : 0);
    const nextPercent = loaded / total * 100;
    if (nextPercent < current) return;
    if (fill) fill.style.width = `${nextPercent}%`;
    if (label) label.textContent = `${formatBytes(loaded)} / ${formatBytes(total)}`;
  }
  function setPendingAttachmentStatus(uploadId, statusText) {
    const row = pendingAttachmentRows.get(uploadId);
    if (!row) return;
    const meta = row.querySelector(".msg-meta");
    if (meta) meta.textContent = statusText;
  }
  function removePendingAttachment(uploadId) {
    clearUploadFinalizeWatch(uploadId);
    const row = pendingAttachmentRows.get(uploadId);
    if (!row) return;
    row.remove();
    pendingAttachmentRows.delete(uploadId);
  }
  async function updateGroupSettingRequest(payload) {
    const res = await fetch("/api/groups/" + currentGroupId + "/settings", {
      method: "PATCH",
      headers: apiHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, error: data.error || null };
  }
  function uploadEncryptedAttachment(groupId, body, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/groups/${groupId}/upload`);
      const isBinaryUpload = body && body.encryptedBytes instanceof Uint8Array;
      const headers = apiHeaders({ json: !isBinaryUpload });
      for (const [key, val] of Object.entries(headers)) xhr.setRequestHeader(key, val);
      xhr.upload.onprogress = (evt) => {
        if (!evt.lengthComputable || typeof onProgress !== "function") return;
        onProgress(evt.loaded, evt.total);
      };
      xhr.onerror = () => reject(new Error("Upload failed"));
      xhr.onload = () => {
        const raw = xhr.responseText || "{}";
        let data = {};
        try {
          data = JSON.parse(raw);
        } catch {
        }
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
      };
      if (isBinaryUpload) {
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.setRequestHeader("X-Upload-IV", body.iv);
        xhr.setRequestHeader("X-Upload-Type", body.type);
        xhr.setRequestHeader("X-Message-Id", body.id);
        xhr.setRequestHeader("X-Encrypted-Metadata", body.encryptedMetadata);
        xhr.setRequestHeader("X-Metadata-IV", body.metadataIv);
        xhr.setRequestHeader("X-Encryption-Version", "2");
        xhr.setRequestHeader("X-Key-Version", "1");
        xhr.setRequestHeader("X-Client-Upload-Id", body.clientUploadId || "");
        if (body.tagIndex) xhr.setRequestHeader("X-Tag-Index", body.tagIndex);
        if (body.replyToId) xhr.setRequestHeader("X-Reply-To-Id", String(body.replyToId));
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
      showToast("Chat content is not ready yet", "error");
      return;
    }
    const uploadId = createUploadId();
    let processedFile = file;
    const isImage = isAllowedUploadImageType(file.type);
    if (isImage) {
      processedFile = await compressImage(file);
      if (processedFile.size > MAX_ATTACHMENT_BYTES) {
        showToast(ATTACHMENT_TOO_LARGE_MSG, "error");
        return;
      }
    } else {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        showToast(ATTACHMENT_TOO_LARGE_MSG, "error");
        return;
      }
    }
    try {
      const totalBytes = processedFile.size;
      const progressPayload = {
        groupId: currentGroupId,
        uploadId,
        type: isImage ? "image" : "file",
        filename: file.name,
        totalBytes,
        loadedBytes: 0,
        senderId: currentUser.id,
        senderName: currentUser.username,
        senderColor: currentUser.iconColor
      };
      ensurePendingAttachmentRow(progressPayload);
      socket.emit("attachment_upload_progress", { ...progressPayload, filename: null });
      setPendingAttachmentStatus(uploadId, "Preparing\u2026");
      const buffer = await processedFile.arrayBuffer();
      updatePendingAttachmentProgress(uploadId, Math.max(1, Math.round(totalBytes * 0.2)), totalBytes);
      setPendingAttachmentStatus(uploadId, "Encrypting\u2026");
      const messageId = crypto.randomUUID();
      const messageIdentity = { id: messageId, groupId: currentGroupId, senderId: currentUser.id, type: isImage ? "image" : "file", keyVersion: 1, revision: 1 };
      const aad = v2Aad(messageIdentity);
      const { encryptedBytes, iv } = await encryptBytes(buffer, key, currentGroupId, aad);
      const hashtag = getActiveTagTopic();
      const replyPreview = replyingTo ? { senderName: replyingTo.senderName, preview: replyingTo.preview } : null;
      const metadataEnvelope = await encryptJson({ filename: file.name, hashtag, replyPreview }, key, currentGroupId, "metadata", aad);
      const tagIndex = hashtag && hashtag !== DEFAULT_TAG_TOPIC ? await blindIndex(hashtag, key, currentGroupId, "tag-index") : null;
      let lastBroadcastLoaded = 0;
      let lastBroadcastAt = 0;
      const emitProgress = (loaded, total, force = false) => {
        const now = Date.now();
        const shouldEmit = force || loaded === 0 || loaded >= total || now - lastBroadcastAt >= 120 || loaded - lastBroadcastLoaded >= Math.max(32768, total * 0.05);
        if (!shouldEmit) return;
        lastBroadcastLoaded = loaded;
        lastBroadcastAt = now;
        socket.emit("attachment_upload_progress", {
          ...progressPayload,
          filename: null,
          loadedBytes: loaded,
          totalBytes: total
        });
      };
      const body = {
        id: messageId,
        encryptedBytes,
        iv,
        type: isImage ? "image" : "file",
        encryptedMetadata: metadataEnvelope.encryptedContent,
        metadataIv: metadataEnvelope.iv,
        tagIndex,
        clientUploadId: uploadId,
        replyToId: replyingTo?.id || null
      };
      const res = await uploadEncryptedAttachment(currentGroupId, body, (loaded, total) => {
        updatePendingAttachmentProgress(uploadId, loaded, total);
        setPendingAttachmentStatus(uploadId, "Uploading\u2026");
        emitProgress(loaded, total || totalBytes);
      });
      if (!res.ok) {
        removePendingAttachment(uploadId);
        socket.emit("attachment_upload_failed", { groupId: currentGroupId, uploadId });
        const d = res.data || {};
        showToast(d.error || "Upload failed", "error");
        return;
      }
      updatePendingAttachmentProgress(uploadId, totalBytes, totalBytes);
      setPendingAttachmentStatus(uploadId, "Finalizing\u2026");
      emitProgress(totalBytes, totalBytes, true);
      watchUploadFinalize(uploadId, currentGroupId);
    } catch (err) {
      console.error("File upload error:", err);
      removePendingAttachment(uploadId);
      socket.emit("attachment_upload_failed", { groupId: currentGroupId, uploadId });
      showToast("Upload failed", "error");
    }
  }
  function formatDiagnosticsValue(value) {
    if (value == null || value === "") return "\u2014";
    return String(value);
  }
  function formatDiagnosticsTime(value) {
    if (!value) return "\u2014";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "\u2014" : date.toLocaleString();
  }
  function getDisplayModeLabel() {
    if (window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true) return "standalone";
    if (window.matchMedia?.("(display-mode: minimal-ui)").matches) return "minimal-ui";
    if (window.matchMedia?.("(display-mode: fullscreen)").matches) return "fullscreen";
    return "browser";
  }
  function getServiceWorkerStatusLabel() {
    if (!("serviceWorker" in navigator)) return "unsupported";
    return navigator.serviceWorker.controller ? "controlled" : "not controlled";
  }
  function getViewportSizeLabel() {
    return `${window.innerWidth} \xD7 ${window.innerHeight}`;
  }
  function getVisualViewportSizeLabel() {
    const vv = window.visualViewport;
    if (!vv) return "unavailable";
    return `${Math.round(vv.width)} \xD7 ${Math.round(vv.height)} @ ${Math.round(vv.offsetTop)}`;
  }
  function getSafeAreaLabel() {
    const style = getComputedStyle(document.documentElement);
    return [
      `top ${style.getPropertyValue("--safe-area-top").trim() || "0px"}`,
      `right ${style.getPropertyValue("--safe-area-right").trim() || "0px"}`,
      `bottom ${style.getPropertyValue("--safe-area-bottom").trim() || "0px"}`,
      `left ${style.getPropertyValue("--safe-area-left").trim() || "0px"}`
    ].join(" \xB7 ");
  }
  function resolveConnectionStateLabel() {
    if (socket?.connected) return { state: "connected", label: "Connected" };
    if (!socketDiagnostics.isBrowserOnline) return { state: "offline", label: "Offline" };
    if (socketDiagnostics.reconnectFailed) return { state: "disconnected", label: "Reconnect failed" };
    if (socketDiagnostics.reconnectAttempts > 0) return { state: "reconnecting", label: `Reconnecting (${socketDiagnostics.reconnectAttempts})` };
    if (socketDiagnostics.lastConnectError) return { state: "error", label: "Connection error" };
    return { state: "connecting", label: "Connecting\u2026" };
  }
  function updateConnectionTransport() {
    socketDiagnostics.socketTransport = socket?.io?.engine?.transport?.name || "unknown";
    socketDiagnostics.socketId = socket?.id || "";
  }
  function updateReconnectBanner() {
    const banner = $("reconnect-banner");
    const text = $("reconnect-banner-text");
    if (!banner || !text) return;
    if (socket?.connected) {
      banner.hidden = true;
      return;
    }
    const parts = [];
    if (!socketDiagnostics.isBrowserOnline) {
      parts.push("Offline");
    } else if (socketDiagnostics.reconnectFailed) {
      parts.push("Reconnect failed");
    } else if (socketDiagnostics.reconnectAttempts > 0) {
      parts.push(`Reconnecting\u2026 (${socketDiagnostics.reconnectAttempts})`);
    } else {
      parts.push("Reconnecting\u2026");
    }
    if (socketDiagnostics.lastDisconnectReason) {
      parts.push(socketDiagnostics.lastDisconnectReason);
    }
    text.textContent = parts.filter(Boolean).join(" \xB7 ");
    banner.hidden = false;
  }
  function updateConnectionStatusUi(stateOverride, labelOverride) {
    const stateInfo = stateOverride ? { state: stateOverride, label: labelOverride || resolveConnectionStateLabel().label } : resolveConnectionStateLabel();
    socketDiagnostics.connectionState = stateInfo.state;
    const status = $("conn-status");
    const label = $("conn-label");
    $("conn-dot").className = stateInfo.state === "connected" ? "conn-dot connected" : "conn-dot";
    if (status) {
      status.dataset.state = stateInfo.state;
      status.classList.add("is-actionable");
    }
    if (label) label.textContent = stateInfo.label;
    updateReconnectBanner();
  }
  function renderDiagnosticsPanel() {
    const grid = $("diagnostics-grid");
    if (!grid) return;
    const fields = [
      ["App version", appVersionLabel],
      ["Display mode", getDisplayModeLabel()],
      ["Current URL", window.location.href],
      ["Service worker", getServiceWorkerStatusLabel()],
      ["Online status", socketDiagnostics.isBrowserOnline ? "online" : "offline"],
      ["Health status", socketDiagnostics.healthStatus],
      ["Health latency", socketDiagnostics.healthLatencyMs == null ? "\u2014" : `${socketDiagnostics.healthLatencyMs} ms`],
      ["Health checked", formatDiagnosticsTime(socketDiagnostics.healthCheckedAt)],
      ["Health edge", socketDiagnostics.healthEdge || "\u2014"],
      ["Health request id", socketDiagnostics.healthRequestId || "\u2014"],
      ["Server time", formatDiagnosticsTime(socketDiagnostics.healthServerTime)],
      ["Railway environment", socketDiagnostics.healthEnvironment || "\u2014"],
      ["Socket connected", socket?.connected ? "true" : "false"],
      ["Socket id", socketDiagnostics.socketId || "\u2014"],
      ["Transport", socketDiagnostics.socketTransport],
      ["Last connect", formatDiagnosticsTime(socketDiagnostics.lastConnectAt)],
      ["Last disconnect", formatDiagnosticsTime(socketDiagnostics.lastDisconnectAt)],
      ["Last disconnect reason", socketDiagnostics.lastDisconnectReason || "\u2014"],
      ["Last connect error", socketDiagnostics.lastConnectError || "\u2014"],
      ["Last error time", formatDiagnosticsTime(socketDiagnostics.lastConnectErrorAt)],
      ["Reconnect attempts", socketDiagnostics.reconnectAttempts],
      ["Viewport", getViewportSizeLabel()],
      ["Visual viewport", getVisualViewportSizeLabel()],
      ["Safe area", getSafeAreaLabel()],
      ["User agent", navigator.userAgent]
    ];
    grid.innerHTML = "";
    for (const [label, value] of fields) {
      const item = document.createElement("div");
      item.className = "diagnostics-item";
      const labelEl = document.createElement("span");
      labelEl.className = "diagnostics-label";
      labelEl.textContent = label;
      const valueEl = document.createElement("span");
      valueEl.className = "diagnostics-value";
      valueEl.textContent = formatDiagnosticsValue(value);
      item.append(labelEl, valueEl);
      grid.appendChild(item);
    }
  }
  async function refreshDiagnosticsHealth() {
    const startedAt = performance.now();
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const latency = Math.max(0, Math.round(performance.now() - startedAt));
      const data = await res.json().catch(() => ({}));
      const diagnostics = data?.diagnostics && typeof data.diagnostics === "object" ? data.diagnostics : {};
      if (res.ok && data.ok === true) socketDiagnostics.healthStatus = "ok";
      else if (res.ok) socketDiagnostics.healthStatus = "degraded";
      else socketDiagnostics.healthStatus = "error";
      socketDiagnostics.healthLatencyMs = latency;
      socketDiagnostics.healthCheckedAt = data?.checkedAt || (/* @__PURE__ */ new Date()).toISOString();
      socketDiagnostics.healthEdge = diagnostics.railwayEdge || "";
      socketDiagnostics.healthRequestId = diagnostics.railwayRequestId || "";
      socketDiagnostics.healthServerTime = diagnostics.serverTime || "";
      socketDiagnostics.healthEnvironment = diagnostics.railwayEnvironment || "";
    } catch {
      socketDiagnostics.healthStatus = "unreachable";
      socketDiagnostics.healthLatencyMs = null;
      socketDiagnostics.healthCheckedAt = (/* @__PURE__ */ new Date()).toISOString();
      socketDiagnostics.healthEdge = "";
      socketDiagnostics.healthRequestId = "";
      socketDiagnostics.healthServerTime = "";
      socketDiagnostics.healthEnvironment = "";
    }
    renderDiagnosticsPanel();
  }
  function openDiagnosticsModal() {
    $("diagnostics-modal").hidden = false;
    updateConnectionTransport();
    renderDiagnosticsPanel();
    void refreshDiagnosticsHealth();
  }
  function closeDiagnosticsModal() {
    $("diagnostics-modal").hidden = true;
  }
  var socketHasConnectedOnce = false;
  async function refreshCurrentGroupAfterReconnect({ fullSync = false } = {}) {
    try {
      await loadGroups({ withBackendPreload: fullSync });
      if (!currentGroupId) return;
      const cacheBefore = ensureGroupCacheEntry(currentGroupId);
      const fingerprintBefore = cacheFingerprint(cacheBefore.messages);
      await Promise.all([loadMessages(currentGroupId), loadMembers(currentGroupId)]);
      if (!currentGroupId) return;
      const cacheAfter = ensureGroupCacheEntry(currentGroupId);
      const fingerprintAfter = cacheFingerprint(cacheAfter.messages);
      if (fingerprintBefore !== fingerprintAfter) {
        renderGroupFromCache(currentGroupId, { restoreScroll: false });
      }
      observeCurrentGroupRowsForRead();
      if (composerNearBottomBeforeFocus || isNearBottom()) scrollToBottom(true);
    } catch (err) {
      console.warn("Failed to refresh current group after reconnect:", err);
    }
  }
  function cacheFingerprint(messages) {
    if (!Array.isArray(messages) || !messages.length) return "0:";
    const last = messages[messages.length - 1];
    return `${messages.length}:${last.id}`;
  }
  var lastFocusStateSyncAt = 0;
  function syncStateOnFocus() {
    const now = Date.now();
    if (now - lastFocusStateSyncAt < 30 * 1e3) return;
    lastFocusStateSyncAt = now;
    if (!socket?.connected) {
      void loadGroups();
      if (currentGroupId) void refreshCurrentGroupFromServer();
    }
  }
  function manualReconnectSocket() {
    if (!socket) return;
    socketDiagnostics.reconnectAttempts = 0;
    socketDiagnostics.reconnectFailed = false;
    socketDiagnostics.lastConnectError = "";
    socketDiagnostics.lastConnectErrorAt = "";
    updateConnectionStatusUi("connecting", "Reconnecting\u2026");
    socket.disconnect();
    socket.connect();
  }
  function bindOnlineOfflineListeners() {
    const syncOnlineState = () => {
      socketDiagnostics.isBrowserOnline = navigator.onLine !== false;
      if (!socketDiagnostics.isBrowserOnline) {
        updateConnectionStatusUi("offline");
      } else if (socket?.connected) {
        updateConnectionStatusUi("connected");
      } else {
        updateConnectionStatusUi(socketDiagnostics.reconnectAttempts > 0 ? "reconnecting" : "connecting");
        if (socket) socket.connect();
      }
      renderDiagnosticsPanel();
    };
    window.addEventListener("online", syncOnlineState);
    window.addEventListener("offline", syncOnlineState);
    syncOnlineState();
  }
  function initSocket() {
    socket = io({
      transports: ["polling", "websocket"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 900,
      reconnectionDelayMax: 8e3,
      timeout: 2e4
    });
    updateConnectionTransport();
    renderDiagnosticsPanel();
    socket.on("connect", () => {
      socketDiagnostics.connectionState = "connected";
      socketDiagnostics.lastConnectError = "";
      socketDiagnostics.lastConnectErrorAt = "";
      socketDiagnostics.lastConnectAt = (/* @__PURE__ */ new Date()).toISOString();
      socketDiagnostics.reconnectAttempts = 0;
      socketDiagnostics.reconnectFailed = false;
      clearTimeout(disconnectStatusTimer);
      disconnectStatusTimer = 0;
      updateConnectionTransport();
      updateConnectionStatusUi("connected", "Connected");
      console.info("[socket] connect", {
        id: socket.id,
        transport: socketDiagnostics.socketTransport
      });
      if (currentGroupId) socket.emit("join_room", currentGroupId);
      joinAllGroupRooms();
      flushMarkReadEmits();
      if (socketHasConnectedOnce) {
        const downMs = socketDiagnostics.lastDisconnectAt ? Date.now() - new Date(socketDiagnostics.lastDisconnectAt).getTime() : Number.POSITIVE_INFINITY;
        const needFullResync = downMs > SOCKET_RECOVERY_WINDOW_MS;
        void refreshCurrentGroupAfterReconnect({ fullSync: needFullResync });
      } else {
        socketHasConnectedOnce = true;
        void refreshCurrentGroupAfterReconnect();
      }
      renderDiagnosticsPanel();
    });
    socket.on("disconnect", (reason) => {
      socketDiagnostics.lastDisconnectReason = reason || "unknown";
      socketDiagnostics.lastDisconnectAt = (/* @__PURE__ */ new Date()).toISOString();
      joinedRoomIds = /* @__PURE__ */ new Set();
      updateConnectionTransport();
      clearTimeout(disconnectStatusTimer);
      disconnectStatusTimer = setTimeout(() => {
        disconnectStatusTimer = 0;
        if (document.visibilityState === "hidden") return;
        updateConnectionStatusUi(socketDiagnostics.isBrowserOnline ? "disconnected" : "offline", socketDiagnostics.isBrowserOnline ? "Disconnected" : "Offline");
      }, DISCONNECT_STATUS_GRACE_MS);
      console.warn("[socket] disconnect", { reason });
      pendingDisappearingStartMessageIds = /* @__PURE__ */ new Set();
      pendingReadMessageIds.clear();
      clearAllMessageVisibilityTimers();
      renderDiagnosticsPanel();
    });
    socket.on("connect_error", (error) => {
      socketDiagnostics.lastConnectError = error?.message || "unknown";
      socketDiagnostics.lastConnectErrorAt = (/* @__PURE__ */ new Date()).toISOString();
      if (document.visibilityState !== "hidden") {
        updateConnectionStatusUi(socketDiagnostics.isBrowserOnline ? "error" : "offline", socketDiagnostics.isBrowserOnline ? "Connection error" : "Offline");
      }
      console.warn("[socket] connect_error", { message: socketDiagnostics.lastConnectError });
      renderDiagnosticsPanel();
    });
    socket.io.on("reconnect_attempt", (attempt) => {
      socketDiagnostics.reconnectAttempts = Number(attempt) || socketDiagnostics.reconnectAttempts + 1;
      if (document.visibilityState !== "hidden") {
        updateConnectionStatusUi("reconnecting");
        updateReconnectBanner();
      }
      console.info("[socket] reconnect_attempt", { attempt: socketDiagnostics.reconnectAttempts });
      renderDiagnosticsPanel();
    });
    socket.io.on("reconnect", (attempt) => {
      socketDiagnostics.reconnectAttempts = Number(attempt) || 0;
      socketDiagnostics.reconnectFailed = false;
      updateConnectionTransport();
      updateConnectionStatusUi("connected", "Connected");
      console.info("[socket] reconnect", {
        attempt: socketDiagnostics.reconnectAttempts,
        transport: socketDiagnostics.socketTransport
      });
      renderDiagnosticsPanel();
    });
    socket.io.on("reconnect_failed", () => {
      socketDiagnostics.reconnectFailed = true;
      updateConnectionStatusUi("disconnected", "Reconnect failed");
      updateReconnectBanner();
      console.warn("[socket] reconnect_failed");
      renderDiagnosticsPanel();
    });
    socket.on("attachment_upload_progress", (payload) => {
      if (!payload || payload.groupId !== currentGroupId) return;
      if (payload.senderId === currentUser?.id && !pendingAttachmentRows.has(payload.uploadId)) return;
      ensurePendingAttachmentRow(payload);
      updatePendingAttachmentProgress(payload.uploadId, payload.loadedBytes, payload.totalBytes);
    });
    socket.on("attachment_upload_failed", ({ groupId, uploadId }) => {
      if (groupId !== currentGroupId) return;
      removePendingAttachment(uploadId);
    });
    socket.on("new_message", async (msg) => {
      if (!document.hasFocus() && msg.senderId !== currentUser.id) {
        unreadNotificationCount++;
        updatePageTitleNotification();
      }
      if (cacheHasMessage(msg.groupId, msg.id)) {
        if (msg.clientUploadId) removePendingAttachment(msg.clientUploadId);
        reconcileOptimisticEcho(msg);
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
          mergeMessagesIntoCache(msg.groupId, [msg]);
        }
        if (cache.messageRows && !cache.rowsDirty) {
          const prevMsg = cache.messages && cache.messages.length > 1 ? cache.messages[cache.messages.length - 2] : null;
          const row = await buildMessageRow(msg, msg.groupId, { showSenderName: !shouldContinueSeries(prevMsg, msg) });
          if (row) {
            cache.messageRows.push(row);
          }
        }
        if (msg.senderId !== currentUser.id) {
          unreadCounts[msg.groupId] = Math.max(0, (unreadCounts[msg.groupId] || 0) + 1);
          updateUnreadBadge(msg.groupId, unreadCounts[msg.groupId]);
          playNotifSound();
        }
        const preview = await getMessagePreviewText(msg, msg.groupId);
        updateGroupPreview(msg.groupId, preview, msg.createdAt);
        if (msg.senderId !== currentUser.id) {
          const totalUnread = getTotalUnreadCount();
          pushStatus.totalUnreadCount = totalUnread;
          sendNativeNotification(totalUnread, msg.groupId, { senderName: msg.senderName, preview });
        }
        if (msg.clientUploadId) removePendingAttachment(msg.clientUploadId);
        return;
      }
      applyCurrentUserReadState(msg);
      await hydrateMessageChannel(msg, msg.groupId);
      const incomingTopic = resolveMessageTagTopic(msg);
      const incomingIsActiveChannel = incomingTopic === getActiveTagTopic();
      const activeChannelWasPinned = incomingIsActiveChannel && isNearBottom();
      await appendMessageBubble(msg, true, msg.groupId);
      if (msg.clientUploadId) removePendingAttachment(msg.clientUploadId);
      if (msg.senderId !== currentUser.id) {
        observeCurrentGroupRowsForRead();
        if (incomingIsActiveChannel && activeChannelWasPinned) {
          markChannelReadAt(msg.groupId, msg);
        } else {
          unreadCounts[msg.groupId] = Math.max(0, (unreadCounts[msg.groupId] || 0) + 1);
          updateUnreadBadge(msg.groupId, unreadCounts[msg.groupId]);
          if (channelUnreadLoadedForGroup === String(msg.groupId)) {
            let tagIndex = incomingTopic === DEFAULT_TAG_TOPIC ? "" : channelUnreadTagIndexByTopic.get(incomingTopic);
            if (tagIndex == null && incomingTopic !== DEFAULT_TAG_TOPIC) {
              tagIndex = await channelTagIndex(incomingTopic, msg.groupId);
              channelUnreadTagIndexByTopic.set(incomingTopic, String(tagIndex));
              channelUnreadTopicByTagIndex.set(String(tagIndex), incomingTopic);
            }
            channelUnreadCounts[String(tagIndex)] = Math.max(0, (channelUnreadCounts[String(tagIndex)] || 0) + 1);
            renderTagFilters();
          }
        }
      }
      const preview2 = await getMessagePreviewText(msg, msg.groupId);
      updateGroupPreview(msg.groupId, preview2, msg.createdAt);
      if (msg.senderId !== currentUser.id) {
        const totalUnread = getTotalUnreadCount();
        pushStatus.totalUnreadCount = totalUnread;
        sendNativeNotification(totalUnread, msg.groupId, { senderName: msg.senderName, preview: preview2 });
      }
    });
    socket.on("message_read_update", ({ messageId, readCount }) => {
      pendingReadMessageIds.delete(messageId);
      markMessageReadConfirmed(messageId);
      updateDeliveryForMessage(messageId, readCount);
      const stored = allMessages.find((m) => m.id === messageId);
      if (stored) stored.readCount = Math.max(0, Number(readCount) || 0);
    });
    socket.on("read_cursor_updated", (payload) => {
      const { groupId, tagIndex, createdAt, messageId, channelUnreadCount, groupUnreadCount } = payload || {};
      if (!groupId) return;
      const groupKey = String(groupId);
      const tagKey = tagIndex == null || tagIndex === "" ? "" : String(tagIndex);
      if (createdAt && (tagKey === "" || String(currentGroupId) === groupKey && channelUnreadLoadedForGroup === groupKey)) {
        const topic = tagKey === "" ? DEFAULT_TAG_TOPIC : channelUnreadTopicByTagIndex.get(tagKey) || null;
        if (topic) setLocalReadCursor(groupKey, topic, { at: createdAt, id: messageId || "" });
      }
      unreadCounts[groupKey] = Math.max(0, Number(groupUnreadCount) || 0);
      updateUnreadBadge(groupKey, unreadCounts[groupKey]);
      if (String(currentGroupId) === groupKey && channelUnreadLoadedForGroup === groupKey) {
        channelUnreadCounts[tagKey] = Math.max(0, Number(channelUnreadCount) || 0);
        renderTagFilters();
      }
      if (String(currentGroupId) === groupKey) {
        refreshUnseenRowClasses();
        updateFirstUnreadButton();
      }
    });
    socket.on("disappearing_state_updated", (payload) => {
      applyDisappearingStateUpdate(payload || {});
    });
    socket.on("message_deleted", ({ messageId }) => {
      clearDisappearingTimer(messageId);
      clearMessageVisibilityTimer(messageId);
      if (hiddenDisappearingMessageIds.delete(String(messageId))) persistHiddenDisappearingMessageIds();
      const row = document.querySelector('[data-msg-id="' + messageId + '"]');
      if (row) {
        readObserver?.unobserve(row);
        revokeBlobUrlsIn(row);
        row.remove();
        reconcileTranscriptStructure(messagesArea(), currentGroupId);
      }
      pendingReadMessageIds.delete(messageId);
      for (const [groupId, cache] of groupDataCache.entries()) {
        const index = cache.messages ? cache.messages.findIndex((msg) => msg.id === messageId) : -1;
        if (index === -1) continue;
        cache.messages.splice(index, 1);
        if (historyDbSupported) void deleteHistoryMessage(groupId, messageId);
        if (groupId === currentGroupId && cache.messageRows) {
          cache.messageRows = cache.messageRows.filter((msgRow) => msgRow?.dataset?.msgId !== messageId);
        } else {
          cache.rowsDirty = true;
        }
        if (cache.channelRows) {
          for (const memo of Object.values(cache.channelRows)) {
            const removed = memo.rows.filter((row2) => row2?.dataset?.msgId !== String(messageId));
            if (removed.length !== memo.rows.length) {
              memo.rows = removed;
              memo.byId.delete(String(messageId));
              memo.firstMsgId = memo.rows.length ? memo.rows[0].dataset?.msgId || null : null;
              memo.lastMsgId = memo.rows.length ? memo.rows[memo.rows.length - 1].dataset?.msgId || null : null;
            }
          }
        }
        cache.oldestMessageId = cache.messages.length ? cache.messages[0].id : null;
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
    socket.on("message_edited", async (updated) => {
      const messageId = updated.id || updated.messageId;
      const { encryptedContent, iv, editedAt, revision } = updated;
      const row = document.querySelector('[data-msg-id="' + messageId + '"]');
      if (row) {
        const bubble = row.querySelector(".msg-bubble");
        const textEl = row.querySelector(".msg-text");
        if (bubble && textEl) {
          bubble.dataset.encContent = encryptedContent;
          bubble.dataset.iv = iv;
          const key = currentGroupId ? getGroupKey(currentGroupId) : null;
          if (key) {
            const pt = await decryptMessageText(updated, key, currentGroupId).catch(() => null);
            textEl.textContent = pt !== null ? pt : MSG_CONTENT_UNAVAILABLE;
          } else {
            textEl.textContent = MSG_CONTENT_UNAVAILABLE;
          }
          if (!bubble.querySelector(".msg-edited-badge")) {
            const badge = document.createElement("span");
            badge.className = "msg-edited-badge";
            badge.textContent = " (edited)";
            const textEl2 = bubble.querySelector(".msg-text");
            if (textEl2 && textEl2.parentNode) textEl2.after(badge);
            else bubble.appendChild(badge);
          }
        }
      }
      for (const [groupId, cache] of groupDataCache.entries()) {
        const stored = cache.messages ? cache.messages.find((msg) => msg.id === messageId) : null;
        if (!stored) continue;
        stored.encryptedContent = encryptedContent;
        stored.iv = iv;
        stored.encryptedMetadata = updated.encryptedMetadata ?? stored.encryptedMetadata;
        stored.metadataIv = updated.metadataIv ?? stored.metadataIv;
        if (updated.tagIndex !== void 0) stored.tagIndex = updated.tagIndex;
        stored.editedAt = editedAt;
        stored.revision = revision;
        delete stored._decryptedText;
        delete stored.hashtag;
        if (groupId !== currentGroupId) cache.rowsDirty = true;
        if (groupId === currentGroupId) allMessages = cache.messages;
        writeLocalGroupCache(groupId, cache);
        if (historyDbSupported) void persistHistoryMessages(groupId, [stored]);
        break;
      }
    });
    socket.on("chat_cleared", ({ groupId }) => {
      const cache = ensureGroupCacheEntry(groupId);
      for (const msg of cache.messages || []) {
        clearDisappearingTimer(msg.id);
        clearMessageVisibilityTimer(msg.id);
        hiddenDisappearingMessageIds.delete(String(msg.id));
      }
      persistHiddenDisappearingMessageIds();
      cache.messages = [];
      cache.messageRows = [];
      cache.channelRows = null;
      cache.channelAnchors = null;
      cache.members = cache.members || [];
      cache.oldestMessageId = null;
      cache.rowsDirty = false;
      unreadCounts[String(groupId)] = 0;
      updateUnreadBadge(String(groupId), 0);
      if (String(groupId) === String(currentGroupId)) {
        channelUnreadCounts = {};
        channelUnreadLoadedForGroup = null;
        channelUnreadTagIndexByTopic = /* @__PURE__ */ new Map();
        channelUnreadTopicByTagIndex = /* @__PURE__ */ new Map();
      }
      writeLocalGroupCache(groupId, cache);
      if (historyDbSupported) void clearGroupHistoryStore(groupId);
      if (groupId !== currentGroupId) return;
      renderGroupFromCache(groupId);
      renderTagFilters();
      addSystemMessage("Chat history was cleared");
    });
    socket.on("tag_cleared", async ({ groupId, tagIndex }) => {
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
      if (cache.channelRows && removedTopic) delete cache.channelRows[removedTopic];
      if (String(groupId) === String(currentGroupId) && channelUnreadLoadedForGroup === String(groupId)) {
        channelUnreadCounts[String(tagIndex || "")] = 0;
      }
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
    socket.on("group_renamed", ({ groupId, newName }) => {
      const g = groups.find((x) => x.id === groupId);
      if (g) g.name = newName;
      if (groupId === currentGroupId) {
        $("chat-group-name").textContent = newName;
        $("edit-group-name-input").value = newName;
        syncRightPanelMobileTitle();
      }
      renderGroupList();
    });
    socket.on("group_settings_updated", ({ groupId, allowMemberClear, allowMemberClearTag, allowMemberExport, allowMemberKick, allowMemberInvite, aiEnabled, groupColor, groupIcon }) => {
      const group = groups.find((g) => g.id === groupId);
      if (group) {
        if (allowMemberClear !== void 0) group.allowMemberClear = !!allowMemberClear;
        if (allowMemberClearTag !== void 0) group.allowMemberClearTag = !!allowMemberClearTag;
        if (allowMemberExport !== void 0) group.allowMemberExport = !!allowMemberExport;
        if (allowMemberKick !== void 0) group.allowMemberKick = !!allowMemberKick;
        if (allowMemberInvite !== void 0) group.allowMemberInvite = !!allowMemberInvite;
        if (aiEnabled !== void 0) group.aiEnabled = !!aiEnabled;
        if (groupColor !== void 0) group.groupColor = groupColor || null;
        if (groupIcon !== void 0) group.groupIcon = groupIcon || null;
      }
      const cache = ensureGroupCacheEntry(groupId);
      if (cache && cache.messages) cache.rowsDirty = true;
      if (groupId !== currentGroupId) {
        renderGroupList();
        return;
      }
      if (currentGroupData) {
        if (allowMemberClear !== void 0) currentGroupData.allowMemberClear = !!allowMemberClear;
        if (allowMemberClearTag !== void 0) currentGroupData.allowMemberClearTag = !!allowMemberClearTag;
        if (allowMemberExport !== void 0) currentGroupData.allowMemberExport = !!allowMemberExport;
        if (allowMemberKick !== void 0) currentGroupData.allowMemberKick = !!allowMemberKick;
        if (allowMemberInvite !== void 0) currentGroupData.allowMemberInvite = !!allowMemberInvite;
        if (aiEnabled !== void 0) currentGroupData.aiEnabled = !!aiEnabled;
        if (groupColor !== void 0) currentGroupData.groupColor = groupColor || null;
        if (groupIcon !== void 0) currentGroupData.groupIcon = groupIcon || null;
      }
      const isOwner = currentGroupData && currentGroupData.createdBy === currentUser.id;
      if (canCurrentUserManageGroup()) {
        $("allow-member-clear-toggle").checked = !!currentGroupData.allowMemberClear;
        $("allow-member-clear-tag-toggle").checked = !!currentGroupData.allowMemberClearTag;
        $("allow-member-export-toggle").checked = !!currentGroupData.allowMemberExport;
        $("allow-member-kick-toggle").checked = !!currentGroupData.allowMemberKick;
        $("allow-member-invite-toggle").checked = currentGroupData.allowMemberInvite !== false;
        $("ai-mode-toggle").checked = !!currentGroupData.aiEnabled;
      }
      syncAllowMemberClearTagToggleState();
      syncGroupPermissionControls();
      updateGroupColorAction(canCurrentUserManageGroup());
      updateAiControls();
      updateGroupActionButtons(isOwner);
      renderMembersList();
      renderGroupList();
    });
    socket.on("group_owner_transferred", ({ groupId, createdBy }) => {
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
    socket.on("member_joined", ({ userId, username, iconColor, profilePicture, groupId }) => {
      const cache = ensureGroupCacheEntry(groupId);
      const isNewMember = !!(cache.members && !cache.members.find((m) => m.id === userId));
      if (isNewMember) {
        cache.members.push({ id: userId, username, iconColor, profilePicture: profilePicture || null, isAdministrator: false });
        writeLocalGroupCache(groupId, cache);
      }
      if (groupId === currentGroupId) {
        refreshVisibleDeliveryTicks();
      }
      if (groupId !== currentGroupId) return;
      addSystemMessage(username + " joined the group chat");
      members = cache.members || members;
      renderMembersList();
      renderWhisperPicker();
      $("chat-member-count").textContent = members.length + " member" + (members.length !== 1 ? "s" : "");
    });
    socket.on("group_invited", async (groupPayload) => {
      if (!groupPayload || !groupPayload.id || !groupPayload.secret || !currentUser) return;
      const normalizedGroupId = String(groupPayload.id);
      if (groups.some((group) => String(group.id) === normalizedGroupId)) return;
      groups.push({
        ...groupPayload,
        id: normalizedGroupId,
        _lastPreviewText: GROUP_PREVIEW_EMPTY_TEXT,
        _lastPreviewTime: ""
      });
      unreadCounts[normalizedGroupId] = 0;
      const entry = { groupId: normalizedGroupId, secret: groupPayload.secret, joinCode: groupPayload.joinCode || null };
      try {
        await keyVault.put(entry);
      } catch {
      }
      groupKeyVaultCache.set(normalizedGroupId, entry);
      if (socket) {
        socket.emit("join_room", normalizedGroupId);
        trackJoinedRoom(normalizedGroupId);
      }
      renderGroupList();
      syncUnreadIndicators();
      pushStatus.totalUnreadCount = getTotalUnreadCount();
      showToast(`You were invited to ${groupPayload.name || "a new chat"}`, "success");
    });
    socket.on("member_role_updated", ({ userId, groupId, isAdministrator }) => {
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
    socket.on("member_left", ({ userId, username, groupId }) => {
      const cache = ensureGroupCacheEntry(groupId);
      if (cache.members) {
        cache.members = cache.members.filter((member) => member.id !== userId);
        writeLocalGroupCache(groupId, cache);
      }
      if (groupId !== currentGroupId) return;
      addSystemMessage(username + " left the group");
      members = cache.members || members.filter((m) => m.id !== userId);
      renderMembersList();
      renderWhisperPicker();
      $("chat-member-count").textContent = members.length + " member" + (members.length !== 1 ? "s" : "");
      refreshVisibleDeliveryTicks();
    });
    socket.on("member_kicked", ({ userId, groupId }) => {
      if (userId === currentUser.id) {
        groups = groups.filter((g) => g.id !== groupId);
        delete unreadCounts[groupId];
        pushStatus.totalUnreadCount = syncUnreadIndicators();
        renderGroupList();
        if (groupId === currentGroupId) {
          currentGroupId = null;
          currentGroupData = null;
          $("chat-active").hidden = true;
          $("chat-empty").hidden = false;
          setMobileView("list");
        }
        return;
      }
      if (groupId !== currentGroupId) return;
      const m = members.find((x) => x.id === userId);
      if (m) addSystemMessage("\u{1F6AB} " + m.username + " was removed from the group");
      const cache = ensureGroupCacheEntry(groupId);
      if (cache.members) {
        cache.members = cache.members.filter((x) => x.id !== userId);
        writeLocalGroupCache(groupId, cache);
      }
      members = cache.members || members.filter((x) => x.id !== userId);
      renderMembersList();
      renderWhisperPicker();
      refreshVisibleDeliveryTicks();
    });
    socket.on("group_disbanded", ({ groupId }) => {
      groups = groups.filter((g) => g.id !== groupId);
      delete unreadCounts[groupId];
      pushStatus.totalUnreadCount = syncUnreadIndicators();
      renderGroupList();
      if (groupId === currentGroupId) {
        currentGroupId = null;
        currentGroupData = null;
        members = [];
        $("chat-active").hidden = true;
        $("chat-empty").hidden = false;
        $("right-panel-content").hidden = true;
        $("right-panel-empty").hidden = false;
        setMobileView("list");
        addSystemMessage("This group has been disbanded");
      }
    });
    socket.on("group_join_denied", async ({ groupId }) => {
      const normalizedGroupId = String(groupId || "");
      if (!normalizedGroupId) return;
      await loadGroups();
      if (currentGroupId !== normalizedGroupId) return;
      if (groups.some((group) => String(group.id) === normalizedGroupId)) return;
      currentGroupId = null;
      currentGroupData = null;
      members = [];
      $("chat-active").hidden = true;
      $("chat-empty").hidden = false;
      $("right-panel-content").hidden = true;
      $("right-panel-empty").hidden = false;
      renderMembersList();
      renderWhisperPicker();
      setMobileView("list");
    });
    socket.on("presence_update", ({ groupId, onlineUserIds }) => {
      if (groupId !== currentGroupId) return;
      onlineUsers = new Set(onlineUserIds);
      renderMembersList();
    });
    socket.on("channel_announced", ({ groupId, channel, action }) => {
      const topic = normalizeHashtagTopic(channel);
      if (!groupId || !topic || topic === DEFAULT_TAG_TOPIC) return;
      if (action === "remove") {
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
    socket.on("user_updated", (user) => {
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
      const m = members.find((x) => x.id === user.id);
      if (m) {
        m.username = user.username;
        m.iconColor = user.iconColor;
        m.profilePicture = user.profilePicture || null;
        renderMembersList();
      }
      if (user.id === currentUser.id) {
        currentUser = user;
        $("user-username").textContent = user.username;
        renderCurrentUserAvatar(user);
        syncProfilePictureModeUI();
        renderProfileAiUsage();
        updateAiControls();
      }
      document.querySelectorAll('.msg-row[data-sender-id="' + CSS.escape(String(user.id)) + '"]').forEach((row) => {
        const av = row.querySelector(".msg-avatar");
        if (av && user.username) renderAvatarElement(av, user);
        const nameEl = row.querySelector(".msg-sender-name");
        if (nameEl && user.username) nameEl.textContent = user.username;
      });
      if (!$("user-management-modal").hidden) void loadUserManagementSummary();
    });
    socket.on("user_deleted", ({ userId }) => {
      if (String(userId) === String(currentUser?.id)) {
        window.location.href = "index.html";
        return;
      }
      if (!$("user-management-modal").hidden) void loadUserManagementSummary();
    });
    socket.on("account_deleted", ({ userId }) => {
      if (String(userId) !== String(currentUser?.id)) return;
      window.location.href = "index.html";
    });
    socket.on("user_typing", ({ username }) => {
      $("typing-user").textContent = username;
      $("typing-indicator").classList.add("is-visible");
      clearTimeout(window._typingTimer);
      window._typingTimer = setTimeout(() => $("typing-indicator").classList.remove("is-visible"), 3e3);
    });
    socket.on("user_stop_typing", () => {
      $("typing-indicator").classList.remove("is-visible");
    });
    socket.on("error", ({ message }) => {
      pendingDisappearingStartMessageIds = /* @__PURE__ */ new Set();
      const msg = message || "An error occurred";
      if (/not a member of this group/i.test(msg)) {
        void recoverFromMembershipLoss();
        return;
      }
      showToast(msg, "error");
    });
  }
  async function recoverFromMembershipLoss() {
    const failedGroupId = currentGroupId;
    await loadGroups();
    if (!failedGroupId) return;
    if (groups.some((group) => String(group.id) === String(failedGroupId))) {
      showToast("Not a member of this group", "error");
      return;
    }
    if (String(currentGroupId) === String(failedGroupId)) {
      currentGroupId = null;
      currentGroupData = null;
      members = [];
      $("chat-active").hidden = true;
      $("chat-empty").hidden = false;
      $("right-panel-content").hidden = true;
      $("right-panel-empty").hidden = false;
      renderMembersList();
      renderWhisperPicker();
      setMobileView("list");
    }
    showToast("This chat is no longer available to you", "info");
  }
  function addSystemMessage(text) {
    const div = document.createElement("div");
    div.className = "msg-system";
    div.textContent = text;
    messagesArea().appendChild(div);
    scrollToBottom();
  }
  function setupEmojiPicker() {
    const emojis = ["\u{1F600}", "\u{1F602}", "\u{1F970}", "\u{1F60D}", "\u{1F60E}", "\u{1F929}", "\u{1F973}", "\u{1F62D}", "\u{1F624}", "\u{1F914}", "\u{1F60F}", "\u{1F607}", "\u{1F644}", "\u{1F634}", "\u{1F917}", "\u{1F97A}", "\u{1F631}", "\u{1F61C}", "\u{1F92A}", "\u{1F61D}", "\u{1F911}", "\u{1F608}", "\u{1F479}", "\u{1F480}", "\u{1F4A9}", "\u{1F47D}", "\u{1F47B}", "\u{1F47E}", "\u{1F648}", "\u{1F436}", "\u{1F431}", "\u{1F42D}", "\u{1F430}", "\u{1F98A}", "\u{1F43B}", "\u{1F43C}", "\u{1F428}", "\u{1F42F}", "\u{1F981}", "\u{1F42E}", "\u{1F437}", "\u{1F438}", "\u{1F419}", "\u{1F98B}", "\u{1F33A}", "\u{1F338}", "\u{1F34E}", "\u{1F355}", "\u{1F382}", "\u{1F389}", "\u{1F38A}", "\u{1F381}", "\u2764\uFE0F", "\u{1F9E1}", "\u{1F49B}", "\u{1F49A}", "\u{1F499}", "\u{1F49C}", "\u{1F5A4}", "\u{1F494}", "\u2728", "\u2B50", "\u{1F31F}", "\u{1F525}", "\u{1F4AB}", "\u{1F308}", "\u2600\uFE0F", "\u{1F319}", "\u2744\uFE0F", "\u{1F3B5}", "\u{1F3B6}", "\u{1F3C6}", "\u{1F451}", "\u{1F48E}", "\u{1F5DD}\uFE0F", "\u{1F511}", "\u{1F30D}", "\u{1F680}", "\u{1F3AD}", "\u{1F44B}", "\u{1F91D}", "\u{1F44D}", "\u{1F44E}", "\u{1F64F}", "\u{1F4AA}", "\u270C\uFE0F", "\u{1F91E}", "\u{1F91F}", "\u{1F446}", "\u{1F447}", "\u{1F448}", "\u{1F449}"];
    const picker = $("emoji-picker");
    for (const em of emojis) {
      const btn = document.createElement("button");
      btn.className = "emoji-btn-item";
      btn.textContent = em;
      btn.addEventListener("click", () => insertEmoji(em));
      picker.appendChild(btn);
    }
  }
  function insertEmoji(em) {
    const inp = $("message-input");
    const start = inp.selectionStart;
    const end = inp.selectionEnd;
    inp.value = inp.value.slice(0, start) + em + inp.value.slice(end);
    inp.selectionStart = inp.selectionEnd = start + em.length;
    inp.focus();
    autoResizeTextarea(inp);
    $("emoji-picker").hidden = true;
  }
  function setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      if (handleAiTonePickerKey(e)) return;
      if (e.key === "Escape") {
        document.querySelectorAll(".modal-overlay:not([hidden])").forEach((m) => {
          m.hidden = true;
        });
        $("ctx-menu").hidden = true;
        $("emoji-picker").hidden = true;
        cancelWhisperSelection();
        hideImageViewer();
        replyingTo = null;
        $("reply-preview-bar").hidden = true;
      }
    });
  }
  function autoResizeTextarea(el) {
    const keepBottomPinned = isMessagesPinnedToBottom();
    el.style.height = "auto";
    const isMobileLayout2 = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 768px)").matches;
    const maxH = Math.min(Math.floor(window.innerHeight * 0.4), isMobileLayout2 ? 220 : 180);
    el.style.height = Math.min(el.scrollHeight, maxH) + "px";
    if (keepBottomPinned) pinMessagesToBottom();
  }
  function updateMessageModeBtn() {
    const keepBottomPinned = isMessagesPinnedToBottom();
    const btn = $("whisper-mode-btn");
    const whisperActive = messageMode === "whisper";
    const disappearingActive = messageMode === "disappearing";
    const aiActive = messageMode === "ai";
    if (whisperActive) {
      setElementIcon(btn, "megaphone", { iconOnly: true, label: "Whisper message mode" });
      btn.classList.add("whisper-active");
      btn.classList.remove("disappearing-active", "ai-active");
      if (!whisperRecipients.length && whisperPickerMode == null) $("whisper-picker").hidden = true;
    } else if (disappearingActive) {
      setElementIcon(btn, "timer", { iconOnly: true, label: "Disappearing message mode" });
      btn.classList.remove("whisper-active", "ai-active");
      btn.classList.add("disappearing-active");
      hideWhisperPicker();
    } else if (aiActive) {
      setElementIcon(btn, "ai", { iconOnly: true, label: "AI mode \u2014 next message goes to GChat AI" });
      btn.classList.remove("whisper-active", "disappearing-active");
      btn.classList.add("ai-active");
      hideWhisperPicker();
    } else {
      setElementIcon(btn, "message-square", { iconOnly: true });
      btn.classList.remove("whisper-active", "disappearing-active", "ai-active");
      hideWhisperPicker();
    }
    const composer = $("message-input-bar");
    composer?.classList.toggle("whisper-mode-active", whisperActive);
    composer?.classList.toggle("disappearing-mode-active", disappearingActive);
    composer?.classList.toggle("ai-mode-active", aiActive);
    updateKeyState();
    syncWhisperPickerStatus();
    if (keepBottomPinned) pinMessagesToBottom();
  }
  function updateWhisperBtn() {
    updateMessageModeBtn();
  }
  async function kickMember(userId, username) {
    showConfirm("Kick Member", "Remove " + username + " from this group?", async () => {
      const res = await fetch("/api/groups/" + currentGroupId + "/members/" + userId, {
        method: "DELETE",
        headers: apiHeaders()
      });
      if (res.ok) {
        showToast("Kicked " + username, "success");
      } else {
        const d = await res.json().catch(() => ({}));
        showToast(d.error || "Failed to kick member", "error");
      }
    }, { destructive: true });
  }
  async function updateMemberAdministrator(member, isAdministrator) {
    if (!member || !currentGroupId) return;
    const action = isAdministrator ? "Promote" : "Demote";
    const description = isAdministrator ? `Give ${member.username} administrator access to group permissions and moderation?` : `Remove administrator access from ${member.username}?`;
    showConfirm(`${action} member`, description, async () => {
      const res = await fetch(`/api/groups/${currentGroupId}/members/${member.id}/administrator`, {
        method: "PATCH",
        headers: apiHeaders(),
        body: JSON.stringify({ isAdministrator })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.error || `Failed to ${action.toLowerCase()} member`, "error");
        return;
      }
      showToast(
        isAdministrator ? `${member.username} is now an administrator` : `${member.username} is now a group member`,
        "success"
      );
    });
  }
  var confirmCallback = null;
  function showConfirm(title, message, onConfirm, options = {}) {
    $("confirm-title").textContent = title;
    $("confirm-message").textContent = message;
    const okBtn = $("confirm-ok-btn");
    if (okBtn) okBtn.className = options.destructive ? "btn-danger" : "btn-primary";
    $("confirm-modal").hidden = false;
    confirmCallback = onConfirm;
  }
  var activeSearchTerm = "";
  var searchDebounceTimer = 0;
  var searchSessionId = 0;
  var searchAbortController = null;
  var searchHistoryExhausted = false;
  var searchReturnAnchor = null;
  var SEARCH_PAGE_LIMIT = 100;
  var SEARCH_AUTO_PAGE_BATCH = 5;
  function syncSearchClearButton() {
    const btn = $("clear-search-btn");
    const input = $("search-input");
    if (!btn) return;
    btn.hidden = !input || input.value.length === 0;
  }
  function clearActiveSearch({ restoreTranscript = true } = {}) {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = 0;
    }
    const hadSearch = !!activeSearchTerm;
    searchSessionId += 1;
    searchAbortController?.abort();
    searchAbortController = null;
    const input = $("search-input");
    if (input && input.value) input.value = "";
    activeSearchTerm = "";
    searchHistoryExhausted = false;
    syncSearchClearButton();
    $("search-results-count").textContent = "";
    syncSearchHistoryStatus();
    if (hadSearch && restoreTranscript && currentGroupId) {
      const anchor = searchReturnAnchor;
      searchReturnAnchor = null;
      void renderActiveChannelStream({ restoreScroll: false }).then(() => {
        if (anchor) restoreViewportAnchor(messagesArea(), anchor);
      });
    }
  }
  function reconcileTranscriptStructure(area = messagesArea(), groupId = currentGroupId) {
    if (!area || !groupId) return;
    for (const divider of area.querySelectorAll(":scope > .msg-date-divider")) divider.remove();
    const cache = ensureGroupCacheEntry(groupId);
    const byId = new Map((cache.messages || []).map((msg) => [String(msg.id), msg]));
    let previousMessage = null;
    let previousDay = "";
    for (const row of Array.from(area.querySelectorAll(":scope > .msg-row[data-msg-id]"))) {
      if (row.hidden) continue;
      const msg = byId.get(String(row.dataset.msgId));
      if (!msg) continue;
      const day = getLocalDayKey(msg.createdAt);
      if (day && day !== previousDay) area.insertBefore(createDateDivider(msg.createdAt), row);
      const continued = shouldContinueSeries(previousMessage, msg);
      row.classList.toggle("series-continued", continued);
      const header = row.querySelector(".msg-header");
      const identity = row.querySelector(".msg-avatar-identity");
      const continuationTime = row.querySelector(".msg-continuation-time");
      if (header) header.hidden = continued;
      if (identity) identity.hidden = continued;
      if (continuationTime) continuationTime.hidden = !continued;
      previousMessage = msg;
      previousDay = day;
    }
  }
  function syncSearchHistoryStatus(text = "") {
    const wrap = $("search-history-status");
    const label = $("search-history-status-text");
    const more = $("search-older-btn");
    if (!wrap || !label || !more) return;
    label.textContent = text;
    more.hidden = !activeSearchTerm || searchHistoryExhausted || !text;
    wrap.hidden = !activeSearchTerm || !text && more.hidden;
  }
  function applySearchVisibility() {
    const area = messagesArea();
    if (!area || !currentGroupId) return;
    const normalizedTerm = activeSearchTerm ? activeSearchTerm.toLowerCase() : "";
    for (const el of Array.from(area.children)) {
      if (el.classList.contains("msg-date-divider")) continue;
      if (!el.classList.contains("msg-row") && !el.classList.contains("msg-system")) continue;
      if (!normalizedTerm) {
        el.hidden = false;
        continue;
      }
      const textEl = el.querySelector(".msg-text");
      const content = textEl ? textEl.textContent : el.textContent;
      const match = (content || "").toLowerCase().includes(normalizedTerm);
      el.hidden = !match;
    }
    reconcileTranscriptStructure(area, currentGroupId);
    const count = normalizedTerm ? countVisibleChannelMessages() : 0;
    $("search-results-count").textContent = normalizedTerm ? count + " result" + (count !== 1 ? "s" : "") : "";
  }
  function highlightText(el, term) {
    el.textContent = el.textContent;
    if (!term) return;
    const text = el.textContent;
    const lc = text.toLowerCase();
    const tl = term.toLowerCase();
    el.textContent = "";
    let idx = 0;
    let found;
    while ((found = lc.indexOf(tl, idx)) !== -1) {
      if (found > idx) el.appendChild(document.createTextNode(text.slice(idx, found)));
      const mark = document.createElement("mark");
      mark.className = "search-highlight";
      mark.textContent = text.slice(found, found + term.length);
      el.appendChild(mark);
      idx = found + term.length;
    }
    if (idx < text.length) el.appendChild(document.createTextNode(text.slice(idx)));
  }
  async function getSearchableMessageText(msg, groupId) {
    if (!msg) return "";
    if (msg.type === "system") return String(msg.encryptedContent || "");
    if (msg.type === "image" || msg.type === "file") return String(msg.filename || "");
    if (msg._decryptedText != null) return String(msg._decryptedText);
    const key = getGroupKey(groupId);
    if (!key) return "";
    const plaintext = await decryptMessageText(msg, key, groupId).catch(() => null);
    if (plaintext != null) msg._decryptedText = plaintext;
    return plaintext == null ? "" : String(plaintext);
  }
  async function renderSearchMatches(matches, groupId, sessionId) {
    if (sessionId !== searchSessionId || String(groupId) !== String(currentGroupId)) return;
    const area = messagesArea();
    if (!area) return;
    const rows = await buildMessageRows(matches.slice(-CHANNEL_RENDER_WINDOW), groupId);
    if (sessionId !== searchSessionId || String(groupId) !== String(currentGroupId)) return;
    const fragment = document.createDocumentFragment();
    for (const row of rows) fragment.appendChild(row);
    area.replaceChildren(fragment);
    reconcileTranscriptStructure(area, groupId);
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "channel-empty-state search-empty-state";
      empty.textContent = "No matching messages";
      area.appendChild(empty);
    }
    area.scrollTop = 0;
    observeCurrentGroupRowsForRead();
  }
  async function searchMessages(term, { pageBatch = SEARCH_AUTO_PAGE_BATCH } = {}) {
    const nextTerm = term ? String(term).trim() : "";
    if (!nextTerm) {
      clearActiveSearch();
      return;
    }
    const startingSearch = !activeSearchTerm;
    activeSearchTerm = nextTerm;
    syncSearchClearButton();
    if (startingSearch) searchReturnAnchor = captureViewportAnchor(messagesArea());
    searchAbortController?.abort();
    const controller = new AbortController();
    searchAbortController = controller;
    const sessionId = ++searchSessionId;
    const groupId = currentGroupId;
    const channel = getActiveTagTopic();
    searchHistoryExhausted = false;
    syncSearchHistoryStatus("Searching cached and older messages\u2026");
    const cache = ensureGroupCacheEntry(groupId);
    let cursor = cache.messages?.length ? cache.messages[0].id : null;
    let fetchedRows = 0;
    let requests = 0;
    try {
      while (cursor && requests < pageBatch && !controller.signal.aborted) {
        const res = await fetch(
          `/api/groups/${groupId}/messages?before=${encodeURIComponent(cursor)}&limit=${SEARCH_PAGE_LIMIT}`,
          { cache: "no-store", signal: controller.signal }
        );
        if (!res.ok) throw new Error(`Search history request failed (${res.status})`);
        const raw = await res.json();
        requests += 1;
        fetchedRows += raw.length;
        if (!raw.length) {
          searchHistoryExhausted = true;
          break;
        }
        const visible = filterMessagesVisibleToCurrentUser(raw);
        await mapWithConcurrency(visible, 12, (msg) => hydrateMessageChannel(msg, groupId));
        mergeMessagesIntoCache(groupId, visible);
        cursor = raw[0].id;
        if (raw.length < SEARCH_PAGE_LIMIT) searchHistoryExhausted = true;
      }
      if (!cursor) searchHistoryExhausted = true;
      if (sessionId !== searchSessionId || controller.signal.aborted) return;
      const candidates = (ensureGroupCacheEntry(groupId).messages || []).filter((msg) => resolveMessageTagTopic(msg) === channel).filter((msg) => !isMessageHiddenForCurrentUser(msg));
      const texts = await mapWithConcurrency(candidates, 12, (msg) => getSearchableMessageText(msg, groupId));
      if (sessionId !== searchSessionId || controller.signal.aborted) return;
      const normalized = nextTerm.toLowerCase();
      const matches = candidates.filter((msg, index) => texts[index].toLowerCase().includes(normalized));
      await renderSearchMatches(matches, groupId, sessionId);
      if (sessionId !== searchSessionId) return;
      $("search-results-count").textContent = `${matches.length} result${matches.length === 1 ? "" : "s"}`;
      syncSearchHistoryStatus(
        searchHistoryExhausted ? `Searched all available history (${fetchedRows} older messages loaded).` : `Loaded ${fetchedRows} older messages in ${requests} bounded request${requests === 1 ? "" : "s"}.`
      );
      for (const row of messagesArea().querySelectorAll(".msg-row")) {
        if (row.dataset.searchHighlighted) continue;
        const textEl = row.querySelector(".msg-text");
        if (!textEl) continue;
        const markdownSource = textEl.dataset.markdownSource;
        if (markdownSource != null) renderMarkdown(textEl, markdownSource);
        else renderPlainText(textEl, textEl.textContent);
        highlightText(textEl, nextTerm);
        row.dataset.searchHighlighted = "1";
      }
    } catch (err) {
      if (err?.name === "AbortError" || sessionId !== searchSessionId) return;
      console.warn("Search history failed:", err);
      syncSearchHistoryStatus("Older history could not be loaded. Current cached results are unchanged.");
    }
  }
  async function exportChat() {
    const key = getGroupKey(currentGroupId);
    const lines = [];
    for (const msg of allMessages) {
      if (isDisappearingMessage(msg)) continue;
      const time = formatTime(msg.createdAt);
      let content = "";
      if (msg.type === "image") content = "[Image]";
      else if (msg.type === "file") content = "[File: " + (msg.filename || "") + "]";
      else if (key) {
        const pt = await decryptMessageText(msg, key, currentGroupId).catch(() => null);
        content = pt ?? MSG_CONTENT_UNAVAILABLE;
      } else {
        content = MSG_CONTENT_UNAVAILABLE;
      }
      let replyPrefix = "";
      const reply = msg.replyPreview || (() => {
        try {
          return msg.replyTo ? typeof msg.replyTo === "string" ? JSON.parse(msg.replyTo) : msg.replyTo : null;
        } catch {
          return null;
        }
      })();
      if (msg.replyToId || reply) {
        replyPrefix = "Replying to, " + (reply?.senderName || "original message") + ": " + (reply?.preview || "Original message unavailable") + " \u2014 ";
      }
      lines.push("[" + time + "] " + (msg.senderName || "Unknown") + ": " + replyPrefix + content);
    }
    if (!lines.length) {
      showToast("No messages to export", "info");
      return;
    }
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const gname = (currentGroupData ? currentGroupData.name : "chat").replace(/[^a-zA-Z0-9]/g, "-");
    a.href = url;
    a.download = "Gchat-" + gname + "-" + date + ".txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  async function loadAndRenderAiTones() {
    if (!aiFeatureEnabled) return;
    try {
      const res = await fetch("/api/ai/tones");
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      if (!data.tones || typeof data.tones !== "object") return;
      const tones = data.tones;
      const keys = Object.keys(tones);
      if (!keys.length) return;
      for (const key of keys) {
        if (tones[key] && typeof tones[key].label === "string") {
          AI_TONE_LABELS[key] = tones[key].label;
        }
      }
      for (const key of Object.keys(AI_TONE_LABELS)) {
        if (!tones[key]) delete AI_TONE_LABELS[key];
      }
      const select = $("ai-tone-select");
      if (!select) return;
      select.replaceChildren();
      for (const key of keys) {
        const label = tones[key] && tones[key].label || key.charAt(0).toUpperCase() + key.slice(1);
        const option = document.createElement("option");
        option.value = key;
        option.textContent = label;
        select.appendChild(option);
      }
      select.value = getSelectedAiTone();
    } catch {
    }
  }
  function readStoredAiTone() {
    try {
      const stored = String(localStorage.getItem(AI_TONE_STORAGE_KEY) || "").trim().toLowerCase();
      return AI_TONE_LABELS[stored] ? stored : DEFAULT_AI_TONE;
    } catch {
      return DEFAULT_AI_TONE;
    }
  }
  function writeStoredAiTone(tone) {
    const normalized = String(tone || "").trim().toLowerCase();
    if (!AI_TONE_LABELS[normalized]) return;
    try {
      localStorage.setItem(AI_TONE_STORAGE_KEY, normalized);
    } catch {
    }
  }
  function getSelectedAiTone() {
    const value = String(selectedAiTone || "").trim().toLowerCase();
    return AI_TONE_LABELS[value] ? value : DEFAULT_AI_TONE;
  }
  function isAiReadableMessage(msg) {
    return !!(msg && (msg.type === "text" || msg.type == null) && !(Array.isArray(msg.whisperTo) && msg.whisperTo.length) && !isDisappearingMessage(msg));
  }
  function normalizeAiToolChannel(value, fallbackChannel) {
    return normalizeHashtagTopic(value) || normalizeHashtagTopic(fallbackChannel) || DEFAULT_TAG_TOPIC;
  }
  function truncateAiToolResult(result) {
    let json = JSON.stringify(result);
    if (json.length <= AI_TOOL_RESULT_MAX_CHARS) return json;
    const kept = [];
    let used = 2;
    for (let i = (result.messages || []).length - 1; i >= 0; i -= 1) {
      const entryJson = JSON.stringify(result.messages[i]);
      if (used + entryJson.length + 2 > AI_TOOL_RESULT_MAX_CHARS) break;
      kept.unshift(result.messages[i]);
      used += entryJson.length + 2;
    }
    json = JSON.stringify({ ...result, messages: kept });
    return json.length <= AI_TOOL_RESULT_MAX_CHARS ? json : json.slice(0, AI_TOOL_RESULT_MAX_CHARS);
  }
  async function collectAiToolMessages(groupId) {
    const cache = ensureGroupCacheEntry(groupId);
    const localMessages = Array.isArray(cache.messages) ? cache.messages : [];
    const seen = /* @__PURE__ */ new Set();
    const combined = [];
    const pushUnique = (list) => {
      for (const m of list || []) {
        if (!m || seen.has(String(m.id))) continue;
        seen.add(String(m.id));
        combined.push(m);
      }
    };
    let historyMessages = [];
    try {
      historyMessages = await readHistoryMessages(groupId);
    } catch {
      historyMessages = [];
    }
    pushUnique(historyMessages);
    pushUnique(localMessages);
    return combined;
  }
  async function executeAiToolGetChannelHistory(input, options) {
    const groupId = options.groupId;
    const channel = normalizeAiToolChannel(input && input.channel, options.channel);
    const rawLimit = Number(input && input.limit);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(AI_CHANNEL_HISTORY_MAX_LIMIT, Math.round(rawLimit))) : AI_CHANNEL_HISTORY_DEFAULT_LIMIT;
    const before = typeof input?.before === "string" ? String(input.before).trim() : "";
    const combined = await collectAiToolMessages(groupId);
    const candidates = combined.filter((m) => isAiReadableMessage(m) && resolveMessageTagTopic(m) === channel).sort((a, b) => {
      const timeDiff = String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
      return timeDiff !== 0 ? timeDiff : String(a.id).localeCompare(String(b.id));
    });
    let window2 = candidates;
    if (before) {
      const beforeIndex = candidates.findIndex((m) => String(m.id) === before);
      if (beforeIndex >= 0) window2 = candidates.slice(0, beforeIndex);
    }
    const slice = window2.slice(-limit);
    const key = getGroupKey(groupId);
    const lines = [];
    for (const msg of slice) {
      const text = key ? await decryptMessageText(msg, key, groupId).catch(() => null) : null;
      if (!text) continue;
      const trimmed = String(text).trim();
      if (!trimmed) continue;
      lines.push({
        id: String(msg.id),
        createdAt: msg.createdAt || "",
        senderName: String(msg.senderName || "Unknown").slice(0, 64),
        content: trimmed.slice(0, 2e3)
      });
    }
    return truncateAiToolResult({
      channel,
      count: lines.length,
      oldestMessageId: slice.length ? String(slice[0].id) : null,
      newestMessageId: slice.length ? String(slice[slice.length - 1].id) : null,
      messages: lines
    });
  }
  async function executeAiToolGetChannelList(options) {
    const groupId = options.groupId;
    const combined = await collectAiToolMessages(groupId);
    const stats = /* @__PURE__ */ new Map();
    const knownTopics = /* @__PURE__ */ new Set();
    for (const topic of getKnownChannels(groupId)) knownTopics.add(topic);
    for (const m of combined) {
      if (!isAiReadableMessage(m)) continue;
      const topic = resolveMessageTagTopic(m);
      knownTopics.add(topic);
      const entry = stats.get(topic) || { messageCount: 0, lastMessageAt: "", senders: /* @__PURE__ */ new Set() };
      entry.messageCount += 1;
      if (!entry.lastMessageAt || String(m.createdAt || "") > entry.lastMessageAt) {
        entry.lastMessageAt = String(m.createdAt || "");
      }
      if (m.senderId) entry.senders.add(String(m.senderId));
      stats.set(topic, entry);
    }
    const channels = [];
    for (const topic of knownTopics) {
      const entry = stats.get(topic);
      channels.push({
        channel: topic,
        messageCount: entry ? entry.messageCount : 0,
        lastMessageAt: entry ? entry.lastMessageAt : "",
        participantCount: entry ? entry.senders.size : 0
      });
    }
    channels.sort((a, b) => {
      if (a.channel === DEFAULT_TAG_TOPIC) return -1;
      if (b.channel === DEFAULT_TAG_TOPIC) return 1;
      return String(b.lastMessageAt).localeCompare(String(a.lastMessageAt));
    });
    return truncateAiToolResult({ channels: channels.slice(0, AI_CHANNEL_LIST_MAX_CHANNELS) });
  }
  async function executeAiToolCall(toolCall, options) {
    const name = String(toolCall && toolCall.name ? toolCall.name : "").trim();
    let input = {};
    if (typeof toolCall?.input === "string") {
      try {
        input = JSON.parse(toolCall.input);
      } catch {
        input = {};
      }
    } else if (toolCall?.input && typeof toolCall.input === "object") {
      input = toolCall.input;
    }
    try {
      if (name === "get_channel_history") {
        return await executeAiToolGetChannelHistory(input, options);
      }
      if (name === "get_channel_list") {
        return await executeAiToolGetChannelList(options);
      }
      return JSON.stringify({ error: "Unknown AI tool" });
    } catch (err) {
      return JSON.stringify({ error: String(err && err.message ? err.message : "Tool execution failed") });
    }
  }
  function accumulateAiMeta(acc, meta) {
    if (!meta) return acc;
    if (!acc) return { ...meta, toolCalls: 0, toolRounds: 0 };
    const sum = (a, b) => roundAiTokenAmount((a || 0) + (b || 0));
    return {
      ...acc,
      model: meta.model || acc.model,
      promptTokens: sum(acc.promptTokens, meta.promptTokens),
      completionTokens: sum(acc.completionTokens, meta.completionTokens),
      totalTokens: sum(acc.totalTokens, meta.totalTokens),
      rawPromptTokens: sum(acc.rawPromptTokens, meta.rawPromptTokens),
      rawCompletionTokens: sum(acc.rawCompletionTokens, meta.rawCompletionTokens),
      rawTotalTokens: sum(acc.rawTotalTokens, meta.rawTotalTokens),
      estimatedCostUsd: acc.estimatedCostUsd != null && meta.estimatedCostUsd != null ? sum(acc.estimatedCostUsd, meta.estimatedCostUsd) : null,
      estimatedCostRmb: acc.estimatedCostRmb != null && meta.estimatedCostRmb != null ? sum(acc.estimatedCostRmb, meta.estimatedCostRmb) : null,
      toolCalls: 0,
      toolRounds: 0
    };
  }
  function formatDesktopUpdateStatus(status) {
    if (!status || typeof status !== "object") {
      return "Check for desktop updates when connected.";
    }
    if (status.state === "error") return status.error || "Update check failed.";
    if (status.message) return status.message;
    switch (status.state) {
      case "checking":
        return "Checking for updates\u2026";
      case "up-to-date":
        return "You are up to date.";
      case "available":
        return status.availableVersion ? `Update ${status.availableVersion} is available.` : "An update is available.";
      case "downloading":
        return Number.isFinite(status.percent) ? `Downloading\u2026 ${status.percent}%` : "Downloading update\u2026";
      case "ready":
        return "Update ready to install.";
      case "idle":
      default:
        return status.currentVersion ? `Version ${status.currentVersion}` : "Check for desktop updates when connected.";
    }
  }
  var desktopUpdateCheckTimeout = null;
  function renderDesktopUpdateStatus(status) {
    const row = $("desktop-update-row");
    const statusEl = $("desktop-update-status");
    const checkBtn = $("desktop-check-update-btn");
    const installBtn = $("desktop-install-update-btn");
    const releaseBtn = $("desktop-open-release-btn");
    if (!row || !statusEl) return;
    if (!window.electronAPI?.checkForUpdates) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    statusEl.textContent = formatDesktopUpdateStatus(status);
    statusEl.dataset.state = status?.state || "idle";
    if (desktopUpdateCheckTimeout) {
      clearTimeout(desktopUpdateCheckTimeout);
      desktopUpdateCheckTimeout = null;
    }
    if (status?.state === "checking" || status?.state === "downloading") {
      desktopUpdateCheckTimeout = setTimeout(() => {
        desktopUpdateCheckTimeout = null;
        if (document.visibilityState === "hidden") return;
        renderDesktopUpdateStatus({ state: "error", error: "Update check timed out. Try again." });
      }, 6e4);
    }
    if (checkBtn) {
      checkBtn.disabled = status?.state === "checking" || status?.state === "downloading";
    }
    if (installBtn) {
      const showInstall = status?.state === "available" || status?.state === "ready";
      installBtn.hidden = !showInstall;
      installBtn.disabled = status?.state === "downloading" || status?.state === "checking";
    }
    if (releaseBtn) {
      const showRelease = status?.state === "available" || status?.state === "ready" || status?.state === "error";
      releaseBtn.hidden = !showRelease;
    }
  }
  function bindDesktopUpdateUi() {
    const row = $("desktop-update-row");
    if (!row || !window.electronAPI?.checkForUpdates) {
      if (row) row.hidden = true;
      return;
    }
    row.hidden = false;
    renderDesktopUpdateStatus({ state: "idle" });
    if (typeof window.electronAPI.getUpdateStatus === "function") {
      void window.electronAPI.getUpdateStatus().then((status) => {
        renderDesktopUpdateStatus(status);
      }).catch(() => {
        renderDesktopUpdateStatus({ state: "idle" });
      });
    }
    if (typeof window.electronAPI.onUpdateStatus === "function") {
      window.electronAPI.onUpdateStatus((status) => {
        renderDesktopUpdateStatus(status);
      });
    }
    $("desktop-check-update-btn")?.addEventListener("click", async () => {
      renderDesktopUpdateStatus({ state: "checking", message: "Checking for updates\u2026" });
      try {
        const status = await window.electronAPI.checkForUpdates();
        renderDesktopUpdateStatus(status || { state: "error", error: "No response from updater." });
        if (status?.state === "up-to-date") {
          showToast("You are up to date", "success");
        } else if (status?.state === "available" || status?.state === "ready") {
          showToast(formatDesktopUpdateStatus(status), "success");
        } else if (status?.state === "error") {
          showToast(status.error || "Update check failed", "error");
        }
      } catch (error) {
        const message = error?.message || "Update check failed";
        renderDesktopUpdateStatus({ state: "error", error: message });
        showToast(message, "error");
      }
    });
    $("desktop-install-update-btn")?.addEventListener("click", async () => {
      try {
        const ok = await window.electronAPI.installUpdate?.();
        if (!ok) showToast("Install is not ready yet", "error");
      } catch (error) {
        showToast(error?.message || "Failed to install update", "error");
      }
    });
    $("desktop-open-release-btn")?.addEventListener("click", async () => {
      try {
        await window.electronAPI.openLatestRelease?.();
      } catch (error) {
        showToast(error?.message || "Could not open release page", "error");
      }
    });
  }
  function openProfileModal() {
    closeMobileActionMenu();
    void refreshAiUsageSummary();
    $("profile-username").value = currentUser.username;
    $("profile-color").value = currentUser.iconColor;
    $("profile-error").textContent = "";
    clearProfilePictureSelection();
    syncProfilePictureModeUI();
    updateProfileRemoveButton();
    const colorInput = $("profile-color");
    const swatch = $("profile-color-swatch");
    const value = $("profile-color-value");
    if (colorInput && swatch) swatch.style.background = colorInput.value;
    if (colorInput && value) value.textContent = String(colorInput.value || "").toUpperCase();
    renderProfileAiUsage();
    syncNotificationsToggle();
    if (window.electronAPI?.getUpdateStatus) {
      void window.electronAPI.getUpdateStatus().then(renderDesktopUpdateStatus).catch(() => {
      });
    } else {
      renderDesktopUpdateStatus(null);
    }
    $("profile-modal").hidden = false;
  }
  async function logoutCurrentUser() {
    await fetch("/api/auth/logout", { method: "POST", headers: apiHeaders() });
    window.location.href = "index.html";
  }
  async function requestAiResponse(groupId, options = {}) {
    const tone = options.tone || getSelectedAiTone();
    const channel = normalizeHashtagTopic(options.channel) || DEFAULT_TAG_TOPIC;
    const groupName = String(options.groupName || "");
    const prompt = String(options.prompt || "").trim();
    if (!prompt) throw new Error("AI prompt is required");
    const transcript = [{ role: "user", content: prompt }];
    let toolRounds = 0;
    let toolCallsTotal = 0;
    let accumulated = null;
    for (; ; ) {
      if (toolRounds > MAX_AI_TOOL_ROUNDS) {
        throw new Error("AI needed too many steps to answer");
      }
      const res = await fetch(`/api/groups/${groupId}/ai/chat`, {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({ groupName, prompt, tone, channel, transcript })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = String(data.error || "AI request failed");
        if (/daily AI token limit/i.test(message) || /global daily AI token limit/i.test(message)) {
          void refreshAiUsageSummary();
        }
        throw new Error(message);
      }
      accumulated = accumulateAiMeta(accumulated, normalizeAiMeta(data.aiMeta));
      if (data.status === "tool_calls" && Array.isArray(data.toolCalls) && data.toolCalls.length) {
        toolRounds += 1;
        toolCallsTotal += data.toolCalls.length;
        if (toolRounds > MAX_AI_TOOL_ROUNDS) {
          throw new Error("AI needed too many steps to answer");
        }
        transcript.push(data.assistantMessage || { role: "assistant", content: null, tool_calls: [] });
        const toolOptions = { groupId, channel, key: getGroupKey(groupId) };
        for (const toolCall of data.toolCalls) {
          const output = await executeAiToolCall(toolCall, toolOptions);
          transcript.push({
            role: "tool",
            tool_call_id: String(toolCall.id || ""),
            content: String(output || "")
          });
        }
        continue;
      }
      const answer = String(data.answer || "").trim();
      if (!answer) throw new Error("AI returned an empty response");
      const normalizedAnswer = answer.replace(/^\n+/, "");
      if (accumulated) {
        accumulated.toolCalls = toolCallsTotal;
        accumulated.toolRounds = toolRounds;
      }
      return {
        answer: normalizedAnswer,
        model: String(data.model || DEFAULT_AI_MODEL),
        aiMeta: accumulated,
        aiUsage: data.aiUsage || null
      };
    }
  }
  async function sendAiReplyInBackground(request) {
    if (aiRequestInFlight) return;
    aiRequestInFlight = true;
    try {
      const result = await requestAiResponse(request.groupId, {
        groupName: request.groupName,
        prompt: request.prompt,
        tone: request.tone,
        channel: request.channel,
        skipBusyUi: true
      });
      if (!result.answer) throw new Error("AI returned an empty response");
      if (result.aiUsage) setAiUsageSummary(result.aiUsage);
      const { encryptedContent, iv } = await encryptMessage(result.answer, request.key, request.groupId);
      if (estimateBase64Bytes(encryptedContent) > MAX_TEXT_MESSAGE_BYTES) {
        throw new Error("AI response is too large to send");
      }
      await emitSocketWithAck("send_ai_message", {
        groupId: request.groupId,
        encryptedContent,
        iv,
        replyTo: request.replyToData,
        hashtag: request.hashtag || null,
        aiMeta: result.aiMeta
      });
      showToast("AI reply sent", "success");
    } catch (err) {
      const message = String(err && err.message ? err.message : "AI request failed");
      if (/daily AI token limit/i.test(message) || /global daily AI token limit/i.test(message)) {
        void refreshAiUsageSummary();
      }
      showToast(message, "error");
    } finally {
      aiRequestInFlight = false;
    }
  }
  var AI_TONE_PICKER_TONES = [
    { tone: "casual", key: "1", icon: "smile", label: "Casual", className: "tone-casual" },
    { tone: "professional", key: "2", icon: "briefcase", label: "Professional", className: "tone-professional" },
    { tone: "playful", key: "3", icon: "sparkles", label: "Playful", className: "tone-playful" },
    { tone: "playful_gangster", key: "4", icon: "crown", label: "Playful Gangster", className: "tone-gangster" }
  ];
  var aiTonePickOpen = false;
  var aiTonePickResolver = null;
  var aiTonePickHighlighted = null;
  function populateAiTonePicker() {
    const grid = $("ai-tone-picker-grid");
    if (!grid || grid.childNodes.length) return;
    for (const entry of AI_TONE_PICKER_TONES) {
      const label = AI_TONE_LABELS[entry.tone] || entry.label;
      const box = document.createElement("button");
      box.type = "button";
      box.className = `ai-tone-box ${entry.className}`;
      box.dataset.tone = entry.tone;
      box.dataset.key = entry.key;
      box.title = `Send with ${label} tone (${entry.key})`;
      const icon = document.createElement("span");
      icon.className = "ai-tone-box-icon";
      icon.appendChild(createIcon(entry.icon));
      const text = document.createElement("span");
      text.className = "ai-tone-box-label";
      text.textContent = label;
      const badge = document.createElement("span");
      badge.className = "ai-tone-box-key";
      badge.textContent = entry.key;
      box.append(icon, text, badge);
      box.addEventListener("click", () => {
        resolveAiTonePick(entry.tone);
      });
      grid.appendChild(box);
    }
  }
  function resolveAiTonePick(tone) {
    if (!aiTonePickOpen) return;
    const resolver = aiTonePickResolver;
    aiTonePickOpen = false;
    aiTonePickResolver = null;
    aiTonePickHighlighted = null;
    const picker = $("ai-tone-picker");
    if (picker) picker.hidden = true;
    if (resolver) resolver(tone);
  }
  function cancelAiTonePick() {
    resolveAiTonePick(null);
  }
  function showAiTonePicker() {
    populateAiTonePicker();
    const picker = $("ai-tone-picker");
    if (!picker) return Promise.resolve(null);
    const current = getSelectedAiTone();
    aiTonePickHighlighted = AI_TONE_PICKER_TONES.some((entry) => entry.tone === current) ? current : AI_TONE_PICKER_TONES[0].tone;
    for (const box of picker.querySelectorAll(".ai-tone-box")) {
      box.classList.toggle("is-highlighted", box.dataset.tone === aiTonePickHighlighted);
    }
    picker.hidden = false;
    aiTonePickOpen = true;
    return new Promise((resolve) => {
      aiTonePickResolver = resolve;
    });
  }
  function handleAiTonePickerKey(event) {
    if (!aiTonePickOpen) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelAiTonePick();
      return true;
    }
    if (event.key === "Enter") {
      if (event.defaultPrevented) return false;
      event.preventDefault();
      event.stopPropagation();
      resolveAiTonePick(aiTonePickHighlighted || AI_TONE_PICKER_TONES[0].tone);
      return true;
    }
    const entry = AI_TONE_PICKER_TONES.find(
      (item) => item.key === event.key || item.tone === String(event.key || "").toLowerCase()
    );
    if (entry) {
      event.preventDefault();
      event.stopPropagation();
      resolveAiTonePick(entry.tone);
      return true;
    }
    return false;
  }
  async function sendAiPromptWithTonePicker(parsedMessage) {
    if (aiTonePickOpen) return;
    const tone = await showAiTonePicker();
    if (!tone) return;
    await sendAiPromptMessage(parsedMessage, tone);
  }
  async function sendAiPromptMessage(parsedMessage, tone = getSelectedAiTone()) {
    const groupId = currentGroupId;
    const groupName = currentGroupData?.name || "";
    const prompt = parsedMessage.text;
    const hashtag = parsedMessage.hashtag || null;
    const channel = hashtag || DEFAULT_TAG_TOPIC;
    const key = getGroupKey(groupId);
    if (!key) {
      showToast("Chat content is not ready yet", "error");
      return;
    }
    if (aiRequestInFlight) {
      showToast("An AI request is already in progress", "error");
      return;
    }
    try {
      let replyToData = null;
      if (replyingTo) {
        replyToData = JSON.stringify({
          id: replyingTo.id,
          senderName: replyingTo.senderName,
          preview: replyingTo.preview
        });
      }
      const messageId = crypto.randomUUID();
      const messageIdentity = {
        id: messageId,
        groupId,
        senderId: currentUser.id,
        type: "text",
        encryptionVersion: 2,
        keyVersion: 1,
        revision: 1
      };
      const metadata = {
        hashtag,
        replyPreview: replyingTo ? { senderName: replyingTo.senderName, preview: replyingTo.preview } : null
      };
      const encryptedPrompt = await encryptV2Message(prompt, metadata, messageIdentity, key);
      if (estimateBase64Bytes(encryptedPrompt.encryptedContent) > MAX_TEXT_MESSAGE_BYTES) {
        throw new Error("Message too large");
      }
      const tagIndex = hashtag && hashtag !== DEFAULT_TAG_TOPIC ? await blindIndex(hashtag, key, groupId, "tag-index") : null;
      await emitSocketWithAck("send_message", {
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
        aiMeta: { model: DEFAULT_AI_MODEL, mode: DEFAULT_AI_MODE, tone, webSearchEnabled: false }
      });
      resetComposerAfterSend();
      showToast("AI request sent", "success");
      void sendAiReplyInBackground({
        groupId,
        groupName,
        prompt,
        tone,
        channel,
        hashtag,
        replyToData,
        key
      });
    } catch (err) {
      console.error("AI prompt send failed:", err);
      showToast("Failed to send AI request", "error");
    }
  }
  async function openUserManagementModal() {
    closeMobileActionMenu();
    $("user-management-error").textContent = "";
    setUserManagementLoading();
    $("user-management-modal").hidden = false;
    await loadUserManagementSummary();
  }
  function setupEventListeners() {
    $("logout-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      await logoutCurrentUser();
    });
    $("wallpaper-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      resetWallpaperDraft();
      applyWallpaperFromSettings();
      $("wallpaper-modal").hidden = false;
    });
    $("wallpaper-close-btn").addEventListener("click", () => {
      $("wallpaper-modal").hidden = true;
      resetWallpaperDraft();
    });
    $("wallpaper-modal").addEventListener("click", (e) => {
      if (e.target !== $("wallpaper-modal")) return;
      $("wallpaper-modal").hidden = true;
      resetWallpaperDraft();
    });
    $("wallpaper-save-btn").addEventListener("click", saveWallpaperDraft);
    $("wallpaper-reset-btn").addEventListener("click", async () => {
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
        $("wallpaper-error").textContent = result.error || "Failed to reset wallpaper";
        return;
      }
      $("wallpaper-modal").hidden = true;
      resetWallpaperDraft();
      showToast(result.ok ? WALLPAPER_RESET_SUCCESS_MSG : WALLPAPER_RESET_SYNC_FAIL_MSG, result.ok ? "success" : "info");
    });
    $("wallpaper-input").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      $("wallpaper-error").textContent = "";
      wallpaperDraft = buildWallpaperDraft({ wallpaperDataUrl: null });
      resetWallpaperProgress();
      if (!isAllowedUploadImageType(file.type)) {
        $("wallpaper-error").textContent = "Please choose a JPEG, PNG, GIF, or WebP image";
        setWallpaperSaveState(false);
        return;
      }
      if (file.size > MAX_WALLPAPER_BYTES) {
        $("wallpaper-error").textContent = WALLPAPER_TOO_LARGE_MSG;
        setWallpaperSaveState(false);
        return;
      }
      setWallpaperSaveState(false);
      try {
        setWallpaperProgress(3, "Preparing wallpaper\u2026");
        const preparedFile = await prepareWallpaperFile(file);
        wallpaperDraft.wallpaperDataUrl = await readFileAsDataUrl(preparedFile, {
          onProgress: (event) => {
            if (!event.lengthComputable) return;
            const percent = Math.round(event.loaded / event.total * 100);
            setWallpaperProgress(percent, `Reading wallpaper\u2026 ${percent}%`);
          }
        });
        setWallpaperProgress(100, "Ready to save");
        applyWallpaperDraftPreview(wallpaperDraft.wallpaperDataUrl);
        setWallpaperSaveState(!wallpaperSettingsEqual(wallpaperDraft, appLocalSettings));
      } catch {
        wallpaperDraft.wallpaperDataUrl = null;
        $("wallpaper-error").textContent = WALLPAPER_READ_FAIL_MSG;
        resetWallpaperProgress();
        setWallpaperSaveState(false);
      }
    });
    $("wallpaper-blur-input").addEventListener("input", (e) => {
      const maxWallpaperBlur = wallpaperTheme ? wallpaperTheme.MAX_WALLPAPER_BLUR : 24;
      wallpaperDraft = buildWallpaperDraft({
        wallpaperBlur: clampInteger(e.target.value, DEFAULT_WALLPAPER_BLUR, maxWallpaperBlur, DEFAULT_WALLPAPER_BLUR)
      });
      applyWallpaperDraftPreview();
      setWallpaperSaveState(!wallpaperSettingsEqual(wallpaperDraft, appLocalSettings));
    });
    $("wallpaper-transparency-input").addEventListener("input", (e) => {
      wallpaperDraft = buildWallpaperDraft({
        wallpaperTransparency: clampInteger(e.target.value, 0, 100, DEFAULT_WALLPAPER_TRANSPARENCY)
      });
      applyWallpaperDraftPreview();
      setWallpaperSaveState(!wallpaperSettingsEqual(wallpaperDraft, appLocalSettings));
    });
    $("open-diagnostics-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openDiagnosticsModal();
    });
    $("conn-status").addEventListener("click", (event) => {
      if (event.target.closest("#open-diagnostics-btn")) return;
      openDiagnosticsModal();
    });
    $("reconnect-diagnostics-btn").addEventListener("click", openDiagnosticsModal);
    $("reconnect-now-btn").addEventListener("click", () => {
      manualReconnectSocket();
      void refreshDiagnosticsHealth();
    });
    $("update-reload-btn").addEventListener("click", () => {
      const banner = $("update-available-banner");
      if (banner) banner.hidden = true;
      hostedAppReloadPending = false;
      void reloadAppShell();
    });
    $("diagnostics-refresh-btn").addEventListener("click", () => {
      updateConnectionTransport();
      renderDiagnosticsPanel();
      void refreshDiagnosticsHealth();
    });
    $("diagnostics-reconnect-btn").addEventListener("click", () => {
      manualReconnectSocket();
      void refreshDiagnosticsHealth();
    });
    $("diagnostics-close-btn").addEventListener("click", closeDiagnosticsModal);
    $("diagnostics-close-footer-btn").addEventListener("click", closeDiagnosticsModal);
    $("diagnostics-modal").addEventListener("click", (e) => {
      if (e.target !== $("diagnostics-modal")) return;
      closeDiagnosticsModal();
    });
    const userListBtn = $("sidebar-user-list-btn");
    if (userListBtn) {
      userListBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await openUserManagementModal();
      });
    }
    $("channel-cancel-btn")?.addEventListener("click", closeChannelCreateModal);
    $("channel-confirm-btn")?.addEventListener("click", confirmChannelCreate);
    $("channel-modal")?.addEventListener("click", (e) => {
      if (e.target === $("channel-modal")) closeChannelCreateModal();
    });
    $("channel-name-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        confirmChannelCreate();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeChannelCreateModal();
      }
    });
    $("sidebar-mobile-actions-btn")?.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMobileActionMenu();
    });
    $("mobile-user-list-btn").addEventListener("click", async () => {
      closeMobileActionMenu();
      await openUserManagementModal();
    });
    $("mobile-diagnostics-btn").addEventListener("click", () => {
      closeMobileActionMenu();
      openDiagnosticsModal();
    });
    $("mobile-bottom-profile-btn").addEventListener("click", () => {
      openProfileModal();
    });
    $("mobile-bottom-logout-btn").addEventListener("click", async () => {
      await logoutCurrentUser();
    });
    document.addEventListener("click", (event) => {
      if (event.target.closest("#mobile-sidebar-actions-menu") || event.target.closest("#sidebar-mobile-actions-btn")) return;
      closeMobileActionMenu();
    });
    $("user-management-close-btn").addEventListener("click", () => {
      $("user-management-modal").hidden = true;
    });
    $("user-management-modal").addEventListener("click", (e) => {
      if (e.target !== $("user-management-modal")) return;
      $("user-management-modal").hidden = true;
    });
    $("user-management-global-limit-save").addEventListener("click", async () => {
      const res = await fetch("/api/ai/global-limit", {
        method: "PATCH",
        headers: apiHeaders(),
        body: JSON.stringify({ dailyLimit: $("user-management-global-limit-input").value })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        $("user-management-error").textContent = data.error || "Failed to save global limit";
        return;
      }
      await Promise.all([loadUserManagementSummary(), refreshAiUsageSummary()]);
    });
    $("sidebar-user-btn").addEventListener("click", openProfileModal);
    $("profile-close-btn").addEventListener("click", () => $("profile-modal").hidden = true);
    bindNotificationsToggle();
    bindDesktopUpdateUi();
    document.querySelectorAll(".modal-overlay").forEach((modal) => {
      modal.addEventListener("click", (event) => {
        if (event.target !== modal) return;
        if (modal.id === "channel-modal") {
          closeChannelCreateModal();
        } else {
          modal.hidden = true;
        }
      });
    });
    $("profile-save-username").addEventListener("click", async () => {
      const username = $("profile-username").value.trim();
      if (!username) return;
      const res = await fetch("/api/auth/profile", {
        method: "PATCH",
        headers: apiHeaders(),
        body: JSON.stringify({ username })
      });
      const d = await res.json();
      if (!res.ok) {
        $("profile-error").textContent = d.error || "Failed";
        return;
      }
      currentUser = d;
      $("user-username").textContent = d.username;
      renderCurrentUserAvatar(d);
      syncProfilePictureModeUI();
      updateAiControls();
      if (!$("user-management-modal").hidden) void loadUserManagementSummary();
      $("profile-error").textContent = "\u2713 Saved";
    });
    $("profile-save-color").addEventListener("click", async () => {
      const iconColor = $("profile-color").value;
      const res = await fetch("/api/auth/profile", {
        method: "PATCH",
        headers: apiHeaders(),
        body: JSON.stringify({ iconColor })
      });
      const d = await res.json();
      if (!res.ok) {
        $("profile-error").textContent = d.error || "Failed";
        return;
      }
      currentUser = d;
      renderCurrentUserAvatar(d);
      syncProfilePictureModeUI();
      if (!$("user-management-modal").hidden) void loadUserManagementSummary();
      $("profile-error").textContent = "\u2713 Saved";
    });
    $("profile-picture-mode-slider")?.addEventListener("input", () => {
      setProfilePictureMode($("profile-picture-mode-slider").value === "1" ? "image" : "color");
    });
    $("profile-mode-color-label")?.addEventListener("click", () => {
      setProfilePictureMode("color");
    });
    $("profile-mode-image-label")?.addEventListener("click", () => {
      setProfilePictureMode("image");
    });
    const syncProfileColorUi = () => {
      const colorInput = $("profile-color");
      const swatch = $("profile-color-swatch");
      const value = $("profile-color-value");
      if (!colorInput) return;
      const hex = String(colorInput.value || "#4A90D9").toUpperCase();
      if (swatch) swatch.style.background = hex;
      if (value) value.textContent = hex;
    };
    $("profile-color")?.addEventListener("input", syncProfileColorUi);
    syncProfileColorUi();
    $("profile-picture-pick-btn")?.addEventListener("click", () => {
      $("profile-picture-input")?.click();
    });
    $("profile-picture-input")?.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      const nameEl = $("profile-picture-file-name");
      const preview = $("profile-picture-preview");
      const img = $("profile-picture-preview-img");
      if (!file) {
        if (nameEl) nameEl.textContent = "Max 2MB";
        if (preview) preview.hidden = true;
        if (img) img.removeAttribute("src");
        $("profile-save-picture").disabled = true;
        setUploadProgress("profile-picture-progress", "profile-picture-progress-label", { visible: false });
        return;
      }
      if (nameEl) nameEl.textContent = file.name;
      $("profile-save-picture").disabled = true;
      if (!isAllowedUploadImageType(file.type)) {
        $("profile-error").textContent = "Only JPEG, PNG, GIF, and WebP images are supported";
        if (preview) preview.hidden = true;
        setUploadProgress("profile-picture-progress", "profile-picture-progress-label", { visible: false });
        return;
      }
      if (file.size > MAX_PROFILE_PICTURE_BYTES) {
        $("profile-error").textContent = PROFILE_PICTURE_TOO_LARGE_MSG;
        if (preview) preview.hidden = true;
        setUploadProgress("profile-picture-progress", "profile-picture-progress-label", { visible: false });
        return;
      }
      $("profile-error").textContent = "";
      setUploadProgress("profile-picture-progress", "profile-picture-progress-label", {
        visible: true,
        label: "Preparing preview\u2026"
      });
      const reader = new FileReader();
      reader.onerror = () => {
        $("profile-error").textContent = "Failed to read the selected image. Please try a different file.";
        if (preview) preview.hidden = true;
        $("profile-save-picture").disabled = true;
        setUploadProgress("profile-picture-progress", "profile-picture-progress-label", { visible: false });
      };
      reader.onload = (ev) => {
        if (!img || !preview) return;
        img.src = ev.target.result;
        preview.hidden = false;
        $("profile-save-picture").disabled = false;
        setUploadProgress("profile-picture-progress", "profile-picture-progress-label", { visible: false });
      };
      reader.readAsDataURL(file);
    });
    $("profile-save-picture").addEventListener("click", async () => {
      const saveButton = $("profile-save-picture");
      if (saveButton.disabled) return;
      const file = $("profile-picture-input").files[0];
      if (!file) {
        $("profile-error").textContent = "Please select an image";
        return;
      }
      if (!isAllowedUploadImageType(file.type)) {
        $("profile-error").textContent = "Only JPEG, PNG, GIF, and WebP images are supported";
        return;
      }
      if (file.size > MAX_PROFILE_PICTURE_BYTES) {
        $("profile-error").textContent = PROFILE_PICTURE_TOO_LARGE_MSG;
        return;
      }
      setButtonBusy(saveButton, true, "Uploading\u2026", "Save");
      setUploadProgress("profile-picture-progress", "profile-picture-progress-label", {
        visible: true,
        label: "Uploading image\u2026"
      });
      try {
        const profilePicture = await readFileAsDataURL(file);
        const res = await fetch("/api/auth/profile", {
          method: "PATCH",
          headers: apiHeaders(),
          body: JSON.stringify({ profilePicture })
        });
        const d = await res.json();
        if (!res.ok) {
          $("profile-error").textContent = d.error || "Failed";
          return;
        }
        currentUser = d;
        renderCurrentUserAvatar(d);
        clearProfilePictureSelection();
        syncProfilePictureModeUI();
        updateProfileRemoveButton();
        if (!$("user-management-modal").hidden) void loadUserManagementSummary();
        $("profile-error").textContent = "\u2713 Saved";
      } catch {
        $("profile-error").textContent = "Could not upload the image. Check your connection and try again.";
      } finally {
        setUploadProgress("profile-picture-progress", "profile-picture-progress-label", { visible: false });
        setButtonBusy(saveButton, false, "Uploading\u2026", "Save");
        saveButton.disabled = !$("profile-picture-input").files[0];
      }
    });
    $("profile-remove-picture").addEventListener("click", async () => {
      const res = await fetch("/api/auth/profile", {
        method: "PATCH",
        headers: apiHeaders(),
        body: JSON.stringify({ profilePicture: null })
      });
      const d = await res.json();
      if (!res.ok) {
        $("profile-error").textContent = d.error || "Failed";
        return;
      }
      currentUser = d;
      renderCurrentUserAvatar(d);
      clearProfilePictureSelection();
      syncProfilePictureModeUI();
      updateProfileRemoveButton();
      if (!$("user-management-modal").hidden) void loadUserManagementSummary();
      $("profile-error").textContent = "\u2713 Removed";
    });
    $("profile-delete-btn").addEventListener("click", () => {
      showConfirm("Delete Account", "Permanently delete your account? This cannot be undone.", async () => {
        $("profile-modal").hidden = true;
        const res = await fetch("/api/auth/account", { method: "DELETE", headers: apiHeaders() });
        if (res.ok) window.location.href = "index.html";
      }, { destructive: true });
    });
    $("new-group-btn").addEventListener("click", () => {
      $("create-group-name").value = "";
      $("create-error").textContent = "";
      $("create-modal").hidden = false;
    });
    $("create-cancel-btn").addEventListener("click", () => $("create-modal").hidden = true);
    $("create-confirm-btn").addEventListener("click", async () => {
      const name = $("create-group-name").value.trim();
      $("create-error").textContent = "";
      if (!name) {
        $("create-error").textContent = "Group name is required";
        return;
      }
      const secret = generateGroupSecret();
      const keyCommitment2 = await keyCommitment(secret);
      let code = "";
      let res;
      let d;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        code = generateInviteCode();
        res = await fetch("/api/groups/create", {
          method: "POST",
          headers: apiHeaders(),
          body: JSON.stringify({ name, code, secret, keyCommitment: keyCommitment2 })
        });
        d = await res.json();
        if (res.ok || res.status !== 409 || d.error !== "Group code already in use") break;
      }
      if (!res.ok) {
        $("create-error").textContent = d.error || "Failed";
        return;
      }
      const vaultEntry = { groupId: d.id, secret, joinCode: code };
      await keyVault.put(vaultEntry);
      groupKeyVaultCache.set(String(d.id), vaultEntry);
      $("create-modal").hidden = true;
      groups.unshift(d);
      unreadCounts[d.id] = Math.max(0, Number(d.unreadCount) || 0);
      renderGroupList();
      syncUnreadIndicators();
      await selectGroup(d.id);
      addSystemMessage('Group "' + d.name + '" created.');
      const copied = await copyTextToClipboard(code);
      showToast(copied ? "Invite code copied" : "Could not copy invite code", copied ? "info" : "error");
    });
    $("join-group-btn").addEventListener("click", () => {
      $("join-group-code").value = "";
      $("join-error").textContent = "";
      $("join-modal").hidden = false;
    });
    $("join-cancel-btn").addEventListener("click", () => $("join-modal").hidden = true);
    $("clear-cache-btn").addEventListener("click", () => {
      showConfirm(
        "Clear Cache and Restart",
        "This will reset local GChat data and restart the app. Your login session and local user settings will be kept. Continue?",
        async () => {
          await clearCacheAndRestartApp();
        },
        { destructive: true }
      );
    });
    let joinGroupInFlight = false;
    $("join-confirm-btn").addEventListener("click", async () => {
      if (joinGroupInFlight) return;
      const inviteInput = $("join-group-code").value.trim();
      $("join-error").textContent = "";
      if (!inviteInput) {
        $("join-error").textContent = "Enter an invite code";
        return;
      }
      const code = inviteInput.toLowerCase();
      joinGroupInFlight = true;
      setButtonBusy($("join-confirm-btn"), true, "Joining\u2026", "Join");
      try {
        const res = await fetch("/api/groups/join", {
          method: "POST",
          headers: apiHeaders(),
          body: JSON.stringify({ code })
        });
        const d = await res.json();
        if (!res.ok) {
          $("join-error").textContent = d.error || "Failed";
          return;
        }
        const commitment = await keyCommitment(d.secret);
        if (commitment !== d.keyCommitment) {
          $("join-error").textContent = "This invite code returned the wrong encryption key";
          return;
        }
        const vaultEntry = { groupId: d.id, secret: d.secret, joinCode: code };
        await keyVault.put(vaultEntry);
        groupKeyVaultCache.set(String(d.id), vaultEntry);
        $("join-modal").hidden = true;
        if (!groups.find((g) => g.id === d.id)) {
          groups.unshift(d);
          unreadCounts[d.id] = Math.max(0, Number(d.unreadCount) || 0);
          renderGroupList();
          syncUnreadIndicators();
        }
        await selectGroup(d.id);
        addSystemMessage(d.alreadyJoined ? `You are already a member of "${d.name}".` : `You joined "${d.name}".`);
      } catch {
        $("join-error").textContent = "Could not join the group. Check your connection and try again.";
      } finally {
        joinGroupInFlight = false;
        setButtonBusy($("join-confirm-btn"), false, "Joining\u2026", "Join");
      }
    });
    $("copy-code-btn").addEventListener("click", async () => {
      if (!currentGroupData) return;
      let entry = groupKeyVaultCache.get(String(currentGroupData.id));
      if (!entry?.secret) {
        await loadGroupKeyVaultEntries();
        entry = groupKeyVaultCache.get(String(currentGroupData.id));
      }
      if (!entry?.joinCode) {
        showToast("Invite code is not ready yet", "error");
        return;
      }
      if (!await copyTextToClipboard(entry.joinCode)) {
        showToast("Could not copy invite code", "error");
        return;
      }
      setElementIcon($("copy-code-btn"), "check", { label: "Copied" });
      setTimeout(() => setElementIcon($("copy-code-btn"), "key-round", { label: "Invite" }), 1500);
    });
    let groupRenameInFlight = false;
    const saveGroupName = async () => {
      const name = $("edit-group-name-input").value.trim();
      if (!name || !currentGroupId || groupRenameInFlight) return;
      if (currentGroupData && name === currentGroupData.name) return;
      groupRenameInFlight = true;
      try {
        const res = await fetch("/api/groups/" + currentGroupId + "/name", {
          method: "PATCH",
          headers: apiHeaders(),
          body: JSON.stringify({ name })
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          showToast(d.error || "Failed to rename", "error");
          $("edit-group-name-input").value = currentGroupData ? currentGroupData.name : "";
        }
      } catch {
        showToast("Could not rename the group. Check your connection and try again.", "error");
        $("edit-group-name-input").value = currentGroupData ? currentGroupData.name : "";
      } finally {
        groupRenameInFlight = false;
      }
    };
    $("edit-group-name-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveGroupName();
      }
    });
    $("edit-group-name-input").addEventListener("blur", saveGroupName);
    let groupIconMode = "color";
    const syncGroupIconMode = (mode) => {
      groupIconMode = mode;
      const isImage = mode === "image";
      document.querySelector(".group-icon-mode-tabs")?.setAttribute("data-mode", isImage ? "image" : "color");
      $("group-icon-color-section").hidden = isImage;
      $("group-icon-image-section").hidden = !isImage;
      $("group-icon-mode-color").classList.toggle("active", !isImage);
      $("group-icon-mode-image").classList.toggle("active", isImage);
      $("group-icon-mode-color").setAttribute("aria-selected", String(!isImage));
      $("group-icon-mode-image").setAttribute("aria-selected", String(isImage));
      $("group-color-save-btn").disabled = isImage && !$("group-icon-input").files?.[0] && !currentGroupData?.groupIcon;
    };
    $("set-group-color-btn").addEventListener("click", () => {
      if (!currentGroupId || $("set-group-color-btn").disabled) return;
      $("group-color-input").value = currentGroupData && currentGroupData.groupColor || "#4a90d9";
      $("group-icon-input").value = "";
      $("group-icon-file-name").textContent = "JPEG, PNG, GIF, or WebP \xB7 max 2MB";
      $("group-icon-preview").hidden = true;
      setUploadProgress("group-icon-progress", "group-icon-progress-label", { visible: false });
      syncGroupIconMode(currentGroupData?.groupIcon ? "image" : "color");
      $("group-color-modal").hidden = false;
    });
    $("group-color-cancel-btn").addEventListener("click", () => {
      $("group-color-modal").hidden = true;
    });
    $("group-icon-mode-color").addEventListener("click", () => syncGroupIconMode("color"));
    $("group-icon-mode-image").addEventListener("click", () => syncGroupIconMode("image"));
    $("group-icon-pick-btn").addEventListener("click", () => $("group-icon-input").click());
    $("group-icon-input").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!isAllowedUploadImageType(file.type) || file.size > MAX_PROFILE_PICTURE_BYTES) {
        showToast(!isAllowedUploadImageType(file.type) ? "Only JPEG, PNG, GIF, and WebP images are supported" : PROFILE_PICTURE_TOO_LARGE_MSG, "error");
        event.target.value = "";
        $("group-color-save-btn").disabled = !currentGroupData?.groupIcon;
        return;
      }
      $("group-icon-file-name").textContent = file.name;
      $("group-color-save-btn").disabled = true;
      setUploadProgress("group-icon-progress", "group-icon-progress-label", {
        visible: true,
        label: "Preparing preview\u2026"
      });
      const reader = new FileReader();
      reader.onerror = () => {
        showToast("Failed to read the selected image. Please try a different file.", "error");
        event.target.value = "";
        $("group-icon-preview").hidden = true;
        $("group-color-save-btn").disabled = !currentGroupData?.groupIcon;
        setUploadProgress("group-icon-progress", "group-icon-progress-label", { visible: false });
      };
      reader.onload = () => {
        $("group-icon-preview-img").src = String(reader.result || "");
        $("group-icon-preview").hidden = false;
        $("group-color-save-btn").disabled = false;
        setUploadProgress("group-icon-progress", "group-icon-progress-label", { visible: false });
      };
      reader.readAsDataURL(file);
    });
    $("group-color-save-btn").addEventListener("click", async () => {
      const saveButton = $("group-color-save-btn");
      if (saveButton.disabled) return;
      setButtonBusy(saveButton, true, groupIconMode === "image" ? "Uploading\u2026" : "Saving\u2026", "Confirm");
      setUploadProgress("group-icon-progress", "group-icon-progress-label", {
        visible: true,
        label: groupIconMode === "image" ? "Uploading group icon\u2026" : "Saving icon color\u2026"
      });
      let payload;
      try {
        if (groupIconMode === "image") {
          const file = $("group-icon-input").files?.[0];
          if (!file) {
            if (currentGroupData?.groupIcon) payload = { groupIcon: currentGroupData.groupIcon };
            else {
              showToast("Choose an image for the group icon", "error");
              return;
            }
          } else {
            const groupIcon = await readFileAsDataURL(file);
            payload = { groupIcon };
          }
        } else {
          payload = { groupColor: $("group-color-input").value, groupIcon: null };
        }
        const res = await fetch("/api/groups/" + currentGroupId + "/settings", {
          method: "PATCH",
          headers: apiHeaders(),
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          showToast(d.error || "Failed to set group icon", "error");
          return;
        }
        $("group-color-modal").hidden = true;
      } catch {
        showToast("Could not upload the group icon. Check your connection and try again.", "error");
      } finally {
        setUploadProgress("group-icon-progress", "group-icon-progress-label", { visible: false });
        setButtonBusy(saveButton, false, "Uploading\u2026", "Confirm");
        saveButton.disabled = groupIconMode === "image" && !$("group-icon-input").files?.[0] && !currentGroupData?.groupIcon;
      }
    });
    $("clear-history-btn").addEventListener("click", () => {
      if ($("clear-history-btn").disabled) return;
      showConfirm(
        "Clear Chat History",
        "This will permanently delete all messages for everyone. Continue?",
        async () => {
          const res = await fetch("/api/groups/" + currentGroupId + "/messages", {
            method: "DELETE",
            headers: apiHeaders()
          });
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            showToast(d.error || "Failed", "error");
          }
        },
        { destructive: true }
      );
    });
    $("allow-member-clear-toggle").addEventListener("change", async (e) => {
      const nextChecked = e.target.checked;
      const result = await updateGroupSettingRequest({ allowMemberClear: nextChecked });
      if (!result.ok) {
        e.target.checked = !nextChecked;
        syncAllowMemberClearTagToggleState();
        showToast(result.error || "Failed to update group settings", "error");
        return;
      }
      if (currentGroupData) {
        currentGroupData.allowMemberClear = e.target.checked;
        if (e.target.checked) currentGroupData.allowMemberClearTag = true;
        syncAllowMemberClearTagToggleState();
        updateGroupActionButtons(currentGroupData.createdBy === currentUser.id);
      }
    });
    $("allow-member-clear-tag-toggle").addEventListener("change", async (e) => {
      const nextChecked = e.target.checked;
      const result = await updateGroupSettingRequest({ allowMemberClearTag: nextChecked });
      if (!result.ok) {
        e.target.checked = !nextChecked;
        syncAllowMemberClearTagToggleState();
        showToast(result.error || "Failed to update group settings", "error");
        return;
      }
      if (currentGroupData) {
        currentGroupData.allowMemberClearTag = nextChecked;
        syncAllowMemberClearTagToggleState();
        updateGroupActionButtons(currentGroupData.createdBy === currentUser.id);
      }
    });
    $("allow-member-export-toggle").addEventListener("change", async (e) => {
      const nextChecked = e.target.checked;
      const result = await updateGroupSettingRequest({ allowMemberExport: nextChecked });
      if (!result.ok) {
        e.target.checked = !nextChecked;
        showToast(result.error || "Failed to update group settings", "error");
        return;
      }
      if (currentGroupData) {
        currentGroupData.allowMemberExport = e.target.checked;
        updateGroupActionButtons(currentGroupData.createdBy === currentUser.id);
      }
    });
    $("allow-member-kick-toggle").addEventListener("change", async (e) => {
      const nextChecked = e.target.checked;
      const result = await updateGroupSettingRequest({ allowMemberKick: nextChecked });
      if (!result.ok) {
        e.target.checked = !nextChecked;
        showToast(result.error || "Failed to update group settings", "error");
        return;
      }
      if (currentGroupData) {
        currentGroupData.allowMemberKick = e.target.checked;
      }
    });
    $("allow-member-invite-toggle").addEventListener("change", async (e) => {
      const nextChecked = e.target.checked;
      const result = await updateGroupSettingRequest({ allowMemberInvite: nextChecked });
      if (!result.ok) {
        e.target.checked = !nextChecked;
        showToast(result.error || "Failed to update group settings", "error");
        return;
      }
      if (currentGroupData) {
        currentGroupData.allowMemberInvite = nextChecked;
      }
    });
    $("ai-mode-toggle").addEventListener("change", async (e) => {
      const nextChecked = e.target.checked;
      const result = await updateGroupSettingRequest({ aiEnabled: nextChecked });
      if (!result.ok) {
        e.target.checked = !nextChecked;
        showToast(result.error || "Failed to update group settings", "error");
        return;
      }
      if (currentGroupData) currentGroupData.aiEnabled = nextChecked;
      updateAiControls();
    });
    $("export-btn").addEventListener("click", () => {
      if ($("export-btn").disabled) return;
      exportChat();
    });
    $("disband-btn").addEventListener("click", () => {
      if ($("disband-btn").disabled) return;
      showConfirm("Disband Group", "Permanently disband this group and delete all messages?", async () => {
        const res = await fetch("/api/groups/" + currentGroupId, {
          method: "DELETE",
          headers: apiHeaders()
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          showToast(d.error || "Failed", "error");
        }
      }, { destructive: true });
    });
    $("leave-group-btn").addEventListener("click", () => {
      if ($("leave-group-btn").disabled) return;
      showConfirm("Leave Group", "Are you sure you want to leave this group?", async () => {
        const res = await fetch("/api/groups/" + currentGroupId + "/leave", {
          method: "DELETE",
          headers: apiHeaders()
        });
        if (res.ok) {
          delete unreadCounts[currentGroupId];
          groups = groups.filter((g) => g.id !== currentGroupId);
          pushStatus.totalUnreadCount = syncUnreadIndicators();
          renderGroupList();
          currentGroupId = null;
          currentGroupData = null;
          $("chat-active").hidden = true;
          $("chat-empty").hidden = false;
          $("right-panel-content").hidden = true;
          $("right-panel-empty").hidden = false;
          setMobileView("list");
          showToast("Left group", "success");
        } else {
          const d = await res.json().catch(() => ({}));
          showToast(d.error || "Failed", "error");
        }
      }, { destructive: true });
    });
    $("confirm-cancel-btn").addEventListener("click", () => {
      $("confirm-modal").hidden = true;
      confirmCallback = null;
    });
    $("confirm-ok-btn").addEventListener("click", () => {
      $("confirm-modal").hidden = true;
      if (confirmCallback) {
        confirmCallback();
        confirmCallback = null;
      }
    });
    $("ctx-reply").addEventListener("click", () => {
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
      } else if (msg.type === "image") {
        preview = "[image]";
      } else if (msg.type === "file") {
        preview = "[file: " + (msg.filename || "") + "]";
      } else {
        preview = MSG_CONTENT_UNAVAILABLE;
      }
      replyingTo = {
        id: msg.id,
        senderName: msg.senderName,
        preview
      };
      $("reply-preview-name").textContent = msg.senderName;
      $("reply-preview-text").textContent = truncate(replyingTo.preview, 80);
      $("reply-preview-bar").hidden = false;
      if (isAiAssistantMessage(msg) && canUseAiInCurrentGroup()) {
        messageMode = "ai";
        whisperRecipients = [];
        composerTokens.whisper = null;
        hideWhisperPicker();
        updateMessageModeBtn();
        showToast("Reply will be sent to GChat AI", "info");
      }
      $("message-input").focus();
    });
    $("ctx-edit").addEventListener("click", () => {
      if (!ctxMsg || ctxMsg.senderId !== currentUser?.id) return;
      const msg = ctxMsg;
      const text = ctxText;
      hideContextMenu();
      void startEditMessage(msg, text);
    });
    $("ctx-delete").addEventListener("click", () => {
      if (!ctxMsg) return;
      const isAuthor = ctxMsg.senderId === currentUser?.id;
      const isGlobal = isGlobalGroupId(ctxMsg.groupId || currentGroupId);
      if (!isAuthor && !isGlobal) return;
      const msg = ctxMsg;
      hideContextMenu();
      showConfirm("Delete message", "Delete this message for everyone? This cannot be undone.", async () => {
        const res = await fetch(`/api/groups/${msg.groupId || currentGroupId}/messages/${msg.id}`, {
          method: "DELETE",
          headers: apiHeaders()
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          showToast(data.error || "Delete failed", "error");
        }
      }, { destructive: true });
    });
    $("ctx-copy").addEventListener("click", () => {
      if (ctxText) {
        navigator.clipboard.writeText(ctxText).catch(() => {
        });
      }
      hideContextMenu();
    });
    $("ctx-download").addEventListener("click", () => {
      if (!ctxMsg || ctxMsg.type !== "image" && ctxMsg.type !== "file") return;
      downloadAttachment(ctxMsg);
      hideContextMenu();
    });
    $("tag-ctx-delete").addEventListener("click", () => {
      if (!ctxTagTopic) return;
      const topic = ctxTagTopic;
      hideTagContextMenu();
      if (topic === DEFAULT_TAG_TOPIC) {
        showToast("Cannot delete #main", "error");
        return;
      }
      const cache = ensureGroupCacheEntry(currentGroupId);
      const hasMessages = (cache.messages || []).some((msg) => resolveMessageTagTopic(msg) === topic);
      if (hasMessages && !canCurrentUserClearTag()) {
        showToast("You do not have permission to delete this channel", "error");
        return;
      }
      showConfirm(
        `Delete ${formatHashtagLabel(topic)}`,
        hasMessages ? `This will permanently delete every ${formatHashtagLabel(topic)} message for everyone. Continue?` : `Remove empty channel ${formatHashtagLabel(topic)}?`,
        async () => {
          await clearTagMessages(topic);
        },
        { destructive: true }
      );
    });
    $("avatar-ctx-invite").addEventListener("click", () => {
      openInviteModal();
    });
    $("invite-close-btn").addEventListener("click", () => {
      $("invite-modal").hidden = true;
    });
    $("invite-modal").addEventListener("click", (e) => {
      if (e.target === $("invite-modal")) $("invite-modal").hidden = true;
    });
    document.addEventListener("contextmenu", (event) => {
      const avatar = event.target.closest(".msg-avatar, .member-avatar");
      if (!avatar) return;
      if (event.target.closest("time")) return;
      const row = avatar.closest(".msg-row, .member-item");
      if (!row) return;
      const userId = row.dataset.senderId || row.dataset.userId;
      if (!userId || !currentUser || String(userId) === String(currentUser.id)) return;
      if (String(userId) === AI_ASSISTANT_USER_ID) return;
      event.preventDefault();
      let username = "";
      const member = members.find((m) => String(m.id) === String(userId));
      if (member) {
        username = member.username;
      } else {
        const nameEl = row.querySelector(".msg-sender-name");
        if (nameEl) username = nameEl.textContent || "";
      }
      showAvatarContextMenu(event, userId, username || "this user");
    });
    document.addEventListener("click", (e) => {
      if (!$("ctx-menu").contains(e.target)) hideContextMenu();
      if (!$("tag-ctx-menu").contains(e.target)) hideTagContextMenu();
      if (!$("avatar-ctx-menu").contains(e.target)) hideAvatarContextMenu();
      if (!$("emoji-picker").contains(e.target) && e.target !== $("emoji-btn")) {
        $("emoji-picker").hidden = true;
      }
      const tonePicker = $("ai-tone-picker");
      if (tonePicker && !tonePicker.hidden && !tonePicker.contains(e.target) && !e.target.closest("#message-input-bar")) {
        cancelAiTonePick();
      }
      if (!$("whisper-picker").contains(e.target) && !$("whisper-mode-btn").contains(e.target) && e.target !== $("message-input")) {
        cancelWhisperSelection();
      }
    });
    $("reply-cancel-btn").addEventListener("click", () => {
      replyingTo = null;
      $("reply-preview-bar").hidden = true;
    });
    const msgInput = $("message-input");
    msgInput.addEventListener("input", () => {
      syncComposerTokens();
      autoResizeTextarea(msgInput);
      if (currentGroupId && socket) {
        socket.emit("typing", { groupId: currentGroupId });
        clearTimeout(window._myTypingTimer);
        window._myTypingTimer = setTimeout(() => {
          socket.emit("stop_typing", { groupId: currentGroupId });
        }, 1500);
      }
    });
    msgInput.addEventListener("focus", () => {
      composerNearBottomBeforeFocus = isNearBottom();
      if (!isMobileLayout()) return;
      setTimeout(() => {
        syncAppViewportHeight();
        window.scrollTo(0, 0);
        if (composerNearBottomBeforeFocus) scrollToBottom(true);
      }, MOBILE_KEYBOARD_FOCUS_DELAY_MS);
    });
    const aiToneSelect = $("ai-tone-select");
    if (aiToneSelect) {
      aiToneSelect.addEventListener("change", () => {
        selectedAiTone = aiToneSelect.value;
        writeStoredAiTone(selectedAiTone);
      });
    }
    msgInput.addEventListener("blur", () => {
      clearTimeout(window._myTypingTimer);
      if (currentGroupId && socket) socket.emit("stop_typing", { groupId: currentGroupId });
      composerNearBottomBeforeFocus = true;
      syncAppViewportHeight();
    });
    msgInput.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && handleComposerBackspace(msgInput)) {
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        if (aiTonePickOpen) return;
        e.preventDefault();
        doSend(msgInput.value);
      }
    });
    $("send-btn").addEventListener("click", () => doSend(msgInput.value));
    $("file-input").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) {
        handleFileUpload(file);
        e.target.value = "";
      }
    });
    msgInput.addEventListener("paste", async (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (!files.length) return;
      e.preventDefault();
      if (files.length > 1) showToast(`Sending ${files.length} files\u2026`, "info");
      for (const file of files) {
        await handleFileUpload(file);
      }
    });
    $("emoji-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      $("emoji-picker").hidden = !$("emoji-picker").hidden;
    });
    $("whisper-mode-btn").addEventListener("click", (event) => {
      event.stopPropagation();
      if (messageMode === "normal") messageMode = "whisper";
      else if (messageMode === "whisper") {
        messageMode = "disappearing";
        whisperRecipients = [];
        composerTokens.whisper = null;
      } else if (messageMode === "disappearing") {
        messageMode = "ai";
        whisperRecipients = [];
        composerTokens.whisper = null;
        if (!canUseAiInCurrentGroup({ showError: true })) {
          messageMode = "normal";
        }
      } else messageMode = "normal";
      if (messageMode === "whisper") showWhisperPicker("button");
      else hideWhisperPicker();
      syncComposerTokens();
      updateMessageModeBtn();
    });
    $("whisper-picker-confirm").addEventListener("click", () => {
      if (!getActiveWhisperRecipientIds().length) {
        showToast("Select at least one recipient", "error");
        return;
      }
      hideWhisperPicker();
      syncComposerTokens();
      updateWhisperBtn();
    });
    $("whisper-picker-cancel").addEventListener("click", cancelWhisperSelection);
    $("scroll-bottom-btn").addEventListener("click", () => scrollToBottom());
    bindTagFilterDrag();
    $("scroll-first-unread-btn").addEventListener("click", jumpToFirstUnread);
    let scrollRafPending = false;
    let lastRecordedAnchor = "";
    messagesArea().addEventListener("scroll", () => {
      if (scrollRafPending) return;
      scrollRafPending = true;
      requestAnimationFrame(() => {
        scrollRafPending = false;
        const area = messagesArea();
        const isAtBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 150;
        $("scroll-bottom-btn").hidden = isAtBottom;
        if (isAtBottom) {
          scrollUnreadCount = 0;
          $("scroll-unread-badge").hidden = true;
        }
        updateFirstUnreadButton();
        const anchorRow = Array.from(area.querySelectorAll(".msg-row[data-msg-id]:not([hidden])")).find((row) => {
          const rect = row.getBoundingClientRect();
          const aRect = area.getBoundingClientRect();
          return rect.bottom > aRect.top + 8 && rect.top < aRect.bottom;
        });
        if (anchorRow) {
          const anchorId = String(anchorRow.dataset.msgId);
          if (anchorId !== lastRecordedAnchor && currentGroupId) {
            lastRecordedAnchor = anchorId;
            const cache = ensureGroupCacheEntry(currentGroupId);
            cache.channelAnchors = cache.channelAnchors || {};
            cache.channelAnchors[getActiveTagTopic()] = anchorId;
            scheduleLocalGroupCacheWrite(currentGroupId, cache);
          }
        }
        if (area.scrollTop <= SCROLL_LOAD_THRESHOLD && !loadingOlder && !transcriptRebuilding && oldestMessageId) {
          loadOlderMessages();
        }
      });
    }, { passive: true });
    $("sidebar-resizer").addEventListener("mousedown", startSidebarResize);
    $("right-panel-toggle").addEventListener("click", toggleRightPanel);
    $("sidebar-toggle-empty").addEventListener("click", toggleSidebar);
    $("right-panel-toggle-empty").addEventListener("click", toggleRightPanel);
    $("sidebar-toggle").addEventListener("click", toggleSidebar);
    $("right-panel-close").addEventListener("click", closeRightPanel);
    $("sidebar-overlay").addEventListener("click", closeMobilePanels);
    $("search-input").addEventListener("input", (e) => {
      const value = e.target.value;
      syncSearchClearButton();
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        searchDebounceTimer = 0;
        searchMessages(value);
      }, 180);
    });
    $("clear-search-btn").addEventListener("click", () => {
      clearActiveSearch();
    });
    $("search-older-btn").addEventListener("click", () => {
      if (!activeSearchTerm || searchHistoryExhausted) return;
      void searchMessages(activeSearchTerm, { pageBatch: SEARCH_AUTO_PAGE_BATCH });
    });
    $("unread-jump-btn").addEventListener("click", () => {
      const first = messagesArea().querySelector(".msg-row.unseen");
      if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    $("image-viewer-overlay").addEventListener("click", hideImageViewer);
    $("image-viewer-img").addEventListener("click", () => {
      updateImageViewerZoom(imageViewerZoom > 1 ? 1 : imageViewerZoom + 1);
    });
    $("image-viewer-img").addEventListener("wheel", (e) => {
      e.preventDefault();
      updateImageViewerZoom(imageViewerZoom + (e.deltaY < 0 ? 0.2 : -0.2));
    }, { passive: false });
    $("image-viewer-download-btn").addEventListener("click", async () => {
      if (!imageViewerData) return;
      const url = URL.createObjectURL(imageViewerData.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = imageViewerData.filename || "image";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 100);
    });
    $("image-viewer-copy-btn").addEventListener("click", async () => {
      if (!imageViewerData) return;
      await copyAttachmentToClipboard({
        type: "image",
        _viewerData: imageViewerData
      });
    });
  }
  async function loadOlderMessages(cursorOverride = null, retried = false) {
    const cursor = cursorOverride || oldestMessageId;
    if (loadingOlder || !cursor || !currentGroupId) return;
    loadingOlder = true;
    const indicator = $("load-more-indicator");
    if (indicator) indicator.hidden = false;
    try {
      if (!retried) {
        const served = await prependHistoryMessagesOlderThan(cursor);
        if (served) return;
      }
      const url = `/api/groups/${currentGroupId}/messages?before=${cursor}&limit=50`;
      const res = await fetch(url);
      if (!res.ok) return;
      const rawMsgs = await res.json();
      if (!rawMsgs.length) {
        if (!retried) {
          const cache2 = ensureGroupCacheEntry(currentGroupId);
          const fallback = (cache2.messages || []).find((m) => String(m.id) !== String(cursor));
          if (fallback) {
            oldestMessageId = fallback.id;
            return loadOlderMessages(fallback.id, true);
          }
        }
        oldestMessageId = null;
        return;
      }
      const msgs = filterMessagesVisibleToCurrentUser(rawMsgs);
      for (const msg of msgs) await hydrateMessageChannel(msg, currentGroupId);
      const channel = getActiveTagTopic();
      const channelMsgs = msgs.filter((msg) => resolveMessageTagTopic(msg) === channel);
      const knownIds = new Set((ensureGroupCacheEntry(currentGroupId).messages || []).map((m) => String(m.id)));
      const freshChannelMsgs = channelMsgs.filter((m) => !knownIds.has(String(m.id)));
      const area = messagesArea();
      const viewportAnchor = captureViewportAnchor(area);
      const rows = freshChannelMsgs.length ? await buildMessageRows(freshChannelMsgs, currentGroupId) : [];
      const fragment = document.createDocumentFragment();
      for (const row of rows) {
        if (!row) continue;
        if (row.classList && row.classList.contains("msg-row")) {
          const msgId = row.dataset.msgId;
          const srcMsg = freshChannelMsgs.find((m) => String(m.id) === String(msgId));
          if (srcMsg) observeMessageForRead(row, srcMsg);
        }
        fragment.appendChild(row);
      }
      const oldFirst = area.querySelector(".msg-row, .msg-system");
      if (oldFirst) {
        area.insertBefore(fragment, oldFirst);
      } else {
        area.appendChild(fragment);
      }
      reconcileTranscriptStructure(area, currentGroupId);
      allMessages = mergeMessagesIntoCache(currentGroupId, msgs, { persist: true });
      oldestMessageId = rawMsgs[0].id;
      const cache = ensureGroupCacheEntry(currentGroupId);
      cache.messages = allMessages;
      cache.messageRows = rows.concat(cache.messageRows || []);
      cache.oldestMessageId = oldestMessageId;
      cache.rowsDirty = false;
      writeLocalGroupCache(currentGroupId, cache);
      if (rows.length) {
        const memo = getChannelRowMemo(cache, getActiveTagTopic());
        memo.rows = [...rows, ...memo.rows];
        for (const row of rows) {
          const msgId = row?.dataset?.msgId;
          if (msgId) memo.byId.set(String(msgId), row);
        }
        memo.firstMsgId = rows[0].dataset?.msgId || memo.firstMsgId;
        evictChannelRowBack(memo);
      }
      restoreViewportAnchor(area, viewportAnchor);
    } catch (err) {
      console.error("loadOlderMessages error:", err);
    } finally {
      loadingOlder = false;
      if (indicator) indicator.hidden = true;
    }
  }
  async function prependHistoryMessagesOlderThan(cursorId) {
    const groupId = currentGroupId;
    if (!groupId || !cursorId) return false;
    const history = await readHistoryMessages(groupId);
    if (!history.length) return false;
    const cursorIndex = history.findIndex((m) => String(m.id) === String(cursorId));
    if (cursorIndex <= 0) return false;
    const cache = ensureGroupCacheEntry(groupId);
    const knownIds = new Set((cache.messages || []).map((m) => String(m.id)));
    const older = history.slice(0, cursorIndex).filter((m) => !knownIds.has(String(m.id))).filter((m) => !isMessageHiddenForCurrentUser(m));
    if (!older.length) return false;
    const take = older.slice(-50);
    const channel = getActiveTagTopic();
    for (const msg of take) await hydrateMessageChannel(msg, groupId);
    const channelMsgs = take.filter((msg) => resolveMessageTagTopic(msg) === channel);
    if (!channelMsgs.length) {
      mergeMessagesIntoCache(groupId, take, { persist: false });
      oldestMessageId = take[0].id;
      writeLocalGroupCache(groupId, cache);
      return false;
    }
    const area = messagesArea();
    const viewportAnchor = captureViewportAnchor(area);
    const rows = await buildMessageRows(channelMsgs, groupId);
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      if (!row) continue;
      if (row.classList?.contains("msg-row")) {
        const srcMsg = channelMsgs.find((m) => String(m.id) === String(row.dataset.msgId));
        if (srcMsg) observeMessageForRead(row, srcMsg);
      }
      fragment.appendChild(row);
    }
    const oldFirst = area.querySelector(".msg-row, .msg-system");
    if (oldFirst) area.insertBefore(fragment, oldFirst);
    else area.appendChild(fragment);
    reconcileTranscriptStructure(area, groupId);
    allMessages = mergeMessagesIntoCache(groupId, take, { persist: false });
    oldestMessageId = take[0].id;
    const entry = ensureGroupCacheEntry(groupId);
    entry.messages = allMessages;
    entry.messageRows = rows.concat(entry.messageRows || []);
    entry.oldestMessageId = oldestMessageId;
    entry.rowsDirty = false;
    writeLocalGroupCache(groupId, entry);
    if (rows.length) {
      const memo = getChannelRowMemo(entry, channel);
      memo.rows = [...rows, ...memo.rows];
      for (const row of rows) {
        const msgId = row?.dataset?.msgId;
        if (msgId) memo.byId.set(String(msgId), row);
      }
      memo.firstMsgId = rows[0].dataset?.msgId || memo.firstMsgId;
      evictChannelRowBack(memo);
    }
    restoreViewportAnchor(area, viewportAnchor);
    return true;
  }
  function getViewportHeightForLayout({ visualViewport, fallbackHeight }) {
    const visualHeight = visualViewport ? Math.round(visualViewport.height) : 0;
    return Math.max(fallbackHeight, visualHeight || 0);
  }
})();
//# sourceMappingURL=app.js.map
