'use strict';

/**
 * Pure Mini GChat frame builder.
 *
 * Hierarchy: padded sidebar | content (channels, transcript, hint, composer) | scrollbar.
 * Hover uses a gray fill and reuses the one-line gap as a thin outline.
 * No I/O — the screen/input loop lives in chat.js / app.js.
 */

const ansi = require('./ansi');
const landing = require('./landing');
const { clampScroll } = require('./landing');

const PALETTE = {
  title: '#ffffff',
  text: '#e6edf3',
  muted: '#6e7681',
  hoverBg: '#2d333b',
  hoverFg: '#e6edf3',
  outline: '#8b93a0',
  action: '#e6edf3',
  actionHot: '#ffffff',
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
  track: '#30363d',
  thumb: '#8b93a0',
};

const TEXT = '\uFE0E';

const ACTIONS = {
  reply: { id: 'reply', glyph: 'r', label: 'reply', color: PALETTE.keyR },
  edit: { id: 'edit', glyph: 'e', label: 'edit', color: PALETTE.keyE },
  delete: { id: 'delete', glyph: 'd', label: 'delete', color: PALETTE.keyD },
};

const SIDEBAR_MIN = 20;
const SIDEBAR_MAX = 26;
const PAD = 2;
const CHANNEL_ROWS = 2;
const COMPOSER_ROWS = 3;
const SCROLLBAR_W = 1;
const CARD_MAX_WIDTH = 38;
const CARD_MIN_WIDTH = 18;
const FIELD_CARET = '█';
const ELLIPSIS = '…';
const TRANSITION_MS = 480;

const DEFAULT_CHAT = {
  groups: [],
  activeGroupId: null,
  channels: ['main'],
  activeChannel: 'main',
  messages: [],
  scrollOffset: 0,
  hoverMessageId: null,
  hoverAction: null,
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
  overlay: null,
  loading: false,
  animFrame: 0,
  transition: null,
  typing: null,
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

function padCells(str, width) {
  const w = ansi.width(str);
  if (w >= width) return ansi.truncate(str, width);
  return str + ' '.repeat(width - w);
}

function fillRow(plain, width, { bg = null, fg = null, bold = false, dim = false } = {}) {
  const clipped = ansi.width(plain) > width ? ansi.stripAnsi(ansi.truncate(plain, width)) : plain;
  const pad = ' '.repeat(Math.max(0, width - ansi.width(clipped)));
  const style = `${bg ? ansi.bg(bg) : ''}${fg ? ansi.fg(fg) : ''}${bold ? ansi.bold() : ''}${dim ? ansi.dim() : ''}`;
  return `${style}${clipped}${pad}${ansi.reset()}`;
}

function isOwnMessage(item, userId) {
  return !!(userId && item?.msg?.senderId && String(item.msg.senderId) === String(userId));
}

function isAttachment(item) {
  const type = item?.msg?.type;
  return type === 'image' || type === 'file';
}

function actionListFor(item, userId) {
  const list = [ACTIONS.reply];
  if (isOwnMessage(item, userId)) {
    if (!isAttachment(item) && item.msg?.type !== 'whisper') list.push(ACTIONS.edit);
    list.push(ACTIONS.delete);
  }
  return list;
}

function actionChip(action) {
  return `(${action.glyph})`;
}

function actionStrip(actions) {
  return actions.map((a) => actionChip(a)).join(' ');
}

function styleActionChip(action, hot) {
  const open = `${ansi.fg(PALETTE.muted)}(${ansi.reset()}`;
  const close = `${ansi.fg(PALETTE.muted)})${ansi.reset()}`;
  const letter = `${hot ? ansi.bold() : ''}${ansi.fg(action.color)}${action.glyph}${ansi.reset()}`;
  return open + letter + close;
}

function overlayActions(metaPlain, actions, width) {
  const strip = actionStrip(actions);
  const stripW = ansi.width(strip);
  const bodyW = Math.max(0, width - stripW - 1);
  const body = ansi.width(metaPlain) > bodyW
    ? ansi.stripAnsi(ansi.truncate(metaPlain, Math.max(1, bodyW)))
    : metaPlain;
  const mid = ' '.repeat(Math.max(0, width - ansi.width(body) - stripW));
  return body + mid + strip;
}

function actionHits(actions, originX, originY, width) {
  const strip = actionStrip(actions);
  const stripW = ansi.width(strip);
  let x = originX + width - stripW;
  const hits = [];
  for (const action of actions) {
    const chip = actionChip(action);
    const w = ansi.width(chip);
    hits.push({
      type: 'action',
      action: action.id,
      x,
      y: originY,
      w,
      h: 1,
    });
    x += w + 1;
  }
  return hits;
}

function styleHint(actions, hoverAction) {
  return actions.map((action) => {
    const hot = hoverAction === action.id;
    const open = `${ansi.fg(PALETTE.muted)}(${ansi.reset()}`;
    const close = `${ansi.fg(PALETTE.muted)})${ansi.fg(PALETTE.muted)}${action.label.slice(1)}${ansi.reset()}`;
    const letter = `${hot ? ansi.bold() : ''}${ansi.fg(action.color)}${action.glyph}${ansi.reset()}`;
    return open + letter + close;
  }).join('  ');
}

function hintHits(actions, originX, originY) {
  let x = originX;
  const hits = [];
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    const label = `(${action.glyph})${action.label.slice(1)}`;
    const w = ansi.width(label);
    hits.push({
      type: 'action',
      action: action.id,
      id: null,
      x,
      y: originY,
      w,
      h: 1,
    });
    x += w + 2;
  }
  return hits;
}

function cardWidth(transcriptWidth) {
  return Math.max(CARD_MIN_WIDTH, Math.min(CARD_MAX_WIDTH, transcriptWidth));
}

function buildCardLines(item, width) {
  const inner = cardWidth(width);
  const filename = item.attach?.filename || (item.msg?.type === 'image' ? 'image' : 'file');
  const size = item.attach?.size != null ? formatBytes(item.attach.size) : '';
  const kind = item.msg?.type === 'image' ? 'image' : 'file';
  const innerW = inner - 2;
  const top = `┌${'─'.repeat(innerW)}┐`;
  const nameRoom = innerW - 2 - (size ? ansi.width(size) + 1 : 0);
  const name = padCells(filename, Math.max(1, nameRoom));
  const mid1 = `│ ${name}${size ? ` ${size}` : ''} │`;
  const mid2 = `│ ${padCells(kind, innerW - 2)} │`;
  const bot = `└${'─'.repeat(innerW)}┘`;
  return [top, mid1, mid2, bot];
}

function bodyText(item) {
  if (item.text != null && item.text !== '') return item.text;
  if (item.error) return `[unable to decrypt]`;
  return '';
}

function metaLine(item) {
  const time = formatTime(item.msg?.createdAt);
  const name = item.msg?.senderName || item.msg?.senderId || '?';
  const edited = item.msg?.editedAt ? '  edited' : '';
  return `${time}  ${name}${edited}`;
}

function replyLine(item) {
  const reply = item.replyTo;
  if (!reply) return null;
  const name = reply.name || 'message';
  const preview = String(reply.preview || '').replace(/\s+/g, ' ').slice(0, 48);
  return `↩  ${name}${preview ? `: ${preview}` : ''}`;
}

function layoutMessage(item, width, userId) {
  const actions = actionListFor(item, userId);
  const rows = [];
  const reply = replyLine(item);
  let replyRow = -1;
  if (reply) {
    replyRow = rows.length;
    rows.push(reply);
  }
  const metaRow = rows.length;
  rows.push(metaLine(item));
  let card = null;
  if (isAttachment(item)) {
    const cardLines = buildCardLines(item, width);
    card = { start: rows.length, height: cardLines.length, width: cardWidth(width) };
    rows.push(...cardLines);
  } else {
    rows.push(...wrapText(bodyText(item), width));
  }
  return { rows, actions, card, height: rows.length, replyRow, metaRow };
}

function sendingLabel(frame) {
  const on = Math.floor((frame || 0) / 8) % 2 === 0;
  return on ? 'sending...' : 'sending   ';
}

function paintMessageRow(plain, width, {
  hover, isMeta, isReply, hoverAction, actions, sending, animFrame,
}) {
  let content = plain;
  if (hover && isMeta) content = overlayActions(plain, actions, width);
  if (sending && !isMeta && !isReply) {
    const label = sendingLabel(animFrame);
    const labelW = ansi.width(label);
    const bodyW = Math.max(0, width - labelW - 1);
    const body = ansi.width(content) > bodyW
      ? ansi.stripAnsi(ansi.truncate(content, Math.max(1, bodyW)))
      : content;
    content = body + ' '.repeat(Math.max(0, width - ansi.width(body) - labelW)) + label;
  }
  const fg = isReply || sending ? PALETTE.muted : (isMeta ? PALETTE.muted : PALETTE.text);
  if (!hover) {
    return fillRow(content, width, { fg, dim: !!sending });
  }
  let painted = fillRow(content, width, { bg: PALETTE.hoverBg, fg: hover ? PALETTE.hoverFg : fg, dim: !!sending });
  if (isMeta && hover) {
    for (const action of actions) {
      const chip = actionChip(action);
      const styled = styleActionChip(action, hoverAction === action.id);
      painted = painted.replace(chip, `${ansi.bg(PALETTE.hoverBg)}${styled}${ansi.bg(PALETTE.hoverBg)}`);
    }
  }
  return painted;
}

function paintGap(width, role) {
  if (role === 'top' || role === 'bottom') {
    return fillRow('─'.repeat(Math.max(0, width)), width, { fg: PALETTE.outline });
  }
  return fillRow('', width, {});
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

function buildSidebar(state, width, height) {
  const lines = [];
  const hits = [];
  if (width <= 0 || height <= 0) return { lines, hits };
  const inner = Math.max(1, width - PAD);
  const title = sidebarTitle();
  lines.push(fillRow(`${' '.repeat(PAD)}${title}`, width, { fg: PALETTE.muted }));
  const list = state.groups || [];
  for (let i = 0; i < height - 1; i += 1) {
    const group = list[i];
    if (!group) {
      lines.push(fillRow('', width, {}));
      continue;
    }
    const active = String(group.id) === String(state.activeGroupId);
    const name = `${' '.repeat(PAD)}${String(group.name || '?')}`;
    lines.push(fillRow(padCells(name, inner), width, {
      bg: active ? PALETTE.activeBg : null,
      fg: active ? PALETTE.title : PALETTE.text,
      bold: active,
    }));
    hits.push({
      type: 'group',
      id: group.id,
      x: 0,
      y: 1 + i,
      w: width,
      h: 1,
    });
  }
  hits.unshift({
    type: 'sidebar-empty',
    x: 0,
    y: 0,
    w: width,
    h: height,
  });
  return { lines, hits };
}

function buildChannelRow(state, width, originX, originY) {
  const hits = [];
  let x = PAD;
  let out = ' '.repeat(PAD);
  const channels = state.channels && state.channels.length ? state.channels : ['main'];
  for (const name of channels) {
    const label = `#${name}`;
    const active = name === (state.activeChannel || 'main');
    const styled = active
      ? `${ansi.bold()}${ansi.fg(PALETTE.title)}${label}${ansi.reset()}`
      : `${ansi.fg(PALETTE.muted)}${label}${ansi.reset()}`;
    const w = ansi.width(label);
    if (x + w > width - PAD) break;
    hits.push({
      type: 'channel',
      name,
      x: originX + x,
      y: originY,
      w,
      h: 1,
    });
    out += styled;
    out += '  ';
    x += w + 2;
  }
  return { line: padCells(out, width), hits };
}

function buildBirdLines(width, height, frame) {
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
    const styled = landing.styleArtLine(artLine, row, frame, tier.shimmer);
    lines[y] = `${' '.repeat(left)}${styled}${' '.repeat(Math.max(0, width - left - ansi.width(artLine)))}`;
  });
  return lines;
}

function scrollbarGlyphs(trackH, total, view, offset) {
  const cells = Array.from({ length: Math.max(0, trackH) }, () => '│');
  if (trackH <= 0) return cells;
  if (total <= view) {
    return cells.map(() => '│');
  }
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

function buildComposerHint(state, width) {
  if (state.error) return fillRow(String(state.error), width, { fg: PALETTE.error });
  if (state.editingId) return fillRow('editing', width, { fg: PALETTE.muted });
  if (state.replyTo) {
    return fillRow(`↩  ${state.replyTo.name || 'reply'}`, width, { fg: PALETTE.muted });
  }
  if (state.hoverMessageId) {
    const item = (state.messages || []).find((m) => String(m.msg?.id) === String(state.hoverMessageId));
    if (item) {
      const actions = actionListFor(item, state.userId);
      return padCells(`${' '.repeat(PAD)}${styleHint(actions, state.hoverAction)}`, width);
    }
  }
  if (state.typing && state.typing.username) {
    const pulse = Math.floor((state.animFrame || 0) / 8) % 2 === 0;
    const dots = pulse ? '…' : '   ';
    return fillRow(`${' '.repeat(PAD)}${state.typing.username} is typing${dots}`, width, { fg: PALETTE.muted });
  }
  return fillRow('', width, {});
}

function buildComposerField(state, width) {
  const text = state.composer || '';
  const caret = state.composerCaret || 0;
  const fieldWidth = Math.max(1, width - PAD);
  const scroll = clampScroll(state.composerScroll || 0, caret, text.length, fieldWidth);
  const placeholder = state.editingId ? 'edit message' : 'message';
  const shown = text.length > 0 ? text : placeholder;
  const usingPlaceholder = text.length === 0;
  const color = usingPlaceholder ? PALETTE.placeholder : PALETTE.text;

  let content = shown;
  let caretCell = -1;
  const at = Math.max(0, Math.min(caret, text.length));
  if (!usingPlaceholder) {
    const atEnd = at >= text.length;
    const displayLen = atEnd ? text.length + 1 : text.length;
    if (displayLen <= fieldWidth) {
      if (atEnd) content = shown + FIELD_CARET;
      else caretCell = at;
    } else {
      const leftEll = scroll > 0;
      const rightEll = scroll + fieldWidth < displayLen;
      const start = scroll + (leftEll ? 1 : 0);
      const end = scroll + fieldWidth - (rightEll ? 1 : 0);
      const display = atEnd ? shown + FIELD_CARET : shown;
      content = (leftEll ? ELLIPSIS : '') + display.slice(start, end) + (rightEll ? ELLIPSIS : '');
      if (!atEnd) caretCell = at - scroll;
    }
  } else {
    caretCell = 0;
  }

  const pad = ' '.repeat(Math.max(0, fieldWidth - ansi.width(content)));
  const box = content + pad;
  let field = ' '.repeat(PAD);
  for (let i = 0; i < box.length; i += 1) {
    const ch = box[i];
    if (i === caretCell) {
      field += `${ansi.underline()}${ansi.bg(color)}${ansi.fg('#161b22')}${ch}${ansi.reset()}`;
    } else {
      field += `${ansi.underline()}${ansi.fg(color)}${ch}${ansi.reset()}`;
    }
  }
  return padCells(field, width);
}

function paintOverlay(lines, cols, rows, overlay) {
  if (!overlay) return { hits: [] };
  const box = overlayLines(overlay);
  const width = Math.max(...box.lines.map((l) => ansi.width(l)));
  const height = box.lines.length;
  const x = Math.max(0, Math.floor((cols - width) / 2));
  const y = Math.max(0, Math.floor((rows - height) / 2));
  const hits = [];
  for (let i = 0; i < box.lines.length; i += 1) {
    const row = y + i;
    if (row < 0 || row >= rows) continue;
    const fragment = padCells(box.lines[i], width);
    lines[row] = `${' '.repeat(x)}${fragment}${' '.repeat(Math.max(0, cols - x - width))}`;
  }
  hits.push({ type: 'overlay', x, y, w: width, h: height });
  for (const hit of box.hits) {
    hits.push({
      ...hit,
      x: x + hit.x,
      y: y + hit.y,
    });
  }
  return { hits, x, y, width, height };
}

function overlayLines(overlay) {
  const type = overlay.type;
  const innerW = 36;
  const wrap = (title, body, buttons) => {
    const lines = [];
    const hits = [];
    lines.push(fillRow(`┌${'─'.repeat(innerW)}┐`, innerW + 2, { fg: PALETTE.border }));
    lines.push(fillRow(`│ ${padCells(title, innerW - 2)} │`, innerW + 2, { fg: PALETTE.title, bold: true }));
    lines.push(fillRow(`│${' '.repeat(innerW)}│`, innerW + 2, { fg: PALETTE.border }));
    for (const row of body) {
      lines.push(fillRow(`│ ${padCells(row, innerW - 2)} │`, innerW + 2, { fg: PALETTE.text }));
    }
    lines.push(fillRow(`│${' '.repeat(innerW)}│`, innerW + 2, { fg: PALETTE.border }));
    const btn = buttons.map((b) => `[${b.label}]`).join('   ');
    const btnRowIndex = lines.length;
    lines.push(fillRow(`│ ${padCells(btn, innerW - 2)} │`, innerW + 2, { fg: PALETTE.text }));
    lines.push(fillRow(`└${'─'.repeat(innerW)}┘`, innerW + 2, { fg: PALETTE.border }));
    let bx = 3;
    for (const button of buttons) {
      const label = `[${button.label}]`;
      hits.push({
        type: 'overlay-button',
        action: button.id,
        x: bx,
        y: btnRowIndex,
        w: ansi.width(label),
        h: 1,
      });
      bx += ansi.width(label) + 3;
    }
    return { lines, hits };
  };

  if (type === 'delete') {
    return wrap('Delete this message?', ['This cannot be undone.'], [
      { id: 'confirm', label: 'delete' },
      { id: 'cancel', label: 'cancel' },
    ]);
  }
  if (type === 'reveal') {
    const name = overlay.filename || 'file';
    const meta = [overlay.kind, overlay.size].filter(Boolean).join(' · ');
    const note = overlay.opened ? 'opened' : (overlay.error || 'ready');
    return wrap(name, [meta, note], [
      { id: 'open', label: 'open' },
      { id: 'save', label: 'save' },
      { id: 'cancel', label: 'close' },
    ]);
  }
  if (type === 'save') {
    const value = overlay.value || overlay.filename || 'file';
    return wrap('Save as', [value], [
      { id: 'confirm', label: 'save' },
      { id: 'cancel', label: 'cancel' },
    ]);
  }
  if (type === 'error') {
    return wrap('Error', [overlay.message || 'Something went wrong'], [
      { id: 'cancel', label: 'close' },
    ]);
  }
  return wrap(overlay.title || 'GChat', [overlay.message || ''], [
    { id: 'cancel', label: 'close' },
  ]);
}

function showBird(state) {
  return !state.activeGroupId || !!state.transition;
}

function buildChatFrame(cols, rows, state = DEFAULT_CHAT) {
  const width = Math.max(1, cols);
  const height = Math.max(1, rows);
  const sideW = sidebarWidth(width);
  const mainX = sideW > 0 ? sideW + 1 : 0;
  const mainW = Math.max(1, width - mainX);
  const barX = width - SCROLLBAR_W;
  const contentW = Math.max(1, mainW - SCROLLBAR_W);
  const textW = Math.max(1, contentW - PAD);
  const transcriptY = CHANNEL_ROWS;
  const transcriptH = Math.max(1, height - CHANNEL_ROWS - COMPOSER_ROWS);
  const composerY = height - COMPOSER_ROWS;

  const regions = {
    sidebar: { x: 0, y: 0, w: sideW, h: height },
    channels: { x: mainX, y: 0, w: contentW, h: 1 },
    transcript: { x: mainX, y: transcriptY, w: contentW, h: transcriptH },
    scrollbar: { x: barX, y: transcriptY, w: SCROLLBAR_W, h: transcriptH },
    composer: { x: mainX, y: composerY + 1, w: contentW, h: COMPOSER_ROWS - 1 },
    hint: { x: mainX, y: composerY + 1, w: contentW, h: 1 },
  };

  const hits = [];
  const lines = Array.from({ length: height }, () => ' '.repeat(width));

  const side = buildSidebar(state, sideW, height);
  const channels = buildChannelRow(state, contentW, mainX, 0);
  hits.push(...side.hits, ...channels.hits);

  const filtered = filterMessages(state.messages, state.activeChannel);
  const blocks = filtered.map((item) => ({
    item,
    layout: layoutMessage(item, textW, state.userId),
  }));

  const flat = [];
  for (const block of blocks) {
    if (flat.length) flat.push({ kind: 'gap', item: null, row: '', rowInBlock: -1, layout: null });
    block.layout.rows.forEach((row, rowInBlock) => {
      flat.push({ kind: 'row', item: block.item, row, rowInBlock, layout: block.layout });
    });
  }

  const totalLines = flat.length;
  const maxScroll = Math.max(0, totalLines - transcriptH);
  const offset = Math.max(0, Math.min(state.scrollOffset || 0, maxScroll));
  const start = Math.max(0, totalLines - transcriptH - offset);
  const visible = flat.slice(start, start + transcriptH);
  const hoverId = state.hoverMessageId != null ? String(state.hoverMessageId) : null;
  const bird = showBird(state);
  const birdLines = bird ? buildBirdLines(contentW, transcriptH, state.animFrame || 0) : null;
  const bar = scrollbarGlyphs(transcriptH, bird ? 0 : totalLines, transcriptH, offset);

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
      lines[screenY] = join(left, birdLines[i] || fillRow('', contentW, {}), ' ');
      continue;
    }
    const abs = start + i;
    const entry = visible[i];
    const prev = abs > 0 ? flat[abs - 1] : null;
    const next = abs + 1 < flat.length ? flat[abs + 1] : null;
    const midPad = (styled) => `${' '.repeat(PAD)}${styled}`;

    if (!entry || entry.kind === 'gap') {
      let role = null;
      if (next && next.kind === 'row' && hoverId && String(next.item.msg?.id) === hoverId) role = 'top';
      else if (prev && prev.kind === 'row' && hoverId && String(prev.item.msg?.id) === hoverId) role = 'bottom';
      lines[screenY] = join(left, paintGap(contentW, role), bar[i]);
      continue;
    }

    const id = String(entry.item.msg?.id || '');
    const hover = hoverId !== null && id === hoverId;
    const painted = paintMessageRow(entry.row, textW, {
      hover,
      isMeta: entry.rowInBlock === entry.layout.metaRow,
      isReply: entry.rowInBlock === entry.layout.replyRow,
      hoverAction: hover ? state.hoverAction : null,
      actions: entry.layout.actions,
      sending: !!entry.item.sending,
      animFrame: state.animFrame || 0,
    });
    lines[screenY] = join(left, midPad(painted), bar[i]);

    hits.push({
      type: 'message',
      id: entry.item.msg.id,
      x: mainX,
      y: screenY,
      w: contentW,
      h: 1,
    });

    if (entry.rowInBlock === entry.layout.metaRow && hover) {
      for (const hit of actionHits(entry.layout.actions, mainX + PAD, screenY, textW)) {
        hits.push({ ...hit, id: entry.item.msg.id });
      }
    }

    const card = entry.layout.card;
    if (card && entry.rowInBlock >= card.start && entry.rowInBlock < card.start + card.height) {
      hits.push({
        type: 'card',
        id: entry.item.msg.id,
        x: mainX + PAD,
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

  const rule = fillRow('─'.repeat(contentW), contentW, { fg: PALETTE.rule });
  const sideAt = (y) => (sideW > 0 ? (side.lines[y] || fillRow('', sideW, {})) : '');
  const withBar = (y, mid, barGlyph = ' ') => join(sideAt(y), mid, barGlyph);

  lines[0] = withBar(0, channels.line);
  if (CHANNEL_ROWS > 1) lines[1] = withBar(1, rule);

  const hint = buildComposerHint(state, contentW);
  const field = buildComposerField(state, contentW);
  lines[composerY] = withBar(composerY, rule);
  lines[composerY + 1] = withBar(composerY + 1, hint);
  lines[composerY + 2] = withBar(composerY + 2, field);

  if (state.hoverMessageId) {
    const item = (state.messages || []).find((m) => String(m.msg?.id) === String(state.hoverMessageId));
    if (item) {
      const actions = actionListFor(item, state.userId);
      for (const hit of hintHits(actions, mainX + PAD, composerY + 1)) {
        hits.push({ ...hit, id: item.msg.id });
      }
    }
  }

  hits.push({
    type: 'composer',
    x: mainX,
    y: composerY + 2,
    w: contentW,
    h: 1,
  });

  const overlayHits = paintOverlay(lines, width, height, state.overlay);
  hits.push(...overlayHits.hits);

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
  };
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
  COMPOSER_ROWS,
  SCROLLBAR_W,
  TRANSITION_MS,
  DEFAULT_CHAT,
  sidebarWidth,
  sidebarTitle,
  formatTime,
  formatBytes,
  wrapText,
  actionListFor,
  actionStrip,
  styleHint,
  layoutMessage,
  hitTest,
  filterMessages,
  scrollOffsetFromY,
  buildBirdLines,
  buildChatFrame,
  composeChatFrame,
};
