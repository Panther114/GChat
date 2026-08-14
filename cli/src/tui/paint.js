'use strict';

/**
 * Diffing terminal painter.
 *
 * Full-screen TUIs that rewrite every cell on every tick feel like a
 * harness in Apple Terminal.app: eraseLine + a wall of SGR is expensive
 * and races the display. This painter:
 *   - writes only rows whose bytes changed
 *   - never eraseLine (full-width rows already overwrite the cell)
 *   - falls back to a full rewrite when most rows are dirty, on resize,
 *     or periodically so a missed cell cannot linger
 */

const ansi = require('./ansi');
const { runWithTheme, PALETTE, paintCanvasLine } = require('./theme');

function isAppleTerminal() {
  return String(process.env.TERM_PROGRAM || '').toLowerCase() === 'apple_terminal';
}

function fullEveryMs() {
  return isAppleTerminal() ? 4000 : 2000;
}

function fullEveryFrames() {
  return isAppleTerminal() ? 20 : 36;
}

function createScreenPainter() {
  let prev = [];
  let prevRaw = [];
  let prevW = 0;
  let prevH = 0;
  let incremental = 0;
  let lastFullAt = 0;

  function reset() {
    prev = [];
    prevRaw = [];
    prevW = 0;
    prevH = 0;
    incremental = 0;
    lastFullAt = 0;
  }

  function paint(lines, cols, rows, opts = {}) {
    const width = Math.max(1, cols);
    const height = Math.max(1, rows);
    const now = Date.now();
    const next = new Array(height);
    for (let y = 0; y < height; y += 1) next[y] = lines[y] || '';

    const sizeChanged = prevW !== width || prevH !== height;
    const dueTime = lastFullAt > 0 && (now - lastFullAt >= fullEveryMs());
    const dueFrames = incremental >= fullEveryFrames();
    let force = !!(opts.force || sizeChanged || dueTime || dueFrames || prev.length === 0);

    let dirty = 0;
    if (!force) {
      for (let y = 0; y < height; y += 1) {
        if (next[y] !== prev[y]) dirty += 1;
      }
      if (dirty === 0) return '';
      if (dirty > height * 0.6) force = true;
    }

    let out = '';
    if (force) {
      out += ansi.cursorHide();
      for (let y = 0; y < height; y += 1) {
        out += ansi.cursorTo(0, y) + next[y];
      }
      incremental = 0;
      lastFullAt = now;
    } else {
      for (let y = 0; y < height; y += 1) {
        if (next[y] !== prev[y]) out += ansi.cursorTo(0, y) + next[y];
      }
      incremental += 1;
    }

    prev = next;
    prevW = width;
    prevH = height;
    return out;
  }

  /**
   * Wrap raw frame lines onto the theme canvas, reusing last wrap for
   * unchanged rows, then diff-paint.
   */
  function paintRaw(rawLines, cols, rows, opts = {}) {
    const width = Math.max(1, cols);
    const height = Math.max(1, rows);
    const theme = opts.theme;
    const originX = opts.originX || 0;
    const sizeChanged = prevW !== width || prevH !== height;
    const forceWrap = !!(opts.force || sizeChanged || prevRaw.length !== height);

    return runWithTheme(theme, () => {
      const canvas = opts.canvas || PALETTE.canvas;
      const wrapped = new Array(height);
      for (let y = 0; y < height; y += 1) {
        const raw = rawLines[y] || '';
        if (!forceWrap && raw === prevRaw[y] && prev[y]) {
          wrapped[y] = prev[y];
        } else {
          wrapped[y] = paintCanvasLine(raw, width, originX, canvas);
        }
      }
      prevRaw = Array.from({ length: height }, (_, y) => rawLines[y] || '');
      return paint(wrapped, width, height, opts);
    });
  }

  return {
    paint,
    paintRaw,
    reset,
  };
}

function composeFull(lines, cols, rows) {
  return createScreenPainter().paint(lines, cols, rows, { force: true });
}

module.exports = {
  createScreenPainter,
  composeFull,
  isAppleTerminal,
  fullEveryMs,
  fullEveryFrames,
};
