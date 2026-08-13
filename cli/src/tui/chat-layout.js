'use strict';

/**
 * Pure Mini GChat frame builder.
 *
 * Hover outlines a message (no fill). Click selects it. Icons sit on the
 * right; the hint row under the transcript spells reply/edit/delete/clear
 * with a stylized first letter — only while a message is selected.
 */

const ansi = require('./ansi');
const landing = require('./landing');
const { clampScroll } = require('./landing');

const PALETTE = {
  title: '#ffffff',
  text: '#e6edf3',
  muted: '#6e7681',
  hoverFg: '#e6edf3',
  outline: '#6e7681',
  outlineStrong: '#c9d1d9',
  channelHover: '#b1bac4',
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
};

const TEXT = '\uFE0E';

const ACTIONS = {
  reply: { id: 'reply', key: 'r', glyph: '↩', label: 'reply', color: PALETTE.keyR },
  edit: { id: 'edit', key: 'e', glyph: `${'✎'}${TEXT}`, label: 'edit', color: PALETTE.keyE },
  delete: { id: 'delete', key: 'd', glyph: '×', label: 'delete', color: PALETTE.keyD },
  preview: { id: 'preview', key: 'p', glyph: '▣', label: 'preview', color: PALETTE.keyP },
  clear: { id: 'clear', key: 'c', glyph: null, label: 'clear', color: PALETTE.muted },
};

const SIDEBAR_MIN = 20;
const SIDEBAR_MAX = 26;
const PAD = 2;
const CHANNEL_ROWS = 3;
const COMPOSER_MIN_INNER = 1;
const COMPOSER_MAX_INNER = 4;
const SCROLLBAR_W = 1;
const WHEEL_LINES = 3;
const FIELD_CARET = '█';
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
  overlay: null,
  loading: false,
  animFrame: 0,
  transition: null,
  typing: null,
  creatingChannel: false,
  channelDraft: '',
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

function actionListFor(item, userId) {
  const list = [ACTIONS.reply];
  if (isImage(item)) list.push(ACTIONS.preview);
  if (isOwnMessage(item, userId)) {
    if (!isAttachment(item) && item.msg?.type !== 'whisper') list.push(ACTIONS.edit);
    list.push(ACTIONS.delete);
  }
  return list;
}

function hintActionsFor(item, userId) {
  return [...actionListFor(item, userId), ACTIONS.clear];
}

function iconStrip(actions) {
  return actions.filter((a) => a.glyph).map((a) => a.glyph).join('  ');
}

function overlayIcons(metaPlain, actions, width) {
  const strip = iconStrip(actions);
  if (!strip) return metaPlain;
  const stripW = ansi.width(strip);
  const bodyW = Math.max(0, width - stripW - 1);
  const body = ansi.width(metaPlain) > bodyW
    ? ansi.stripAnsi(ansi.truncate(metaPlain, Math.max(1, bodyW)))
    : metaPlain;
  return body + ' '.repeat(Math.max(0, width - ansi.width(body) - stripW)) + strip;
}

function iconHits(actions, originX, originY, width) {
  const strip = iconStrip(actions);
  const stripW = ansi.width(strip);
  let x = originX + width - stripW;
  const hits = [];
  for (const action of actions) {
    if (!action.glyph) continue;
    const w = Math.max(1, ansi.width(action.glyph));
    hits.push({ type: 'action', action: action.id, x, y: originY, w, h: 1 });
    x += w + 2;
  }
  return hits;
}

function styleWord(word, color) {
  const first = word[0] || '';
  const rest = word.slice(1);
  return `${ansi.bold()}${ansi.fg(color)}${first}${ansi.reset()}${ansi.fg(PALETTE.muted)}${rest}${ansi.reset()}`;
}

function styleHint(actions) {
  return actions.map((action) => {
    const color = action.id === 'delete' ? PALETTE.muted : action.color;
    let word = styleWord(action.label, color);
    if (action.id === 'preview') {
      word += ` ${ansi.fg(PALETTE.keyP)}${ACTIONS.preview.glyph}${ansi.reset()}`;
    }
    return word;
  }).join('   ');
}

function hintHits(actions, originX, originY) {
  let x = originX;
  const hits = [];
  for (const action of actions) {
    const extra = action.id === 'preview' ? ` ${ACTIONS.preview.glyph}` : '';
    const w = ansi.width(action.label + extra);
    hits.push({ type: 'action', action: action.id, id: null, x, y: originY, w, h: 1 });
    x += w + 3;
  }
  return hits;
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

function styleImageLabel(frame) {
  const word = '[Image]';
  let out = '';
  for (let i = 0; i < word.length; i += 1) {
    const hot = landing.isHot(0, i, frame || 0, { speed: 0.5, width: 3, period: 16 });
    out += hot
      ? `${ansi.bold()}${ansi.fg(PALETTE.title)}${word[i]}${ansi.reset()}`
      : `${ansi.fg(PALETTE.card)}${word[i]}${ansi.reset()}`;
  }
  return out;
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
  if (isImage(item)) {
    card = { start: rows.length, height: 1, width: Math.min(width, 8) };
    rows.push('[Image]');
  } else if (isAttachment(item)) {
    const name = item.attach?.filename || 'file';
    card = { start: rows.length, height: 1, width: Math.min(width, ansi.width(name) + 8) };
    rows.push(`[file] ${name}`);
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
  outlined, isMeta, isReply, showIcons, hoverAction, actions, sending, animFrame, isImageRow,
}) {
  let content = isImageRow ? '' : plain;
  if (showIcons && isMeta) content = overlayIcons(plain, actions, width);
  if (sending && !isMeta && !isReply && !isImageRow) {
    const label = sendingLabel(animFrame);
    const labelW = ansi.width(label);
    const bodyW = Math.max(0, width - labelW - 1);
    const body = ansi.width(content) > bodyW
      ? ansi.stripAnsi(ansi.truncate(content, Math.max(1, bodyW)))
      : content;
    content = body + ' '.repeat(Math.max(0, width - ansi.width(body) - labelW)) + label;
  }
  const fg = isReply || sending ? PALETTE.muted : (isMeta ? PALETTE.muted : PALETTE.text);
  let painted;
  if (isImageRow) {
    painted = padCells(styleImageLabel(animFrame), width);
  } else {
    painted = fillRow(content, width, { fg, dim: !!sending });
  }
  if (showIcons && isMeta) {
    for (const action of actions) {
      if (!action.glyph) continue;
      const hot = hoverAction === action.id;
      const styled = `${hot ? ansi.bold() : ''}${ansi.fg(action.color)}${action.glyph}${ansi.reset()}`;
      painted = painted.replace(action.glyph, styled);
    }
  }
  return painted;
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

function chipWidth(label) {
  return Math.max(5, ansi.width(label) + 2);
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

  const paintChip = (label, { active, hover, draft }) => {
    const w = chipWidth(label);
    if (x + w > width - 1) return false;
    const color = active ? PALETTE.title : (hover ? PALETTE.channelHover : PALETTE.muted);
    const body = ` ${padCells(label, w - 2)} `;
    const top = `${ansi.fg(color)}╭${'─'.repeat(w - 2)}╮${ansi.reset()}`;
    const mid = `${ansi.fg(color)}│${ansi.reset()}${ansi.fg(active ? PALETTE.title : color)}${ansi.bold()}${body.slice(1, -1)}${ansi.reset()}${ansi.fg(color)}│${ansi.reset()}`;
    const bot = `${ansi.fg(color)}╰${'─'.repeat(w - 2)}╯${ansi.reset()}`;
    const splice = (row, fragment) => {
      const prefix = ansi.width(lines[row]) === width && lines[row].trim() === '' ? ' '.repeat(x) : padCells(lines[row].slice(0, 0) + ' '.repeat(x), x);
      lines[row] = padCells(prefix + fragment + ' ', width);
    };
    // Rebuild each row from a buffer of chips instead of splicing ANSI.
    return { x, w, top, mid, bot, color };
  };

  const chips = [];
  for (const name of channels) {
    const label = `#${name}`;
    const w = chipWidth(label);
    if (x + w > width - PAD - 6) break;
    const active = name === (state.activeChannel || 'main');
    const hover = !active && state.hoverChannel === name;
    chips.push({
      type: 'channel',
      name,
      label,
      x,
      w,
      active,
      hover,
    });
    x += w + 1;
  }
  if (state.creatingChannel) {
    const draft = `#${state.channelDraft || ''}${FIELD_CARET}`;
    const w = Math.max(8, chipWidth(draft));
    if (x + w <= width - PAD) {
      chips.push({
        type: 'channel-draft',
        name: 'draft',
        label: draft,
        x,
        w,
        active: true,
        hover: false,
      });
      x += w + 1;
    }
  } else {
    const w = chipWidth('+');
    if (x + w <= width - PAD) {
      chips.push({
        type: 'create-channel',
        name: '+',
        label: '+',
        x,
        w,
        active: false,
        hover: state.hoverChannel === '+',
      });
    }
  }

  const rowBuf = [' '.repeat(width), ' '.repeat(width), ' '.repeat(width)];
  const writePlain = (row, at, text) => {
    const chars = [...rowBuf[row]];
    // rowBuf is spaces; we store styled strings separately
    void chars;
    void at;
    void text;
  };
  void writePlain;
  void paintChip;

  const styled = ['', '', ''];
  let cursor = 0;
  const padTo = (target) => {
    const used = ansi.width(styled[0]);
    if (target > used) {
      const gap = ' '.repeat(target - used);
      styled[0] += gap;
      styled[1] += gap;
      styled[2] += gap;
    }
    cursor = target;
  };
  padTo(PAD);
  for (const chip of chips) {
    padTo(chip.x);
    const color = chip.active ? PALETTE.title : (chip.hover ? PALETTE.channelHover : PALETTE.muted);
    const inner = padCells(chip.label, chip.w - 2);
    styled[0] += `${ansi.fg(color)}╭${'─'.repeat(chip.w - 2)}╮${ansi.reset()}`;
    styled[1] += `${ansi.fg(color)}│${ansi.reset()}${ansi.fg(color)}${chip.active ? ansi.bold() : ''}${inner}${ansi.reset()}${ansi.fg(color)}│${ansi.reset()}`;
    styled[2] += `${ansi.fg(color)}╰${'─'.repeat(chip.w - 2)}╯${ansi.reset()}`;
    hits.push({
      type: chip.type,
      name: chip.name,
      x: originX + chip.x,
      y: originY,
      w: chip.w,
      h: 3,
    });
    cursor = chip.x + chip.w;
  }
  lines[0] = padCells(styled[0], width);
  lines[1] = padCells(styled[1], width);
  lines[2] = padCells(styled[2], width);
  return { lines, hits };
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

function buildComposerHint(state, width) {
  if (state.error) return fillRow(`${' '.repeat(PAD)}${state.error}`, width, { fg: PALETTE.error });
  if (state.overlay && state.overlay.type === 'delete') {
    return fillRow('', width, {});
  }
  if (state.editingId) return fillRow(`${' '.repeat(PAD)}editing`, width, { fg: PALETTE.muted });
  if (state.replyTo) {
    return fillRow(`${' '.repeat(PAD)}↩  ${state.replyTo.name || 'reply'}`, width, { fg: PALETTE.muted });
  }
  if (state.selectedMessageId) {
    const item = (state.messages || []).find((m) => String(m.msg?.id) === String(state.selectedMessageId));
    if (item) {
      const actions = hintActionsFor(item, state.userId);
      return padCells(`${' '.repeat(PAD)}${styleHint(actions)}`, width);
    }
  }
  if (state.typing && state.typing.username) {
    const pulse = Math.floor((state.animFrame || 0) / 8) % 2 === 0;
    const dots = pulse ? '…' : '   ';
    return fillRow(`${' '.repeat(PAD)}${state.typing.username} is typing${dots}`, width, { fg: PALETTE.muted });
  }
  return fillRow('', width, {});
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
        caretCol = at - start;
        break;
      }
      if (at === raw.length && i === wrapped.length - 1) {
        caretLine = i;
        caretCol = wrapped[i].text.length;
      }
    }
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
  const color = PALETTE.outlineStrong;
  const lines = [boxTop(width, color)];
  const bar = scrollbarGlyphs(metrics.innerH, metrics.total, metrics.innerH, metrics.total - metrics.innerH - metrics.lineScroll);
  const shown = metrics.wrapped.slice(metrics.lineScroll, metrics.lineScroll + metrics.innerH);
  while (shown.length < metrics.innerH) shown.push({ start: 0, text: '' });
  shown.forEach((entry, i) => {
    const absLine = metrics.lineScroll + i;
    let text = metrics.usingPlaceholder ? metrics.placeholder : entry.text;
    let caretCell = -1;
    if (metrics.usingPlaceholder && i === 0) caretCell = 0;
    else if (!metrics.usingPlaceholder && absLine === metrics.caretLine) caretCell = metrics.caretCol;
    let painted = '';
    const colorFg = metrics.usingPlaceholder ? PALETTE.placeholder : PALETTE.text;
    const display = padCells(text, metrics.textW);
    for (let c = 0; c < display.length; c += 1) {
      const ch = display[c];
      if (c === caretCell) {
        painted += `${ansi.bg(colorFg)}${ansi.fg('#161b22')}${ch === ' ' ? FIELD_CARET : ch}${ansi.reset()}`;
      } else {
        painted += `${ansi.fg(colorFg)}${ch}${ansi.reset()}`;
      }
    }
    const thumb = metrics.overflow
      ? (bar[i] === '█' ? `${ansi.fg(PALETTE.thumb)}█${ansi.reset()}` : `${ansi.fg(PALETTE.track)}│${ansi.reset()}`)
      : ' ';
    lines.push(boxRow(padCells(painted, metrics.textW) + thumb, width, color));
  });
  lines.push(boxBottom(width, color));
  return lines;
}

function showBird(state) {
  return !state.activeGroupId || !!state.transition;
}

function outlineColor(hover, selected) {
  if (selected) return PALETTE.outlineStrong;
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
  const metrics = composerMetrics(state, boxW);
  const composerH = metrics.chrome;
  const transcriptY = CHANNEL_ROWS;
  const transcriptH = Math.max(1, height - CHANNEL_ROWS - composerH);
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

  const side = buildSidebar(state, sideW, height);
  const channels = buildChannelBar(state, contentW, mainX, 0);
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
  const bird = showBird(state);
  const birdLines = bird ? buildBirdLines(contentW, transcriptH, state.animFrame || 0) : null;
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
      lines[screenY] = join(left, birdLines[i] || fillRow('', contentW, {}), ' ');
      continue;
    }
    const abs = start + i;
    const entry = visible[i];
    const prev = abs > 0 ? flat[abs - 1] : null;
    const next = abs + 1 < flat.length ? flat[abs + 1] : null;
    const idOf = (node) => (node && node.kind === 'row' ? String(node.item.msg?.id || '') : '');

    if (!entry || entry.kind === 'gap') {
      const nextId = idOf(next);
      const prevId = idOf(prev);
      const nextColor = outlineColor(nextId && nextId === hoverId, nextId && nextId === selectedId);
      const prevColor = outlineColor(prevId && prevId === hoverId, prevId && prevId === selectedId);
      let mid;
      const deleting = state.overlay && state.overlay.type === 'delete'
        && prevId && String(state.overlay.messageId) === prevId;
      if (deleting) {
        const label = ' confirm deletion? ';
        const pulsed = pulseText(label.trim(), state.animFrame, PALETTE.error, '#7a2d2d');
        const inner = Math.max(0, boxW - 2);
        const padL = Math.max(0, Math.floor((inner - ansi.width(label)) / 2));
        const row = `${ansi.fg(PALETTE.error)}╰${'─'.repeat(padL)}${ansi.reset()}${pulsed}${ansi.fg(PALETTE.error)}${'─'.repeat(Math.max(0, inner - padL - ansi.width(label)))}╯${ansi.reset()}`;
        mid = `${' '.repeat(PAD)}${row}`;
        protectedRows.add(screenY);
        confirmHits.push({
          type: 'confirm-delete',
          x: mainX + PAD + 1 + padL,
          y: screenY,
          w: ansi.width(label.trim()),
          h: 1,
        });
      } else if (nextColor) {
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
    const color = outlineColor(hover, selected);
    const showIcons = hover || selected;
    const painted = paintMessageRow(entry.row, textW, {
      outlined: !!color,
      isMeta: entry.rowInBlock === entry.layout.metaRow,
      isReply: entry.rowInBlock === entry.layout.replyRow,
      showIcons,
      hoverAction: (hover || selected) ? state.hoverAction : null,
      actions: entry.layout.actions,
      sending: !!entry.item.sending,
      animFrame: state.animFrame || 0,
      isImageRow: entry.layout.card && entry.rowInBlock === entry.layout.card.start && isImage(entry.item),
    });
    const inner = color ? boxRow(painted, boxW, color) : `${' '.repeat(1)}${painted}${' '.repeat(1)}`;
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

    if (showIcons && entry.rowInBlock === entry.layout.metaRow) {
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

  for (let i = 0; i < CHANNEL_ROWS; i += 1) {
    lines[i] = withBar(i, channels.lines[i] || fillRow('', contentW, {}));
  }

  const hint = buildComposerHint(state, contentW);
  const boxLines = buildComposerBox(state, boxW, metrics);
  lines[composerY] = withBar(composerY, hint);
  boxLines.forEach((row, i) => {
    lines[composerY + 1 + i] = withBar(composerY + 1 + i, `${' '.repeat(PAD)}${row}`);
  });
  const padY = composerY + 1 + boxLines.length;
  if (padY < height) lines[padY] = withBar(padY, fillRow('', contentW, {}));

  if (state.selectedMessageId && !(state.overlay && state.overlay.type === 'delete')) {
    const item = (state.messages || []).find((m) => String(m.msg?.id) === String(state.selectedMessageId));
    if (item) {
      for (const hit of hintHits(hintActionsFor(item, state.userId), mainX + PAD, composerY)) {
        hits.push({ ...hit, id: item.msg.id });
      }
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
  if (state.overlay && state.overlay.type === 'delete') {
    for (let y = 0; y < height; y += 1) {
      if (!protectedRows.has(y)) lines[y] = dimLine(lines[y]);
    }
    hits.push({ type: 'dim', x: 0, y: 0, w: width, h: height });
  }
  hits.push(...confirmHits);

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
    composerMetrics: metrics,
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
  COMPOSER_MIN_INNER,
  COMPOSER_MAX_INNER,
  SCROLLBAR_W,
  WHEEL_LINES,
  TRANSITION_MS,
  DEFAULT_CHAT,
  sidebarWidth,
  sidebarTitle,
  formatTime,
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
  findMessageBounds,
  clampScrollForMessage,
  composerMetrics,
  buildBirdLines,
  buildChatFrame,
  composeChatFrame,
};
