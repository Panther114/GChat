'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ansi = require('../src/tui/ansi');
const landing = require('../src/tui/landing');
const app = require('../src/tui/app');
const theme = require('../src/tui/theme');

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
  assert.match(plain, /Welcome to GChat CLI 0\.1 r15/);
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
  // Moving +1 frame shifts the band along the diagonal by BAND_SPEED.
  assert.equal(landing.isHot(0, landing.BAND_SPEED, 1), landing.isHot(0, 0, 0));
});

test('shimmerHeat fades the band edges instead of a hard cut', () => {
  const stripe = chatLayout.GLIMMER;
  assert.equal(landing.shimmerHeat(0, 4, 0, stripe), 0, 'outside the band is idle');
  const edge = landing.shimmerHeat(0, 0.2, 0, stripe);
  const mid = landing.shimmerHeat(0, 2, 0, stripe);
  const far = landing.shimmerHeat(0, 3.7, 0, stripe);
  assert.ok(mid > edge, 'center is hotter than the leading edge');
  assert.ok(mid > far, 'center is hotter than the trailing edge');
  assert.ok(edge > 0 && edge < 1, 'leading edge is a partial fade');
  assert.ok(far > 0 && far < 1, 'trailing edge is a partial fade');
  assert.ok(mid > 0.9, 'the plateau stays near full heat');
});

test('composeFrame: writes full-width rows without eraseLine', () => {
  const out = app.composeFrame(80, 24, 0);
  assert.ok(!out.includes('\u001b[2K'), 'eraseLine is not used; rows overwrite in place');
  const segments = out.split(/\u001b\[\d+;\d+H/).filter((s) => s.length > 0);
  assert.ok(segments.length >= landing.ART.length, 'one segment per art line');
  const selected = landing.selectTier(80, 24);
  assert.ok(ansi.stripAnsi(out).includes(selected.art[0]), 'first art line present in composed output');
});

test('composeFrame: content is written on each line', () => {
  const out = app.composeFrame(80, 24, 0);
  const plain = ansi.stripAnsi(out.replace(/\u001b\[\d+;\d+H/g, ''));
  assert.match(plain, /Welcome to GChat CLI 0\.1 r15/);
  assert.match(plain, /\[x\] login via username/);
  assert.match(plain, /Press enter to continue/);
});

test('composeFrame: every row is painted with the dark canvas', () => {
  const out = app.composeFrame(80, 24, 0);
  const canvas = ansi.bg(theme.DARK.canvas);
  assert.ok(out.includes(canvas), 'dark canvas SGR is present');
  const segments = out.split(/\u001b\[\d+;\d+H/).slice(1);
  assert.equal(segments.length, 24, 'one write per terminal row');
  for (const segment of segments) {
    assert.ok(segment.includes(canvas), 'row sits on the canvas');
  }
});

test('screen painter writes only dirty rows and can force a full refresh', () => {
  const { createScreenPainter } = require('../src/tui/paint');
  const painter = createScreenPainter();
  const a = ['one', 'two', 'three'];
  const first = painter.paint(a, 8, 3, { force: true });
  assert.equal(first.split(/\u001b\[\d+;\d+H/).slice(1).length, 3);
  assert.equal(painter.paint(a, 8, 3), '', 'identical frame is a no-op');
  const changed = painter.paint(['one', 'TWO', 'three'], 8, 3);
  assert.ok(changed.includes('TWO'));
  assert.equal(changed.split(/\u001b\[\d+;\d+H/).slice(1).length, 1, 'only the dirty row is rewritten');
});

test('composeFrame: light theme uses the light canvas and dark art', () => {
  const out = app.composeFrame(80, 24, 0, testUi({ theme: 'light' }));
  assert.ok(out.includes(ansi.bg(theme.LIGHT.canvas)), 'light canvas is painted');
  assert.ok(out.includes(ansi.fg(theme.LIGHT.artIdle)), 'bird uses the light idle color');
  assert.ok(out.includes(ansi.fg(theme.LIGHT.title)), 'title uses the light palette');
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
  assert.deepEqual(ansi.parseSgrMouse('\u001b[<0;45;12M'), {
    button: 0, x: 45, y: 12, press: true, kind: 'press', motion: false, wheel: 0,
  });
  assert.deepEqual(ansi.parseSgrMouse('\u001b[<2;10;5m'), {
    button: 2, x: 10, y: 5, press: false, kind: 'release', motion: false, wheel: 0,
  });
  assert.equal(ansi.parseSgrMouse('\u001b[D'), null);
  assert.equal(ansi.parseSgrMouse('abc'), null);
  assert.equal(ansi.mouseEnable().includes('?1000h'), true);
  assert.equal(ansi.mouseEnable().includes('?1003h'), true, 'hover motion tracking enabled');
  assert.equal(ansi.mouseDisable().includes('?1000l'), true);
  assert.equal(ansi.mouseDisable().includes('?1003l'), true);
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

const chatLayout = require('../src/tui/chat-layout');

function chatState(over = {}) {
  return {
    ...chatLayout.DEFAULT_CHAT,
    userId: 'me',
    username: 'will',
    groups: [{ id: 'g1', name: 'team' }],
    activeGroupId: 'g1',
    channels: ['main', 'design'],
    activeChannel: 'main',
    messages: [
      {
        msg: {
          id: 'm1',
          senderId: 'ada',
          senderName: 'ada',
          type: 'text',
          createdAt: '2026-08-13T10:02:00.000Z',
        },
        text: 'ship it tonight',
        channel: 'main',
      },
      {
        msg: {
          id: 'm2',
          senderId: 'me',
          senderName: 'will',
          type: 'text',
          createdAt: '2026-08-13T10:03:00.000Z',
        },
        text: 'on it',
        channel: 'main',
      },
      {
        msg: {
          id: 'm3',
          senderId: 'ada',
          senderName: 'ada',
          type: 'image',
          createdAt: '2026-08-13T10:04:00.000Z',
        },
        text: null,
        channel: 'main',
        attach: { filename: 'photo.jpg', size: 240000, mimeType: 'image/jpeg' },
      },
    ],
    ...over,
  };
}

test('parseSgrMouse: hover motion and wheel', () => {
  const hover = ansi.parseSgrMouse('\u001b[<35;20;8M');
  assert.equal(hover.kind, 'move');
  assert.equal(hover.motion, true);
  assert.equal(hover.wheel, 0);
  const wheelUp = ansi.parseSgrMouse('\u001b[<64;20;8M');
  assert.equal(wheelUp.kind, 'wheel');
  assert.equal(wheelUp.wheel, -1);
  const wheelDown = ansi.parseSgrMouse('\u001b[<65;20;8M');
  assert.equal(wheelDown.kind, 'wheel');
  assert.equal(wheelDown.wheel, 1);
});

test('charWidth: variation selectors are zero-width', () => {
  assert.equal(ansi.charWidth('\uFE0E'), 0);
  assert.equal(ansi.width(`✎${chatLayout.TEXT}`), 1);
});

test('codePointIndex and stepCodePoint do not split emoji', () => {
  const text = 'hi👍!';
  assert.equal(ansi.codePointIndex(text, 0), 0);
  assert.equal(ansi.codePointIndex(text, 2), 2);
  assert.equal(ansi.codePointIndex(text, 4), 3);
  assert.equal(ansi.stepCodePoint(text, 2, 1), 4);
  assert.equal(ansi.stepCodePoint(text, 4, -1), 2);
});

test('chat frame: sidebar, channels, composer, and messages', () => {
  const frame = chatLayout.buildChatFrame(80, 24, chatState());
  const plain = frame.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(plain.includes('GChat CLI 0.1 r15'), 'sidebar title is the CLI version');
  assert.ok(!plain.includes('chats\n') && !/^\s*chats\s*$/m.test(plain.split('\n')[0]), 'old "chats" label is gone');
  assert.ok(plain.includes('team'), 'active group in sidebar');
  assert.ok(!plain.includes('●'), 'groups are not indented with a bullet');
  assert.ok(plain.includes('#main'), 'channel strip');
  assert.ok(plain.includes('#design'));
  assert.ok(plain.includes('ada'));
  assert.ok(plain.includes('ship it tonight'));
  assert.ok(plain.includes('on it'));
  assert.ok(plain.includes('[Image]'), 'image messages use the [Image] effect');
  assert.ok(plain.includes('message'), 'composer placeholder');
  assert.ok(plain.includes('╭') && plain.includes('╰'), 'composer is a rounded box');
  assert.ok(frame.hits.some((h) => h.type === 'create-channel'), '+ create channel chip');
  assert.ok(!plain.includes('team  #main'), 'group/channel status line is gone');
  assert.ok(frame.regions.sidebar.w > 0);
  assert.ok(frame.hits.some((h) => h.type === 'group'));
  assert.ok(frame.hits.some((h) => h.type === 'sidebar-empty'));
  assert.ok(frame.hits.some((h) => h.type === 'channel' && h.name === 'design'));
  assert.ok(frame.hits.some((h) => h.type === 'card' && h.id === 'm3'));
  assert.ok(frame.hits.some((h) => h.type === 'composer'));
  assert.ok(frame.hits.some((h) => h.type === 'scrollbar'));
});

test('chat hover outlines without fill and does not show input shortcuts', () => {
  const idle = chatLayout.buildChatFrame(80, 24, chatState());
  const idlePlain = idle.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(!idlePlain.includes('reply'), 'shortcuts hidden until select');

  const hovered = chatLayout.buildChatFrame(80, 24, chatState({ hoverMessageId: 'm2' }));
  const hoverPlain = hovered.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(!hoverPlain.includes('delete'), 'hover does not put delete on the input hint');
  assert.ok(hoverPlain.includes('╭') && hoverPlain.includes('╰'), 'hover uses a rounded outline');
  assert.ok(!hovered.lines.join('').includes(ansi.bg('#2d333b')), 'hover does not fill a background');

  const selected = chatLayout.buildChatFrame(80, 24, chatState({ selectedMessageId: 'm2' }));
  const selPlain = selected.lines.map((l) => ansi.stripAnsi(l));
  const hint = selPlain.find((l) => l.includes('reply') && l.includes('edit'));
  assert.ok(hint, 'selection shows reply/edit/delete/clear on the hint row');
  assert.ok(hint.includes('clear (esc)'));
  assert.ok(hint.includes('delete'));
  assert.ok(selected.lines.join('').includes(ansi.bg(chatLayout.PALETTE.selectedBg)), 'selected uses a raised background');
  assert.ok(selPlain.join('\n').includes('↩'), 'selected own message keeps icons on the right');
});

test('chat hover: action and card hits sit on the selected message', () => {
  const frame = chatLayout.buildChatFrame(80, 24, chatState({ selectedMessageId: 'm2' }));
  const reply = frame.hits.find((h) => h.type === 'action' && h.action === 'reply' && h.id === 'm2');
  const edit = frame.hits.find((h) => h.type === 'action' && h.action === 'edit' && h.id === 'm2');
  assert.ok(reply && edit, 'own message exposes reply + edit hits');
  assert.equal(chatLayout.hitTest(frame.hits, reply.x, reply.y).action, 'reply');

  const cardFrame = chatLayout.buildChatFrame(80, 24, chatState({ hoverMessageId: 'm3' }));
  const card = cardFrame.hits.find((h) => h.type === 'card' && h.id === 'm3');
  assert.ok(card, 'attachment card is clickable');
  assert.equal(chatLayout.hitTest(cardFrame.hits, card.x + 2, card.y).type, 'card');
});

test('chat frame: channel filter hides other channels', () => {
  const state = chatState({
    messages: [
      ...chatState().messages,
      {
        msg: { id: 'm4', senderId: 'ada', senderName: 'ada', type: 'text', createdAt: '2026-08-13T10:05:00.000Z' },
        text: 'design only',
        channel: 'design',
      },
    ],
    activeChannel: 'design',
  });
  const plain = chatLayout.buildChatFrame(80, 24, state).lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(plain.includes('design only'));
  assert.ok(!plain.includes('ship it tonight'));
});

test('wrapText wraps on word boundaries and hard-breaks long tokens', () => {
  assert.deepEqual(chatLayout.wrapText('hello world', 8), ['hello ', 'world']);
  const long = chatLayout.wrapText('abcdefghij', 4);
  assert.deepEqual(long, ['abcd', 'efgh', 'ij']);
});

test('formatBytes and formatTime are bounded and readable', () => {
  assert.equal(chatLayout.formatBytes(240000), '234 KB');
  assert.equal(chatLayout.formatBytes(800), '800 B');
  assert.match(chatLayout.formatTime('2026-08-13T10:03:00.000Z'), /^\d{2}:\d{2}$/);
});

test('chat reply preview keeps the ↩ symbol and the original sender', () => {
  const state = chatState({
    messages: [
      chatState().messages[0],
      {
        ...chatState().messages[1],
        replyTo: { id: 'm1', name: 'ada', preview: 'ship it tonight' },
      },
    ],
  });
  const frame = chatLayout.buildChatFrame(80, 24, state);
  const plain = frame.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(plain.includes('↩  ada: ship it tonight'));
  const ref = frame.hits.find((h) => h.type === 'reply-ref' && String(h.id) === 'm1');
  assert.ok(ref);
  assert.ok(ref.w < 30, 'reply hit is the text, not the whole message row');
});

test('reply preview only undims when the reply text itself is hovered', () => {
  const base = chatState({
    messages: [
      chatState().messages[0],
      {
        ...chatState().messages[1],
        replyTo: { id: 'm1', name: 'ada', preview: 'ship it tonight', color: '#79c0ff' },
      },
    ],
    hoverMessageId: 'm2',
  });
  const overMsg = chatLayout.buildChatFrame(80, 24, { ...base, hoverReply: false });
  const overReply = chatLayout.buildChatFrame(80, 24, { ...base, hoverReply: true });
  assert.notEqual(overMsg.lines.join(''), overReply.lines.join(''), 'hovering the quote restyles it');
  const ref = overReply.hits.find((h) => h.type === 'reply-ref');
  const body = overReply.hits.find((h) => h.type === 'message' && String(h.id) === 'm2');
  assert.ok(ref && body);
  assert.ok(ref.w < body.w, 'quote hit is narrower than the message row');
});

test('sending messages are grayed and labeled', () => {
  const state = chatState({
    animFrame: 0,
    messages: [{ ...chatState().messages[1], sending: true }],
  });
  const plain = chatLayout.buildChatFrame(80, 24, state).lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(plain.includes('sending'));
});

test('empty group selection paints a static bird and hides the composer', () => {
  const a = chatLayout.buildChatFrame(80, 24, chatState({ activeGroupId: null, animFrame: 0 }));
  const b = chatLayout.buildChatFrame(80, 24, chatState({ activeGroupId: null, animFrame: 9 }));
  const plain = a.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(!plain.includes('ship it tonight'), 'messages hidden when no group is selected');
  assert.ok(plain.includes('⠉') || plain.includes('⣦'), 'landing bird art is reused');
  assert.ok(!a.hits.some((h) => h.type === 'composer'), 'composer is hidden while idle');
  assert.equal(a.lines.join(''), b.lines.join(''), 'idle bird does not shimmer');
});

test('channel transition hides the transcript behind the bird', () => {
  const state = chatState({ transition: { until: Date.now() + 400, kind: 'channel' }, animFrame: 2 });
  const frame = chatLayout.buildChatFrame(80, 24, state);
  const plain = frame.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(plain.includes('#design'), 'channel strip still updates');
  assert.ok(!plain.includes('ship it tonight'), 'old transcript is not shown mid-switch');
  assert.ok(!frame.hits.some((h) => h.type === 'composer'), 'composer hides during a channel switch');
});

test('delete confirm flashes a red hint and paints the message red', () => {
  const frame = chatLayout.buildChatFrame(80, 24, chatState({
    selectedMessageId: 'm2',
    overlay: { type: 'delete', messageId: 'm2' },
    animFrame: 0,
  }));
  const plain = frame.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(plain.includes('confirm deletion? (enter)'));
  assert.ok(plain.includes('on it'));
  assert.ok(plain.includes('clear (esc)'));
  assert.ok(frame.lines.join('').includes(ansi.bg(chatLayout.PALETTE.deleteBg)), 'target message uses a red fill');
  assert.ok(!frame.hits.some((h) => h.type === 'confirm-delete'));
  assert.ok(frame.hits.some((h) => h.type === 'action' && h.action === 'clear'));
});

test('channel chips are three lines tall and include +', () => {
  const frame = chatLayout.buildChatFrame(80, 24, chatState({ hoverChannel: 'design' }));
  assert.equal(frame.regions.channels.h, 3);
  const create = frame.hits.find((h) => h.type === 'create-channel');
  assert.ok(create && create.h === 3);
  const ch = frame.hits.find((h) => h.type === 'channel' && h.name === 'design');
  assert.ok(ch && ch.h === 3);
});

test('hovered first and last messages keep their rounded caps', () => {
  const frame = chatLayout.buildChatFrame(80, 24, chatState({ hoverMessageId: 'm1' }));
  const plain = frame.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(plain.includes('╭') && plain.includes('╰'), 'top message outline is not clipped');
});

test('nameColor prefers senderColor and hashes otherwise', () => {
  assert.equal(chatLayout.nameColor({ msg: { senderColor: '#ff00aa', senderName: 'ada' } }), '#ff00aa');
  const a = chatLayout.hashNameColor('ada');
  const b = chatLayout.hashNameColor('ada');
  const c = chatLayout.hashNameColor('will');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(theme.DARK.nameColors.includes(a));
  const lightName = theme.runWithTheme('light', () => chatLayout.hashNameColor('ada'));
  assert.ok(theme.LIGHT.nameColors.includes(lightName));
});

test('WHEEL_LINES is a single line step', () => {
  assert.equal(chatLayout.WHEEL_LINES, 1);
});

test('sidebar groups are full-width rows with unread badges', () => {
  const frame = chatLayout.buildChatFrame(80, 24, chatState({
    groups: [{ id: 'g1', name: 'team', unreadCount: 3 }],
  }));
  const plain = frame.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(plain.includes('[3]'));
  const group = frame.hits.find((h) => h.type === 'group' && h.id === 'g1');
  assert.ok(group && group.h === 1);
  assert.equal(group.w, frame.regions.sidebar.w, 'group row spans the sidebar');
  const row = ansi.stripAnsi(frame.lines[group.y]).slice(0, group.w);
  assert.ok(row.includes('team'));
  assert.ok(!row.includes('╭') && !row.includes('╰') && !row.includes('│'), 'sidebar rows are not rounded chips');
});

test('expanded channel chip exposes delete only, never on #main', () => {
  const frame = chatLayout.buildChatFrame(80, 24, chatState({
    activeChannel: 'design',
    channelMenu: 'design',
  }));
  assert.ok(!frame.hits.some((h) => h.type === 'channel-action' && h.action === 'rename'));
  assert.ok(frame.hits.some((h) => h.type === 'channel-action' && h.action === 'delete'));
  const main = chatLayout.buildChatFrame(80, 24, chatState({
    activeChannel: 'main',
    channelMenu: 'main',
  }));
  assert.ok(!main.hits.some((h) => h.type === 'channel-action'));
});

test('clampScrollForMessage keeps a short message on screen', () => {
  const bounds = { start: 10, end: 13 };
  const clamped = chatLayout.clampScrollForMessage(80, bounds, 40, 20);
  const min = Math.min(40 - 20 - 10, 40 - 13);
  const max = Math.max(40 - 20 - 10, 40 - 13);
  assert.ok(clamped >= Math.max(0, min));
  assert.ok(clamped <= Math.max(0, max));
});

function sliceByWidth(styled, start, width) {
  const plain = ansi.stripAnsi(styled);
  let x = 0;
  let out = '';
  for (const ch of plain) {
    const cw = ansi.charWidth(ch);
    if (x >= start + width) break;
    if (x >= start) out += ch;
    x += cw;
  }
  return out;
}

function cellsHaveBg(styled, startPlain, selectedBg) {
  const bg = ansi.bg(selectedBg);
  const tokens = String(styled).split(/(\u001b\[[0-9;]*m)/);
  let on = false;
  let seen = false;
  let covered = 0;
  let total = 0;
  let buf = '';
  for (const token of tokens) {
    if (!token) continue;
    if (token.startsWith('\u001b[')) {
      if (token === '\u001b[0m') on = false;
      else if (token === bg || token.includes('48;')) on = token !== '\u001b[0m' && token.includes('48;');
      continue;
    }
    for (const ch of token) {
      buf += ch;
      if (!seen) {
        if (buf.includes(startPlain)) seen = true;
        continue;
      }
      total += 1;
      if (on) covered += 1;
    }
  }
  return { covered, total };
}

test('formatStamp puts time on the right and adds a date when it is not today', () => {
  const now = new Date('2026-08-13T20:00:00');
  assert.match(chatLayout.formatStamp('2026-08-13T10:02:00.000Z', now), /^\d{2}:\d{2}$/);
  assert.match(chatLayout.formatStamp('2026-08-12T10:03:00.000Z', now), /Aug 12 \d{2}:\d{2}/);
});

test('message timestamps sit on the name row; actions sit on the content row', () => {
  const now = new Date('2026-08-13T20:00:00');
  const frame = chatLayout.buildChatFrame(80, 24, chatState({
    selectedMessageId: 'm2',
    memberCount: 3,
    now,
    messages: [
      {
        msg: {
          id: 'm2',
          senderId: 'me',
          senderName: 'will',
          type: 'text',
          createdAt: '2026-08-12T10:03:00.000Z',
          readCount: 1,
          totalRecipients: 2,
        },
        text: 'on it',
        channel: 'main',
      },
    ],
  }));
  const nameRow = frame.lines.map((l) => ansi.stripAnsi(l)).find((l) => l.includes('will') && l.includes('Aug 12'));
  assert.ok(nameRow, 'date+time is on the name row');
  assert.ok(nameRow.indexOf('will') < nameRow.indexOf('Aug 12'), 'timestamp is to the right of the name');
  assert.ok(!nameRow.includes('↩'), 'action icons are not on the name row');
  const content = frame.lines.map((l) => ansi.stripAnsi(l)).find((l) => l.includes('on it'));
  assert.ok(content.includes('↩') && content.includes('×'), 'actions sit on the content row');
  assert.ok(content.includes('✓') || content.includes('·'), 'ticks sit on the content row');
});

test('actions pack to the right of the content; ticks sit on the far right', () => {
  const state = chatState({
    selectedMessageId: 'm2',
    memberCount: 4,
    messages: [
      {
        msg: {
          id: 'm2', senderId: 'me', senderName: 'will', type: 'text',
          createdAt: '2026-08-13T10:03:00.000Z', readCount: 1, totalRecipients: 3,
        },
        text: 'short',
        channel: 'main',
      },
      {
        msg: {
          id: 'm3', senderId: 'me', senderName: 'will', type: 'image',
          createdAt: '2026-08-13T10:04:00.000Z', readCount: 0, totalRecipients: 3,
        },
        text: null,
        channel: 'main',
        attach: { filename: 'photo.jpg', size: 1000, mimeType: 'image/jpeg' },
      },
    ],
  });
  const textFrame = chatLayout.buildChatFrame(80, 24, { ...state, selectedMessageId: 'm2', hoverMessageId: 'm2' });
  const imageFrame = chatLayout.buildChatFrame(80, 24, { ...state, selectedMessageId: 'm3', hoverMessageId: 'm3' });
  const reply = textFrame.hits.find((h) => h.type === 'action' && h.action === 'reply' && h.id === 'm2');
  const edit = textFrame.hits.find((h) => h.type === 'action' && h.action === 'edit' && h.id === 'm2');
  const del = textFrame.hits.find((h) => h.type === 'action' && h.action === 'delete' && h.id === 'm2');
  assert.ok(reply && edit && del);
  assert.equal(edit.x, reply.x + 3, 'packed actions have no missing slot in the middle');
  assert.equal(del.x, edit.x + 3);
  const row = textFrame.lines.map((l) => ansi.stripAnsi(l)).find((l) => l.includes('short') && l.includes('↩'));
  assert.ok(row.lastIndexOf('✓') > row.lastIndexOf('×'), 'ticks sit to the right of the tools');
  assert.match(row.replace(/[│\s]+$/, ''), /[✓·]\s*$/, 'ticks sit on the right edge of the message row');
  const imgReply = imageFrame.hits.find((h) => h.type === 'action' && h.action === 'reply' && h.id === 'm3');
  const imgPrev = imageFrame.hits.find((h) => h.type === 'action' && h.action === 'preview' && h.id === 'm3');
  assert.ok(imgReply && imgPrev);
  assert.equal(imgPrev.x, imgReply.x + 3);
});

test('selected image highlight continues after the sender name', () => {
  const frame = chatLayout.buildChatFrame(80, 24, chatState({
    selectedMessageId: 'm3',
    messages: [chatState().messages[2]],
  }));
  const row = frame.lines.find((l) => {
    const p = ansi.stripAnsi(l);
    return p.includes('ada') && !p.includes('[Image]');
  });
  assert.ok(row, 'image message still has a name row');
  const { covered, total } = cellsHaveBg(row, 'ada', chatLayout.PALETTE.selectedBg);
  assert.ok(total > 4, 'there is space after the name');
  assert.ok(covered > total * 0.7, `highlight covers the gap after the name (${covered}/${total})`);
});

test('composer hints sit on the right; typing stays on the left', () => {
  const selected = chatLayout.buildChatFrame(80, 24, chatState({
    selectedMessageId: 'm2',
    typing: { username: 'ada', until: Date.now() + 3000 },
  }));
  const hint = selected.lines.map((l) => ansi.stripAnsi(l)).find((l) => l.includes('reply') && l.includes('ada is typing'));
  assert.ok(hint, 'typing and action hints share the composer hint row');
  assert.ok(hint.indexOf('ada is typing') < hint.indexOf('reply'), 'typing is on the left');
  assert.ok(hint.trimEnd().endsWith('clear (esc)'), 'action hints are rightmost');

  const channel = chatLayout.buildChatFrame(80, 24, chatState({
    activeChannel: 'design',
    channelMenu: 'design',
  }));
  const channelHint = channel.lines.map((l) => ansi.stripAnsi(l)).find((l) => l.includes('delete') && l.includes('clear'));
  assert.ok(channelHint, 'selecting a channel shows delete/clear hints');
  assert.ok(!channelHint.includes('rename'));
  assert.ok(channelHint.trimEnd().endsWith('clear (esc)'));
  assert.ok(channelHint.indexOf('delete') > 40, 'channel hints are on the right');
});

test('create chip reads + Create and a draft chip has a cancel hit', () => {
  const idle = chatLayout.buildChatFrame(80, 24, chatState());
  assert.ok(idle.lines.map((l) => ansi.stripAnsi(l)).join('\n').includes('+ Create'));
  const creating = chatLayout.buildChatFrame(80, 24, chatState({
    creatingChannel: true,
    channelDraft: 'pics',
  }));
  const mid = ansi.stripAnsi(creating.lines[1]);
  assert.ok(mid.includes('#pics'));
  assert.ok(mid.includes('×'));
  assert.ok(creating.hits.some((h) => h.type === 'cancel-create'));
});

test('expanded channel chip top/mid/bot share one width', () => {
  const frame = chatLayout.buildChatFrame(80, 24, chatState({
    activeChannel: 'design',
    channelMenu: 'design',
    channelExpandFrame: chatLayout.CHANNEL_EXPAND_FRAMES,
  }));
  const hit = frame.hits.find((h) => h.type === 'channel' && h.name === 'design');
  assert.ok(hit);
  const localX = hit.x;
  const top = sliceByWidth(frame.lines[0], localX, hit.w);
  const mid = sliceByWidth(frame.lines[1], localX, hit.w);
  const bot = sliceByWidth(frame.lines[2], localX, hit.w);
  assert.equal(ansi.width(top), hit.w);
  assert.equal(ansi.width(mid), hit.w);
  assert.equal(ansi.width(bot), hit.w);
  assert.ok(mid.includes('#'));
  assert.ok(frame.hits.some((h) => h.type === 'channel-action' && h.action === 'delete'));
});

test('channel chip width interpolates while expanding', () => {
  const collapsed = chatLayout.buildChatFrame(80, 24, chatState({
    activeChannel: 'design',
    channelMenu: 'design',
    channelExpandFrame: 0,
  }));
  const mid = chatLayout.buildChatFrame(80, 24, chatState({
    activeChannel: 'design',
    channelMenu: 'design',
    channelExpandFrame: 4,
  }));
  const open = chatLayout.buildChatFrame(80, 24, chatState({
    activeChannel: 'design',
    channelMenu: 'design',
    channelExpandFrame: chatLayout.CHANNEL_EXPAND_FRAMES,
  }));
  const wOf = (frame) => frame.hits.find((h) => h.type === 'channel' && h.name === 'design').w;
  assert.ok(wOf(collapsed) < wOf(mid), 'chip grows during the expand animation');
  assert.ok(wOf(mid) <= wOf(open));
});

test('group load hides the channel bar behind the bird', () => {
  const frame = chatLayout.buildChatFrame(80, 24, chatState({
    loadingGroup: true,
    transition: { until: Date.now() + 400, kind: 'group' },
    channels: ['main', 'design', 'oldone'],
  }));
  const plain = frame.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(!plain.includes('#design'), 'old channels are not shown while a group loads');
  assert.ok(!plain.includes('+ Create'));
  assert.equal(frame.hits.filter((h) => h.type === 'channel' || h.type === 'create-channel').length, 0);
  assert.ok(chatLayout.hideChannelBar({ activeGroupId: 'g1', loadingGroup: true }));
});

test('isAltEnter and isShiftEnter recognize modified Enter encodings', () => {
  assert.equal(ansi.isAltEnter('\u001b\r'), true);
  assert.equal(ansi.isAltEnter('\u001b[13;3u'), true);
  assert.equal(ansi.isAltEnter('\u001b[A'), false);
  assert.equal(ansi.isShiftEnter('\u001b[13;2u'), true);
  assert.equal(ansi.isShiftEnter('\u001b[27;2;13~'), true);
  assert.equal(ansi.isAltBackspace('\u001b\u007f'), true);
});

const { createChatController } = require('../src/tui/chat');
const { configPaths } = require('../src/store/paths');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeController(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-tui-'));
  const chat = createChatController({
    client: {
      user: { id: 'me', username: 'will' },
      listGroups: async () => [{ id: 'g1', name: 'team' }],
      listMembers: async () => [{ id: 'me' }, { id: 'ada' }, { id: 'bob' }],
      openGroup: async () => ({ messages: [] }),
      connectSocket: async () => {},
      disconnectSocket: () => {},
      setActiveGroup: () => {},
      switchChannel: (_g, name) => name,
      markRead: () => {},
      getSecret: () => null,
      emitTyping: () => {},
      logout: async () => {},
    },
    paths: configPaths(dir),
    stdout: { write() {}, columns: 80, rows: 24 },
    getSize: () => ({ cols: 80, rows: 24 }),
  });
  Object.assign(chat.state, chatState(over));
  return chat;
}

test('chat frame paints the theme canvas and light selected fill', () => {
  const dark = chatLayout.buildChatFrame(80, 24, chatState({ selectedMessageId: 'm2' }));
  assert.ok(dark.lines.join('').includes(ansi.bg(theme.DARK.canvas)));
  assert.ok(dark.lines.join('').includes(ansi.bg(theme.DARK.selectedBg)));
  const composed = chatLayout.composeChatFrame(80, 24, chatState());
  const segments = composed.split(/\u001b\[\d+;\d+H/).slice(1);
  assert.equal(segments.length, 24);
  for (const segment of segments) {
    assert.ok(segment.includes(ansi.bg(theme.DARK.canvas)), 'composed chat row is on the canvas');
  }

  const light = chatLayout.buildChatFrame(80, 24, chatState({
    theme: 'light',
    selectedMessageId: 'm2',
  }));
  assert.ok(light.lines.join('').includes(ansi.bg(theme.LIGHT.canvas)));
  assert.ok(light.lines.join('').includes(ansi.bg(theme.LIGHT.selectedBg)));
  assert.ok(!light.lines.join('').includes(ansi.bg(theme.DARK.selectedBg)));
});

test('Theme button toggles the palette and persists it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-theme-tui-'));
  const paths = configPaths(dir);
  const chat = createChatController({
    client: {
      user: { id: 'me', username: 'will' },
      listGroups: async () => [{ id: 'g1', name: 'team' }],
      listMembers: async () => [{ id: 'me' }, { id: 'ada' }],
      openGroup: async () => ({ messages: [] }),
      connectSocket: async () => {},
      disconnectSocket: () => {},
      setActiveGroup: () => {},
      switchChannel: (_g, name) => name,
      markRead: () => {},
      getSecret: () => null,
      emitTyping: () => {},
      logout: async () => {},
    },
    paths,
    stdout: { write() {}, columns: 80, rows: 24 },
    getSize: () => ({ cols: 80, rows: 24 }),
  });
  Object.assign(chat.state, chatState({
    profileOpen: true,
    profileExpandFrame: chatLayout.PROFILE_FRAMES,
  }));
  const open = chat.draw();
  const hit = open.hits.find((h) => h.type === 'theme');
  assert.ok(hit);
  await chat.handleClick(hit);
  assert.equal(chat.state.theme, 'light');
  const { loadConfig } = require('../src/store/config');
  assert.equal(loadConfig(paths).theme, 'light');
  const light = chat.draw();
  assert.ok(light.lines.join('').includes(ansi.bg(theme.LIGHT.canvas)));
  await chat.handleClick(light.hits.find((h) => h.type === 'theme'));
  assert.equal(chat.state.theme, 'dark');
  assert.equal(loadConfig(paths).theme, 'dark');
});

test('clicking a selected message deselects it', async () => {
  const chat = makeController({ selectedMessageId: 'm2' });
  const frame = chat.draw();
  const hit = frame.hits.find((h) => h.type === 'message' && String(h.id) === 'm2');
  assert.ok(hit);
  await chat.handleClick(hit);
  assert.equal(chat.state.selectedMessageId, null);
});

test('up and down move the selection by a whole message', () => {
  const chat = makeController({ selectedMessageId: 'm2' });
  chat.moveSelection(-1);
  assert.equal(chat.state.selectedMessageId, 'm1');
  chat.moveSelection(1);
  assert.equal(chat.state.selectedMessageId, 'm2');
  chat.moveSelection(1);
  assert.equal(chat.state.selectedMessageId, 'm3');
});

test('Alt+Enter inserts a newline; Shift+Enter CSI is ignored', () => {
  const chat = makeController();
  chat.handleKey('h');
  chat.pushInput('\u001b\r');
  chat.handleKey('i');
  assert.equal(chat.state.composer, 'h\ni');
  chat.pushInput('\u001b[13;3u');
  assert.equal(chat.state.composer, 'h\ni\n');
  chat.pushInput('\u001b[13;2u');
  assert.equal(chat.state.composer, 'h\ni\n', 'Shift+Enter is not bound to newline');
});

test('Alt+Backspace deletes the current word', () => {
  const chat = makeController({ composer: 'hello world', composerCaret: 11 });
  chat.deleteWord();
  assert.equal(chat.state.composer, 'hello ');
  assert.equal(chat.state.composerCaret, 6);
  chat.pushInput('\u001b\u007f');
  assert.equal(chat.state.composer, '');
});

test('canceling an edit restores the previous composer draft', () => {
  const chat = makeController({ composer: 'draft', composerCaret: 5 });
  chat.beginEdit(chat.state.messages[1]);
  assert.equal(chat.state.composer, 'on it');
  chat.cancelComposeMode();
  assert.equal(chat.state.composer, 'draft');
  assert.equal(chat.state.composerCaret, 5);
  assert.equal(chat.state.editingId, null);
});

test('startup does not open the first group', async () => {
  const chat = makeController({ activeGroupId: null, groups: [{ id: 'g1', name: 'team' }] });
  chat.state.activeGroupId = 'g1';
  await chat.start();
  assert.equal(chat.state.activeGroupId, null);
  assert.ok(!chat.draw().hits.some((h) => h.type === 'composer'));
});

test('closing a channel chip retracts instead of snapping shut', () => {
  const open = chatLayout.buildChatFrame(80, 24, chatState({
    activeChannel: 'design',
    channelMenu: 'design',
    channelExpandFrame: chatLayout.CHANNEL_EXPAND_FRAMES,
  }));
  const mid = chatLayout.buildChatFrame(80, 24, chatState({
    activeChannel: 'design',
    channelMenu: 'design',
    channelClosing: true,
    channelExpandFrame: 3,
  }));
  const wOf = (frame) => frame.hits.find((h) => h.type === 'channel' && h.name === 'design').w;
  assert.ok(wOf(mid) < wOf(open), 'chip shrinks while retracting');
});

test('idle bird is uniformly dim; loading bird uses a hot stripe', () => {
  const idle = chatLayout.buildBirdLines(40, 12, 4, false).join('');
  const loading = chatLayout.buildBirdLines(40, 12, 4, true).join('');
  assert.ok(!idle.includes(ansi.bold()), 'idle bird has no bright stripe');
  assert.ok(loading.includes(ansi.bold()), 'loading bird has a bright stripe');
});

test('chat and landing birds share one shimmer', () => {
  for (const tier of landing.LOGO_TIERS) {
    assert.equal(tier.shimmer, landing.BIRD_SHIMMER);
  }
  assert.equal(landing.BIRD_SHIMMER.speed, 1.2);
  assert.equal(landing.BIRD_SHIMMER.width, landing.BAND_WIDTH);
  assert.equal(landing.BIRD_SHIMMER.period, 64);
});

test('older history is advertised with a flashing Loading more row', () => {
  const frame = chatLayout.buildChatFrame(80, 24, chatState({
    hasMoreHistory: true,
    loadingMore: true,
    animFrame: 2,
  }));
  const plain = frame.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(plain.includes('Loading more...'));
});

test('composer uses the login block caret', () => {
  const frame = chatLayout.buildChatFrame(80, 24, chatState({
    composer: 'hi',
    composerCaret: 2,
  }));
  const row = frame.lines.map((l) => ansi.stripAnsi(l)).find((l) => l.includes('hi█'));
  assert.ok(row, 'end caret is the login block glyph');
  const mid = chatLayout.buildChatFrame(80, 24, chatState({
    composer: 'hi',
    composerCaret: 1,
  }));
  assert.ok(mid.lines.join('').includes('\u001b[48'), 'mid-text caret is a colored block');
});

test('composer grows to six lines and blank extra lines do not repeat the placeholder', () => {
  assert.equal(chatLayout.COMPOSER_MAX_INNER, 6);
  const metrics = chatLayout.composerMetrics(
    chatState({ composer: '\n\n\n', composerCaret: 3 }),
    40
  );
  assert.ok(metrics.innerH >= 4);
  const frame = chatLayout.buildChatFrame(80, 24, chatState({
    composer: '\n\n\n',
    composerCaret: 3,
  }));
  const hits = frame.lines.map((l) => ansi.stripAnsi(l)).filter((l) => l.includes('message')).length;
  assert.equal(hits, 0, 'placeholder is not painted on blank typed lines');
  const empty = chatLayout.buildChatFrame(80, 24, chatState({ composer: '', composerCaret: 0 }));
  const placeholders = empty.lines.map((l) => ansi.stripAnsi(l)).filter((l) => /\bmessage\b/.test(l));
  assert.equal(placeholders.length, 1, 'empty composer shows the placeholder once');
});

test('delete confirm is enter/esc only and ignores other keys', () => {
  const chat = makeController({ selectedMessageId: 'm2' });
  chat.state.overlay = { type: 'delete', messageId: 'm2' };
  chat.handleKey('x');
  assert.equal(chat.state.overlay.type, 'delete');
  assert.equal(chat.state.composer, '');
  chat.handleKey('\u001b');
  assert.equal(chat.state.overlay, null);
});

test('clicking the scrollbar thumb starts a drag; clicking the track jumps', () => {
  const many = Array.from({ length: 18 }, (_, i) => ({
    msg: {
      id: `s${i}`,
      senderId: 'ada',
      senderName: 'ada',
      type: 'text',
      createdAt: `2026-08-13T11:${String(i).padStart(2, '0')}:00.000Z`,
    },
    text: `message body ${i} with enough words`,
    channel: 'main',
  }));
  const chat = makeController({ messages: many, scrollOffset: 4 });
  const frame = chat.draw();
  assert.ok(frame.maxScroll > 0, 'transcript can scroll');
  const bar = frame.regions.scrollbar;
  const thumb = frame.scrollbarThumb;
  assert.ok(thumb, 'a thumb is painted when the transcript overflows');
  const before = chat.state.scrollOffset;
  chat.handleMouse({
    kind: 'press', button: 0, x: thumb.x + 1, y: thumb.y + 1, press: true, motion: false, wheel: 0,
  });
  assert.equal(chat.state.scrollOffset, before, 'pressing the thumb does not teleport it');
  chat.handleMouse({
    kind: 'move', button: 0, x: thumb.x + 1, y: thumb.y + 6, press: true, motion: true, wheel: 0,
  });
  assert.notEqual(chat.state.scrollOffset, before, 'dragging the thumb moves the offset');

  const jumped = makeController({ messages: many, scrollOffset: 4 });
  const jumpFrame = jumped.draw();
  const jumpThumb = jumpFrame.scrollbarThumb;
  const trackY = jumpThumb.y > jumpFrame.regions.scrollbar.y
    ? jumpFrame.regions.scrollbar.y + 1
    : jumpThumb.y + jumpThumb.h + 1;
  assert.ok(trackY >= bar.y && trackY < bar.y + bar.h);
  assert.ok(trackY < jumpThumb.y || trackY >= jumpThumb.y + jumpThumb.h, 'click is on the track');
  jumped.handleMouse({
    kind: 'press', button: 0, x: bar.x + 1, y: trackY + 1, press: true, motion: false, wheel: 0,
  });
  assert.notEqual(jumped.state.scrollOffset, 4, 'clicking the track jumps the viewport');
  const afterJump = jumped.state.scrollOffset;
  const dragY = trackY + 1 + 6 < bar.y + bar.h ? trackY + 1 + 6 : Math.max(bar.y, trackY - 6);
  jumped.handleMouse({
    kind: 'move', button: 0, x: bar.x + 1, y: dragY, press: true, motion: true, wheel: 0,
  });
  assert.notEqual(jumped.state.scrollOffset, afterJump, 'unreleased move after a track jump keeps dragging');
});

test('scrollbar drag drops stale hover outlines', () => {
  const many = Array.from({ length: 18 }, (_, i) => ({
    msg: {
      id: `s${i}`,
      senderId: 'ada',
      senderName: 'ada',
      type: 'text',
      createdAt: `2026-08-13T11:${String(i).padStart(2, '0')}:00.000Z`,
    },
    text: `message body ${i} with enough words`,
    channel: 'main',
  }));
  const chat = makeController({ messages: many, scrollOffset: 4, hoverMessageId: 's3' });
  const frame = chat.draw();
  const thumb = frame.scrollbarThumb;
  assert.ok(thumb);
  chat.handleMouse({
    kind: 'press', button: 0, x: thumb.x + 1, y: thumb.y + 1, press: true, motion: false, wheel: 0,
  });
  assert.equal(chat.state.hoverMessageId, null, 'starting a scrollbar drag clears hover');
  chat.state.hoverMessageId = 's5';
  chat.handleMouse({
    kind: 'move', button: 0, x: thumb.x + 1, y: thumb.y + 4, press: true, motion: true, wheel: 0,
  });
  assert.equal(chat.state.hoverMessageId, null, 'drag motion does not restore hover');
});

test('scrollbar uses filled cells instead of box-drawing glyphs', () => {
  const many = Array.from({ length: 18 }, (_, i) => ({
    msg: {
      id: `s${i}`,
      senderId: 'ada',
      senderName: 'ada',
      type: 'text',
      createdAt: `2026-08-13T11:${String(i).padStart(2, '0')}:00.000Z`,
    },
    text: `message body ${i} with enough words`,
    channel: 'main',
  }));
  const frame = chatLayout.buildChatFrame(80, 24, chatState({ messages: many, scrollOffset: 4 }));
  const y = frame.regions.transcript.y;
  const row = frame.lines[y];
  const plain = ansi.stripAnsi(row);
  assert.equal(plain.slice(-1), ' ', 'bar cell is a space, not │ or █');
  assert.ok(
    row.includes(ansi.bg(theme.DARK.track)) || row.includes(ansi.bg(theme.DARK.thumb)),
    'bar is a background fill so Terminal.app has no row gaps'
  );
});

test('preview hint has no icon glyph', () => {
  const frame = chatLayout.buildChatFrame(80, 24, chatState({ selectedMessageId: 'm3' }));
  const hint = frame.lines.map((l) => ansi.stripAnsi(l)).find((l) => l.includes('preview'));
  assert.ok(hint);
  assert.ok(!hint.includes('▣'), 'preview hint is text only');
});

test('reply/edit/delete hide on other messages while composing those actions', () => {
  const busy = chatLayout.buildChatFrame(80, 24, chatState({
    selectedMessageId: 'm3',
    replyTo: { id: 'm1', name: 'ada', preview: 'ship' },
  }));
  assert.ok(!busy.hits.some((h) => h.type === 'action' && h.action === 'reply'));
  assert.ok(!busy.hits.some((h) => h.type === 'action' && h.action === 'delete'));
  assert.ok(busy.hits.some((h) => h.type === 'action' && h.action === 'preview' && String(h.id) === 'm3'));
});

test('sidebar profile name stays pinned with a thin rule and padded logout', () => {
  const pinnedY = chatLayout.profileNameRow(24);
  const idle = chatLayout.buildChatFrame(80, 24, chatState({
    activeGroupId: null,
    username: 'will',
    iconColor: '#79c0ff',
  }));
  const frame = chatLayout.buildChatFrame(80, 24, chatState({ username: 'will', iconColor: '#79c0ff' }));
  const idleName = idle.hits.filter((h) => h.type === 'profile').at(-1);
  const nameHit = frame.hits.filter((h) => h.type === 'profile').at(-1);
  assert.ok(nameHit && idleName);
  assert.equal(nameHit.y, pinnedY, 'name sits on the default input row');
  assert.equal(idleName.y, pinnedY, 'idle bird does not drop the name to the bottom');
  const sideW = frame.regions.sidebar.w;
  const nameRow = ansi.stripAnsi(frame.lines[nameHit.y]).slice(0, sideW);
  assert.ok(nameRow.includes('will'));
  assert.ok(!nameRow.includes('╭') && !nameRow.includes('╰'), 'profile is not a rounded group chip');
  const padRow = ansi.stripAnsi(frame.lines[nameHit.y - 1]).slice(0, sideW).trim();
  assert.equal(padRow, '', 'one blank line sits between the rule and the name');
  const ruleRow = frame.lines[nameHit.y - 2];
  assert.ok(ansi.stripAnsi(ruleRow).slice(0, sideW).includes('─'), 'rule is a thin separator');
  assert.ok(!ruleRow.includes(ansi.bg(chatLayout.PALETTE.rule)), 'rule is not a solid fill');

  const open = chatLayout.buildChatFrame(80, 24, chatState({
    username: 'will',
    profileOpen: true,
    profileExpandFrame: chatLayout.PROFILE_FRAMES,
  }));
  const openName = open.hits.filter((h) => h.type === 'profile').at(-1);
  const logout = open.hits.find((h) => h.type === 'logout');
  const openRuleY = open.hits.filter((h) => h.type === 'profile').map((h) => h.y).sort((a, b) => a - b)[0];
  assert.ok(logout);
  assert.equal(openName.y, pinnedY, 'name stays pinned when Log out opens');
  assert.equal(openRuleY, nameHit.y - 2 - chatLayout.PROFILE_LIFT, 'rule lifts three rows');
  assert.equal(logout.y, openRuleY + 2, 'Log out sits under a pad below the rule');
  assert.ok(logout.y < openName.y - 1, 'Log out has padding above the name');
  assert.ok(open.lines.map((l) => ansi.stripAnsi(l)).join('\n').includes('Log out'));
  const logoutRow = ansi.stripAnsi(open.lines[logout.y]).slice(0, sideW);
  assert.ok(logoutRow.startsWith(' '), 'Log out has horizontal padding');
  assert.ok(!logoutRow.includes('╭'), 'Log out is not a rounded box');

  const themeHit = open.hits.find((h) => h.type === 'theme');
  assert.ok(themeHit, 'Theme sits in the open profile menu');
  assert.equal(themeHit.y, logout.y + 1, 'Theme sits directly below Log out');
  assert.ok(themeHit.y < openName.y, 'Theme stays above the pinned name');
  const themeRow = ansi.stripAnsi(open.lines[themeHit.y]).slice(0, sideW);
  assert.ok(themeRow.includes('Theme'));
  assert.ok(themeRow.startsWith(' '), 'Theme has horizontal padding');
  assert.ok(!themeRow.includes('╭'), 'Theme is not a rounded box');
});

test('offsetToShowMessage keeps the target in view', () => {
  const bounds = { start: 10, end: 13 };
  const off = chatLayout.offsetToShowMessage(bounds, 40, 20);
  assert.ok(off >= 0 && off <= 20);
});

test('buildField and the composer keep emoji intact', () => {
  const field = landing.buildField({
    text: 'hi👍',
    placeholder: 'x',
    active: true,
    width: 12,
    caret: 2,
    bar: 0,
  });
  const plain = ansi.stripAnsi(field);
  assert.ok(plain.includes('👍'), 'emoji is not split into surrogate replacements');
  assert.ok(!plain.includes('\uFFFD'));

  const frame = chatLayout.buildChatFrame(80, 24, chatState({
    composer: 'ok 😀',
    composerCaret: 'ok 😀'.length,
    editingId: 'm2',
  }));
  const composed = frame.lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(composed.includes('😀'));
  assert.ok(!composed.includes('\uFFFD'));
});

test('beginEdit keeps emoji in the composer', () => {
  const chat = makeController();
  chat.state.messages[1].text = 'ok 👍';
  chat.beginEdit(chat.state.messages[1]);
  assert.equal(chat.state.composer, 'ok 👍');
  const drawn = chat.draw().lines.map((l) => ansi.stripAnsi(l)).join('\n');
  assert.ok(drawn.includes('👍'));
});
