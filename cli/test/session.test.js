'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { configPaths } = require('../src/store/paths');
const { loadSession, saveSession, cookieHeader, storeSetCookieHeaders, clearSession } = require('../src/store/session');
const { loadConfig, setConfigKey } = require('../src/store/config');
const { setChannelOrder, listChannels } = require('../src/store/prefs');
const { putVaultEntry, getVaultEntry, listVaultEntries, removeVaultEntry } = require('../src/store/vault');
const { HttpClient } = require('../src/client/http');
const { looksLikeImagePath } = require('../src/tui/clipboard-image');
const { socketIoOptions } = require('../src/client/socket');
const { SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION } = require('../src/version');

test('session cookie jar persists and formats Cookie header', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-sess-'));
  const paths = configPaths(dir);
  let session = { cookies: {}, csrfToken: null, user: null };
  session = storeSetCookieHeaders(session, ['connect.sid=abc123; Path=/; HttpOnly']);
  saveSession(session, paths);
  const loaded = loadSession(paths);
  assert.equal(loaded.cookies['connect.sid'], 'abc123');
  assert.equal(cookieHeader(loaded), 'connect.sid=abc123');
  clearSession(paths);
  assert.deepEqual(loadSession(paths).cookies, {});
});

test('config set server persists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-cfg-'));
  const paths = configPaths(dir);
  setConfigKey('server', 'http://127.0.0.1:4400', paths);
  assert.equal(loadConfig(paths).server, 'http://127.0.0.1:4400');
});

test('vault put/get/list/remove', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-vault-'));
  const paths = configPaths(dir);
  putVaultEntry('g1', { secret: 's', joinCode: 'abc123' }, paths);
  assert.equal(getVaultEntry('g1', paths).secret, 's');
  assert.equal(listVaultEntries(paths).length, 1);
  removeVaultEntry('g1', paths);
  assert.equal(getVaultEntry('g1', paths), null);
});

test('looksLikeImagePath only accepts existing image files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-img-'));
  const file = path.join(dir, 'shot.png');
  fs.writeFileSync(file, 'x');
  assert.equal(looksLikeImagePath(file), file);
  assert.equal(looksLikeImagePath('not-a-path'), false);
  assert.equal(looksLikeImagePath('/tmp/nope.txt'), false);
});

test('HttpClient builds absolute URLs from configured server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-http-'));
  const paths = configPaths(dir);
  setConfigKey('server', 'http://example.test/', paths);
  const client = new HttpClient({ paths });
  assert.equal(client.server, 'http://example.test');
});

test('HttpClient sends X-GChat-Sync-Protocol on every request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-proto-'));
  const paths = configPaths(dir);
  setConfigKey('server', 'http://example.test', paths);
  const client = new HttpClient({ paths });
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), headers: opts.headers, method: opts.method });
    return {
      ok: true,
      status: 200,
      headers: { getSetCookie: () => [], get: () => null },
      text: async () => '{"ok":true}',
    };
  };
  try {
    await client.post('/api/groups/create', { name: 'x' });
    await client.get('/api/groups/mine');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.length, 2);
  for (const req of seen) {
    assert.equal(req.headers[SYNC_PROTOCOL_HEADER], String(SYNC_PROTOCOL_VERSION));
  }
});

test('socket handshake advertises sync protocol 2', () => {
  const opts = socketIoOptions({ cookies: { 'connect.sid': 'abc' } });
  assert.deepEqual(opts.auth, { protocol: SYNC_PROTOCOL_VERSION });
  assert.equal(opts.extraHeaders[SYNC_PROTOCOL_HEADER], String(SYNC_PROTOCOL_VERSION));
  assert.equal(opts.transportOptions.polling.extraHeaders[SYNC_PROTOCOL_HEADER], String(SYNC_PROTOCOL_VERSION));
  assert.match(opts.extraHeaders.Cookie, /connect\.sid=abc/);
});

test('HttpClient maps 426 protocol_upgrade_required to a versioned error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-426-'));
  const paths = configPaths(dir);
  setConfigKey('server', 'http://example.test', paths);
  const client = new HttpClient({ paths });
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 426,
    headers: { getSetCookie: () => [], get: () => null },
    text: async () => JSON.stringify({ error: 'protocol_upgrade_required', requiredProtocol: 2 }),
  });
  try {
    await assert.rejects(
      () => client.post('/api/groups/create', { name: 'x' }),
      (err) => {
        assert.equal(err.status, 426);
        assert.match(err.message, /protocol_upgrade_required/);
        assert.match(err.message, /need 2/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('setChannelOrder preserves custom order and keeps main', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-ch-'));
  const paths = configPaths(dir);
  const ordered = setChannelOrder('g1', ['design', 'main', 'random'], paths);
  assert.deepEqual(ordered, ['design', 'main', 'random']);
  assert.deepEqual(listChannels('g1', paths), ['design', 'main', 'random']);
});
