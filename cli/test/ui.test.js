'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const ansi = require('../src/tui/ansi');
const { createKeyParser } = require('../src/ui/keys');
const { Editor } = require('../src/ui/editor');
const { LiveScreen, layoutText, wrapText } = require('../src/ui/screen');
const fmt = require('../src/ui/format');
const image = require('../src/ui/image');
const { matchCommands, findCommand } = require('../src/ui/commands');
const { App } = require('../src/ui/app');
const { configPaths } = require('../src/store/paths');
const { savePrefs } = require('../src/store/prefs');
const cryptoV2 = require('../src/crypto-v2');
const { encryptTextEnvelope } = require('../src/client/messages');

const plain = (s) => ansi.stripAnsi(s);

// ── keys ────────────────────────────────────────────────────────────────────

function parse(input) {
  const keys = [];
  const pastes = [];
  const focus = [];
  const feed = createKeyParser({ onKey: (k) => keys.push(k), onPaste: (t) => pastes.push(t), onFocus: (f) => focus.push(f) });
  feed(input);
  return { keys, pastes, focus };
}

test('key parser: printable, enter, backspace, arrows and ctrl letters', () => {
  const { keys } = parse('a\r\u007f\u001b[A\u001b[1;5D\u0003\u001bOB');
  assert.deepEqual(keys.map((k) => k.name), ['char', 'enter', 'backspace', 'up', 'left', 'ctrl', 'down']);
  assert.equal(keys[4].ctrl, true);
  assert.equal(keys[5].ch, 'c');
});

test('key parser: alt+enter, shift+enter (CSI u) and a lone escape', () => {
  const { keys } = parse('\u001b\r\u001b[13;2u\u001b');
  assert.equal(keys[0].name, 'enter');
  assert.equal(keys[0].alt, true);
  assert.equal(keys[1].shift, true);
  assert.equal(keys[2].name, 'escape');
});

test('key parser: bracketed paste is delivered whole, even across chunks', () => {
  const pastes = [];
  const keys = [];
  const feed = createKeyParser({ onKey: (k) => keys.push(k), onPaste: (t) => pastes.push(t) });
  feed('\u001b[200~line one\nline');
  feed(' two\u001b[201~x');
  assert.deepEqual(pastes, ['line one\nline two']);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].ch, 'x');
});

test('key parser: focus reports and astral characters', () => {
  const { keys, focus } = parse('\u001b[I\u001b[O\u{1F600}');
  assert.deepEqual(focus, [true, false]);
  assert.equal(keys[0].ch, '\u{1F600}');
});

test('key parser: an escape sequence split across chunks is reassembled', () => {
  const keys = [];
  const feed = createKeyParser({ onKey: (k) => keys.push(k) });
  feed('\u001b[');
  feed('B');
  assert.deepEqual(keys.map((k) => k.name), ['down']);
});

// ── editor ──────────────────────────────────────────────────────────────────

test('editor: insert, caret movement, word delete and kill', () => {
  const ed = new Editor();
  ed.insert('hello big world');
  ed.deleteWordBack();
  assert.equal(ed.text, 'hello big ');
  ed.home();
  ed.insert('>> ');
  assert.equal(ed.text, '>> hello big ');
  ed.killToEnd();
  assert.equal(ed.text, '>> ');
  ed.killToStart();
  assert.equal(ed.text, '');
});

test('editor: multi-line navigation and history', () => {
  const ed = new Editor({ history: ['first', 'second'] });
  ed.insert('ab\ncd');
  assert.equal(ed.moveLine(-1), true);
  assert.equal(ed.caret, 2);
  assert.equal(ed.moveLine(-1), false);
  const single = new Editor({ history: ['first', 'second'] });
  single.arrow(-1);
  assert.equal(single.text, 'second');
  single.arrow(-1);
  assert.equal(single.text, 'first');
  single.arrow(1);
  single.arrow(1);
  assert.equal(single.text, '');
});

test('editor: surrogate pairs are deleted as one character', () => {
  const ed = new Editor();
  ed.insert('a\u{1F600}');
  ed.backspace();
  assert.equal(ed.text, 'a');
});

test('editor: submit records history, skips masked input', () => {
  const ed = new Editor();
  ed.insert('hi');
  assert.equal(ed.submit(), 'hi');
  assert.deepEqual(ed.history, ['hi']);
  const secret = new Editor({ mask: true });
  secret.insert('hunter2');
  secret.submit();
  assert.deepEqual(secret.history, []);
});

test('layoutText wraps by display width and keeps the caret inside', () => {
  const laid = layoutText('hello world', 5, 11);
  assert.deepEqual(laid.lines, ['hello', ' worl', 'd']);
  assert.deepEqual(laid.caret, { row: 2, col: 1 });
  assert.deepEqual(layoutText('漢字漢', 4, 2).caret, { row: 1, col: 0 });
  assert.deepEqual(layoutText('ab\ncd', 10, 3).caret, { row: 1, col: 0 });
});

test('wrapText never exceeds the width and splits oversized words', () => {
  for (const line of wrapText('a short sentence with averyveryverylongwordinsideit', 12)) {
    assert.ok(ansi.width(line) <= 12, `"${line}" is too wide`);
  }
});

// ── screen ──────────────────────────────────────────────────────────────────

function fakeStdout(cols = 40, rows = 20) {
  const out = new EventEmitter();
  out.columns = cols;
  out.rows = rows;
  out.writes = [];
  out.write = (data) => { out.writes.push(String(data)); return true; };
  return out;
}

test('LiveScreen erases exactly the previous live region before repainting', () => {
  const out = fakeStdout();
  const screen = new LiveScreen({ stdout: out });
  screen.render(['one', 'two', 'three'], { row: 1, col: 2 });
  out.writes.length = 0;
  screen.render(['x'], null);
  const seq = out.writes.join('');
  assert.ok(seq.includes('\r\u001b[1A\u001b[J'), 'moves up one row (caret was on the second line) then clears below');
  assert.ok(plain(seq).includes('x'));
});

test('LiveScreen commit writes lines above the live region and repaints it', () => {
  const out = fakeStdout();
  const screen = new LiveScreen({ stdout: out });
  screen.render(['live'], { row: 0, col: 0 });
  out.writes.length = 0;
  screen.commit(['committed']);
  const seq = out.writes.join('');
  assert.ok(seq.indexOf('committed') < seq.lastIndexOf('live'));
});

test('LiveScreen accounts for lines that re-wrap after a resize', () => {
  const out = fakeStdout(40);
  const screen = new LiveScreen({ stdout: out });
  screen.render(['x'.repeat(40), 'y'.repeat(30)], { row: 1, col: 0 });
  out.columns = 20;
  out.writes.length = 0;
  screen.render(['z'], null);
  assert.ok(out.writes.join('').includes('\u001b[2A'), 'first line now takes two rows');
});

// ── format ──────────────────────────────────────────────────────────────────

test('box lines are exactly the requested width', () => {
  const lines = fmt.box(['hello', 'a longer line that will be clipped to fit inside the box'], 30, { title: 'Title' });
  for (const line of lines) assert.equal(ansi.width(line), 30);
});

test('messageLines folds consecutive messages from one sender under one header', () => {
  const base = { senderId: 'u2', senderName: 'bob', createdAt: new Date().toISOString() };
  const first = { msg: { ...base, id: '1' }, text: 'one' };
  const second = { msg: { ...base, id: '2' }, text: 'two' };
  const a = fmt.messageLines(first, { cols: 60, me: 'u1', prev: null }).map(plain);
  const b = fmt.messageLines(second, { cols: 60, me: 'u1', prev: first }).map(plain);
  assert.ok(a.some((l) => l.includes('bob')), 'first message carries the sender header');
  assert.ok(a.some((l) => l.includes('Today')), 'and a day rule');
  assert.deepEqual(b, ['  two'], 'second message is just its body');
});

test('messageLines labels my own messages, attachments and decrypt failures', () => {
  const when = new Date().toISOString();
  const mine = fmt.messageLines({ msg: { id: '1', senderId: 'u1', senderName: 'me-name', createdAt: when }, text: 'hi' }, { cols: 60, me: 'u1' }).map(plain);
  assert.ok(mine.some((l) => l.includes('you')));
  const file = fmt.messageLines({ msg: { id: '2', senderId: 'u2', senderName: 'bob', type: 'image', createdAt: when }, attach: { filename: 'cat.png', size: 2048 } }, { cols: 60, me: 'u1', attachmentLabel: 'Image #1' }).map(plain);
  assert.ok(file.some((l) => l.includes('[Image #1] cat.png') && l.includes('2.0 KB')));
  const bad = fmt.messageLines({ msg: { id: '3', senderId: 'u2', senderName: 'bob', createdAt: when }, error: 'boom' }, { cols: 60, me: 'u1' }).map(plain);
  assert.ok(bad.some((l) => l.includes('unable to decrypt')));
});

// ── image ───────────────────────────────────────────────────────────────────

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Builds an RGBA PNG; filter type 1 (Sub) on every row exercises the unfilter path. */
function makePng(width, height, pixel) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const raw = Buffer.alloc(width * 4);
    for (let x = 0; x < width; x += 1) pixel(x, y).forEach((v, i) => { raw[x * 4 + i] = v; });
    const filtered = Buffer.alloc(width * 4);
    for (let i = 0; i < raw.length; i += 1) filtered[i] = (raw[i] - (i >= 4 ? raw[i - 4] : 0)) & 0xff;
    rows.push(Buffer.concat([Buffer.from([1]), filtered]));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

test('PNG decoding returns the original pixels', () => {
  const png = makePng(4, 2, (x, y) => [x * 60, y * 100, 7, 255]);
  assert.equal(image.sniff(png), 'png');
  const decoded = image.decodeImage(png);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 2);
  assert.deepEqual([...decoded.data.subarray(4 * 5, 4 * 5 + 4)], [60, 100, 7, 255]);
});

test('renderBlocks draws two pixel rows per text row within the size limits', () => {
  const png = makePng(40, 40, (x, y) => [x * 6, y * 6, 128, 255]);
  const out = image.renderBlocks(png, { maxCols: 20, maxRows: 5, truecolor: true });
  assert.ok(out.lines.length <= 5);
  for (const line of out.lines) assert.ok(ansi.width(line) <= 20);
  assert.ok(out.lines[0].includes('▀'));
  assert.throws(() => image.decodeImage(Buffer.from('not an image')), /unknown image format/);
});

test('inline image protocol is only used for terminals that support it', () => {
  assert.equal(image.supportsInlineProtocol({ TERM_PROGRAM: 'iTerm.app' }), true);
  assert.equal(image.supportsInlineProtocol({ TERM_PROGRAM: 'Apple_Terminal' }), false);
  assert.equal(image.supportsInlineProtocol({ TERM_PROGRAM: 'iTerm.app', GCHAT_IMAGE_PROTOCOL: 'blocks' }), false);
});

// ── commands ────────────────────────────────────────────────────────────────

test('slash command matching prefers names, resolves aliases', () => {
  assert.equal(matchCommands('gr')[0].name, 'groups');
  assert.equal(findCommand('g').name, 'groups');
  assert.equal(findCommand('exit').name, 'quit');
  assert.equal(findCommand('nope'), null);
  assert.ok(matchCommands('').length >= 20);
});

// ── App (fake client) ───────────────────────────────────────────────────────

const SECRET = cryptoV2.generateGroupSecret();
const GROUP = { id: 'g1', name: 'Team', unreadCount: 0 };
const OTHER = { id: 'g2', name: 'Other', unreadCount: 2 };

async function envelope({ id, senderId, senderName, text, channel = 'main', createdAt }) {
  const { envelope: env } = await encryptTextEnvelope({ messageId: id, text, secret: SECRET, groupId: GROUP.id, senderId, channel });
  return { ...env, senderName, createdAt: createdAt || new Date().toISOString() };
}

function makeClient(over = {}) {
  const calls = { sent: [], read: [], typing: [] };
  const client = {
    calls,
    server: 'http://localhost:1',
    http: { session: { user: { id: 'u1' }, cookies: { a: 'b' } }, setServer() {} },
    user: { id: 'u1', username: 'me' },
    onEvent: null,
    async me() { return { id: 'u1', username: 'me' }; },
    async listGroups() { return [GROUP, OTHER]; },
    async openGroup() {
      return { group: GROUP, channel: 'main', messages: [await envelope({ id: 'm1', senderId: 'u2', senderName: 'bob', text: 'hello there', createdAt: '2026-08-13T10:00:00.000Z' })] };
    },
    async fetchChannels() { return []; },
    async fetchUnread() { return { counts: { main: 0 }, groupUnreadCount: 0, tagIndexes: {} }; },
    async connectSocket() { return {}; },
    disconnectSocket() {},
    async listMembers() { return [{ id: 'u1', username: 'me' }, { id: 'u2', username: 'bob' }]; },
    getSecret: () => SECRET,
    async sendText(args) { calls.sent.push(args); return { ok: true }; },
    async markChannelRead(...args) { calls.read.push(args); return true; },
    emitTyping(...args) { calls.typing.push(args); },
    inviteCode: () => 'abc123',
    ...over,
  };
  return client;
}

async function makeApp(clientOver, { auth = false, open = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-ui-'));
  const paths = configPaths(dir);
  savePrefs({ activeGroupId: GROUP.id }, paths);
  const stdin = new EventEmitter();
  stdin.setRawMode = () => {};
  stdin.setEncoding = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  const stdout = fakeStdout(80, 30);
  const exits = [];
  const client = makeClient(clientOver);
  const app = new App({ client, paths, stdin, stdout, onExit: (code) => exits.push(code) });
  const committed = [];
  const commit = app.screen.commit.bind(app.screen);
  app.screen.commit = (lines) => { committed.push(...lines.map(plain)); commit(lines); };
  await app.start();
  if (!auth) await app.bootPromise;
  if (!auth && open) await app.openGroup(GROUP);
  await app.printChain;
  const type = (text) => stdin.emit('data', text);
  const live = () => app.screen.lines.map(plain);
  const settle = async () => { await new Promise((r) => setTimeout(r, 30)); await app.printChain; };
  return { app, client, committed, exits, type, live, settle, stdout };
}

test('opening a chat prints its history and shows the input placeholder', async () => {
  const { app, committed, live } = await makeApp();
  assert.equal(app.view, 'chat');
  const joined = committed.join('\n');
  assert.match(joined, /Team · #main/);
  assert.match(joined, /bob/);
  assert.match(joined, /hello there/);
  assert.ok(live().some((l) => l.includes('Message #main')), 'input box shows the channel placeholder');
  app.stop(0);
});

test('typing a message and pressing Enter sends it to the active channel', async () => {
  const { app, client, type, settle } = await makeApp();
  type('hi team');
  type('\r');
  await settle();
  assert.equal(client.calls.sent.length, 1);
  assert.equal(client.calls.sent[0].text, 'hi team');
  assert.equal(client.calls.sent[0].channel, 'main');
  assert.equal(app.input.text, '');
  app.stop(0);
});

test('a trailing backslash plus Enter inserts a newline instead of sending', async () => {
  const { app, client, type } = await makeApp();
  type('line one\\');
  type('\r');
  assert.equal(app.input.text, 'line one\n');
  assert.equal(client.calls.sent.length, 0);
  app.stop(0);
});

test('typing a slash opens the command menu; Esc closes it', async () => {
  const { app, type, live } = await makeApp();
  type('/gr');
  assert.ok(live().some((l) => l.includes('/groups') && l.includes('Switch between groups')));
  type('\u001b');
  assert.equal(app.input.text, '');
  assert.ok(!live().some((l) => l.includes('Switch between groups')));
  app.stop(0);
});

test('/members prints the roster', async () => {
  const { app, type, committed, settle } = await makeApp();
  type('/members\r');
  await settle();
  assert.match(committed.join('\n'), /Team · 2 members/);
  assert.match(committed.join('\n'), /bob/);
  app.stop(0);
});

test('Ctrl+C clears the draft first, then needs a second press to exit', async () => {
  const { app, exits, type, live } = await makeApp();
  type('draft');
  type('\u0003');
  assert.equal(app.input.text, '');
  assert.deepEqual(exits, []);
  type('\u0003');
  assert.ok(live().some((l) => l.includes('Ctrl+C again')));
  assert.deepEqual(exits, []);
  type('\u0003');
  assert.deepEqual(exits, [0]);
});

test('a live message in the open channel is printed and advances the read cursor', async () => {
  const { app, client, committed, settle } = await makeApp();
  const raw = await envelope({ id: 'm2', senderId: 'u2', senderName: 'bob', text: 'live one' });
  await app.onClientEvent('sync_event', { protocol: 2, type: 'message.created', groupId: 'g1', seq: 2, epoch: 1, message: { ...raw, groupId: 'g1' } });
  await settle();
  assert.match(committed.join('\n'), /live one/);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(client.calls.read.length >= 1, 'mark_channel_read was sent');
  assert.equal(client.calls.read.at(-1)[2].messageId, 'm2');
  app.stop(0);
});

test('while the terminal is unfocused, new messages are not marked read until focus returns', async () => {
  const { app, client, stdout, type, settle } = await makeApp();
  await new Promise((r) => setTimeout(r, 400));
  client.calls.read.length = 0;
  type('\u001b[O');
  const raw = await envelope({ id: 'm3', senderId: 'u2', senderName: 'bob', text: 'while away' });
  await app.onClientEvent('sync_event', { protocol: 2, type: 'message.created', groupId: 'g1', seq: 3, epoch: 1, message: { ...raw, groupId: 'g1' } });
  await settle();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(client.calls.read.length, 0);
  assert.ok(stdout.writes.join('').includes('\u0007'), 'bell rang');
  type('\u001b[I');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(client.calls.read.at(-1)[2].messageId, 'm3');
  app.stop(0);
});

test('a message in another group bumps its unread count in the footer', async () => {
  const { app, live, settle } = await makeApp();
  const raw = await envelope({ id: 'x1', senderId: 'u2', senderName: 'bob', text: 'elsewhere' });
  await app.onClientEvent('sync_event', { protocol: 2, type: 'message.created', groupId: 'g2', seq: 1, epoch: 1, message: { ...raw, groupId: 'g2' } });
  await settle();
  assert.ok(live().some((l) => l.includes('Other') && l.includes('3')), 'Other had 2 unread, now 3');
  app.stop(0);
});

test('read_cursor_updated from another device clears the badge', async () => {
  const { app, live } = await makeApp();
  app.onReadCursor({ groupId: 'g2', tagIndex: null, groupUnreadCount: 0, channelUnreadCount: 0 });
  assert.ok(!live().some((l) => l.includes('Other')));
  app.stop(0);
});

test('own message echoed by the server is printed as "you" exactly once', async () => {
  const { app, committed, settle } = await makeApp();
  const raw = await envelope({ id: 'm9', senderId: 'u1', senderName: 'me', text: 'mine' });
  const event = { protocol: 2, type: 'message.created', groupId: 'g1', seq: 4, epoch: 1, message: { ...raw, groupId: 'g1' } };
  await app.onClientEvent('sync_event', event);
  await app.onClientEvent('sync_event', event);
  await settle();
  const joined = committed.join('\n');
  assert.equal((joined.match(/mine/g) || []).length, 1);
  assert.match(joined, /you/);
  app.stop(0);
});

test('login flow: wrong password shows the error and returns to the menu', async () => {
  let attempts = 0;
  const { app, type, live, committed, settle } = await makeApp({
    http: { session: { user: null, cookies: {} }, setServer() {} },
    async login(username) {
      attempts += 1;
      if (attempts === 1) throw new Error('Invalid username or password');
      return { id: 'u1', username };
    },
  }, { auth: true });
  assert.ok(live().some((l) => l.includes('Sign in to GChat')));
  type('\r');
  await settle();
  type('me\r');
  await settle();
  type('nope\r');
  await settle();
  assert.match(committed.join('\n'), /Invalid username or password/);
  assert.ok(live().some((l) => l.includes('Sign in to GChat')));
  type('\r');
  await settle();
  type('me\r');
  await settle();
  type('right\r');
  await new Promise((r) => setTimeout(r, 100));
  await settle();
  assert.match(committed.join('\n'), /Signed in as me/);
  app.stop(0);
});

test('the password prompt masks what is typed', async () => {
  const { app, type, live, settle } = await makeApp({ http: { session: { user: null, cookies: {} }, setServer() {} } }, { auth: true });
  type('\r');
  await settle();
  type('me\r');
  await settle();
  type('secret');
  const shown = live().join('\n');
  assert.ok(shown.includes('••••••'));
  assert.ok(!shown.includes('secret'));
  app.stop(0);
});

// ── home screen, mouse, speed ───────────────────────────────────────────────

test('gchat starts on the home screen and does not open a chat by itself', async () => {
  const { app, client, live, committed } = await makeApp(undefined, { open: false });
  assert.equal(app.view, 'home');
  assert.equal(app.group, null);
  const shown = live().join('\n');
  assert.match(shown, /Welcome back, me!/);
  assert.match(shown, /Your chats/);
  assert.match(shown, /Team/);
  assert.match(shown, /\+ New group/);
  assert.ok(!committed.join('\n').includes('hello there'), 'no history printed');
  assert.equal(client.calls.sent.length, 0);
  app.stop(0);
});

test('home: arrows move the highlight, Enter opens that chat', async () => {
  const { app, type, live, settle } = await makeApp(undefined, { open: false });
  assert.equal(app.homeIndex, 0, 'defaults to the last opened chat');
  type('\u001b[B');
  assert.equal(app.homeIndex, 1);
  type('\u001b[A');
  type('\r');
  await settle();
  await app.printChain;
  assert.equal(app.view, 'chat');
  assert.equal(app.group.id, 'g1');
  assert.ok(live().some((l) => l.includes('Message #main')));
  app.stop(0);
});

test('/home goes back and the old chat stops being treated as open', async () => {
  const { app, type, live, settle } = await makeApp();
  type('/home\r');
  await settle();
  assert.equal(app.view, 'home');
  assert.equal(app.group, null);
  assert.match(live().join('\n'), /Your chats/);
  app.stop(0);
});

test('home animation: frames differ over time but keep a stable size', () => {
  const { renderBird } = require('../src/ui/bird');
  const a = renderBird({ width: 24, t: 0.2, truecolor: true });
  const b = renderBird({ width: 24, t: 2.4, truecolor: true });
  assert.equal(a.length, b.length);
  assert.notDeepEqual(a, b);
  for (const line of a) assert.equal(ansi.width(line), 24 + 10);
  const arriving = renderBird({ width: 24, t: 0, enter: 0.1, truecolor: true });
  assert.ok(arriving.join('').length < a.join('').length, 'the bird is mostly off-screen while flying in');
});

test('home layout adapts: narrow terminals get one column, short ones drop the bird', () => {
  const { renderHome } = require('../src/ui/home');
  const base = { t: 1, enter: 1, burst: -1, user: 'me', host: 'h', connected: true, groups: [GROUP, OTHER], selected: 0, lastId: 'g1', version: '1' };
  const wide = renderHome({ ...base, cols: 100, rows: 40 });
  const narrow = renderHome({ ...base, cols: 50, rows: 40 });
  const short = renderHome({ ...base, cols: 100, rows: 18 });
  for (const out of [wide, short]) for (const line of out.lines) assert.ok(ansi.width(line) <= 100);
  assert.ok(wide.lines.some((l) => plain(l).includes('│') && plain(l).includes('Your chats')), 'two columns');
  assert.ok(narrow.lines.length > 0 && narrow.lines.every((l) => ansi.width(l) <= 50));
  assert.equal(short.birdBox, null, 'no room for the bird');
  assert.notEqual(wide.birdBox, null);
});

function clickAt(app, type, x, row) {
  app.screen.originTop = 1; // pretend the live region starts on the first terminal row
  type(`\u001b[<0;${x};${row + 1}M\u001b[<0;${x};${row + 1}m`);
}

test('mouse: clicking a channel name in the footer switches channel', async () => {
  const { app, type, settle } = await makeApp();
  app.channels = ['main', 'design'];
  app.refresh();
  const chip = app.hits.find((h) => h.fn && h.x1 - h.x0 === '#design'.length);
  assert.ok(chip, 'the #design chip is a click target');
  clickAt(app, type, chip.x0 + 2, chip.row);
  await settle();
  assert.equal(app.channel, 'design');
  app.stop(0);
});

test('mouse: clicking a chat on the home screen opens it', async () => {
  const { app, type, settle } = await makeApp(undefined, { open: false });
  const hit = app.hits.find((h) => h.x1 - h.x0 > 10);
  assert.ok(hit);
  clickAt(app, type, hit.x0 + 3, hit.row);
  await settle();
  await app.printChain;
  assert.equal(app.view, 'chat');
  app.stop(0);
});

test('mouse: clicking a menu option picks it, and clicks outside the live region are ignored', async () => {
  const { app, type, settle } = await makeApp();
  type('/groups\r');
  await settle();
  assert.ok(app.dialog, 'group picker is open');
  const option = app.hits[1];
  clickAt(app, type, option.x0 + 4, option.row);
  await settle();
  await app.printChain;
  assert.equal(app.dialog, null);
  type('\u001b[<0;5;200M');
  app.stop(0);
});

test('the cursor-position reply sets the click origin; mouse off ignores clicks', async () => {
  const { app, type } = await makeApp();
  app.screen.pendingReports.length = 0;
  app.screen.pendingReports.push({ caretRow: 2 });
  type('\u001b[20;5R');
  assert.equal(app.screen.originTop, 18);
  app.setMouse(false);
  const before = app.channel;
  const hit = app.hits.find((h) => h.fn);
  clickAt(app, type, hit.x0 + 1, hit.row);
  assert.equal(app.mouseOn, false);
  assert.equal(app.channel, before);
  app.stop(0);
});

test('opening a chat sends the history and unread requests together (no serial round trips)', async () => {
  const starts = [];
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const { app } = await makeApp({
    async openGroup() {
      starts.push(Date.now());
      await delay(60);
      return { group: GROUP, channel: 'main', messages: [] };
    },
    async fetchUnread() {
      starts.push(Date.now());
      await delay(60);
      return { counts: { main: 0 }, groupUnreadCount: 0, tagIndexes: {} };
    },
  }, { open: false });
  const t0 = Date.now();
  await app.openGroup(GROUP);
  const elapsed = Date.now() - t0;
  assert.ok(Math.abs(starts[0] - starts[1]) < 30, 'both requests start together');
  assert.ok(elapsed < 150, `open took ${elapsed}ms`);
  app.stop(0);
});

test('unread messages get a "new messages" rule above the first one', async () => {
  const { app, committed } = await makeApp({
    async fetchUnread() { return { counts: { main: 2 }, groupUnreadCount: 2, tagIndexes: {} }; },
    async openGroup() {
      return {
        group: GROUP,
        channel: 'main',
        messages: [
          await envelope({ id: 'a1', senderId: 'u2', senderName: 'bob', text: 'old news', createdAt: '2026-08-13T10:00:00.000Z' }),
          await envelope({ id: 'a2', senderId: 'u2', senderName: 'bob', text: 'fresh one', createdAt: '2026-08-13T10:01:00.000Z' }),
          await envelope({ id: 'a3', senderId: 'u2', senderName: 'bob', text: 'fresh two', createdAt: '2026-08-13T10:02:00.000Z' }),
        ],
      };
    },
  });
  const text = committed.join('\n');
  assert.ok(text.indexOf('new messages') > text.indexOf('old news'));
  assert.ok(text.indexOf('new messages') < text.indexOf('fresh one'));
  app.stop(0);
});

// ── safety and polish ───────────────────────────────────────────────────────

test('safe() strips terminal escape sequences and control characters from other people\'s text', () => {
  const evil = 'hi\u001b]0;pwned\u0007 there\u001b[2J\u001b[31mred\u0000 ‮evil\u009b1m';
  const clean = fmt.safe(evil);
  assert.equal(clean, 'hi therered evil');
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(clean));
  assert.equal(fmt.safe('line one\nline two\ttabbed'), 'line one\nline two\ttabbed');
});

test('a message carrying escape codes is printed without them', async () => {
  const { app, committed, settle } = await makeApp();
  const raw = await envelope({ id: 'x9', senderId: 'u2', senderName: 'bob\u001b]0;owned\u0007', text: 'click \u001b[2Jhere\u001b]8;;http://evil\u0007 now' });
  await app.onClientEvent('sync_event', { protocol: 2, type: 'message.created', groupId: 'g1', seq: 9, epoch: 1, message: { ...raw, groupId: 'g1' } });
  await settle();
  const joined = committed.join('\n');
  assert.match(joined, /click here now/);
  assert.ok(!joined.includes('\u001b'), 'no raw escape reached the transcript');
  app.stop(0);
});

test('inline styling: links are underlined, `code` and **bold** are styled, text stays intact', () => {
  const styled = fmt.inlineStyle('see https://example.com/a?b=1, use `npm i` and **now**');
  assert.equal(plain(styled), 'see https://example.com/a?b=1, use npm i and now');
  assert.ok(styled.includes('\u001b[4m'), 'underlined link');
  assert.equal(fmt.inlineStyle('plain text'), 'plain text');
});

test('the sign-in screen shows the bird and tagline above the menu', async () => {
  const { app, live } = await makeApp({ http: { session: { user: null, cookies: {} }, setServer() {} } }, { auth: true });
  app.stdout.rows = 40;
  app.refresh();
  const shown = live().join('\n');
  assert.match(shown, /Encrypted group chat, in your terminal\./);
  assert.match(shown, /Sign in to GChat/);
  assert.ok(live().length > 14, 'bird rows are part of the live region');
  app.stop(0);
});

test('the input box carries the channel name on its border', async () => {
  const { app, live } = await makeApp();
  assert.ok(live().some((l) => l.startsWith('╭') && l.includes('#main')));
  app.stop(0);
});
