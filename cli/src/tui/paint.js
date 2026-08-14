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

/** Paint cost (ms) above which we treat the TTY as behind. */
const OVERLOAD_MS = 24;

function isAppleTerminal() {
  return String(process.env.TERM_PROGRAM || '').toLowerCase() === 'apple_terminal';
}

function fullEveryMs(lastPaintMs) {
  // When the last write was already expensive, do not pile on extra full frames.
  return lastPaintMs >= OVERLOAD_MS ? 4000 : 2000;
}

function fullEveryFrames(lastPaintMs) {
  return lastPaintMs >= OVERLOAD_MS ? 20 : 36;
}

function createScreenPainter() {
  let prev = [];
  let prevRaw = [];
  let prevW = 0;
  let prevH = 0;
  let incremental = 0;
  let lastFullAt = 0;
  let lastPaintMs = 0;
  let sceneKey = '';

  function reset() {
    prev = [];
    prevRaw = [];
    prevW = 0;
    prevH = 0;
    incremental = 0;
    lastFullAt = 0;
    lastPaintMs = 0;
    sceneKey = '';
  }

  function isOverloaded(limitMs = OVERLOAD_MS) {
    return lastPaintMs >= limitMs;
  }

  function paint(lines, cols, rows, opts = {}) {
    const width = Math.max(1, cols);
    const height = Math.max(1, rows);
    const now = Date.now();
    const next = new Array(height);
    for (let y = 0; y < height; y += 1) next[y] = lines[y] || '';

    const sizeChanged = prevW !== width || prevH !== height;
    const sceneChanged = !!(opts.scene && opts.scene !== sceneKey);
    if (opts.scene) sceneKey = opts.scene;
    const dueTime = lastFullAt > 0 && (now - lastFullAt >= fullEveryMs(lastPaintMs));
    const dueFrames = incremental >= fullEveryFrames(lastPaintMs);
    let force = !!(opts.force || sizeChanged || sceneChanged || dueTime || dueFrames || prev.length === 0);

    let dirty = 0;
    if (!force) {
      for (let y = 0; y < height; y += 1) {
        if (next[y] !== prev[y]) dirty += 1;
      }
      if (dirty === 0) {
        lastPaintMs = 0;
        return '';
      }
      if (dirty > height * 0.6) force = true;
    }

    const t0 = process.hrtime.bigint();
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

    lastPaintMs = Number(process.hrtime.bigint() - t0) / 1e6;
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
    const sceneChanged = !!(opts.scene && opts.scene !== sceneKey);
    const forceWrap = !!(opts.force || sizeChanged || sceneChanged || prevRaw.length !== height);

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
    isOverloaded,
    lastPaintMs: () => lastPaintMs,
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
  OVERLOAD_MS,
};
