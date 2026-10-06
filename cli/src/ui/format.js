'use strict';

const ansi = require('../tui/ansi');
const { wrapText } = require('./screen');

const NAME_COLORS = ['#79c0ff', '#d2a8ff', '#7ee787', '#ffa657', '#ff7b72', '#a5d6ff', '#f778ba', '#e3b341'];

const THEMES = {
  dark: {
    accent: '#8ab4f8',
    text: '#e6edf3',
    muted: '#8b949e',
    faint: '#6e7681',
    border: '#4d5560',
    borderActive: '#9aa4b0',
    error: '#ff7b72',
    ok: '#7ee787',
    warn: '#e3b341',
  },
  light: {
    accent: '#0b57d0',
    text: '#1f2328',
    muted: '#57606a',
    faint: '#6e7781',
    border: '#9aa4b0',
    borderActive: '#424a53',
    error: '#c5221f',
    ok: '#1a7f37',
    warn: '#9a6700',
  },
};

let theme = THEMES.dark;

function setTheme(name) {
  theme = THEMES[name] || THEMES.dark;
  return theme;
}

function getTheme() {
  return theme;
}

/**
 * Strips terminal control sequences and control characters from text that
 * came from other people (messages, names, file names). Without this, a
 * message could carry escape codes that move the cursor, retitle the window
 * or paint over the screen.
 */
function safe(text) {
  return String(text ?? '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '') // OSC (titles, hyperlinks, images)
    .replace(/\u001b[P^_X][^\u001b]*(?:\u001b\\)?/g, '') // DCS, PM, APC, SOS strings
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '') // CSI sequences
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, '') // 8-bit CSI
    .replace(/\u001b[@-Z\\-_]/g, '') // two-byte escapes
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '') // remaining C0/C1 controls (\n and \t stay)
    .replace(/\u202e|\u2066|\u2067|\u2068|\u2069/g, ''); // bidi overrides that reorder text
}

const paint = (hex, text) => `${ansi.fg(hex)}${text}${ansi.reset()}`;
const color = (key, text) => paint(theme[key], text);
const bold = (text) => `${ansi.bold()}${text}${ansi.reset()}`;
const dim = (text) => `${ansi.fg(theme.faint)}${text}${ansi.reset()}`;
const muted = (text) => `${ansi.fg(theme.muted)}${text}${ansi.reset()}`;

function hashString(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function nameColor(name) {
  return NAME_COLORS[hashString(String(name || '?')) % NAME_COLORS.length];
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (dayKey(iso) === dayKey(now.toISOString())) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function rule(label, cols, key = 'faint') {
  const text = label ? ` ${label} ` : '';
  const fill = Math.max(2, cols - ansi.width(text) - 4);
  const left = Math.floor(fill / 2);
  return color(key, `${'─'.repeat(left + 2)}${text}${'─'.repeat(fill - left + 2)}`);
}

/** A rounded box around pre-styled content lines (each already <= inner width). */
function box(lines, cols, { title = '', borderKey = 'border' } = {}) {
  const inner = Math.max(4, cols - 4);
  const edge = (text) => color(borderKey, text);
  const titleText = title ? ` ${title} ` : '';
  const top = `${edge('╭')}${edge('─'.repeat(0))}${title ? edge('─') + titleText : ''}${edge('─'.repeat(Math.max(0, cols - 2 - (title ? 1 + ansi.width(titleText) : 0))))}${edge('╮')}`;
  const body = lines.map((line) => {
    const clipped = ansi.truncate(line, inner);
    const pad = ' '.repeat(Math.max(0, inner - ansi.width(clipped)));
    return `${edge('│')} ${clipped}${pad} ${edge('│')}`;
  });
  const bottom = `${edge('╰')}${edge('─'.repeat(cols - 2))}${edge('╯')}`;
  return [top, ...body, bottom];
}

function previewText(item, max = 80) {
  if (item.attach) return `[${item.msg.type === 'image' ? 'image' : 'file'}] ${safe(item.attach.filename || '')}`.trim();
  const flat = safe(item.text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Light markdown: `code`, **bold** and links. Applied per wrapped line. */
function inlineStyle(line) {
  if (!/[`*]|https?:/.test(line)) return line;
  const styled = line
    .replace(/(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (url) => `${ansi.underline()}${paint(theme.accent, url)}${ansi.reset()}`)
    .replace(/`([^`\n]+)`/g, (_, code) => paint(theme.warn, code))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, text) => bold(text));
  return `${styled}${ansi.reset()}`;
}

/**
 * Transcript lines for one message.
 * `ctx.prev` is the previously printed item (to fold consecutive messages from
 * one sender under a single header); `attachmentLabel` is the "[Image #n]" tag.
 */
function messageLines(item, { cols, me, prev = null, attachmentLabel = null }) {
  const msg = item.msg;
  const mine = String(msg.senderId) === String(me);
  const name = mine ? 'you' : safe(msg.senderName || msg.senderId || '?');
  const tint = mine ? theme.accent : nameColor(msg.senderName || msg.senderId);
  const lines = [];

  if (!prev || dayKey(prev.msg.createdAt) !== dayKey(msg.createdAt)) {
    lines.push('', rule(dayLabel(msg.createdAt), Math.min(cols, 60)));
  }
  const samePerson = prev
    && String(prev.msg.senderId) === String(msg.senderId)
    && dayKey(prev.msg.createdAt) === dayKey(msg.createdAt)
    && new Date(msg.createdAt) - new Date(prev.msg.createdAt) < 5 * 60 * 1000
    && !item.replyTo
    && msg.type !== 'whisper';

  if (!samePerson) {
    const tags = [];
    if (msg.type === 'whisper') {
      const to = Array.isArray(msg.whisperTo) ? msg.whisperTo.length : 0;
      tags.push(color('warn', mine ? `whisper${to ? ` to ${to}` : ''}` : 'whispers to you'));
    }
    if (msg.isDisappearing) tags.push(dim('disappearing'));
    if (msg.editedAt) tags.push(dim('edited'));
    const meta = [dim(formatTime(msg.createdAt)), ...tags].filter(Boolean).join(dim(' · '));
    lines.push(`${paint(tint, '●')} ${ansi.bold()}${ansi.fg(tint)}${name}${ansi.reset()}  ${meta}`);
  }

  if (item.replyTo) {
    const who = safe(item.replyTo.name || 'message');
    const quoted = ansi.truncate(`${who}: ${safe(item.replyTo.preview || '')}`, cols - 6);
    lines.push(`  ${dim('┃')} ${muted(quoted)}`);
  }

  const bodyWidth = Math.max(10, cols - 2);
  if (item.attach) {
    const kind = msg.type === 'image' ? 'Image' : 'File';
    const label = attachmentLabel || kind;
    const size = item.attach.size ? ` · ${formatBytes(item.attach.size)}` : '';
    lines.push(`  ${color('warn', `[${label}]`)} ${safe(item.attach.filename || '')}${dim(size)}${item.sending ? dim('  uploading…') : ''}`);
  } else if (item.error) {
    lines.push(`  ${color('error', '[unable to decrypt]')} ${dim(safe(String(item.error).slice(0, 60)))}`);
  } else {
    for (const line of wrapText(safe(item.text ?? '').replace(/\t/g, '    '), bodyWidth)) lines.push(`  ${inlineStyle(line)}`);
  }
  if (samePerson && msg.editedAt) lines[lines.length - 1] += dim(' (edited)');
  return lines;
}

module.exports = {
  safe,
  inlineStyle,
  THEMES,
  setTheme,
  getTheme,
  paint,
  color,
  bold,
  dim,
  muted,
  nameColor,
  formatTime,
  dayKey,
  dayLabel,
  formatBytes,
  rule,
  box,
  previewText,
  messageLines,
};
