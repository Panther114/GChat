'use strict';

/**
 * Minimal ANSI terminal primitives for the GChat TUI.
 * Zero dependencies, CommonJS, Node 18+ and Bun compatible.
 * Only what the TUI needs: cursor/screen control, 24-bit color,
 * text attributes, and a display-width helper (CJK/wide aware).
 */

const ESC = '\u001b[';

// ---------------------------------------------------------------------------
// Cursor & screen
// ---------------------------------------------------------------------------

/** Move cursor to 0-based column x, row y. */
function cursorTo(x = 0, y = 0) {
  return `${ESC}${Math.max(0, Math.floor(y)) + 1};${Math.max(0, Math.floor(x)) + 1}H`;
}

function cursorHide() {
  return `${ESC}?25l`;
}

function cursorShow() {
  return `${ESC}?25h`;
}

/** Clear current line (cursor position unaffected). */
function eraseLine() {
  return `${ESC}2K`;
}

/** Clear screen and scrollback, home cursor. */
function clearScreen() {
  return `${ESC}2J${ESC}3J${ESC}H`;
}

/** Switch to the alternate screen buffer (full-screen apps). */
function enterAltScreen() {
  return `${ESC}?1049h`;
}

/** Leave the alternate screen buffer. */
function exitAltScreen() {
  return `${ESC}?1049l`;
}

/**
 * Enable SGR mouse tracking: clicks (1000), any-motion/hover (1003),
 * and extended coordinates (1006). 1003 is what makes hover-highlight
 * possible — without it the terminal only reports button events.
 */
function mouseEnable() {
  return `${ESC}?1000h${ESC}?1003h${ESC}?1006h`;
}

/** Disable SGR mouse tracking (all modes we enable). */
function mouseDisable() {
  return `${ESC}?1000l${ESC}?1003l${ESC}?1006l`;
}

/** Enable bracketed paste so a pasted image path arrives as one chunk. */
function pasteEnable() {
  return `${ESC}?2004h`;
}

/** Disable bracketed paste. */
function pasteDisable() {
  return `${ESC}?2004l`;
}

/**
 * Parse one SGR mouse event (`ESC[<b;x;yM` press / `...m` release) into
 * 1-based terminal coordinates. Returns null for anything else.
 *
 * `kind`: 'press' | 'release' | 'move' | 'wheel'
 * `wheel`: -1 = up (older), +1 = down (newer), 0 = not a wheel event
 * `button`: 0 left, 1 middle, 2 right, 3 = no button (hover move)
 */
function parseSgrMouse(str) {
  const match = String(str).match(/^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (!match) return null;
  const raw = Number(match[1]);
  const press = match[4] === 'M';
  const isWheel = (raw & 64) === 64;
  const isMotion = (raw & 32) === 32 && !isWheel;
  let kind = 'press';
  if (isWheel) kind = 'wheel';
  else if (isMotion) kind = 'move';
  else if (!press) kind = 'release';
  const button = isWheel ? raw : (raw & 3);
  return {
    button,
    x: Number(match[2]),
    y: Number(match[3]),
    press,
    kind,
    motion: isMotion,
    wheel: isWheel ? ((raw & 1) ? 1 : -1) : 0,
  };
}

/** Ask xterm-family terminals to distinguish Shift+Enter from Enter. */
function modifyOtherKeysEnable() {
  return `${ESC}>4;2m`;
}

function modifyOtherKeysDisable() {
  return `${ESC}>4;0m`;
}

/**
 * Shift+Enter encodings when the terminal implements modifyOtherKeys or
 * Kitty CSI u. macOS Terminal.app does not: Shift+Enter is identical to
 * Enter (`\r`), so it cannot be used as a reliable newline shortcut there.
 */
function isShiftEnter(sequence) {
  const seq = String(sequence);
  return seq === '\u001b[13;2~'
    || seq === '\u001b[27;2;13~'
    || seq === '\u001b[13;2u'
    || seq === '\u001b[13;2;13~'
    || seq === '\u001b[13;2;13u';
}

/** Alt+Enter: ESC+CR/LF in raw mode, plus xterm/Kitty modified-key forms. */
function isAltEnter(sequence) {
  const seq = String(sequence);
  return seq === '\u001b\r'
    || seq === '\u001b\n'
    || seq === '\u001b[13;3~'
    || seq === '\u001b[27;3;13~'
    || seq === '\u001b[13;3u'
    || seq === '\u001b[13;3;13~';
}

/** Alt+Backspace: ESC+DEL/BS, plus xterm/Kitty modified-key forms. */
function isAltBackspace(sequence) {
  const seq = String(sequence);
  return seq === '\u001b\u007f'
    || seq === '\u001b\b'
    || seq === '\u001b[127;3u'
    || seq === '\u001b[27;3;127~'
    || seq === '\u001b[127;3~';
}

// ---------------------------------------------------------------------------
// Text attributes & 24-bit color
// ---------------------------------------------------------------------------

function sgr(code) {
  return `${ESC}${code}m`;
}

function bold(on = true) {
  return sgr(on ? 1 : 22);
}

function dim(on = true) {
  return sgr(on ? 2 : 22);
}

function italic(on = true) {
  return sgr(on ? 3 : 23);
}

function underline(on = true) {
  return sgr(on ? 4 : 24);
}

function blink(on = true) {
  return sgr(on ? 5 : 25);
}

function reverse(on = true) {
  return sgr(on ? 7 : 27);
}

function hidden(on = true) {
  return sgr(on ? 8 : 28);
}

function strikethrough(on = true) {
  return sgr(on ? 9 : 29);
}

function reset() {
  return sgr(0);
}

/** Parse '#rrggbb' (also accepts 'rgb' shorthand) to [r, g, b]. */
function hexToRgb(hex) {
  const raw = String(hex || '').replace(/^#/, '').trim();
  if (raw.length === 3) {
    return [0, 1, 2].map((i) => parseInt(raw[i] + raw[i], 16));
  }
  if (raw.length !== 6) return null;
  const value = parseInt(raw, 16);
  if (Number.isNaN(value)) return null;
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * Truecolor capability: macOS Terminal.app misparses `38;2;r;g;b` as
 * "unknown 38 → faint text" (every colored glyph renders dim). Only emit
 * 24-bit color when the terminal advertises it; otherwise fall back to
 * the xterm-256 palette, which Terminal.app renders correctly.
 */
function detectTruecolor() {
  const colorterm = String(process.env.COLORTERM || '').toLowerCase();
  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) return true;
  const term = String(process.env.TERM || '').toLowerCase();
  if (term.includes('truecolor') || term.includes('24bit')) return true;
  if (process.env.WT_SESSION) return true;
  const program = String(process.env.TERM_PROGRAM || '').toLowerCase();
  return [
    'iterm.app', 'wezterm', 'vscode', 'ghostty', 'alacritty',
    'kitty', 'hyper', 'warp', 'tabby', 'contour', 'mintty', 'konsole',
  ].includes(program);
}

const TRUE_COLOR = detectTruecolor();

function isAppleTerminal() {
  return String(process.env.TERM_PROGRAM || '').toLowerCase() === 'apple_terminal';
}

/** Map an rgb triplet to the nearest xterm-256 color index (0-255). */
function rgbTo256(r, g, b) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round((r - 8) / 10) + 232;
  }
  const cube = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * cube(r) + 6 * cube(g) + cube(b);
}

function truecolor(prefix, hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '';
  return sgr(`${prefix};2;${rgb[0]};${rgb[1]};${rgb[2]}`);
}

function color256(prefix, hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '';
  return sgr(`${prefix};5;${rgbTo256(rgb[0], rgb[1], rgb[2])}`);
}

/** Foreground color from a hex string, e.g. fg('#3fb950'). */
function fg(hex) {
  return TRUE_COLOR ? truecolor(38, hex) : color256(38, hex);
}

/** Background color from a hex string. */
function bg(hex) {
  return TRUE_COLOR ? truecolor(48, hex) : color256(48, hex);
}

// ---------------------------------------------------------------------------
// Display width (CJK / wide char aware)
// ---------------------------------------------------------------------------

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const CSI_RE = /\u001b\[[0-9;?]*[a-zA-Z]/;

/** Approximate wcwidth: 2 for common CJK/wide ranges, 1 otherwise. */
function charWidth(char) {
  const code = char.codePointAt(0);
  if (code === 0) return 0;
  if (CONTROL_RE.test(char)) return 0;
  if (code >= 0xfe00 && code <= 0xfe0f) return 0; // variation selectors (text/emoji)
  if (code >= 0x0300 && code <= 0x036f) return 0; // combining diacritics
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK Radicals..CJK Symbols
    (code >= 0x3041 && code <= 0x33ff) || // Hiragana..CJK Compat
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Ext A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
    (code >= 0xa000 && code <= 0xa4cf) || // Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compat Ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK Compat Forms
    (code >= 0xff00 && code <= 0xff60) || // Fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth signs
    (code >= 0x1f300 && code <= 0x1f64f) || // Misc symbols & pictographs
    (code >= 0x1f900 && code <= 0x1f9ff) || // Supplemental symbols
    (code >= 0x20000 && code <= 0x2fffd) || // CJK Ext B+
    (code >= 0x30000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Strip ANSI SGR/CSI sequences (and OSC title/bel sequences) from a string. */
function stripAnsi(str) {
  return String(str)
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, '');
}

/** Visible display width of a (possibly ANSI-styled) string. */
function width(str) {
  const plain = stripAnsi(str);
  let total = 0;
  for (const char of plain) total += charWidth(char);
  return total;
}

/** Convert a UTF-16 string index to a code-point index. */
function codePointIndex(str, utf16Index) {
  const raw = String(str || '');
  const at = Math.max(0, Math.min(utf16Index, raw.length));
  let n = 0;
  let i = 0;
  for (const ch of raw) {
    if (i >= at) break;
    i += ch.length;
    n += 1;
  }
  return n;
}

/** Move a UTF-16 index by one code point. Never lands inside a surrogate pair. */
function stepCodePoint(str, utf16Index, dir) {
  const raw = String(str || '');
  let i = Math.max(0, Math.min(utf16Index, raw.length));
  if (dir < 0) {
    if (i <= 0) return 0;
    const prev = raw.charCodeAt(i - 1);
    if (prev >= 0xdc00 && prev <= 0xdfff && i >= 2) {
      const hi = raw.charCodeAt(i - 2);
      if (hi >= 0xd800 && hi <= 0xdbff) return i - 2;
    }
    return i - 1;
  }
  if (i >= raw.length) return raw.length;
  const cur = raw.charCodeAt(i);
  if (cur >= 0xd800 && cur <= 0xdbff && i + 1 < raw.length) {
    const lo = raw.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return i + 2;
  }
  return i + 1;
}

/** Pad a string with spaces so its visible width reaches `cols` (min 1 space gap if non-empty and short). */
function padEnd(str, cols, gap = 1) {
  const current = width(str);
  const needed = Math.max(cols - current, str.length ? gap : 0);
  return str + ' '.repeat(needed);
}

/** Truncate a (possibly styled) string to at most `maxWidth` visible columns, keeping SGR styling. */
function truncate(str, maxWidth) {
  if (maxWidth <= 0) return '';
  if (width(str) <= maxWidth) return str;
  const tokens = String(str).split(/(\u001b\[[0-9;?]*[a-zA-Z])/g);
  let out = '';
  let used = 0;
  for (const token of tokens) {
    if (token === '') continue;
    if (CSI_RE.test(token)) {
      out += token;
      continue;
    }
    for (const char of token) {
      const w = charWidth(char);
      if (used + w > maxWidth) break;
      out += char;
      used += w;
    }
    if (used >= maxWidth) break;
  }
  return out + reset();
}

module.exports = {
  cursorTo,
  cursorHide,
  cursorShow,
  eraseLine,
  clearScreen,
  enterAltScreen,
  exitAltScreen,
  mouseEnable,
  mouseDisable,
  pasteEnable,
  pasteDisable,
  modifyOtherKeysEnable,
  modifyOtherKeysDisable,
  parseSgrMouse,
  isShiftEnter,
  isAltEnter,
  isAltBackspace,
  bold,
  dim,
  italic,
  underline,
  blink,
  reverse,
  hidden,
  strikethrough,
  reset,
  detectTruecolor,
  isAppleTerminal,
  rgbTo256,
  hexToRgb,
  fg,
  bg,
  charWidth,
  stripAnsi,
  width,
  codePointIndex,
  stepCodePoint,
  padEnd,
  truncate,
};
