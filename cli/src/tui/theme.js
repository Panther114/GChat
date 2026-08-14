'use strict';

/**
 * TUI color themes.
 *
 * The CLI is a full-screen alt-buffer app. Every cell is painted with a
 * canvas background so light terminal profiles cannot leak through the
 * designed palettes. Detecting the terminal background is unreliable
 * (especially macOS Terminal.app); an explicit dark/light switch is the
 * source of truth.
 */

const ansi = require('./ansi');

const DARK = Object.freeze({
  canvas: '#0d1117',
  title: '#ffffff',
  text: '#e6edf3',
  label: '#e6edf3',
  muted: '#6e7681',
  hint: '#6e7681',
  hoverFg: '#e6edf3',
  outline: '#6e7681',
  outlineStrong: '#8b93a0',
  selectedBg: '#2a3139',
  deleteBg: '#4a1518',
  deletePulse: '#7a2d2d',
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
  caretLetter: '#161b22',
  artIdle: '#8b93a0',
  artHot: '#ffffff',
  logoutHot: '#ff7b72',
  theme: '#79c0ff',
  themeHot: '#a5d6ff',
  nameColors: Object.freeze([
    '#79c0ff', '#d2a8ff', '#7ee787', '#ffa657',
    '#ff7b72', '#a5d6ff', '#f778ba', '#e3b341',
  ]),
});

const LIGHT = Object.freeze({
  canvas: '#ffffff',
  title: '#1f2328',
  text: '#1f2328',
  label: '#1f2328',
  muted: '#656d76',
  hint: '#656d76',
  hoverFg: '#1f2328',
  outline: '#8c959f',
  outlineStrong: '#656d76',
  selectedBg: '#eaeef2',
  deleteBg: '#ffebe9',
  deletePulse: '#a40e26',
  channelHover: '#424a53',
  composerOutline: '#d0d7de',
  image: '#9a6700',
  action: '#1f2328',
  activeBg: '#eaeef2',
  border: '#d0d7de',
  rule: '#d0d7de',
  card: '#656d76',
  error: '#cf222e',
  placeholder: '#8c959f',
  sending: '#656d76',
  reply: '#656d76',
  keyR: '#0969da',
  keyE: '#8250df',
  keyD: '#cf222e',
  keyP: '#1a7f37',
  track: '#d0d7de',
  thumb: '#8c959f',
  faint: '#afb8c1',
  caretLetter: '#ffffff',
  artIdle: '#d0d7de',
  artHot: '#1f2328',
  logoutHot: '#a40e26',
  theme: '#0969da',
  themeHot: '#218bff',
  nameColors: Object.freeze([
    '#0969da', '#8250df', '#1a7f37', '#9a6700',
    '#cf222e', '#218bff', '#bf3989', '#7d4e00',
  ]),
});

const stack = [];

function normalizeTheme(theme) {
  return String(theme || '').trim().toLowerCase() === 'light' ? 'light' : 'dark';
}

function nextTheme(theme) {
  return normalizeTheme(theme) === 'light' ? 'dark' : 'light';
}

function getPalette(theme) {
  return normalizeTheme(theme) === 'light' ? LIGHT : DARK;
}

function currentTheme() {
  return stack.length ? stack[stack.length - 1] : 'dark';
}

/** Run `fn` with PALETTE bound to `theme`. Painting is sync, so the stack is safe. */
function runWithTheme(theme, fn) {
  stack.push(normalizeTheme(theme));
  try {
    return fn();
  } finally {
    stack.pop();
  }
}

const PALETTE = new Proxy({}, {
  get(_target, prop) {
    if (prop === 'then') return undefined;
    return getPalette(currentTheme())[prop];
  },
});

function withBg(text, bg) {
  if (!bg) return `${text}${ansi.reset()}`;
  const reset = ansi.reset();
  const bgOn = ansi.bg(bg);
  return `${bgOn}${String(text).split(reset).join(reset + bgOn)}${reset}`;
}

/**
 * Paint one terminal row: optional `originX` leading spaces, then `text`,
 * then trailing spaces, all sitting on `canvas`. Re-applies canvas after
 * every SGR reset so holes cannot show the terminal profile.
 */
function paintCanvasLine(text, width, originX = 0, canvas) {
  const cols = Math.max(0, width);
  if (cols <= 0) return '';
  const fill = canvas || PALETTE.canvas;
  const left = ' '.repeat(Math.max(0, originX));
  const body = text || '';
  const used = Math.max(0, originX) + ansi.width(body);
  const right = ' '.repeat(Math.max(0, cols - used));
  return withBg(ansi.truncate(`${left}${body}${right}`, cols), fill);
}

module.exports = {
  DARK,
  LIGHT,
  PALETTE,
  normalizeTheme,
  nextTheme,
  getPalette,
  currentTheme,
  runWithTheme,
  withBg,
  paintCanvasLine,
};
