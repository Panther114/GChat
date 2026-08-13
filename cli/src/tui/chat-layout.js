'use strict';

/**
 * Pure GChat CLI frame builder.
 *
 * Hover outlines a message (no fill). Click selects it. Timestamps sit on
 * the name row's right edge; packed actions then read ticks sit on the
 * first content row. The hint row above the composer keeps typing on the
 * left and action labels on the right.
 */

const ansi = require('./ansi');
const landing = require('./landing');

const PALETTE = {
  title: '#ffffff',
  text: '#e6edf3',
  muted: '#6e7681',
  hoverFg: '#e6edf3',
  outline: '#6e7681',
  outlineStrong: '#8b93a0',
  selectedBg: '#2a3139',
  deleteBg: '#4a1518',
  channelHover: '#b1bac4',
  composerOutline: '#3d444d',
  image: '#e3b341',
  action: '#e6edf3',
  activeBg: '#21262d',
  border: '#30363d',
  rule: '#30363d',
  card: '#8b93a0',
  error: '#f85149',
  placeholder: '#8a8a8a',
  sending: '#6e7681',
  reply: '#8b93a0',
  keyR: '#79c0ff',
  keyE: '#d2a8ff',
  keyD: '#f85149',
  keyP: '#7ee787',
  track: '#30363d',
  thumb: '#8b93a0',
  faint: '#484f58',
};

const CARET_LETTER = '#161b22';

const TEXT = '\uFE0E';

const ACTIONS = {
  reply: { id: 'reply', key: 'r', glyph: '↩', label: 'reply', color: PALETTE.keyR },
  edit: { id: 'edit', key: 'e', glyph: `${'✎'}${TEXT}`, label: 'edit', color: PALETTE.keyE },
  delete: { id: 'delete', key: 'd', glyph: '×', label: 'delete', color: PALETTE.keyD },
  preview: { id: 'preview', key: 'p', glyph: '▣', label: 'preview', color: PALETTE.keyP },
  clear: { id: 'clear', key: 'Escape', glyph: null, label: 'clear (esc)', color: PALETTE.muted },
};

const SIDEBAR_MIN = 20;
const SIDEBAR_MAX = 26;
const PAD = 2;
const CHANNEL_ROWS = 3;
const COMPOSER_MIN_INNER = 1;
const COMPOSER_MAX_INNER = 6;
const SCROLLBAR_W = 1;
const WHEEL_LINES = 1;
const FIELD_CARET = '█';
const TRANSITION_MS = 480;
const CHANNEL_EXPAND_FRAMES = 8;
const PROFILE_FRAMES = 6;
const HISTORY_PAGE = 50;
const SCROLL_TWEEN_MS = 220;

const DEFAULT_CHAT = {
  groups: [],
  activeGroupId: null,
  channels: ['main'],
  activeChannel: 'main',
  messages: [],
  scrollOffset: 0,
  hoverMessageId: null,
  hoverAction: null,
  hoverChannel: null,
  selectedMessageId: null,
  composer: '',
  composerCaret: 0,
  composerScroll: 0,
  replyTo: null,
  editingId: null,
  status: '',
  connected: false,
  error: null,
  userId: null,
  username: '',
  iconColor: '',
  overlay: null,
  loading: false,
  loadingGroup: false,
  animFrame: 0,
  transition: null,
  typing: null,
  creatingChannel: false,
  channelDraft: '',
  channelMenu: null,
  channelExpandFrame: CHANNEL_EXPAND_FRAMES,
  channelClosing: false,
  channelDraftCaret: 0,
  composerBeforeEdit: null,
  hasMoreHistory: false,
  loadingMore: false,
  profileOpen: false,
  profileClosing: false,
  profileExpandFrame: 0,
  hoverLogout: false,
  scrollTween: null,
  memberCount: 0,
  now: null,
};

function sidebarWidth(cols) {
  if (cols < 60) return 0;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.floor(cols * 0.22)));
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatBytes(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) {
    const kb = value / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function wrapText(text, width) {
  const max = Math.max(1, width);
  const out = [];
  for (const para of String(text || '').split('\n')) {
    if (para === '') {
      out.push('');
      continue;
    }
    const tokens = para.split(/(\s+)/);
    let line = '';
    let lineW = 0;
    const flush = () => {
      out.push(line);
      line = '';
      lineW = 0;
    };
    for (const token of tokens) {
      const tokenW = ansi.width(token);
      if (tokenW > max) {
        if (line) flush();
        let chunk = '';
        let chunkW = 0;
        for (const ch of token) {
          const w = ansi.charWidth(ch);
          if (chunkW + w > max && chunk) {
            out.push(chunk);
            chunk = ch;
            chunkW = w;
          } else {
            chunk += ch;
            chunkW += w;
          }
        }
        line = chunk;
        lineW = chunkW;
        continue;
      }
      if (lineW + tokenW > max && line) {
        flush();
        if (/^\s+$/.test(token)) continue;
      }
      line += token;
      lineW += tokenW;
    }
    out.push(line);
  }
  return out.length > 0 ? out : [''];
}

function wrapIndexed(text, width) {
  const max = Math.max(1, width);
  const raw = String(text || '');
  const lines = [];
  let i = 0;
  while (i <= raw.length) {
    if (i === raw.length) {
      if (lines.length === 0 || raw.endsWith('\n')) lines.push({ start: i, text: '' });
      break;
    }
    if (raw[i] === '\n') {
      lines.push({ start: i, text: '' });
      i += 1;
      continue;
    }
    const nl = raw.indexOf('\n', i);
    const paraEnd = nl === -1 ? raw.length : nl;
    const para = raw.slice(i, paraEnd);
    if (para.length === 0) {
      lines.push({ start: i, text: '' });
      i = paraEnd;
      continue;
    }
    const tokens = para.split(/(\s+)/);
    let line = '';
    let lineStart = i;
    let consumed = 0;
    let lineW = 0;
    const flush = () => {
      lines.push({ start: lineStart, text: line });
      line = '';
      lineW = 0;
      lineStart = i + consumed;
    };
    for (const token of tokens) {
      const tokenW = ansi.width(token);
      if (tokenW > max) {
        if (line) flush();
        let chunk = '';
        let chunkW = 0;
        for (const ch of token) {
          const w = ansi.charWidth(ch);
          if (chunkW + w > max && chunk) {
            lines.push({ start: lineStart, text: chunk });
            lineStart += chunk.length;
            chunk = ch;
            chunkW = w;
          } else {
            chunk += ch;
            chunkW += w;
          }
        }
        line = chunk;
        lineW = chunkW;
        consumed += token.length;
        continue;
      }
      if (lineW + tokenW > max && line) flush();
      if (!(/^\s+$/.test(token) && !line)) {
        line += token;
        lineW += tokenW;
      }
      consumed += token.length;
    }
    if (line || lines.length === 0) lines.push({ start: lineStart, text: line });
    i = paraEnd;
    if (nl !== -1) i += 1;
    else break;
  }
  return lines.length ? lines : [{ start: 0, text: '' }];
}

function padCells(str, width) {
  const w = ansi.width(str);
  if (w >= width) return ansi.truncate(str, width);
  return str + ' '.repeat(width - w);
}

function padStartCells(str, width) {
  const w = ansi.width(str);
  if (w >= width) return ansi.truncate(str, width);
  return ' '.repeat(width - w) + str;
}

function fillRow(plain, width, { bg = null, fg = null, bold = false, dim = false } = {}) {
  const clipped = ansi.width(plain) > width ? ansi.stripAnsi(ansi.truncate(plain, width)) : plain;
  const pad = ' '.repeat(Math.max(0, width - ansi.width(clipped)));
  const style = `${bg ? ansi.bg(bg) : ''}${fg ? ansi.fg(fg) : ''}${bold ? ansi.bold() : ''}${dim ? ansi.dim() : ''}`;
  return `${style}${clipped}${pad}${ansi.reset()}`;
}

function dimLine(line) {
  return `${ansi.dim()}${line}${ansi.reset()}`;
}

function isOwnMessage(item, userId) {
  return !!(userId && item?.msg?.senderId && String(item.msg.senderId) === String(userId));
}

function isAttachment(item) {
  const type = item?.msg?.type;
  return type === 'image' || type === 'file';
}

function isImage(item) {
  return item?.msg?.type === 'image';
}

function actionMode(state = {}) {
  return {
    busy: !!(state.replyTo || state.editingId || (state.overlay && state.overlay.type === 'delete')),
  };
}

function actionListFor(item, userId, mode = {}) {
  const busy = !!mode.busy;
  const list = [];
  if (!busy) list.push(ACTIONS.reply);
  if (isImage(item)) list.push(ACTIONS.preview);
  if (!busy && isOwnMessage(item, userId)) {
    if (!isAttachment(item) && item.msg?.type !== 'whisper') list.push(ACTIONS.edit);
    list.push(ACTIONS.delete);
  }
  return list;
}

function hintActionsFor(item, userId, mode = {}) {
  return [...actionListFor(item, userId, mode), ACTIONS.clear];
}

const ACTION_SLOTS = ['reply', 'preview', 'edit', 'delete'];
const ACTION_SLOT_W = 1;
const ACTION_GAP = 2;
const ACTION_GUTTER = ACTION_SLOTS.length * ACTION_SLOT_W + (ACTION_SLOTS.length - 1) * ACTION_GAP;
const TICK_GUTTER = 7;
const CONTENT_GUTTER = TICK_GUTTER + 1 + ACTION_GUTTER;
const CHANNEL_ICON_GAP = 2;

function formatStamp(iso, now = new Date()) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const same = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (same) return time;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()];
  return `${mon} ${date.getDate()} ${time}`;
}

function groupRecipientCount(state) {
  const members = Math.max(0, Number(state?.memberCount) || 0);
  if (members > 0) return Math.max(0, members - 1);
  let max = 0;
  for (const item of state?.messages || []) {
    max = Math.max(max, Number(item?.msg?.totalRecipients) || 0);
  }
  return max;
}

function faintStyle() {
  return `${ansi.dim()}${ansi.fg(PALETTE.muted)}`;
}

function tickStrip(item, totalOverride) {
  const total = Math.max(0, Number(totalOverride) || Number(item?.msg?.totalRecipients) || 0);
  const read = Math.max(0, Math.min(total, Number(item?.msg?.readCount) || 0));
  if (total <= 0) return ''.padStart(TICK_GUTTER, ' ');
  if (total > 6) {
    return padStartCells(`${ansi.fg(PALETTE.muted)}${read}/${total}${ansi.reset()}`, TICK_GUTTER);
  }
  const marked = `${ansi.fg(PALETTE.muted)}${'✓'.repeat(read)}${ansi.reset()}`;
  const open = `${faintStyle()}${'·'.repeat(total - read)}${ansi.reset()}`;
  return padStartCells(`${marked}${open}`, TICK_GUTTER);
}

function visibleActions(actions) {
  return (actions || []).filter((action) => action && action.glyph);
}

function packedActionWidth(actions) {
  const n = visibleActions(actions).length;
  if (n <= 0) return 0;
  return n * ACTION_SLOT_W + (n - 1) * ACTION_GAP;
}

function iconHits(actions, originX, originY, rowWidth) {
  const list = visibleActions(actions);
  const stripW = packedActionWidth(list);
  const startX = originX + rowWidth - TICK_GUTTER - (stripW ? 1 + stripW : 0);
  const hits = [];
  let x = startX;
  for (const action of list) {
    hits.push({ type: 'action', action: action.id, x, y: originY, w: 1, h: 1 });
    x += ACTION_SLOT_W + ACTION_GAP;
  }
  return hits;
}

function styleWord(word, color) {
  const first = word[0] || '';
  const rest = word.slice(1);
  return `${ansi.bold()}${ansi.fg(color)}${first}${ansi.reset()}${ansi.fg(PALETTE.muted)}${rest}${ansi.reset()}`;
}

function styleHint(actions) {
  return actions.map((action) => styleWord(action.label, action.color)).join('   ');
}

function hintHits(actions, originX, originY, rowWidth) {
  const parts = actions.map((action) => {
    return { action, w: ansi.width(action.label) };
  });
  const total = parts.reduce((sum, p) => sum + p.w, 0) + Math.max(0, parts.length - 1) * 3;
  let x = originX + Math.max(0, rowWidth - total - 1);
  const hits = [];
  for (const part of parts) {
    hits.push({ type: 'action', action: part.action.id, id: null, x, y: originY, w: part.w, h: 1 });
    x += part.w + 3;
  }
  return hits;
}

function channelHintActions(name) {
  if (name === 'main') return [ACTIONS.clear];
  return [
    { id: 'delete-channel', key: 'd', glyph: '×', label: 'delete', color: PALETTE.keyD },
    ACTIONS.clear,
  ];
}

function bodyText(item) {
  if (item.text != null && item.text !== '') return item.text;
  if (item.error) return `[unable to decrypt]`;
  return '';
}

function metaLine(item) {
  const name = item.msg?.senderName || item.msg?.senderId || '?';
  const edited = item.msg?.editedAt ? '  edited' : '';
  return `${name}${edited}`;
}

function replyPreviewText(item) {
  const reply = item?.replyTo;
  if (!reply) return '';
  const name = reply.name || 'message';
  const preview = String(reply.preview || '').replace(/\s+/g, ' ');
  return preview ? `${name}: ${preview}` : name;
}

function replyLine(item) {
  return item?.replyTo ? replyPreviewText(item) : null;
}

function paintReplyPreview(item, width, { hot = false, bg = null } = {}) {
  const reply = item?.replyTo || {};
  const name = reply.name || 'message';
  const color = reply.color || hashNameColor(name);
  let label = replyPreviewText(item);
  if (ansi.width(label) > width) {
    label = `${ansi.stripAnsi(ansi.truncate(label, Math.max(1, width - 1)))}…`;
  }
  const style = `${hot ? '' : ansi.dim()}${ansi.italic()}${ansi.fg(color)}`;
  return withBg(`${style}${padCells(label, width)}`, bg);
}

const NAME_COLORS = [
  '#79c0ff', '#d2a8ff', '#7ee787', '#ffa657',
  '#ff7b72', '#a5d6ff', '#f778ba', '#e3b341',
];

function hashNameColor(name) {
  let hash = 0;
  for (const ch of String(name || '?')) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
  return NAME_COLORS[hash % NAME_COLORS.length];
}

function nameColor(item) {
  const raw = item?.msg?.senderColor || item?.msg?.iconColor || '';
  const hex = String(raw).trim();
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex}`;
  return hashNameColor(item?.msg?.senderName || item?.msg?.senderId || '?');
}

function layoutMessage(item, width, userId, mode = {}) {
  const actions = actionListFor(item, userId, mode);
  const rows = [];
  const reply = replyLine(item);
  let replyRow = -1;
  if (reply) {
    replyRow = rows.length;
    rows.push(reply);
  }
  const metaRow = rows.length;
  rows.push(metaLine(item));
  const iconRow = rows.length;
  let card = null;
  const bodyW = Math.max(1, width - CONTENT_GUTTER);
  if (isImage(item)) {
    card = { start: rows.length, height: 1, width: Math.min(bodyW, 8) };
    rows.push('[Image]');
  } else if (isAttachment(item)) {
    const name = item.attach?.filename || 'file';
    card = { start: rows.length, height: 1, width: Math.min(bodyW, ansi.width(name) + 8) };
    rows.push(`[file] ${name}`);
  } else {
    const body = wrapText(bodyText(item), bodyW);
    rows.push(...body);
  }
  return { rows, actions, card, height: rows.length, replyRow, metaRow, iconRow };
}

function sendingLabel(frame) {
  const on = Math.floor((frame || 0) / 8) % 2 === 0;
  return on ? 'sending...' : 'sending   ';
}

function withBg(text, bg) {
  if (!bg) return `${text}${ansi.reset()}`;
  const reset = ansi.reset();
  const bgOn = ansi.bg(bg);
  return `${bgOn}${String(text).split(reset).join(reset + bgOn)}${reset}`;
}

function paintMessageRow(plain, width, {
  raised, deleting, isMeta, isReply, isIconRow, showIcons, hoverAction, actions, sending,
  animFrame, isImageRow, nameTint, stamp, ticks, item, replyHot,
}) {
  const bg = deleting ? PALETTE.deleteBg : (raised ? PALETTE.selectedBg : null);
  const bgOn = bg ? ansi.bg(bg) : '';

  if (isMeta) {
    const stampText = stamp || '';
    const stampW = ansi.width(stampText);
    const nameMax = Math.max(1, width - stampW - (stampW ? 1 : 0));
    const name = ansi.stripAnsi(ansi.truncate(String(plain || ''), nameMax));
    const nameW = ansi.width(name);
    const mid = Math.max(0, width - nameW - stampW);
    const left = `${bgOn}${ansi.fg(nameTint || PALETTE.text)}${ansi.bold()}${name}${ansi.reset()}`;
    const gap = `${bgOn}${' '.repeat(mid)}`;
    const right = stampText ? `${bgOn}${ansi.fg(PALETTE.muted)}${stampText}${ansi.reset()}` : '';
    return withBg(`${left}${gap}${right}`, bg);
  }

  if (isReply) {
    return paintReplyPreview(item, width, { hot: !!replyHot, bg });
  }

  const gutterW = CONTENT_GUTTER;
  const bodyW = Math.max(1, width - gutterW);
  let body = isImageRow ? '[Image]' : String(plain || '');
  if (sending && !isImageRow) {
    const label = sendingLabel(animFrame);
    const room = Math.max(1, bodyW - ansi.width(label) - 1);
    const cut = ansi.width(body) > room ? ansi.stripAnsi(ansi.truncate(body, room)) : body;
    body = cut + ' '.repeat(Math.max(0, room - ansi.width(cut))) + label;
  }
  const bodyFg = isImageRow ? PALETTE.image : (sending ? PALETTE.muted : PALETTE.text);
  const shown = isIconRow && showIcons ? visibleActions(actions) : [];
  const actionW = packedActionWidth(shown);
  const actionStyled = shown.map((action) => {
    const hot = hoverAction === action.id;
    return `${bgOn}${hot ? ansi.bold() : ''}${ansi.fg(action.color)}${action.glyph}${ansi.reset()}`;
  }).join(`${bgOn}${' '.repeat(ACTION_GAP)}`);
  const tickText = isIconRow ? padStartCells(ticks || '', TICK_GUTTER) : ''.padStart(TICK_GUTTER, ' ');
  const midW = Math.max(0, gutterW - (actionW ? actionW + 1 : 0) - TICK_GUTTER);
  const bodyStyled = `${bgOn}${ansi.fg(bodyFg)}${padCells(isImageRow ? '[Image]' : body, bodyW)}${ansi.reset()}`;
  const gutterStyled = `${bgOn}${' '.repeat(midW)}`
    + (actionW ? `${actionStyled}${bgOn} ` : '')
    + `${tickText}${ansi.reset()}`;
  return withBg(bodyStyled + gutterStyled, bg);
}

function boxTop(width, color) {
  return fillRow(`╭${'─'.repeat(Math.max(0, width - 2))}╮`, width, { fg: color });
}

function boxBottom(width, color) {
  return fillRow(`╰${'─'.repeat(Math.max(0, width - 2))}╯`, width, { fg: color });
}

function boxRow(inner, width, color) {
  return `${ansi.fg(color)}│${ansi.reset()}${padCells(inner, Math.max(0, width - 2))}${ansi.fg(color)}│${ansi.reset()}`;
}

function pulseText(text, frame, hotColor, idleColor) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const hot = landing.isHot(0, i, frame || 0, { speed: 0.6, width: 4, period: 18 });
    out += `${ansi.bold()}${ansi.fg(hot ? hotColor : idleColor)}${text[i]}${ansi.reset()}`;
  }
  return out;
}

function hitTest(hits, x, y) {
  let found = null;
  for (const hit of hits) {
    if (x >= hit.x && x < hit.x + hit.w && y >= hit.y && y < hit.y + hit.h) {
      found = hit;
    }
  }
  return found;
}

function filterMessages(messages, channel) {
  const want = channel || 'main';
  return (messages || []).filter((item) => (item.channel || 'main') === want);
}

function sidebarTitle() {
  return `GChat CLI v${landing.TUI_VERSION}`;
}

function profileProgress(state) {
  const frames = Math.max(1, PROFILE_FRAMES);
  const raw = Number(state?.profileExpandFrame);
  const frame = Number.isFinite(raw) ? raw : 0;
  return Math.min(1, Math.max(0, frame / frames));
}

function paintStripeLabel(text, frame, hover, idleColor, hotColor) {
  if (!hover) return `${ansi.fg(idleColor)}${text}${ansi.reset()}`;
  return pulseText(text, frame, hotColor, idleColor);
}

function buildSidebar(state, width, height) {
  const lines = [];
  const hits = [];
  if (width <= 0 || height <= 0) return { lines, hits };
  lines.push(fillRow(`${' '.repeat(Math.min(1, PAD))}${sidebarTitle()}`, width, { fg: PALETTE.muted }));
  const list = state.groups || [];
  const boxW = width;
  const progress = profileProgress(state);
  const eased = 1 - (1 - progress) * (1 - progress);
  const logoutH = Math.round(3 * eased);
  const reserved = 3 + logoutH;
  let y = 1;
  for (let i = 0; i < list.length && y + 2 < height - reserved; i += 1) {
    const group = list[i];
    const active = String(group.id) === String(state.activeGroupId);
    const color = active ? PALETTE.title : PALETTE.muted;
    const unread = Number(group.unreadCount) || 0;
    const badge = unread > 0 ? `[${unread > 99 ? '99+' : unread}]` : '';
    const nameW = Math.max(1, boxW - 2 - (badge ? ansi.width(badge) + 1 : 0));
    const mid = `${padCells(String(group.name || '?'), nameW)}${badge ? ` ${badge}` : ''}`;
    lines.push(fillRow(`╭${'─'.repeat(Math.max(0, boxW - 2))}╮`, width, { fg: color }));
    lines.push(
      `${ansi.fg(color)}│${ansi.reset()}`
      + `${ansi.fg(active ? PALETTE.title : PALETTE.text)}${active ? ansi.bold() : ''}${padCells(mid, boxW - 2)}${ansi.reset()}`
      + `${ansi.fg(color)}│${ansi.reset()}`
    );
    lines.push(fillRow(`╰${'─'.repeat(Math.max(0, boxW - 2))}╯`, width, { fg: color }));
    hits.push({ type: 'group', id: group.id, x: 0, y, w: width, h: 3 });
    y += 3;
  }
  while (lines.length < height - reserved) lines.push(fillRow('', width, {}));

  if (logoutH > 0) {
    const logoutY = height - reserved;
    const color = PALETTE.error;
    const label = padCells(' Log out', Math.max(1, boxW - 2));
    const body = paintStripeLabel(label, state.animFrame || 0, !!state.hoverLogout, PALETTE.error, '#ff7b72');
    if (logoutH >= 1) lines.push(fillRow(`╭${'─'.repeat(Math.max(0, boxW - 2))}╮`, width, { fg: color }));
    if (logoutH >= 2) {
      lines.push(
        `${ansi.fg(color)}│${ansi.reset()}${body}${ansi.fg(color)}│${ansi.reset()}`
      );
    }
    if (logoutH >= 3) lines.push(fillRow(`╰${'─'.repeat(Math.max(0, boxW - 2))}╯`, width, { fg: color }));
    while (lines.length < logoutY + logoutH) lines.push(fillRow('', width, {}));
    if (logoutH >= 2) {
      hits.push({ type: 'logout', x: 0, y: logoutY, w: width, h: logoutH });
    }
  }

  const userColor = state.iconColor && /^#?[0-9a-fA-F]{6}$/.test(state.iconColor)
    ? (String(state.iconColor).startsWith('#') ? state.iconColor : `#${state.iconColor}`)
    : hashNameColor(state.username || '?');
  const uname = String(state.username || 'you');
  lines.push(fillRow(`╭${'─'.repeat(Math.max(0, boxW - 2))}╮`, width, { fg: userColor }));
  lines.push(
    `${ansi.fg(userColor)}│${ansi.reset()}`
    + `${ansi.fg(userColor)}${ansi.bold()}${padCells(uname, boxW - 2)}${ansi.reset()}`
    + `${ansi.fg(userColor)}│${ansi.reset()}`
  );
  lines.push(fillRow(`╰${'─'.repeat(Math.max(0, boxW - 2))}╯`, width, { fg: userColor }));
  hits.push({ type: 'profile', x: 0, y: height - 3, w: width, h: 3 });

  hits.unshift({ type: 'sidebar-empty', x: 0, y: 0, w: width, h: Math.max(0, height - reserved) });
  return { lines, hits };
}

function chipWidth(label) {
  return Math.max(5, ansi.width(label) + 2);
}

function channelExpandIconsPlain() {
  return ACTIONS.delete.glyph;
}

function channelExpandIconsStyled() {
  return `${ansi.fg(PALETTE.keyD)}${ACTIONS.delete.glyph}${ansi.reset()}`;
}

function channelExpandProgress(state, name) {
  if (!state || state.channelMenu !== name) return 0;
  const frames = Math.max(1, CHANNEL_EXPAND_FRAMES);
  const raw = Number(state.channelExpandFrame);
  const frame = Number.isFinite(raw) ? raw : frames;
  return Math.min(1, Math.max(0, frame / frames));
}

function paintBoxChip(innerStyled, w, color, { bold = false, dim = false } = {}) {
  const innerW = Math.max(1, w - 2);
  const inner = padCells(innerStyled, innerW);
  const fg = `${dim ? ansi.dim() : ''}${ansi.fg(color)}`;
  const reset = ansi.reset();
  return {
    top: `${fg}╭${'─'.repeat(innerW)}╮${reset}`,
    mid: `${fg}│${reset}${fg}${bold ? ansi.bold() : ''}${inner}${reset}${fg}│${reset}`,
    bot: `${fg}╰${'─'.repeat(innerW)}╯${reset}`,
    innerW,
  };
}

function paintLineWithCaret(text, width, { caret = -1, fg }) {
  const max = Math.max(1, width);
  const visual = [];
  for (const ch of String(text || '')) {
    const w = ansi.charWidth(ch);
    if (w <= 0) {
      if (visual.length) visual[visual.length - 1] += ch;
      continue;
    }
    visual.push(ch);
  }
  while (visual.length < max) visual.push(' ');
  if (visual.length > max) visual.length = max;
  let out = '';
  for (let i = 0; i < visual.length; i += 1) {
    const ch = visual[i];
    if (i === caret) {
      out += `${ansi.bg(fg)}${ansi.fg(CARET_LETTER)}${ch === ' ' ? FIELD_CARET : ch}${ansi.reset()}`;
    } else {
      out += `${ansi.fg(fg)}${ch}${ansi.reset()}`;
    }
  }
  return out;
}

function buildChannelBar(state, width, originX, originY) {
  const hits = [];
  const lines = [
    fillRow('', width, {}),
    fillRow('', width, {}),
    fillRow('', width, {}),
  ];
  let x = PAD;
  const channels = state.channels && state.channels.length ? state.channels : ['main'];
  const expandPlain = channelExpandIconsPlain();
  const expandStyled = channelExpandIconsStyled();
  const expandIconW = ansi.width(expandPlain);

  const chips = [];
  for (const name of channels) {
    const expanding = name !== 'main' && state.channelMenu === name;
    const collapsedLabel = `#${name}`;
    const expandedLabel = `#${name}  ${expandPlain}`;
    const progress = expanding ? channelExpandProgress(state, name) : 0;
    const eased = 1 - (1 - progress) * (1 - progress);
    const collapsedW = chipWidth(collapsedLabel);
    const expandedW = chipWidth(expandedLabel);
    const w = Math.round(collapsedW + (expandedW - collapsedW) * eased);
    if (x + w > width - PAD - 6) break;
    const active = name === (state.activeChannel || 'main');
    const hover = !active && state.hoverChannel === name;
    chips.push({
      type: 'channel',
      name,
      label: collapsedLabel,
      x,
      w,
      active: active || expanding,
      hover,
      expanding,
    });
    x += w + 1;
  }
  if (state.creatingChannel) {
    const draft = `#${state.channelDraft || ''}  ×`;
    const w = Math.max(10, chipWidth(draft) + 1);
    if (x + w <= width - PAD) {
      chips.push({
        type: 'channel-draft',
        name: 'draft',
        label: draft,
        x,
        w,
        active: true,
        hover: false,
        cancel: true,
      });
      x += w + 1;
    }
  } else {
    const w = chipWidth('+ Create');
    if (x + w <= width - PAD) {
      chips.push({
        type: 'create-channel',
        name: '+',
        label: '+ Create',
        x,
        w,
        active: false,
        hover: state.hoverChannel === '+',
      });
    }
  }

  const styled = ['', '', ''];
  const padTo = (target) => {
    const used = ansi.width(styled[0]);
    if (target > used) {
      const gap = ' '.repeat(target - used);
      styled[0] += gap;
      styled[1] += gap;
      styled[2] += gap;
    }
  };
  padTo(PAD);
  for (const chip of chips) {
    padTo(chip.x);
    const isCreate = chip.type === 'create-channel';
    const color = isCreate
      ? (chip.hover ? PALETTE.channelHover : PALETTE.muted)
      : (chip.active ? PALETTE.title : (chip.hover ? PALETTE.channelHover : PALETTE.muted));
    const innerW = Math.max(1, chip.w - 2);
    let inner = padCells(chip.label, innerW);
    let iconsVisible = false;
    const draftCaret = Math.max(0, Number(state.channelDraftCaret) || 0);
    if (chip.expanding) {
      const base = `#${chip.name}`;
      const baseW = ansi.width(base);
      const expandedInner = Math.max(baseW + 1 + expandIconW, chipWidth(`#${chip.name}  ${expandPlain}`) - 2);
      const full = `${base}${' '.repeat(Math.max(0, expandedInner - baseW - expandIconW))}${expandStyled}`;
      inner = ansi.width(full) > innerW ? ansi.truncate(full, innerW) : padCells(full, innerW);
      iconsVisible = innerW >= baseW + 1 + expandIconW;
    } else if (chip.cancel) {
      const base = `#${state.channelDraft || ''}`;
      const caret = 1 + Math.min(draftCaret, (state.channelDraft || '').length);
      const cross = `${ansi.fg(PALETTE.keyD)}×${ansi.reset()}`;
      const room = Math.max(1, innerW - 1);
      const left = landing.buildField({
        text: base,
        placeholder: '#',
        active: true,
        width: room,
        caret,
        bar: 0,
      });
      inner = padCells(left, room) + cross;
    }
    const box = paintBoxChip(inner, chip.w, color, { bold: chip.active && !isCreate, dim: isCreate && !chip.hover });
    styled[0] += box.top;
    styled[1] += box.mid;
    styled[2] += box.bot;
    hits.push({
      type: chip.type,
      name: chip.name,
      x: originX + chip.x,
      y: originY,
      w: chip.w,
      h: 3,
    });
    if (iconsVisible && chip.name !== 'main' && chip.name !== '+') {
      hits.push({
        type: 'channel-action',
        action: 'delete',
        name: chip.name,
        x: originX + chip.x + chip.w - 2,
        y: originY + 1,
        w: 1,
        h: 1,
      });
    }
    if (chip.cancel) {
      hits.push({
        type: 'cancel-create',
        x: originX + chip.x + chip.w - 2,
        y: originY + 1,
        w: 1,
        h: 1,
      });
    }
  }
  lines[0] = padCells(styled[0], width);
  lines[1] = padCells(styled[1], width);
  lines[2] = padCells(styled[2], width);
  return { lines, hits };
}

function buildBirdLines(width, height, frame, animate = true) {
  const tier = (() => {
    for (const candidate of landing.LOGO_TIERS) {
      const w = Math.max(...candidate.art.map((line) => ansi.width(line)));
      if (w <= Math.max(1, width - 2) && candidate.art.length <= Math.max(1, height - 2)) {
        return candidate;
      }
    }
    return landing.LOGO_TIERS[landing.LOGO_TIERS.length - 1];
  })();
  const artW = Math.max(...tier.art.map((line) => ansi.width(line)));
  const left = Math.max(0, Math.floor((width - artW) / 2));
  const top = Math.max(0, Math.floor((height - tier.art.length) / 2));
  const lines = Array.from({ length: height }, () => fillRow('', width, {}));
  tier.art.forEach((artLine, row) => {
    const y = top + row;
    if (y < 0 || y >= height) return;
    const styled = landing.styleArtLine(artLine, row, frame, animate ? tier.shimmer : false);
    lines[y] = `${' '.repeat(left)}${styled}${' '.repeat(Math.max(0, width - left - ansi.width(artLine)))}`;
  });
  return lines;
}

function scrollbarGlyphs(trackH, total, view, offset) {
  const cells = Array.from({ length: Math.max(0, trackH) }, () => '│');
  if (trackH <= 0) return cells;
  if (total <= view) return cells;
  const thumbH = Math.max(1, Math.round((trackH * view) / total));
  const maxOff = Math.max(1, total - view);
  const travel = Math.max(0, trackH - thumbH);
  const fromTop = Math.round(((maxOff - offset) / maxOff) * travel);
  for (let i = 0; i < thumbH; i += 1) {
    const idx = fromTop + i;
    if (idx >= 0 && idx < trackH) cells[idx] = '█';
  }
  return cells;
}

function scrollOffsetFromY(y, region, maxScroll) {
  if (!region || region.h <= 1) return 0;
  const rel = (y - region.y) / Math.max(1, region.h - 1);
  const t = Math.max(0, Math.min(1, rel));
  return Math.round((1 - t) * maxScroll);
}

function scrollOffsetFromDrag(startOffset, startY, y, region, maxScroll) {
  const current = Math.max(0, Number(startOffset) || 0);
  if (!region || region.h <= 1 || maxScroll <= 0) return Math.min(current, Math.max(0, maxScroll));
  const view = region.h;
  const total = maxScroll + view;
  const thumbH = Math.max(1, Math.round((view * view) / Math.max(1, total)));
  const travel = Math.max(1, view - thumbH);
  const delta = Math.round((-(y - startY) / travel) * maxScroll);
  return Math.max(0, Math.min(maxScroll, current + delta));
}

function hideChannelBar(state) {
  if (!state || !state.activeGroupId) return true;
  if (state.loadingGroup) return true;
  return !!(state.transition && state.transition.kind === 'group');
}

function findMessageBounds(flat, id) {
  if (id == null) return null;
  const want = String(id);
  let start = -1;
  let end = -1;
  for (let i = 0; i < flat.length; i += 1) {
    if (flat[i].kind === 'row' && String(flat[i].item.msg?.id) === want) {
      if (start < 0) start = i;
      end = i + 1;
    }
  }
  if (start < 0) return null;
  if (start > 0 && flat[start - 1].kind === 'gap') start -= 1;
  if (end < flat.length && flat[end].kind === 'gap') end += 1;
  return { start, end };
}

function clampScrollForMessage(offset, bounds, total, viewH) {
  if (!bounds || viewH <= 0) return offset;
  const maxOff = Math.max(0, total - viewH);
  const atTop = total - viewH - bounds.start;
  const atBottom = total - bounds.end;
  const min = Math.min(atTop, atBottom);
  const max = Math.max(atTop, atBottom);
  return Math.max(0, Math.min(maxOff, Math.max(min, Math.min(max, offset))));
}

function offsetToShowMessage(bounds, total, viewH) {
  if (!bounds || viewH <= 0) return 0;
  const maxOff = Math.max(0, total - viewH);
  const mid = Math.floor((bounds.start + bounds.end) / 2);
  const offset = total - mid - Math.floor(viewH / 2);
  return Math.max(0, Math.min(maxOff, offset));
}

function buildComposerHint(state, width) {
  let left = '';
  if (state.error) left = `${ansi.fg(PALETTE.error)}${state.error}${ansi.reset()}`;
  else if (state.editingId) left = `${ansi.fg(PALETTE.muted)}editing${ansi.reset()}`;
  else if (state.replyTo) left = `${ansi.fg(PALETTE.muted)}↩  ${state.replyTo.name || 'reply'}${ansi.reset()}`;
  else if (state.typing && state.typing.username) {
    const pulse = Math.floor((state.animFrame || 0) / 8) % 2 === 0;
    left = `${ansi.fg(PALETTE.muted)}${state.typing.username} is typing${pulse ? '…' : '   '}${ansi.reset()}`;
  }

  let right = '';
  let rightActions = [];
  if (state.overlay && state.overlay.type === 'delete') {
    const label = pulseText('confirm deletion?', state.animFrame, PALETTE.error, '#7a2d2d');
    const key = `${ansi.fg(PALETTE.error)}enter${ansi.reset()}`;
    right = `${label}   ${key}`;
  } else if (state.channelMenu) {
    rightActions = channelHintActions(state.channelMenu);
    right = styleHint(rightActions);
  } else if (state.selectedMessageId) {
    const item = (state.messages || []).find((m) => String(m.msg?.id) === String(state.selectedMessageId));
    if (item) {
      rightActions = hintActionsFor(item, state.userId, actionMode(state));
      right = styleHint(rightActions);
    }
  }

  const leftW = ansi.width(left);
  const rightW = ansi.width(right);
  const gap = Math.max(1, width - PAD - leftW - rightW - 1);
  const row = `${' '.repeat(PAD)}${left}${' '.repeat(gap)}${right}`;
  return { line: padCells(row, width), rightActions, rightStart: PAD + leftW + gap };
}

function composerMetrics(state, boxWidth) {
  const innerW = Math.max(1, boxWidth - 2);
  const placeholder = state.editingId ? 'edit message' : 'message';
  const raw = state.composer || '';
  const usingPlaceholder = raw.length === 0;
  const textW = innerW - 1;
  const wrapped = wrapIndexed(usingPlaceholder ? placeholder : raw, textW);
  const total = Math.max(1, wrapped.length);
  const innerH = Math.min(COMPOSER_MAX_INNER, Math.max(COMPOSER_MIN_INNER, total));
  const overflow = total > COMPOSER_MAX_INNER;
  let caretLine = 0;
  let caretCol = 0;
  if (!usingPlaceholder) {
    const at = Math.max(0, Math.min(state.composerCaret || 0, raw.length));
    for (let i = 0; i < wrapped.length; i += 1) {
      const start = wrapped[i].start;
      const next = i + 1 < wrapped.length ? wrapped[i + 1].start : raw.length + 1;
      if (at >= start && at < next) {
        caretLine = i;
        caretCol = ansi.width((wrapped[i].text || '').slice(0, at - start));
        break;
      }
      if (at === raw.length && i === wrapped.length - 1) {
        caretLine = i;
        caretCol = ansi.width(wrapped[i].text || '');
      }
    }
    if (caretCol >= textW) {
      if (caretLine === wrapped.length - 1) {
        wrapped.push({ start: raw.length, text: '' });
      }
      caretLine += 1;
      caretCol = 0;
    }
  } else {
    caretCol = 0;
  }
  let lineScroll = state.composerScroll || 0;
  if (caretLine < lineScroll) lineScroll = caretLine;
  if (caretLine >= lineScroll + innerH) lineScroll = caretLine - innerH + 1;
  lineScroll = Math.max(0, Math.min(Math.max(0, total - innerH), lineScroll));
  return {
    innerW,
    textW,
    wrapped,
    total,
    innerH,
    overflow,
    caretLine,
    caretCol,
    lineScroll,
    usingPlaceholder,
    placeholder,
    chrome: innerH + 4,
  };
}

function buildComposerBox(state, width, metrics) {
  const color = PALETTE.composerOutline;
  const lines = [boxTop(width, color)];
  const bar = scrollbarGlyphs(metrics.innerH, metrics.total, metrics.innerH, metrics.total - metrics.innerH - metrics.lineScroll);
  const shown = metrics.wrapped.slice(metrics.lineScroll, metrics.lineScroll + metrics.innerH);
  while (shown.length < metrics.innerH) shown.push({ start: 0, text: '' });
  shown.forEach((entry, i) => {
    const absLine = metrics.lineScroll + i;
    const placeholderOnly = metrics.usingPlaceholder && absLine === 0;
    let caretCell = -1;
    if (placeholderOnly) caretCell = 0;
    else if (!metrics.usingPlaceholder && absLine === metrics.caretLine) caretCell = metrics.caretCol;
    const onLine = caretCell >= 0;
    const painted = landing.buildField({
      text: placeholderOnly ? '' : (entry.text || ''),
      placeholder: placeholderOnly ? metrics.placeholder : ' ',
      active: onLine,
      width: metrics.textW,
      caret: onLine ? (placeholderOnly ? 0 : metrics.caretCol) : 0,
      bar: 0,
    });
    const thumb = metrics.overflow
      ? (bar[i] === '█' ? `${ansi.fg(PALETTE.thumb)}█${ansi.reset()}` : `${ansi.fg(PALETTE.track)}│${ansi.reset()}`)
      : ' ';
    lines.push(boxRow(painted + thumb, width, color));
  });
  lines.push(boxBottom(width, color));
  return lines;
}

function showBird(state) {
  return !state.activeGroupId || !!state.transition || !!state.loadingGroup;
}

function birdAnimated(state) {
  return !!(state.transition || state.loadingGroup);
}

function showComposer(state) {
  return !!(state.activeGroupId && !state.transition && !state.loadingGroup);
}

function outlineColor(hover) {
  if (hover) return PALETTE.outline;
  return null;
}

function buildChatFrame(cols, rows, state = DEFAULT_CHAT) {
  const width = Math.max(1, cols);
  const height = Math.max(1, rows);
  const sideW = sidebarWidth(width);
  const mainX = sideW > 0 ? sideW + 1 : 0;
  const mainW = Math.max(1, width - mainX);
  const barX = width - SCROLLBAR_W;
  const contentW = Math.max(1, mainW - SCROLLBAR_W);
  const boxW = Math.max(8, contentW - PAD);
  const textW = Math.max(1, boxW - 2);
  const hideComp = !showComposer(state);
  const metrics = hideComp
    ? {
      innerW: 1, textW: 1, wrapped: [], total: 0, innerH: 0, overflow: false,
      caretLine: 0, caretCol: 0, lineScroll: 0, usingPlaceholder: true,
      placeholder: '', chrome: 0,
    }
    : composerMetrics(state, boxW);
  const composerH = metrics.chrome;
  const hideBar = hideChannelBar(state);
  const transcriptY = hideBar ? 0 : CHANNEL_ROWS;
  const transcriptH = Math.max(1, height - transcriptY - composerH);
  const composerY = height - composerH;

  const regions = {
    sidebar: { x: 0, y: 0, w: sideW, h: height },
    channels: { x: mainX, y: 0, w: contentW, h: CHANNEL_ROWS },
    transcript: { x: mainX, y: transcriptY, w: contentW, h: transcriptH },
    scrollbar: { x: barX, y: transcriptY, w: SCROLLBAR_W, h: transcriptH },
    composer: { x: mainX + PAD, y: composerY + 2, w: boxW, h: metrics.innerH },
    hint: { x: mainX, y: composerY, w: contentW, h: 1 },
    composerBar: { x: mainX + PAD + boxW - 1, y: composerY + 2, w: 1, h: metrics.innerH },
  };

  const hits = [];
  const lines = Array.from({ length: height }, () => ' '.repeat(width));
  const recipients = groupRecipientCount(state);

  const side = buildSidebar(state, sideW, height);
  const channels = hideBar ? { lines: [], hits: [] } : buildChannelBar(state, contentW, mainX, 0);
  hits.push(...side.hits, ...channels.hits);

  const filtered = filterMessages(state.messages, state.activeChannel);
  const mode = actionMode(state);
  const blocks = filtered.map((item) => ({
    item,
    layout: layoutMessage(item, textW, state.userId, mode),
  }));

  const flat = [];
  const showMore = !!(state.hasMoreHistory || state.loadingMore);
  if (showMore) {
    flat.push({ kind: 'more', item: null, row: 'Loading more...', rowInBlock: -1, layout: null });
  }
  if (blocks.length) flat.push({ kind: 'gap', item: null, row: '', rowInBlock: -1, layout: null });
  for (const block of blocks) {
    if (flat.length > 1) flat.push({ kind: 'gap', item: null, row: '', rowInBlock: -1, layout: null });
    block.layout.rows.forEach((row, rowInBlock) => {
      flat.push({ kind: 'row', item: block.item, row, rowInBlock, layout: block.layout });
    });
  }
  if (blocks.length) flat.push({ kind: 'gap', item: null, row: '', rowInBlock: -1, layout: null });

  const totalLines = flat.length;
  let maxScroll = Math.max(0, totalLines - transcriptH);
  const selectedId = state.selectedMessageId != null ? String(state.selectedMessageId) : null;
  const hoverId = state.hoverMessageId != null ? String(state.hoverMessageId) : null;
  const bounds = state.overlay && state.overlay.type === 'delete'
    ? findMessageBounds(flat, state.overlay.messageId || selectedId)
    : null;
  let offset = Math.max(0, Math.min(state.scrollOffset || 0, maxScroll));
  if (bounds) offset = clampScrollForMessage(offset, bounds, totalLines, transcriptH);
  const start = Math.max(0, totalLines - transcriptH - offset);
  const visible = flat.slice(start, start + transcriptH);
  const selectedBounds = selectedId ? findMessageBounds(flat, selectedId) : null;
  const bird = showBird(state);
  const birdH = hideBar && bird ? composerY : transcriptH;
  const birdLines = bird
    ? buildBirdLines(
      contentW,
      birdH,
      birdAnimated(state) ? (state.animFrame || 0) : 0,
      birdAnimated(state)
    )
    : null;
  const bar = scrollbarGlyphs(transcriptH, bird ? 0 : totalLines, transcriptH, offset);
  const protectedRows = new Set();
  const confirmHits = [];

  const join = (left, mid, barGlyph) => {
    const divider = sideW > 0 ? `${ansi.fg(PALETTE.border)}│${ansi.reset()}` : '';
    const thumb = barGlyph === '█';
    const barCell = thumb
      ? `${ansi.fg(PALETTE.thumb)}${barGlyph}${ansi.reset()}`
      : `${ansi.fg(PALETTE.track)}${barGlyph || ' '}${ansi.reset()}`;
    return (left || '') + divider + padCells(mid, contentW) + barCell;
  };

  for (let i = 0; i < transcriptH; i += 1) {
    const screenY = transcriptY + i;
    const left = sideW > 0 ? (side.lines[screenY] || fillRow('', sideW, {})) : '';
    if (bird) {
      const birdRow = hideBar ? CHANNEL_ROWS + i : i;
      lines[screenY] = join(left, birdLines[birdRow] || fillRow('', contentW, {}), ' ');
      continue;
    }
    const abs = start + i;
    const entry = visible[i];
    const prev = abs > 0 ? flat[abs - 1] : null;
    const next = abs + 1 < flat.length ? flat[abs + 1] : null;
    const idOf = (node) => (node && node.kind === 'row' ? String(node.item.msg?.id || '') : '');

    if (entry && entry.kind === 'more') {
      const label = 'Loading more...';
      const pulsed = pulseText(label, state.animFrame, PALETTE.title, PALETTE.muted);
      const padL = Math.max(0, Math.floor((contentW - ansi.width(label)) / 2));
      lines[screenY] = join(left, `${' '.repeat(padL)}${pulsed}`, bar[i]);
      continue;
    }

    if (!entry || entry.kind === 'gap') {
      const nextId = idOf(next);
      const prevId = idOf(prev);
      const nextColor = outlineColor(nextId && nextId === hoverId);
      const prevColor = outlineColor(prevId && prevId === hoverId);
      let mid;
      if (nextColor) {
        mid = `${' '.repeat(PAD)}${boxTop(boxW, nextColor)}`;
        if (nextId && (nextId === selectedId || (state.overlay && String(state.overlay.messageId) === nextId))) {
          protectedRows.add(screenY);
        }
      } else if (prevColor) {
        mid = `${' '.repeat(PAD)}${boxBottom(boxW, prevColor)}`;
        if (prevId && (prevId === selectedId || (state.overlay && String(state.overlay.messageId) === prevId))) {
          protectedRows.add(screenY);
        }
      } else {
        mid = fillRow('', contentW, {});
        hits.push({ type: 'gap', x: mainX, y: screenY, w: contentW, h: 1 });
      }
      lines[screenY] = join(left, mid, bar[i]);
      continue;
    }

    const id = String(entry.item.msg?.id || '');
    const hover = hoverId !== null && id === hoverId;
    const selected = selectedId !== null && id === selectedId;
    const deleting = !!(state.overlay && state.overlay.type === 'delete'
      && String(state.overlay.messageId) === id);
    const color = outlineColor(hover && !deleting);
    const showIcons = (hover || selected) && !deleting;
    const painted = paintMessageRow(entry.row, textW, {
      raised: selected,
      deleting,
      isMeta: entry.rowInBlock === entry.layout.metaRow,
      isReply: entry.rowInBlock === entry.layout.replyRow,
      isIconRow: entry.rowInBlock === entry.layout.iconRow,
      showIcons,
      hoverAction: (hover || selected) ? state.hoverAction : null,
      actions: entry.layout.actions,
      sending: !!entry.item.sending,
      animFrame: state.animFrame || 0,
      isImageRow: entry.layout.card && entry.rowInBlock === entry.layout.card.start && isImage(entry.item),
      nameTint: entry.rowInBlock === entry.layout.metaRow ? nameColor(entry.item) : null,
      stamp: entry.rowInBlock === entry.layout.metaRow
        ? formatStamp(entry.item.msg?.createdAt, state.now || undefined)
        : '',
      ticks: entry.rowInBlock === entry.layout.iconRow
        ? tickStrip(entry.item, recipients)
        : ''.padEnd(TICK_GUTTER, ' '),
      item: entry.item,
      replyHot: hover && entry.rowInBlock === entry.layout.replyRow,
    });
    let inner;
    if (color) inner = boxRow(painted, boxW, color);
    else if (deleting || selected) inner = ` ${painted} `;
    else inner = ` ${painted} `;
    lines[screenY] = join(left, `${' '.repeat(PAD)}${inner}`, bar[i]);

    if (selected || (state.overlay && state.overlay.type === 'delete' && String(state.overlay.messageId) === id)) {
      protectedRows.add(screenY);
    }

    hits.push({
      type: 'message',
      id: entry.item.msg.id,
      x: mainX,
      y: screenY,
      w: contentW,
      h: 1,
    });

    if (entry.rowInBlock === entry.layout.replyRow && entry.item.replyTo?.id) {
      hits.push({
        type: 'reply-ref',
        id: entry.item.replyTo.id,
        parentId: entry.item.msg.id,
        x: mainX + PAD + 1,
        y: screenY,
        w: textW,
        h: 1,
      });
    }

    if (showIcons && entry.rowInBlock === entry.layout.iconRow) {
      for (const hit of iconHits(entry.layout.actions, mainX + PAD + 1, screenY, textW)) {
        hits.push({ ...hit, id: entry.item.msg.id });
      }
    }

    const card = entry.layout.card;
    if (card && entry.rowInBlock >= card.start && entry.rowInBlock < card.start + card.height) {
      hits.push({
        type: 'card',
        id: entry.item.msg.id,
        x: mainX + PAD + 1,
        y: screenY,
        w: card.width,
        h: 1,
      });
    }
  }

  hits.push({
    type: 'scrollbar',
    x: barX,
    y: transcriptY,
    w: SCROLLBAR_W,
    h: transcriptH,
  });

  const sideAt = (y) => (sideW > 0 ? (side.lines[y] || fillRow('', sideW, {})) : '');
  const withBar = (y, mid, barGlyph = ' ') => join(sideAt(y), mid, barGlyph);

  if (!hideBar) {
    for (let i = 0; i < CHANNEL_ROWS; i += 1) {
      lines[i] = withBar(i, channels.lines[i] || fillRow('', contentW, {}));
    }
  }

  if (!hideComp) {
    const hint = buildComposerHint(state, contentW);
    const boxLines = buildComposerBox(state, boxW, metrics);
    lines[composerY] = withBar(composerY, hint.line);
    boxLines.forEach((row, i) => {
      lines[composerY + 1 + i] = withBar(composerY + 1 + i, `${' '.repeat(PAD)}${row}`);
    });
    const padY = composerY + 1 + boxLines.length;
    if (padY < height) lines[padY] = withBar(padY, fillRow('', contentW, {}));

    if (hint.rightActions.length && !(state.overlay && state.overlay.type === 'delete')) {
      const hintId = state.selectedMessageId || state.channelMenu || null;
      for (const hit of hintHits(hint.rightActions, mainX, composerY, contentW)) {
        hits.push({ ...hit, id: hintId });
      }
    }

    hits.push({
      type: 'composer',
      x: mainX + PAD,
      y: composerY + 2,
      w: boxW,
      h: metrics.innerH,
    });
    if (metrics.overflow) {
      hits.push({
        type: 'composer-scrollbar',
        x: mainX + PAD + boxW - 1,
        y: composerY + 2,
        w: 1,
        h: metrics.innerH,
      });
    }
  }
  hits.push(...confirmHits);

  if (state.overlay && state.overlay.type === 'delete') {
    if (!hideComp) protectedRows.add(composerY);
    for (let y = 0; y < height; y += 1) {
      if (!protectedRows.has(y)) lines[y] = dimLine(lines[y]);
    }
  }

  if (state.overlay && state.overlay.type === 'error') {
    const overlayHits = paintErrorToast(lines, width, height, state.overlay);
    hits.push(...overlayHits);
  }

  for (let i = 0; i < lines.length; i += 1) {
    if (ansi.width(lines[i]) < width) lines[i] = padCells(lines[i], width);
    else if (ansi.width(lines[i]) > width) lines[i] = ansi.truncate(lines[i], width);
  }

  return {
    lines,
    regions,
    hits,
    visibleCount: visible.filter((v) => v && v.kind === 'row').length,
    totalLines,
    maxScroll,
    scrollOffset: offset,
    messageBounds: bounds,
    selectedBounds,
    composerMetrics: metrics,
    shouldLoadMore: !!(
      (state.hasMoreHistory || state.loadingMore)
      && !state.loadingMore
      && state.hasMoreHistory
      && visible.some((entry) => entry && entry.kind === 'more')
    ),
  };
}

function paintErrorToast(lines, cols, rows, overlay) {
  const msg = String(overlay.message || 'error').slice(0, 40);
  const text = ` ${msg} `;
  const w = ansi.width(text) + 2;
  const x = Math.max(0, Math.floor((cols - w) / 2));
  const y = Math.max(0, Math.floor(rows / 2));
  lines[y] = `${' '.repeat(x)}${fillRow(text, w, { fg: PALETTE.error, bold: true })}`;
  return [{ type: 'overlay', x, y, w, h: 1 }];
}

function composeChatFrame(cols, rows, state) {
  const { lines } = buildChatFrame(cols, rows, state);
  let out = ansi.cursorHide();
  for (let i = 0; i < lines.length; i += 1) {
    out += ansi.cursorTo(0, i) + ansi.eraseLine() + ansi.truncate(lines[i], cols);
  }
  return out;
}

module.exports = {
  PALETTE,
  ACTIONS,
  TEXT,
  PAD,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  CHANNEL_ROWS,
  CHANNEL_EXPAND_FRAMES,
  PROFILE_FRAMES,
  HISTORY_PAGE,
  SCROLL_TWEEN_MS,
  ACTION_SLOTS,
  ACTION_GUTTER,
  TICK_GUTTER,
  CONTENT_GUTTER,
  COMPOSER_MIN_INNER,
  COMPOSER_MAX_INNER,
  SCROLLBAR_W,
  WHEEL_LINES,
  TRANSITION_MS,
  DEFAULT_CHAT,
  sidebarWidth,
  sidebarTitle,
  formatTime,
  formatStamp,
  formatBytes,
  wrapText,
  wrapIndexed,
  actionListFor,
  hintActionsFor,
  styleHint,
  layoutMessage,
  hitTest,
  filterMessages,
  scrollOffsetFromY,
  scrollOffsetFromDrag,
  hideChannelBar,
  showComposer,
  birdAnimated,
  groupRecipientCount,
  tickStrip,
  paintLineWithCaret,
  CARET_LETTER,
  findMessageBounds,
  clampScrollForMessage,
  offsetToShowMessage,
  actionMode,
  replyPreviewText,
  buildComposerHint,
  composerMetrics,
  buildBirdLines,
  nameColor,
  hashNameColor,
  buildChatFrame,
  composeChatFrame,
};
