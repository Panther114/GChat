'use strict';

/**
 * Inline terminal renderer.
 *
 * Nothing here uses the alternate screen: finished output ("committed" lines)
 * is written into the normal scrollback, and only a small live region at the
 * bottom (dialogs, input box, footer) is erased and repainted in place. That
 * keeps native scrollback, selection and copy working, like Claude Code.
 */

const ansi = require('../tui/ansi');

const SYNC_ON = '\u001b[?2026h';
const SYNC_OFF = '\u001b[?2026l';

/** Number of terminal rows a line occupies at the given width. */
function rowsFor(line, cols) {
  const w = ansi.width(line);
  return Math.max(1, Math.ceil(w / Math.max(1, cols)));
}

/**
 * Splits text into visual lines no wider than `cols`, tracking the caret.
 * Pass one column less than the box width so the caret never lands past the edge.
 */
function layoutText(text, cols, caretIndex = null, { mask = false } = {}) {
  const lines = [];
  let line = '';
  let lineWidth = 0;
  let caret = null;
  let index = 0;
  for (const ch of text) {
    if (ch === '\n') {
      if (caretIndex === index) caret = { row: lines.length, col: lineWidth };
      lines.push(line);
      line = '';
      lineWidth = 0;
      index += ch.length;
      continue;
    }
    const shown = mask ? '•' : ch;
    const w = Math.max(0, ansi.charWidth(shown));
    if (lineWidth + w > cols) {
      lines.push(line);
      line = '';
      lineWidth = 0;
    }
    if (caretIndex === index) caret = { row: lines.length, col: lineWidth };
    line += shown;
    lineWidth += w;
    index += ch.length;
  }
  if (caretIndex !== null && caret === null) caret = { row: lines.length, col: lineWidth };
  lines.push(line);
  return { lines, caret };
}

/** Word-wraps styled text to `cols`, keeping explicit newlines. */
function wrapText(text, cols) {
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    if (ansi.width(paragraph) <= cols) {
      out.push(paragraph);
      continue;
    }
    let line = '';
    let lineWidth = 0;
    const words = paragraph.split(/( +)/);
    for (const word of words) {
      const w = ansi.width(word);
      if (lineWidth + w <= cols) {
        line += word;
        lineWidth += w;
        continue;
      }
      if (word.trim() === '') continue;
      if (lineWidth > 0) {
        out.push(line.replace(/ +$/, ''));
        line = '';
        lineWidth = 0;
      }
      if (w <= cols) {
        line = word;
        lineWidth = w;
        continue;
      }
      // A single token wider than the line: hard-break it by display width.
      let chunk = '';
      let chunkWidth = 0;
      for (const ch of word) {
        const cw = Math.max(0, ansi.charWidth(ch));
        if (chunkWidth + cw > cols) {
          out.push(chunk);
          chunk = '';
          chunkWidth = 0;
        }
        chunk += ch;
        chunkWidth += cw;
      }
      line = chunk;
      lineWidth = chunkWidth;
    }
    out.push(line.replace(/ +$/, ''));
  }
  return out;
}

class LiveScreen {
  constructor({ stdout }) {
    this.out = stdout;
    this.lines = [];
    this.caret = null; // { row, col } within the live region, or null to hide the cursor
    this.painted = null; // { lines, caretRow, cols } describing what is on screen
    this.trackCursor = false; // ask the terminal where the region is (needed for mouse clicks)
    this.pendingReports = [];
    this.originTop = null; // 1-based terminal row of the live region's first line
  }

  /** Called with the terminal's answer to our cursor position request. */
  handleCursorReport(row) {
    const snapshot = this.pendingReports.shift();
    if (snapshot) this.originTop = row - snapshot.caretRow;
  }

  /** Index into the live region for a 1-based terminal row, or -1 when outside it. */
  regionRow(y) {
    if (this.originTop == null || !this.painted) return -1;
    const index = y - this.originTop;
    return index >= 0 && index < this.painted.lines.length ? index : -1;
  }

  cols() {
    return Math.max(20, this.out.columns || 80);
  }

  rows() {
    return Math.max(5, this.out.rows || 24);
  }

  _erase() {
    if (!this.painted) return '';
    const cols = this.cols();
    const { lines, caretRow, caretCol, cols: paintedCols } = this.painted;
    let up = 0;
    if (cols === paintedCols) {
      up = caretRow;
    } else {
      // The terminal re-wrapped the old lines after a resize: count rows at the new
      // width, plus the wrapped rows of the caret's own line above the cursor.
      for (let k = 0; k < caretRow; k += 1) up += rowsFor(lines[k], cols);
      up += Math.floor(caretCol / cols);
    }
    this.painted = null;
    return `\r${up > 0 ? `\u001b[${up}A` : ''}\u001b[J`;
  }

  _paintSeq() {
    const cols = this.cols();
    const lines = this.lines.map((l) => ansi.truncate(l, cols));
    let seq = lines.join('\r\n');
    const last = lines.length - 1;
    const caretRow = this.caret ? Math.min(this.caret.row, last) : last;
    const caretCol = this.caret ? this.caret.col : ansi.width(lines[last] || '');
    if (this.caret) {
      const up = last - caretRow;
      if (up > 0) seq += `\u001b[${up}A`;
      seq += '\r';
      if (this.caret.col > 0) seq += `\u001b[${Math.min(this.caret.col, cols - 1)}C`;
    }
    this.painted = { lines, caretRow, caretCol, cols };
    let query = '';
    if (this.trackCursor && this.wantTrack) {
      query = '\u001b[6n';
      this.pendingReports.push({ caretRow });
      if (this.pendingReports.length > 8) this.pendingReports.shift();
    }
    return seq + (this.caret ? '\u001b[?25h' : '\u001b[?25l') + query;
  }

  /** Replace the live region. */
  render(lines, caret = null, { track = true } = {}) {
    this.lines = lines;
    this.caret = caret;
    this.wantTrack = track;
    this.out.write(`${SYNC_ON}\u001b[?25l${this._erase()}${this._paintSeq()}${SYNC_OFF}`);
  }

  /** Write finished lines above the live region (into scrollback). */
  commit(lines) {
    if (!lines || !lines.length) return;
    const body = `${lines.join('\r\n')}\r\n`;
    this.out.write(`${SYNC_ON}\u001b[?25l${this._erase()}${body}${this._paintSeq()}${SYNC_OFF}`);
  }

  /** Raw terminal output (image protocols etc.) above the live region. */
  commitRaw(data) {
    this.wantTrack = true;
    this.out.write(`${SYNC_ON}\u001b[?25l${this._erase()}${data}${this._paintSeq()}${SYNC_OFF}`);
  }

  /** Clears the visible screen and scrollback, then repaints the live region. */
  clearAll() {
    this.painted = null;
    this.out.write(`${SYNC_ON}\u001b[2J\u001b[3J\u001b[H${this._paintSeq()}${SYNC_OFF}`);
  }

  /** Leaves the live region on screen and moves the cursor below it. */
  release() {
    if (this.painted) {
      const down = this.painted.lines.length - 1 - this.painted.caretRow;
      this.out.write(`${down > 0 ? `\u001b[${down}B` : ''}\r\n\u001b[?25h`);
      this.painted = null;
    } else {
      this.out.write('\u001b[?25h');
    }
  }
}

module.exports = { LiveScreen, layoutText, wrapText, rowsFor };
