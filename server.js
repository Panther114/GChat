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
const packageJson = require('./package.json');

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_JSON_BODY_BYTES = 16 * 1024 * 1024; // total JSON payload budget for wallpaper base64 overhead + other API bodies
const MAX_WALLPAPER_BYTES = 10 * 1024 * 1024;
const MAX_PROFILE_PICTURE_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENT_BODY_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_MESSAGE_BYTES = 64 * 1024;
const MAX_REPLY_PREVIEW_LENGTH = 240;
const MAX_SOCKET_PAYLOAD_BYTES = 256 * 1024;
const IV_BYTES = 12;
const SAFE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const APP_VERSION = packageJson.version || '0.0.0';

// ── App & Server ──────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: MAX_SOCKET_PAYLOAD_BYTES,
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
`);

// Safe migrations — each wrapped in try/catch so re-runs are harmless
const migrations = [
  "ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'",
  "ALTER TABLE messages ADD COLUMN reply_to TEXT",
  "ALTER TABLE messages ADD COLUMN filename TEXT",
  "ALTER TABLE messages ADD COLUMN whisper_to TEXT",
  "ALTER TABLE messages ADD COLUMN total_recipients INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE messages ADD COLUMN hashtag TEXT",
  "ALTER TABLE group_chats ADD COLUMN allow_member_clear INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE group_chats ADD COLUMN allow_member_export INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE group_chats ADD COLUMN allow_member_kick INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE group_chats ADD COLUMN group_color TEXT",
  "CREATE TABLE IF NOT EXISTS _config (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "ALTER TABLE users ADD COLUMN profile_picture TEXT",
  "ALTER TABLE users ADD COLUMN client_settings TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE messages ADD COLUMN edited_at TEXT",
  "CREATE INDEX IF NOT EXISTS idx_message_reads_message_id ON message_reads (message_id)",
  "CREATE INDEX IF NOT EXISTS idx_group_members_user_group ON group_members (user_id, group_id)",
  "CREATE INDEX IF NOT EXISTS idx_group_members_group_joined_at ON group_members (group_id, joined_at ASC, user_id)",
  // Composite index to support efficient pagination ORDER BY (created_at DESC, id DESC)
  "CREATE INDEX IF NOT EXISTS idx_messages_group_pagination ON messages (group_id, created_at DESC, id DESC)",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch { /* column/table already exists */ }
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
      profile_picture = CASE
        WHEN @hasProfilePicture = 1 THEN @profilePicture
        ELSE profile_picture
      END
    WHERE id = @userId
  `),
  updateUserSettings: db.prepare('UPDATE users SET client_settings = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  deleteUserMemberships: db.prepare('DELETE FROM group_members WHERE user_id = ?'),

  // Groups
  insertGroup: db.prepare(
    'INSERT INTO group_chats (id, name, code, created_by) VALUES (?, ?, ?, ?)'
  ),
  findGroupByCode: db.prepare('SELECT * FROM group_chats WHERE code = ?'),
  findGroupById: db.prepare('SELECT * FROM group_chats WHERE id = ?'),
  updateGroupName: db.prepare('UPDATE group_chats SET name = ? WHERE id = ?'),
  updateGroupAllowMemberClear: db.prepare('UPDATE group_chats SET allow_member_clear = ? WHERE id = ?'),
  updateGroupAllowMemberExport: db.prepare('UPDATE group_chats SET allow_member_export = ? WHERE id = ?'),
  updateGroupAllowMemberKick: db.prepare('UPDATE group_chats SET allow_member_kick = ? WHERE id = ?'),
  updateGroupColor: db.prepare('UPDATE group_chats SET group_color = ? WHERE id = ?'),

  // Members
  insertMember: db.prepare(
    'INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)'
  ),
  isMember: db.prepare(
    'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?'
  ),
  getUserGroups: db.prepare(`
    SELECT g.id, g.name, g.code, g.created_by, g.created_at, g.allow_member_clear, g.allow_member_export, g.allow_member_kick, g.group_color
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

  // Admin
  getAllUsers: db.prepare('SELECT id, username, icon_color, created_at FROM users ORDER BY created_at DESC'),

  // Messages — DESC then reverse for last-N-in-order pattern
  getLastMessages: db.prepare(`
     SELECT m.id, m.group_id, m.sender_id, u.username AS sender_name,
            u.icon_color AS sender_color, m.encrypted_content, m.iv,
           m.type, m.reply_to, m.filename, m.whisper_to, m.hashtag, m.created_at, m.edited_at,
             m.total_recipients,
            (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id) AS read_count,
            EXISTS(
              SELECT 1
              FROM message_reads mr2
              WHERE mr2.message_id = m.id AND mr2.user_id = ?
            ) AS has_read
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    WHERE m.group_id = ?
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `),
  getMessagesBefore: db.prepare(`
    WITH ref AS (SELECT created_at, id FROM messages WHERE id = ?)
     SELECT m.id, m.group_id, m.sender_id, u.username AS sender_name,
            u.icon_color AS sender_color, m.encrypted_content, m.iv,
           m.type, m.reply_to, m.filename, m.whisper_to, m.hashtag, m.created_at, m.edited_at,
             m.total_recipients,
            (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id) AS read_count,
            EXISTS(
              SELECT 1
              FROM message_reads mr2
              WHERE mr2.message_id = m.id AND mr2.user_id = ?
            ) AS has_read
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    CROSS JOIN ref
    WHERE m.group_id = ? AND (
      m.created_at < ref.created_at OR
      (m.created_at = ref.created_at AND m.id < ref.id)
    )
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `),
  insertMessage: db.prepare(
    'INSERT INTO messages (id, group_id, sender_id, encrypted_content, iv, type, reply_to, filename, whisper_to, hashtag, total_recipients) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  findMessageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
  markMessageRead: db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)'),
  getMessageReadCount: db.prepare('SELECT COUNT(*) AS count FROM message_reads WHERE message_id = ?'),
  deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
  updateMessage: db.prepare(
    'UPDATE messages SET encrypted_content = ?, iv = ?, edited_at = ? WHERE id = ?'
  ),

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

app.get('/api/health', (_req, res) => {
  try {
    const dbCheck = db.prepare('SELECT 1 AS ok').get();
    const ok = !!dbCheck && dbCheck.ok === 1;
    res.status(ok ? 200 : 503).json({
      ok,
      version: APP_VERSION,
      uptimeSec: Math.floor(process.uptime()),
      checkedAt: new Date().toISOString(),
      database: ok ? 'ok' : 'error',
    });
  } catch (err) {
    console.error('Healthcheck failed:', err);
    res.status(503).json({
      ok: false,
      version: APP_VERSION,
      uptimeSec: Math.floor(process.uptime()),
      checkedAt: new Date().toISOString(),
      database: 'error',
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
    clientSettings,
  };
}

function formatMessage(m) {
  return {
    id: m.id,
    groupId: m.group_id,
    senderId: m.sender_id,
    senderName: m.sender_name,
    senderColor: m.sender_color,
    encryptedContent: m.encrypted_content,
    iv: m.iv,
    type: m.type || 'text',
    replyTo: m.reply_to || null,
    filename: m.filename || null,
    whisperTo: m.whisper_to || null,
    hashtag: m.hashtag || null,
    createdAt: m.created_at,
    editedAt: m.edited_at || null,
    totalRecipients: Math.max(0, Number(m.total_recipients) || 0),
    readCount: Math.max(0, Number(m.read_count) || 0),
    hasRead: !!m.has_read,
  };
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
  res.json(settings);
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

  const next = { ...settings };
  if (req.body.wallpaperDataUrl !== undefined) {
    const parsedWallpaper = parseImageDataUrl(req.body.wallpaperDataUrl, MAX_WALLPAPER_BYTES, { allowNull: true });
    if (!parsedWallpaper.ok) {
      return res.status(400).json({ error: getWallpaperValidationError(parsedWallpaper) });
    }
    next.wallpaperDataUrl = parsedWallpaper.dataUrl;
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

// ── Admin Routes ──────────────────────────────────────────────────────────────

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
    allowMemberClear: group.allow_member_clear || 0,
    allowMemberExport: group.allow_member_export || 0,
    allowMemberKick: group.allow_member_kick || 0,
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
    allowMemberClear: group.allow_member_clear || 0,
    allowMemberExport: group.allow_member_export || 0,
    allowMemberKick: group.allow_member_kick || 0,
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
      allowMemberClear: g.allow_member_clear || 0,
      allowMemberExport: g.allow_member_export || 0,
      allowMemberKick: g.allow_member_kick || 0,
      groupColor: g.group_color || null,
    }))
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
  const { allowMemberClear, allowMemberExport, allowMemberKick, groupColor } = req.body;

  const group = stmts.findGroupById.get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.created_by !== userId) return res.status(403).json({ error: 'Only the group owner can change settings' });

  if (allowMemberClear !== undefined) {
    stmts.updateGroupAllowMemberClear.run(allowMemberClear ? 1 : 0, groupId);
  }
  if (allowMemberExport !== undefined) {
    stmts.updateGroupAllowMemberExport.run(allowMemberExport ? 1 : 0, groupId);
  }
  if (allowMemberKick !== undefined) {
    stmts.updateGroupAllowMemberKick.run(allowMemberKick ? 1 : 0, groupId);
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
    allowMemberExport: !!updated.allow_member_export,
    allowMemberKick: !!updated.allow_member_kick,
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

  let rows;
  if (before) {
    // CTE parameter order: (beforeMessageId, userId, groupId, limit)
    rows = stmts.getMessagesBefore.all(before, userId, groupId, limit).reverse();
  } else {
    rows = stmts.getLastMessages.all(userId, groupId, limit).reverse();
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

  if (isBinaryUpload) {
    encryptedContent = req.body.toString('base64');
    iv = typeof req.headers['x-upload-iv'] === 'string' ? req.headers['x-upload-iv'] : null;
    type = typeof req.headers['x-upload-type'] === 'string' ? req.headers['x-upload-type'] : null;
    clientUploadId = typeof req.headers['x-client-upload-id'] === 'string' ? req.headers['x-client-upload-id'] : null;
    if (typeof req.headers['x-upload-filename'] === 'string') {
      try {
        filename = decodeURIComponent(req.headers['x-upload-filename']);
      } catch {
        filename = req.headers['x-upload-filename'];
      }
    }
  } else {
    ({ encryptedContent, iv, type, filename, clientUploadId } = req.body || {});
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
      stmts.insertMessage.run(msgId, groupId, userId, encryptedContent, iv, msgType, null, safeFilename, null, null, totalRecipients);
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
    hashtag: null,
    createdAt,
    editedAt: null,
    totalRecipients,
    readCount: 0,
    clientUploadId: typeof clientUploadId === 'string' ? clientUploadId.slice(0, 128) : null,
  };

  io.to(groupId).emit('new_message', payload);
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
  socket.on('send_message', ({ groupId, encryptedContent, iv, replyTo, hashtag, spamSignature }) => {
    if (!groupId) {
      socket.emit('error', { message: 'Group ID is required' });
      return;
    }

    // Server-side rate limiting: max 10 messages per 5 seconds, keyed by userId
    const rateData = socketRateMap.get(socket.userId);
    if (rateData) {
      const now = Date.now();
      rateData.timestamps = rateData.timestamps.filter(t => now - t < 5000);
      if (rateData.timestamps.length >= 10) {
        socket.emit('error', { message: 'Rate limit exceeded. Please slow down.' });
        return;
      }
      // Check for repeated identical messages (3+ in a row)
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
    if (hashtag != null && normalizedHashtag == null) {
      socket.emit('error', { message: 'Invalid hashtag' });
      return;
    }

    const member = stmts.isMember.get(groupId, socket.userId);
    if (!member) {
      socket.emit('error', { message: 'Not a member of this group' });
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
        totalRecipients
      );
    } catch (err) {
      console.error('DB insert message error:', err);
      socket.emit('error', { message: 'Failed to save message' });
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
      type: 'text',
      replyTo: replyCheck.value,
      filename: null,
      whisperTo: null,
      hashtag: normalizedHashtag,
      createdAt,
      editedAt: null,
      totalRecipients,
      readCount: 0,
    };

    io.to(groupId).emit('new_message', payload);
  });

  // ── send_whisper ──────────────────────────────────────────────────────────
  socket.on('send_whisper', ({ groupId, encryptedContent, iv, whisperTo, replyTo, hashtag, spamSignature }) => {
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
    if (hashtag != null && normalizedHashtag == null) {
      socket.emit('error', { message: 'Invalid hashtag' });
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
        totalRecipients
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
