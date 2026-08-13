'use strict';

/**
 * Pure Mini GChat frame builder.
 *
 * Given terminal size + chat state, returns the styled lines, layout
 * regions, and hit boxes (messages, cards, hover actions, sidebar).
 * No I/O — the screen/input loop lives in chat.js / app.js.
 */

const ansi = require('./ansi');
const { clampScroll } = require('./landing');

const PALETTE = {
  title: '#ffffff',
  text: '#e6edf3',
  muted: '#6e7681',
  hoverBg: '#30363d',
  hoverFg: '#e6edf3',
  action: '#e6edf3',
  actionHot: '#ffffff',
  activeBg: '#21262d',
  border: '#30363d',
  card: '#8b93a0',
  error: '#f85149',
  placeholder: '#8a8a8a',
};

/** Text-presentation pencil (VS15) so macOS does not promote it to an emoji. */
const TEXT = '\uFE0E';

const ACTIONS = {
  reply: { id: 'reply', glyph: '↩', label: 'reply' },
  edit: { id: 'edit', glyph: `✎${TEXT}`, label: 'edit' },
  delete: { id: 'delete', glyph: '×', label: 'delete' },
};

const SIDEBAR_MIN = 14;
const SIDEBAR_MAX = 22;
const CHANNEL_ROW = 1;
const COMPOSER_ROWS = 2;
const CARD_MAX_WIDTH = 38;
const CARD_MIN_WIDTH = 18;
const ACTION_GAP = 2;
const FIELD_CARET = '█';
const ELLIPSIS = '…';

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
};

function sidebarWidth(cols) {
  if (cols < 56) return 0;
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

function fillRow(plain, width, { bg = null, fg = null, bold = false } = {}) {
  const clipped = ansi.width(plain) > width ? ansi.stripAnsi(ansi.truncate(plain, width)) : plain;
  const pad = ' '.repeat(Math.max(0, width - ansi.width(clipped)));
  const style = `${bg ? ansi.bg(bg) : ''}${fg ? ansi.fg(fg) : ''}${bold ? ansi.bold() : ''}`;
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

function actionStrip(actions) {
  return actions.map((a) => a.glyph).join(' '.repeat(ACTION_GAP));
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
    const gw = Math.max(1, ansi.width(action.glyph));
    hits.push({
      type: 'action',
      action: action.id,
      x,
      y: originY,
      w: gw + 1,
      h: 1,
    });
    x += gw + ACTION_GAP;
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

/**
 * Lay out one message as a block of plain rows (styling applied later).
 */
function layoutMessage(item, width, userId) {
  const actions = actionListFor(item, userId);
  const rows = [metaLine(item)];
  let card = null;
  if (isAttachment(item)) {
    const cardLines = buildCardLines(item, width);
    card = { start: rows.length, height: cardLines.length, width: cardWidth(width) };
    rows.push(...cardLines);
  } else {
    rows.push(...wrapText(bodyText(item), width));
  }
  return { rows, actions, card, height: rows.length };
}

function paintMessageRow(plain, width, { hover, isMeta, hoverAction, actions }) {
  if (!hover) {
    return fillRow(plain, width, { fg: isMeta ? PALETTE.muted : PALETTE.text });
  }
  let content = plain;
  if (isMeta) content = overlayActions(plain, actions, width);
  const painted = fillRow(content, width, { bg: PALETTE.hoverBg, fg: PALETTE.hoverFg });
  if (isMeta && hoverAction) {
    const hot = actions.find((a) => a.id === hoverAction);
    if (hot) {
      const needle = hot.glyph;
      const idx = painted.indexOf(needle);
      if (idx !== -1) {
        return painted.replace(
          needle,
          `${ansi.bold()}${ansi.fg(PALETTE.actionHot)}${needle}${ansi.bg(PALETTE.hoverBg)}${ansi.fg(PALETTE.hoverFg)}`
        );
      }
    }
  }
  return painted;
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

function buildSidebar(state, width, height) {
  const lines = [];
  const hits = [];
  if (width <= 0 || height <= 0) return { lines, hits };
  const title = fillRow('chats', width, { fg: PALETTE.muted });
  lines.push(title);
  const list = state.groups || [];
  for (let i = 0; i < height - 1; i += 1) {
    const group = list[i];
    if (!group) {
      lines.push(fillRow('', width, {}));
      continue;
    }
    const active = String(group.id) === String(state.activeGroupId);
    const mark = active ? '● ' : '  ';
    const name = padCells(mark + String(group.name || '?'), width);
    lines.push(fillRow(name, width, {
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
  return { lines, hits };
}

function buildChannelRow(state, width, originX, originY) {
  const hits = [];
  let x = 0;
  let out = '';
  const channels = state.channels && state.channels.length ? state.channels : ['main'];
  for (const name of channels) {
    const label = `#${name}`;
    const active = name === (state.activeChannel || 'main');
    const styled = active
      ? `${ansi.bold()}${ansi.fg(PALETTE.title)}${label}${ansi.reset()}`
      : `${ansi.fg(PALETTE.muted)}${label}${ansi.reset()}`;
    const w = ansi.width(label);
    if (x + w > width) break;
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

function hoverLegend(state) {
  if (!state.hoverMessageId) return '';
  const item = (state.messages || []).find((m) => String(m.msg?.id) === String(state.hoverMessageId));
  if (!item) return '';
  return actionListFor(item, state.userId).map((a) => `${a.glyph}  ${a.label}`).join('   ');
}

function buildComposer(state, width) {
  const banner = state.editingId
    ? 'editing'
    : state.replyTo
      ? `↩  ${state.replyTo.name || 'reply'}`
      : (hoverLegend(state) || state.status || '');
  const status = fillRow(banner, width, { fg: state.error ? PALETTE.error : PALETTE.muted });

  const text = state.composer || '';
  const caret = state.composerCaret || 0;
  const fieldWidth = Math.max(1, width);
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
  let field = '';
  for (let i = 0; i < box.length; i += 1) {
    const ch = box[i];
    if (i === caretCell && !usingPlaceholder) {
      field += `${ansi.underline()}${ansi.bg(color)}${ansi.fg('#161b22')}${ch}${ansi.reset()}`;
    } else if (i === caretCell && usingPlaceholder) {
      field += `${ansi.underline()}${ansi.bg(color)}${ansi.fg('#161b22')}${ch}${ansi.reset()}`;
    } else {
      field += `${ansi.underline()}${ansi.fg(color)}${ch}${ansi.reset()}`;
    }
  }
  return { status, field };
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
  // Backdrop first so more specific button hits win in hitTest (last match).
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

/**
 * Build one chat frame.
 *
 * @returns {{
 *   lines: string[],
 *   regions: object,
 *   hits: object[],
 *   visibleCount: number,
 *   totalLines: number,
 *   maxScroll: number,
 * }}
 */
function buildChatFrame(cols, rows, state = DEFAULT_CHAT) {
  const width = Math.max(1, cols);
  const height = Math.max(1, rows);
  const sideW = sidebarWidth(width);
  const mainX = sideW > 0 ? sideW + 1 : 0;
  const mainW = Math.max(1, width - mainX);
  const transcriptY = CHANNEL_ROW;
  const transcriptH = Math.max(1, height - CHANNEL_ROW - COMPOSER_ROWS);
  const composerY = height - COMPOSER_ROWS;

  const regions = {
    sidebar: { x: 0, y: 0, w: sideW, h: height },
    channels: { x: mainX, y: 0, w: mainW, h: CHANNEL_ROW },
    transcript: { x: mainX, y: transcriptY, w: mainW, h: transcriptH },
    composer: { x: mainX, y: composerY, w: mainW, h: COMPOSER_ROWS },
  };

  const hits = [];
  const lines = Array.from({ length: height }, () => ' '.repeat(width));

  const side = buildSidebar(state, sideW, height);
  const channels = buildChannelRow(state, mainW, mainX, 0);
  hits.push(...side.hits, ...channels.hits);

  const filtered = filterMessages(state.messages, state.activeChannel);
  const blocks = filtered.map((item) => ({
    item,
    layout: layoutMessage(item, mainW, state.userId),
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

  for (let i = 0; i < transcriptH; i += 1) {
    const screenY = transcriptY + i;
    const entry = visible[i];
    const prefix = sideW > 0
      ? (side.lines[screenY] || fillRow('', sideW, {})) + `${ansi.fg(PALETTE.border)}│${ansi.reset()}`
      : '';
    if (!entry || entry.kind === 'gap') {
      lines[screenY] = prefix + fillRow('', mainW, {});
      continue;
    }
    const id = String(entry.item.msg?.id || '');
    const hover = hoverId !== null && id === hoverId;
    const painted = paintMessageRow(entry.row, mainW, {
      hover,
      isMeta: entry.rowInBlock === 0,
      hoverAction: hover ? state.hoverAction : null,
      actions: entry.layout.actions,
    });
    lines[screenY] = prefix + painted;

    hits.push({
      type: 'message',
      id: entry.item.msg.id,
      x: mainX,
      y: screenY,
      w: mainW,
      h: 1,
    });

    if (entry.rowInBlock === 0 && hover) {
      for (const hit of actionHits(entry.layout.actions, mainX, screenY, mainW)) {
        hits.push({ ...hit, id: entry.item.msg.id });
      }
    }

    const card = entry.layout.card;
    if (card && entry.rowInBlock >= card.start && entry.rowInBlock < card.start + card.height) {
      hits.push({
        type: 'card',
        id: entry.item.msg.id,
        x: mainX,
        y: screenY,
        w: card.width,
        h: 1,
      });
    }
  }

  // Sidebar + divider on header / composer rows (transcript already painted them).
  if (sideW > 0) {
    for (const y of [0, composerY, composerY + 1]) {
      if (y < 0 || y >= height) continue;
      if (y >= transcriptY && y < transcriptY + transcriptH) continue;
      const left = side.lines[y] || fillRow('', sideW, {});
      const divider = `${ansi.fg(PALETTE.border)}│${ansi.reset()}`;
      if (y === 0) {
        lines[0] = left + divider + channels.line;
      }
    }
  } else {
    lines[0] = channels.line;
  }

  const composer = buildComposer(state, mainW);
  const sideAt = (y) => (sideW > 0
    ? (side.lines[y] || fillRow('', sideW, {})) + `${ansi.fg(PALETTE.border)}│${ansi.reset()}`
    : '');
  lines[composerY] = sideAt(composerY) + composer.status;
  lines[composerY + 1] = sideAt(composerY + 1) + composer.field;
  hits.push({
    type: 'composer',
    x: mainX,
    y: composerY + 1,
    w: mainW,
    h: 1,
  });

  if (state.loading && filtered.length === 0) {
    const msg = 'loading…';
    const y = transcriptY + Math.floor(transcriptH / 2);
    const x = mainX + Math.max(0, Math.floor((mainW - ansi.width(msg)) / 2));
    const left = sideW > 0
      ? (side.lines[y] || fillRow('', sideW, {})) + `${ansi.fg(PALETTE.border)}│${ansi.reset()}`
      : '';
    lines[y] = left + fillRow(`${' '.repeat(Math.max(0, x - mainX))}${msg}`, mainW, { fg: PALETTE.muted });
  }

  const overlayHits = paintOverlay(lines, width, height, state.overlay);
  hits.push(...overlayHits.hits);

  // Guarantee every line is exactly `width` cells so erase-then-write never
  // leaves a short row sitting on leftover glyphs.
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
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  CHANNEL_ROW,
  COMPOSER_ROWS,
  DEFAULT_CHAT,
  sidebarWidth,
  formatTime,
  formatBytes,
  wrapText,
  actionListFor,
  actionStrip,
  layoutMessage,
  hitTest,
  filterMessages,
  buildChatFrame,
  composeChatFrame,
};
