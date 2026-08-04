'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { configPaths } = require('../src/store/paths');
const { loadSession, saveSession, cookieHeader, storeSetCookieHeaders, clearSession } = require('../src/store/session');
const { loadConfig, setConfigKey } = require('../src/store/config');
const { putVaultEntry, getVaultEntry, listVaultEntries, removeVaultEntry } = require('../src/store/vault');
const { HttpClient } = require('../src/client/http');

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

test('HttpClient builds absolute URLs from configured server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-http-'));
  const paths = configPaths(dir);
  setConfigKey('server', 'http://example.test/', paths);
  const client = new HttpClient({ paths });
  assert.equal(client.server, 'http://example.test');
});
