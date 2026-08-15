'use strict';

/**
 * GChat CLI landing page.
 *
 * Pure frame builder: given terminal dimensions and an animation frame
 * index, returns the styled lines plus where to draw them. No I/O here —
 * the screen/input loop lives in app.js, which keeps this unit-testable.
 *
 * The logo ships in three size tiers (large / medium / small); the largest
 * tier that fits the terminal width and height is chosen automatically.
 */

const ansi = require('./ansi');
const { PALETTE, DARK, runWithTheme } = require('./theme');

/** Display version for the landing page (intentionally separate from package version). */
const TUI_VERSION = '0.1 r27';
/** Shared duration for login→loading and loading→idle bird hops. */
const BIRD_FLIGHT_MS = 560;

/**
 * Single adjustable padding number (in cells), used for both:
 * - horizontal: gap between the logo and its captions
 * - vertical: breathing room above/below the logo block
 */
const LOGO_PADDING = 15;

/**
 * One bird shimmer for landing and the chat pane. Soft edges via shimmerHeat;
 * speed/width/period match the faded login sweep so every bird feels the same.
 */
const BAND_SPEED = 1.2;
const BAND_WIDTH = 32;
const BAND_PERIOD = 64;

const DEFAULT_SHIMMER = { speed: BAND_SPEED, width: BAND_WIDTH, period: BAND_PERIOD };
const BIRD_SHIMMER = DEFAULT_SHIMMER;

/** Frames for the idle → login form morph (~1s at 50ms/frame). */
const TRANSITION_FRAMES = 10;
/** How long a freshly typed password char stays visible before masking. */
const PASSWORD_MASK_MS = 1000;
/** Block caret shown at the insertion point of the active field. */
const FIELD_CARET = '█';
/** Letter color on the caret block (dark-theme default; live value is PALETTE.caretLetter). */
const CARET_LETTER = DARK.caretLetter;
/** Overflow indicator — the condensed triple dot. */
const ELLIPSIS = '…';
/** The label color reaches the final gray one frame before the morph ends. */
const FADE_FINISH_AT = (TRANSITION_FRAMES - 2) / TRANSITION_FRAMES;

/** Idle caption after the [x]; its tail becomes the username field. */
const LOGIN_LABEL = ' login via username';
const LOGIN_TAIL = 'username';

/** Fixed underline box width for both login fields (content overflows with …). */
const USERNAME_FIELD_WIDTH = 25;
const PASSWORD_FIELD_WIDTH = USERNAME_FIELD_WIDTH;

/** Pure UI state for the landing frame; app.js owns and mutates it. */
const DEFAULT_UI = {
  mode: 'idle', // 'idle' | 'transition' | 'login'
  modeFrame: 0, // frames since the transition started
  username: '',
  usernameCaret: 0, // insertion index within the username
  password: [], // [{ ch, at }] — at = epoch ms when the char was typed
  passwordCaret: 0, // insertion index within the password entries
  usernameScroll: 0, // lazy-scroll window start within the username
  passwordScroll: 0, // lazy-scroll window start within the password
  activeField: 'username', // 'username' | 'password'
  now: 0, // epoch ms used for password masking (set per draw)
  error: null, // { until, fields, message } — invalid-submit / login-failure feedback
  loggingIn: false, // a login request is in flight
  theme: 'dark',
};

/** Braille logo tiers, largest first. Caption keys are art row indexes. */
const LOGO_TIERS = [
  {
    name: 'large',
    captions: { 2: 'title', 4: 'option', 12: 'hint' },
    shimmer: BIRD_SHIMMER,
    art: [
      '⠈⣦⡀',
      '⠀⢀⠻⣿⣶⣄',
      '⠀⠀⠀⠈⢿⣿⣿⣿⣦⣀',
      '⠀⠀⠀⠀⠀⠉⢿⣿⣿⣿⣿⣿⣦⣄',
      '⠀⠀⠀⠀⠀⠀⠀⠈⠻⣿⣿⣿⣿⣿⣿⣿⣶⣤⣀',
      '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⠙⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣤⣀',
      '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠛⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣤⣀',
      '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣶⣤⡀',
      '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠛⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣾⣿⣷⡄',
      '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⣀⣈⣉⣙⣛⣛⣛⣛⣛⡿⠉⠁⠀⠈⠀⠈',
      '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⣴⣾⣿⣿⣿⣿⠿⠿⠛⠛⠉⠉⠀⢁',
      '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣶⣿⣿⠟⠋⠁⠀⠈',
      '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⣾⠟⠉',
      '⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠾⠉⢘',
      '⠀⠀⠀⠀⠀⠀⠀⠀⠐⠁',
    ],
  },
  {
    name: 'medium',
    captions: { 1: 'title', 3: 'option', 9: 'hint' },
    shimmer: BIRD_SHIMMER,
    art: [
      '⠉⣦⣀',
      '⠀⢀⠻⣿⣶⣤⡀',
      '⠀⠀⠀⠈⠻⣿⣿⣿⣶⣤⣈',
      '⠀⠀⠀⠀⠀⠀⠛⣿⣿⣿⣿⣿⣷⣦⣄',
      '⠀⠀⠀⠀⠀⠀⠀⠀⠉⠻⣿⣿⣿⣿⣿⣿⣿⣷⣶⣤⣀',
      '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣶⣤⣄',
      '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠻⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠿⣦',
      '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣤⣶⣶⣶⣶⣶⡶⠶⠒⠛⠉⢈',
      '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⣾⣿⠟⠋⠉⠸',
      '⠀⠀⠀⠀⠀⠀⠀⠀⣤⠿⠉',
      '⠀⠀⠀⠀⠀⠀⢀⠋⢀',
    ],
  },
  {
    name: 'small',
    captions: { 0: 'title', 2: 'option', 5: 'hint' },
    shimmer: BIRD_SHIMMER,
    art: [
      '⠉⣦⣀',
      '⠀⠀⠙⢿⣿⣦⣄⢀',
      '⠀⠀⠀⠀⠸⠛⣿⣿⣿⣿⣶⣤⣀⣀',
      '⠀⠀⠀⠀⠀⠀⠀⣀⣉⣿⣿⠿⠛⠉⠉',
      '⠀⠀⠀⠀⣠⠚⠉⢁',
      '⠀⠀⠀⠁',
    ],
  },
];

/** Neutral gray for field placeholders — the morph fades to this (no blue hues). */
const PLACEHOLDER_COLOR = DARK.placeholder;

/** How long the "Input invalid" hint flash lasts (ms). */
const ERROR_HINT_MS = 1000;
/** Hint flash toggle period (ms) — a quick on/off blink. */
const ERROR_FLASH_MS = 200;

/**
 * Lazy-scroll window position: the caret moves freely inside the window;
 * the window slides only when the caret would leave it, one cell at a time.
 * `at` is the caret index, `len` the text length (the end caret occupies a
 * virtual cell after the text). Resets to 0 once the text fits again.
 */
function clampScroll(scroll, at, len, width) {
  const displayLen = at >= len ? len + 1 : len;
  if (displayLen <= width) return 0;
  let s = Math.max(0, scroll);
  if (at < s) s = at;
  if (at > s + width - 1) s = at - (width - 1);
  return Math.max(0, s);
}

const CAPTIONS = {
  title: buildTitle,
  option: buildOption,
  hint: buildHint,
};

const MAX_CAPTION_WIDTH = Math.max(
  ...Object.values(CAPTIONS).map((build) => ansi.width(build())),
  ansi.width(buildLoginHint(1))
);

/**
 * Position of this cell inside the repeating shimmer period.
 * Diagonal: (row + col) grows along the diagonal; moving it sweeps a
 * diagonal band across the art.
 */
function shimmerPos(row, col, frame, shimmer = DEFAULT_SHIMMER) {
  const speed = Number(shimmer?.speed);
  const period = Number(shimmer?.period);
  return ((row + col - frame * speed) % period + period) % period;
}

/**
 * Soft heat in [0, 1] for this cell. 0 outside the band; 1 on the plateau;
 * a smoothstep fade on the leading and trailing edges so the stripe is not
 * a hard block.
 */
function shimmerHeat(row, col, frame, shimmer = DEFAULT_SHIMMER) {
  const width = Number(shimmer?.width);
  if (!(width > 0)) return 0;
  const pos = shimmerPos(row, col, frame, shimmer);
  if (pos >= width) return 0;
  const edge = Math.min(width / 2, Math.max(1, width * 0.35));
  const dist = Math.min(pos, width - pos);
  if (dist >= edge) return 1;
  const t = dist / edge;
  return t * t * (3 - 2 * t);
}

/** True when the cell is inside the shimmer band (including faded edges). */
function isHot(row, col, frame, shimmer = DEFAULT_SHIMMER) {
  return shimmerPos(row, col, frame, shimmer) < Number(shimmer?.width);
}

/** Style one art line at frame `frame` using the tier's shimmer params. */
function styleArtLine(artLine, row, frame, shimmer = DEFAULT_SHIMMER) {
  let out = '';
  let run = '';
  let runColor = null;
  let runBold = false;
  const flush = () => {
    if (!run) return;
    out += runBold
      ? `${ansi.fg(runColor)}${ansi.bold()}${run}${ansi.reset()}`
      : `${ansi.fg(runColor)}${run}${ansi.reset()}`;
    run = '';
  };
  const animate = shimmer !== false && shimmer != null;
  for (let col = 0; col < artLine.length; col += 1) {
    const ch = artLine[col];
    const heat = animate ? shimmerHeat(row, col, frame, shimmer) : 0;
    const color = heat > 0 ? lerpHex(PALETTE.artIdle, PALETTE.artHot, heat) : PALETTE.artIdle;
    const bold = heat >= 0.55;
    if (runColor !== null && (color !== runColor || bold !== runBold)) flush();
    runColor = color;
    runBold = bold;
    run += ch;
  }
  flush();
  return out;
}

/** Soft sweep used by Loading / confirm-delete (not the bird band). */
const TEXT_SHIMMER = { speed: 0.6, width: 4, period: 18 };

function pulseText(text, frame, hotColor, idleColor, shimmer = TEXT_SHIMMER) {
  let out = '';
  let run = '';
  let runColor = null;
  const flush = () => {
    if (!run) return;
    out += `${ansi.bold()}${ansi.fg(runColor)}${run}${ansi.reset()}`;
    run = '';
  };
  let i = 0;
  for (const ch of String(text || '')) {
    const heat = shimmerHeat(0, i, frame || 0, shimmer);
    const color = heat > 0 ? lerpHex(idleColor, hotColor, heat) : idleColor;
    if (runColor !== null && color !== runColor) flush();
    runColor = color;
    run += ch;
    i += 1;
  }
  flush();
  return out;
}

function buildTitle() {
  return `${ansi.bold()}${ansi.fg(PALETTE.title)}Welcome to GChat CLI ${TUI_VERSION}${ansi.reset()}`;
}

function buildCheck() {
  const bracket = `${ansi.fg(PALETTE.hint)}${ansi.dim()}`;
  const check = `${ansi.bold()}${ansi.fg(PALETTE.title)}`;
  const end = `${ansi.reset()}`;
  return `${bracket}[${end}${check}x${end}${bracket}]${end}`;
}

function buildOption() {
  return `${buildCheck()}${ansi.fg(PALETTE.label)}${LOGIN_LABEL}${ansi.reset()}`;
}

function buildHint() {
  return `${ansi.fg(PALETTE.hint)}${ansi.dim()}Press enter to continue${ansi.reset()}`;
}

function buildLoginHint(progress, ui = DEFAULT_UI) {
  if (progress < 0.5) return buildHint();
  if (ui.loggingIn) {
    return `${ansi.fg(PALETTE.hint)}${ansi.dim()}Logging in…${ansi.reset()}`;
  }
  if (ui.error && ui.now < ui.error.until) {
    // Flash the hint: alternates between dim and bright red.
    const flashOn = Math.floor(ui.now / ERROR_FLASH_MS) % 2 === 0;
    const dim = flashOn ? ansi.dim() : '';
    const message = (ui.error.message || 'Input invalid').slice(0, USERNAME_FIELD_WIDTH - 2)
      + ((ui.error.message || 'Input invalid').length > USERNAME_FIELD_WIDTH - 2 ? ELLIPSIS : '');
    return `${dim}${ansi.fg(PALETTE.error)}${message}${ansi.reset()}`;
  }
  return `${ansi.fg(PALETTE.hint)}${ansi.dim()}Press enter to login${ansi.reset()}`;
}

/** Linear → easing for the morph. */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** Morph progress 0..1 from ui.modeFrame (1 once the form is settled). */
function progress(ui) {
  if (ui.mode === 'login') return 1;
  return easeOutCubic(Math.min(1, ui.modeFrame / TRANSITION_FRAMES));
}

/** Linear (non-eased) morph progress 0..1 — used for the color fade. */
function linearProgress(ui) {
  return Math.min(1, ui.modeFrame / TRANSITION_FRAMES);
}

/** Interpolate two hex colors at t ∈ [0,1]. */
function lerpHex(a, b, t) {
  const [ar, ag, ab] = ansi.hexToRgb(a);
  const [br, bg, bb] = ansi.hexToRgb(b);
  const mix = (x, y) => Math.round(x + (y - x) * t);
  const hex = (v) => v.toString(16).padStart(2, '0');
  return `#${hex(mix(ar, br))}${hex(mix(ag, bg))}${hex(mix(ab, bb))}`;
}

/**
 * Password display: a char is visible only while it is the newest char AND
 * still fresh (typed within PASSWORD_MASK_MS); typing the next char hides it
 * immediately, and the newest char also masks after 1s.
 */
function maskPassword(entries, now) {
  return entries.map((e, i) => {
    const isNewest = i === entries.length - 1;
    return isNewest && now - e.at < PASSWORD_MASK_MS ? e.ch : '*';
  }).join('');
}

/**
 * Render a plain `box` (exactly `width` cells) with the underline applied
 * only to its first `barCells` cells — the underline bar animates in.
 */
function underlineBox(box, barCells, color, dimOn) {
  const dim = dimOn ? ansi.dim() : '';
  if (barCells <= 0) return `${dim}${ansi.fg(color)}${box}${ansi.reset()}`;
  let first = '';
  let rest = '';
  let used = 0;
  for (const ch of box) {
    if (used < barCells) {
      first += ch;
      used += 1;
    } else {
      rest += ch;
    }
  }
  if (!rest) return `${ansi.underline()}${dim}${ansi.fg(color)}${first}${ansi.reset()}`;
  return `${ansi.underline()}${dim}${ansi.fg(color)}${first}${ansi.reset()}${dim}${ansi.fg(color)}${rest}${ansi.reset()}`;
}

/**
 * Render a plain `box` string with the underline bar over the first
 * `barCells` cells. The cell at `caretCell` (when set) renders as the block
 * caret: a colored block with the letter visible beneath it.
 */
function renderBox(box, barCells, color, dimOn, caretCell = -1, blockCaret = false) {
  const dim = dimOn ? ansi.dim() : '';
  const base = `${dim}${ansi.fg(color)}`;
  let out = '';
  let i = 0;
  for (const ch of String(box || '')) {
    const underline = i < barCells ? ansi.underline() : '';
    if (i === caretCell) {
      if (blockCaret || ch === ' ' || ch === FIELD_CARET) {
        // Title-on-title █ is a solid cell. A dark █ on a near-canvas
        // foreground disappears on blank composer lines.
        out += `${underline}${ansi.bg(PALETTE.title)}${ansi.fg(PALETTE.title)}█${ansi.reset()}`;
      } else {
        out += `${underline}${ansi.bg(color)}${ansi.fg(PALETTE.caretLetter)}${ch}${ansi.reset()}`;
      }
    } else {
      out += underline + base + ch + ansi.reset();
    }
    i += 1;
  }
  return out;
}

/**
 * One form field: a fixed-width underlined box. Placeholder in dim neutral
 * gray, typed content in label color. The caret is a colored block over the
 * character at its index — the letter stays visible beneath it; at the end
 * of the text the block glyph is appended, and while empty it sits on the
 * placeholder's first letter. On overflow the window scrolls lazily: it
 * stays put while the caret moves inside it and slides one cell at a time
 * only when the caret leaves it.
 */
function buildField({ text, placeholder, active = false, width = 1, align = 'left', caret = 0, muted = false, bar = 1, scroll = 0, blankLine = false }) {
  const rawText = String(text || '');
  const has = rawText.length > 0;
  const emptyActive = !!(active && !has && blankLine);
  const shown = String(has || muted ? rawText : (emptyActive ? ' ' : (placeholder || '')));
  const chars = Array.from(shown);
  const len = chars.length;
  const color = has && !muted ? PALETTE.label : (emptyActive ? PALETTE.label : PALETTE.placeholder);
  const dimOn = !(has && !muted) && !emptyActive;
  const at = active
    ? Math.max(0, Math.min(ansi.codePointIndex(shown, caret), emptyActive ? len : (has ? len : 0)))
    : 0;

  let cells = chars.slice();
  let caretCell = -1; // code-point index of the block-caret cell, -1 when none

  if (active) {
    const atEnd = at >= len;
    const displayLen = atEnd ? len + 1 : len;
    if (displayLen <= width) {
      if (atEnd) cells.push(FIELD_CARET);
      else caretCell = at;
    } else {
      const s = clampScroll(scroll, at, len, width);
      const leftEll = s > 0;
      const rightEll = s + width < displayLen;
      const start = s + (leftEll ? 1 : 0);
      const end = s + width - (rightEll ? 1 : 0);
      const display = atEnd ? chars.concat([FIELD_CARET]) : chars;
      cells = [];
      if (leftEll) cells.push(ELLIPSIS);
      cells.push(...display.slice(start, end));
      if (rightEll) cells.push(ELLIPSIS);
      if (!atEnd) caretCell = at - s;
    }
  } else if (ansi.width(cells.join('')) > width) {
    const visible = Math.max(1, width - 1);
    let used = 0;
    const keep = [];
    for (const ch of cells) {
      const w = ansi.charWidth(ch);
      if (used + w > visible) break;
      keep.push(ch);
      used += w;
    }
    cells = keep.concat([ELLIPSIS]);
  }

  const content = cells.join('');
  const pad = ' '.repeat(Math.max(0, width - ansi.width(content)));
  const box = (align === 'right' ? pad : '') + content + (align === 'right' ? '' : pad);
  const barCells = Math.max(0, Math.min(width, Math.round(bar * width)));
  const caretShift = align === 'right' ? Array.from(pad).length : 0;
  return renderBox(box, barCells, color, dimOn, caretCell < 0 ? -1 : caretCell + caretShift, emptyActive);
}

/**
 * The label slides left (from after the [x] to the [x] spot, which the
 * username field replaces) and drops its "login via" prefix. The color
 * fades from label color to neutral placeholder gray (a pure brightness
 * fade, no blue hues), finishing by FADE_FINISH_AT of the morph so it
 * reaches the final gray while the label still settles. The underline bar
 * grows beneath it.
 */
function buildTransitionLabel(progress, linear) {
  const drop = Math.round(progress * (LOGIN_LABEL.length - LOGIN_TAIL.length));
  const shown = LOGIN_LABEL.slice(drop);
  const x = Math.round((1 - progress) * 4);
  const fadeT = Math.min(1, linear / FADE_FINISH_AT);
  const color = lerpHex(PALETTE.label, PALETTE.placeholder, fadeT);
  const box = (' '.repeat(x) + shown).padEnd(USERNAME_FIELD_WIDTH, ' ');
  const barCells = Math.max(0, Math.min(USERNAME_FIELD_WIDTH, Math.round(progress * USERNAME_FIELD_WIDTH)));
  return underlineBox(box, barCells, color, false);
}

/** Art row index whose caption key is `key` for the tier. */
function captionRow(tier, key) {
  return Number(Object.entries(tier.captions).find(([, value]) => value === key)[0]);
}

/** Option row: username field replaces the [x] (or the morphing label during the transition). */
function buildLoginOptionRow(styled, ui, captionX, p, linear) {
  const gap = Math.max(1, captionX - ansi.width(styled));
  if (ui.mode === 'transition') {
    return styled + ' '.repeat(gap) + buildTransitionLabel(p, linear);
  }
  const field = buildField({
    text: ui.username,
    placeholder: 'username',
    active: ui.activeField === 'username',
    width: USERNAME_FIELD_WIDTH,
    align: 'left',
    caret: ui.usernameCaret,
    scroll: ui.usernameScroll,
  });
  return styled + ' '.repeat(gap) + field;
}

/** Password row: beneath the username field, revealing 'password' 8 chars from the field start. */
function buildLoginPasswordRow(styled, ui, captionX, p) {
  const pad = Math.max(0, captionX - ansi.width(styled));
  if (ui.mode === 'transition') {
    const word = 'password';
    const revealed = Math.min(word.length, Math.ceil(p * word.length));
    const text = ' '.repeat(word.length - revealed) + word.slice(0, revealed);
    return styled + ' '.repeat(pad) + buildField({
      text,
      placeholder: 'password',
      active: false,
      width: PASSWORD_FIELD_WIDTH,
      muted: true,
      bar: p,
    });
  }
  const masked = maskPassword(ui.password, ui.now);
  return styled + ' '.repeat(pad) + buildField({
    text: masked,
    placeholder: 'password',
    active: ui.activeField === 'password',
    width: PASSWORD_FIELD_WIDTH,
    align: 'left',
    caret: ui.passwordCaret,
    scroll: ui.passwordScroll,
  });
}

function artWidth(tier) {
  return Math.max(...tier.art.map((line) => ansi.width(line)));
}

/** Frame width for a tier: logo + padding + widest caption. */
function tierWidth(tier) {
  return artWidth(tier) + LOGO_PADDING + MAX_CAPTION_WIDTH;
}

/** Frame height for a tier: logo rows + vertical padding. */
function tierHeight(tier) {
  return tier.art.length + LOGO_PADDING;
}

/**
 * Pick the largest logo tier that fits `cols` × `rows`; falls back to the
 * smallest tier when even it does not fit.
 */
function selectTier(cols, rows) {
  for (const tier of LOGO_TIERS) {
    if (tierWidth(tier) <= cols && tierHeight(tier) <= rows) return tier;
  }
  return LOGO_TIERS[LOGO_TIERS.length - 1];
}

/** Build the per-tier art/caption lines for one ui state. */
function buildTierLines(tier, frame, ui, captionX, optionRow, passwordRow, titleRow, hintRow, p, linear) {
  const lines = [];
  tier.art.forEach((artLine, row) => {
    const styled = styleArtLine(artLine, row, frame, tier.shimmer);
    const captionKey = tier.captions[row];
    const login = ui.mode !== 'idle';
    if (!login) {
      const caption = captionKey === undefined ? undefined : CAPTIONS[captionKey]();
      lines.push(caption === undefined
        ? styled
        : styled + ' '.repeat(Math.max(1, captionX - ansi.width(styled))) + caption);
      return;
    }
    if (row === optionRow) {
      lines.push(buildLoginOptionRow(styled, ui, captionX, p, linear));
    } else if (row === passwordRow) {
      lines.push(buildLoginPasswordRow(styled, ui, captionX, p));
    } else if (row === titleRow) {
      lines.push(styled + ' '.repeat(Math.max(1, captionX - ansi.width(styled))) + buildTitle());
    } else if (row === hintRow) {
      lines.push(styled + ' '.repeat(Math.max(1, captionX - ansi.width(styled))) + buildLoginHint(p, ui));
    } else {
      lines.push(styled);
    }
  });
  return lines;
}

/**
 * Build one landing frame.
 *
 * @param {number} cols terminal columns
 * @param {number} rows terminal rows
 * @param {number} frame animation frame index (0, 1, 2, …)
 * @param {object} [ui] interactive state (DEFAULT_UI when omitted)
 * @returns {{ lines: string[], originX: number, originY: number, width: number, height: number }}
 */
function sharedBirdY(rows, artH) {
  const height = Number(artH || 0) + LOGO_PADDING;
  const originY = Math.max(0, Math.floor((Math.max(1, rows) - height) / 2));
  return originY + Math.floor(LOGO_PADDING / 2);
}

function loginBirdOrigin(cols, rows) {
  const tier = selectTier(cols, rows);
  const w = tierWidth(tier);
  return {
    x: Math.max(0, Math.floor((Math.max(1, cols) - w) / 2)),
    y: sharedBirdY(rows, tier.art.length),
    artW: artWidth(tier),
    artH: tier.art.length,
  };
}

function buildLandingFrame(cols, rows, frame = 0, ui = DEFAULT_UI) {
  return runWithTheme(ui && ui.theme, () => buildLandingFrameNow(cols, rows, frame, ui));
}

function buildLandingFrameNow(cols, rows, frame, ui) {
  const tier = selectTier(cols, rows);
  const captionX = artWidth(tier) + LOGO_PADDING;
  const topPad = Math.floor(LOGO_PADDING / 2);
  const p = ui.mode === 'idle' ? 0 : progress(ui);
  const linear = ui.mode === 'idle' ? 0 : linearProgress(ui);
  const login = ui.mode !== 'idle';
  const optionRow = captionRow(tier, 'option');
  // Medium/large tiers get a blank gap row between the username and password fields.
  const passwordRow = optionRow + (tier.name === 'small' ? 1 : 2);
  const titleRow = captionRow(tier, 'title');
  const hintRow = captionRow(tier, 'hint');

  const artLines = buildTierLines(tier, frame, ui, captionX, optionRow, passwordRow, titleRow, hintRow, p, linear);
  // Pin the layout width to the settled login form in every mode so the
  // Enter transition (hint swap, sliding label, password reveal) and typing
  // never shift the centered content.
  const settled = buildTierLines(
    tier, frame, { ...DEFAULT_UI, mode: 'login' },
    captionX, optionRow, passwordRow, titleRow, hintRow, 1, 1
  );
  const width = Math.max(
    ...artLines.map((line) => ansi.width(line)),
    ...settled.map((line) => ansi.width(line))
  );
  const lines = [...Array(topPad).fill(''), ...artLines, ...Array(LOGO_PADDING - topPad).fill('')];

  const height = lines.length;
  const originX = Math.max(0, Math.floor((cols - width) / 2));
  const originY = Math.max(0, Math.floor((rows - height) / 2));

  const fieldBounds = login ? {
    username: { row: topPad + optionRow + originY, x: originX + captionX },
    password: { row: topPad + passwordRow + originY, x: originX + captionX },
  } : null;

  return { lines, originX, originY, width, height, fieldBounds };
}

module.exports = {
  TUI_VERSION,
  BIRD_FLIGHT_MS,
  LOGO_PADDING,
  LOGO_TIERS,
  TRANSITION_FRAMES,
  PASSWORD_MASK_MS,
  ERROR_HINT_MS,
  clampScroll,
  USERNAME_FIELD_WIDTH,
  PASSWORD_FIELD_WIDTH,
  DEFAULT_UI,
  ART: LOGO_TIERS[LOGO_TIERS.length - 1].art,
  ART_WIDTH: artWidth(LOGO_TIERS[LOGO_TIERS.length - 1]),
  TEXT_X: artWidth(LOGO_TIERS[LOGO_TIERS.length - 1]) + LOGO_PADDING,
  BAND_WIDTH,
  BAND_SPEED,
  BAND_PERIOD,
  BIRD_SHIMMER,
  DEFAULT_SHIMMER,
  TEXT_SHIMMER,
  isHot,
  shimmerHeat,
  lerpHex,
  pulseText,
  easeOutCubic,
  selectTier,
  styleArtLine,
  sharedBirdY,
  loginBirdOrigin,
  buildLandingFrame,
  buildField,
  renderBox,
  FIELD_CARET,
  CARET_LETTER,
  PLACEHOLDER_COLOR,
};
