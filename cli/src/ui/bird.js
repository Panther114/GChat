'use strict';

/**
 * The animated GChat bird for the home screen.
 *
 * The artwork is the real logo (an alpha mask), drawn two pixels per cell with
 * half-block characters. Colors flow along a gradient, a highlight sweeps
 * across now and then, the bird bobs gently, and stars twinkle around it.
 */

const ansi = require('../tui/ansi');
const MASK = require('./bird-mask');

const MASK_W = MASK[0].length;
const MASK_H = MASK.length;
const MARGIN = 5; // empty cells on each side, so the bird can fly in from the left

const STOPS = ['#4fd1ff', '#7c8cff', '#c77dff', '#ff6bd6', '#ffb454', '#4fd1ff'].map((hex) => ansi.hexToRgb(hex));
const STAR_GLYPHS = ['·', '✦', '˖', '∙', '✧'];

const alphaCache = new Map();

/** Box-filtered alpha (0..1) of the logo at exactly w x h pixels. */
function alphaGrid(w, h) {
  const key = `${w}x${h}`;
  const cached = alphaCache.get(key);
  if (cached) return cached;
  const grid = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const y0 = (y * MASK_H) / h;
    const y1 = ((y + 1) * MASK_H) / h;
    for (let x = 0; x < w; x += 1) {
      const x0 = (x * MASK_W) / w;
      const x1 = ((x + 1) * MASK_W) / w;
      let sum = 0;
      let weight = 0;
      for (let sy = Math.floor(y0); sy < Math.min(MASK_H, Math.ceil(y1)); sy += 1) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.min(MASK_W, Math.ceil(x1)); sx += 1) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          sum += (MASK[sy].charCodeAt(sx) - 48) * wy * wx;
          weight += wy * wx;
        }
      }
      grid[y * w + x] = weight > 0 ? Math.min(1, sum / weight / 9) : 0;
    }
  }
  alphaCache.set(key, grid);
  return grid;
}

function ramp(p) {
  const wrapped = ((p % 1) + 1) % 1;
  const scaled = wrapped * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const mix = (c, to, k) => [c[0] + (to[0] - c[0]) * k, c[1] + (to[1] - c[1]) * k, c[2] + (to[2] - c[2]) * k];

function sgr(prefix, rgb, truecolor) {
  const [r, g, b] = rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))));
  return truecolor ? `\u001b[${prefix};2;${r};${g};${b}m` : `\u001b[${prefix};5;${ansi.rgbTo256(r, g, b)}m`;
}

function hash(a, b, c) {
  let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  return h;
}

/** Cell size of the bird (without margins) for a given pixel width. */
function birdSize(width) {
  let h = Math.round((width * MASK_H) / MASK_W);
  if (h % 2) h += 1;
  return { width, height: h, rows: h / 2 };
}

/**
 * One animation frame.
 * @param {object} o
 * @param {number} o.width   bird width in cells
 * @param {number} o.t       seconds since the screen opened
 * @param {number} [o.enter] 0..1 fly-in progress (1 = settled)
 * @param {number} [o.burst] seconds since a click burst started (negative = none)
 * @returns {string[]} lines, each width + 2 * MARGIN cells wide
 */
function renderBird({ width, t = 0, enter = 1, burst = -1, truecolor = ansi.detectTruecolor(), dark = true }) {
  const { height, rows } = birdSize(width);
  const alpha = alphaGrid(width, height);
  const bg = dark ? [13, 17, 23] : [255, 255, 255];
  const white = dark ? [255, 255, 255] : [40, 40, 60];
  const ease = 1 - (1 - Math.min(1, Math.max(0, enter))) ** 3;
  const xShift = Math.round((1 - ease) * -width * 0.55);
  const bob = enter >= 1 ? Math.round(Math.sin(t * 1.7) * 0.7) : 0;
  const sweep = ((t * 0.32) % 2.4) - 0.7;
  const total = width + MARGIN * 2;
  const canvasRows = rows + 1; // one spare row for the bob
  const lines = [];

  const pixel = (x, y) => {
    const sx = x - MARGIN - xShift;
    const sy = y - 1 - bob; // 1px offset leaves room for the bob
    if (sx < 0 || sx >= width || sy < 0 || sy >= height) return null;
    const a = alpha[sy * width + sx] * ease;
    if (a < 0.2) return null;
    const diag = (sx / width + sy / height) / 2;
    let color = ramp(sx / width * 0.55 + sy / height * 0.45 - t * 0.1);
    const shine = Math.max(0, 1 - Math.abs(diag - sweep) / 0.09);
    if (shine > 0) color = mix(color, white, shine * 0.65);
    return a >= 0.75 ? color : mix(bg, color, a);
  };

  for (let r = 0; r < canvasRows; r += 1) {
    let line = '';
    for (let x = 0; x < total; x += 1) {
      const top = pixel(x, r * 2);
      const bottom = pixel(x, r * 2 + 1);
      if (top && bottom) line += `${sgr(38, top, truecolor)}${sgr(48, bottom, truecolor)}▀\u001b[0m`;
      else if (top) line += `${sgr(38, top, truecolor)}▀\u001b[0m`;
      else if (bottom) line += `${sgr(38, bottom, truecolor)}▄\u001b[0m`;
      else {
        let glyph = ' ';
        let tint = null;
        if (burst >= 0 && burst < 0.8) {
          const dx = x - total / 2;
          const dy = (r - canvasRows / 2) * 2;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (Math.abs(dist - burst * width * 1.1) < 1.4) {
            glyph = STAR_GLYPHS[(x + r) % STAR_GLYPHS.length];
            tint = ramp(dist / width + t);
          }
        }
        if (glyph === ' ' && enter >= 1 && hash(x, r, Math.floor(t * 2.5)) % 83 === 0) {
          glyph = STAR_GLYPHS[hash(r, x, 7) % STAR_GLYPHS.length];
          tint = ramp((x + r * 3) / 40 - t * 0.1);
        }
        line += tint ? `${sgr(38, mix(bg, tint, 0.75), truecolor)}${glyph}\u001b[0m` : glyph;
      }
    }
    lines.push(line);
  }
  return lines;
}

module.exports = { renderBird, birdSize, MARGIN, ramp };
