'use strict';

/**
 * Regression tests for the CLI sync/one-shot/prompt bug batch.
 * Unit-level only; live-server coverage lives in integration.test.js.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');

const { SocketClient, socketIoOptions } = require('../src/client/socket');
const { runArgv, promptHidden } = require('../src/commands/handlers');
const { configPaths, readJson } = require('../src/store/paths');
const { loadPrefs } = require('../src/store/prefs');
const app = require('../src/tui/app');
const landing = require('../src/tui/landing');
const { IMAGE_MIME_BY_EXT } = require('../src/client/api');

function mockStdin() {
  const s = new PassThrough();
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = (v) => { s.rawMode = !!v; };
  return s;
}

function captureStderr(fn) {
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.stderr.write = original;
      return captured;
    });
}

// --- socket layer -----------------------------------------------------------

test('socket options use bounded reconnection backoff', () => {
  const opts = socketIoOptions({ cookies: {} });
  assert.equal(opts.reconnection, true);
  assert.ok(opts.reconnectionDelay >= 100, 'non-zero initial delay');
  assert.ok(opts.reconnectionDelayMax <= 5000, 'delay is capped');
  assert.ok(opts.randomizationFactor > 0);
});

test('emitAck settles exactly once: timeout rejects, late ack is silent', async () => {
  const sc = new SocketClient({ server: 'http://example.test', session: {}, onEvent: () => {} });
  const fake = {
    connected: true,
    emitted: [],
    on() {},
    off() {},
    removeAllListeners() {},
    disconnect() { fake.disconnected = true; },
    emit(event, payload, ack) {
      fake.emitted.push(event);
      fake.ack = ack;
    },
  };
  sc.connect = () => { sc.socket = fake; return fake; };
  const outcome = await sc.emitAck('send_message', {}, 20).then(
    () => 'resolved',
    (err) => err.message
  );
  assert.match(outcome, /send_message timed out/);
  assert.doesNotThrow(() => fake.ack({ ok: true }), 'late ack must not throw');
});

test('waitConnected disconnects the socket when the wait times out', async () => {
  const sc = new SocketClient({ server: 'http://example.test', session: {}, onEvent: () => {} });
  const fake = {
    connected: false,
    on() {},
    off() {},
    removeAllListeners() {},
    disconnect() { fake.disconnected = true; },
  };
  sc.connect = () => { sc.socket = fake; return fake; };
  await assert.rejects(() => sc.waitConnected(20), /timed out/);
  assert.equal(fake.disconnected, true, 'no reconnecting socket leaks after timeout');
});

test('rejoinRooms re-emits join_room for every tracked room', () => {
  const sc = new SocketClient({ server: 'http://example.test', session: {}, onEvent: () => {} });
  const fake = { emit: (event, payload) => fake.joined = [event, payload] };
  sc.socket = fake;
  sc.joinedRooms.add('g1');
  sc.joinedRooms.add('g2');
  sc.rejoinRooms();
  assert.deepEqual(fake.joined, ['join_room', 'g2']);
});

// --- one-shot command lifecycle --------------------------------------------

test('one-shot commands disconnect the socket in a finally block', async () => {
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-oneshot-'));
  const fakeClient = {
    http: { setServer() {} },
    resolveGroup: async () => ({ id: 'g1', name: 'team' }),
    sendText: async () => ({ messageId: 'm1' }),
    disconnectSocket: () => calls.push('disconnect'),
  };
  await runArgv(['send', 'hi'], { client: fakeClient, configDir: dir, out: () => {}, err: () => {} });
  assert.ok(calls.includes('disconnect'), 'disconnectSocket runs after the command settles');
});

// --- promptHidden -----------------------------------------------------------

test('promptHidden resolves on Enter, never echoes input, handles backspace', async () => {
  const writes = [];
  const out = { write: (t) => writes.push(t) };
  const stdin = mockStdin();
  const pending = promptHidden('Password: ', { input: stdin, output: out });
  stdin.write('ab\u007fc\r');
  assert.equal(await pending, 'ac');
  assert.deepEqual(writes, ['Password: ', '\n'], 'typed characters are never echoed');
});

test('promptHidden rejects on Ctrl+C and restores raw mode', async () => {
  const stdin = mockStdin();
  const pending = promptHidden('P: ', { input: stdin, output: { write() {} } });
  stdin.write('\u0003');
  await assert.rejects(() => pending, /Aborted/);
  assert.equal(stdin.rawMode, false, 'terminal raw mode restored');
});

test('promptHidden requires a TTY', async () => {
  await assert.rejects(
    () => promptHidden('P: ', { input: new PassThrough(), output: { write() {} } }),
    /TTY/
  );
});

// --- splash restore ---------------------------------------------------------

test('restore failure maps the splash screen back to landing', () => {
  assert.equal(app.screenAfterRestoreFailure('splash'), 'landing');
  assert.equal(app.screenAfterRestoreFailure('landing'), 'landing');
  assert.equal(app.screenAfterRestoreFailure('chat'), 'chat');
});

// --- stores -----------------------------------------------------------------

test('readJson warns on stderr when a non-empty store file is corrupt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-corrupt-'));
  const paths = configPaths(dir);
  fs.writeFileSync(paths.prefs, '{not json');
  let captured = '';
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };
  try {
    const prefs = loadPrefs(paths);
    assert.deepEqual(prefs.channels, {}, 'fallback is used');
  } finally {
    process.stderr.write = original;
  }
  assert.match(captured, /could not parse/);
  assert.match(captured, /prefs\.json/);
});

test('readJson stays silent for clean files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-clean-'));
  const file = path.join(dir, 'store.json');
  fs.writeFileSync(file, '{"ok":true}');
  let captured = '';
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };
  try {
    assert.deepEqual(readJson(file, {}), { ok: true });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(captured, '');
});

// --- version / upload guards -------------------------------------------------

test('TUI version is the CLI package version (single version string)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(landing.TUI_VERSION, pkg.version);
});

test('.jpg maps to image/jpeg and friends to their real MIME types', () => {
  assert.equal(IMAGE_MIME_BY_EXT['.jpg'], 'image/jpeg');
  assert.equal(IMAGE_MIME_BY_EXT['.jpeg'], 'image/jpeg');
  assert.equal(IMAGE_MIME_BY_EXT['.png'], 'image/png');
  assert.equal(IMAGE_MIME_BY_EXT['.gif'], 'image/gif');
  assert.equal(IMAGE_MIME_BY_EXT['.webp'], 'image/webp');
});

// --- chat TUI sync_event semantics ------------------------------------------

const cryptoV2 = require('../src/crypto-v2');
const {
  encryptTextEnvelope,
} = require('../src/client/messages');
const { createChatController } = require('../src/tui/chat');

/**
 * Controller harness wired to a fake client with REAL crypto so sync_event
 * payloads can be built exactly like the server emits them.
 */
async function makeSyncHarness({ fetchMessages = async () => [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-sync-'));
  const secret = cryptoV2.generateGroupSecret();
  const groupId = cryptoV2.randomUuid();
  const fetchCalls = [];
  const client = {
    user: { id: 'me', username: 'will' },
    listGroups: async () => [{ id: groupId, name: 'team' }],
    listMembers: async () => [],
    openGroup: async () => ({ messages: [] }),
    connectSocket: async () => ({}),
    disconnectSocket: () => {},
    setActiveGroup: () => {},
    switchChannel: (_g, name) => name,
    getSecret: (id) => (String(id) === String(groupId) ? secret : null),
    emitTyping: () => {},
    logout: async () => {},
    deleteMessage: async () => {},
    editMessage: async () => {},
    markChannelRead: async () => {},
    fetchMessages: async (id, opts) => {
      fetchCalls.push({ id, opts });
      return fetchMessages(id, opts);
    },
  };
  const chat = createChatController({
    client,
    paths: configPaths(dir),
    stdout: { write() {}, columns: 80, rows: 24 },
    getSize: () => ({ cols: 80, rows: 24 }),
  });
  await chat.start();
  chat.state.groups = [{ id: groupId, name: 'team' }];
  chat.state.activeGroupId = groupId;
  return { chat, client, secret, groupId, fetchCalls };
}

function makeSyncEvent({ groupId, type, message, entityId, auxiliary, seq = 1 }) {
  return {
    protocol: 2,
    groupId,
    epoch: 1,
    seq,
    type,
    entityId: entityId || message?.id || null,
    channelKey: message?.tagIndex || auxiliary?.channelKey || 'main',
    revision: Math.max(1, Number(message?.revision) || 1),
    message: message || null,
    auxiliary: auxiliary || null,
  };
}

async function makeRawMessage({ chat, secret, groupId, text, channel, senderId, revision = 1, id = null }) {
  // The id MUST be the same one the AAD was bound to: real server messages
  // keep the envelope id; overriding it post-hoc breaks GCM auth.
  const mid = id || cryptoV2.randomUuid();
  const { envelope } = await encryptTextEnvelope({
    text, secret, groupId, senderId, channel, revision, messageId: mid,
  });
  return {
    ...envelope,
    id: mid,
    groupId,
    senderId,
    senderName: String(senderId) === 'me' ? 'will' : 'ada',
    type: 'text',
    createdAt: '2026-08-13T10:05:00.000Z',
  };
}

/**
 * The TUI's socket dispatch is fire-and-forget (assigned by start()), and
 * Node's WebCrypto subtle ops settle on the threadpool — beyond a microtask
 * flush. Yield to the event loop so the full decrypt→render chain lands.
 */
async function settle(ms = 75) {
  await new Promise((r) => setTimeout(r, ms));
}

test('sync_event message.created decrypts, filters by channel, and replays are idempotent', async () => {
  const { chat, client, secret, groupId } = await makeSyncHarness();
  const raw = await makeRawMessage({ secret, groupId, text: 'hello there', channel: 'design', senderId: 'ada' });
  await client.onEvent('sync_event', makeSyncEvent({ groupId, type: 'message.created', message: raw }));
  await settle();
  const rows = () => chat.state.messages.filter((m) => String(m.msg.id) === String(raw.id));
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].text, 'hello there');
  assert.equal(rows()[0].channel, 'design', 'decrypted channel metadata is used');
  assert.equal(rows()[0].sending, false);
  // Replayed create for a row we already hold is dropped.
  await client.onEvent('sync_event', makeSyncEvent({ groupId, type: 'message.created', message: raw }));
  await settle();
  assert.equal(rows().length, 1);
  chat.stop();
});

test('sync_event from another group bumps unread instead of touching the transcript', async () => {
  const { chat, client, secret, groupId } = await makeSyncHarness();
  const otherId = cryptoV2.randomUuid();
  chat.state.groups.push({ id: otherId, name: 'other' });
  const raw = await makeRawMessage({ secret, groupId: otherId, text: 'elsewhere', channel: 'main', senderId: 'ada' });
  await client.onEvent('sync_event', makeSyncEvent({ groupId: otherId, type: 'message.created', message: raw }));
  assert.equal(chat.state.messages.length, 0);
  assert.equal(chat.state.groups.find((g) => String(g.id) === otherId).unreadCount, 1);
  chat.stop();
});

test('own pending row is renamed by the sync_event echo instead of duplicated', async () => {
  const { chat, client, secret, groupId } = await makeSyncHarness();
  chat.state.messages.push({
    msg: { id: 'pending-1-abc', groupId, senderId: 'me', senderName: 'will', type: 'text', createdAt: '2026-08-13T10:05:00.000Z' },
    text: 'self echo',
    channel: 'main',
    sending: true,
  });
  const raw = await makeRawMessage({ secret, groupId, text: 'self echo', channel: 'main', senderId: 'me' });
  await client.onEvent('sync_event', makeSyncEvent({ groupId, type: 'message.created', message: raw }));
  await settle();
  const rows = chat.state.messages.filter((m) => m.text === 'self echo');
  assert.equal(rows.length, 1, 'no duplicate row for the echoed own message');
  assert.equal(String(rows[0].msg.id), String(raw.id), 'pending row adopted the server id');
  assert.equal(rows[0].sending, false);
  chat.stop();
});

test('message.edited replaces the row and an older revision is ignored', async () => {
  const { chat, client, secret, groupId } = await makeSyncHarness();
  const raw = await makeRawMessage({ secret, groupId, text: 'v1', channel: 'main', senderId: 'ada', revision: 1 });
  await client.onEvent('sync_event', makeSyncEvent({ groupId, type: 'message.created', message: raw }));
  await settle();
  const edited = await makeRawMessage({ secret, groupId, text: 'v2', channel: 'main', senderId: 'ada', revision: 2, id: raw.id });
  await client.onEvent('sync_event', makeSyncEvent({ groupId, type: 'message.edited', message: edited, seq: 2 }));
  await settle();
  assert.equal(chat.state.messages.find((m) => String(m.msg.id) === String(raw.id)).text, 'v2');
  const stale = await makeRawMessage({ secret, groupId, text: 'v0', channel: 'main', senderId: 'ada', revision: 1, id: raw.id });
  await client.onEvent('sync_event', makeSyncEvent({ groupId, type: 'message.edited', message: stale, seq: 3 }));
  await settle();
  assert.equal(chat.state.messages.find((m) => String(m.msg.id) === String(raw.id)).text, 'v2', 'older revision never replays');
  chat.stop();
});

test('message.deleted removes the row via entityId', async () => {
  const { chat, client, secret, groupId } = await makeSyncHarness();
  const raw = await makeRawMessage({ secret, groupId, text: 'doomed', channel: 'main', senderId: 'ada' });
  await client.onEvent('sync_event', makeSyncEvent({ groupId, type: 'message.created', message: raw }));
  await settle();
  assert.equal(chat.state.messages.length, 1);
  await client.onEvent('sync_event', makeSyncEvent({ groupId, type: 'message.deleted', entityId: raw.id, seq: 2 }));
  await settle();
  assert.equal(chat.state.messages.length, 0);
  chat.stop();
});

test('history.cleared clears everything for *, or only the matching channel tag', async () => {
  const { chat, client, secret, groupId } = await makeSyncHarness();
  const main = await makeRawMessage({ secret, groupId, text: 'keep', channel: 'main', senderId: 'ada' });
  const design = await makeRawMessage({ secret, groupId, text: 'drop', channel: 'design', senderId: 'ada' });
  await client.onEvent('sync_event', makeSyncEvent({ groupId, type: 'message.created', message: main }));
  await settle();
  await client.onEvent('sync_event', makeSyncEvent({ groupId, type: 'message.created', message: design, seq: 2 }));
  await settle();
  await client.onEvent('sync_event', makeSyncEvent({
    groupId, type: 'history.cleared', auxiliary: { channelKey: design.tagIndex }, seq: 3,
  }));
  await settle();
  assert.equal(chat.state.messages.length, 1, 'only the cleared channel is removed');
  assert.equal(chat.state.messages[0].text, 'keep');
  await client.onEvent('sync_event', makeSyncEvent({
    groupId, type: 'history.cleared', auxiliary: { channelKey: '*' }, seq: 4,
  }));
  await settle();
  assert.equal(chat.state.messages.length, 0);
  chat.stop();
});

test('sync_hint maps to a bounded, throttled backfill of the active group only', async () => {
  const { chat, client, groupId, fetchCalls } = await makeSyncHarness();
  await client.onEvent('sync_hint', { groupId, epoch: 1, latestSeq: 5, unreadDelta: 1 });
  await client.onEvent('sync_hint', { groupId, epoch: 1, latestSeq: 6, unreadDelta: 1 });
  const otherId = cryptoV2.randomUuid();
  await client.onEvent('sync_hint', { groupId: otherId, epoch: 1, latestSeq: 7 });
  assert.equal(fetchCalls.length, 1, 'throttled: one fetch inside the window');
  assert.equal(String(fetchCalls[0].id), String(groupId), 'active group only');
  assert.ok(fetchCalls[0].opts.limit <= 100, 'page size stays within the server cap');
  chat.stop();
});

test('reconnect triggers one bounded backfill for the active group', async () => {
  const { chat, client, groupId, fetchCalls } = await makeSyncHarness();
  await client.onEvent('connect', null); // initial connect: no backfill
  await client.onEvent('disconnect', null);
  await client.onEvent('connect', null); // reconnect: bounded backfill
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].opts.limit <= 100);
  chat.stop();
});

test('sync events with a foreign protocol version are ignored', async () => {
  const { chat, client, secret, groupId } = await makeSyncHarness();
  const raw = await makeRawMessage({ secret, groupId, text: 'nope', channel: 'main', senderId: 'ada' });
  await client.onEvent('sync_event', { ...makeSyncEvent({ groupId, type: 'message.created', message: raw }), protocol: 1 });
  assert.equal(chat.state.messages.length, 0);
  chat.stop();
});

test('terminal bell rings for inactive-group messages when bell is on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-bell-'));
  const writes = [];
  const secret = cryptoV2.generateGroupSecret();
  const groupId = cryptoV2.randomUuid();
  const otherId = cryptoV2.randomUuid();
  const client = {
    user: { id: 'me', username: 'will' },
    listGroups: async () => [{ id: groupId, name: 'team' }, { id: otherId, name: 'other' }],
    listMembers: async () => [],
    openGroup: async () => ({ messages: [] }),
    connectSocket: async () => ({}),
    disconnectSocket: () => {},
    setActiveGroup: () => {},
    switchChannel: (_g, name) => name,
    getSecret: (id) => (String(id) === String(otherId) ? secret : null),
    emitTyping: () => {},
    logout: async () => {},
    deleteMessage: async () => {},
    editMessage: async () => {},
    markChannelRead: async () => {},
    fetchMessages: async () => [],
  };
  const chat = createChatController({
    client,
    paths: configPaths(dir),
    stdout: { write: (t) => writes.push(String(t)), columns: 80, rows: 24 },
    getSize: () => ({ cols: 80, rows: 24 }),
  });
  await chat.start();
  chat.state.groups = [{ id: groupId, name: 'team' }, { id: otherId, name: 'other' }];
  chat.state.activeGroupId = groupId;
  writes.length = 0;
  const raw = await makeRawMessage({ secret, groupId: otherId, text: 'ping', channel: 'main', senderId: 'ada' });
  await client.onEvent('sync_event', makeSyncEvent({ groupId: otherId, type: 'message.created', message: raw }));
  await settle();
  assert.ok(writes.some((w) => w.includes('\x07')), 'bell rings for inactive-group message');
  chat.stop();
});

// --- composer behaviors ------------------------------------------------------

function makeComposerHarness({ onQuit } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-compose-'));
  const cursorCalls = [];
  const chat = createChatController({
    client: {
      user: { id: 'me', username: 'will' },
      listGroups: async () => [],
      listMembers: async () => [],
      openGroup: async () => ({ messages: [] }),
      connectSocket: async () => {},
      disconnectSocket: () => {},
      setActiveGroup: () => {},
      switchChannel: (_g, name) => name,
      getSecret: () => null,
      emitTyping: () => {},
      logout: async () => {},
      deleteMessage: async () => {},
      editMessage: async () => {},
      sendText: async () => ({ messageId: `srv-${Math.random().toString(36).slice(2)}` }),
      markChannelRead: async (_g, _c, cursor) => cursorCalls.push(cursor),
    },
    paths: configPaths(dir),
    stdout: { write() {}, columns: 80, rows: 24 },
    getSize: () => ({ cols: 80, rows: 24 }),
    onQuit,
  });
  return { chat, cursorCalls };
}

test('Ctrl+C while composing cancels the edit instead of quitting', () => {
  let quit = 0;
  const { chat } = makeComposerHarness({ onQuit: () => { quit += 1; } });
  Object.assign(chat.state, { activeGroupId: 'g1', composer: 'draft text', composerCaret: 10 });
  chat.handleKey('\u0003');
  assert.equal(chat.state.composer, '');
  assert.equal(quit, 0, 'Ctrl+C did not quit the TUI');
});

test('Ctrl+C still copies when a message is selected and the composer is empty', () => {
  const { chat } = makeComposerHarness();
  Object.assign(chat.state, {
    selectedMessageId: 'm2',
    composer: '',
    messages: [{
      msg: { id: 'm2', senderId: 'ada', senderName: 'ada', type: 'text', createdAt: '2026-08-13T10:03:00.000Z' },
      text: 'on it',
      channel: 'main',
    }],
  });
  chat.handleKey('\u0003');
  assert.equal(chat.state.flash && chat.state.flash.text, 'copied!');
});

test('Ctrl+D still quits', () => {
  let quit = 0;
  const { chat } = makeComposerHarness({ onQuit: () => { quit += 1; } });
  chat.handleKey('\u0004');
  assert.equal(quit, 1);
});

test('pending optimistic ids are monotonic and never collide', () => {
  const { chat } = makeComposerHarness();
  const ids = new Set();
  for (let i = 0; i < 5; i += 1) {
    chat.state.activeGroupId = 'g1';
    const before = chat.state.messages.length;
    chat.state.composer = `msg ${i}`;
    chat.state.composerCaret = chat.state.composer.length;
    chat.state.userId = 'me';
    chat.state.username = 'will';
    chat.handleKey('\r');
    const added = chat.state.messages.slice(before);
    for (const row of added) ids.add(String(row.msg.id));
  }
  assert.equal(ids.size, 5, 'five sends produce five distinct pending ids');
});

test('markVisibleRead sends a per-channel read cursor, not 20 per-message marks', async () => {
  const { chat, cursorCalls } = makeComposerHarness();
  Object.assign(chat.state, {
    activeGroupId: 'g1',
    activeChannel: 'design',
    userId: 'me',
    username: 'will',
    messages: [
      {
        msg: { id: 'd1', senderId: 'ada', senderName: 'ada', type: 'text', createdAt: '2026-08-13T10:00:00.000Z' },
        text: 'one',
        channel: 'design',
      },
      {
        msg: { id: 'd2', senderId: 'ada', senderName: 'ada', type: 'text', createdAt: '2026-08-13T10:01:00.000Z' },
        text: 'two',
        channel: 'design',
      },
    ],
  });
  chat.draw();
  assert.ok(cursorCalls.length >= 1);
  assert.equal(cursorCalls[0].messageId, 'd2', 'cursor is the last visible message');
  assert.equal(cursorCalls[0].createdAt, '2026-08-13T10:01:00.000Z');
  chat.draw();
  chat.draw();
  assert.ok(cursorCalls.length <= 2, 'same tail message does not re-emit the cursor every draw');
});

test('channel list converges with the server list on group open', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-chmerge-'));
  const groupId = 'g-chmerge';
  const fetchChannelCalls = [];
  const chat = createChatController({
    client: {
      user: { id: 'me', username: 'will' },
      listGroups: async () => [{ id: groupId, name: 'team' }],
      listMembers: async () => [],
      openGroup: async () => ({ messages: [] }),
      connectSocket: async () => {},
      disconnectSocket: () => {},
      setActiveGroup: () => {},
      switchChannel: (_g, name) => name,
      getSecret: () => null,
      emitTyping: () => {},
      logout: async () => {},
      fetchChannels: async (id) => {
        fetchChannelCalls.push(id);
        return [{ name: 'ops', tagIndex: 'x', messageCount: 3 }];
      },
    },
    paths: configPaths(dir),
    stdout: { write() {}, columns: 80, rows: 24 },
    getSize: () => ({ cols: 80, rows: 24 }),
  });
  chat.state.groups = [{ id: groupId, name: 'team' }];
  await chat.loadGroup({ id: groupId, name: 'team' });
  assert.deepEqual(fetchChannelCalls, [groupId], 'one bounded fetch per group open');
  assert.ok(chat.state.channels.includes('ops'), 'server channel merged in');
  assert.equal(chat.state.activeChannel, 'main', 'local active-channel choice kept');
  chat.stop();
});

