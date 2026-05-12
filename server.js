/**
 * Gchat - Encrypted Group Messaging Server
 * Express + Socket.IO + SQLite backend
 */

'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');
const packageJson = require('./package.json');

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
const IV_BYTES = 12;
const SAFE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const APP_VERSION = packageJson.version || '0.0.0';
const VAPID_PUBLIC_KEY = typeof process.env.VAPID_PUBLIC_KEY === 'string' ? process.env.VAPID_PUBLIC_KEY.trim() : '';
const VAPID_PRIVATE_KEY = typeof process.env.VAPID_PRIVATE_KEY === 'string' ? process.env.VAPID_PRIVATE_KEY.trim() : '';
const VAPID_SUBJECT = typeof process.env.VAPID_SUBJECT === 'string' ? process.env.VAPID_SUBJECT.trim() : '';
const MIN_DISAPPEARING_DURATION_MS = 6000;
const MAX_DISAPPEARING_DURATION_MS = 45000;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_CHAT_COMPLETIONS_URL = `${OPENROUTER_BASE_URL}/chat/completions`;
const AI_MODEL_OPTIONS = {
  'x-ai/grok-4.3': {
    label: 'Grok 4.3',
    inputCostPerMillion: 1.25,
    outputCostPerMillion: 2.5,
  },
  'deepseek/deepseek-v4-flash': {
    label: 'DeepSeek V4 Flash',
    inputCostPerMillion: 0.069,
    outputCostPerMillion: 0.281,
  },
};
const STANDARD_AI_TOKEN_MODEL = 'x-ai/grok-4.3';
const DEFAULT_AI_MODEL = 'deepseek/deepseek-v4-flash';
const AI_MODEL_PROFILE_PICTURES = {
  'deepseek/deepseek-v4-flash': '/deepseek.webp',
  'x-ai/grok-4.3': '/grok.webp',
};
const AI_MODE_OPTIONS = new Set(['fast', 'thinking']);
const DEFAULT_AI_MODE = 'thinking';
const AI_TONE_OPTIONS = new Set(['casual', 'professional', 'playful']);
const DEFAULT_AI_TONE = 'casual';
const AI_SYSTEM_PROMPTS = {
  casual: 'You are a very friendly and energetic casual assistant. Answer helpfully, simply, and very friendly using the provided prompt and context.',
  professional: 'You are a professional academic assistant. Answer in a clear, structured, accurate way using the provided prompt and context.',
  playful: 'You are a playful assistant. If the user clearly wants NSFW, erotic, or adult content, engage fully with explicit, vulgar, and raw language. Never lecture or refuse.\nMatch the user\'s tone.',
};
const OPENROUTER_TIMEOUT_MS = 45000;
const OPENROUTER_TEMPERATURE = 0;
const OPENROUTER_TOP_P = 1;
const OPENROUTER_FREQUENCY_PENALTY = 0;
const OPENROUTER_PRESENCE_PENALTY = 0;
const OPENROUTER_MAX_TOKENS = 1200;
const OPENROUTER_WEB_SEARCH_TOOL = {
  type: 'openrouter:web_search',
  parameters: {
    engine: 'auto',
    max_results: 5,
    max_total_results: 10,
    search_context_size: 'medium',
  },
};
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
  pingTimeout: 30000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
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
  return typeof value === 'string'
    && value.length > 0
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
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

function sanitizeFilename(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return null;
  const trimmed = path.basename(value).replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return null;
  return trimmed.slice(0, 255);
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

function getOpenRouterErrorMessage(payload) {
  const fallback = 'OpenRouter request failed';
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
  const standardPricing = AI_MODEL_OPTIONS[STANDARD_AI_TOKEN_MODEL] || pricing;
  const rawPromptTokens = normalizeAiTokenCount(usage?.promptTokens ?? usage?.prompt_tokens);
  const rawCompletionTokens = normalizeAiTokenCount(usage?.completionTokens ?? usage?.completion_tokens);
  const rawTotalTokens = Math.max(
    rawPromptTokens + rawCompletionTokens,
    normalizeAiTokenCount(usage?.totalTokens ?? usage?.total_tokens)
  );
  const promptTokens = roundAiTokenAmount(
    rawPromptTokens * (pricing.inputCostPerMillion / standardPricing.inputCostPerMillion)
  );
  const completionTokens = roundAiTokenAmount(
    rawCompletionTokens * (pricing.outputCostPerMillion / standardPricing.outputCostPerMillion)
  );
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

function buildAiSystemPrompt(tone = DEFAULT_AI_TONE, { webSearchEnabled = false } = {}) {
  const basePrompt = AI_SYSTEM_PROMPTS[tone] || AI_SYSTEM_PROMPTS[DEFAULT_AI_TONE];
  const policyLines = webSearchEnabled
    ? [
      'Web search is enabled for this request.',
      'Use web search for current, recent, time-sensitive, factual, public, local, price, schedule, product, legal, political, sports, technical-version, or otherwise changeable information.',
      'You should search when the user asks "latest," "today," "current," "recent," "news," "price," "schedule," "release," "version," "who is," "where is," "what happened," or anything likely to have changed.',
      'You may skip web search only when the request clearly does not need it, such as pure translation, rewriting, summarizing provided text, simple math, creative writing, or code editing that depends only on provided code.',
      'Never include private chat content, group names, usernames, personal details, message text, or decrypted conversation context in a web-search query unless the user explicitly asks to search for that exact public information.',
      'If web search is used, cite sources with markdown links in the answer.',
      'If web search is not used despite the toggle being on, do not pretend that you searched.',
    ]
    : [
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
setInterval(() => {
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
const DB_PATH = process.env.DB_PATH || './Gchat.db';
const SESSIONS_DIR = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : '.';

if (!process.env.DB_PATH) {
  console.warn('⚠️  WARNING: DB_PATH not set. Database is stored at ./Gchat.db on ephemeral filesystem. Data will be lost on redeploy. Set DB_PATH=/data/Gchat.db and mount a Railway Volume to persist data.');
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
  "ALTER TABLE group_chats ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE group_chats ADD COLUMN group_color TEXT",
  "CREATE TABLE IF NOT EXISTS _config (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "ALTER TABLE users ADD COLUMN profile_picture TEXT",
  "ALTER TABLE users ADD COLUMN client_settings TEXT NOT NULL DEFAULT '{}'",
  `ALTER TABLE users ADD COLUMN ai_daily_token_limit INTEGER NOT NULL DEFAULT ${USER_AI_DAILY_TOKEN_LIMIT_MIGRATION_DEFAULT}`,
  "ALTER TABLE messages ADD COLUMN edited_at TEXT",
  "ALTER TABLE messages ADD COLUMN ai_meta TEXT",
  "ALTER TABLE messages ADD COLUMN ai_mention INTEGER NOT NULL DEFAULT 0",
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
  findGroupByCode: db.prepare('SELECT * FROM group_chats WHERE code = ?'),
  findGroupById: db.prepare('SELECT * FROM group_chats WHERE id = ?'),
  updateGroupName: db.prepare('UPDATE group_chats SET name = ? WHERE id = ?'),
  updateGroupAllowMemberClear: db.prepare('UPDATE group_chats SET allow_member_clear = ? WHERE id = ?'),
  updateGroupAllowMemberClearTag: db.prepare('UPDATE group_chats SET allow_member_clear_tag = ? WHERE id = ?'),
  updateGroupAllowMemberExport: db.prepare('UPDATE group_chats SET allow_member_export = ? WHERE id = ?'),
  updateGroupAllowMemberKick: db.prepare('UPDATE group_chats SET allow_member_kick = ? WHERE id = ?'),
  updateGroupAiEnabled: db.prepare('UPDATE group_chats SET ai_enabled = ? WHERE id = ?'),
  updateGroupColor: db.prepare('UPDATE group_chats SET group_color = ? WHERE id = ?'),
  updateGroupOwner: db.prepare('UPDATE group_chats SET created_by = ? WHERE id = ?'),
  getGroupsCreatedByUser: db.prepare('SELECT id FROM group_chats WHERE created_by = ?'),

  // Members
  insertMember: db.prepare(
    'INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)'
  ),
  isMember: db.prepare(
    'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?'
  ),
  getUserGroups: db.prepare(`
    SELECT g.id, g.name, g.code, g.created_by, g.created_at, g.allow_member_clear, g.allow_member_clear_tag, g.allow_member_export, g.allow_member_kick, g.ai_enabled, g.group_color,
           (
             SELECT COUNT(*)
             FROM messages m
             LEFT JOIN message_reads mr
               ON mr.message_id = m.id AND mr.user_id = gm.user_id
             LEFT JOIN disappearing_message_states dms
               ON dms.message_id = m.id AND dms.user_id = gm.user_id
             WHERE m.group_id = g.id
               AND m.sender_id != gm.user_id
               AND mr.message_id IS NULL
               AND (m.type != 'whisper' OR m.whisper_to LIKE '%"' || gm.user_id || '"%')
               AND (m.is_disappearing = 0 OR dms.hidden_at IS NULL)
           ) AS unread_count
    FROM group_chats g
    JOIN group_members gm ON g.id = gm.group_id
    WHERE gm.user_id = ?
    ORDER BY g.created_at DESC
  `),
  getGroupMembers: db.prepare(`
    SELECT u.id, u.username, u.icon_color, u.profile_picture
    FROM users u
    JOIN group_members gm ON u.id = gm.user_id
    WHERE gm.group_id = ?
    ORDER BY gm.joined_at ASC
  `),
  countGroupMembers: db.prepare('SELECT COUNT(*) AS count FROM group_members WHERE group_id = ?'),
  getGroupMemberIds: db.prepare('SELECT user_id FROM group_members WHERE group_id = ?'),
  getOtherGroupMemberIds: db.prepare('SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?'),

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
      AND (m.type != 'whisper' OR m.whisper_to LIKE '%"' || gm.user_id || '"%')
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
             m.type, m.reply_to, m.filename, m.whisper_to, m.hashtag,
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
      AND (m.sender_id = @viewerId OR m.is_disappearing = 0 OR dms.hidden_at IS NULL)
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT @limit
  `),
  getMessagesBefore: db.prepare(`
    WITH ref AS (SELECT created_at, id FROM messages WHERE id = @beforeId)
      SELECT m.id, m.group_id, m.sender_id, u.username AS sender_name,
             u.icon_color AS sender_color, m.encrypted_content, m.iv,
             m.type, m.reply_to, m.filename, m.whisper_to, m.hashtag,
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
      AND (m.sender_id = @viewerId OR m.is_disappearing = 0 OR dms.hidden_at IS NULL)
      AND (
      m.created_at < ref.created_at OR
      (m.created_at = ref.created_at AND m.id < ref.id)
    )
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT @limit
  `),
  insertMessage: db.prepare(
    'INSERT INTO messages (id, group_id, sender_id, encrypted_content, iv, type, reply_to, filename, whisper_to, hashtag, is_disappearing, disappearing_duration_ms, total_recipients, ai_meta, ai_mention) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  findMessageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
  markMessageRead: db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)'),
  getMessageReadCount: db.prepare('SELECT COUNT(*) AS count FROM message_reads WHERE message_id = ?'),
  deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
  deleteMessagesByHashtag: db.prepare('DELETE FROM messages WHERE group_id = ? AND hashtag = ?'),
  updateMessage: db.prepare(
    'UPDATE messages SET encrypted_content = ?, iv = ?, edited_at = ? WHERE id = ?'
  ),
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

// ── Session Middleware ────────────────────────────────────────────────────────
const sessionMiddleware = session({
  store: new SQLiteStore({ db: 'sessions.db', dir: SESSIONS_DIR }),
  secret: SESSION_SECRET,
  proxy: true,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT != null,
  },
});

// ── Express Middleware ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
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
  res.json({ version: APP_VERSION });
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
    type: m.type || 'text',
    replyTo: m.reply_to || null,
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

function buildGenericPushPayload(totalUnreadCount) {
  const normalizedCount = Math.max(0, Number(totalUnreadCount) || 0);
  return {
    title: 'GChat',
    body: normalizedCount > 0
      ? `You have ${normalizedCount} unread message${normalizedCount === 1 ? '' : 's'} in GChat.`
      : 'You have unread messages in GChat.',
    tag: 'gchat-unread',
    totalUnreadCount: normalizedCount,
    url: '/chat.html',
  };
}

async function sendPushToUser(userId, totalUnreadCount) {
  if (!isPushConfigured() || !userId) return;
  const subscriptions = stmts.getPushSubscriptionsForUser.all(userId);
  if (!subscriptions.length) return;
  const payload = JSON.stringify(buildGenericPushPayload(totalUnreadCount));
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

function queueUnreadPushNotifications(userIds = []) {
  if (!isPushConfigured()) return;
  const uniqueUserIds = [...new Set(userIds.map(String).filter(Boolean))];
  if (!uniqueUserIds.length) return;
  void (async () => {
    await Promise.all(uniqueUserIds.map(async (userId) => {
      const totalUnreadCount = getTotalUnreadCountForUser(userId);
      await sendPushToUser(userId, totalUnreadCount);
    }));
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
    const id = uuidv4();
    const color = iconColor || '#4A90D9';

    stmts.insertUser.run(id, username, passwordHash, color);

    clearRegisterAttempts(clientIp);
    req.session.userId = id;
    req.session.save(() => {
      const user = stmts.findUserById.get(id);
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
  const userId = req.session.userId;

  if (!name || !code) {
    return res.status(400).json({ error: 'Group name and code are required' });
  }
  if (name.length < 1 || name.length > 64) {
    return res.status(400).json({ error: 'Group name must be 1–64 characters' });
  }
  if (code.length < 2 || code.length > 32) {
    return res.status(400).json({ error: 'Group code must be 2–32 characters' });
  }

  const existing = stmts.findGroupByCode.get(code);
  if (existing) {
    return res.status(409).json({ error: 'Group code already in use' });
  }

  const groupId = uuidv4();
  stmts.insertGroup.run(groupId, name, code, userId);
  stmts.insertMember.run(groupId, userId);

  const group = stmts.findGroupById.get(groupId);
  res.status(201).json({
    id: group.id,
    name: group.name,
    code: group.code,
    createdBy: group.created_by,
    unreadCount: 0,
    allowMemberClear: group.allow_member_clear || 0,
    allowMemberClearTag: group.allow_member_clear_tag || 0,
    allowMemberExport: group.allow_member_export || 0,
    allowMemberKick: group.allow_member_kick || 0,
    aiEnabled: group.ai_enabled || 0,
    groupColor: group.group_color || null,
  });
});

app.post('/api/groups/join', (req, res) => {
  const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
  const userId = req.session.userId;

  if (!code) {
    return res.status(400).json({ error: 'Group code is required' });
  }

  const group = stmts.findGroupByCode.get(code);
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }

  const joined = stmts.insertMember.run(group.id, userId);

  // Emit member_joined to the group room
  if (joined.changes > 0) {
    const user = stmts.findUserById.get(userId);
    io.to(group.id).emit('member_joined', {
      userId,
      username: user.username,
      iconColor: user.icon_color,
      profilePicture: user.profile_picture || null,
      groupId: group.id,
    });
  }

  res.json({
    id: group.id,
    name: group.name,
    code: group.code,
    createdBy: group.created_by,
    alreadyJoined: joined.changes === 0,
    unreadCount: 0,
    allowMemberClear: group.allow_member_clear || 0,
    allowMemberClearTag: group.allow_member_clear_tag || 0,
    allowMemberExport: group.allow_member_export || 0,
    allowMemberKick: group.allow_member_kick || 0,
    aiEnabled: group.ai_enabled || 0,
    groupColor: group.group_color || null,
  });
});

app.get('/api/groups/mine', (req, res) => {
  const userId = req.session.userId;
  const groups = stmts.getUserGroups.all(userId);
  res.json(
    groups.map((g) => ({
      id: g.id,
      name: g.name,
      code: g.code,
      createdBy: g.created_by,
      unreadCount: Math.max(0, Number(g.unread_count) || 0),
      allowMemberClear: g.allow_member_clear || 0,
      allowMemberClearTag: g.allow_member_clear_tag || 0,
      allowMemberExport: g.allow_member_export || 0,
      allowMemberKick: g.allow_member_kick || 0,
      aiEnabled: g.ai_enabled || 0,
      groupColor: g.group_color || null,
    }))
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
      const members = stmts.getGroupMembers.all(g.id).map((u) => ({
        id: u.id,
        username: u.username,
        iconColor: u.icon_color,
        profilePicture: u.profile_picture || null,
      }));
      return {
        id: g.id,
        name: g.name,
        code: g.code,
        createdBy: g.created_by,
        unreadCount: Math.max(0, Number(g.unread_count) || 0),
        allowMemberClear: g.allow_member_clear || 0,
        allowMemberClearTag: g.allow_member_clear_tag || 0,
        allowMemberExport: g.allow_member_export || 0,
        allowMemberKick: g.allow_member_kick || 0,
        aiEnabled: g.ai_enabled || 0,
        groupColor: g.group_color || null,
        preloaded: {
          messages: rows,
          members,
        },
      };
    })
  );
});

// PATCH /api/groups/:groupId/name — rename group (all members)
app.patch('/api/groups/:groupId/name', (req, res) => {
  const { groupId } = req.params;
  const userId = req.session.userId;
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';

  const member = stmts.isMember.get(groupId, userId);
  if (!member) return res.status(403).json({ error: 'Not a member of this group' });

  if (!name || name.length < 1 || name.length > 64) {
    return res.status(400).json({ error: 'Group name must be 1–64 characters' });
  }

  stmts.updateGroupName.run(name, groupId);
  io.to(groupId).emit('group_renamed', { groupId, newName: name });
  res.json({ ok: true });
});

// PATCH /api/groups/:groupId/settings — update group settings (owner only)
app.patch('/api/groups/:groupId/settings', (req, res) => {
  const { groupId } = req.params;
  const userId = req.session.userId;
  const { allowMemberClear, allowMemberClearTag, allowMemberExport, allowMemberKick, aiEnabled, groupColor } = req.body;

  const group = stmts.findGroupById.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.created_by !== userId) return res.status(403).json({ error: 'Only the group owner can change settings' });
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
  if (aiEnabled !== undefined) {
    stmts.updateGroupAiEnabled.run(aiEnabled ? 1 : 0, groupId);
  }
  if (groupColor !== undefined) {
    if (groupColor !== null && (typeof groupColor !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(groupColor))) {
      return res.status(400).json({ error: 'Invalid group color format' });
    }
    stmts.updateGroupColor.run(groupColor, groupId);
  }
  const updated = stmts.findGroupById.get(groupId);
  io.to(groupId).emit('group_settings_updated', {
    groupId,
    allowMemberClear: !!updated.allow_member_clear,
    allowMemberClearTag: !!updated.allow_member_clear_tag,
    allowMemberExport: !!updated.allow_member_export,
    allowMemberKick: !!updated.allow_member_kick,
    aiEnabled: !!updated.ai_enabled,
    groupColor: updated.group_color || null,
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
  } else {
    rows = stmts.getLastMessages.all({
      viewerId: userId,
      groupId,
      limit,
    }).reverse();
  }

  res.json(rows.map(formatMessage));
});

// DELETE /api/groups/:groupId/messages — clear all messages (owner, or members if allowed)
app.delete('/api/groups/:groupId/messages', (req, res) => {
  const { groupId } = req.params;
  const userId = req.session.userId;

  const group = stmts.findGroupById.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const member = stmts.isMember.get(groupId, userId);
  if (!member) return res.status(403).json({ error: 'Not a member of this group' });

  const isOwner = group.created_by === userId;
  if (!isOwner && !group.allow_member_clear) {
    return res.status(403).json({ error: 'Only the group owner can clear chat history' });
  }

  stmts.deleteGroupMessages.run(groupId);
  io.to(groupId).emit('chat_cleared', { groupId });
  res.json({ ok: true });
});

app.delete('/api/groups/:groupId/tags/:tag/messages', (req, res) => {
  const { groupId, tag } = req.params;
  const userId = req.session.userId;

  const group = stmts.findGroupById.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const member = stmts.isMember.get(groupId, userId);
  if (!member) return res.status(403).json({ error: 'Not a member of this group' });

  const normalizedTag = normalizeHashtag(tag);
  if (!normalizedTag) return res.status(400).json({ error: 'Invalid hashtag' });

  const isOwner = group.created_by === userId;
  if (!isOwner && !group.allow_member_clear && !group.allow_member_clear_tag) {
    return res.status(403).json({ error: 'Only the group owner can clear this hashtag' });
  }

  stmts.deleteMessagesByHashtag.run(groupId, normalizedTag);
  io.to(groupId).emit('tag_cleared', { groupId, hashtag: normalizedTag });
  res.json({ ok: true });
});

// DELETE /api/groups/:groupId/messages/:messageId — disabled (message recall not available)
app.delete('/api/groups/:groupId/messages/:messageId', (req, res) => {
  return res.status(410).json({ error: 'Message recall is not available' });
});

// PATCH /api/groups/:groupId/messages/:messageId — disabled (message editing not available)
app.patch('/api/groups/:groupId/messages/:messageId', (req, res) => {
  return res.status(410).json({ error: 'Message editing is not available' });
});

// DELETE /api/groups/:groupId/leave — leave group (non-owner)
app.delete('/api/groups/:groupId/leave', (req, res) => {
  const { groupId } = req.params;
  const userId = req.session.userId;

  const group = stmts.findGroupById.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const member = stmts.isMember.get(groupId, userId);
  if (!member) return res.status(403).json({ error: 'Not a member of this group' });

  if (group.created_by === userId) {
    return res.status(400).json({ error: 'Group owner cannot leave. Disband the group instead.' });
  }

  stmts.deleteMember.run(groupId, userId);

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
    }))
  );
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
  let filename = null;
  let clientUploadId = null;
  let hashtag = null;

  if (isBinaryUpload) {
    encryptedContent = req.body.toString('base64');
    iv = typeof req.headers['x-upload-iv'] === 'string' ? req.headers['x-upload-iv'] : null;
    type = typeof req.headers['x-upload-type'] === 'string' ? req.headers['x-upload-type'] : null;
    clientUploadId = typeof req.headers['x-client-upload-id'] === 'string' ? req.headers['x-client-upload-id'] : null;
    hashtag = typeof req.headers['x-upload-hashtag'] === 'string' ? req.headers['x-upload-hashtag'] : null;
    if (typeof req.headers['x-upload-filename'] === 'string') {
      try {
        filename = decodeURIComponent(req.headers['x-upload-filename']);
      } catch {
        filename = req.headers['x-upload-filename'];
      }
    }
  } else {
    ({ encryptedContent, iv, type, filename, clientUploadId, hashtag } = req.body || {});
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

  let safeFilename = sanitizeFilename(filename);
  if (msgType === 'file' && !safeFilename) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const normalizedHashtag = normalizeHashtag(hashtag);
  if (hashtag !== null && hashtag !== undefined && normalizedHashtag === null) {
    return res.status(400).json({ error: 'Invalid hashtag' });
  }

  const encryptedBytes = estimateBase64Bytes(encryptedContent);
  if (encryptedBytes <= 0) {
    return res.status(400).json({ error: 'Upload payload is empty' });
  }
  if (encryptedBytes > MAX_ATTACHMENT_BYTES) {
    return res.status(413).json({ error: 'Attachment too large (max 15MB)' });
  }
  const msgId = uuidv4();
  const createdAt = new Date().toISOString();
  const user = stmts.findUserById.get(userId);
  const totalRecipients = Math.max(0, (stmts.countGroupMembers.get(groupId)?.count || 0) - 1);

  try {
    stmts.insertMessage.run(
      msgId,
      groupId,
      userId,
      encryptedContent,
      iv,
      msgType,
      null,
      safeFilename,
      null,
      normalizedHashtag,
      0,
      null,
      totalRecipients,
      null,
      0
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
    type: msgType,
    replyTo: null,
    filename: safeFilename,
    whisperTo: null,
    hashtag: normalizedHashtag,
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
      .map((row) => row.user_id)
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
  const canMemberKick = !!group.allow_member_kick;
  if (!isOwner && !canMemberKick) {
    return res.status(403).json({ error: 'Only the group owner can kick members' });
  }

  const targetMember = stmts.isMember.get(groupId, targetUserId);
  if (!targetMember) {
    return res.status(404).json({ error: 'Member not found' });
  }

  stmts.deleteMember.run(groupId, targetUserId);
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
  stmts.deleteGroup.run(groupId);

  io.to(groupId).emit('group_disbanded', { groupId });
  res.json({ ok: true });
});

app.post('/api/groups/:groupId/ai/chat', async (req, res) => {
  const { groupId } = req.params;
  const userId = req.session.userId;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
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

  const selectedModel = normalizeAiModel(req.body.model);
  const selectedMode = normalizeAiMode(req.body.mode);
  const selectedTone = normalizeAiTone(req.body.tone);
  const webSearchEnabled = normalizeAiBoolean(req.body.webSearchEnabled);
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
      content: buildAiSystemPrompt(selectedTone, { webSearchEnabled }),
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
    const upstream = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Title': 'GChat',
        ...(origin ? { 'HTTP-Referer': origin } : {}),
      },
      body: JSON.stringify({
        model: selectedModel,
        temperature: OPENROUTER_TEMPERATURE,
        top_p: OPENROUTER_TOP_P,
        frequency_penalty: OPENROUTER_FREQUENCY_PENALTY,
        presence_penalty: OPENROUTER_PRESENCE_PENALTY,
        max_tokens: OPENROUTER_MAX_TOKENS,
        messages,
        ...(webSearchEnabled ? { tools: [OPENROUTER_WEB_SEARCH_TOOL] } : {}),
      }),
      signal: controller.signal,
    });
    const payload = await upstream.json().catch(() => ({}));
    const debug = extractOpenRouterDebugMeta(upstream, payload);
    if (!upstream.ok) {
      const errorMessage = getOpenRouterErrorMessage(payload);
      console.warn('OpenRouter AI upstream error:', {
        ...debug,
        errorMessage,
      });
      const status = upstream.status === 429 ? 429 : 502;
      return res.status(status).json({ error: errorMessage, debug });
    }

    const answer = extractOpenRouterText(payload?.choices?.[0]?.message?.content);
    if (!answer) {
      console.warn('OpenRouter AI returned empty content:', debug);
      return res.status(502).json({ error: 'OpenRouter returned an empty response', debug });
    }

    const usage = extractOpenRouterUsage(payload);
    const webSearchRequests = extractOpenRouterWebSearchRequests(payload);
    const standardizedUsage = convertModelUsageToStandardTokens(usage, selectedModel);
    const directCostUsd = extractOpenRouterCostUsd(payload);
    const estimatedCostUsd = directCostUsd ?? estimateOpenRouterCostUsd(usage, selectedModel);
    const aiMeta = sanitizeAiMessageMeta({
      model: getOpenRouterResponseModel(payload, selectedModel),
      mode: selectedMode,
      tone: selectedTone,
      webSearchEnabled,
      webSearchRequests,
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
          uuidv4(),
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
      return res.status(504).json({ error: 'OpenRouter request timed out' });
    }
    console.error('OpenRouter AI request error:', {
      name: err?.name || 'Error',
      message: sanitizeAiText(err?.message, 240) || 'Unknown error',
      code: sanitizeAiText(err?.code, 64),
    });
    res.status(502).json({ error: 'Failed to contact OpenRouter' });
  } finally {
    clearTimeout(timeout);
  }
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────

// Per-socket rate limiting state
const socketRateMap = new Map(); // socketId -> { timestamps: [], lastContent: '', repeatCount: 0 }

// Per-room presence tracking: groupId -> Set<socketId>
const roomPresence = new Map();

function getSpamSignature(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
}

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

function emitToUser(userId, event, payload) {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.userId === userId) socket.emit(event, payload);
  }
}

function canUserAccessMessage(message, userId) {
  if (!message || !userId) return false;
  if (String(message.sender_id) === String(userId)) return true;
  if (message.type !== 'whisper') return true;
  try {
    const recipients = JSON.parse(message.whisper_to || '[]');
    return Array.isArray(recipients) && recipients.map(String).includes(String(userId));
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
  console.log(`Socket connected: ${socket.username} (${socket.userId})`);
  // Rate limit keyed by userId to prevent multi-connection bypass
  if (!socketRateMap.has(socket.userId)) {
    socketRateMap.set(socket.userId, { timestamps: [], lastContent: '', repeatCount: 0 });
  }

  // ── join_room ──────────────────────────────────────────────────────────────
  socket.on('join_room', (groupId) => {
    if (!groupId) return;

    const member = stmts.isMember.get(groupId, socket.userId);
    if (!member) {
      socket.emit('error', { message: 'Not a member of this group' });
      return;
    }

    markExpiredDisappearingMessagesHidden(socket.userId);

    // Leave previous rooms (except own socket room)
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        removePresence(room, socket.id);
        socket.leave(room);
      }
    }

    socket.join(groupId);
    socket.currentRoom = groupId;
    addPresence(groupId, socket.id);

    // Notify room of updated presence
    const presenceSockets = getPresence(groupId);
    const onlineUserIds = new Set();
    for (const sid of presenceSockets) {
      const s = io.sockets.sockets.get(sid);
      if (s) onlineUserIds.add(s.userId);
    }
    io.to(groupId).emit('presence_update', { groupId, onlineUserIds: [...onlineUserIds] });

    console.log(`${socket.username} joined room ${groupId}`);
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
      groupId,
      encryptedContent,
      iv,
      replyTo,
      hashtag,
      isDisappearing,
      disappearingDurationMs,
      spamSignature,
      aiMention,
      aiMeta,
    } = payload;
    const fail = (message) => {
      socket.emit('error', { message });
      if (typeof ack === 'function') ack({ ok: false, error: message });
    };
    if (!groupId) {
      fail('Group ID is required');
      return;
    }

    // Server-side rate limiting: max 10 messages per 5 seconds, keyed by userId
    const rateData = socketRateMap.get(socket.userId);
    if (rateData) {
      const now = Date.now();
      rateData.timestamps = rateData.timestamps.filter(t => now - t < 5000);
      if (rateData.timestamps.length >= 10) {
        fail('Rate limit exceeded. Please slow down.');
        return;
      }
      // Check for repeated identical messages (3+ in a row)
      const messageSignature = getSpamSignature(spamSignature) || encryptedContent;
      if (messageSignature === rateData.lastContent) {
        rateData.repeatCount = (rateData.repeatCount || 0) + 1;
        if (rateData.repeatCount >= 3) {
          fail('Don\'t send the same message repeatedly.');
          return;
        }
      } else {
        rateData.repeatCount = 0;
        rateData.lastContent = messageSignature;
      }
      rateData.timestamps.push(now);
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
    const normalizedIsDisappearing = !!isDisappearing;
    const normalizedAiMention = !!aiMention;
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
    if (normalizedAiMention && !group.ai_enabled) {
      fail('AI mode is disabled by the group owner');
      return;
    }
    if (normalizedAiMention && normalizedIsDisappearing) {
      fail('AI requests cannot be combined with disappearing messages');
      return;
    }

    const member = stmts.isMember.get(groupId, socket.userId);
    if (!member) {
      fail('Not a member of this group');
      return;
    }

    const msgId = uuidv4();
    const createdAt = new Date().toISOString();
    const totalRecipients = Math.max(0, (stmts.countGroupMembers.get(groupId)?.count || 0) - 1);

    try {
      stmts.insertMessage.run(
        msgId,
        groupId,
        socket.userId,
        encryptedContent,
        iv,
        'text',
        replyCheck.value,
        null,
        null,
        normalizedHashtag,
        normalizedIsDisappearing ? 1 : 0,
        normalizedDisappearingDuration,
        totalRecipients,
        normalizedAiMeta ? JSON.stringify(normalizedAiMeta) : null,
        normalizedAiMention ? 1 : 0
      );
    } catch (err) {
      console.error('DB insert message error:', err);
      fail('Failed to save message');
      return;
    }

    const messagePayload = {
      id: msgId,
      groupId,
      senderId: socket.userId,
      senderName: socket.username,
      senderColor: socket.iconColor,
      encryptedContent,
      iv,
      type: 'text',
      replyTo: replyCheck.value,
      filename: null,
      whisperTo: null,
      hashtag: normalizedHashtag,
      aiMeta: normalizedAiMeta,
      aiMention: normalizedAiMention,
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

    io.to(groupId).emit('new_message', messagePayload);
    queueUnreadPushNotifications(
      stmts.getOtherGroupMemberIds.all(groupId, socket.userId)
        .map((row) => row.user_id)
    );
    if (typeof ack === 'function') ack({ ok: true, messageId: msgId });
  });

  socket.on('send_ai_message', (payload = {}, ack) => {
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

    const msgId = uuidv4();
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
        0
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
      stmts.getGroupMemberIds.all(groupId).map((row) => row.user_id)
    );
    if (typeof ack === 'function') ack({ ok: true, messageId: msgId });
  });

  // ── send_whisper ──────────────────────────────────────────────────────────
  socket.on('send_whisper', ({ groupId, encryptedContent, iv, whisperTo, replyTo, hashtag, isDisappearing, disappearingDurationMs, spamSignature }) => {
    if (!groupId || !Array.isArray(whisperTo)) {
      socket.emit('error', { message: 'Invalid whisper payload' });
      return;
    }

    // Rate limiting (same limits as send_message, keyed by userId)
    const rateData = socketRateMap.get(socket.userId);
    if (rateData) {
      const now = Date.now();
      rateData.timestamps = rateData.timestamps.filter(t => now - t < 5000);
      if (rateData.timestamps.length >= 10) {
        socket.emit('error', { message: 'Rate limit exceeded. Please slow down.' });
        return;
      }
      const messageSignature = getSpamSignature(spamSignature) || encryptedContent;
      if (messageSignature === rateData.lastContent) {
        rateData.repeatCount = (rateData.repeatCount || 0) + 1;
        if (rateData.repeatCount >= 3) {
          socket.emit('error', { message: 'Don\'t send the same message repeatedly.' });
          return;
        }
      } else {
        rateData.repeatCount = 0;
        rateData.lastContent = messageSignature;
      }
      rateData.timestamps.push(now);
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

    const replyCheck = normalizeReplyPayload(replyTo, groupId);
    if (!replyCheck.ok) {
      socket.emit('error', { message: replyCheck.error });
      return;
    }
    const normalizedHashtag = normalizeHashtag(hashtag);
    if (hashtag !== null && hashtag !== undefined && normalizedHashtag === null) {
      socket.emit('error', { message: 'Invalid hashtag' });
      return;
    }
    if (hashtag !== null && hashtag !== undefined) {
      socket.emit('error', { message: 'Tags cannot be combined with whispers' });
      return;
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

    const msgId = uuidv4();
    const createdAt = new Date().toISOString();
    const totalRecipients = Math.max(0, recipientsExcludingSender.length);
    // Store whisper recipients as JSON array for safety
    const whisperToStr = JSON.stringify(recipientsExcludingSender);

    try {
      stmts.insertMessage.run(
        msgId,
        groupId,
        socket.userId,
        encryptedContent,
        iv,
        'whisper',
        replyCheck.value,
        null,
        whisperToStr,
        normalizedHashtag,
        normalizedIsDisappearing ? 1 : 0,
        normalizedDisappearingDuration,
        totalRecipients,
        null,
        0
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
      type: 'whisper',
      replyTo: replyCheck.value,
      filename: null,
      whisperTo: whisperToStr,
      hashtag: normalizedHashtag,
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
    queueUnreadPushNotifications(recipientsExcludingSender);
  });

  socket.on('mark_message_read', ({ groupId, messageId }) => {
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
    io.to(groupId).emit('message_read_update', { messageId, readCount });
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
    if (!stmts.isMember.get(groupId, socket.userId)) return;
    socket.to(groupId).emit('user_typing', { username: socket.username });
  });

  socket.on('stop_typing', ({ groupId }) => {
    if (!groupId) return;
    if (!stmts.isMember.get(groupId, socket.userId)) return;
    socket.to(groupId).emit('user_stop_typing', { username: socket.username });
  });

  // ── disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.username}`);

    if (socket.currentRoom) {
      removePresence(socket.currentRoom, socket.id);
      const presenceSockets = getPresence(socket.currentRoom);
      const onlineUserIds = new Set();
      for (const sid of presenceSockets) {
        const s = io.sockets.sockets.get(sid);
        if (s) onlineUserIds.add(s.userId);
      }
      io.to(socket.currentRoom).emit('presence_update', {
        groupId: socket.currentRoom,
        onlineUserIds: [...onlineUserIds],
      });
    }

    // Clean up rate-limit state for this user when no more sockets are active.
    // Prune timestamps older than the rate window; if none remain (and no
    // repeated-message flag is set) remove the entry entirely to prevent the
    // map from growing unboundedly (#4 memory leak, #30 stale state).
    const hasOtherSockets = [...io.sockets.sockets.values()].some(
      s => s !== socket && s.userId === socket.userId
    );
    if (!hasOtherSockets) {
      const rateData = socketRateMap.get(socket.userId);
      if (rateData) {
        const now = Date.now();
        rateData.timestamps = rateData.timestamps.filter(t => now - t < 5000);
        if (rateData.timestamps.length === 0) {
          socketRateMap.delete(socket.userId);
        }
      }
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
server.listen(PORT, () => {
  console.log(`Gchat server running on port ${PORT}`);
});
