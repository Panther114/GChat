'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ansi = require('../src/tui/ansi');
const landing = require('../src/tui/landing');
const app = require('../src/tui/app');

test('width: braille is 1 cell, CJK is 2 cells, ANSI is stripped', () => {
  assert.equal(ansi.width('⠉⣦⣀'), 3);
  assert.equal(ansi.width('中文'), 4);
  assert.equal(ansi.width('a中b'), 4);
  assert.equal(ansi.width(`${ansi.fg('#3fb950')}x${ansi.reset()}`), 1);
});

test('stripAnsi removes SGR sequences', () => {
  const styled = `${ansi.bold()}${ansi.fg('#ffffff')}hi${ansi.reset()}`;
  assert.equal(ansi.stripAnsi(styled), 'hi');
  assert.equal(ansi.width(styled), 2);
});

test('hexToRgb parses 6 and 3 digit hex', () => {
  assert.deepEqual(ansi.hexToRgb('#3fb950'), [63, 185, 80]);
  assert.deepEqual(ansi.hexToRgb('fff'), [255, 255, 255]);
  assert.equal(ansi.hexToRgb('nope'), null);
});

test('truncate cuts by visible width without breaking styles', () => {
  const line = `${ansi.fg('#ffffff')}abcdef${ansi.reset()}`;
  assert.equal(ansi.stripAnsi(ansi.truncate(line, 3)), 'abc');
  assert.equal(ansi.stripAnsi(ansi.truncate(line, 99)), 'abcdef');
});

test('truncate preserves styling when it cuts', () => {
  const line = `${ansi.fg('#ffffff')}abcdef${ansi.reset()}`;
  const cut = ansi.truncate(line, 3);
  assert.equal(ansi.stripAnsi(cut), 'abc');
  assert.ok(cut.startsWith('\u001b['), 'styled prefix retained after cut');
  assert.equal(ansi.width(cut), 3);
  assert.equal(ansi.truncate(line, 0), '');
});

test('text effects emit standard SGR codes (italic, underline, strike, etc.)', () => {
  assert.equal(ansi.italic(), '\u001b[3m');
  assert.equal(ansi.italic(false), '\u001b[23m');
  assert.equal(ansi.underline(), '\u001b[4m');
  assert.equal(ansi.underline(false), '\u001b[24m');
  assert.equal(ansi.blink(), '\u001b[5m');
  assert.equal(ansi.blink(false), '\u001b[25m');
  assert.equal(ansi.reverse(), '\u001b[7m');
  assert.equal(ansi.reverse(false), '\u001b[27m');
  assert.equal(ansi.hidden(), '\u001b[8m');
  assert.equal(ansi.hidden(false), '\u001b[28m');
  assert.equal(ansi.strikethrough(), '\u001b[9m');
  assert.equal(ansi.strikethrough(false), '\u001b[29m');
});

test('rgbTo256 maps the gray ramp and the 6x6x6 color cube', () => {
  assert.equal(ansi.rgbTo256(255, 255, 255), 231);
  assert.equal(ansi.rgbTo256(0, 0, 0), 16);
  assert.equal(ansi.rgbTo256(128, 128, 128), 244);
  assert.equal(ansi.rgbTo256(0, 255, 0), 46);
});

function loadAnsi() {
  const key = require.resolve('../src/tui/ansi');
  delete require.cache[key];
  return require('../src/tui/ansi');
}

function testUi(over) {
  return {
    ...landing.DEFAULT_UI,
    ...over,
  };
}

test('fg/bg fall back to xterm-256 color when truecolor is not advertised', () => {
  const saved = { COLORTERM: process.env.COLORTERM, TERM_PROGRAM: process.env.TERM_PROGRAM };
  delete process.env.COLORTERM;
  delete process.env.TERM_PROGRAM;
  try {
    const fresh = loadAnsi();
    assert.equal(fresh.fg('#ffffff'), '\u001b[38;5;231m');
    assert.equal(fresh.bg('#000000'), '\u001b[48;5;16m');
    assert.equal(fresh.fg('#3fb950'), '\u001b[38;5;78m');
  } finally {
    if (saved.COLORTERM === undefined) delete process.env.COLORTERM;
    else process.env.COLORTERM = saved.COLORTERM;
    if (saved.TERM_PROGRAM === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = saved.TERM_PROGRAM;
  }
});

test('fg/bg use 24-bit truecolor when COLORTERM advertises it', () => {
  const saved = process.env.COLORTERM;
  process.env.COLORTERM = 'truecolor';
  try {
    const fresh = loadAnsi();
    assert.equal(fresh.fg('#3fb950'), '\u001b[38;2;63;185;80m');
    assert.equal(fresh.bg('#3fb950'), '\u001b[48;2;63;185;80m');
  } finally {
    if (saved === undefined) delete process.env.COLORTERM;
    else process.env.COLORTERM = saved;
  }
});

test('landing frame: contains title, option and hint with art glyphs intact', () => {
  const tier = landing.LOGO_TIERS[0];
  const frame = landing.buildLandingFrame(100, 30, 0);
  assert.equal(frame.height, tier.art.length + landing.LOGO_PADDING);
  assert.equal(frame.originX, Math.floor((100 - frame.width) / 2));
  const plain = frame.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.match(plain, /Welcome to GChat CLI v0\.1/);
  assert.match(plain, /\[x\] login via username/);
  assert.match(plain, /Press enter to continue/);
  // The braille glyphs themselves must be preserved exactly.
  for (const artLine of tier.art) {
    assert.ok(plain.includes(artLine), `art line missing: ${artLine}`);
  }
});

test('landing frame: auto-selects the largest tier that fits width and height', () => {
  assert.equal(landing.selectTier(200, 80).name, 'large', 'huge terminals get the largest tier');
  assert.equal(landing.selectTier(20, 10).name, 'small', 'falls back to small when nothing fits');
  // Selection must grow monotonically with available width (robust to LOGO_PADDING tweaks).
  // LOGO_TIERS is ordered largest-first, so a larger tier has a smaller index.
  const names = [];
  for (let cols = 20; cols <= 200; cols += 2) names.push(landing.selectTier(cols, 40).name);
  const indexes = names.map((name) => landing.LOGO_TIERS.findIndex((t) => t.name === name));
  for (let i = 1; i < indexes.length; i += 1) {
    assert.ok(indexes[i] <= indexes[i - 1], `tier grows with width: ${names.join(' -> ')}`);
  }
  // Whatever is selected, its composed frame must fit the terminal (except
  // the deliberate fallback, which draws small even when nothing fits).
  const fallback = landing.LOGO_TIERS[landing.LOGO_TIERS.length - 1];
  for (const [cols, rows] of [[100, 30], [80, 24], [60, 20], [50, 12], [200, 80]]) {
    const tier = landing.selectTier(cols, rows);
    const frame = landing.buildLandingFrame(cols, rows, 0);
    if (tier !== fallback) {
      assert.ok(frame.width <= cols && frame.height <= rows, `frame fits ${cols}x${rows}`);
    }
  }
});

test('landing frame: LOGO_PADDING adds horizontal gap and vertical breathing room', () => {
  const frame = landing.buildLandingFrame(100, 30, 0);
  const topPad = Math.floor(landing.LOGO_PADDING / 2);
  assert.equal(frame.lines[0], '', 'blank rows above the logo');
  assert.ok(ansi.stripAnsi(frame.lines[topPad]).includes(landing.LOGO_TIERS[0].art[0]), 'art starts after top padding');
  // Captions start at the tier's art width + LOGO_PADDING, not tighter.
  const captionRow = ansi.stripAnsi(frame.lines[topPad + 2]);
  const artMaxWidth = Math.max(...landing.LOGO_TIERS[0].art.map((l) => ansi.width(l)));
  assert.ok(captionRow.includes(landing.LOGO_TIERS[0].art[2]));
  assert.equal(
    captionRow.indexOf('Welcome'),
    artMaxWidth + landing.LOGO_PADDING,
    'horizontal gap equals LOGO_PADDING'
  );
});

test('landing frame: animation changes styling only, never the glyphs', () => {
  const a = landing.buildLandingFrame(100, 30, 0);
  const b = landing.buildLandingFrame(100, 30, 1);
  const plainA = a.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  const plainB = b.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.equal(plainA, plainB, 'glyph composition must not change between frames');
  assert.notEqual(a.lines.join(''), b.lines.join(''), 'styling should differ between frames');
});

test('landing frame: isHot sweeps a diagonal band', () => {
  assert.equal(landing.isHot(0, 0, 0), true);
  assert.equal(landing.isHot(0, landing.BAND_WIDTH, 0), false);
  // Moving +1 frame shifts the band along the diagonal.
  assert.equal(landing.isHot(1, 0, 1), landing.isHot(0, 0, 0));
});

test('composeFrame: eraseLine precedes content on every line (never after)', () => {
  const out = app.composeFrame(80, 24, 0);
  // Each cursorTo starts a line segment. A line must begin with eraseLine and
  // must NOT end with eraseLine — otherwise the content just written is wiped.
  const segments = out.split(/\u001b\[\d+;\d+H/).filter((s) => s.length > 0);
  assert.ok(segments.length >= landing.ART.length, 'one segment per art line');
  // First segment is the leading cursorHide prefix; the rest are per-line writes.
  for (const segment of segments.slice(1)) {
    assert.ok(segment.startsWith('\u001b[2K'), `line should start with eraseLine: ${JSON.stringify(segment.slice(0, 20))}`);
    // Blank padding lines are exactly (eraseLine) with no content; any other
    // line must not end with eraseLine (would blank the content just written).
    const content = segment.slice('\u001b[2K'.length);
    assert.ok(!content.endsWith('\u001b[2K'), 'line must not end with eraseLine (would blank content)');
  }
  // The art glyphs survive in the composed bytes (first line of the tier
  // that was selected for this terminal size).
  const selected = landing.selectTier(80, 24);
  assert.ok(ansi.stripAnsi(out).includes(selected.art[0]), 'first art line present in composed output');
});

test('composeFrame: content is written on each line after the erase', () => {
  const out = app.composeFrame(80, 24, 0);
  const plain = ansi.stripAnsi(out.replace(/\u001b\[\d+;\d+H/g, '').replace(/\u001b\[2K/g, ''));
  assert.match(plain, /Welcome to GChat CLI v0\.1/);
  assert.match(plain, /\[x\] login via username/);
  assert.match(plain, /Press enter to continue/);
});

test('redrawRequired: a geometry change forces a full clear before redraw', () => {
  assert.equal(app.redrawRequired(null, null, 80, 24), false, 'first draw needs no clear');
  assert.equal(app.redrawRequired(80, 24, 80, 24), false, 'same size: incremental redraw');
  assert.equal(app.redrawRequired(80, 24, 40, 24), true, 'width change clears');
  assert.equal(app.redrawRequired(80, 24, 80, 20), true, 'height change clears');
});

test('login transition: label slides/fades into the username field, password reveals below', () => {
  const plainOf = (ui) => landing.buildLandingFrame(100, 30, 0, ui).lines.map((l) => ansi.stripAnsi(l)).join('\n');

  const start = plainOf(testUi({ mode: 'transition', modeFrame: 0 }));
  assert.ok(start.includes('login via username'), 'label intact at transition start');
  assert.ok(start.includes('Press enter to continue'), 'old hint shown first');
  assert.ok(!start.includes('password'), 'password word not yet revealed');

  const half = landing.buildLandingFrame(
    100, 30, 0,
    testUi({ mode: 'transition', modeFrame: Math.floor(landing.TRANSITION_FRAMES / 2) })
  );
  const halfPlain = half.lines.map((l) => ansi.stripAnsi(l));
  const revealRow = halfPlain.find((l) => l.includes(' passwor'));
  assert.ok(revealRow, 'password reveals during the morph');
  // The reveal is anchored 8 chars from the field start, not at the box edge.
  const tier = landing.LOGO_TIERS[0];
  const captionX = Math.max(...tier.art.map((l) => ansi.width(l))) + landing.LOGO_PADDING;
  assert.equal(revealRow.indexOf('p'), captionX + 1, 'reveal starts 8 chars from the field start');

  const end = plainOf(testUi({ mode: 'transition', modeFrame: landing.TRANSITION_FRAMES }));
  assert.ok(!end.includes('login via'), 'label slid away by the end of the morph');
  assert.ok(end.includes('username'), 'username field in place');
  assert.ok(end.includes('password'), 'password word fully revealed');
  assert.ok(end.includes('Press enter to login'), 'hint swapped in');

  const login = plainOf(testUi({ mode: 'login' }));
  assert.ok(login.includes('Welcome to GChat CLI'), 'title stays during login');
  assert.ok(!login.includes('[x]'), '[x] replaced entirely by the username field');
  assert.ok(login.includes('sername') && login.includes('assword'), 'placeholders under their block carets');
  assert.ok(login.includes('Press enter to login'));
});

test('login morph: underline bars animate in instead of appearing instantly', () => {
  const frameOf = (mf) => landing.buildLandingFrame(
    100, 30, 0,
    testUi({ mode: 'transition', modeFrame: mf })
  );
  const rowOf = (f, field) => f.lines[f.fieldBounds[field].row - f.originY];

  const start = frameOf(0);
  assert.ok(!rowOf(start, 'username').includes('\u001b[4m'), 'username bar not shown at morph start');
  assert.ok(!rowOf(start, 'password').includes('\u001b[4m'), 'password bar not shown at morph start');

  const end = frameOf(landing.TRANSITION_FRAMES - 1);
  assert.ok(rowOf(end, 'username').includes('\u001b[4m'), 'username bar fully grown by the end');
  assert.ok(rowOf(end, 'password').includes('\u001b[4m'), 'password bar fully grown by the end');
});

test('login morph: frame width is pinned so content never shifts horizontally', () => {
  const widths = [0, 5, 10, 15, landing.TRANSITION_FRAMES].map((modeFrame) =>
    landing.buildLandingFrame(100, 30, 0, testUi({ mode: 'transition', modeFrame })).width
  );
  assert.ok(new Set(widths).size === 1, `width stable across morph: ${widths.join(',')}`);
});

test('login morph: the color fade completes before the label settles', () => {
  const frameOf = (mf) => landing.buildLandingFrame(100, 30, 0, testUi({ mode: 'transition', modeFrame: mf }));
  const colorOf = (f) => {
    const idx = f.lines.map((l) => ansi.stripAnsi(l)).findIndex((l) => l.includes('username') || l.includes('login via'));
    const matches = f.lines[idx].match(/\u001b\[38;(?:2;\d+;\d+;\d+|5;\d+)m/g);
    return matches[matches.length - 1];
  };
  const finishedAt = landing.TRANSITION_FRAMES - 2;
  assert.equal(colorOf(frameOf(finishedAt)), colorOf(frameOf(landing.TRANSITION_FRAMES - 1)),
    'fade reaches the final gray one frame before the morph ends');
  assert.notEqual(colorOf(frameOf(0)), colorOf(frameOf(finishedAt)), 'color still changes during the first half');
});

test('login mode: typing hides placeholders; password chars mask after 1s', () => {
  const now = 10_000;
  const ui = testUi({
    mode: 'login',
    username: 'alice',
    password: [
      { ch: 's', at: now - 2000 }, // older than 1s → masked
      { ch: 'e', at: now - 200 }, // newest & fresh → visible
    ],
    now,
  });
  const plain = landing.buildLandingFrame(100, 30, 0, ui).lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(plain.includes('alice'), 'username content shown');
  assert.ok(!plain.includes('username'), 'username placeholder gone once typing');
  assert.ok(plain.includes('*e'), 'previous char masked, newest char visible');
  assert.ok(!plain.includes('password'), 'password placeholder gone once typing');
});

test('login mode: a password char hides as soon as the next one is typed', () => {
  const now = 10_000;
  const ui = testUi({
    mode: 'login',
    password: [
      { ch: 's', at: now - 100 }, // fresh but NOT newest → hidden
      { ch: 'e', at: now - 50 }, // newest → visible
    ],
    now,
  });
  const lines = landing.buildLandingFrame(100, 30, 0, ui).lines.map((l) => ansi.stripAnsi(l));
  const passRow = lines.find((l) => l.includes('*e'));
  assert.ok(passRow, 'only the newest password char shows');
  assert.ok(!passRow.includes('se'), 'previous letter auto-hides when the next is typed');
});

test('parseSgrMouse: parses click events and rejects non-events', () => {
  assert.deepEqual(ansi.parseSgrMouse('\u001b[<0;45;12M'), { button: 0, x: 45, y: 12, press: true });
  assert.deepEqual(ansi.parseSgrMouse('\u001b[<2;10;5m'), { button: 2, x: 10, y: 5, press: false });
  assert.equal(ansi.parseSgrMouse('\u001b[D'), null);
  assert.equal(ansi.parseSgrMouse('abc'), null);
  assert.equal(ansi.mouseEnable().includes('?1000h'), true);
  assert.equal(ansi.mouseDisable().includes('?1000l'), true);
});

test('login mode: caret is a colored block with the letter visible beneath it', () => {
  const onUser = landing.buildLandingFrame(100, 30, 0, testUi({ mode: 'login', username: 'alice' }));
  const userPlain = onUser.lines.map((l) => ansi.stripAnsi(l));
  assert.ok(userPlain.some((l) => l.includes('alice')), 'letters stay visible — nothing hidden');
  const userRowIdx = userPlain.findIndex((l) => l.includes('alice'));
  assert.ok(onUser.lines[userRowIdx].includes('\u001b[48'), 'caret is a colored block (bg) with the letter visible');

  const mid = landing.buildLandingFrame(
    100, 30, 0,
    testUi({ mode: 'login', username: 'alice', usernameCaret: 2 })
  );
  const midPlain = mid.lines.map((l) => ansi.stripAnsi(l));
  assert.ok(midPlain.some((l) => l.includes('alice')), 'block caret mid-text keeps the letter visible');

  const atEnd = landing.buildLandingFrame(
    100, 30, 0,
    testUi({ mode: 'login', username: 'alice', usernameCaret: 5 })
  );
  const endPlain = atEnd.lines.map((l) => ansi.stripAnsi(l));
  assert.ok(endPlain.some((l) => l.includes('alice█')), 'block caret appends at the end of the text');

  const onPass = landing.buildLandingFrame(
    100, 30, 0,
    testUi({ mode: 'login', activeField: 'password', password: [{ ch: 'p', at: 0 }], now: 5000 })
  );
  const passPlain = onPass.lines.map((l) => ansi.stripAnsi(l));
  const caretRow = passPlain.findIndex((l) => l.endsWith('*' + ' '.repeat(landing.PASSWORD_FIELD_WIDTH - 1)));
  assert.ok(caretRow > -1, 'password caret sits on the first masked char');
  assert.ok(onPass.lines[caretRow].includes('\u001b[48'), 'password caret is the colored block');
});

test('login mode: empty active field keeps the placeholder unshifted', () => {
  const active = landing.buildLandingFrame(100, 30, 0, testUi({ mode: 'login' }));
  const activePlain = active.lines.map((l) => ansi.stripAnsi(l));
  assert.ok(
    activePlain.some((l) => l.endsWith('username' + ' '.repeat(landing.USERNAME_FIELD_WIDTH - 8))),
    'placeholder never shifts — the caret block sits on its first letter'
  );
  const userIdx = activePlain.findIndex((l) => l.includes('username'));
  assert.ok(active.lines[userIdx].includes('\u001b[48'), 'caret block on the first placeholder letter');

  const inactive = landing.buildLandingFrame(
    100, 30, 0,
    testUi({ mode: 'login', activeField: 'password' })
  );
  const inactivePlain = inactive.lines.map((l) => ansi.stripAnsi(l));
  const userRow = inactivePlain.find((l) => l.trimEnd().endsWith('username'));
  assert.ok(userRow, 'inactive placeholder starts at the box start');
});

test('login mode: field content overflows with a condensed ellipsis', () => {
  const long = 'x'.repeat(30);
  const ui = testUi({ mode: 'login', username: long });
  const frame = landing.buildLandingFrame(100, 30, 0, ui);
  const row = frame.lines.map((l) => ansi.stripAnsi(l)).find((l) => l.includes('x'));
  assert.ok(row.endsWith('…'), 'ellipsis on the overflow side');
  assert.ok(!row.includes(long), 'content truncated to the box');
  assert.ok(row.endsWith('x…'), 'visible tail + ellipsis');
});

test('clampScroll: the lazy window slides one cell at a time, never jumps', () => {
  const W = landing.USERNAME_FIELD_WIDTH;
  // Typing at the end: the window follows the caret, one cell per step.
  assert.equal(landing.clampScroll(0, 25, 25, W), 1);
  assert.equal(landing.clampScroll(1, 26, 26, W), 2);
  assert.equal(landing.clampScroll(6, 30, 30, W), 6, 'caret at the right edge: window pinned');
  // Navigating back: the window stays put while the caret is inside it.
  assert.equal(landing.clampScroll(6, 25, 30, W), 6, 'no scroll while the caret is inside the window');
  assert.equal(landing.clampScroll(6, 5, 30, W), 5, 'scrolls left only when the caret exits');
  assert.equal(landing.clampScroll(6, 0, 30, W), 0);
  // Shrinking text resets the window once it fits again.
  assert.equal(landing.clampScroll(6, 20, 20, W), 0, 'text fits again → no scroll');
  assert.equal(landing.clampScroll(6, 5, 10, W), 0);
});

test('login mode: lazy scrolling keeps the caret in focus while overflowing', () => {
  const long = 'x'.repeat(30);
  const atEnd = landing.buildLandingFrame(
    100, 30, 0,
    testUi({ mode: 'login', username: long, usernameCaret: long.length, usernameScroll: 6 })
  );
  const endRow = atEnd.lines.map((l) => ansi.stripAnsi(l)).find((l) => l.includes('…'));
  assert.ok(endRow.indexOf('…') < endRow.indexOf('x'), 'at the end: ellipsis on the left');
  assert.ok(endRow.endsWith('x█'), 'block caret at the right edge');

  // Mid-text with a scrolled window: the caret keeps its window position —
  // no jump to the center when scrolling back.
  const mid = landing.buildLandingFrame(
    100, 30, 0,
    testUi({ mode: 'login', username: long, usernameCaret: 15, usernameScroll: 2 })
  );
  const midRaw = mid.lines;
  const midPlain = midRaw.map((l) => ansi.stripAnsi(l));
  const midIdx = midPlain.findIndex((l) => l.includes('…'));
  assert.ok(midRaw[midIdx].includes('\u001b[48'), 'caret block rendered in the window');
  const bgAt = midRaw[midIdx].indexOf('\u001b[48');
  const caretCol = ansi.width(ansi.stripAnsi(midRaw[midIdx].slice(0, bgAt)));
  const tier = landing.LOGO_TIERS[0];
  const captionX = Math.max(...tier.art.map((l) => ansi.width(l))) + landing.LOGO_PADDING;
  assert.equal(caretCol, captionX + 13, 'caret stays at its window position (at - scroll)');

  const atStart = landing.buildLandingFrame(
    100, 30, 0,
    testUi({ mode: 'login', username: long, usernameCaret: 0 })
  );
  const startRow = atStart.lines.map((l) => ansi.stripAnsi(l)).find((l) => l.includes('…'));
  assert.ok(startRow.endsWith('x…'), 'caret at the head: ellipsis on the right');
  assert.ok(startRow.includes('…'), 'block caret visible at the head');
});

test('login mode: hint shows "Logging in…" while the login request is in flight', () => {
  const f = landing.buildLandingFrame(100, 30, 0, testUi({ mode: 'login', loggingIn: true }));
  const plain = f.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(plain.includes('Logging in…'), 'hint indicates the login request');
  assert.ok(!plain.includes('Press enter to login'), 'submit hint hidden while logging in');
});

test('login mode: hint surfaces the backend error message', () => {
  const now = 10_000;
  const ui = testUi({
    mode: 'login',
    error: { until: now + landing.ERROR_HINT_MS, fields: [], message: "Couldn't connect" },
    now,
  });
  const f = landing.buildLandingFrame(100, 30, 0, ui);
  const lines = f.lines.map((l) => ansi.stripAnsi(l));
  const plain = lines.join('\n');
  assert.ok(plain.includes("Couldn't connect"), 'network failure message shown');
  const hintIdx = lines.findIndex((l) => l.includes("Couldn't connect"));
  assert.ok(f.lines[hintIdx].includes('\u001b[38;2;248;81;73m') || f.lines[hintIdx].includes('\u001b[38;5;209m'),
    'error message is red');
  // Long protocol messages are truncated to the pinned hint budget.
  const longMsg = 'Too many failed login attempts. Please try again later.';
  const longUi = { ...ui, error: { until: now + landing.ERROR_HINT_MS, fields: [], message: longMsg } };
  const longF = landing.buildLandingFrame(100, 30, 0, longUi);
  const longRow = longF.lines.map((l) => ansi.stripAnsi(l)).find((l) => l.includes('…'));
  assert.ok(longRow && !longRow.includes(longMsg), 'long messages truncate with an ellipsis');
});

test('login mode: invalid submit flashes the hint, fields stay normal', () => {
  const now = 10_000; // Math.floor(now/200) is even → flash phase ON (dim)
  const ui = testUi({
    mode: 'login',
    error: { until: now + landing.ERROR_HINT_MS, fields: ['username', 'password'] },
    now,
  });
  const f = landing.buildLandingFrame(100, 30, 0, ui);
  const lines = f.lines.map((l) => ansi.stripAnsi(l));
  const plain = lines.join('\n');
  assert.ok(plain.includes('Input invalid'), 'hint becomes "Input invalid"');
  const hintIdx = lines.findIndex((l) => l.includes('Input invalid'));
  assert.ok(f.lines[hintIdx].includes('\u001b[2m'), 'hint dims on the flash phase');
  const errorColor = (row) => row.includes('\u001b[38;2;248;81;73m') || row.includes('\u001b[38;5;209m');
  const userIdx = lines.findIndex((l) => l.includes('username'));
  assert.ok(!errorColor(f.lines[userIdx]), 'fields do NOT flash on error');

  // Flash OFF phase: the hint goes bright red, still present.
  const off = landing.buildLandingFrame(100, 30, 0, { ...ui, now: now + 200 });
  const offLines = off.lines.map((l) => ansi.stripAnsi(l));
  const offHintIdx = offLines.findIndex((l) => l.includes('Input invalid'));
  assert.ok(!off.lines[offHintIdx].includes('\u001b[2m'), 'hint flashes bright on the off phase');
  assert.ok(errorColor(off.lines[offHintIdx]), 'hint stays red while flashing');

  // Expired: hint back to normal.
  const expired = landing.buildLandingFrame(100, 30, 0, { ...ui, now: now + landing.ERROR_HINT_MS });
  const expiredPlain = expired.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(expiredPlain.includes('Press enter to login'), 'hint reverts after the error window');
  assert.ok(!expiredPlain.includes('Input invalid'), 'invalid hint gone after expiry');
});

test('login mode: fieldBounds maps fields to screen coordinates for clicks', () => {
  const ui = testUi({ mode: 'login' });
  const idle = landing.buildLandingFrame(100, 30, 0);
  const frame = landing.buildLandingFrame(100, 30, 0, ui);
  assert.equal(idle.fieldBounds, null, 'no bounds while idle');
  assert.ok(frame.fieldBounds, 'bounds present once logged in');
  // Large tier: a gap row sits between the username and password fields.
  assert.equal(
    frame.fieldBounds.password.row - frame.fieldBounds.username.row,
    2,
    'password sits one gap row under username (large tier)'
  );
  const tierArtWidth = Math.max(...landing.LOGO_TIERS[0].art.map((l) => ansi.width(l)));
  assert.equal(frame.fieldBounds.username.x, frame.originX + tierArtWidth + landing.LOGO_PADDING);
  assert.equal(frame.lines[frame.fieldBounds.username.row - frame.originY].includes('\u001b[4m'), true);
});

test('login mode: small tier has no gap, medium/large have a gap row between fields', () => {
  const gapOf = (cols, rows) => {
    const frame = landing.buildLandingFrame(cols, rows, 0, testUi({ mode: 'login' }));
    return frame.fieldBounds.password.row - frame.fieldBounds.username.row;
  };
  // Force each tier: use sizes where only one tier fits, then check its gap.
  assert.equal(gapOf(200, 80), 2, 'large tier gap');
  const mediumFrame = landing.buildLandingFrame(80, 40, 0, testUi({ mode: 'login' }));
  const mediumGap = mediumFrame.fieldBounds.password.row - mediumFrame.fieldBounds.username.row;
  assert.ok(mediumGap === 2, `medium tier gap (was ${mediumGap})`);
  const smallFrame = landing.buildLandingFrame(50, 16, 0, testUi({ mode: 'login' }));
  const smallGap = smallFrame.fieldBounds.password.row - smallFrame.fieldBounds.username.row;
  assert.ok(smallGap === 1, `small tier gap (was ${smallGap})`);
});

test('composeFrame: login ui passes through to the frame', () => {
  const out = app.composeFrame(80, 24, 0, testUi({ mode: 'login', username: 'bob', usernameCaret: 3 }));
  const plain = ansi.stripAnsi(out);
  assert.ok(plain.includes('bob█'));
  assert.ok(plain.includes('Press enter to login'));
});
