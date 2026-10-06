'use strict';

/**
 * The home screen: a welcome box with the animated bird on the left and the
 * list of chats (plus a few tips) on the right, in the style of Claude Code's
 * start screen. Returns plain lines plus click targets.
 */

const ansi = require('../tui/ansi');
const fmt = require('./format');
const { renderBird, birdSize, MARGIN } = require('./bird');

const MAX_VISIBLE_CHATS = 6;
const BOX_MAX = 100;
const LEFT_WIDTH = 38;

function padTo(text, width) {
  const gap = width - ansi.width(text);
  return gap > 0 ? text + ' '.repeat(gap) : ansi.truncate(text, width);
}

function center(text, width) {
  const gap = width - ansi.width(text);
  if (gap <= 0) return ansi.truncate(text, width);
  const left = Math.floor(gap / 2);
  return ' '.repeat(left) + text + ' '.repeat(gap - left);
}

/** Largest bird (in cells) that fits the available rows. */
function pickBirdWidth(freeRows, maxWidth) {
  let width = Math.min(30, maxWidth);
  while (width >= 14 && birdSize(width).rows + 1 > freeRows) width -= 2;
  return width >= 14 ? width : 0;
}

/**
 * @param {object} o
 * @param {Array<{id:string,name:string,unreadCount?:number}>} o.groups
 * @param {number} o.selected   index into the combined item list (groups, then New, then Join)
 * @returns {{lines:string[], hits:Array, items:Array, birdBox:{row:number,x0:number,x1:number}|null}}
 */
function renderHome({
  cols, rows, t, enter, burst, user, host, connected, groups, selected, lastId, version, dark = true,
}) {
  const t2 = fmt.getTheme();
  const boxWidth = Math.min(cols, BOX_MAX);
  const inner = boxWidth - 4;
  const twoCol = boxWidth >= 78;
  const leftW = twoCol ? LEFT_WIDTH : inner;
  const rightW = twoCol ? inner - leftW - 3 : inner;

  const items = [
    ...groups.map((g) => ({ kind: 'group', group: g })),
    { kind: 'new' },
    { kind: 'join' },
  ];
  const sel = Math.max(0, Math.min(selected, items.length - 1));

  // ── right column ──
  const right = [];
  right.push(fmt.color('accent', fmt.bold('Tips for getting started')));
  const last = groups.find((g) => String(g.id) === String(lastId));
  right.push(fmt.muted(last ? `Press Enter to pick up in ${last.name}.` : 'Pick a chat below, or create one.'));
  right.push(fmt.muted('Type / for commands, or click and use ↑ ↓.'));
  right.push(fmt.muted('Ctrl+V sends the image on your clipboard.'));
  right.push(fmt.dim('─'.repeat(Math.max(4, rightW - 1))));
  right.push(fmt.color('accent', fmt.bold('Your chats')));

  // Window the list around the selection.
  let start = 0;
  if (items.length > MAX_VISIBLE_CHATS + 2) {
    start = Math.max(0, Math.min(sel - 2, items.length - (MAX_VISIBLE_CHATS + 2)));
  }
  const visible = items.slice(start, start + MAX_VISIBLE_CHATS + 2);
  const itemRows = [];
  visible.forEach((item, i) => {
    const index = start + i;
    const active = index === sel;
    let label;
    let tag = '';
    let badge = '';
    if (item.kind === 'group') {
      label = item.group.name;
      if (String(item.group.id) === String(lastId)) tag = fmt.dim('last opened');
      if (Number(item.group.unreadCount) > 0) badge = fmt.color('error', `● ${item.group.unreadCount > 99 ? '99+' : item.group.unreadCount}`);
    } else if (item.kind === 'new') {
      label = '+ New group';
    } else {
      label = '+ Join with a code';
    }
    const pointer = active ? fmt.color('accent', '❯') : ' ';
    const left = `${pointer} ${active ? fmt.color('accent', fmt.bold(label)) : (item.kind === 'group' ? label : fmt.muted(label))}`;
    const rightPart = [tag, badge].filter(Boolean).join('  ');
    const gap = Math.max(1, rightW - ansi.width(left) - ansi.width(rightPart) - 1);
    const text = rightPart ? ansi.truncate(`${left}${' '.repeat(gap)}${rightPart}`, rightW) : ansi.truncate(left, rightW);
    itemRows.push({ index, line: right.length });
    right.push(text);
  });
  if (start > 0 || start + visible.length < items.length) {
    right.push(fmt.dim(`  ${items.length} in total · ↑ ↓ to scroll, /groups for all`));
  }

  // ── left column ──
  // Rows left for the bird once the input box, footer and the box chrome are accounted for.
  const spare = rows - 6 - 2 - 7;
  const wantBird = twoCol
    ? pickBirdWidth(spare, 30)
    : pickBirdWidth(spare - right.length, Math.min(24, inner - 2 * MARGIN));
  const left = [];
  left.push('');
  left.push(center(fmt.bold(`Welcome back, ${user || 'there'}!`), leftW));
  left.push('');
  let birdTop = -1;
  let birdWidth = 0;
  if (wantBird) {
    const bird = renderBird({ width: wantBird, t, enter, burst, dark });
    birdTop = left.length;
    birdWidth = wantBird + MARGIN * 2;
    for (const line of bird) left.push(center(line, leftW));
    left.push('');
  }
  left.push(center(fmt.muted(`${user || '-'} · ${host}`), leftW));
  left.push(center(connected ? fmt.color('ok', '● connected') : fmt.color('warn', '○ connecting…'), leftW));
  left.push('');

  // ── compose ──
  const hits = [];
  const lines = [];
  let birdBox = null;
  if (twoCol) {
    const height = Math.max(left.length, right.length + 1);
    const divider = fmt.dim(' │ ');
    for (let i = 0; i < height; i += 1) {
      lines.push(`${padTo(left[i] || '', leftW)}${divider}${padTo(right[i + 0] ?? '', rightW)}`);
    }
    for (const r of itemRows) hits.push({ row: r.line + 1, x0: 2 + leftW + 3, x1: 2 + inner, index: r.index });
    if (birdTop >= 0) {
      const x0 = 2 + Math.floor((leftW - birdWidth) / 2);
      birdBox = { row: birdTop + 1, rows: birdSize(wantBird).rows + 1, x0, x1: x0 + birdWidth };
    }
  } else {
    // Single column: heading, optional bird, then the list.
    const stack = [...left, ...right];
    stack.forEach((line) => lines.push(padTo(line, inner)));
    const offset = left.length;
    for (const r of itemRows) hits.push({ row: offset + r.line + 1, x0: 2, x1: 2 + inner, index: r.index });
    if (birdTop >= 0) {
      const x0 = 2 + Math.floor((inner - birdWidth) / 2);
      birdBox = { row: birdTop + 1, rows: birdSize(wantBird).rows + 1, x0, x1: x0 + birdWidth };
    }
  }

  const boxed = fmt.box(lines, boxWidth, { title: `GChat CLI v${version}`, borderKey: 'accent' });
  return { lines: boxed, hits, items, birdBox, selected: sel };
}

module.exports = { renderHome, MAX_VISIBLE_CHATS };
