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
const {
  PALETTE,
  DARK,
  runWithTheme,
  withBg,
  paintCanvasLine,
} = require('./theme');
const { composeFull } = require('./paint');

const CARET_LETTER = DARK.caretLetter;

const TEXT = '\uFE0E';

const ACTIONS = {
  reply: { id: 'reply', key: 'r', glyph: '↩', word: 'reply', mod: 'ctrl', get color() { return PALETTE.keyR; } },
  edit: { id: 'edit', key: 'e', glyph: `${'✎'}${TEXT}`, word: 'edit', mod: 'ctrl', get color() { return PALETTE.keyE; } },
  delete: { id: 'delete', key: 'd', glyph: '×', word: 'delete', mod: 'ctrl', get color() { return PALETTE.keyD; } },
  preview: { id: 'preview', key: 'p', glyph: '▣', word: 'preview', mod: 'ctrl', get color() { return PALETTE.keyP; } },
  copy: { id: 'copy', key: 'c', glyph: null, word: 'copy', mod: 'ctrl', get color() { return PALETTE.keyC; } },
  clear: { id: 'clear', key: 'Escape', glyph: null, word: 'clear (esc)', get color() { return PALETTE.muted; } },
  cancel: { id: 'clear', key: 'Escape', glyph: null, word: 'cancel', get color() { return PALETTE.muted; } },
  focus: { id: 'focus', key: 'f', glyph: null, word: 'focus', mod: 'ctrl', get color() { return PALETTE.theme; } },
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
const BIRD_FLIGHT_MS = landing.BIRD_FLIGHT_MS;
const CHANNEL_EXPAND_FRAMES = 8;
const PROFILE_FRAMES = 18;
const HISTORY_PAGE = 50;
const SCROLL_TWEEN_MS = 220;
const GLIMMER = landing.TEXT_SHIMMER;
const PROFILE_NAME_OFFSET = 3;
const PROFILE_BUTTON_ROWS = 1;
const PROFILE_BUTTON_COUNT = 3;
const PROFILE_BUTTON_GAP = 1;
/** Closed: rule + blank + name. Open: rule + pad + three 1-line controls with a gap + pad + name. */
const PROFILE_LIFT = 1 + PROFILE_BUTTON_COUNT * PROFILE_BUTTON_ROWS
  + (PROFILE_BUTTON_COUNT - 1) * PROFILE_BUTTON_GAP;

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
  composerFollowCaret: true,
  birdFlight: null,
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
  profileCloseFrom: 0,
  profileCloseFrame: 0,
  hoverLogout: false,
  hoverTheme: false,
  hoverSensitivity: false,
  theme: 'dark',
  scrollSensitivity: 1,
  profileCursor: null,
  inputFocusBeforeProfile: null,
  hoverReply: false,
  scrollTween: null,
  scrollBatch: 0,
  scrollBatchTotal: 0,
  inputFocus: 'composer',
  highlightedGroupId: null,
  flash: null,
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
      line += token;
      lineW += tokenW;
      consumed += token.length;
    }
    lines.push({ start: lineStart, text: line });
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

function fillRow(plain, width, opts = {}) {
  const bg = opts.bg === undefined ? PALETTE.canvas : opts.bg;
  const fg = opts.fg || null;
  const bold = !!opts.bold;
  const dim = !!opts.dim;
  const underlineOn = !!opts.underline;
  const clipped = ansi.width(plain) > width ? ansi.stripAnsi(ansi.truncate(plain, width)) : plain;
  const pad = ' '.repeat(Math.max(0, width - ansi.width(clipped)));
  const style = `${bg ? ansi.bg(bg) : ''}${fg ? ansi.fg(fg) : ''}${bold ? ansi.bold() : ''}${dim ? ansi.dim() : ''}${underlineOn ? ansi.underline() : ''}`;
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
  return [...actionListFor(item, userId, mode), ACTIONS.copy, ACTIONS.focus];
}

const PROFILE_ITEMS = ['logout', 'theme', 'sensitivity'];

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
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function dayKey(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatDayLabel(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()];
  return `${mon} ${date.getDate()}`;
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

function hintWord(action, compact = false) {
  if (compact && action.mod === 'ctrl') return String(action.key || action.word?.[0] || action.id);
  if (compact && action.id === 'clear') return 'esc';
  return action.word || action.label || action.id;
}

function styleHotWord(action, compact = false) {
  const color = action.color || PALETTE.muted;
  const word = hintWord(action, compact);
  const hot = String(action.key || '');
  const canHot = hot && hot.length === 1 && hot !== 'Escape';
  if (!canHot) return `${ansi.fg(color)}${word}${ansi.reset()}`;
  if (compact && action.mod === 'ctrl') {
    return `${ansi.bold()}${ansi.fg(color)}${word}${ansi.reset()}`;
  }
  const at = word.toLowerCase().indexOf(hot.toLowerCase());
  if (at < 0) return `${ansi.fg(color)}${word}${ansi.reset()}`;
  return `${ansi.fg(PALETTE.muted)}${word.slice(0, at)}${ansi.reset()}`
    + `${ansi.bold()}${ansi.fg(color)}${word.slice(at, at + 1)}${ansi.reset()}`
    + `${ansi.fg(PALETTE.muted)}${word.slice(at + 1)}${ansi.reset()}`;
}

function groupHintActions(list) {
  const groups = [];
  const rest = [];
  const byMod = new Map();
  for (const action of list || []) {
    if (action.mod) {
      if (!byMod.has(action.mod)) {
        const bucket = [];
        byMod.set(action.mod, bucket);
        groups.push({ mod: action.mod, actions: bucket });
      }
      byMod.get(action.mod).push(action);
    } else {
      rest.push(action);
    }
  }
  return { groups, rest };
}

function modPrefix(mod, compact = false) {
  const name = String(mod || 'ctrl');
  return compact ? `${name}+` : `${name} + `;
}

function styleHint(actions, maxWidth = 0) {
  const render = (compact) => {
    const { groups, rest } = groupHintActions(actions);
    const gap = compact ? ' ' : '  ';
    const parts = [];
    for (const group of groups) {
      const prefix = `${ansi.fg(PALETTE.muted)}${modPrefix(group.mod, compact)}${ansi.reset()}`;
      parts.push(prefix + styleHotWord(group.actions[0], compact));
      for (const action of group.actions.slice(1)) parts.push(styleHotWord(action, compact));
    }
    for (const action of rest) parts.push(styleHotWord(action, compact));
    return parts.join(gap);
  };
  const wide = render(false);
  if (!(maxWidth > 0) || ansi.width(wide) <= maxWidth) return wide;
  return render(true);
}

function hintHits(actions, originX, originY, rowWidth) {
  const compact = ansi.width(styleHint(actions, 0)) > Math.max(1, rowWidth - 1);
  const gap = compact ? 1 : 2;
  const { groups, rest } = groupHintActions(actions);
  const parts = [];
  for (const group of groups) {
    const prefix = modPrefix(group.mod, compact);
    group.actions.forEach((action, i) => {
      let w = ansi.width(hintWord(action, compact));
      if (i === 0) w += ansi.width(prefix);
      parts.push({ action, w });
    });
  }
  for (const action of rest) {
    parts.push({ action, w: ansi.width(hintWord(action, compact)) });
  }
  const total = parts.reduce((sum, p) => sum + p.w, 0) + Math.max(0, parts.length - 1) * gap;
  let x = originX + Math.max(0, rowWidth - total - 1);
  const hits = [];
  for (const part of parts) {
    hits.push({ type: 'action', action: part.action.id, id: null, x, y: originY, w: part.w, h: 1 });
    x += part.w + gap;
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
  return preview ? `↩  ${name}: ${preview}` : `↩  ${name}`;
}

function replyLine(item) {
  return item?.replyTo ? replyPreviewText(item) : null;
}

function paintReplyPreview(item, width, { hot = false, bg = null } = {}) {
  const reply = item?.replyTo || {};
  const name = reply.name || 'message';
  const color = reply.color || hashNameColor(name);
  const preview = String(reply.preview || '').replace(/\s+/g, ' ');
  const symbol = '↩  ';
  const namePart = preview ? `${name}:` : name;
  const dim = hot ? '' : ansi.dim();
  const prefixW = ansi.width(symbol) + ansi.width(namePart) + (preview ? 1 : 0);
  let previewPart = preview;
  if (previewPart && prefixW + ansi.width(previewPart) > width) {
    const room = Math.max(1, width - prefixW - 1);
    previewPart = `${ansi.stripAnsi(ansi.truncate(previewPart, room))}…`;
  }
  let nameShown = namePart;
  const shownPreview = previewPart ? ` ${previewPart}` : '';
  if (ansi.width(symbol + nameShown + shownPreview) > width) {
    const room = Math.max(1, width - ansi.width(symbol) - 1);
    nameShown = `${ansi.stripAnsi(ansi.truncate(nameShown, room))}…`;
  }
  const plain = `${symbol}${nameShown}${previewPart && nameShown === namePart ? shownPreview : ''}`;
  const styled = `${dim}${ansi.fg(PALETTE.muted)}${symbol}${ansi.reset()}`
    + `${hot ? ansi.bold() : dim}${ansi.fg(color)}${nameShown}${ansi.reset()}`
    + (previewPart && nameShown === namePart
      ? `${dim}${ansi.italic()}${ansi.fg(color)}${shownPreview}${ansi.reset()}`
      : '');
  return withBg(`${styled}${' '.repeat(Math.max(0, width - ansi.width(plain)))}`, bg);
}

function hashNameColor(name) {
  const colors = PALETTE.nameColors;
  let hash = 0;
  for (const ch of String(name || '?')) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
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
  return pulseText('sending...', frame, PALETTE.title, PALETTE.muted);
}

function deletingLabel(frame) {
  return pulseText('deleting...', frame, PALETTE.error, PALETTE.deletePulse);
}

function paintMessageRow(plain, width, {
  raised, deleting, isMeta, isReply, isIconRow, showIcons, hoverAction, actions, sending,
  animFrame, isImageRow, nameTint, stamp, ticks, item, replyHot,
}) {
  const pendingDelete = !!item?.deleting;
  const bg = deleting ? PALETTE.deleteBg : (raised && !pendingDelete ? PALETTE.selectedBg : PALETTE.canvas);
  const bgOn = bg ? ansi.bg(bg) : '';
  const finish = (row) => (pendingDelete && !deleting ? dimLine(row) : row);

  if (isMeta) {
    const stampText = stamp || '';
    const stampW = ansi.width(stampText);
    const nameMax = Math.max(1, width - stampW - (stampW ? 1 : 0));
    const name = ansi.stripAnsi(ansi.truncate(String(plain || ''), nameMax));
    const nameW = ansi.width(name);
    const mid = Math.max(0, width - nameW - stampW);
    const nameFg = pendingDelete ? PALETTE.muted : (nameTint || PALETTE.text);
    const left = `${bgOn}${ansi.fg(nameFg)}${ansi.bold()}${name}${ansi.reset()}`;
    const gap = `${bgOn}${' '.repeat(mid)}`;
    const right = stampText ? `${bgOn}${ansi.fg(PALETTE.muted)}${stampText}${ansi.reset()}` : '';
    return finish(withBg(`${left}${gap}${right}`, bg));
  }

  if (isReply) {
    return finish(paintReplyPreview(item, width, { hot: !!replyHot, bg }));
  }

  const statusPlain = sending ? 'sending...' : (pendingDelete ? 'deleting...' : '');
  const statusOnRow = !!(statusPlain && isIconRow);
  const shown = isIconRow && showIcons && !statusOnRow ? visibleActions(actions) : [];
  const actionW = statusOnRow ? ansi.width(statusPlain) : packedActionWidth(shown);
  const need = (actionW ? actionW + 1 : 0) + TICK_GUTTER;
  const steal = Math.max(0, need - CONTENT_GUTTER);
  const gutterW = CONTENT_GUTTER + steal;
  const bodyW = Math.max(1, width - gutterW);
  const body = isImageRow ? '[Image]' : String(plain || '');
  const bodyFg = isImageRow ? PALETTE.image : (sending || pendingDelete ? PALETTE.muted : PALETTE.text);
  let actionStyled = '';
  if (statusOnRow) {
    const label = sending ? sendingLabel(animFrame) : deletingLabel(animFrame);
    actionStyled = `${bgOn}${label}${ansi.reset()}`;
  } else {
    actionStyled = shown.map((action) => {
      const hot = hoverAction === action.id;
      return `${bgOn}${hot ? ansi.bold() : ''}${ansi.fg(action.color)}${action.glyph}${ansi.reset()}`;
    }).join(`${bgOn}${' '.repeat(ACTION_GAP)}`);
  }
  const tickText = isIconRow ? padStartCells(ticks || '', TICK_GUTTER) : ''.padStart(TICK_GUTTER, ' ');
  const midW = Math.max(0, gutterW - (actionW ? actionW + 1 : 0) - TICK_GUTTER);
  const bodyStyled = `${bgOn}${ansi.fg(bodyFg)}${padCells(body, bodyW)}${ansi.reset()}`;
  const gutterStyled = `${bgOn}${' '.repeat(midW)}`
    + (actionW ? `${actionStyled}${bgOn} ` : '')
    + `${tickText}${ansi.reset()}`;
  return finish(withBg(bodyStyled + gutterStyled, bg));
}

function boxTop(width, color, fill = null, title = '') {
  const inner = Math.max(0, width - 2);
  let mid = '─'.repeat(inner);
  const name = title ? ` ${String(title).trim()} ` : '';
  if (name && ansi.width(name) < inner) {
    mid = `${name}${'─'.repeat(Math.max(0, inner - ansi.width(name)))}`;
  }
  return fillRow(`╭${mid}╮`, width, { fg: color, bg: fill || undefined });
}

function boxBottom(width, color, fill = null) {
  return fillRow(`╰${'─'.repeat(Math.max(0, width - 2))}╯`, width, { fg: color, bg: fill || undefined });
}

function boxRow(inner, width, color, fill = null) {
  const bgOn = fill ? ansi.bg(fill) : '';
  const reset = ansi.reset();
  return `${bgOn}${ansi.fg(color)}│${reset}${bgOn}${padCells(inner, Math.max(0, width - 2))}${bgOn}${ansi.fg(color)}│${reset}`;
}

function pulseText(text, frame, hotColor, idleColor) {
  return landing.pulseText(text, frame, hotColor, idleColor, GLIMMER);
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
  return `GChat CLI ${landing.TUI_VERSION}`;
}

function profileProgress(state) {
  const frames = Math.max(1, PROFILE_FRAMES);
  const raw = Number(state?.profileExpandFrame);
  const frame = Number.isFinite(raw) ? raw : 0;
  return Math.min(1, Math.max(0, frame / frames));
}

function profileEase(state) {
  if (state && state.profileClosing) {
    const frames = Math.max(1, PROFILE_FRAMES);
    const raw = Number(state.profileCloseFrame);
    const u = Math.min(1, Math.max(0, (Number.isFinite(raw) ? raw : 0) / frames));
    const from = Math.min(1, Math.max(0, Number(state.profileCloseFrom) || 0));
    return from * (1 - landing.easeOutCubic(u));
  }
  return landing.easeOutCubic(profileProgress(state));
}

function profileLift(state) {
  return Math.round(PROFILE_LIFT * profileEase(state));
}

function profileLineFade(ease, lineIndex, lineCount = PROFILE_BUTTON_COUNT) {
  const count = Math.max(1, lineCount);
  const start = (lineIndex / count) * 0.72;
  const span = 0.28;
  const raw = Math.min(1, Math.max(0, (ease - start) / span));
  return landing.easeOutCubic(raw);
}

function sensitivityFromX(x, hit) {
  if (!hit) return 1;
  const w = Math.max(1, Number(hit.w) || 1);
  const rel = Number(x) - Number(hit.x || 0);
  const t = Math.max(0, Math.min(1, rel / Math.max(1, w - 1)));
  return 1 + Math.round(t * 19);
}

function paintStripeLabel(text, frame, hover, idleColor, hotColor) {
  if (!hover) return `${ansi.fg(idleColor)}${text}${ansi.reset()}`;
  return pulseText(text, frame, hotColor, idleColor);
}

function insetSidebarRow(label, width, inset, opts = {}) {
  const pad = Math.max(0, Number(inset) || 0);
  const innerW = Math.max(1, width - pad * 2);
  const inner = fillRow(padCells(String(label || ''), innerW), innerW, opts);
  if (pad <= 0) return inner;
  return `${fillRow('', pad, {})}${inner}${fillRow('', pad, {})}`;
}

function fadeHex(target, fade) {
  const t = Math.min(1, Math.max(0, Number(fade) || 0));
  if (t <= 0) return PALETTE.canvas;
  if (t >= 1) return target;
  return landing.lerpHex(PALETTE.canvas, target, t);
}

function paintButtonLabel(word, innerW, frame, hover, fade, idleFg, hotFg) {
  const label = String(word || '');
  const padL = 1;
  const room = Math.max(0, innerW - padL);
  const shown = ansi.width(label) > room ? ansi.stripAnsi(ansi.truncate(label, room)) : label;
  const color = hover ? (hotFg || idleFg) : idleFg;
  let body;
  if (hover && fade >= 1) body = pulseText(shown, frame, hotFg || color, idleFg);
  else body = `${ansi.fg(fadeHex(color, fade))}${shown}${ansi.reset()}`;
  const tail = ' '.repeat(Math.max(0, innerW - padL - ansi.width(shown)));
  return `${' '.repeat(padL)}${body}${tail}`;
}

function contrastOn(bgHex) {
  const rgb = ansi.hexToRgb(bgHex) || [0, 0, 0];
  const lum = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
  return lum < 165 ? '#ffffff' : '#1f2328';
}

function paintFillTrackWithLabel(innerW, value, fade, title) {
  const trackW = Math.max(1, innerW);
  const n = Math.max(1, Math.min(20, Math.round(Number(value) || 1)));
  const filled = Math.max(1, Math.round((n / 20) * trackW));
  const label = ` ${String(title || '').trim()} `;
  let out = '';
  for (let i = 0; i < trackW; i += 1) {
    const on = i < filled;
    const bg = fadeHex(on ? PALETTE.thumb : PALETTE.track, fade);
    const ch = i < label.length ? label[i] : ' ';
    const fg = on
      ? (PALETTE.thumbFg || contrastOn(bg))
      : (PALETTE.trackFg || contrastOn(bg));
    out += `${ansi.bg(bg)}${ansi.fg(fg)}${ch}`;
  }
  return `${out}${ansi.reset()}`;
}

function paintSidebarControl({
  label,
  width,
  inset,
  frame,
  hover,
  idleFg,
  hotFg,
  fade = 1,
  fillValue = null,
}) {
  const pad = Math.max(0, Number(inset) || 0);
  const boxW = Math.max(3, width - pad * 2);
  const innerW = Math.max(1, boxW - 2);
  const side = fillRow('', pad, {});
  const blank = fillRow('', width, {});
  if (!(fade > 0)) return { top: blank, mid: blank, bot: blank };
  const inner = fillValue != null
    ? paintFillTrackWithLabel(innerW, fillValue, fade, label || 'Sensitivity')
    : paintButtonLabel(label, innerW, frame, hover, fade, idleFg, hotFg);
  const outline = hover ? (idleFg || PALETTE.outline) : null;
  const mid = outline
    ? `${side}${boxRow(inner, boxW, outline)}${side}`
    : `${side} ${inner} ${side}`;
  return {
    top: outline ? `${side}${boxTop(boxW, outline)}${side}` : blank,
    mid,
    bot: outline ? `${side}${boxBottom(boxW, outline)}${side}` : blank,
  };
}

function profileNameRow(height) {
  return Math.max(2, (height || 1) - PROFILE_NAME_OFFSET);
}

function paintProfileNameRow(username, userColor, width, inset) {
  const pad = Math.max(0, Number(inset) || 0);
  const innerW = Math.max(1, width - pad * 2);
  const hintPlain = 'ctrl+a';
  const hintW = ansi.width(hintPlain);
  const nameBudget = Math.max(1, innerW - hintW - 1);
  const name = ansi.stripAnsi(ansi.truncate(` ${String(username || 'you')}`, nameBudget));
  const namePad = Math.max(0, nameBudget - ansi.width(name));
  const nameStyled = `${ansi.bold()}${ansi.fg(userColor)}${name}${' '.repeat(namePad)}${ansi.reset()}`;
  const hintStyled = `${ansi.fg(PALETTE.muted)}ctrl+${ansi.reset()}`
    + `${ansi.bold()}${ansi.fg(PALETTE.theme)}a${ansi.reset()}`;
  const inner = `${nameStyled} ${hintStyled}`;
  if (pad <= 0) return `${inner}${ansi.reset()}`;
  return `${fillRow('', pad, {})}${inner}${fillRow('', Math.max(0, width - pad - innerW), {})}`;
}

function buildSidebar(state, width, height, nameY = null) {
  const lines = [];
  const hits = [];
  if (width <= 0 || height <= 0) return { lines, hits };
  const inset = Math.min(2, PAD);
  lines.push(fillRow(`${' '.repeat(inset)}${sidebarTitle()}`, width, { fg: PALETTE.muted }));
  const list = state.groups || [];
  const eased = profileEase(state);
  const extra = profileLift(state);
  const profileNameY = Math.max(2, Math.min(height - 1, nameY == null ? profileNameRow(height) : nameY));
  const barY = Math.max(1, profileNameY - 2 - extra);
  const logoutY = barY + 2;
  const themeY = barY + 4;
  const sensY = barY + 6;
  lines.push(fillRow('', width, {}));
  let y = 2;
  for (let i = 0; i < list.length && y < barY; i += 1) {
    const group = list[i];
    const active = String(group.id) === String(state.activeGroupId);
    const highlighted = !active && String(group.id) === String(state.highlightedGroupId);
    const unread = Number(group.unreadCount) || 0;
    const badge = unread > 0 ? `[${unread > 99 ? '99+' : unread}]` : '';
    const innerW = Math.max(1, width - inset * 2);
    const nameW = Math.max(1, innerW - 1 - (badge ? ansi.width(badge) + 1 : 0));
    const label = ` ${padCells(String(group.name || '?'), nameW)}${badge ? ` ${badge}` : ''}`;
    lines.push(insetSidebarRow(label, width, inset, {
      fg: active ? PALETTE.title : PALETTE.text,
      bold: active,
      bg: active ? PALETTE.activeBg : undefined,
      underline: highlighted,
    }));
    hits.push({ type: 'group', id: group.id, x: 0, y, w: width, h: 1 });
    y += 1;
    if (y < barY) {
      lines.push(fillRow('', width, {}));
      y += 1;
    }
  }
  while (lines.length < height) lines.push(fillRow('', width, {}));

  const userColor = state.iconColor && /^#?[0-9a-fA-F]{6}$/.test(state.iconColor)
    ? (String(state.iconColor).startsWith('#') ? state.iconColor : `#${state.iconColor}`)
    : hashNameColor(state.username || '?');
  const uname = String(state.username || 'you');
  lines[barY] = fillRow('─'.repeat(Math.max(0, width)), width, { fg: PALETTE.rule });
  hits.push({ type: 'profile', x: 0, y: barY, w: width, h: 1 });
  const profileFocused = state.profileCursor != null;
  const covered = new Set();
  const placeButton = (midY, type, opts, fadeIndex) => {
    if (midY <= barY || midY >= profileNameY || midY < 0 || midY >= height) return;
    const fade = profileLineFade(eased, fadeIndex);
    if (!(fade > 0)) return;
    const box = paintSidebarControl({
      width,
      inset,
      frame: state.animFrame || 0,
      fade,
      ...opts,
    });
    if (midY - 1 > barY && (!opts.hover || lines[midY - 1] != null)) {
      if (opts.hover && box.top) lines[midY - 1] = box.top;
    }
    lines[midY] = box.mid;
    if (midY + 1 < profileNameY && opts.hover && box.bot) lines[midY + 1] = box.bot;
    if (fade > 0.45) {
      hits.push({
        type,
        x: inset,
        y: midY,
        w: Math.max(1, width - inset * 2),
        h: 1,
      });
    }
    covered.add(midY);
    if (opts.hover) {
      covered.add(midY - 1);
      covered.add(midY + 1);
    }
  };
  placeButton(logoutY, 'logout', {
    label: 'Log out',
    hover: !!state.hoverLogout || (profileFocused && state.profileCursor === 0),
    idleFg: PALETTE.error,
    hotFg: PALETTE.logoutHot,
  }, 0);
  placeButton(themeY, 'theme', {
    label: 'Theme',
    hover: !!state.hoverTheme || (profileFocused && state.profileCursor === 1),
    idleFg: PALETTE.theme,
    hotFg: PALETTE.themeHot,
  }, 1);
  placeButton(sensY, 'sensitivity', {
    label: 'Sensitivity',
    hover: !!state.hoverSensitivity || (profileFocused && state.profileCursor === 2),
    idleFg: PALETTE.thumb,
    hotFg: PALETTE.outlineStrong,
    fillValue: state.scrollSensitivity,
  }, 2);
  for (let py = barY + 1; py < profileNameY; py += 1) {
    if (covered.has(py)) continue;
    hits.push({ type: 'profile', x: 0, y: py, w: width, h: 1 });
  }
  if (profileNameY >= 0 && profileNameY < height) {
    lines[profileNameY] = paintProfileNameRow(uname, userColor, width, inset);
    hits.push({ type: 'profile', x: 0, y: profileNameY, w: width, h: 1 });
  }

  hits.unshift({ type: 'sidebar-empty', x: 0, y: 0, w: width, h: Math.max(0, barY) });
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

function paintBoxChip(innerStyled, w, color, { bold = false, dim = false, fill = null } = {}) {
  const innerW = Math.max(1, w - 2);
  const inner = padCells(innerStyled, innerW);
  const bgOn = fill ? ansi.bg(fill) : '';
  const fg = `${dim ? ansi.dim() : ''}${ansi.fg(color)}`;
  const reset = ansi.reset();
  return {
    top: `${bgOn}${fg}╭${'─'.repeat(innerW)}╮${reset}`,
    mid: `${bgOn}${fg}│${reset}${bgOn}${fg}${bold ? ansi.bold() : ''}${inner}${reset}${bgOn}${fg}│${reset}`,
    bot: `${bgOn}${fg}╰${'─'.repeat(innerW)}╯${reset}`,
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
      out += `${ansi.bg(fg)}${ansi.fg(PALETTE.caretLetter)}${ch === ' ' ? FIELD_CARET : ch}${ansi.reset()}`;
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
    const box = paintBoxChip(inner, chip.w, color, {
      bold: chip.active && !isCreate,
      dim: isCreate && !chip.hover,
      fill: chip.active && !isCreate ? PALETTE.activeBg : null,
    });
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

function pickBirdTier(width, height) {
  for (const candidate of landing.LOGO_TIERS) {
    const w = Math.max(...candidate.art.map((line) => ansi.width(line)));
    if (w <= Math.max(1, width - 2) && candidate.art.length <= Math.max(1, height - 2)) {
      return candidate;
    }
  }
  return landing.LOGO_TIERS[landing.LOGO_TIERS.length - 1];
}

function buildBirdLines(width, height, frame, animate = true, origin = null) {
  const tier = (origin && origin.tier) || pickBirdTier(width, height);
  const artW = Math.max(...tier.art.map((line) => ansi.width(line)));
  const left = origin && Number.isFinite(origin.x)
    ? Math.round(origin.x)
    : Math.max(0, Math.floor((width - artW) / 2));
  const top = origin && Number.isFinite(origin.y)
    ? Math.round(origin.y)
    : Math.max(0, Math.floor((height - tier.art.length) / 2));
  const lines = Array.from({ length: height }, () => fillRow('', width, {}));
  tier.art.forEach((artLine, row) => {
    const y = top + row;
    if (y < 0 || y >= height) return;
    const x = Math.max(0, left);
    const styled = landing.styleArtLine(artLine, row, frame, animate ? landing.BIRD_SHIMMER : false);
    const lead = ' '.repeat(x);
    const tail = ' '.repeat(Math.max(0, width - x - ansi.width(artLine)));
    lines[y] = `${lead}${styled}${tail}`;
  });
  return lines;
}

function idleBirdOrigin(cols, rows, state = DEFAULT_CHAT) {
  const width = Math.max(1, cols);
  const height = Math.max(1, rows);
  const sideW = sidebarWidth(width);
  const mainX = sideW > 0 ? sideW + 1 : 0;
  const contentW = Math.max(1, width - mainX - SCROLLBAR_W);
  // Same art as login/loading so the bird can hop left → middle → right
  // without changing size (a larger idle bird on 80×24 sat near center).
  const tier = landing.selectTier(width, height);
  const artW = Math.max(...tier.art.map((line) => ansi.width(line)));
  const left = Math.max(0, Math.floor((contentW - artW) / 2));
  return {
    x: mainX + left,
    y: landing.sharedBirdY(height, tier.art.length),
    artW,
    artH: tier.art.length,
    tier,
  };
}

function birdFlightPlacement(state, cols, rows) {
  const flight = state && state.birdFlight;
  if (!flight) return null;
  const raw = Math.min(1, Math.max(0, (Date.now() - Number(flight.at || 0)) / Math.max(1, Number(flight.ms) || BIRD_FLIGHT_MS)));
  const eased = 1 - (1 - raw) * (1 - raw);
  return {
    x: Number(flight.fromX) + (Number(flight.toX) - Number(flight.fromX)) * eased,
    y: Number(flight.fromY) + (Number(flight.toY) - Number(flight.fromY)) * eased,
    progress: raw,
    done: raw >= 1,
  };
}

/** Sub-cell thumb steps. Unicode lower-eighths give 8 positions per row. */
const SCROLLBAR_STEPS = 8;
/** Lower n/8 of a cell. Index 0 unused; a full cell uses a background fill, not █. */
const LOWER_EIGHTHS = Object.freeze(['', '▁', '▂', '▃', '▄', '▅', '▆', '▇']);

function scrollbarThumbMetrics(trackH, total, view, offset) {
  if (trackH <= 0 || total <= view) return null;
  const steps = SCROLLBAR_STEPS;
  const trackSteps = trackH * steps;
  const thumbSteps = Math.max(steps, Math.round((trackSteps * view) / total));
  const maxOff = Math.max(1, total - view);
  const travelSteps = Math.max(0, trackSteps - thumbSteps);
  const fromTopSteps = Math.round(((maxOff - offset) / maxOff) * travelSteps);
  const fromTop = Math.floor(fromTopSteps / steps);
  const thumbH = Math.max(1, Math.ceil((fromTopSteps + thumbSteps) / steps) - fromTop);
  return { fromTop, thumbH, fromTopSteps, thumbSteps, steps };
}

function scrollbarThumb(trackH, total, view, offset) {
  const metrics = scrollbarThumbMetrics(trackH, total, view, offset);
  if (!metrics) return null;
  return { fromTop: metrics.fromTop, thumbH: metrics.thumbH };
}

function paintScrollbarCell(kind) {
  // Full track/thumb cells stay background-colored spaces. │ and █ leave a
  // gap between rows in Apple Terminal.app (a dotted bar). Edge cells use
  // lower-eighth glyphs with both fg and bg set so that gap still fills.
  if (kind === 'thumb') return `${ansi.bg(PALETTE.thumb)} ${ansi.reset()}`;
  if (kind === 'track') return `${ansi.bg(PALETTE.track)} ${ansi.reset()}`;
  if (kind && typeof kind === 'object') {
    const n = Math.max(1, Math.min(SCROLLBAR_STEPS - 1, Number(kind.eighths) || 1));
    if (kind.fromTop) {
      const lower = SCROLLBAR_STEPS - n;
      return `${ansi.fg(PALETTE.track)}${ansi.bg(PALETTE.thumb)}${LOWER_EIGHTHS[lower]}${ansi.reset()}`;
    }
    return `${ansi.fg(PALETTE.thumb)}${ansi.bg(PALETTE.track)}${LOWER_EIGHTHS[n]}${ansi.reset()}`;
  }
  return ' ';
}

function scrollbarGlyphs(trackH, total, view, offset) {
  if (!(trackH > 0) || !(total > view)) {
    return Array.from({ length: Math.max(0, trackH) }, () => 'empty');
  }
  const metrics = scrollbarThumbMetrics(trackH, total, view, offset);
  if (!metrics) return Array.from({ length: trackH }, () => 'track');
  const cells = new Array(trackH);
  for (let i = 0; i < trackH; i += 1) {
    const a = i * metrics.steps;
    const b = a + metrics.steps;
    const lo = Math.max(a, metrics.fromTopSteps);
    const hi = Math.min(b, metrics.fromTopSteps + metrics.thumbSteps);
    const n = Math.max(0, hi - lo);
    if (n <= 0) cells[i] = 'track';
    else if (n >= metrics.steps) cells[i] = 'thumb';
    else cells[i] = { eighths: n, fromTop: lo === a };
  }
  return cells;
}

function easeInOutCubic(t) {
  const x = Math.min(1, Math.max(0, Number(t) || 0));
  return x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2;
}

/** Cubic ease-in-out over a fixed tick count. Slow at both ends, fastest in the middle. */
function nextScrollStep(left, total) {
  const absLeft = Math.abs(Number(left) || 0);
  if (!absLeft) return 0;
  const absTotal = Math.max(absLeft, Math.abs(Number(total) || 0), 1);
  const done = Math.max(0, absTotal - absLeft);
  const ticks = Math.max(12, absTotal);
  const t0 = done / absTotal;
  const t1 = Math.min(1, t0 + (1 / ticks));
  const step = Math.max(1, Math.round((easeInOutCubic(t1) - easeInOutCubic(t0)) * absTotal));
  return Math.min(step, absLeft);
}

function scrollOffsetFromY(y, region, maxScroll) {
  if (!region || region.h <= 1) return 0;
  const view = region.h;
  const total = maxScroll + view;
  const metrics = scrollbarThumbMetrics(view, total, view, 0);
  if (!metrics) {
    const rel = (y - region.y) / Math.max(1, region.h - 1);
    return Math.round((1 - Math.max(0, Math.min(1, rel))) * maxScroll);
  }
  const travelSteps = Math.max(1, view * SCROLLBAR_STEPS - metrics.thumbSteps);
  const fromTopSteps = Math.max(0, Math.min(travelSteps, (y - region.y) * SCROLLBAR_STEPS));
  return Math.round((1 - fromTopSteps / travelSteps) * maxScroll);
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
  const flash = state.flash && Number(state.flash.until) > Date.now() ? state.flash : null;
  if (state.error) left = `${ansi.fg(PALETTE.error)}${state.error}${ansi.reset()}`;
  else if (flash) {
    left = pulseText(
      flash.text || '',
      state.animFrame,
      flash.hot || PALETTE.title,
      flash.idle || PALETTE.muted
    );
  } else if (state.editingId) left = `${ansi.fg(PALETTE.muted)}editing${ansi.reset()}`;
  else if (state.replyTo) left = `${ansi.fg(PALETTE.muted)}↩  ${state.replyTo.name || 'reply'}${ansi.reset()}`;
  else if (state.typing && state.typing.username) {
    const pulse = Math.floor((state.animFrame || 0) / 8) % 2 === 0;
    left = `${ansi.fg(PALETTE.muted)}${state.typing.username} is typing${pulse ? '…' : '   '}${ansi.reset()}`;
  }

  const leftW = ansi.width(left);
  const hintRoom = Math.max(8, width - PAD - leftW - 2);
  let right = '';
  let rightActions = [];
  if (state.overlay && state.overlay.type === 'delete') {
    const label = pulseText('confirm deletion? (enter)', state.animFrame, PALETTE.error, PALETTE.deletePulse);
    rightActions = [ACTIONS.cancel];
    right = `${label}   ${styleHint(rightActions, Math.max(8, hintRoom - ansi.width(label) - 3))}`;
  } else if (state.channelMenu) {
    rightActions = channelHintActions(state.channelMenu);
    right = styleHint(rightActions, hintRoom);
  } else if (state.selectedMessageId) {
    const item = (state.messages || []).find((m) => String(m.msg?.id) === String(state.selectedMessageId));
    if (item) {
      rightActions = hintActionsFor(item, state.userId, actionMode(state));
      right = styleHint(rightActions, hintRoom);
    }
  }

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
  let caretAt = 0;
  if (!usingPlaceholder) {
    const lineStart = wrapped[caretLine]?.start || 0;
    const at = Math.max(0, Math.min(state.composerCaret || 0, raw.length));
    caretAt = Math.max(0, at - lineStart);
  }
  let lineScroll = state.composerScroll || 0;
  if (state.composerFollowCaret !== false) {
    if (caretLine < lineScroll) lineScroll = caretLine;
    if (caretLine >= lineScroll + innerH) lineScroll = caretLine - innerH + 1;
  }
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
    caretAt,
    lineScroll,
    usingPlaceholder,
    placeholder,
    chrome: innerH + 4,
  };
}

function buildComposerBox(state, width, metrics) {
  const color = state.inputFocus === 'transcript' ? PALETTE.composerOutline : PALETTE.outlineStrong;
  const lines = [boxTop(width, color)];
  const bar = scrollbarGlyphs(metrics.innerH, metrics.total, metrics.innerH, metrics.total - metrics.innerH - metrics.lineScroll);
  const shown = metrics.wrapped.slice(metrics.lineScroll, metrics.lineScroll + metrics.innerH);
  while (shown.length < metrics.innerH) shown.push({ start: 0, text: '' });
  shown.forEach((entry, i) => {
    const absLine = metrics.lineScroll + i;
    const placeholderOnly = metrics.usingPlaceholder && absLine === 0;
    let caretCell = -1;
    if (placeholderOnly) caretCell = 0;
    else if (!metrics.usingPlaceholder && absLine === metrics.caretLine) caretCell = metrics.caretAt;
    const onLine = caretCell >= 0;
    const painted = landing.buildField({
      text: placeholderOnly ? '' : (entry.text || ''),
      placeholder: placeholderOnly ? metrics.placeholder : ' ',
      active: onLine,
      width: metrics.textW,
      caret: onLine ? (placeholderOnly ? 0 : metrics.caretAt) : 0,
      bar: 0,
      blankLine: !placeholderOnly && !(entry.text || ''),
    });
    const thumb = metrics.overflow ? paintScrollbarCell(bar[i]) : ' ';
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
  return runWithTheme(state && state.theme, () => buildChatFrameNow(cols, rows, state));
}

function buildChatFrameNow(cols, rows, state) {
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
      caretLine: 0, caretCol: 0, caretAt: 0, lineScroll: 0, usingPlaceholder: true,
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
  const lines = Array.from({ length: height }, () => fillRow('', width, {}));
  const recipients = groupRecipientCount(state);

  const profileNameY = profileNameRow(height);
  const side = buildSidebar(state, sideW, height, profileNameY);
  const channels = hideBar ? { lines: [], hits: [] } : buildChannelBar(state, contentW, mainX, 0);
  hits.push(...side.hits, ...channels.hits);

  const filtered = filterMessages(state.messages, state.activeChannel);
  const mode = actionMode(state);
  const blocks = filtered.map((item) => ({
    item,
    layout: layoutMessage(item, textW, state.userId, mode),
  }));

  const contentProbe = [];
  if (blocks.length) contentProbe.push('gap');
  let prevDay = null;
  for (const block of blocks) {
    const day = dayKey(block.item?.msg?.createdAt);
    if (day && day !== prevDay) {
      contentProbe.push('gap');
      contentProbe.push('date');
      prevDay = day;
    }
    if (contentProbe.length > 1) contentProbe.push('gap');
    block.layout.rows.forEach(() => contentProbe.push('row'));
  }
  if (blocks.length) contentProbe.push('gap');
  const fillsScreen = contentProbe.length > transcriptH;

  const flat = [];
  const showMore = !!(state.loadingMore || (state.hasMoreHistory && fillsScreen));
  if (showMore) {
    flat.push({ kind: 'more', item: null, row: 'Loading more...', rowInBlock: -1, layout: null });
  }
  if (blocks.length) flat.push({ kind: 'gap', item: null, row: '', rowInBlock: -1, layout: null });
  prevDay = null;
  for (const block of blocks) {
    const day = dayKey(block.item?.msg?.createdAt);
    if (day && day !== prevDay) {
      if (!flat.length || flat[flat.length - 1].kind !== 'gap') {
        flat.push({ kind: 'gap', item: null, row: '', rowInBlock: -1, layout: null });
      }
      flat.push({
        kind: 'date',
        item: block.item,
        row: formatDayLabel(block.item.msg.createdAt),
        rowInBlock: -1,
        layout: null,
      });
      prevDay = day;
    }
    if (flat.length > 1 && flat[flat.length - 1].kind !== 'gap') {
      flat.push({ kind: 'gap', item: null, row: '', rowInBlock: -1, layout: null });
    }
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
  const perch = bird ? idleBirdOrigin(width, height, state) : null;
  const flight = bird ? birdFlightPlacement(state, width, height) : null;
  const birdOrigin = !bird ? null : (flight && !flight.done
    ? { x: flight.x - mainX, y: flight.y, tier: perch.tier }
    : { x: perch.x - mainX, y: perch.y, tier: perch.tier });
  const birdLines = bird
    ? buildBirdLines(
      contentW,
      Math.max(birdH, height),
      (birdAnimated(state) || (flight && !flight.done)) ? (state.animFrame || 0) : 0,
      !!(birdAnimated(state) || (flight && !flight.done)),
      birdOrigin
    )
    : null;
  const overflow = !bird && totalLines > transcriptH;
  const bar = scrollbarGlyphs(transcriptH, overflow ? totalLines : 0, transcriptH, offset);
  const thumb = overflow ? scrollbarThumb(transcriptH, totalLines, transcriptH, offset) : null;
  const protectedRows = new Set();
  const confirmHits = [];

  const join = (left, mid, barKind) => {
    const divider = sideW > 0 ? `${ansi.fg(PALETTE.border)}│${ansi.reset()}` : '';
    const barCell = paintScrollbarCell(barKind);
    return (left || '') + divider + padCells(mid, contentW) + barCell;
  };

  for (let i = 0; i < transcriptH; i += 1) {
    const screenY = transcriptY + i;
    const left = sideW > 0 ? (side.lines[screenY] || fillRow('', sideW, {})) : '';
    if (bird) {
      lines[screenY] = join(left, birdLines[screenY] || fillRow('', contentW, {}), ' ');
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

    if (entry && entry.kind === 'date') {
      const label = String(entry.row || '');
      const rule = Math.max(2, Math.floor((contentW - ansi.width(label) - 2) / 2));
      const plain = `${'─'.repeat(rule)} ${label} ${'─'.repeat(rule)}`;
      const mid = fillRow(plain, contentW, { fg: PALETTE.muted, dim: true });
      lines[screenY] = join(left, mid, bar[i]);
      continue;
    }

    if (!entry || entry.kind === 'gap') {
      const nextId = idOf(next);
      const prevId = idOf(prev);
      const nextDeleting = !!(state.overlay && state.overlay.type === 'delete' && nextId && nextId === String(state.overlay.messageId));
      const prevDeleting = !!(state.overlay && state.overlay.type === 'delete' && prevId && prevId === String(state.overlay.messageId));
      const nextColor = nextDeleting ? PALETTE.error : outlineColor(nextId && nextId === hoverId);
      const prevColor = prevDeleting ? PALETTE.error : outlineColor(prevId && prevId === hoverId);
      let mid;
      if (nextColor) {
        mid = `${' '.repeat(PAD)}${boxTop(boxW, nextColor)}`;
        if (nextId && (nextId === selectedId || nextDeleting)) {
          protectedRows.add(screenY);
        }
      } else if (prevColor) {
        mid = `${' '.repeat(PAD)}${boxBottom(boxW, prevColor)}`;
        if (prevId && (prevId === selectedId || prevDeleting)) {
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
    const pendingDelete = !!entry.item.deleting;
    const color = deleting ? PALETTE.error : outlineColor(hover && !deleting && !pendingDelete);
    const showIcons = (hover || selected) && !deleting && !pendingDelete && !entry.item.sending;
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
      replyHot: !!(state.hoverReply && hover && entry.rowInBlock === entry.layout.replyRow),
    });
    let inner;
    if (color) inner = boxRow(painted, boxW, color);
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
    if (entry.rowInBlock !== entry.layout.metaRow && entry.rowInBlock !== entry.layout.replyRow) {
      hits.push({
        type: 'message-text',
        id: entry.item.msg.id,
        x: mainX + PAD + 1,
        y: screenY,
        w: Math.max(1, textW - CONTENT_GUTTER),
        h: 1,
      });
    }

    if (entry.rowInBlock === entry.layout.replyRow && entry.item.replyTo?.id) {
      const replyW = Math.max(1, Math.min(textW, ansi.width(replyPreviewText(entry.item) || '↩')));
      hits.push({
        type: 'reply-ref',
        id: entry.item.replyTo.id,
        parentId: entry.item.msg.id,
        x: mainX + PAD + 1,
        y: screenY,
        w: replyW,
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

  if (overflow) {
    hits.push({
      type: 'scrollbar',
      x: barX,
      y: transcriptY,
      w: SCROLLBAR_W,
      h: transcriptH,
    });
  }

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

    if (hint.rightActions.length) {
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
        x: mainX + PAD + boxW - 2,
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
    scrollbarThumb: thumb
      ? { x: barX, y: transcriptY + thumb.fromTop, w: SCROLLBAR_W, h: thumb.thumbH }
      : null,
    composerMetrics: metrics,
    shouldLoadMore: !!(
      state.hasMoreHistory
      && !state.loadingMore
      && (!fillsScreen || visible.some((entry) => entry && entry.kind === 'more'))
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

function composeChatFrame(cols, rows, state, built) {
  const frame = built || buildChatFrame(cols, rows, state);
  const width = Math.max(1, cols);
  const height = Math.max(1, rows);
  return runWithTheme(state && state.theme, () => {
    const canvas = PALETTE.canvas;
    const wrapped = new Array(height);
    for (let i = 0; i < height; i += 1) {
      wrapped[i] = paintCanvasLine(frame.lines[i] || '', width, 0, canvas);
    }
    return composeFull(wrapped, width, height);
  });
}

module.exports = {
  PALETTE: DARK,
  ACTIONS,
  TEXT,
  PAD,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  CHANNEL_ROWS,
  CHANNEL_EXPAND_FRAMES,
  PROFILE_FRAMES,
  PROFILE_BUTTON_ROWS,
  PROFILE_BUTTON_COUNT,
  PROFILE_BUTTON_GAP,
  HISTORY_PAGE,
  SCROLL_TWEEN_MS,
  ACTION_SLOTS,
  ACTION_GUTTER,
  TICK_GUTTER,
  CONTENT_GUTTER,
  COMPOSER_MIN_INNER,
  COMPOSER_MAX_INNER,
  SCROLLBAR_W,
  SCROLLBAR_STEPS,
  WHEEL_LINES,
  TRANSITION_MS,
  BIRD_FLIGHT_MS,
  GLIMMER,
  PROFILE_NAME_OFFSET,
  PROFILE_LIFT,
  DEFAULT_CHAT,
  profileNameRow,
  profileEase,
  profileLift,
  profileLineFade,
  sensitivityFromX,
  sidebarWidth,
  sidebarTitle,
  formatTime,
  formatStamp,
  formatDayLabel,
  dayKey,
  formatBytes,
  wrapText,
  wrapIndexed,
  actionListFor,
  hintActionsFor,
  styleHint,
  layoutMessage,
  hitTest,
  filterMessages,
  scrollbarThumb,
  scrollbarThumbMetrics,
  scrollbarGlyphs,
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
  PROFILE_ITEMS,
  easeInOutCubic,
  nextScrollStep,
  replyPreviewText,
  buildComposerHint,
  composerMetrics,
  buildBirdLines,
  idleBirdOrigin,
  birdFlightPlacement,
  nameColor,
  hashNameColor,
  buildChatFrame,
  composeChatFrame,
  paintScrollbarCell,
};
