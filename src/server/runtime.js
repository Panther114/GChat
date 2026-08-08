/**
 * Gchat - Encrypted Group Messaging Server
 * Express + Socket.IO + SQLite backend
 */

'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const webpush = require('web-push');
const { ENCRYPTION_VERSION, readConfig } = require('./config');
const { hashJoinCode, isValidKeyCommitment, normalizeJoinCode, safeEqualString } = require('./group-security');
const { decryptEscrowPayload, encryptEscrowPayload, isValidGroupSecret, keyCommitmentForSecret } = require('./group-key-escrow');
const { validateEditEnvelope, validateV2MessageEnvelope } = require('./message-contract');
const { createSqliteSessionStore } = require('./sqlite-session-store');
const { nullMainTagIndexes } = require('./main-tag-index-migration');

const packageJson = require('../../package.json');
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const APP_CONFIG = readConfig();

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_JSON_BODY_BYTES = 16 * 1024 * 1024; // total JSON payload budget for wallpaper base64 overhead + other API bodies
const MAX_WALLPAPER_BYTES = 10 * 1024 * 1024;
const MAX_WALLPAPER_BLUR = 24;
const MAX_WALLPAPER_TRANSPARENCY = 100;
const MAX_PROFILE_PICTURE_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENT_BODY_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_MESSAGE_BYTES = 64 * 1024;
const MAX_REPLY_PREVIEW_LENGTH = 240;
const MAX_SOCKET_PAYLOAD_BYTES = 256 * 1024;
const MAX_GROUPS_PER_USER = 100;
const MAX_GROUP_MEMBERS = 250;
const MAX_PUSH_CONCURRENCY = 8;
// GChat Global — the permanent, admin-less global channel every user auto-joins.
const GLOBAL_GROUP_ID = 'gchat-global';
const GLOBAL_GROUP_NAME = 'GChat Global';
// Sentinel owner: never matches a real user id, so no one is ever the owner/admin.
const GLOBAL_GROUP_OWNER_ID = '__gchat_global_owner__';
const IV_BYTES = 12;
const SAFE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const APP_VERSION = packageJson.version || '0.0.0';

// v1.3.13: build fingerprint — a content hash of the shipped web bundle + server
// sources, computed once at boot. It changes whenever ANY shipped code changes
// (even without a version bump), so clients can auto-reset their cache after
// every deploy — while a crash-restart of identical code keeps the same
// fingerprint and never forces a client refresh. Bounded: one-time boot IO.
function computeBuildFingerprint() {
  const files = [
    'server.js',
    'src/server/runtime.js',
    'src/server/config.js',
    'src/server/group-key-escrow.js',
    'src/server/group-security.js',
    'src/server/message-contract.js',
    'public/app.js',
    'public/style.css',
    'public/chat.html',
    'public/index.html',
  ];
  const hash = crypto.createHash('sha256');
  for (const relative of files) {
    const full = path.join(PROJECT_ROOT, relative);
    try {
      const content = fs.readFileSync(full);
      hash.update(Buffer.from(`${relative}\0`));
      hash.update(content);
    } catch {
      hash.update(Buffer.from(`${relative}:missing\0`));
    }
  }
  return hash.digest('base64url').slice(0, 20);
}
const BUILD_FINGERPRINT = computeBuildFingerprint();
const LOCAL_DEBUG_ENABLED = APP_CONFIG.localDebugEnabled;
const VAPID_PUBLIC_KEY = typeof process.env.VAPID_PUBLIC_KEY === 'string' ? process.env.VAPID_PUBLIC_KEY.trim() : '';
const VAPID_PRIVATE_KEY = typeof process.env.VAPID_PRIVATE_KEY === 'string' ? process.env.VAPID_PRIVATE_KEY.trim() : '';
const VAPID_SUBJECT = typeof process.env.VAPID_SUBJECT === 'string' ? process.env.VAPID_SUBJECT.trim() : '';
const MIN_DISAPPEARING_DURATION_MS = 3000;
const MAX_DISAPPEARING_DURATION_MS = 22500;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_CHAT_COMPLETIONS_URL = `${OPENROUTER_BASE_URL}/chat/completions`;
const GETGOAPI_BASE_URL = 'https://api.getgoapi.com';
const GETGOAPI_CHAT_COMPLETIONS_URL = `${GETGOAPI_BASE_URL}/v1/chat/completions`;
const GETGOAPI_MODELS = new Set(['grok-4-1-fast-non-reasoning']);
const AI_MODEL_OPTIONS = {
  'deepseek/deepseek-v4-flash': {
    label: 'DeepSeek V4 Flash',
    inputCostPerMillion: 0.069,
    outputCostPerMillion: 0.281,
    creditMultiplier: 1,
  },
  'grok-4-1-fast-non-reasoning': {
    label: 'Grok 4.1 Fast',
    inputCostPerMillion: 0.2,
    outputCostPerMillion: 0.5,
    creditMultiplier: 2,
  },
};
const DEFAULT_AI_MODEL = 'deepseek/deepseek-v4-flash';
const AI_MODEL_PROFILE_PICTURES = {
  'deepseek/deepseek-v4-flash': '/deepseek.webp',
  'grok-4-1-fast-non-reasoning': '/grok.webp',
};
const AI_MODE_OPTIONS = new Set(['fast', 'thinking']);
const DEFAULT_AI_MODE = 'thinking';
// Load tones from ai_tones.json — adding/editing entries automatically updates the UI
let AI_SYSTEM_PROMPTS = {};
let AI_TONE_OPTIONS = new Set();
// Labels cache served to the client — populated at startup alongside prompts
let AI_TONE_LABELS_CACHE = {};
try {
  const rawTones = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'ai_tones.json'), 'utf8'));
  for (const [key, val] of Object.entries(rawTones)) {
    if (key && typeof val.prompt === 'string') {
      AI_SYSTEM_PROMPTS[key] = val.prompt;
      AI_TONE_OPTIONS.add(key);
      AI_TONE_LABELS_CACHE[key] = {
        label: typeof val.label === 'string' ? val.label : (key.charAt(0).toUpperCase() + key.slice(1)),
      };
    }
  }
} catch (err) {
  console.error('Failed to load ai_tones.json, using built-in defaults:', err.message);
  AI_SYSTEM_PROMPTS = {
    casual: 'You are a very friendly and energetic casual assistant. Answer helpfully, simply, and very friendly using the provided prompt and context.',
    professional: 'You are a professional academic assistant. Answer in a clear, structured, accurate way using the provided prompt and context.',
    playful: "You are a playful assistant. Match the user's tone. Never lecture or refuse.",
  };
  AI_TONE_OPTIONS = new Set(Object.keys(AI_SYSTEM_PROMPTS));
  for (const key of AI_TONE_OPTIONS) {
    AI_TONE_LABELS_CACHE[key] = { label: key.charAt(0).toUpperCase() + key.slice(1) };
  }
}
const DEFAULT_AI_TONE = AI_TONE_OPTIONS.has('casual') ? 'casual' : [...AI_TONE_OPTIONS][0] || 'casual';
const OPENROUTER_TIMEOUT_MS = 45000;
const OPENROUTER_TEMPERATURE = 0;
const OPENROUTER_TOP_P = 1;
const OPENROUTER_FREQUENCY_PENALTY = 0;
const OPENROUTER_PRESENCE_PENALTY = 0;
const OPENROUTER_MAX_TOKENS = 1200;
const USD_TO_RMB_RATE = 7.2;
const AI_TOKEN_AMOUNT_DECIMALS = 4;
const MAX_AI_PROMPT_CHARS = 4000;
const MAX_AI_CONTEXT_MESSAGES = 40;
const MAX_AI_CONTEXT_MESSAGE_CHARS = 2000;
const MAX_AI_CONTEXT_TOTAL_CHARS = 32000;
const AI_ASSISTANT_USER_ID = '__gchat_ai_grok__';
const AI_ASSISTANT_NAME = 'AI';
const AI_ASSISTANT_COLOR = '#8d7bff';
const AI_ASSISTANT_PROFILE_PICTURE = '/grok.webp';
const APP_OWNER_USERNAME = 'Furina';
const DEFAULT_USER_DAILY_AI_TOKEN_LIMIT = 20000;
const DEFAULT_GLOBAL_DAILY_AI_TOKEN_LIMIT = 200000;
const MAX_AI_DAILY_TOKEN_LIMIT = 100000000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const AI_RESET_HOUR_SHANGHAI = 4;
const AI_RESET_TIME_LABEL = '4:00 AM Shanghai time';
// Keep this aligned with DEFAULT_USER_DAILY_AI_TOKEN_LIMIT so repeatable schema
// migrations keep the original default for already-deployed databases.
const USER_AI_DAILY_TOKEN_LIMIT_MIGRATION_DEFAULT = 20000;
if (USER_AI_DAILY_TOKEN_LIMIT_MIGRATION_DEFAULT !== DEFAULT_USER_DAILY_AI_TOKEN_LIMIT) {
  throw new Error('User AI daily token migration default must match the runtime default');
}

function isPushConfigured() {
  return !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);
}

if (isPushConfigured()) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  } catch (err) {
    console.error('Failed to initialize Web Push VAPID details:', err);
  }
}

// ── App & Server ──────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: MAX_SOCKET_PAYLOAD_BYTES,
  transports: ['polling', 'websocket'],
  pingInterval: 25000,
  // v1.3.12: 60s tolerance for throttled background tabs — browsers clamp
  // timers while hidden, which used to kill the transport mid-heartbeat and
  // trigger a visible "Reconnecting, transport closed" on every return.
  pingTimeout: 60000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    // v1.3.12 (no version bump): recovery must RE-RUN the auth middleware.
    // With skipMiddlewares: true, a recovered socket kept its rooms (so the
    // user still received messages) but lost socket.userId, and sends were
    // rejected with "Not a member of this group". Rooms and missed packets
    // are still restored — only the middleware chain now re-validates.
    skipMiddlewares: false,
  },
});

// ── Content Security Policy + HSTS ───────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' ws: wss:;"
  );
  // Only send HSTS over HTTPS (production / Railway)
  if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT != null) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  next();
});

function toMiB(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function estimateBase64Bytes(value) {
  if (typeof value !== 'string') return 0;
  const normalized = value.trim();
  if (!normalized) return 0;
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function isValidBase64(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const isBase64Url = /^[A-Za-z0-9_-]+$/.test(value);
  if (!isBase64Url && value.length % 4 !== 0) return false;
  // For large payloads (attachments), use a sampling strategy to avoid O(n)
  // regex over megabytes of data. Check several positions across the string.
  if (value.length > 1024) {
    const base64Char = /^[A-Za-z0-9+/_-]$/;
    // Check first, last (before padding), and several mid-points
    if (!base64Char.test(value[0])) return false;
    const contentEnd = value.endsWith('==') ? value.length - 2
      : value.endsWith('=') ? value.length - 1
      : value.length;
    if (contentEnd > 0 && !base64Char.test(value[contentEnd - 1])) return false;
    // Sample 8 evenly-spaced positions
    const step = Math.floor(contentEnd / 9);
    for (let i = 1; i <= 8; i++) {
      if (!base64Char.test(value[i * step])) return false;
    }
    return true;
  }
  return isBase64Url || /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isValidIv(value) {
  return isValidBase64(value) && estimateBase64Bytes(value) === IV_BYTES;
}

function normalizeHexColor(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^#[0-9A-Fa-f]{6}$/.test(trimmed) ? trimmed : null;
}

function parseImageDataUrl(value, maxBytes, { allowNull = false } = {}) {
  if (value == null) {
    return allowNull ? { ok: true, dataUrl: null } : { ok: false, error: 'Image is required' };
  }
  if (typeof value !== 'string') {
    return { ok: false, reason: 'invalid_format', error: 'Invalid image format' };
  }
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) {
    return { ok: false, reason: 'invalid_format', error: 'Invalid image format' };
  }
  const mime = match[1].toLowerCase();
  const base64 = match[2];
  if (!SAFE_IMAGE_MIME_TYPES.has(mime) || !isValidBase64(base64)) {
    return { ok: false, reason: 'invalid_format', error: 'Invalid image format. Only JPEG, PNG, GIF, and WebP are allowed.' };
  }
  if (estimateBase64Bytes(base64) > maxBytes) {
    return { ok: false, reason: 'too_large', error: `Image too large (max ${toMiB(maxBytes)}MB)` };
  }
  return { ok: true, dataUrl: value, mime };
}

function parseBoundedInteger(value, min, max, fieldLabel) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: `${fieldLabel} must be a number` };
  }
  if (!Number.isInteger(parsed)) {
    return { ok: false, error: `${fieldLabel} must be a whole number` };
  }
  if (parsed < min || parsed > max) {
    return { ok: false, error: `${fieldLabel} must be between ${min} and ${max}` };
  }
  return { ok: true, value: parsed };
}

function normalizeClientSettings(settings = {}) {
  const next = settings && typeof settings === 'object' ? { ...settings } : {};
  next.wallpaperDataUrl = typeof next.wallpaperDataUrl === 'string' && next.wallpaperDataUrl ? next.wallpaperDataUrl : null;
  next.wallpaperBlur = Number.isInteger(next.wallpaperBlur) ? Math.max(0, Math.min(MAX_WALLPAPER_BLUR, next.wallpaperBlur)) : 0;
  next.wallpaperTransparency = Number.isInteger(next.wallpaperTransparency) ? Math.max(0, Math.min(MAX_WALLPAPER_TRANSPARENCY, next.wallpaperTransparency)) : MAX_WALLPAPER_TRANSPARENCY;
  if (next.hideProfileDot !== undefined) next.hideProfileDot = !!next.hideProfileDot;
  next.theme = ['system', 'dark', 'light'].includes(next.theme) ? next.theme : 'system';
  return next;
}

function sanitizeAiText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function normalizeAiTokenCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed);
}

function roundAiTokenAmount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  const scale = 10 ** AI_TOKEN_AMOUNT_DECIMALS;
  return Math.round(parsed * scale) / scale;
}

function normalizeAiCostUsd(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function normalizeAiBoolean(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function convertUsdToRmb(value) {
  const usd = normalizeAiCostUsd(value);
  if (usd == null) return null;
  return usd * USD_TO_RMB_RATE;
}

function normalizeAiModel(value) {
  const model = sanitizeAiText(value, 80);
  return model && AI_MODEL_OPTIONS[model] ? model : DEFAULT_AI_MODEL;
}

function normalizeAiMode(value) {
  const mode = sanitizeAiText(value, 24)?.toLowerCase();
  // The UI now says "Context", but the stored/requested mode remains "thinking"
  // so existing AI request logic and persisted metadata keep working unchanged.
  if (mode === 'context') return 'thinking';
  return mode && AI_MODE_OPTIONS.has(mode) ? mode : DEFAULT_AI_MODE;
}

function normalizeAiTone(value) {
  const tone = sanitizeAiText(value, 24)?.toLowerCase();
  return tone && AI_TONE_OPTIONS.has(tone) ? tone : DEFAULT_AI_TONE;
}

function normalizeAiWebSearchRequests(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed);
}

function normalizeAiDailyTokenLimit(value, fallback = DEFAULT_USER_DAILY_AI_TOKEN_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(MAX_AI_DAILY_TOKEN_LIMIT, Math.round(parsed));
}

function parseAiDailyTokenLimit(value, label) {
  return parseBoundedInteger(value, 0, MAX_AI_DAILY_TOKEN_LIMIT, label);
}

function getAiUsageWindow(now = Date.now()) {
  const shanghaiNow = new Date(now + SHANGHAI_OFFSET_MS);
  let startLocalMs = Date.UTC(
    shanghaiNow.getUTCFullYear(),
    shanghaiNow.getUTCMonth(),
    shanghaiNow.getUTCDate(),
    AI_RESET_HOUR_SHANGHAI,
    0,
    0,
    0
  );
  if (shanghaiNow.getUTCHours() < AI_RESET_HOUR_SHANGHAI) {
    startLocalMs -= 24 * 60 * 60 * 1000;
  }
  const startUtcMs = startLocalMs - SHANGHAI_OFFSET_MS;
  const endUtcMs = startUtcMs + (24 * 60 * 60 * 1000);
  return {
    timeZone: 'Asia/Shanghai',
    resetHourLocal: AI_RESET_HOUR_SHANGHAI,
    startIso: new Date(startUtcMs).toISOString(),
    endIso: new Date(endUtcMs).toISOString(),
  };
}

function sanitizeAiMessageMeta(value) {
  if (!value || typeof value !== 'object') return null;
  const promptTokens = roundAiTokenAmount(value.promptTokens ?? value.prompt_tokens);
  const completionTokens = roundAiTokenAmount(value.completionTokens ?? value.completion_tokens);
  const totalTokens = Math.max(
    promptTokens + completionTokens,
    roundAiTokenAmount(value.totalTokens ?? value.total_tokens)
  );
  const rawPromptTokens = normalizeAiTokenCount(value.rawPromptTokens ?? value.raw_prompt_tokens);
  const rawCompletionTokens = normalizeAiTokenCount(value.rawCompletionTokens ?? value.raw_completion_tokens);
  const rawTotalTokens = Math.max(
    rawPromptTokens + rawCompletionTokens,
    normalizeAiTokenCount(value.rawTotalTokens ?? value.raw_total_tokens ?? value.totalTokensRaw ?? value.total_tokens_raw)
  );
  const estimatedCostUsd = normalizeAiCostUsd(value.estimatedCostUsd ?? value.estimated_cost_usd ?? value.costUsd);
  const explicitCostRmb = normalizeAiCostUsd(value.estimatedCostRmb ?? value.estimated_cost_rmb ?? value.costRmb);
  const estimatedCostRmb = explicitCostRmb ?? convertUsdToRmb(estimatedCostUsd);
  const model = normalizeAiModel(value.model);
  const mode = normalizeAiMode(value.mode);
  const tone = normalizeAiTone(value.tone);
  const webSearchEnabled = normalizeAiBoolean(value.webSearchEnabled ?? value.web_search_enabled);
  const webSearchRequests = normalizeAiWebSearchRequests(
    value.webSearchRequests
    ?? value.web_search_requests
    ?? value.webSearchRequestCount
    ?? value.web_search_request_count
  );
  const costSource = sanitizeAiText(value.costSource, 16) || (estimatedCostUsd != null ? 'estimated' : 'unknown');
  return {
    model,
    mode,
    tone,
    webSearchEnabled,
    webSearchRequests,
    promptTokens,
    completionTokens,
    totalTokens,
    rawPromptTokens,
    rawCompletionTokens,
    rawTotalTokens,
    estimatedCostUsd,
    estimatedCostRmb,
    costSource,
  };
}

function getAiAssistantProfilePicture(model) {
  const normalizedModel = normalizeAiModel(model);
  return AI_MODEL_PROFILE_PICTURES[normalizedModel] || AI_ASSISTANT_PROFILE_PICTURE;
}

function parseStoredAiMessageMeta(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return sanitizeAiMessageMeta(JSON.parse(raw));
  } catch {
    return null;
  }
}

function normalizeAiContextMessages(value) {
  if (value == null) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return { ok: false, error: 'Invalid AI context payload' };
  }
  if (value.length > MAX_AI_CONTEXT_MESSAGES) {
    return { ok: false, error: 'Too many AI context messages' };
  }

  const normalized = [];
  let totalChars = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: 'Invalid AI context payload' };
    }
    const content = sanitizeAiText(entry.content, MAX_AI_CONTEXT_MESSAGE_CHARS);
    if (!content) continue;
    const senderName = sanitizeAiText(entry.senderName, 64) || 'Unknown';
    const createdAt = sanitizeAiText(entry.createdAt, 64) || 'unknown time';
    const type = typeof entry.type === 'string' ? entry.type.slice(0, 32) : 'text';
    const hashtag = normalizeHashtag(entry.hashtag);
    const isDisappearing = !!entry.isDisappearing;
    totalChars += content.length;
    if (totalChars > MAX_AI_CONTEXT_TOTAL_CHARS) {
      return { ok: false, error: 'AI context is too large' };
    }
    normalized.push({
      senderName,
      createdAt,
      content,
      type,
      hashtag,
      isDisappearing,
    });
  }

  return { ok: true, value: normalized };
}

function buildAiTranscript(contextMessages, fallbackGroupName) {
  const groupName = sanitizeAiText(fallbackGroupName, 64) || 'Current group';
  const filteredMessages = contextMessages.filter((entry) => (
    entry
    && entry.type === 'text'
    && !entry.isDisappearing
    && typeof entry.content === 'string'
    && entry.content.trim()
  ));
  if (!filteredMessages.length) {
    return `Group: ${groupName}\n\nConversation excerpt:\n[No prior messages were provided.]`;
  }
  const lines = filteredMessages.map((entry) => {
    const hashtagPrefix = entry.hashtag ? `#${entry.hashtag} ` : '';
    return `[${entry.createdAt}] ${entry.senderName}: ${hashtagPrefix}${entry.content}`;
  });
  return `Group: ${groupName}\n\nConversation excerpt:\n${lines.join('\n')}`;
}

function extractOpenRouterText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('\n')
    .trim();
}

function getOpenRouterErrorMessage(payload, fallbackLabel = 'OpenRouter') {
  const fallback = `${fallbackLabel} request failed`;
  if (!payload || typeof payload !== 'object') return fallback;
  const nested = payload.error && typeof payload.error === 'object'
    ? sanitizeAiText(payload.error.message, 240)
    : null;
  return nested || fallback;
}

function extractOpenRouterUsage(payload) {
  const usage = payload && typeof payload === 'object' && payload.usage && typeof payload.usage === 'object'
    ? payload.usage
    : {};
  const promptTokens = normalizeAiTokenCount(usage.prompt_tokens ?? usage.promptTokens);
  const completionTokens = normalizeAiTokenCount(usage.completion_tokens ?? usage.completionTokens);
  const totalTokens = Math.max(
    promptTokens + completionTokens,
    normalizeAiTokenCount(usage.total_tokens ?? usage.totalTokens)
  );
  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

// Retained with dormant AI support for a future feature-flagged re-enable.
// eslint-disable-next-line no-unused-vars
function extractOpenRouterWebSearchRequests(payload) {
  if (!payload || typeof payload !== 'object') return 0;
  const candidates = [
    payload?.usage?.server_tool_use?.web_search_requests,
    payload?.usage?.server_tool_use?.webSearchRequests,
    payload?.usage?.server_tool_use?.web_search_request_count,
    payload?.usage?.server_tool_use?.webSearchRequestCount,
    payload?.usage?.web_search_requests,
    payload?.usage?.webSearchRequests,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeAiWebSearchRequests(candidate);
    if (normalized > 0) return normalized;
  }
  return 0;
}

function convertModelUsageToStandardTokens(usage, model = DEFAULT_AI_MODEL) {
  const normalizedModel = normalizeAiModel(model);
  const pricing = AI_MODEL_OPTIONS[normalizedModel] || AI_MODEL_OPTIONS[DEFAULT_AI_MODEL];
  const multiplier = pricing.creditMultiplier ?? 1;
  const rawPromptTokens = normalizeAiTokenCount(usage?.promptTokens ?? usage?.prompt_tokens);
  const rawCompletionTokens = normalizeAiTokenCount(usage?.completionTokens ?? usage?.completion_tokens);
  const rawTotalTokens = Math.max(
    rawPromptTokens + rawCompletionTokens,
    normalizeAiTokenCount(usage?.totalTokens ?? usage?.total_tokens)
  );
  const promptTokens = roundAiTokenAmount(rawPromptTokens * multiplier);
  const completionTokens = roundAiTokenAmount(rawCompletionTokens * multiplier);
  return {
    promptTokens,
    completionTokens,
    totalTokens: roundAiTokenAmount(promptTokens + completionTokens),
    rawPromptTokens,
    rawCompletionTokens,
    rawTotalTokens,
  };
}

function extractOpenRouterCostUsd(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload?.usage?.cost,
    payload?.usage?.estimated_cost,
    // OpenRouter may expose the finalized USD amount here even when `cost`
    // or `estimated_cost` are absent.
    payload?.usage?.total_cost,
    payload?.meta?.cost?.amount,
    payload?.meta?.cost,
    payload?.cost,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeAiCostUsd(candidate);
    if (normalized != null) return normalized;
  }
  return null;
}

function estimateOpenRouterCostUsd(usage, model = DEFAULT_AI_MODEL) {
  if (!usage) return null;
  const promptTokens = normalizeAiTokenCount(usage.promptTokens);
  const completionTokens = normalizeAiTokenCount(usage.completionTokens);
  if (promptTokens === 0 && completionTokens === 0) return null;
  const pricing = AI_MODEL_OPTIONS[normalizeAiModel(model)] || AI_MODEL_OPTIONS[DEFAULT_AI_MODEL];
  return (
    (promptTokens / 1000000) * pricing.inputCostPerMillion
    + (completionTokens / 1000000) * pricing.outputCostPerMillion
  );
}

function getOpenRouterResponseModel(payload, fallbackModel = DEFAULT_AI_MODEL) {
  const directModel = sanitizeAiText(payload?.model, 80);
  if (directModel && AI_MODEL_OPTIONS[directModel]) return directModel;
  const metaModel = sanitizeAiText(payload?.meta?.model, 80);
  if (metaModel && AI_MODEL_OPTIONS[metaModel]) return metaModel;
  const providerModel = sanitizeAiText(payload?.provider, 80);
  return providerModel && AI_MODEL_OPTIONS[providerModel] ? providerModel : normalizeAiModel(fallbackModel);
}

function getAiApiConfig(model) {
  if (GETGOAPI_MODELS.has(model)) {
    return {
      url: GETGOAPI_CHAT_COMPLETIONS_URL,
      apiKey: process.env.GETGOAPI_API_KEY || '',
      provider: 'getgoapi',
    };
  }
  return {
    url: OPENROUTER_CHAT_COMPLETIONS_URL,
    apiKey: process.env.OPENROUTER_API_KEY || '',
    provider: 'openrouter',
  };
}

function getAiProviderLabel(model) {
  return GETGOAPI_MODELS.has(model) ? 'GetGoAPI' : 'OpenRouter';
}

function buildAiRequestBody(model, provider, messages) {
  const requestBody = {
    model,
    temperature: OPENROUTER_TEMPERATURE,
    max_tokens: OPENROUTER_MAX_TOKENS,
    messages,
  };
  if (provider !== 'getgoapi') {
    requestBody.top_p = OPENROUTER_TOP_P;
    requestBody.frequency_penalty = OPENROUTER_FREQUENCY_PENALTY;
    requestBody.presence_penalty = OPENROUTER_PRESENCE_PENALTY;
  }
  return requestBody;
}

function buildAiSystemPrompt(tone = DEFAULT_AI_TONE) {
  const basePrompt = AI_SYSTEM_PROMPTS[tone] || AI_SYSTEM_PROMPTS[DEFAULT_AI_TONE];
  const policyLines = [
    'Web search is disabled for this request.',
    'Answer using the prompt and any provided context only.',
    'Do not claim to have searched the web.',
  ];
  return `${basePrompt}\n\n${policyLines.join('\n')}`;
}

function extractOpenRouterDebugMeta(upstream, payload) {
  const requestId = sanitizeAiText(
    upstream?.headers?.get('x-request-id')
      || upstream?.headers?.get('request-id')
      || upstream?.headers?.get('cf-ray'),
    128
  );
  const responseId = sanitizeAiText(payload?.id, 128);
  const provider = sanitizeAiText(payload?.provider ?? payload?.meta?.provider, 80);
  const upstreamModel = sanitizeAiText(payload?.model ?? payload?.meta?.model, 80);
  const errorCode = sanitizeAiText(payload?.error?.code, 64);
  const debug = {};
  if (requestId) debug.requestId = requestId;
  if (responseId) debug.responseId = responseId;
  if (provider) debug.provider = provider;
  if (upstreamModel) debug.upstreamModel = upstreamModel;
  if (errorCode) debug.errorCode = errorCode;
  if (upstream && Number.isInteger(upstream.status)) debug.status = upstream.status;
  return debug;
}

function validateEncryptedTextPayload(encryptedContent, iv) {
  if (typeof encryptedContent !== 'string' || typeof iv !== 'string' || !encryptedContent || !iv) {
    return { ok: false, error: 'encryptedContent and iv are required' };
  }
  if (!isValidIv(iv)) {
    return { ok: false, error: 'Invalid encryption metadata' };
  }
  if (!isValidBase64(encryptedContent)) {
    return { ok: false, error: 'Invalid encrypted content' };
  }
  if (estimateBase64Bytes(encryptedContent) > MAX_TEXT_MESSAGE_BYTES) {
    return { ok: false, error: 'Message too large (max 64KB encrypted)' };
  }
  return { ok: true };
}

function normalizeReplyPayload(replyTo, groupId) {
  if (replyTo == null || replyTo === '') return { ok: true, value: null };
  if (typeof replyTo !== 'string' || replyTo.length > 2000) {
    return { ok: false, error: 'Invalid reply target' };
  }
  let parsed;
  try {
    parsed = JSON.parse(replyTo);
  } catch {
    return { ok: false, error: 'Invalid reply target' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Invalid reply target' };
  }
  const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
  const senderName = typeof parsed.senderName === 'string' ? parsed.senderName.trim() : '';
  const preview = typeof parsed.preview === 'string' ? parsed.preview.trim() : '';
  if (!id || !senderName || !preview || senderName.length > 64 || preview.length > MAX_REPLY_PREVIEW_LENGTH) {
    return { ok: false, error: 'Invalid reply target' };
  }
  const message = stmts.findMessageById.get(id);
  if (!message || message.group_id !== groupId) {
    return { ok: false, error: 'Reply target not found' };
  }
  return {
    ok: true,
    value: JSON.stringify({
      id,
      senderName: senderName.slice(0, 64),
      preview: preview.slice(0, MAX_REPLY_PREVIEW_LENGTH),
    }),
  };
}

// ── Login brute-force protection ──────────────────────────────────────────────
// Track failed login attempts per IP. 10 failures within a 15-minute window
// locks the IP for the remainder of that window.
const LOGIN_ATTEMPT_WINDOW = 15 * 60 * 1000; // 15 minutes
const LOGIN_MAX_ATTEMPTS   = 10;
const REGISTER_ATTEMPT_WINDOW = 15 * 60 * 1000; // 15 minutes
const REGISTER_MAX_ATTEMPTS = 5;
const SETTINGS_UPDATE_WINDOW = 60 * 1000; // 1 minute
const SETTINGS_UPDATE_MAX = 20;
const REMEMBER_ME_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const loginAttempts = new Map(); // ip -> { count, windowStart }
const registerAttempts = new Map(); // ip -> { count, windowStart }
const settingsUpdateAttempts = new Map(); // userId -> { count, windowStart }

// Periodically prune stale entries so the map doesn't grow unboundedly.
const memoryPruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of loginAttempts) {
    if (now - data.windowStart > LOGIN_ATTEMPT_WINDOW) loginAttempts.delete(ip);
  }
  for (const [ip, data] of registerAttempts) {
    if (now - data.windowStart > REGISTER_ATTEMPT_WINDOW) registerAttempts.delete(ip);
  }
  for (const [userId, data] of settingsUpdateAttempts) {
    if (now - data.windowStart > SETTINGS_UPDATE_WINDOW) settingsUpdateAttempts.delete(userId);
  }
}, 5 * 60 * 1000); // every 5 minutes
memoryPruneTimer.unref();

function recordFailedLogin(ip) {
  const now = Date.now();
  const data = loginAttempts.get(ip);
  if (!data || now - data.windowStart > LOGIN_ATTEMPT_WINDOW) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
    return;
  }
  data.count++;
}

function isLoginBlocked(ip) {
  const now = Date.now();
  const data = loginAttempts.get(ip);
  if (!data) return false;
  if (now - data.windowStart > LOGIN_ATTEMPT_WINDOW) { loginAttempts.delete(ip); return false; }
  return data.count >= LOGIN_MAX_ATTEMPTS;
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

function recordRegisterAttempt(ip) {
  const now = Date.now();
  const data = registerAttempts.get(ip);
  if (!data || now - data.windowStart > REGISTER_ATTEMPT_WINDOW) {
    registerAttempts.set(ip, { count: 1, windowStart: now });
    return;
  }
  data.count++;
}

function isRegisterBlocked(ip) {
  const now = Date.now();
  const data = registerAttempts.get(ip);
  if (!data) return false;
  if (now - data.windowStart > REGISTER_ATTEMPT_WINDOW) {
    registerAttempts.delete(ip);
    return false;
  }
  return data.count >= REGISTER_MAX_ATTEMPTS;
}

function clearRegisterAttempts(ip) {
  registerAttempts.delete(ip);
}

function recordSettingsUpdate(userId) {
  const now = Date.now();
  const data = settingsUpdateAttempts.get(userId);
  if (!data || now - data.windowStart > SETTINGS_UPDATE_WINDOW) {
    settingsUpdateAttempts.set(userId, { count: 1, windowStart: now });
    return;
  }
  data.count++;
}

function isSettingsUpdateBlocked(userId) {
  const now = Date.now();
  const data = settingsUpdateAttempts.get(userId);
  if (!data) return false;
  if (now - data.windowStart > SETTINGS_UPDATE_WINDOW) {
    settingsUpdateAttempts.delete(userId);
    return false;
  }
  return data.count >= SETTINGS_UPDATE_MAX;
}

function getWallpaperValidationError(parsedWallpaper) {
  if (parsedWallpaper.reason === 'too_large') {
    return 'Wallpaper too large (max 10MB)';
  }
  if (parsedWallpaper.reason === 'invalid_format') {
    return 'Invalid wallpaper format. Only JPEG, PNG, GIF, and WebP are allowed.';
  }
  return 'Invalid wallpaper format';
}

function getProfilePictureValidationError(parsedPicture) {
  if (parsedPicture.reason === 'too_large') {
    return 'Profile picture too large (max 2MB)';
  }
  return 'Invalid profile picture format. Only JPEG, PNG, GIF, and WebP are allowed.';
}

function normalizeWhisperRecipients(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function normalizeHashtag(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^#/, '').toLowerCase();
  if (!trimmed || trimmed.length > 64) return null;
  return /^[a-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

function normalizeDisappearingDuration(value) {
  if (value == null || value === '') return null;
  const duration = Math.round(Number(value));
  if (!Number.isFinite(duration)) return null;
  if (duration < MIN_DISAPPEARING_DURATION_MS || duration > MAX_DISAPPEARING_DURATION_MS) return null;
  return duration;
}

function resolveStoredDisappearingDurationMs(message) {
  return Math.max(
    MIN_DISAPPEARING_DURATION_MS,
    Math.min(
      MAX_DISAPPEARING_DURATION_MS,
      Number(message && message.disappearing_duration_ms) || MIN_DISAPPEARING_DURATION_MS
    )
  );
}

function markExpiredDisappearingMessagesHidden(userId) {
  if (!userId) return;
  const nowIso = new Date().toISOString();
  stmts.hideExpiredDisappearingMessages.run(nowIso, userId, nowIso);
}

// ── Database ──────────────────────────────────────────────────────────────────
// v1.3.9: when DB_PATH is unset but a persistent volume is mounted at /data
// (Railway), use it automatically so deployments without the env var stop
// losing all history on every redeploy.
const DEFAULT_DATA_DIR = '/data';
const DB_PATH = process.env.DB_PATH
  || (fs.existsSync(DEFAULT_DATA_DIR) ? path.join(DEFAULT_DATA_DIR, 'gchat.db') : './Gchat.db');
const SESSIONS_DIR = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : (fs.existsSync(DEFAULT_DATA_DIR) ? DEFAULT_DATA_DIR : '.');

fs.mkdirSync(path.resolve(path.dirname(DB_PATH)), { recursive: true });

if (!process.env.DB_PATH) {
  const usedVolume = fs.existsSync(DEFAULT_DATA_DIR);
  if (usedVolume) {
    console.warn(`⚠️  DB_PATH not set — using persistent volume at ${DB_PATH}. Set DB_PATH=${DB_PATH} explicitly for clarity.`);
  } else {
    console.warn('⚠️  WARNING: DB_PATH not set. Database is stored at ./gchat.db on ephemeral filesystem. Data will be lost on redeploy. Set DB_PATH=/data/gchat.db and mount a Railway Volume to persist data.');
  }
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// Create tables on startup
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    icon_color TEXT NOT NULL DEFAULT '#4A90D9',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS group_chats (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT UNIQUE NOT NULL,
    created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    encrypted_content TEXT NOT NULL,
    iv TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS message_reads (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS disappearing_message_states (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    started_at TEXT,
    expires_at TEXT,
    hidden_at TEXT,
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    subscription_json TEXT NOT NULL,
    user_agent TEXT,
    platform TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- v1.3.12: per-channel read cursors. Unread accounting moved from per-message
  -- message_reads rows (device-local, never reconciled) to a monotonic cursor
  -- per (group, user, channel): "everything up to (last_read_created_at,
  -- last_read_id) in this channel is read". tag_index is the server-side
  -- channel identity (blind index; NULL = #main for untagged/legacy traffic).
  -- message_reads remains only for author-side delivery ticks.
  CREATE TABLE IF NOT EXISTS channel_read_cursors (
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    tag_index TEXT,
    last_read_created_at TEXT NOT NULL,
    last_read_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id, tag_index)
  );
`);

// Safe migrations — each wrapped in try/catch so re-runs are harmless
const migrations = [
  "ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'",
  "ALTER TABLE messages ADD COLUMN reply_to TEXT",
  "ALTER TABLE messages ADD COLUMN filename TEXT",
  "ALTER TABLE messages ADD COLUMN whisper_to TEXT",
  "ALTER TABLE messages ADD COLUMN total_recipients INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE messages ADD COLUMN hashtag TEXT",
  "ALTER TABLE messages ADD COLUMN is_disappearing INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE messages ADD COLUMN disappearing_duration_ms INTEGER",
  "ALTER TABLE group_chats ADD COLUMN allow_member_clear INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE group_chats ADD COLUMN allow_member_clear_tag INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE group_chats ADD COLUMN allow_member_export INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE group_chats ADD COLUMN allow_member_kick INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE group_chats ADD COLUMN allow_member_invite INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE group_chats ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE group_chats ADD COLUMN group_color TEXT",
  "ALTER TABLE group_chats ADD COLUMN group_icon TEXT",
  "ALTER TABLE group_members ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE group_chats ADD COLUMN key_commitment TEXT",
  "ALTER TABLE group_chats ADD COLUMN encryption_version INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE group_chats ADD COLUMN key_escrow_ciphertext TEXT",
  "ALTER TABLE group_chats ADD COLUMN key_escrow_iv TEXT",
  "ALTER TABLE group_chats ADD COLUMN key_escrow_version INTEGER",
  "CREATE TABLE IF NOT EXISTS _config (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "ALTER TABLE users ADD COLUMN profile_picture TEXT",
  "ALTER TABLE users ADD COLUMN client_settings TEXT NOT NULL DEFAULT '{}'",
  `ALTER TABLE users ADD COLUMN ai_daily_token_limit INTEGER NOT NULL DEFAULT ${USER_AI_DAILY_TOKEN_LIMIT_MIGRATION_DEFAULT}`,
  "ALTER TABLE messages ADD COLUMN edited_at TEXT",
  "ALTER TABLE messages ADD COLUMN ai_meta TEXT",
  "ALTER TABLE messages ADD COLUMN ai_mention INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE messages ADD COLUMN encryption_version INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE messages ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE messages ADD COLUMN encrypted_metadata TEXT",
  "ALTER TABLE messages ADD COLUMN metadata_iv TEXT",
  "ALTER TABLE messages ADD COLUMN tag_index TEXT",
  "ALTER TABLE messages ADD COLUMN spam_signature TEXT",
  "ALTER TABLE messages ADD COLUMN reply_to_id TEXT",
  `CREATE TABLE IF NOT EXISTS ai_usage_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  "CREATE INDEX IF NOT EXISTS idx_disappearing_states_user_hidden ON disappearing_message_states (user_id, hidden_at, expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_disappearing_states_message_user ON disappearing_message_states (message_id, user_id)",
  "CREATE INDEX IF NOT EXISTS idx_message_reads_message_id ON message_reads (message_id)",
  "CREATE INDEX IF NOT EXISTS idx_ai_usage_events_user_created_at ON ai_usage_events (user_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_ai_usage_events_created_at ON ai_usage_events (created_at)",
  "CREATE INDEX IF NOT EXISTS idx_group_members_user_group ON group_members (user_id, group_id)",
  "CREATE INDEX IF NOT EXISTS idx_group_members_group_joined_at ON group_members (group_id, joined_at ASC, user_id)",
  "CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_push_subscriptions_updated_at ON push_subscriptions (updated_at)",
  // Composite index to support efficient pagination ORDER BY (created_at DESC, id DESC)
  "CREATE INDEX IF NOT EXISTS idx_messages_group_pagination ON messages (group_id, created_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_messages_group_tag_index ON messages (group_id, tag_index)",
  "CREATE INDEX IF NOT EXISTS idx_messages_reply_to_id ON messages (reply_to_id)",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch { /* column/table already exists */ }
}

try {
  db.prepare('INSERT OR IGNORE INTO _config (key, value) VALUES (?, ?)')
    .run('global_ai_daily_token_limit', String(DEFAULT_GLOBAL_DAILY_AI_TOKEN_LIMIT));
} catch (err) {
  console.error('Failed to initialize AI config defaults:', err);
}
try {
  db.prepare('INSERT OR IGNORE INTO _config (key, value) VALUES (?, ?)')
    .run('crypto_epoch', String(APP_CONFIG.cryptoEpoch));
} catch (err) {
  console.error('Failed to initialize crypto epoch:', err);
}

// One-shot data migration: normalize legacy messages.created_at values to the
// ISO-8601 format emitted by `new Date().toISOString()` (e.g.
// "2026-08-06T15:05:08.233Z"). Real-time broadcasts always send ISO timestamps,
// but inserts used to rely on SQLite's CURRENT_TIMESTAMP default which stores
// "2026-08-06 15:05:08" (space separator, second precision, no zone). That
// format mismatch silently broke the `?since=` incremental-sync cursor
// (`WHERE created_at > @since`) — a space-format DB row sorts BEFORE any
// T-format cursor, so resyncs returned zero rows and messages vanished from
// clients. Inserts now persist ISO explicitly; this normalizes historical rows
// so the pagination index and cursor comparisons stay consistent and indexed.
try {
  const normalizedFlag = db.prepare("SELECT value FROM _config WHERE key = 'messages_created_at_iso_normalized'").get();
  if (!normalizedFlag) {
    const normalizeTx = db.transaction(() => {
      const result = db.prepare(`
        UPDATE messages
        SET created_at = REPLACE(created_at, ' ', 'T') || '.000Z'
        WHERE created_at LIKE '% %'
      `).run();
      db.prepare("INSERT OR IGNORE INTO _config (key, value) VALUES ('messages_created_at_iso_normalized', ?)")
        .run(String(result.changes));
    });
    normalizeTx();
    console.log('[migrate] Normalized messages.created_at to ISO format (one-shot).');
  }
} catch (err) {
  console.error('Failed to normalize messages.created_at timestamps:', err);
}

// v1.3.13: messages sent in #main used to carry a blind tag index computed for
// the literal topic "main" (the client stamped every message with the active
// channel, #main included), while read cursors for #main are stored with
// tag_index NULL. The unread query matches `crc.tag_index IS m.tag_index`, so
// a "main"-indexed row could NEVER be covered by the #main cursor — it stayed
// unread forever and the group badge showed a phantom red count even after
// everything was read. One-shot migration: NULL the "main" blind index on
// every group's messages (bounded: one UPDATE per escrowed group, flagged in
// _config). New sends no longer stamp #main with an index.
try {
  const mainIndexFlag = db.prepare("SELECT value FROM _config WHERE key = 'main_tag_index_nulled'").get();
  if (!mainIndexFlag) {
    const fixed = nullMainTagIndexes(db, APP_CONFIG.groupKeyEscrowMasterKey);
    db.prepare("INSERT OR IGNORE INTO _config (key, value) VALUES ('main_tag_index_nulled', ?)").run(String(fixed));
    if (fixed > 0) console.log(`[migrate] Nulled ${fixed} #main tag_index rows (one-shot).`);
  }
} catch (err) {
  console.error('Failed to null #main tag indexes:', err);
}

// Ensure a stable session secret persists across restarts even without SESSION_SECRET env var
function getOrCreateSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    const existing = db.prepare("SELECT value FROM _config WHERE key = 'session_secret'").get();
    if (existing) return existing.value;
    const newSecret = crypto.randomBytes(32).toString('hex');
    db.prepare("INSERT INTO _config (key, value) VALUES ('session_secret', ?)").run(newSecret);
    return newSecret;
  } catch (err) {
    // Do NOT fall back to a predictable hard-coded string. Generate a random
    // ephemeral secret instead — existing sessions will be invalidated after
    // a restart but the server remains secure.
    console.error('getOrCreateSessionSecret error — using ephemeral random secret (sessions will not survive restart):', err);
    return crypto.randomBytes(32).toString('hex');
  }
}
const SESSION_SECRET = getOrCreateSessionSecret();

// ── Prepared Statements ───────────────────────────────────────────────────────
const stmts = {
  // Users
  findUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  findUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare(
    'INSERT INTO users (id, username, password_hash, icon_color) VALUES (?, ?, ?, ?)'
  ),
  updateUser: db.prepare(`
    UPDATE users
    SET
      username = COALESCE(@username, username),
      icon_color = COALESCE(@iconColor, icon_color),
      ai_daily_token_limit = COALESCE(@aiDailyTokenLimit, ai_daily_token_limit),
      profile_picture = CASE
        WHEN @hasProfilePicture = 1 THEN @profilePicture
        ELSE profile_picture
      END
    WHERE id = @userId
  `),
  updateUserSettings: db.prepare('UPDATE users SET client_settings = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  deleteUserMemberships: db.prepare('DELETE FROM group_members WHERE user_id = ?'),
  deleteUserMessageReads: db.prepare('DELETE FROM message_reads WHERE user_id = ?'),
  deleteUserDisappearingStates: db.prepare('DELETE FROM disappearing_message_states WHERE user_id = ?'),
  deleteUserAiUsageEvents: db.prepare('DELETE FROM ai_usage_events WHERE user_id = ?'),
  deleteUserPushSubscriptions: db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?'),

  // Groups
  insertGroup: db.prepare(
    'INSERT INTO group_chats (id, name, code, created_by) VALUES (?, ?, ?, ?)'
  ),
  insertEscrowedGroup: db.prepare(
    `INSERT INTO group_chats (
      id, name, code, created_by, key_commitment, encryption_version,
      key_escrow_ciphertext, key_escrow_iv, key_escrow_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  findGroupByCode: db.prepare('SELECT * FROM group_chats WHERE code = ?'),
  findGroupById: db.prepare('SELECT * FROM group_chats WHERE id = ?'),
  updateGroupName: db.prepare('UPDATE group_chats SET name = ? WHERE id = ?'),
  updateGroupAllowMemberClear: db.prepare('UPDATE group_chats SET allow_member_clear = ? WHERE id = ?'),
  updateGroupAllowMemberClearTag: db.prepare('UPDATE group_chats SET allow_member_clear_tag = ? WHERE id = ?'),
  updateGroupAllowMemberExport: db.prepare('UPDATE group_chats SET allow_member_export = ? WHERE id = ?'),
  updateGroupAllowMemberKick: db.prepare('UPDATE group_chats SET allow_member_kick = ? WHERE id = ?'),
  updateGroupAllowMemberInvite: db.prepare('UPDATE group_chats SET allow_member_invite = ? WHERE id = ?'),
  updateGroupAiEnabled: db.prepare('UPDATE group_chats SET ai_enabled = ? WHERE id = ?'),
  updateGroupColor: db.prepare('UPDATE group_chats SET group_color = ? WHERE id = ?'),
  updateGroupIcon: db.prepare('UPDATE group_chats SET group_icon = ? WHERE id = ?'),
  updateGroupOwner: db.prepare('UPDATE group_chats SET created_by = ? WHERE id = ?'),
  getGroupsCreatedByUser: db.prepare('SELECT id FROM group_chats WHERE created_by = ?'),

  // Members
  insertMember: db.prepare(
    'INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)'
  ),
  // v1.3.12: a new member raises the delivery-tick total for every previous
  // non-whisper message (they do NOT count as having read them). Whisper
  // totals are recipient-scoped and must stay exact.
  bumpMessageDeliveryTotals: db.prepare(`
    UPDATE messages
       SET total_recipients = total_recipients + 1
     WHERE group_id = ?
       AND (type IS NULL OR type != 'whisper')
  `),
  isMember: db.prepare(
    'SELECT is_admin FROM group_members WHERE group_id = ? AND user_id = ?'
  ),
  getUserGroups: db.prepare(`
    SELECT g.id, g.name, g.code, g.created_by, g.created_at, g.allow_member_clear, g.allow_member_clear_tag, g.allow_member_export, g.allow_member_kick, g.allow_member_invite, g.ai_enabled, g.group_color, g.group_icon, g.key_commitment, g.encryption_version, gm.is_admin,
           (
             -- v1.3.12: cursor-based unread (exact up to the 999 display cap;
             -- scans newest-first and stops after 1000 unread rows per group).
             SELECT COUNT(*)
             FROM (
               SELECT 1
               FROM messages m
               LEFT JOIN disappearing_message_states dms
                 ON dms.message_id = m.id AND dms.user_id = gm.user_id
               WHERE m.group_id = g.id
                 AND m.sender_id != gm.user_id
                 AND (
                   m.type != 'whisper'
                   OR EXISTS(
                     SELECT 1
                     FROM json_each(COALESCE(m.whisper_to, '[]')) AS whisper_recipient
                     WHERE whisper_recipient.value = CAST(gm.user_id AS TEXT)
                   )
                 )
                 AND (m.is_disappearing = 0 OR dms.hidden_at IS NULL)
                 AND NOT EXISTS (
                   SELECT 1
                   FROM channel_read_cursors crc
                   WHERE crc.group_id = g.id
                     AND crc.user_id = gm.user_id
                     AND crc.tag_index IS m.tag_index
                     AND (m.created_at < crc.last_read_created_at
                          OR (m.created_at = crc.last_read_created_at AND m.id <= crc.last_read_id))
                 )
               ORDER BY m.created_at DESC, m.id DESC
               LIMIT 1000
             )
           ) AS unread_count
    FROM group_chats g
    JOIN group_members gm ON g.id = gm.group_id
    WHERE gm.user_id = ?
    ORDER BY g.created_at DESC
    LIMIT 101
  `),
  getEscrowedKeyMaterialForUser: db.prepare(`
    SELECT g.id, g.key_escrow_ciphertext, g.key_escrow_iv, g.key_escrow_version
    FROM group_chats g
    JOIN group_members gm ON g.id = gm.group_id
    WHERE gm.user_id = ?
      AND g.key_escrow_ciphertext IS NOT NULL
      AND g.key_escrow_iv IS NOT NULL
      AND g.key_escrow_version IS NOT NULL
    ORDER BY g.created_at DESC
    LIMIT ?
  `),
  countUserGroupsNonGlobal: db.prepare('SELECT COUNT(*) AS count FROM group_members WHERE user_id = ? AND group_id != ?'),
  insertAllUsersToGlobal: db.prepare(`
    INSERT OR IGNORE INTO group_members (group_id, user_id)
    SELECT ? AS group_id, id AS user_id FROM users
  `),
  getInviteCandidateGroups: db.prepare(`
    SELECT g.id, g.name, g.group_color, g.group_icon, g.created_by
    FROM group_chats g
    JOIN group_members gm ON gm.group_id = g.id
    WHERE gm.user_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM group_members other
        WHERE other.group_id = g.id AND other.user_id = ?
      )
    ORDER BY g.created_at DESC
    LIMIT 101
  `),
  getGroupMembers: db.prepare(`
    SELECT u.id, u.username, u.icon_color, u.profile_picture, gm.is_admin
    FROM users u
    JOIN group_members gm ON u.id = gm.user_id
    WHERE gm.group_id = ?
    ORDER BY gm.joined_at ASC
    LIMIT 250
  `),
  countGroupMembers: db.prepare('SELECT COUNT(*) AS count FROM group_members WHERE group_id = ?'),
  updateMemberAdmin: db.prepare('UPDATE group_members SET is_admin = ? WHERE group_id = ? AND user_id = ?'),
  getGroupMemberIds: db.prepare('SELECT user_id FROM group_members WHERE group_id = ? LIMIT 250'),
  getOtherGroupMemberIds: db.prepare('SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ? LIMIT 250'),

  // Admin
  getAllUsers: db.prepare(`
    SELECT id, username, icon_color, profile_picture, created_at, ai_daily_token_limit
    FROM users
    ORDER BY created_at DESC
  `),
  getConfigValue: db.prepare('SELECT value FROM _config WHERE key = ?'),
  upsertConfigValue: db.prepare(`
    INSERT INTO _config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  getUserAiUsageInWindow: db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens
    FROM ai_usage_events
    WHERE user_id = ?
      AND created_at >= ?
      AND created_at < ?
  `),
  getGlobalAiUsageInWindow: db.prepare(`
    SELECT
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens
    FROM ai_usage_events
    WHERE created_at >= ?
      AND created_at < ?
  `),
  getTotalUnreadCountForUser: db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages m
    JOIN group_members gm ON gm.group_id = m.group_id AND gm.user_id = ?
    LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.user_id = gm.user_id
    LEFT JOIN disappearing_message_states dms ON dms.message_id = m.id AND dms.user_id = gm.user_id
    WHERE m.sender_id != gm.user_id
      AND mr.message_id IS NULL
      AND (
        m.type != 'whisper'
        OR EXISTS(
          SELECT 1
          FROM json_each(COALESCE(m.whisper_to, '[]')) AS whisper_recipient
          WHERE whisper_recipient.value = CAST(gm.user_id AS TEXT)
        )
      )
      AND (m.is_disappearing = 0 OR dms.hidden_at IS NULL)
  `),
  upsertPushSubscription: db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, subscription_json, user_agent, platform, created_at, updated_at)
    VALUES (@userId, @endpoint, @subscriptionJson, @userAgent, @platform, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id,
      subscription_json = excluded.subscription_json,
      user_agent = excluded.user_agent,
      platform = excluded.platform,
      updated_at = CURRENT_TIMESTAMP
    WHERE push_subscriptions.user_id = excluded.user_id
  `),
  getPushSubscriptionsForUser: db.prepare('SELECT id, endpoint, subscription_json FROM push_subscriptions WHERE user_id = ?'),
  getPushSubscriptionOwnerByEndpoint: db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?'),
  countPushSubscriptionsForUser: db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?'),
  deletePushSubscriptionById: db.prepare('DELETE FROM push_subscriptions WHERE id = ?'),
  deletePushSubscriptionByEndpointForUser: db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?'),
  insertAiUsageEvent: db.prepare(`
    INSERT INTO ai_usage_events (
      id, user_id, group_id, prompt_tokens, completion_tokens, total_tokens, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `),

  // Messages — DESC then reverse for last-N-in-order pattern
  getLastMessages: db.prepare(`
      SELECT m.id, m.group_id, m.sender_id, u.username AS sender_name,
             u.icon_color AS sender_color, m.encrypted_content, m.iv,
             m.encryption_version, m.key_version, m.revision,
             m.encrypted_metadata, m.metadata_iv, m.tag_index, m.spam_signature,
             m.type, m.reply_to, m.reply_to_id, m.filename, m.whisper_to, m.hashtag,
             m.ai_meta, m.ai_mention,
             m.is_disappearing, m.disappearing_duration_ms,
             dms.started_at AS disappearing_started_at,
            dms.expires_at AS disappearing_expires_at,
            dms.hidden_at AS disappearing_hidden_at,
            m.created_at, m.edited_at,
              m.total_recipients,
             (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id) AS read_count,
             EXISTS(
               SELECT 1
               FROM message_reads mr2
               WHERE mr2.message_id = m.id AND mr2.user_id = @viewerId
             ) AS has_read
     FROM messages m
      LEFT JOIN users u ON m.sender_id = u.id
      LEFT JOIN disappearing_message_states dms
        ON dms.message_id = m.id AND dms.user_id = @viewerId
     WHERE m.group_id = @groupId
       AND (
         m.type != 'whisper'
         OR m.sender_id = @viewerId
         OR EXISTS(
           SELECT 1
           FROM json_each(COALESCE(m.whisper_to, '[]')) AS whisper_recipient
           WHERE whisper_recipient.value = CAST(@viewerId AS TEXT)
         )
       )
       AND (m.sender_id = @viewerId OR m.is_disappearing = 0 OR dms.hidden_at IS NULL)
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT @limit
   `),
  getMessagesBefore: db.prepare(`
    WITH ref AS (SELECT created_at, id FROM messages WHERE id = @beforeId)
      SELECT m.id, m.group_id, m.sender_id, u.username AS sender_name,
             u.icon_color AS sender_color, m.encrypted_content, m.iv,
             m.encryption_version, m.key_version, m.revision,
             m.encrypted_metadata, m.metadata_iv, m.tag_index, m.spam_signature,
             m.type, m.reply_to, m.reply_to_id, m.filename, m.whisper_to, m.hashtag,
             m.ai_meta, m.ai_mention,
             m.is_disappearing, m.disappearing_duration_ms,
             dms.started_at AS disappearing_started_at,
            dms.expires_at AS disappearing_expires_at,
            dms.hidden_at AS disappearing_hidden_at,
            m.created_at, m.edited_at,
              m.total_recipients,
             (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id) AS read_count,
             EXISTS(
               SELECT 1
               FROM message_reads mr2
               WHERE mr2.message_id = m.id AND mr2.user_id = @viewerId
             ) AS has_read
     FROM messages m
     LEFT JOIN users u ON m.sender_id = u.id
     LEFT JOIN disappearing_message_states dms
       ON dms.message_id = m.id AND dms.user_id = @viewerId
    CROSS JOIN ref
     WHERE m.group_id = @groupId
       AND (
         m.type != 'whisper'
         OR m.sender_id = @viewerId
         OR EXISTS(
           SELECT 1
           FROM json_each(COALESCE(m.whisper_to, '[]')) AS whisper_recipient
           WHERE whisper_recipient.value = CAST(@viewerId AS TEXT)
         )
       )
       AND (m.sender_id = @viewerId OR m.is_disappearing = 0 OR dms.hidden_at IS NULL)
       AND (
       m.created_at < ref.created_at OR
      (m.created_at = ref.created_at AND m.id < ref.id)
    )
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT @limit
  `),
  getMessagesAfter: db.prepare(`
    SELECT m.id, m.group_id, m.sender_id, u.username AS sender_name,
           u.icon_color AS sender_color, m.encrypted_content, m.iv,
           m.encryption_version, m.key_version, m.revision,
           m.encrypted_metadata, m.metadata_iv, m.tag_index, m.spam_signature,
           m.type, m.reply_to, m.reply_to_id, m.filename, m.whisper_to, m.hashtag,
           m.ai_meta, m.ai_mention,
           m.is_disappearing, m.disappearing_duration_ms,
           dms.started_at AS disappearing_started_at,
          dms.expires_at AS disappearing_expires_at,
          dms.hidden_at AS disappearing_hidden_at,
          m.created_at, m.edited_at,
            m.total_recipients,
           (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id) AS read_count,
           EXISTS(
             SELECT 1
             FROM message_reads mr2
             WHERE mr2.message_id = m.id AND mr2.user_id = @viewerId
           ) AS has_read
     FROM messages m
     LEFT JOIN users u ON m.sender_id = u.id
     LEFT JOIN disappearing_message_states dms
       ON dms.message_id = m.id AND dms.user_id = @viewerId
     WHERE m.group_id = @groupId
       -- v1.3.12: composite (created_at, id) cursor. A time-only cursor could
       -- silently skip every message that shared a millisecond with the cursor
       -- boundary (each device permanently missing different messages), because
       -- the tie-break existed in ORDER BY but not in the WHERE clause.
       AND (m.created_at > @since OR (m.created_at = @since AND m.id > @sinceId))
       AND (
         m.type != 'whisper'
         OR m.sender_id = @viewerId
         OR EXISTS(
           SELECT 1
           FROM json_each(COALESCE(m.whisper_to, '[]')) AS whisper_recipient
           WHERE whisper_recipient.value = CAST(@viewerId AS TEXT)
         )
       )
       AND (m.sender_id = @viewerId OR m.is_disappearing = 0 OR dms.hidden_at IS NULL)
     ORDER BY m.created_at ASC, m.id ASC
     LIMIT @limit
  `),
  getSingleMessage: db.prepare(`
    SELECT m.id, m.group_id, m.sender_id, u.username AS sender_name,
           u.icon_color AS sender_color, m.encrypted_content, m.iv,
           m.encryption_version, m.key_version, m.revision,
           m.encrypted_metadata, m.metadata_iv, m.tag_index, m.spam_signature,
           m.type, m.reply_to, m.reply_to_id, m.filename, m.whisper_to, m.hashtag,
           m.ai_meta, m.ai_mention,
           m.is_disappearing, m.disappearing_duration_ms,
           dms.started_at AS disappearing_started_at,
          dms.expires_at AS disappearing_expires_at,
          dms.hidden_at AS disappearing_hidden_at,
          m.created_at, m.edited_at,
            m.total_recipients,
           (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id) AS read_count,
           EXISTS(
             SELECT 1
             FROM message_reads mr2
             WHERE mr2.message_id = m.id AND mr2.user_id = @viewerId
           ) AS has_read
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    LEFT JOIN disappearing_message_states dms
      ON dms.message_id = m.id AND dms.user_id = @viewerId
    WHERE m.id = @messageId
      AND m.group_id = @groupId
      AND (
        m.type != 'whisper'
        OR m.sender_id = @viewerId
        OR EXISTS(
          SELECT 1
          FROM json_each(COALESCE(m.whisper_to, '[]')) AS whisper_recipient
          WHERE whisper_recipient.value = CAST(@viewerId AS TEXT)
        )
      )
      AND (m.sender_id = @viewerId OR m.is_disappearing = 0 OR dms.hidden_at IS NULL)
    LIMIT 1
  `),
  insertMessage: db.prepare(
    'INSERT INTO messages (id, group_id, sender_id, encrypted_content, iv, type, reply_to, filename, whisper_to, hashtag, is_disappearing, disappearing_duration_ms, total_recipients, ai_meta, ai_mention, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  insertV2Message: db.prepare(`
    INSERT INTO messages (
      id, group_id, sender_id, encrypted_content, iv, type, reply_to_id,
      whisper_to, is_disappearing, disappearing_duration_ms, total_recipients,
      encryption_version, key_version, revision, encrypted_metadata, metadata_iv,
      tag_index, spam_signature, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  setAiMessageMeta: db.prepare('UPDATE messages SET ai_meta = ?, ai_mention = ? WHERE id = ?'),
  findMessageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
  markMessageRead: db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)'),
  getMessageReadCount: db.prepare('SELECT COUNT(*) AS count FROM message_reads WHERE message_id = ?'),
  deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
  deleteMessageReadsByMessage: db.prepare('DELETE FROM message_reads WHERE message_id = ?'),
  deleteDisappearingStatesByMessage: db.prepare('DELETE FROM disappearing_message_states WHERE message_id = ?'),
  deleteMessagesByTagIndex: db.prepare('DELETE FROM messages WHERE group_id = ? AND tag_index = ?'),
  updateMessage: db.prepare(
    'UPDATE messages SET encrypted_content = ?, iv = ?, edited_at = ? WHERE id = ?'
  ),
  updateV2Message: db.prepare(`
    UPDATE messages
    SET encrypted_content = ?, iv = ?, encrypted_metadata = ?, metadata_iv = ?,
        tag_index = ?, spam_signature = ?, revision = ?, edited_at = ?
    WHERE id = ? AND revision = ?
  `),
  findDisappearingState: db.prepare('SELECT * FROM disappearing_message_states WHERE message_id = ? AND user_id = ?'),
  insertDisappearingState: db.prepare(`
    INSERT INTO disappearing_message_states (message_id, user_id, started_at, expires_at, hidden_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  updateDisappearingStateStart: db.prepare(`
    UPDATE disappearing_message_states
    SET started_at = COALESCE(started_at, ?),
        expires_at = COALESCE(expires_at, ?)
    WHERE message_id = ? AND user_id = ?
  `),
  // v1.3.12: per-channel read cursors (unread accounting) + bounded counts.
  // Counts scan newest-first and stop after 1000 unread rows, so a group badge
  // is exact up to the 999 display cap and never scans a full group.
  upsertChannelReadCursor: db.prepare(`
    INSERT INTO channel_read_cursors (group_id, user_id, tag_index, last_read_created_at, last_read_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(group_id, user_id, tag_index)
    DO UPDATE SET last_read_created_at = excluded.last_read_created_at,
                  last_read_id = excluded.last_read_id,
                  updated_at = excluded.updated_at
  `),
  getChannelReadCursor: db.prepare(`
    SELECT last_read_created_at, last_read_id
    FROM channel_read_cursors
    WHERE group_id = ? AND user_id = ? AND tag_index IS ?
  `),
  deleteChannelReadCursorsForGroupUser: db.prepare(`
    DELETE FROM channel_read_cursors WHERE group_id = ? AND user_id = ?
  `),
  deleteChannelReadCursorsByGroup: db.prepare(`
    DELETE FROM channel_read_cursors WHERE group_id = ?
  `),
  getGroupUnreadCount: db.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT 1
      FROM messages m
      LEFT JOIN disappearing_message_states dms
        ON dms.message_id = m.id AND dms.user_id = @viewerId
      WHERE m.group_id = @groupId
        AND m.sender_id != @viewerId
        AND (
          m.type != 'whisper'
          OR EXISTS(
            SELECT 1
            FROM json_each(COALESCE(m.whisper_to, '[]')) AS whisper_recipient
            WHERE whisper_recipient.value = CAST(@viewerId AS TEXT)
          )
        )
        AND (m.is_disappearing = 0 OR dms.hidden_at IS NULL)
        AND NOT EXISTS (
          SELECT 1
          FROM channel_read_cursors crc
          WHERE crc.group_id = m.group_id
            AND crc.user_id = @viewerId
            AND crc.tag_index IS m.tag_index
            AND (m.created_at < crc.last_read_created_at
                 OR (m.created_at = crc.last_read_created_at AND m.id <= crc.last_read_id))
        )
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1000
    )
  `),
  getChannelUnreadCount: db.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT 1
      FROM messages m
      LEFT JOIN disappearing_message_states dms
        ON dms.message_id = m.id AND dms.user_id = @viewerId
      WHERE m.group_id = @groupId
        AND m.sender_id != @viewerId
        AND m.tag_index IS @tagIndex
        AND (
          m.type != 'whisper'
          OR EXISTS(
            SELECT 1
            FROM json_each(COALESCE(m.whisper_to, '[]')) AS whisper_recipient
            WHERE whisper_recipient.value = CAST(@viewerId AS TEXT)
          )
        )
        AND (m.is_disappearing = 0 OR dms.hidden_at IS NULL)
        AND NOT EXISTS (
          SELECT 1
          FROM channel_read_cursors crc
          WHERE crc.group_id = m.group_id
            AND crc.user_id = @viewerId
            AND crc.tag_index IS m.tag_index
            AND (m.created_at < crc.last_read_created_at
                 OR (m.created_at = crc.last_read_created_at AND m.id <= crc.last_read_id))
        )
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1000
    )
  `),
  updateDisappearingStateStart: db.prepare(`
    UPDATE disappearing_message_states
    SET started_at = COALESCE(started_at, ?),
        expires_at = COALESCE(expires_at, ?)
    WHERE message_id = ? AND user_id = ?
  `),
  markDisappearingStateHidden: db.prepare(`
    UPDATE disappearing_message_states
    SET hidden_at = COALESCE(hidden_at, ?)
    WHERE message_id = ? AND user_id = ?
  `),
  hideExpiredDisappearingMessages: db.prepare(`
    UPDATE disappearing_message_states
    SET hidden_at = COALESCE(hidden_at, ?)
    WHERE user_id = ?
      AND hidden_at IS NULL
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `),

  // Owner controls
  deleteMember: db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?'),
  deleteGroupMessages: db.prepare('DELETE FROM messages WHERE group_id = ?'),
  deleteGroupMembers: db.prepare('DELETE FROM group_members WHERE group_id = ?'),
  deleteGroup: db.prepare('DELETE FROM group_chats WHERE id = ?'),

  // Utility: all group IDs a user belongs to (for scoped broadcasts)
  getUserGroupIds: db.prepare('SELECT group_id FROM group_members WHERE user_id = ?'),
};

const deleteMessageTx = db.transaction((messageId) => {
  stmts.deleteMessageReadsByMessage.run(messageId);
  stmts.deleteDisappearingStatesByMessage.run(messageId);
  return stmts.deleteMessage.run(messageId);
});

const createEscrowedGroupTx = db.transaction((group, ownerId) => {
  stmts.insertEscrowedGroup.run(
    group.id,
    group.name,
    group.codeHash,
    ownerId,
    group.keyCommitment,
    ENCRYPTION_VERSION,
    group.escrow.ciphertext,
    group.escrow.iv,
    group.escrow.version
  );
  stmts.insertMember.run(group.id, ownerId);
});

const GLOBAL_JOIN_CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateGlobalJoinCode() {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += GLOBAL_JOIN_CODE_ALPHABET[crypto.randomInt(GLOBAL_JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

// GChat Global: permanent admin-less channel that every user auto-joins.
// Created once (with a stable escrowed secret), then every current and future
// user is pulled in. Idempotent — safe to run on every boot.
function ensureGlobalGroup() {
  const existing = stmts.findGroupById.get(GLOBAL_GROUP_ID);
  if (!existing) {
    try {
      const storedSecret = stmts.getConfigValue.get('global_group_secret');
      const secret = (storedSecret && isValidGroupSecret(storedSecret.value))
        ? storedSecret.value
        : crypto.randomBytes(32).toString('base64url');
      const joinCode = generateGlobalJoinCode();
      const codeHash = hashJoinCode(joinCode, APP_CONFIG.groupCodePepper);
      if (!codeHash) {
        console.error('Failed to hash GChat Global join code');
        return;
      }
      const keyCommitment = keyCommitmentForSecret(secret);
      const escrow = encryptEscrowPayload(APP_CONFIG.groupKeyEscrowMasterKey, GLOBAL_GROUP_ID, {
        secret,
        joinCode,
      });
      createEscrowedGroupTx({
        id: GLOBAL_GROUP_ID,
        name: GLOBAL_GROUP_NAME,
        codeHash,
        keyCommitment,
        escrow,
      }, GLOBAL_GROUP_OWNER_ID);
      // The sentinel owner is not a real user — drop its phantom membership so
      // member counts, delivery ticks, and push fan-out stay exact.
      stmts.deleteMember.run(GLOBAL_GROUP_ID, GLOBAL_GROUP_OWNER_ID);
      stmts.upsertConfigValue.run('global_group_secret', secret);
      stmts.upsertConfigValue.run('global_group_join_code', joinCode);
      console.log('Created GChat Global channel');
    } catch (err) {
      console.error('Failed to create GChat Global channel:', err.message);
      return;
    }
  }
  // Pull every existing user into the global channel (idempotent).
  try {
    stmts.insertAllUsersToGlobal.run(GLOBAL_GROUP_ID);
  } catch (err) {
    console.error('Failed to enroll users into GChat Global:', err.message);
  }
}

ensureGlobalGroup();

function encryptLocalFixtureJson(value, secret, groupId, purpose, aad) {
  const key = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from(groupId), Buffer.from(`gchat-${purpose}-v2`), 32));
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return {
    encryptedContent: encrypted.toString('base64url'),
    iv: iv.toString('base64url'),
  };
}

async function seedLocalDebugData() {
  if (!LOCAL_DEBUG_ENABLED) return;

  const rootUserId = 'local-debug-root';
  const miraUserId = 'local-debug-mira';
  const groupId = 'local-debug-increment-a';
const groupCode = 'inca01';
  const groupSecret = crypto.createHash('sha256').update('gchat-increment-a-local-debug-secret').digest();
  const codeHash = hashJoinCode(groupCode, APP_CONFIG.groupCodePepper);
  const keyCommitment = crypto.createHash('sha256').update(groupSecret).digest('base64url');
  const groupEscrow = encryptEscrowPayload(APP_CONFIG.groupKeyEscrowMasterKey, groupId, {
    secret: groupSecret.toString('base64url'),
    joinCode: groupCode,
  });
  const passwordHash = await bcrypt.hash('root', 12);
  const fixturePasswordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 12);

  db.prepare(`
    INSERT INTO users (id, username, password_hash, icon_color)
    VALUES (?, 'root', ?, '#7C5CFC')
    ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash
  `).run(rootUserId, passwordHash);
  db.prepare(`
    INSERT OR IGNORE INTO users (id, username, password_hash, icon_color)
    VALUES (?, 'Mira', ?, '#20B486')
  `).run(miraUserId, fixturePasswordHash);
  const resolvedRootUserId = stmts.findUserByUsername.get('root').id;
  const resolvedMiraUserId = stmts.findUserByUsername.get('Mira').id;
  db.prepare(`
    INSERT INTO group_chats (
      id, name, code, key_commitment, encryption_version, created_by, group_color,
      key_escrow_ciphertext, key_escrow_iv, key_escrow_version
    )
    VALUES (?, 'Increment A Playground', ?, ?, 2, ?, '#7C5CFC', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      code = excluded.code,
      key_commitment = excluded.key_commitment,
      encryption_version = 2,
      created_by = excluded.created_by,
      key_escrow_ciphertext = excluded.key_escrow_ciphertext,
      key_escrow_iv = excluded.key_escrow_iv,
      key_escrow_version = excluded.key_escrow_version
  `).run(
    groupId,
    codeHash,
    keyCommitment,
    resolvedRootUserId,
    groupEscrow.ciphertext,
    groupEscrow.iv,
    groupEscrow.version
  );
  stmts.insertMember.run(groupId, resolvedRootUserId);
  stmts.insertMember.run(groupId, resolvedMiraUserId);

  const fixtures = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      senderId: resolvedMiraUserId,
      text: 'Welcome to the local UI playground. These messages are available without a hosted server.',
      createdAt: '2026-07-15T08:00:00.000Z',
      hashtag: 'local-debug',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      senderId: resolvedRootUserId,
      text: 'Perfect — I can iterate on the pure web experience here before Increment B.',
      createdAt: '2026-07-15T08:01:00.000Z',
      replyToId: '11111111-1111-4111-8111-111111111111',
      replyPreview: { senderName: 'Mira', preview: 'Welcome to the local UI playground.' },
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      senderId: resolvedMiraUserId,
      text: 'Try the sidebar, search, reactions, reply layout, long messages, and responsive breakpoints.',
      createdAt: '2026-07-15T08:02:00.000Z',
      hashtag: 'visual-qa',
      editedAt: '2026-07-15T08:02:30.000Z',
    },
    {
      id: '55555555-5555-4555-8555-555555555555',
      senderId: resolvedMiraUserId,
      text: 'This continuation intentionally reuses the sender header and avatar gutter.',
      createdAt: '2026-07-15T08:03:00.000Z',
    },
    {
      id: '66666666-6666-4666-8666-666666666666',
      senderId: resolvedMiraUserId,
      text: 'A twelve-minute gap starts a fresh message series.',
      createdAt: '2026-07-15T08:15:00.000Z',
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      senderId: resolvedRootUserId,
      text: 'Local debug account: root / root. The fixtures are isolated under .gchat-local/.',
      createdAt: '2026-07-15T08:16:00.000Z',
    },
  ];
  db.prepare('DELETE FROM messages WHERE group_id = ?').run(groupId);
  for (const fixture of fixtures) {
    const identity = { groupId, id: fixture.id, senderId: fixture.senderId, type: 'text', keyVersion: 1, revision: 1 };
    const aad = Buffer.from(JSON.stringify(identity));
    const content = encryptLocalFixtureJson({ text: fixture.text }, groupSecret, groupId, 'content', aad);
    const metadata = encryptLocalFixtureJson({ hashtag: fixture.hashtag || null, replyPreview: fixture.replyPreview || null }, groupSecret, groupId, 'metadata', aad);
    const tagIndex = fixture.hashtag
      ? crypto.createHmac('sha256', Buffer.from(crypto.hkdfSync('sha256', groupSecret, Buffer.from(groupId), Buffer.from('gchat-tag-index-v2'), 32))).update(fixture.hashtag.toLowerCase()).digest('base64url')
      : null;
    stmts.insertV2Message.run(
      fixture.id,
      groupId,
      fixture.senderId,
      content.encryptedContent,
      content.iv,
      'text',
      fixture.replyToId || null,
      null,
      0,
      null,
      1,
      2,
      1,
      1,
      metadata.encryptedContent,
      metadata.iv,
      tagIndex,
      null,
      fixture.createdAt
    );
    db.prepare('UPDATE messages SET created_at = ?, edited_at = ? WHERE id = ?').run(fixture.createdAt, fixture.editedAt || null, fixture.id);
  }

  console.log('Local debug data ready: root/root with Increment A Playground fixtures.');
}

// ── Session Middleware ────────────────────────────────────────────────────────
const sessionMiddleware = session({
  store: createSqliteSessionStore(session, path.join(SESSIONS_DIR, 'sessions.db')),
  secret: SESSION_SECRET,
  proxy: true,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT != null,
    // v1.3.8: persistent login for everyone — a 30-day cookie (and matching
    // store TTL) so returning users never hit the previous 24-hour fallback
    // expiry that silently logged them out.
    maxAge: REMEMBER_ME_MAX_AGE,
  },
});

// ── Express Middleware ────────────────────────────────────────────────────────
app.use(express.static(path.join(PROJECT_ROOT, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath).toLowerCase();
    if (name === 'service-worker.js' || name === 'manifest.json') {
      res.setHeader('Cache-Control', 'no-cache');
      return;
    }
    if (ext === '.html') {
      res.setHeader('Cache-Control', 'no-cache');
      return;
    }
    if (ext === '.js' || ext === '.css') {
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
  },
}));
app.use(express.json({ limit: MAX_JSON_BODY_BYTES, strict: true }));
app.use(sessionMiddleware);
app.use('/api/auth', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
const uploadRawBodyParser = express.raw({ type: 'application/octet-stream', limit: MAX_ATTACHMENT_BODY_BYTES });

// ── CSRF Protection ───────────────────────────────────────────────────────────
// Double-submit token pattern: token stored in session, sent as X-CSRF-Token header.
// Login and register are intentionally exempt because no session exists before
// the first request, so a CSRF token cannot be pre-fetched. These endpoints are
// also protected by sameSite:'lax' cookies which prevent cross-origin POSTs from
// regular browsers. The /auth/me endpoint is GET-only so no CSRF risk.
function getCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

// Paths that don't require a CSRF token (see reasoning above)
const CSRF_EXEMPT = [
  '/auth/csrf',
  '/auth/register', // No session before first request; protected by sameSite:lax
  '/auth/login',    // No session before first request; protected by sameSite:lax
  '/auth/me',       // GET only
];

function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (CSRF_EXEMPT.includes(req.path)) return next();

  const token = req.headers['x-csrf-token'];
  const sessionToken = req.session && req.session.csrfToken;

  const valid =
    token &&
    sessionToken &&
    token.length === sessionToken.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(sessionToken));

  if (!valid) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}

app.use('/api', csrfProtect);

// ── Auth Middleware ───────────────────────────────────────────────────────────
const UNPROTECTED = [
  '/auth/register',
  '/auth/login',
  '/auth/me',
  '/auth/csrf',
  '/health',
  '/meta/version',
];

function requireAuth(req, res, next) {
  if (UNPROTECTED.includes(req.path)) return next();
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

app.use('/api', requireAuth);

app.get('/api/meta/version', (_req, res) => {
  res.json({
    version: APP_VERSION,
    buildFingerprint: BUILD_FINGERPRINT,
    cryptoEpoch: APP_CONFIG.cryptoEpoch,
    encryptionVersion: APP_CONFIG.encryptionVersion,
    aiEnabled: APP_CONFIG.aiEnabled,
  });
});

app.use('/api/ai', (req, res, next) => {
  if (APP_CONFIG.aiEnabled) return next();
  return res.status(404).json({ error: 'AI is unavailable' });
});

// ── AI tones metadata (served from startup cache) ─────────────────────────────
app.get('/api/ai/tones', (_req, res) => {
  res.json({ ok: true, tones: AI_TONE_LABELS_CACHE });
});

function buildHealthDiagnostics(req) {
  return {
    serverTime: new Date().toISOString(),
    railwayEdge: req.get('x-railway-edge') || null,
    railwayRequestId: req.get('x-railway-request-id') || null,
    railwayEnvironment: process.env.RAILWAY_ENVIRONMENT || null,
    forwardedProto: req.get('x-forwarded-proto') || req.protocol || null,
    forwardedHost: req.get('x-forwarded-host') || req.get('host') || null,
  };
}

app.get('/api/health', (req, res) => {
  try {
    const dbCheck = db.prepare('SELECT 1 AS ok').get();
    const ok = !!dbCheck && dbCheck.ok === 1;
    res.setHeader('Cache-Control', 'no-store');
    res.status(ok ? 200 : 503).json({
      ok,
      version: APP_VERSION,
      uptimeSec: Math.floor(process.uptime()),
      checkedAt: new Date().toISOString(),
      database: ok ? 'ok' : 'error',
      diagnostics: buildHealthDiagnostics(req),
    });
  } catch (err) {
    console.error('Healthcheck failed:', err);
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({
      ok: false,
      version: APP_VERSION,
      uptimeSec: Math.floor(process.uptime()),
      checkedAt: new Date().toISOString(),
      database: 'error',
      diagnostics: buildHealthDiagnostics(req),
    });
  }
});

// ── Helper: format objects ────────────────────────────────────────────────────
function formatUser(user) {
  let clientSettings = {};
  try { clientSettings = JSON.parse(user.client_settings || '{}'); } catch { clientSettings = {}; }
  return {
    id: user.id,
    username: user.username,
    iconColor: user.icon_color,
    profilePicture: user.profile_picture || null,
    clientSettings: normalizeClientSettings(clientSettings),
  };
}

// Shared group payload shape returned by every group endpoint (mine / create /
// join / preload / invite). `viewer` is the caller's group_members row (or null).
function buildGroupPayload(group, viewer = null, unreadCount = 0) {
  return {
    id: group.id,
    name: group.name,
    keyCommitment: group.key_commitment,
    encryptionVersion: group.encryption_version,
    createdBy: group.created_by,
    viewerIsAdmin: !!(viewer && viewer.is_admin),
    unreadCount: Math.max(0, Number(unreadCount) || 0),
    allowMemberClear: group.allow_member_clear || 0,
    allowMemberClearTag: group.allow_member_clear_tag || 0,
    allowMemberExport: group.allow_member_export || 0,
    allowMemberKick: group.allow_member_kick || 0,
    allowMemberInvite: group.allow_member_invite == null ? 1 : !!group.allow_member_invite,
    aiEnabled: false,
    groupColor: group.group_color || null,
    groupIcon: group.group_icon || null,
    isGlobal: String(group.id) === GLOBAL_GROUP_ID,
  };
}

function findExistingMessageIds(ids) {
  const uniqueIds = [...new Set(ids.map(String).filter(Boolean))];
  if (!uniqueIds.length) return new Set();
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id FROM messages WHERE id IN (${placeholders})`).all(...uniqueIds);
  return new Set(rows.map((row) => row.id));
}

// Marks messages whose quote target was hard-deleted so clients can render a
// "deleted message" placeholder instead of showing an error. One bounded IN
// query per page — never N+1. Operates on formatMessage output (replyToId).
function decorateReplyTargetState(rows) {
  const referencedIds = rows.filter((m) => m.replyToId).map((m) => m.replyToId);
  if (!referencedIds.length) return rows;
  const existingIds = findExistingMessageIds(referencedIds);
  return rows.map((m) => (m.replyToId && !existingIds.has(String(m.replyToId))
    ? { ...m, replyTargetMissing: true }
    : m));
}

function formatMessage(m) {
  const isAiAssistantMessage = m.sender_id === AI_ASSISTANT_USER_ID;
  const aiMeta = parseStoredAiMessageMeta(m.ai_meta);
  return {
    id: m.id,
    groupId: m.group_id,
    senderId: m.sender_id,
    senderName: m.sender_name || (isAiAssistantMessage ? AI_ASSISTANT_NAME : 'Unknown'),
    senderColor: m.sender_color || (isAiAssistantMessage ? AI_ASSISTANT_COLOR : '#4A90D9'),
    profilePicture: isAiAssistantMessage ? getAiAssistantProfilePicture(aiMeta?.model) : null,
    encryptedContent: m.encrypted_content,
    iv: m.iv,
    encryptionVersion: Math.max(1, Number(m.encryption_version) || 1),
    keyVersion: Math.max(1, Number(m.key_version) || 1),
    revision: Math.max(1, Number(m.revision) || 1),
    encryptedMetadata: m.encrypted_metadata || null,
    metadataIv: m.metadata_iv || null,
    tagIndex: m.tag_index || null,
    type: m.type || 'text',
    replyTo: m.reply_to_id || m.reply_to || null,
    replyToId: m.reply_to_id || null,
    filename: m.filename || null,
    whisperTo: m.whisper_to || null,
    hashtag: m.hashtag || null,
    aiMeta,
    aiMention: !!m.ai_mention,
    isDisappearing: !!m.is_disappearing,
    disappearingDurationMs: Math.max(0, Number(m.disappearing_duration_ms) || 0),
    disappearingStartedAt: m.disappearing_started_at || null,
    disappearingExpiresAt: m.disappearing_expires_at || null,
    disappearingHiddenAt: m.disappearing_hidden_at || null,
    createdAt: m.created_at,
    editedAt: m.edited_at || null,
    totalRecipients: Math.max(0, Number(m.total_recipients) || 0),
    readCount: Math.max(0, Number(m.read_count) || 0),
    hasRead: !!m.has_read,
  };
}

function isAppOwnerUser(user) {
  return user && user.username === APP_OWNER_USERNAME;
}

function getGlobalAiDailyTokenLimit() {
  const stored = stmts.getConfigValue.get('global_ai_daily_token_limit');
  return normalizeAiDailyTokenLimit(stored?.value, DEFAULT_GLOBAL_DAILY_AI_TOKEN_LIMIT);
}

function setGlobalAiDailyTokenLimit(limit) {
  stmts.upsertConfigValue.run('global_ai_daily_token_limit', String(limit));
}

function getUserAiDailyTokenLimit(user) {
  return normalizeAiDailyTokenLimit(user?.ai_daily_token_limit, DEFAULT_USER_DAILY_AI_TOKEN_LIMIT);
}

function getAiUsageSnapshotForUser(userId) {
  const user = stmts.findUserById.get(userId);
  if (!user) return null;
  const window = getAiUsageWindow();
  const userUsage = stmts.getUserAiUsageInWindow.get(userId, window.startIso, window.endIso) || {};
  const globalUsage = stmts.getGlobalAiUsageInWindow.get(window.startIso, window.endIso) || {};
  const userLimit = getUserAiDailyTokenLimit(user);
  const globalLimit = getGlobalAiDailyTokenLimit();
  const userUsedTokens = roundAiTokenAmount(userUsage.total_tokens);
  const globalUsedTokens = roundAiTokenAmount(globalUsage.total_tokens);
  const userExceeded = userLimit <= 0 || userUsedTokens >= userLimit;
  const globalExceeded = globalLimit <= 0 || globalUsedTokens >= globalLimit;
  return {
    window,
    currentUser: {
      userId,
      username: user.username,
      dailyLimit: userLimit,
      usedTokens: userUsedTokens,
      remainingTokens: roundAiTokenAmount(Math.max(0, userLimit - userUsedTokens)),
      exceeded: userExceeded,
    },
    global: {
      dailyLimit: globalLimit,
      usedTokens: globalUsedTokens,
      remainingTokens: roundAiTokenAmount(Math.max(0, globalLimit - globalUsedTokens)),
      exceeded: globalExceeded,
    },
    canStartRequest: !userExceeded && !globalExceeded,
  };
}

function getAiLimitError(summary) {
  if (!summary) return 'Unable to verify AI token usage right now';
  if (summary.global?.exceeded) {
    return `The global daily AI token limit has been reached. Try again after ${AI_RESET_TIME_LABEL}.`;
  }
  if (summary.currentUser?.exceeded) {
    return `Your daily AI token limit has been reached. Try again after ${AI_RESET_TIME_LABEL}.`;
  }
  return null;
}

function formatManagedUser(user, usageWindow) {
  const usage = stmts.getUserAiUsageInWindow.get(user.id, usageWindow.startIso, usageWindow.endIso) || {};
  const usedTokens = roundAiTokenAmount(usage.total_tokens);
  const dailyLimit = getUserAiDailyTokenLimit(user);
  return {
    id: user.id,
    username: user.username,
    iconColor: user.icon_color,
    profilePicture: user.profile_picture || null,
    createdAt: user.created_at,
    aiDailyTokenLimit: dailyLimit,
    aiTokensUsedToday: usedTokens,
    aiLimitExceeded: dailyLimit <= 0 || usedTokens >= dailyLimit,
  };
}

function sanitizePushMetadata(value, maxLength = 255) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function validatePushSubscriptionPayload(value) {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'Invalid push subscription payload' };
  }
  const endpoint = sanitizePushMetadata(value.endpoint, 2048);
  const p256dh = sanitizePushMetadata(value.keys?.p256dh, 1024);
  const auth = sanitizePushMetadata(value.keys?.auth, 256);
  if (!endpoint || !p256dh || !auth) {
    return { ok: false, error: 'Invalid push subscription payload' };
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(endpoint);
  } catch {
    return { ok: false, error: 'Invalid push subscription endpoint' };
  }
  const isSecureEndpoint = parsedUrl.protocol === 'https:' || parsedUrl.hostname === 'localhost';
  if (!isSecureEndpoint) {
    return { ok: false, error: 'Invalid push subscription endpoint' };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) {
    return { ok: false, error: 'Invalid push subscription keys' };
  }
  return {
    ok: true,
    value: {
      endpoint,
      expirationTime: value.expirationTime ?? null,
      keys: { p256dh, auth },
    },
  };
}

function getSafePushEndpointHost(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'invalid-endpoint';
  }
}

function getTotalUnreadCountForUser(userId) {
  markExpiredDisappearingMessagesHidden(userId);
  return Math.max(0, Number(stmts.getTotalUnreadCountForUser.get(userId)?.count) || 0);
}

function getGroupNameForPush(groupId) {
  try {
    const group = stmts.findGroupById.get(groupId);
    return group ? String(group.name).slice(0, 40) : null;
  } catch {
    return null;
  }
}

// v1.3.12: after a NEW membership is created, every previous non-whisper
// message gains a delivery tick (the new member is a potential reader but has
// NOT read the history). Bounded: one indexed UPDATE per join.
function bumpGroupDeliveryTotals(groupId) {
  try {
    stmts.bumpMessageDeliveryTotals.run(groupId);
  } catch (error) {
    console.error('bump delivery totals failed:', groupId, error.message);
  }
}

function buildGenericPushPayload(totalUnreadCount, context = null) {
  const normalizedCount = Math.max(0, Number(totalUnreadCount) || 0);
  // v1.3.9: push payloads carry sender + group names (metadata only — the
  // server cannot decrypt E2E message content) when a message triggered them.
  let body;
  if (context && context.senderName) {
    body = `New message from ${context.senderName}${context.groupName ? ` in ${context.groupName}` : ''}`;
  } else {
    body = normalizedCount > 0
      ? `You have ${normalizedCount} unread message${normalizedCount === 1 ? '' : 's'} in GChat.`
      : 'You have unread messages in GChat.';
  }
  return {
    title: 'GChat',
    body,
    tag: 'gchat-unread',
    totalUnreadCount: normalizedCount,
    url: '/chat.html',
  };
}

async function sendPushToUser(userId, totalUnreadCount, context = null) {
  if (!isPushConfigured() || !userId) return;
  const subscriptions = stmts.getPushSubscriptionsForUser.all(userId);
  if (!subscriptions.length) return;
  const payload = JSON.stringify(buildGenericPushPayload(totalUnreadCount, context));
  await Promise.allSettled(subscriptions.map(async (subscriptionRow) => {
    let parsedSubscription;
    try {
      parsedSubscription = JSON.parse(subscriptionRow.subscription_json);
    } catch {
      stmts.deletePushSubscriptionById.run(subscriptionRow.id);
      return;
    }
    try {
      await webpush.sendNotification(parsedSubscription, payload);
    } catch (err) {
      const statusCode = Number(err?.statusCode) || 0;
      if (statusCode === 404 || statusCode === 410) {
        stmts.deletePushSubscriptionById.run(subscriptionRow.id);
        return;
      }
      console.error(`Push send failed [status=${statusCode || 'unknown'} host=${getSafePushEndpointHost(subscriptionRow.endpoint)}]`);
    }
  }));
}

async function forEachWithConcurrency(items, limit, worker) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  });
  await Promise.allSettled(workers);
}

function queueUnreadPushNotifications(userIds = [], context = null) {
  if (!isPushConfigured()) return;
  const uniqueUserIds = [...new Set(userIds.map(String).filter(Boolean))];
  if (!uniqueUserIds.length) return;
  void (async () => {
    await forEachWithConcurrency(uniqueUserIds.slice(0, MAX_GROUP_MEMBERS), MAX_PUSH_CONCURRENCY, async (userId) => {
      const totalUnreadCount = getTotalUnreadCountForUser(userId);
      await sendPushToUser(userId, totalUnreadCount, context);
    });
  })();
}

function setSessionPersistence(req, rememberMe) {
  if (rememberMe) {
    req.session.cookie.maxAge = REMEMBER_ME_MAX_AGE;
    return;
  }

  req.session.cookie.expires = false;
  req.session.cookie.maxAge = null;
}

// ── Auth Routes ───────────────────────────────────────────────────────────────

app.get('/api/auth/csrf', (req, res) => {
  const token = getCsrfToken(req);
  req.session.save(() => res.json({ csrfToken: token }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const user = stmts.findUserById.get(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json(formatUser(user));
});

app.get('/api/auth/settings', (req, res) => {
  const user = stmts.findUserById.get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  let settings = {};
  try { settings = JSON.parse(user.client_settings || '{}'); } catch { settings = {}; }
  res.json(normalizeClientSettings(settings));
});

app.patch('/api/auth/settings', (req, res) => {
  const userId = req.session.userId;
  if (isSettingsUpdateBlocked(userId)) {
    return res.status(429).json({ error: 'Too many settings updates. Please slow down.' });
  }
  recordSettingsUpdate(userId);
  const current = stmts.findUserById.get(userId);
  if (!current) return res.status(401).json({ error: 'Not authenticated' });
  let settings = {};
  try { settings = JSON.parse(current.client_settings || '{}'); } catch { settings = {}; }

  const next = normalizeClientSettings(settings);
  if (req.body.wallpaperDataUrl !== undefined) {
    const parsedWallpaper = parseImageDataUrl(req.body.wallpaperDataUrl, MAX_WALLPAPER_BYTES, { allowNull: true });
    if (!parsedWallpaper.ok) {
      return res.status(400).json({ error: getWallpaperValidationError(parsedWallpaper) });
    }
    next.wallpaperDataUrl = parsedWallpaper.dataUrl;
  }
  if (req.body.wallpaperBlur !== undefined) {
    const parsedBlur = parseBoundedInteger(req.body.wallpaperBlur, 0, MAX_WALLPAPER_BLUR, 'Wallpaper blur');
    if (!parsedBlur.ok) return res.status(400).json({ error: parsedBlur.error });
    next.wallpaperBlur = parsedBlur.value;
  }
  if (req.body.wallpaperTransparency !== undefined) {
    const parsedTransparency = parseBoundedInteger(req.body.wallpaperTransparency, 0, MAX_WALLPAPER_TRANSPARENCY, 'Wallpaper transparency');
    if (!parsedTransparency.ok) return res.status(400).json({ error: parsedTransparency.error });
    next.wallpaperTransparency = parsedTransparency.value;
  }
  if (req.body.hideProfileDot !== undefined) {
    next.hideProfileDot = !!req.body.hideProfileDot;
  }

  try {
    stmts.updateUserSettings.run(JSON.stringify(next), userId);
    res.json(next);
  } catch (err) {
    console.error('Settings update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const iconColor = (req.body.iconColor == null || req.body.iconColor === '')
    ? '#4A90D9'
    : normalizeHexColor(req.body.iconColor);
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (username.length < 2 || username.length > 32) {
    return res.status(400).json({ error: 'Username must be 2–32 characters' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (!iconColor) {
    return res.status(400).json({ error: 'Invalid icon color format' });
  }
  if (isRegisterBlocked(clientIp)) {
    return res.status(429).json({ error: 'Too many registration attempts. Please try again later.' });
  }
  recordRegisterAttempt(clientIp);

  const existing = stmts.findUserByUsername.get(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const id = crypto.randomUUID();
    const color = iconColor || '#4A90D9';

    stmts.insertUser.run(id, username, passwordHash, color);
    // Every user is permanently part of GChat Global from registration.
    stmts.insertMember.run(GLOBAL_GROUP_ID, id);
    // v1.3.12: announce new users in GChat Global ("X joined the group chat")
    // so connected clients see the join without waiting for a refresh.
    io.to(GLOBAL_GROUP_ID).emit('member_joined', {
      userId: id,
      username,
      iconColor: color,
      profilePicture: null,
      groupId: GLOBAL_GROUP_ID,
    });
    clearRegisterAttempts(clientIp);

    const user = stmts.findUserById.get(id);
    if (!user) {
      console.error('Registered user record could not be retrieved after registration.');
      return res.status(500).json({ error: 'Internal server error' });
    }

    req.session.userId = id;
    req.session.save(() => {
      res.status(201).json(formatUser(user));
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const { rememberMe } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  // Brute-force protection: block IP after too many failed attempts
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  if (isLoginBlocked(clientIp)) {
    return res.status(429).json({ error: 'Too many failed login attempts. Please try again later.' });
  }

  const user = stmts.findUserByUsername.get(username);
  if (!user) {
    recordFailedLogin(clientIp);
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  try {
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      recordFailedLogin(clientIp);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    clearLoginAttempts(clientIp);

    req.session.userId = user.id;
    setSessionPersistence(req, rememberMe === true);
    req.session.save(() => {
      res.json(formatUser(user));
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// PATCH /api/auth/profile — update username / iconColor / profilePicture
app.patch('/api/auth/profile', (req, res) => {
  const userId = req.session.userId;
  if (isSettingsUpdateBlocked(userId)) {
    return res.status(429).json({ error: 'Too many profile updates. Please slow down.' });
  }
  recordSettingsUpdate(userId);
  const hasProfilePictureUpdate = Object.prototype.hasOwnProperty.call(req.body, 'profilePicture');
  const { profilePicture } = req.body;
  const username = req.body.username === undefined ? undefined : String(req.body.username).trim();
  const iconColor = req.body.iconColor === undefined ? undefined : normalizeHexColor(req.body.iconColor);

  if (username !== undefined) {
    if (typeof username !== 'string' || username.length < 2 || username.length > 32) {
      return res.status(400).json({ error: 'Username must be 2–32 characters' });
    }
    const existing = stmts.findUserByUsername.get(username);
    if (existing && existing.id !== userId) {
      return res.status(409).json({ error: 'Username already taken' });
    }
  }

  if (iconColor !== undefined && !iconColor) {
    return res.status(400).json({ error: 'Invalid icon color format' });
  }

  if (profilePicture !== undefined && profilePicture !== null) {
    const parsedPicture = parseImageDataUrl(profilePicture, MAX_PROFILE_PICTURE_BYTES);
    if (!parsedPicture.ok) {
      return res.status(400).json({ error: getProfilePictureValidationError(parsedPicture) });
    }
  }

  try {
    stmts.updateUser.run({
      username: username || null,
      iconColor: iconColor || null,
      aiDailyTokenLimit: null,
      profilePicture: hasProfilePictureUpdate ? profilePicture : null,
      hasProfilePicture: hasProfilePictureUpdate ? 1 : 0,
      userId,
    });
    const user = stmts.findUserById.get(userId);
    // Update in-memory socket state for all connected sockets of this user
    for (const [, s] of io.sockets.sockets) {
      if (s.userId === userId) {
        s.username = user.username;
        s.iconColor = user.icon_color;
        s.profilePicture = user.profile_picture;
      }
    }
    // Emit user_updated only to rooms (groups) this user belongs to — not globally.
    // This prevents leaking profile data to users who share no groups with them.
    const userGroupIds = stmts.getUserGroupIds.all(userId).map(r => r.group_id);
    const payload = formatUser(user);
    for (const gid of userGroupIds) {
      io.to(gid).emit('user_updated', payload);
    }
    res.json(payload);
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/auth/account — delete account
const deleteAccountTx = db.transaction((userId) => {
  stmts.deleteUserMessageReads.run(userId);
  stmts.deleteUserDisappearingStates.run(userId);
  stmts.deleteUserAiUsageEvents.run(userId);
  stmts.deleteUserPushSubscriptions.run(userId);
  stmts.deleteUserMemberships.run(userId);
  stmts.deleteUser.run(userId);
});

app.delete('/api/auth/account', (req, res) => {
  const userId = req.session.userId;

  try {
    deleteAccountTx(userId);
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  } catch (err) {
    console.error('Account delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/ai/usage', (req, res) => {
  const summary = getAiUsageSnapshotForUser(req.session.userId);
  if (!summary) return res.status(401).json({ error: 'Not authenticated' });
  res.json(summary);
});

app.get('/api/push/vapid-public-key', (req, res) => {
  if (!isPushConfigured()) {
    return res.status(503).json({ error: 'Push notifications are not configured on this server' });
  }
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.get('/api/push/status', (req, res) => {
  const userId = req.session.userId;
  res.json({
    configured: isPushConfigured(),
    subscriptionActive: Math.max(0, Number(stmts.countPushSubscriptionsForUser.get(userId)?.count) || 0) > 0,
    vapidPublicKey: isPushConfigured() ? VAPID_PUBLIC_KEY : '',
    totalUnreadCount: getTotalUnreadCountForUser(userId),
  });
});

app.post('/api/push/subscribe', (req, res) => {
  if (!isPushConfigured()) {
    return res.status(503).json({ error: 'Push notifications are not configured on this server' });
  }
  const parsedSubscription = validatePushSubscriptionPayload(req.body?.subscription);
  if (!parsedSubscription.ok) {
    return res.status(400).json({ error: parsedSubscription.error });
  }
  const existingSubscription = stmts.getPushSubscriptionOwnerByEndpoint.get(parsedSubscription.value.endpoint);
  if (existingSubscription && String(existingSubscription.user_id) !== String(req.session.userId)) {
    return res.status(409).json({ error: 'This device subscription is already attached to another account. Disable notifications on that account first.' });
  }
  try {
    const result = stmts.upsertPushSubscription.run({
      userId: req.session.userId,
      endpoint: parsedSubscription.value.endpoint,
      subscriptionJson: JSON.stringify(parsedSubscription.value),
      userAgent: sanitizePushMetadata(req.body?.userAgent, 512),
      platform: sanitizePushMetadata(req.body?.platform, 255),
    });
    if (result.changes === 0) {
      return res.status(409).json({ error: 'This device subscription is already attached to another account. Disable notifications on that account first.' });
    }
    res.json({
      ok: true,
      subscriptionActive: true,
      totalUnreadCount: getTotalUnreadCountForUser(req.session.userId),
    });
  } catch (err) {
    console.error('Push subscription save error:', err);
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

app.post('/api/push/unsubscribe', (req, res) => {
  const endpoint = sanitizePushMetadata(req.body?.endpoint, 2048);
  if (!endpoint) {
    return res.status(400).json({ error: 'Subscription endpoint is required' });
  }
  stmts.deletePushSubscriptionByEndpointForUser.run(req.session.userId, endpoint);
  res.json({
    ok: true,
    subscriptionActive: Math.max(0, Number(stmts.countPushSubscriptionsForUser.get(req.session.userId)?.count) || 0) > 0,
    totalUnreadCount: getTotalUnreadCountForUser(req.session.userId),
  });
});

// ── Admin Routes ──────────────────────────────────────────────────────────────

const adminDeleteUserTx = db.transaction((targetUserId, nextOwnerId) => {
  const targetUser = stmts.findUserById.get(targetUserId);
  if (!targetUser) return null;
  const memberships = stmts.getUserGroupIds.all(targetUserId).map((row) => row.group_id);
  const reassignedGroupIds = stmts.getGroupsCreatedByUser.all(targetUserId).map((row) => row.id);
  const ownerJoinedGroupIds = [];
  for (const groupId of reassignedGroupIds) {
    stmts.updateGroupOwner.run(nextOwnerId, groupId);
    const joined = stmts.insertMember.run(groupId, nextOwnerId);
    if (joined.changes > 0) ownerJoinedGroupIds.push(groupId);
  }
  stmts.deleteUserMessageReads.run(targetUserId);
  stmts.deleteUserDisappearingStates.run(targetUserId);
  stmts.deleteUserAiUsageEvents.run(targetUserId);
  stmts.deleteUserPushSubscriptions.run(targetUserId);
  stmts.deleteUserMemberships.run(targetUserId);
  stmts.deleteUser.run(targetUserId);
  return {
    username: targetUser.username,
    groupIds: memberships,
    reassignedGroupIds,
    ownerJoinedGroupIds,
  };
});

app.get('/api/admin/users', (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'Admin endpoint disabled. Set ADMIN_SECRET environment variable to enable.' });
  }
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  // Use timing-safe comparison to prevent timing-based secret enumeration
  const secretBuf = Buffer.from(secret);
  const tokenBuf  = Buffer.from(token);
  const valid = token.length === secret.length &&
    crypto.timingSafeEqual(tokenBuf, secretBuf);
  if (!valid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const users = stmts.getAllUsers.all();
  res.json(users.map(u => ({
    id: u.id,
    username: u.username,
    iconColor: u.icon_color,
    createdAt: u.created_at,
  })));
});

app.get('/api/users/management', (req, res) => {
  const viewer = stmts.findUserById.get(req.session.userId);
  if (!viewer) return res.status(401).json({ error: 'Not authenticated' });
  const canManage = isAppOwnerUser(viewer);
  const usageWindow = getAiUsageWindow();
  const globalUsage = stmts.getGlobalAiUsageInWindow.get(usageWindow.startIso, usageWindow.endIso) || {};
  const globalLimit = getGlobalAiDailyTokenLimit();
  const users = stmts.getAllUsers.all().map((user) => formatManagedUser(user, usageWindow));
  res.json({
    users,
    viewerCanManageAiLimits: canManage,
    viewerCanDeleteUsers: canManage,
    global: {
      dailyLimit: globalLimit,
      usedTokens: roundAiTokenAmount(globalUsage.total_tokens),
      remainingTokens: roundAiTokenAmount(Math.max(0, globalLimit - roundAiTokenAmount(globalUsage.total_tokens))),
      exceeded: globalLimit <= 0 || roundAiTokenAmount(globalUsage.total_tokens) >= globalLimit,
    },
    window: usageWindow,
  });
});

app.patch('/api/users/:userId/ai-limit', (req, res) => {
  const viewer = stmts.findUserById.get(req.session.userId);
  if (!isAppOwnerUser(viewer)) {
    return res.status(403).json({ error: 'Only Furina can change user AI limits' });
  }
  const targetUser = stmts.findUserById.get(req.params.userId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });
  const parsedLimit = parseAiDailyTokenLimit(req.body.dailyLimit, 'Daily AI token limit');
  if (!parsedLimit.ok) return res.status(400).json({ error: parsedLimit.error });

  stmts.updateUser.run({
    username: null,
    iconColor: null,
    aiDailyTokenLimit: parsedLimit.value,
    profilePicture: null,
    hasProfilePicture: 0,
    userId: targetUser.id,
  });

  const updated = stmts.findUserById.get(targetUser.id);
  res.json({
    ok: true,
    user: formatManagedUser(updated, getAiUsageWindow()),
  });
});

app.patch('/api/ai/global-limit', (req, res) => {
  const viewer = stmts.findUserById.get(req.session.userId);
  if (!isAppOwnerUser(viewer)) {
    return res.status(403).json({ error: 'Only Furina can change the global AI limit' });
  }
  const parsedLimit = parseAiDailyTokenLimit(req.body.dailyLimit, 'Global daily AI token limit');
  if (!parsedLimit.ok) return res.status(400).json({ error: parsedLimit.error });
  setGlobalAiDailyTokenLimit(parsedLimit.value);
  const usageWindow = getAiUsageWindow();
  const globalUsage = stmts.getGlobalAiUsageInWindow.get(usageWindow.startIso, usageWindow.endIso) || {};
  res.json({
    ok: true,
    global: {
      dailyLimit: parsedLimit.value,
      usedTokens: roundAiTokenAmount(globalUsage.total_tokens),
      remainingTokens: roundAiTokenAmount(Math.max(0, parsedLimit.value - roundAiTokenAmount(globalUsage.total_tokens))),
      exceeded: parsedLimit.value <= 0 || roundAiTokenAmount(globalUsage.total_tokens) >= parsedLimit.value,
    },
    window: usageWindow,
  });
});

app.delete('/api/users/:userId', (req, res) => {
  const viewer = stmts.findUserById.get(req.session.userId);
  if (!isAppOwnerUser(viewer)) {
    return res.status(403).json({ error: 'Only Furina can delete users' });
  }
  const targetUser = stmts.findUserById.get(req.params.userId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });
  if (isAppOwnerUser(targetUser)) {
    return res.status(400).json({ error: 'Furina cannot be deleted from the user list' });
  }

  const deleted = adminDeleteUserTx(targetUser.id, viewer.id);
  if (!deleted) return res.status(404).json({ error: 'User not found' });

  for (const groupId of deleted.ownerJoinedGroupIds) {
    // v1.3.12: the viewer inherits these groups — previous messages gain ticks.
    bumpGroupDeliveryTotals(groupId);
    io.to(groupId).emit('member_joined', {
      userId: viewer.id,
      username: viewer.username,
      iconColor: viewer.icon_color,
      profilePicture: viewer.profile_picture || null,
      groupId,
    });
  }
  for (const groupId of deleted.reassignedGroupIds) {
    io.to(groupId).emit('group_owner_transferred', {
      groupId,
      createdBy: viewer.id,
    });
  }
  for (const groupId of deleted.groupIds) {
    io.to(groupId).emit('member_left', {
      userId: targetUser.id,
      username: deleted.username,
      groupId,
    });
  }
  io.emit('user_deleted', { userId: targetUser.id });
  for (const [, socket] of io.sockets.sockets) {
    if (socket.userId !== targetUser.id) continue;
    socket.emit('account_deleted', { userId: targetUser.id });
    socket.disconnect(true);
  }
  res.json({ ok: true });
});

// ── Group Routes ──────────────────────────────────────────────────────────────

app.post('/api/groups/create', (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
  const keyCommitment = typeof req.body.keyCommitment === 'string' ? req.body.keyCommitment.trim() : '';
  const secret = typeof req.body.secret === 'string' ? req.body.secret.trim() : '';
  const userId = req.session.userId;

  if (!name || !code || !keyCommitment || !secret) {
    return res.status(400).json({ error: 'Group name, join code, encryption key, and key commitment are required' });
  }
  if (name.length < 1 || name.length > 64) {
    return res.status(400).json({ error: 'Group name must be 1–64 characters' });
  }
  let codeHash;
  let normalizedCode;
  let escrow;
  try {
    codeHash = hashJoinCode(code, APP_CONFIG.groupCodePepper);
    normalizedCode = normalizeJoinCode(code);
    if (!codeHash) throw new Error('Join code must be 8-64 lowercase letters, numbers, or hyphens');
    if (!isValidKeyCommitment(keyCommitment)) throw new Error('Invalid key commitment');
    if (!isValidGroupSecret(secret)) throw new Error('Invalid group encryption key');
    if (!safeEqualString(keyCommitmentForSecret(secret), keyCommitment)) throw new Error('Key commitment does not match encryption key');
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  if ((stmts.countUserGroupsNonGlobal.get(userId, GLOBAL_GROUP_ID)?.count || 0) >= MAX_GROUPS_PER_USER) {
    return res.status(409).json({ error: `You can belong to at most ${MAX_GROUPS_PER_USER} groups` });
  }

  const existing = stmts.findGroupByCode.get(codeHash);
  if (existing) {
    return res.status(409).json({ error: 'Group code already in use' });
  }

  const groupId = crypto.randomUUID();
  try {
    escrow = encryptEscrowPayload(APP_CONFIG.groupKeyEscrowMasterKey, groupId, { secret, joinCode: normalizedCode });
    createEscrowedGroupTx({ id: groupId, name, codeHash, keyCommitment, escrow }, userId);
  } catch (error) {
    console.error('Group creation error:', error.message);
    return res.status(500).json({ error: 'Failed to create group' });
  }

  const group = stmts.findGroupById.get(groupId);
  res.status(201).json(buildGroupPayload(group));
});

app.post('/api/groups/join', (req, res) => {
  const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
  const userId = req.session.userId;

  if (!code) {
    return res.status(400).json({ error: 'An invite code is required' });
  }

  let codeHash;
  try {
    codeHash = hashJoinCode(code, APP_CONFIG.groupCodePepper);
    if (!codeHash) throw new Error('Invalid join code');
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const group = stmts.findGroupByCode.get(codeHash);
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }
  if (!group.key_escrow_ciphertext || !group.key_escrow_iv || !group.key_escrow_version) {
    return res.status(410).json({ error: 'This legacy group has been reset' });
  }
  const existingMembership = stmts.isMember.get(group.id, userId);
  if (!existingMembership && (stmts.countUserGroupsNonGlobal.get(userId, GLOBAL_GROUP_ID)?.count || 0) >= MAX_GROUPS_PER_USER) {
    return res.status(409).json({ error: `You can belong to at most ${MAX_GROUPS_PER_USER} groups` });
  }
  if (!existingMembership && (stmts.countGroupMembers.get(group.id)?.count || 0) >= MAX_GROUP_MEMBERS) {
    return res.status(409).json({ error: `This group has reached its ${MAX_GROUP_MEMBERS}-member limit` });
  }

  const joined = stmts.insertMember.run(group.id, userId);

  // Emit member_joined to the group room
  if (joined.changes > 0) {
    // v1.3.12: every previous message gains a delivery tick.
    bumpGroupDeliveryTotals(group.id);
    const user = stmts.findUserById.get(userId);
    io.to(group.id).emit('member_joined', {
      userId,
      username: user.username,
      iconColor: user.icon_color,
      profilePicture: user.profile_picture || null,
      groupId: group.id,
    });
  }

  let escrowPayload;
  try {
    escrowPayload = decryptEscrowPayload(APP_CONFIG.groupKeyEscrowMasterKey, group.id, {
      ciphertext: group.key_escrow_ciphertext,
      iv: group.key_escrow_iv,
      version: group.key_escrow_version,
    });
  } catch (error) {
    console.error('Group join key recovery error:', error.message);
    return res.status(500).json({ error: 'Failed to recover group key' });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ...buildGroupPayload(group, existingMembership),
    alreadyJoined: joined.changes === 0,
    secret: escrowPayload.secret,
  });
});

// Returns one bounded batch of decryptable key material for the caller's current memberships.
// The payload is intentionally no-store: it contains group secrets and join codes.
app.get('/api/groups/keys', (req, res) => {
  const rows = stmts.getEscrowedKeyMaterialForUser.all(req.session.userId, MAX_GROUPS_PER_USER + 1);
  try {
    const keys = rows.map((row) => {
      const payload = decryptEscrowPayload(APP_CONFIG.groupKeyEscrowMasterKey, row.id, {
        ciphertext: row.key_escrow_ciphertext,
        iv: row.key_escrow_iv,
        version: row.key_escrow_version,
      });
      return { groupId: row.id, ...payload };
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ keys });
  } catch (error) {
    console.error('Group key escrow recovery error:', error.message);
    return res.status(500).json({ error: 'Failed to recover group keys' });
  }
});

app.get('/api/groups/mine', (req, res) => {
  const userId = req.session.userId;
  const groups = stmts.getUserGroups.all(userId);
  res.json(
    groups.map((g) => buildGroupPayload(g, { is_admin: g.is_admin }, g.unread_count))
  );
});

app.get('/api/groups/preload', (req, res) => {
  const userId = req.session.userId;
  const requestedLimit = Number(req.query.limit);
  const safeLimit = Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 50;
  const limit = Math.min(Math.max(safeLimit, 1), 100);
  markExpiredDisappearingMessagesHidden(userId);
  const groups = stmts.getUserGroups.all(userId);
  res.json(
    groups.map((g) => {
      const rows = stmts.getLastMessages
        .all({ viewerId: userId, groupId: g.id, limit })
        .reverse()
        .map(formatMessage);
      const decoratedRows = decorateReplyTargetState(rows);
      const members = stmts.getGroupMembers.all(g.id).map((u) => ({
        id: u.id,
        username: u.username,
        iconColor: u.icon_color,
        profilePicture: u.profile_picture || null,
        isAdministrator: !!u.is_admin,
      }));
      return {
        ...buildGroupPayload(g, { is_admin: g.is_admin }, g.unread_count),
        preloaded: {
          messages: decoratedRows,
          members,
        },
      };
    })
  );
});

// GET /api/groups/invite-candidates/:targetUserId — groups the viewer belongs to
// that the target user is NOT a member of (bounded to MAX_GROUPS_PER_USER + 1).
app.get('/api/groups/invite-candidates/:targetUserId', (req, res) => {
  const { targetUserId } = req.params;
  const userId = req.session.userId;
  if (!targetUserId) return res.status(400).json({ error: 'Target user is required' });
  const target = stmts.findUserById.get(targetUserId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const rows = stmts.getInviteCandidateGroups.all(userId, targetUserId);
  res.json(
    rows.map((group) => ({
      id: group.id,
      name: group.name,
      groupColor: group.group_color || null,
      groupIcon: group.group_icon || null,
      isGlobal: String(group.id) === GLOBAL_GROUP_ID,
      isOwnedByViewer: String(group.created_by) === String(userId),
    }))
  );
});

// POST /api/groups/:groupId/invite — add a user to a group (owner, administrator,
// or any member while "Invite members" is enabled; always on for GChat Global).
app.post('/api/groups/:groupId/invite', (req, res) => {
  const { groupId } = req.params;
  const userId = req.session.userId;
  const targetUserId = typeof req.body?.userId === 'string' ? req.body.userId : '';

  if (!targetUserId) {
    return res.status(400).json({ error: 'User to invite is required' });
  }

  const group = stmts.findGroupById.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const member = stmts.isMember.get(groupId, userId);
  if (!member) return res.status(403).json({ error: 'Not a member of this group' });

  const isGlobalGroup = String(groupId) === GLOBAL_GROUP_ID;
  if (isGlobalGroup) {
    return res.status(400).json({ error: 'GChat Global already includes every user' });
  }

  const target = stmts.findUserById.get(targetUserId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (String(targetUserId) === String(userId)) {
    return res.status(400).json({ error: 'You cannot invite yourself' });
  }

  if (stmts.isMember.get(groupId, targetUserId)) {
    return res.status(409).json({ error: `${target.username} is already a member of this chat` });
  }

  const isOwner = String(group.created_by) === String(userId);
  const isAdministrator = !!member.is_admin;
  const canMemberInvite = group.allow_member_invite == null ? true : !!group.allow_member_invite;
  if (!isOwner && !isAdministrator && !canMemberInvite) {
    return res.status(403).json({ error: 'Members cannot invite others while "Invite members" is disabled' });
  }

  if ((stmts.countUserGroupsNonGlobal.get(targetUserId, GLOBAL_GROUP_ID)?.count || 0) >= MAX_GROUPS_PER_USER) {
    return res.status(409).json({ error: `${target.username} is already in the maximum number of groups` });
  }
  if ((stmts.countGroupMembers.get(groupId)?.count || 0) >= MAX_GROUP_MEMBERS) {
    return res.status(409).json({ error: `This group has reached its ${MAX_GROUP_MEMBERS}-member limit` });
  }

  const joined = stmts.insertMember.run(groupId, targetUserId);
  if (joined.changes > 0) {
    // v1.3.12: every previous message gains a delivery tick; "joined" is only
    // announced for genuinely new memberships.
    bumpGroupDeliveryTotals(groupId);
    io.to(groupId).emit('member_joined', {
      userId: targetUserId,
      username: target.username,
      iconColor: target.icon_color,
      profilePicture: target.profile_picture || null,
      groupId,
    });
  }

  // Give the invitee everything needed to render the new chat immediately,
  // including the escrowed group secret (same payload as join-by-code).
  let secret = null;
  try {
    const escrowPayload = decryptEscrowPayload(APP_CONFIG.groupKeyEscrowMasterKey, group.id, {
      ciphertext: group.key_escrow_ciphertext,
      iv: group.key_escrow_iv,
      version: group.key_escrow_version,
    });
    secret = escrowPayload.secret;
  } catch (error) {
    console.error('Group invite key recovery error:', error.message);
  }
  emitToUser(targetUserId, 'group_invited', {
    ...buildGroupPayload(group),
    secret,
  });

  res.json({ ok: true });
});

// PATCH /api/groups/:groupId/name — rename group (all members)
app.patch('/api/groups/:groupId/name', (req, res) => {
  const { groupId } = req.params;
  const userId = req.session.userId;
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';

  const member = stmts.isMember.get(groupId, userId);
  if (!member) return res.status(403).json({ error: 'Not a member of this group' });

  if (String(groupId) === GLOBAL_GROUP_ID) {
    return res.status(400).json({ error: 'GChat Global cannot be renamed' });
  }

  if (!name || name.length < 1 || name.length > 64) {
    return res.status(400).json({ error: 'Group name must be 1–64 characters' });
  }

  stmts.updateGroupName.run(name, groupId);
  io.to(groupId).emit('group_renamed', { groupId, newName: name });
  res.json({ ok: true });
});

// PATCH /api/groups/:groupId/settings — update group settings (owner or administrator)
app.patch('/api/groups/:groupId/settings', (req, res) => {
  const { groupId } = req.params;
  const userId = req.session.userId;
  const { allowMemberClear, allowMemberClearTag, allowMemberExport, allowMemberKick, allowMemberInvite, aiEnabled, groupColor, groupIcon } = req.body;

  const group = stmts.findGroupById.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (String(groupId) === GLOBAL_GROUP_ID) {
    return res.status(403).json({ error: 'GChat Global has no administrator and its permissions are fixed' });
  }
  const membership = stmts.isMember.get(groupId, userId);
  const isOwner = String(group.created_by) === String(userId);
  if (!isOwner && !membership?.is_admin) {
    return res.status(403).json({ error: 'Only the group owner or an administrator can change settings' });
  }
  const nextAllowMemberClear = allowMemberClear !== undefined
    ? !!allowMemberClear
    : !!group.allow_member_clear;

  if (allowMemberClear !== undefined) {
    stmts.updateGroupAllowMemberClear.run(allowMemberClear ? 1 : 0, groupId);
    if (allowMemberClear) {
      stmts.updateGroupAllowMemberClearTag.run(1, groupId);
    }
  }
  if (allowMemberClearTag !== undefined && !nextAllowMemberClear) {
    stmts.updateGroupAllowMemberClearTag.run(allowMemberClearTag ? 1 : 0, groupId);
  }
  if (allowMemberExport !== undefined) {
    stmts.updateGroupAllowMemberExport.run(allowMemberExport ? 1 : 0, groupId);
  }
  if (allowMemberKick !== undefined) {
    stmts.updateGroupAllowMemberKick.run(allowMemberKick ? 1 : 0, groupId);
  }
  if (allowMemberInvite !== undefined) {
    stmts.updateGroupAllowMemberInvite.run(allowMemberInvite ? 1 : 0, groupId);
  }
  if (APP_CONFIG.aiEnabled && aiEnabled !== undefined) {
    stmts.updateGroupAiEnabled.run(aiEnabled ? 1 : 0, groupId);
  }
  if (groupColor !== undefined) {
    if (groupColor !== null && (typeof groupColor !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(groupColor))) {
      return res.status(400).json({ error: 'Invalid group color format' });
    }
    stmts.updateGroupColor.run(groupColor, groupId);
  }
  if (groupIcon !== undefined) {
    if (groupIcon !== null) {
      const parsedIcon = parseImageDataUrl(groupIcon, MAX_PROFILE_PICTURE_BYTES);
      if (!parsedIcon.ok) return res.status(400).json({ error: getProfilePictureValidationError(parsedIcon) });
    }
    stmts.updateGroupIcon.run(groupIcon, groupId);
  }
  const updated = stmts.findGroupById.get(groupId);
  io.to(groupId).emit('group_settings_updated', {
    groupId,
    allowMemberClear: !!updated.allow_member_clear,
    allowMemberClearTag: !!updated.allow_member_clear_tag,
    allowMemberExport: !!updated.allow_member_export,
    allowMemberKick: !!updated.allow_member_kick,
    allowMemberInvite: updated.allow_member_invite == null ? true : !!updated.allow_member_invite,
    aiEnabled: APP_CONFIG.aiEnabled && !!updated.ai_enabled,
    groupColor: updated.group_color || null,
    groupIcon: updated.group_icon || null,
  });
  res.json({ ok: true });
});

// GET /api/groups/:groupId/messages — paginated messages
app.get('/api/groups/:groupId/messages', (req, res) => {
  const { groupId } = req.params;
  const userId = req.session.userId;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const before = req.query.before || null;

  const member = stmts.isMember.get(groupId, userId);
  if (!member) {
    return res.status(403).json({ error: 'Not a member of this group' });
  }

  markExpiredDisappearingMessagesHidden(userId);

  let rows;
  if (before) {
    rows = stmts.getMessagesBefore.all({
      beforeId: before,
      viewerId: userId,
      groupId,
      limit,
    }).reverse();
  } else if (req.query.since) {
    // Normalize a legacy space-separated cursor ("YYYY-MM-DD HH:MM:SS") to the
    // ISO format now stored in the DB, so a stale client cursor can never
    // silently exclude newer messages from the incremental sync.
    let since = String(req.query.since).slice(0, 64);
    if (since.length === 19 && since[10] === ' ') {
      since = `${since.slice(0, 10)}T${since.slice(11)}.000Z`;
    }
    // v1.3.12: composite cursor — (created_at, id) so messages sharing the
    // cursor's millisecond are included deterministically instead of skipped.
    const sinceId = String(req.query.sinceId || '').slice(0, 64);
    rows = stmts.getMessagesAfter.all({
      since,
      sinceId,
      viewerId: userId,
      groupId,
      limit,
    });
  } else {
    rows = stmts.getLastMessages.all({
      viewerId: userId,
      groupId,
      limit,
    }).reverse();
  }

  res.json(decorateReplyTargetState(rows.map(formatMessage)));
});

// GET /api/groups/:groupId/messages/:messageId — single message for quote
// hydration when the quoted message is outside the client's loaded window.
app.get('/api/groups/:groupId/messages/:messageId', (req, res) => {
  const { groupId, messageId } = req.params;
  const userId = req.session.userId;

  if (!stmts.isMember.get(groupId, userId)) {
    return res.status(403).json({ error: 'Not a member of this group' });
  }

  markExpiredDisappearingMessagesHidden(userId);

  const row = stmts.getSingleMessage.get({ messageId, viewerId: userId, groupId });
  if (!row) return res.status(404).json({ error: 'Message not found' });
  res.json(formatMessage(row));
});

// GET /api/groups/:groupId/unread — per-channel unread counts (capped at 999)
// for the caller, keyed by blind tag_index ('' = #main). The caller supplies
// the tag indexes of the channels it can display (the server cannot read the
// encrypted channel topics); #main is always included. One indexed, bounded
// query per tag — never a full-group scan.
app.get('/api/groups/:groupId/unread', (req, res) => {
  const { groupId } = req.params;
  const userId = req.session.userId;
  if (!stmts.isMember.get(groupId, userId)) {
    return res.status(403).json({ error: 'Not a member of this group' });
  }
  markExpiredDisappearingMessagesHidden(userId);
  const tags = String(req.query.tags || '')
    .split(',')
    .map((tag) => tag.trim().slice(0, 64))
    .filter(Boolean)
    .slice(0, 60);
  const readChannelCount = (tagIndex) => {
    const row = stmts.getChannelUnreadCount.get({ groupId, viewerId: userId, tagIndex });
    return Math.min(999, Math.max(0, Number(row?.count) || 0));
  };
  const counts = { '': readChannelCount(null) };
  for (const tag of tags) counts[tag] = readChannelCount(tag);
  res.json({ counts });
});

// DELETE /api/groups/:groupId/messages — clear all messages (owner, or members if allowed)
// Furina (the app owner) can also clear GChat Global, which has no owner.
app.delete('/api/groups/:groupId/messages', (req, res) => {
  const { groupId } = req.params;
  const userId = req.session.userId;

  const group = stmts.findGroupById.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const member = stmts.isMember.get(groupId, userId);
  if (!member) return res.status(403).json({ error: 'Not a member of this group' });

  const viewer = stmts.findUserById.get(userId);
  const isOwner = group.created_by === userId;
  const isGlobalOwner = String(groupId) === GLOBAL_GROUP_ID && isAppOwnerUser(viewer);
  if (!isOwner && !isGlobalOwner && !member.is_admin && !group.allow_member_clear) {
    return res.status(403).json({ error: 'Only the group owner can clear chat history' });
  }

  stmts.deleteGroupMessages.run(groupId);
  io.to(groupId).emit('chat_cleared', { groupId });
  res.json({ ok: true });
});

// DELETE /api/groups/:groupId/tags/:tagIndex/messages — clear one channel.
// Furina (the app owner) can also delete channels in GChat Global.
app.delete('/api/groups/:groupId/tags/:tagIndex/messages', (req, res) => {
  const { groupId, tagIndex } = req.params;
  const userId = req.session.userId;

  const group = stmts.findGroupById.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const member = stmts.isMember.get(groupId, userId);
  if (!member) return res.status(403).json({ error: 'Not a member of this group' });

  if (!/^[A-Za-z0-9_-]{43}$/.test(tagIndex)) return res.status(400).json({ error: 'Invalid tag index' });

  const viewer = stmts.findUserById.get(userId);
  const isOwner = group.created_by === userId;
  const isGlobalOwner = String(groupId) === GLOBAL_GROUP_ID && isAppOwnerUser(viewer);
  if (!isOwner && !isGlobalOwner && !member.is_admin && !group.allow_member_clear && !group.allow_member_clear_tag) {
    return res.status(403).json({ error: 'Only the group owner can clear this hashtag' });
  }

  stmts.deleteMessagesByTagIndex.run(groupId, tagIndex);
  io.to(groupId).emit('tag_cleared', { groupId, tagIndex });
  res.json({ ok: true });
});

app.delete('/api/groups/:groupId/messages/:messageId', (req, res) => {
  const { groupId, messageId } = req.params;
  const userId = req.session.userId;
  if (!stmts.isMember.get(groupId, userId)) {
    return res.status(403).json({ error: 'Not a member of this group' });
  }
  const message = stmts.findMessageById.get(messageId);
  if (!message || message.group_id !== groupId) {
    return res.status(404).json({ error: 'Message not found' });
  }
  // In GChat Global any member may delete any message.
  const isGlobalGroup = String(groupId) === GLOBAL_GROUP_ID;
  if (message.sender_id !== userId && !isGlobalGroup) {
    return res.status(403).json({ error: 'Only the author can delete this message' });
  }
  if (message.is_disappearing) {
    return res.status(403).json({ error: 'Disappearing messages cannot be deleted' });
  }
  deleteMessageTx(messageId);
  io.to(groupId).emit('message_deleted', { groupId, messageId });
  return res.json({ ok: true, messageId });
});

app.patch('/api/groups/:groupId/messages/:messageId', (req, res) => {
  const { groupId, messageId } = req.params;
  const userId = req.session.userId;
  if (!stmts.isMember.get(groupId, userId)) {
    return res.status(403).json({ error: 'Not a member of this group' });
  }
  const current = stmts.findMessageById.get(messageId);
  if (!current || current.group_id !== groupId) {
    return res.status(404).json({ error: 'Message not found' });
  }
  if (current.sender_id !== userId) {
    return res.status(403).json({ error: 'Only the author can edit this message' });
  }
  if (current.is_disappearing) {
    return res.status(403).json({ error: 'Disappearing messages cannot be edited' });
  }
  if (!['text', 'whisper'].includes(current.type)) {
    return res.status(400).json({ error: 'This message type cannot be edited' });
  }
  const envelope = validateEditEnvelope(req.body, current.revision || 1);
  if (!envelope.ok) {
    const latest = envelope.status === 409 ? formatMessage(current) : undefined;
    return res.status(envelope.status).json({ error: envelope.error, latest });
  }
  const contentCheck = validateEncryptedTextPayload(req.body.encryptedContent, req.body.iv);
  if (!contentCheck.ok) return res.status(400).json({ error: contentCheck.error });
  const metadataCheck = validateEncryptedTextPayload(req.body.encryptedMetadata, req.body.metadataIv);
  if (!metadataCheck.ok) return res.status(400).json({ error: `Metadata: ${metadataCheck.error}` });
  const indexEnvelope = validateV2MessageEnvelope({
    ...req.body,
    id: messageId,
    revision: 1,
    replyToId: current.reply_to_id,
  });
  if (!indexEnvelope.ok) return res.status(400).json({ error: indexEnvelope.error });
  const editedAt = new Date().toISOString();
  const result = stmts.updateV2Message.run(
    req.body.encryptedContent,
    req.body.iv,
    req.body.encryptedMetadata,
    req.body.metadataIv,
    req.body.tagIndex || null,
    req.body.spamSignature || null,
    envelope.revision,
    editedAt,
    messageId,
    Number(req.body.expectedRevision)
  );
  if (!result.changes) {
    const latest = stmts.findMessageById.get(messageId);
    return res.status(409).json({ error: 'Message was edited elsewhere', latest: formatMessage(latest) });
  }
  const updated = formatMessage(stmts.findMessageById.get(messageId));
  io.to(groupId).emit('message_edited', updated);
  return res.json(updated);
});

// DELETE /api/groups/:groupId/leave — leave group (non-owner)
app.delete('/api/groups/:groupId/leave', (req, res) => {
  const { groupId } = req.params;
  const userId = req.session.userId;

  const group = stmts.findGroupById.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const member = stmts.isMember.get(groupId, userId);
  if (!member) return res.status(403).json({ error: 'Not a member of this group' });

  if (String(groupId) === GLOBAL_GROUP_ID) {
    return res.status(400).json({ error: 'You cannot leave GChat Global' });
  }

  if (group.created_by === userId) {
    return res.status(400).json({ error: 'Group owner cannot leave. Disband the group instead.' });
  }

  stmts.deleteMember.run(groupId, userId);
  // v1.3.12: a departing member's per-channel read cursors are gone with them.
  stmts.deleteChannelReadCursorsForGroupUser.run(groupId, userId);

  const user = stmts.findUserById.get(userId);
  io.to(groupId).emit('member_left', {
    userId,
    username: user ? user.username : 'Unknown',
    groupId,
  });

  res.json({ ok: true });
});

// GET /api/groups/:groupId/members — list group members
app.get('/api/groups/:groupId/members', (req, res) => {
  const { groupId } = req.params;
  const userId = req.session.userId;

  const member = stmts.isMember.get(groupId, userId);
  if (!member) {
    return res.status(403).json({ error: 'Not a member of this group' });
  }

  const members = stmts.getGroupMembers.all(groupId);
  res.json(
    members.map((u) => ({
      id: u.id,
      username: u.username,
      iconColor: u.icon_color,
      profilePicture: u.profile_picture || null,
      isAdministrator: !!u.is_admin,
    }))
  );
});

// PATCH /api/groups/:groupId/members/:userId/administrator — owner-only role management
app.patch('/api/groups/:groupId/members/:userId/administrator', (req, res) => {
  const { groupId, userId: targetUserId } = req.params;
  const userId = req.session.userId;
  const group = stmts.findGroupById.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (String(group.created_by) !== String(userId)) {
    return res.status(403).json({ error: 'Only the group owner can manage administrators' });
  }
  if (String(targetUserId) === String(group.created_by)) {
    return res.status(400).json({ error: 'The group owner already has full access' });
  }
  const targetMember = stmts.isMember.get(groupId, targetUserId);
  if (!targetMember) return res.status(404).json({ error: 'Member not found' });

  const isAdministrator = req.body.isAdministrator === true;
  stmts.updateMemberAdmin.run(isAdministrator ? 1 : 0, groupId, targetUserId);
  io.to(groupId).emit('member_role_updated', { groupId, userId: targetUserId, isAdministrator });
  res.json({ ok: true, isAdministrator });
});

// POST /api/groups/:groupId/upload — upload encrypted file or image
app.post('/api/groups/:groupId/upload', uploadRawBodyParser, (req, res) => {
  const { groupId } = req.params;
  const userId = req.session.userId;

  const member = stmts.isMember.get(groupId, userId);
  if (!member) {
    return res.status(403).json({ error: 'Not a member of this group' });
  }

  const isBinaryUpload = Buffer.isBuffer(req.body);
  let encryptedContent = null;
  let iv = null;
  let type = null;
  let clientUploadId = null;
  let messageId = null;
  let encryptedMetadata = null;
  let metadataIv = null;
  let tagIndex = null;

  if (isBinaryUpload) {
    encryptedContent = req.body.toString('base64');
    iv = typeof req.headers['x-upload-iv'] === 'string' ? req.headers['x-upload-iv'] : null;
    type = typeof req.headers['x-upload-type'] === 'string' ? req.headers['x-upload-type'] : null;
    messageId = typeof req.headers['x-message-id'] === 'string' ? req.headers['x-message-id'] : null;
    encryptedMetadata = typeof req.headers['x-encrypted-metadata'] === 'string' ? req.headers['x-encrypted-metadata'] : null;
    metadataIv = typeof req.headers['x-metadata-iv'] === 'string' ? req.headers['x-metadata-iv'] : null;
    tagIndex = typeof req.headers['x-tag-index'] === 'string' ? req.headers['x-tag-index'] : null;
    clientUploadId = typeof req.headers['x-client-upload-id'] === 'string' ? req.headers['x-client-upload-id'] : null;
  } else {
    ({ encryptedContent, iv, type, clientUploadId, messageId, encryptedMetadata, metadataIv, tagIndex } = req.body || {});
  }

  if (!encryptedContent || typeof encryptedContent !== 'string' || !iv || typeof iv !== 'string') {
    return res.status(400).json({ error: 'encryptedContent and iv are required' });
  }

  const msgType = type === 'file' || type === 'image' ? type : null;
  if (!msgType) {
    return res.status(400).json({ error: 'Invalid upload type' });
  }
  if (!isValidIv(iv)) {
    return res.status(400).json({ error: 'Invalid upload encryption metadata' });
  }
  if (!isValidBase64(encryptedContent)) {
    return res.status(400).json({ error: 'Invalid upload payload' });
  }

  const envelope = validateV2MessageEnvelope({
    id: messageId,
    encryptionVersion: req.headers['x-encryption-version'] || req.body?.encryptionVersion,
    keyVersion: req.headers['x-key-version'] || req.body?.keyVersion,
    revision: 1,
    tagIndex,
  });
  if (!envelope.ok) return res.status(400).json({ error: envelope.error });
  const metadataCheck = validateEncryptedTextPayload(encryptedMetadata, metadataIv);
  if (!metadataCheck.ok) return res.status(400).json({ error: `Metadata: ${metadataCheck.error}` });

  const encryptedBytes = estimateBase64Bytes(encryptedContent);
  if (encryptedBytes <= 0) {
    return res.status(400).json({ error: 'Upload payload is empty' });
  }
  if (encryptedBytes > MAX_ATTACHMENT_BYTES) {
    return res.status(413).json({ error: 'Attachment too large (max 15MB)' });
  }
  const msgId = messageId;
  const createdAt = new Date().toISOString();
  const user = stmts.findUserById.get(userId);
  const totalRecipients = Math.max(0, (stmts.countGroupMembers.get(groupId)?.count || 0) - 1);

  try {
    stmts.insertV2Message.run(
      msgId,
      groupId,
      userId,
      encryptedContent,
      iv,
      msgType,
      null,
      null,
      0,
      null,
      totalRecipients,
      2,
      1,
      1,
      encryptedMetadata,
      metadataIv,
      tagIndex || null,
      null,
      createdAt
    );
  } catch (err) {
    console.error('DB insert file error:', err);
    return res.status(500).json({ error: 'Failed to save file' });
  }

  const payload = {
    id: msgId,
    groupId,
    senderId: userId,
    senderName: user.username,
    senderColor: user.icon_color,
    encryptedContent,
    iv,
    encryptedMetadata,
    metadataIv,
    encryptionVersion: 2,
    keyVersion: 1,
    revision: 1,
    type: msgType,
    replyTo: null,
    filename: null,
    whisperTo: null,
    hashtag: null,
    tagIndex: tagIndex || null,
    aiMeta: null,
    aiMention: false,
    isDisappearing: false,
    disappearingDurationMs: 0,
    disappearingStartedAt: null,
    disappearingExpiresAt: null,
    disappearingHiddenAt: null,
    createdAt,
    editedAt: null,
    totalRecipients,
    readCount: 0,
    clientUploadId: typeof clientUploadId === 'string' ? clientUploadId.slice(0, 128) : null,
  };

  io.to(groupId).emit('new_message', payload);
  queueUnreadPushNotifications(
    stmts.getOtherGroupMemberIds.all(groupId, userId)
      .map((row) => row.user_id),
    { senderName: user.username, groupName: getGroupNameForPush(groupId) }
  );
  res.json({ messageId: msgId });
});

// Keep backward-compat alias
app.post('/api/groups/:groupId/upload-image', (req, res) => {
  req.url = `/api/groups/${req.params.groupId}/upload`;
  app.handle(req, res);
});

// DELETE /api/groups/:groupId/members/:userId — kick a member
app.delete('/api/groups/:groupId/members/:userId', (req, res) => {
  const { groupId, userId: targetUserId } = req.params;
  const userId = req.session.userId;

  const member = stmts.isMember.get(groupId, userId);
  if (!member) return res.status(403).json({ error: 'Not a member of this group' });

  const group = stmts.findGroupById.get(groupId);
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }

  if (targetUserId === userId) {
    return res.status(400).json({ error: 'You cannot kick yourself' });
  }

  if (String(targetUserId) === String(group.created_by)) {
    return res.status(403).json({ error: 'Group owner cannot be kicked' });
  }

  const isOwner = String(group.created_by) === String(userId);
  const isAdministrator = !!member.is_admin;
  const canMemberKick = !!group.allow_member_kick;
  if (!isOwner && !isAdministrator && !canMemberKick) {
    return res.status(403).json({ error: 'Only the group owner can kick members' });
  }

  const targetMember = stmts.isMember.get(groupId, targetUserId);
  if (!targetMember) {
    return res.status(404).json({ error: 'Member not found' });
  }
  if (!isOwner && targetMember.is_admin) {
    return res.status(403).json({ error: 'Administrators cannot remove other administrators' });
  }

  stmts.deleteMember.run(groupId, targetUserId);
  // v1.3.12: a removed member's read cursors are gone with them.
  stmts.deleteChannelReadCursorsForGroupUser.run(groupId, targetUserId);
  detachUserFromGroupRoom(groupId, targetUserId);
  io.to(groupId).emit('member_kicked', { userId: targetUserId, groupId });
  res.json({ ok: true });
});

// DELETE /api/groups/:groupId — disband group (owner only)
app.delete('/api/groups/:groupId', (req, res) => {
  const { groupId } = req.params;
  const userId = req.session.userId;

  const group = stmts.findGroupById.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.created_by !== userId) {
    return res.status(403).json({ error: 'Only the group owner can disband this group' });
  }

  stmts.deleteGroupMessages.run(groupId);
  stmts.deleteGroupMembers.run(groupId);
  // v1.3.12: read cursors belong to the group — wiped with it.
  stmts.deleteChannelReadCursorsByGroup.run(groupId);
  stmts.deleteGroup.run(groupId);

  io.to(groupId).emit('group_disbanded', { groupId });
  res.json({ ok: true });
});

app.post('/api/groups/:groupId/ai/chat', async (req, res) => {
  const { groupId } = req.params;
  const userId = req.session.userId;
  const selectedModel = normalizeAiModel(req.body.model);
  const apiConfig = getAiApiConfig(selectedModel);
  const providerLabel = getAiProviderLabel(selectedModel);
  if (!apiConfig.apiKey) {
    return res.status(503).json({ error: 'AI assistant is not configured on this server' });
  }

  const group = stmts.findGroupById.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!stmts.isMember.get(groupId, userId)) {
    return res.status(403).json({ error: 'Not a member of this group' });
  }
  if (!group.ai_enabled) {
    return res.status(403).json({ error: 'AI mode is disabled by the group owner' });
  }

  const prompt = sanitizeAiText(req.body.prompt, MAX_AI_PROMPT_CHARS);
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  const quotaSummary = getAiUsageSnapshotForUser(userId);
  const quotaError = getAiLimitError(quotaSummary);
  if (quotaError) {
    return res.status(429).json({ error: quotaError, aiUsage: quotaSummary });
  }

  const selectedMode = normalizeAiMode(req.body.mode);
  const selectedTone = normalizeAiTone(req.body.tone);
  const normalizedContext = normalizeAiContextMessages(selectedMode === 'thinking' ? req.body.contextMessages : []);
  if (!normalizedContext.ok) {
    return res.status(400).json({ error: normalizedContext.error });
  }

  const transcript = selectedMode === 'thinking'
    ? buildAiTranscript(
      normalizedContext.value,
      sanitizeAiText(req.body.groupName, 64) || group.name
    )
    : '';
  const userPrompt = selectedMode === 'thinking' && transcript
    ? `${transcript}\n\nUser request:\n${prompt}`
    : prompt;
  const messages = [
    {
      role: 'system',
      content: buildAiSystemPrompt(selectedTone),
    },
    {
      role: 'user',
      content: userPrompt,
    },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  try {
    const origin = typeof req.headers.origin === 'string' && /^https?:\/\//.test(req.headers.origin)
      ? req.headers.origin
      : null;
    const upstream = await fetch(apiConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiConfig.apiKey}`,
        ...(apiConfig.provider === 'getgoapi'
          ? { 'x-api-key': apiConfig.apiKey }
          : {
              'X-Title': 'GChat',
              ...(origin ? { 'HTTP-Referer': origin } : {}),
            }),
      },
      body: JSON.stringify(buildAiRequestBody(selectedModel, apiConfig.provider, messages)),
      signal: controller.signal,
    });
    const payload = await upstream.json().catch(() => ({}));
    const debug = extractOpenRouterDebugMeta(upstream, payload);
    if (!upstream.ok) {
      const errorMessage = getOpenRouterErrorMessage(payload, providerLabel);
      console.warn('AI upstream error:', {
        ...debug,
        providerLabel,
        errorMessage,
      });
      const status = upstream.status === 429 ? 429 : 502;
      return res.status(status).json({ error: errorMessage, debug });
    }

    const answer = extractOpenRouterText(payload?.choices?.[0]?.message?.content);
    if (!answer) {
      console.warn('AI returned empty content:', debug);
      return res.status(502).json({ error: 'AI returned an empty response', debug });
    }

    const usage = extractOpenRouterUsage(payload);
    const standardizedUsage = convertModelUsageToStandardTokens(usage, selectedModel);
    const directCostUsd = extractOpenRouterCostUsd(payload);
    const estimatedCostUsd = directCostUsd ?? estimateOpenRouterCostUsd(usage, selectedModel);
    const aiMeta = sanitizeAiMessageMeta({
      model: getOpenRouterResponseModel(payload, selectedModel),
      mode: selectedMode,
      tone: selectedTone,
      webSearchEnabled: false,
      webSearchRequests: 0,
      promptTokens: standardizedUsage.promptTokens,
      completionTokens: standardizedUsage.completionTokens,
      totalTokens: standardizedUsage.totalTokens,
      rawPromptTokens: standardizedUsage.rawPromptTokens,
      rawCompletionTokens: standardizedUsage.rawCompletionTokens,
      rawTotalTokens: standardizedUsage.rawTotalTokens,
      estimatedCostUsd,
      estimatedCostRmb: convertUsdToRmb(estimatedCostUsd),
      costSource: directCostUsd != null ? 'upstream' : 'estimated',
    });

    if (aiMeta && aiMeta.totalTokens > 0) {
      try {
        stmts.insertAiUsageEvent.run(
          crypto.randomUUID(),
          userId,
          groupId,
          aiMeta.promptTokens,
          aiMeta.completionTokens,
          aiMeta.totalTokens,
          new Date().toISOString()
        );
      } catch (recordErr) {
        console.error('Failed to record AI token usage:', recordErr);
      }
    }
    const updatedUsage = getAiUsageSnapshotForUser(userId);

    res.json({
      ok: true,
      model: aiMeta?.model || selectedModel,
      answer,
      aiMeta,
      aiUsage: updatedUsage,
      debug,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return res.status(504).json({ error: 'AI request timed out' });
    }
    console.error('AI request error:', {
      name: err?.name || 'Error',
      message: sanitizeAiText(err?.message, 240) || 'Unknown error',
      code: sanitizeAiText(err?.code, 64),
      providerLabel,
    });
    res.status(502).json({ error: `Failed to contact ${providerLabel}` });
  } finally {
    clearTimeout(timeout);
  }
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────

// Per-room presence tracking: groupId -> Set<socketId>
const roomPresence = new Map();

function addPresence(groupId, socketId) {
  if (!roomPresence.has(groupId)) roomPresence.set(groupId, new Set());
  roomPresence.get(groupId).add(socketId);
}

function removePresence(groupId, socketId) {
  if (roomPresence.has(groupId)) {
    roomPresence.get(groupId).delete(socketId);
    if (roomPresence.get(groupId).size === 0) roomPresence.delete(groupId);
  }
}

function getPresence(groupId) {
  return roomPresence.has(groupId) ? [...roomPresence.get(groupId)] : [];
}

function emitPresenceUpdate(groupId) {
  const presenceSockets = getPresence(groupId);
  const onlineUserIds = new Set();
  for (const sid of presenceSockets) {
    const s = io.sockets.sockets.get(sid);
    if (s) onlineUserIds.add(s.userId);
  }
  io.to(groupId).emit('presence_update', {
    groupId,
    onlineUserIds: [...onlineUserIds],
  });
}

/** Drop a user from a group room + presence (kick / leave / disband). */
function detachUserFromGroupRoom(groupId, userId) {
  for (const socket of io.sockets.sockets.values()) {
    if (String(socket.userId) !== String(userId)) continue;
    if (socket.joinedRooms instanceof Set) socket.joinedRooms.delete(groupId);
    if (socket.currentRoom === groupId) socket.currentRoom = null;
    if (socket.rooms.has(groupId)) {
      removePresence(groupId, socket.id);
      socket.leave(groupId);
    }
  }
  emitPresenceUpdate(groupId);
}

function emitToUser(userId, event, payload) {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.userId === userId) socket.emit(event, payload);
  }
}

// v1.3.9: single read-receipt path used by mark_message_read (per-message) and
// mark_messages_read (batched). Fan-out is scoped to the author's per-user
// room instead of the whole group room — read updates only matter to the
// sender of the message.
function recordMessageRead(socket, groupId, messageId) {
  if (!groupId || !messageId) return;
  const member = stmts.isMember.get(groupId, socket.userId);
  if (!member) return;
  const message = stmts.findMessageById.get(messageId);
  if (!message || message.group_id !== groupId) return;
  if (message.sender_id === socket.userId) return;
  if (message.type === 'whisper') {
    let recipients = [];
    try {
      recipients = JSON.parse(message.whisper_to || '[]');
    } catch {
      return;
    }
    if (!Array.isArray(recipients) || !recipients.map(String).includes(String(socket.userId))) return;
  }
  stmts.markMessageRead.run(messageId, socket.userId);
  const readCount = Math.max(0, Number(stmts.getMessageReadCount.get(messageId)?.count) || 0);
  io.to(`user:${message.sender_id}`).emit('message_read_update', { messageId, readCount });
}

function canUserAccessMessage(message, userId) {
  if (!message || !userId) return false;
  if (String(message.sender_id) === String(userId)) return true;
  if (message.type !== 'whisper') return true;
  try {
    const recipients = JSON.parse(message.whisper_to || '[]');
    const uid = String(userId);
    return Array.isArray(recipients) && recipients.some(r => String(r) === uid);
  } catch {
    return false;
  }
}

// Share the express session with Socket.IO
io.use((socket, next) => {
  const fakeRes = {
    getHeader: () => {},
    setHeader: () => {},
    end: () => {},
  };
  sessionMiddleware(socket.request, socket.request.res || fakeRes, next);
});

// Authenticate socket connections
io.use((socket, next) => {
  const userId = socket.request.session && socket.request.session.userId;
  if (!userId) {
    return next(new Error('Not authenticated'));
  }
  socket.userId = userId;
  const user = stmts.findUserById.get(userId);
  if (!user) {
    return next(new Error('User not found'));
  }
  socket.username = user.username;
  socket.iconColor = user.icon_color;
  socket.profilePicture = user.profile_picture;
  next();
});

io.on('connection', (socket) => {
  // v1.3.12: belt-and-braces — a connected socket must NEVER lack a userId
  // (a recovered socket would otherwise act as a ghost member: rooms intact,
  // sends rejected as "Not a member"). Re-resolve identity from the handshake
  // session, or drop the connection.
  if (!socket.userId) {
    const sessionUserId = socket.request.session && socket.request.session.userId;
    const sessionUser = sessionUserId ? stmts.findUserById.get(sessionUserId) : null;
    if (!sessionUser) {
      console.warn('[socket] dropping unauthenticated connection');
      socket.disconnect(true);
      return;
    }
    socket.userId = sessionUserId;
    socket.username = sessionUser.username;
    socket.iconColor = sessionUser.icon_color;
    socket.profilePicture = sessionUser.profile_picture;
  }
  console.log(`Socket connected: ${socket.username} (${socket.userId})`);
  // v1.3.9: per-user room so targeted events (read receipts, edit/delete
  // confirmation) fan out to exactly one user's devices instead of a group.
  socket.join(`user:${socket.userId}`);
  // ── join_room ──────────────────────────────────────────────────────────────
  socket.on('join_room', (groupId) => {
    if (!groupId) return;
    const normalizedGroupId = String(groupId);

    const member = stmts.isMember.get(normalizedGroupId, String(socket.userId));
    if (!member) {
      socket.emit('group_join_denied', {
        groupId: normalizedGroupId,
        message: 'Not a member of this group',
      });
      return;
    }

    markExpiredDisappearingMessagesHidden(socket.userId);

    // Multi-room presence: stay joined to every group the client has opened.
    // Switching chats must not drop presence (or realtime) in other groups.
    if (!socket.joinedRooms) socket.joinedRooms = new Set();
    socket.currentRoom = normalizedGroupId;
    if (!socket.rooms.has(normalizedGroupId)) {
      socket.join(normalizedGroupId);
    }
    socket.joinedRooms.add(normalizedGroupId);
    addPresence(normalizedGroupId, socket.id);

    const presenceSockets = getPresence(normalizedGroupId);
    const onlineUserIds = new Set();
    for (const sid of presenceSockets) {
      const s = io.sockets.sockets.get(sid);
      if (s) onlineUserIds.add(s.userId);
    }
    io.to(normalizedGroupId).emit('presence_update', {
      groupId: normalizedGroupId,
      onlineUserIds: [...onlineUserIds],
    });

    console.log(`${socket.username} joined room ${normalizedGroupId}`);
  });

  socket.on('channel_announce', ({ groupId, channel, action } = {}) => {
    if (!groupId || !channel) return;
    const normalizedGroupId = String(groupId);
    const member = stmts.isMember.get(normalizedGroupId, String(socket.userId));
    if (!member) return;
    const topic = String(channel).trim().replace(/^#/, '').toLowerCase().slice(0, 12);
    if (!/^[a-z0-9_-]+$/.test(topic) || topic === 'main') return;
    const nextAction = action === 'remove' ? 'remove' : 'add';
    io.to(normalizedGroupId).emit('channel_announced', {
      groupId: normalizedGroupId,
      channel: topic,
      action: nextAction,
      byUserId: socket.userId,
    });
  });

  socket.on('attachment_upload_progress', ({ groupId, uploadId, type, filename, totalBytes, loadedBytes }) => {
    if (!groupId || !uploadId) return;
    const member = stmts.isMember.get(groupId, socket.userId);
    if (!member) return;
    io.to(groupId).emit('attachment_upload_progress', {
      groupId,
      uploadId: String(uploadId).slice(0, 128),
      type: type === 'file' ? 'file' : 'image',
      filename: typeof filename === 'string' ? filename.slice(0, 255) : null,
      totalBytes: Math.max(1, Number(totalBytes) || 1),
      loadedBytes: Math.max(0, Number(loadedBytes) || 0),
      senderId: socket.userId,
      senderName: socket.username,
      senderColor: socket.iconColor,
    });
  });

  socket.on('attachment_upload_failed', ({ groupId, uploadId }) => {
    if (!groupId || !uploadId) return;
    const member = stmts.isMember.get(groupId, socket.userId);
    if (!member) return;
    io.to(groupId).emit('attachment_upload_failed', {
      groupId,
      uploadId: String(uploadId).slice(0, 128),
      senderId: socket.userId,
    });
  });

  // ── send_message ──────────────────────────────────────────────────────────
  socket.on('send_message', (payload = {}, ack) => {
    const {
      id,
      groupId,
      encryptedContent,
      iv,
      encryptedMetadata,
      metadataIv,
      replyToId,
      tagIndex,
      isDisappearing,
      disappearingDurationMs,
      spamSignature,
      encryptionVersion,
      keyVersion,
      revision,
      aiMention,
      aiMeta,
    } = payload;
    const fail = (message) => {
      socket.emit('error', { message });
      if (typeof ack === 'function') ack({ ok: false, error: message });
    };
    // v1.3.12: defensive — a socket without identity must never reach the
    // membership check (recovered sockets used to fail as "Not a member").
    if (!socket.userId) {
      fail('Not authenticated');
      return;
    }
    if (!groupId) {
      fail('Group ID is required');
      return;
    }

    const envelope = validateV2MessageEnvelope(payload);
    if (!envelope.ok) {
      fail(envelope.error);
      return;
    }

    const payloadCheck = validateEncryptedTextPayload(encryptedContent, iv);
    if (!payloadCheck.ok) {
      fail(payloadCheck.error);
      return;
    }

    const metadataCheck = validateEncryptedTextPayload(encryptedMetadata, metadataIv);
    if (!metadataCheck.ok) {
      fail(`Metadata: ${metadataCheck.error}`);
      return;
    }
    const normalizedIsDisappearing = !!isDisappearing;
    const normalizedDisappearingDuration = normalizedIsDisappearing
      ? normalizeDisappearingDuration(disappearingDurationMs)
      : null;
    if (normalizedIsDisappearing && normalizedDisappearingDuration == null) {
      fail('Invalid disappearing message duration');
      return;
    }

    const group = stmts.findGroupById.get(groupId);
    if (!group) {
      fail('Group not found');
      return;
    }
    if (Number(group.encryption_version) !== ENCRYPTION_VERSION) {
      fail('This group must be recreated for encryption v2');
      return;
    }

    const member = stmts.isMember.get(groupId, socket.userId);
    if (!member) {
      fail('Not a member of this group');
      return;
    }

    if (replyToId) {
      const target = stmts.findMessageById.get(replyToId);
      // A missing target means the quoted message was deleted; accept the
      // reply anyway so quotes never hard-fail at send time. Only enforce
      // the same-group rule when the target still exists.
      if (target && target.group_id !== groupId) {
        fail('Reply target not found');
        return;
      }
    }

    const msgId = id;
    const createdAt = new Date().toISOString();
    const totalRecipients = Math.max(0, (stmts.countGroupMembers.get(groupId)?.count || 0) - 1);

    try {
      stmts.insertV2Message.run(
        msgId,
        groupId,
        socket.userId,
        encryptedContent,
        iv,
        'text',
        replyToId || null,
        null,
        normalizedIsDisappearing ? 1 : 0,
        normalizedDisappearingDuration,
        totalRecipients,
        encryptionVersion,
        keyVersion,
        revision,
        encryptedMetadata,
        metadataIv,
        tagIndex || null,
        spamSignature || null,
        createdAt
      );
    } catch (err) {
      console.error('DB insert message error:', err);
      fail('Failed to save message');
      return;
    }

    // v1.3.9: persist AI-prompt markers (Ask AI prompt messages) — previously
    // aiMention/aiMeta were silently dropped and prompts lost their AI chips.
    const normalizedAiMeta = sanitizeAiMessageMeta(aiMeta);
    if (normalizedAiMeta || aiMention) {
      try {
        stmts.setAiMessageMeta.run(
          normalizedAiMeta ? JSON.stringify(normalizedAiMeta) : null,
          aiMention ? 1 : 0,
          msgId
        );
      } catch (err) {
        console.error('DB update AI meta error:', err);
      }
    }

    const messagePayload = {
      id: msgId,
      groupId,
      senderId: socket.userId,
      senderName: socket.username,
      senderColor: socket.iconColor,
      encryptedContent,
      iv,
      encryptedMetadata,
      metadataIv,
      encryptionVersion,
      keyVersion,
      revision,
      type: 'text',
      replyToId: replyToId || null,
      replyTo: null,
      filename: null,
      whisperTo: null,
      hashtag: null,
      tagIndex: tagIndex || null,
      isDisappearing: normalizedIsDisappearing,
      disappearingDurationMs: normalizedDisappearingDuration || 0,
      disappearingStartedAt: null,
      disappearingExpiresAt: null,
      disappearingHiddenAt: null,
      createdAt,
      editedAt: null,
      totalRecipients,
      readCount: 0,
      aiMention: !!aiMention,
      aiMeta: normalizedAiMeta,
    };

    io.to(groupId).emit('new_message', messagePayload);
    queueUnreadPushNotifications(
      stmts.getOtherGroupMemberIds.all(groupId, socket.userId)
        .map((row) => row.user_id),
      { senderName: socket.username, groupName: getGroupNameForPush(groupId) }
    );
    if (typeof ack === 'function') ack({ ok: true, messageId: msgId });
  });

  socket.on('send_ai_message', (payload = {}, ack) => {
    if (!APP_CONFIG.aiEnabled) {
      const message = 'AI is unavailable in Increment A';
      socket.emit('error', { message });
      if (typeof ack === 'function') ack({ ok: false, error: message });
      return;
    }
    const {
      groupId,
      encryptedContent,
      iv,
      replyTo,
      hashtag,
      aiMeta,
    } = payload;
    const fail = (message) => {
      socket.emit('error', { message });
      if (typeof ack === 'function') ack({ ok: false, error: message });
    };
    // v1.3.12: defensive identity guard (see send_message).
    if (!socket.userId) {
      fail('Not authenticated');
      return;
    }
    if (!groupId) {
      fail('Group ID is required');
      return;
    }

    const group = stmts.findGroupById.get(groupId);
    if (!group) {
      fail('Group not found');
      return;
    }
    if (!group.ai_enabled) {
      fail('AI mode is disabled by the group owner');
      return;
    }

    const member = stmts.isMember.get(groupId, socket.userId);
    if (!member) {
      fail('Not a member of this group');
      return;
    }

    const payloadCheck = validateEncryptedTextPayload(encryptedContent, iv);
    if (!payloadCheck.ok) {
      fail(payloadCheck.error);
      return;
    }

    const replyCheck = normalizeReplyPayload(replyTo, groupId);
    if (!replyCheck.ok) {
      fail(replyCheck.error);
      return;
    }

    const normalizedHashtag = normalizeHashtag(hashtag);
    if (hashtag !== null && hashtag !== undefined && normalizedHashtag === null) {
      fail('Invalid hashtag');
      return;
    }
    const normalizedAiMeta = sanitizeAiMessageMeta(aiMeta);

    const msgId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const totalRecipients = Math.max(0, Number(stmts.countGroupMembers.get(groupId)?.count) || 0);

    try {
      stmts.insertMessage.run(
        msgId,
        groupId,
        AI_ASSISTANT_USER_ID,
        encryptedContent,
        iv,
        'text',
        replyCheck.value,
        null,
        null,
        normalizedHashtag,
        0,
        null,
        totalRecipients,
        normalizedAiMeta ? JSON.stringify(normalizedAiMeta) : null,
        0,
        createdAt
      );
    } catch (err) {
      console.error('DB insert AI message error:', err);
      fail('Failed to save AI message');
      return;
    }

    io.to(groupId).emit('new_message', {
      id: msgId,
      groupId,
      senderId: AI_ASSISTANT_USER_ID,
      senderName: AI_ASSISTANT_NAME,
      senderColor: AI_ASSISTANT_COLOR,
      profilePicture: getAiAssistantProfilePicture(normalizedAiMeta?.model),
      encryptedContent,
      iv,
      type: 'text',
      replyTo: replyCheck.value,
      filename: null,
      whisperTo: null,
      hashtag: normalizedHashtag,
      aiMeta: normalizedAiMeta,
      aiMention: false,
      isDisappearing: false,
      disappearingDurationMs: 0,
      disappearingStartedAt: null,
      disappearingExpiresAt: null,
      disappearingHiddenAt: null,
      createdAt,
      editedAt: null,
      totalRecipients,
      readCount: 0,
    });
    queueUnreadPushNotifications(
      stmts.getGroupMemberIds.all(groupId).map((row) => row.user_id),
      { senderName: socket.username, groupName: getGroupNameForPush(groupId) }
    );
    if (typeof ack === 'function') ack({ ok: true, messageId: msgId });
  });

  // ── send_whisper ──────────────────────────────────────────────────────────
  socket.on('send_whisper', (whisperPayload = {}) => {
    const {
      id, groupId, encryptedContent, iv, encryptedMetadata, metadataIv,
      whisperTo, replyToId, tagIndex, isDisappearing, disappearingDurationMs,
      spamSignature, encryptionVersion, keyVersion, revision,
    } = whisperPayload;
    // v1.3.12: defensive identity guard (see send_message).
    if (!socket.userId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }
    if (!groupId || !Array.isArray(whisperTo)) {
      socket.emit('error', { message: 'Invalid whisper payload' });
      return;
    }
    const envelope = validateV2MessageEnvelope(whisperPayload);
    if (!envelope.ok) {
      socket.emit('error', { message: envelope.error });
      return;
    }

    const member = stmts.isMember.get(groupId, socket.userId);
    if (!member) {
      socket.emit('error', { message: 'Not a member of this group' });
      return;
    }

    const payloadCheck = validateEncryptedTextPayload(encryptedContent, iv);
    if (!payloadCheck.ok) {
      socket.emit('error', { message: payloadCheck.error });
      return;
    }
    const metadataCheck = validateEncryptedTextPayload(encryptedMetadata, metadataIv);
    if (!metadataCheck.ok) {
      socket.emit('error', { message: `Metadata: ${metadataCheck.error}` });
      return;
    }
    if (replyToId) {
      const target = stmts.findMessageById.get(replyToId);
      // Deleted quote targets no longer block the whisper at send time; only
      // enforce the same-group rule when the target still exists.
      if (target && target.group_id !== groupId) {
        socket.emit('error', { message: 'Reply target not found' });
        return;
      }
    }
    const normalizedIsDisappearing = !!isDisappearing;
    const normalizedDisappearingDuration = normalizedIsDisappearing
      ? normalizeDisappearingDuration(disappearingDurationMs)
      : null;
    if (normalizedIsDisappearing && normalizedDisappearingDuration == null) {
      socket.emit('error', { message: 'Invalid disappearing message duration' });
      return;
    }

    const recipients = normalizeWhisperRecipients(whisperTo);
    if (recipients.length === 0) {
      socket.emit('error', { message: 'Select at least one whisper recipient.' });
      return;
    }
    if (recipients.every((recipId) => recipId === socket.userId)) {
      socket.emit('error', { message: 'Whispers must target at least one other group member.' });
      return;
    }
    const recipientsExcludingSender = recipients.filter((recipId) => recipId !== socket.userId);

    // Validate that every whisper recipient is a member of this group
    for (const recipId of recipients) {
      if (recipId === socket.userId) continue;
      if (!stmts.isMember.get(groupId, String(recipId))) {
        socket.emit('error', { message: 'One or more whisper recipients are not group members.' });
        return;
      }
    }

    const msgId = id;
    const createdAt = new Date().toISOString();
    const totalRecipients = Math.max(0, recipientsExcludingSender.length);
    // Store whisper recipients as JSON array for safety
    const whisperToStr = JSON.stringify(recipientsExcludingSender);

    try {
      stmts.insertV2Message.run(
        msgId,
        groupId,
        socket.userId,
        encryptedContent,
        iv,
        'whisper',
        replyToId || null,
        whisperToStr,
        normalizedIsDisappearing ? 1 : 0,
        normalizedDisappearingDuration,
        totalRecipients,
        encryptionVersion,
        keyVersion,
        revision,
        encryptedMetadata,
        metadataIv,
        // v1.3.9: persist the client-computed tag index for whispers so channel
        // clears remove them from the DB too (previously always NULL → whispers
        // survived tag clears and resurrected after a resync).
        tagIndex || null,
        spamSignature || null,
        createdAt
      );
    } catch (err) {
      console.error('DB insert whisper error:', err);
      socket.emit('error', { message: 'Failed to save whisper' });
      return;
    }

    const payload = {
      id: msgId,
      groupId,
      senderId: socket.userId,
      senderName: socket.username,
      senderColor: socket.iconColor,
      encryptedContent,
      iv,
      encryptedMetadata,
      metadataIv,
      encryptionVersion,
      keyVersion,
      revision,
      type: 'whisper',
      replyToId: replyToId || null,
      replyTo: null,
      filename: null,
      whisperTo: whisperToStr,
      hashtag: null,
      tagIndex: tagIndex || null,
      aiMeta: null,
      aiMention: false,
      isDisappearing: normalizedIsDisappearing,
      disappearingDurationMs: normalizedDisappearingDuration || 0,
      disappearingStartedAt: null,
      disappearingExpiresAt: null,
      disappearingHiddenAt: null,
      createdAt,
      editedAt: null,
      totalRecipients,
      readCount: 0,
    };

    // Send to sender + recipients only
    const recipientIds = new Set([socket.userId, ...recipients]);
    const roomSockets = getPresence(groupId);
    for (const sid of roomSockets) {
      const s = io.sockets.sockets.get(sid);
      if (s && recipientIds.has(s.userId)) {
        s.emit('new_message', payload);
      }
    }
    queueUnreadPushNotifications(recipientsExcludingSender, {
      senderName: socket.username,
      groupName: getGroupNameForPush(groupId),
    });
  });

  socket.on('mark_message_read', ({ groupId, messageId }) => {
    try {
      recordMessageRead(socket, groupId, messageId);
    } catch (error) {
      console.error('mark_message_read failed for message', messageId, error.message);
    }
  });

  // v1.3.12: per-channel read cursor — "everything up to (createdAt, messageId)
  // in this channel is read". Advances the caller's cursor, recomputes the
  // bounded per-channel and per-group unread counts, and broadcasts them to
  // every one of the user's devices (badges and channel chips stay in sync
  // across devices without any local per-message read flags).
  socket.on('mark_channel_read', ({ groupId, tagIndex, createdAt, messageId }) => {
    try {
      if (!groupId || !createdAt) return;
      const normalizedGroupId = String(groupId).slice(0, 64);
      const member = stmts.isMember.get(normalizedGroupId, socket.userId);
      if (!member) return;
      const normalizedTag = (tagIndex && typeof tagIndex === 'string') ? tagIndex.slice(0, 64) : null;
      const normalizedAt = String(createdAt).slice(0, 64);
      const normalizedId = String(messageId || '').slice(0, 64);
      stmts.upsertChannelReadCursor.run(
        normalizedGroupId,
        socket.userId,
        normalizedTag,
        normalizedAt,
        normalizedId,
        new Date().toISOString()
      );
      const channelRow = stmts.getChannelUnreadCount.get({
        groupId: normalizedGroupId,
        viewerId: socket.userId,
        tagIndex: normalizedTag,
      });
      const groupRow = stmts.getGroupUnreadCount.get({
        groupId: normalizedGroupId,
        viewerId: socket.userId,
      });
      io.to(`user:${socket.userId}`).emit('read_cursor_updated', {
        groupId: normalizedGroupId,
        tagIndex: normalizedTag,
        createdAt: normalizedAt,
        messageId: normalizedId,
        channelUnreadCount: Math.min(999, Math.max(0, Number(channelRow?.count) || 0)),
        groupUnreadCount: Math.min(999, Math.max(0, Number(groupRow?.count) || 0)),
      });
    } catch (error) {
      console.error('mark_channel_read failed:', error.message);
    }
  });

  // v1.3.9: batched variant — one emit covers a whole scroll viewport instead
  // of one emit per row. Bounded to 100 message ids per packet.
  // v1.3.11: per-message guard so a single malformed id can never throw an
  // uncaught better-sqlite3 binding error inside a socket handler (which
  // would crash the entire server).
  socket.on('mark_messages_read', ({ groupId, messageIds = [] }) => {
    if (!groupId || !Array.isArray(messageIds)) return;
    const uniqueIds = [...new Set(messageIds.map(String).filter(Boolean))].slice(0, 100);
    for (const messageId of uniqueIds) {
      try {
        recordMessageRead(socket, groupId, messageId);
      } catch (error) {
        console.error('mark_messages_read failed for message', messageId, error.message);
      }
    }
  });

  socket.on('start_disappearing_timer', ({ groupId, messageId }) => {
    if (!groupId || !messageId) return;
    const member = stmts.isMember.get(groupId, socket.userId);
    if (!member) return;
    markExpiredDisappearingMessagesHidden(socket.userId);
    const message = stmts.findMessageById.get(messageId);
    if (!message || message.group_id !== groupId || !message.is_disappearing) return;
    if (!canUserAccessMessage(message, socket.userId) || String(message.sender_id) === String(socket.userId)) return;

    let state = stmts.findDisappearingState.get(messageId, socket.userId);
    if (!state) {
      const startedAt = new Date().toISOString();
      const duration = resolveStoredDisappearingDurationMs(message);
      const expiresAt = new Date(Date.now() + duration).toISOString();
      stmts.insertDisappearingState.run(messageId, socket.userId, startedAt, expiresAt, null);
      state = stmts.findDisappearingState.get(messageId, socket.userId);
    } else if (!state.started_at || !state.expires_at) {
      const startedAt = new Date().toISOString();
      const duration = resolveStoredDisappearingDurationMs(message);
      const expiresAt = new Date(Date.now() + duration).toISOString();
      stmts.updateDisappearingStateStart.run(startedAt, expiresAt, messageId, socket.userId);
      state = stmts.findDisappearingState.get(messageId, socket.userId);
    }

    emitToUser(socket.userId, 'disappearing_state_updated', {
      groupId,
      messageId,
      startedAt: state?.started_at || null,
      expiresAt: state?.expires_at || null,
      hiddenAt: state?.hidden_at || null,
    });
  });

  socket.on('hide_disappearing_message', ({ groupId, messageId }) => {
    if (!groupId || !messageId) return;
    const member = stmts.isMember.get(groupId, socket.userId);
    if (!member) return;
    const message = stmts.findMessageById.get(messageId);
    if (!message || message.group_id !== groupId || !message.is_disappearing) return;
    if (!canUserAccessMessage(message, socket.userId) || String(message.sender_id) === String(socket.userId)) return;

    const hiddenAt = new Date().toISOString();
    let state = stmts.findDisappearingState.get(messageId, socket.userId);
    if (!state) {
      stmts.insertDisappearingState.run(messageId, socket.userId, null, null, hiddenAt);
      state = stmts.findDisappearingState.get(messageId, socket.userId);
    } else {
      stmts.markDisappearingStateHidden.run(hiddenAt, messageId, socket.userId);
      state = stmts.findDisappearingState.get(messageId, socket.userId);
    }

    emitToUser(socket.userId, 'disappearing_state_updated', {
      groupId,
      messageId,
      startedAt: state?.started_at || null,
      expiresAt: state?.expires_at || null,
      hiddenAt: state?.hidden_at || hiddenAt,
    });
  });

  // ── typing ────────────────────────────────────────────────────────────────
  socket.on('typing', ({ groupId }) => {
    if (!groupId) return;
    // Socket is already in the room only if membership was verified at join time.
    // Skip the expensive DB lookup for every keystroke.
    if (!socket.rooms.has(groupId)) return;
    socket.to(groupId).emit('user_typing', { username: socket.username });
  });

  socket.on('stop_typing', ({ groupId }) => {
    if (!groupId) return;
    if (!socket.rooms.has(groupId)) return;
    socket.to(groupId).emit('user_stop_typing', { username: socket.username });
  });

  // ── disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.username}`);

    const rooms = socket.joinedRooms instanceof Set
      ? [...socket.joinedRooms]
      : (socket.currentRoom ? [socket.currentRoom] : []);

    for (const roomId of rooms) {
      removePresence(roomId, socket.id);
      const presenceSockets = getPresence(roomId);
      const onlineUserIds = new Set();
      for (const sid of presenceSockets) {
        const s = io.sockets.sockets.get(sid);
        if (s) onlineUserIds.add(s.userId);
      }
      io.to(roomId).emit('presence_update', {
        groupId: roomId,
        onlineUserIds: [...onlineUserIds],
      });
    }
  });
});

app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    let error = 'Request payload too large';
    if (req.path.includes('/groups/') && req.path.endsWith('/upload')) {
      error = 'Attachment too large (max 15MB)';
    } else if (req.path === '/api/auth/settings') {
      error = 'Wallpaper too large (max 10MB)';
    } else if (req.path === '/api/auth/profile') {
      error = 'Profile picture too large (max 2MB)';
    } else if (req.path.includes('/messages')) {
      error = 'Message payload too large';
    }
    return res.status(413).json({ error });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  console.error('Unhandled request error:', err);
  return res.status(500).json({ error: 'Internal server error' });
});

// ── Start Server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function startServer() {
  await seedLocalDebugData();
  ensureGlobalGroup();
  server.listen(PORT, () => {
    console.log(`Gchat server running on port ${PORT}`);
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('Failed to start Gchat:', err);
    process.exitCode = 1;
  });
}

module.exports = { app, db, io, seedLocalDebugData, server, startServer, stmts };
