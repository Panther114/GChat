'use strict';

/**
 * Integration: real GChatClient modules against in-process server.
 * Never hits Railway production.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { configPaths } = require('../src/store/paths');
const { GChatClient } = require('../src/client/api');
const { decryptServerMessage } = require('../src/client/messages');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-cli-int-'));
const dbPath = path.join(tempDir, 'cli-int.db');
const cliConfigDir = path.join(tempDir, 'cli-home');

process.env.DB_PATH = dbPath;
process.env.SESSION_SECRET = 'cli-integration-session-secret-at-least-32-chars';
process.env.GROUP_CODE_PEPPER = 'cli-integration-group-code-pepper-32ch';
process.env.AI_ENABLED = '0';
process.env.GROUP_KEY_ESCROW_MASTER_KEY = Buffer.alloc(32, 7).toString('base64url');
process.env.NODE_ENV = 'development';
process.env.PORT = '0';

const { db, io, server: httpServer } = require('../../server');

let baseUrl;
let paths;
let client;

before(async () => {
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = httpServer.address();
  baseUrl = `http://127.0.0.1:${port}`;
  paths = configPaths(cliConfigDir);
  client = new GChatClient({ server: baseUrl, paths });
});

after(async () => {
  try {
    client?.disconnectSocket();
  } catch {
    /* ignore */
  }
  try {
    io.close();
  } catch {
    /* ignore */
  }
  await new Promise((resolve) => {
    httpServer.close(() => resolve());
  });
  try {
    db.close();
  } catch {
    /* ignore */
  }
});

test('login → create group → send encrypted text → history decrypts to same plaintext', async () => {
  const username = `cliuser_${Date.now().toString(36)}`;
  const password = 'secure-password-123';
  const user = await client.register(username, password);
  assert.equal(user.username, username);
  assert.ok(user.id);

  const me = await client.me();
  assert.equal(me.username, username);

  const { group, joinCode } = await client.createGroup('CLI Room');
  assert.ok(group.id);
  assert.match(joinCode, /^[a-z0-9]{6}$/);
  assert.ok(client.getSecret(group.id));

  const plaintext = `cli-integration-ping-${Date.now()}`;
  const sent = await client.sendText({
    groupId: group.id,
    text: plaintext,
    channel: 'main',
  });
  assert.ok(sent.messageId);
  assert.equal(sent.envelope.encryptionVersion, 2);
  assert.ok(sent.envelope.encryptedContent);
  assert.equal(sent.envelope.tagIndex, null, '#main is stored with a NULL tag index');

  // Direct decrypt of outbound envelope
  const direct = await decryptServerMessage(sent.envelope, client.getSecret(group.id), group.id);
  assert.equal(direct.text, plaintext);

  // Fetch history from server and decrypt
  const messages = await client.fetchMessages(group.id, { limit: 50 });
  assert.ok(messages.length >= 1);
  const found = messages.find((m) => m.id === sent.messageId);
  assert.ok(found, 'sent message should appear in history');
  const decrypted = await client.decryptMessages(group.id, [found]);
  assert.equal(decrypted[0].text, plaintext);
  assert.equal(decrypted[0].channel, 'main');
});

test('a CLI #main message is cleared by the #main read cursor (no ghost unread)', async () => {
  const suffix = Date.now().toString(36);
  const sender = new GChatClient({ server: baseUrl, paths: configPaths(path.join(tempDir, 'unread-a')) });
  const reader = new GChatClient({ server: baseUrl, paths: configPaths(path.join(tempDir, 'unread-b')) });
  await sender.register(`usnd_${suffix}`, 'secure-password-123');
  await reader.register(`urdr_${suffix}`, 'secure-password-123');
  const { group, joinCode } = await sender.createGroup(`Unread ${suffix}`);
  await reader.joinGroup(joinCode);
  const sent = await sender.sendText({ groupId: group.id, text: 'ping', channel: 'main' });
  const unread = async () => {
    const { body } = await reader.http.get(`/api/groups/${group.id}/unread`);
    return body.groupUnreadCount;
  };
  assert.equal(await unread(), 1);
  const [row] = (await reader.fetchMessages(group.id, { limit: 5 })).filter((m) => m.id === sent.messageId);
  const sock = await reader.connectSocket();
  await new Promise((resolve) => sock.socket.emit('mark_channel_read',
    { groupId: group.id, tagIndex: null, createdAt: row.createdAt, messageId: row.id }, resolve));
  assert.equal(await unread(), 0);
  sender.disconnectSocket();
  reader.disconnectSocket();
});

test('attachments well over the 256 KB JSON limit upload and decrypt', async () => {
  const suffix = Date.now().toString(36);
  const c = new GChatClient({ server: baseUrl, paths: configPaths(path.join(tempDir, 'upload-big')) });
  await c.register(`ubig_${suffix}`, 'secure-password-123');
  const { group } = await c.createGroup(`Upload ${suffix}`);
  const file = path.join(tempDir, 'big.bin');
  fs.writeFileSync(file, Buffer.alloc(900 * 1024, 7));
  const sent = await c.uploadFile(group.id, file);
  assert.equal(sent.type, 'file');
  const out = path.join(tempDir, 'big.out');
  const saved = await c.saveAttachment(group.id, sent.messageId, out);
  assert.equal(saved.bytes, 900 * 1024);
  c.disconnectSocket();
});

test('join group recovers escrowed secret into vault', async () => {
  const ownerPaths = configPaths(path.join(tempDir, 'owner-home'));
  const owner = new GChatClient({ server: baseUrl, paths: ownerPaths });
  const suffix = Date.now().toString(36);
  await owner.register(`owner_${suffix}`, 'secure-password-123');
  const { group, joinCode } = await owner.createGroup(`Join Room ${suffix}`);

  const memberPaths = configPaths(path.join(tempDir, 'member-home'));
  const member = new GChatClient({ server: baseUrl, paths: memberPaths });
  await member.register(`member_${suffix}`, 'secure-password-123');
  const joined = await member.joinGroup(joinCode);
  assert.equal(joined.id, group.id);
  assert.ok(member.getSecret(group.id));

  const keys = await member.syncKeys();
  assert.ok(keys.some((k) => k.groupId === group.id && k.secret));

  owner.disconnectSocket();
  member.disconnectSocket();
});

test('channel stamp survives encrypt/decrypt filter', async () => {
  const paths2 = configPaths(path.join(tempDir, `chan-${Date.now()}`));
  const c = new GChatClient({ server: baseUrl, paths: paths2 });
  await c.register(`chanuser_${Date.now().toString(36)}`, 'secure-password-123');
  const { group } = await c.createGroup('Channel Room');
  c.switchChannel(group.id, 'design');
  const sent = await c.sendText({ groupId: group.id, text: 'in design', channel: 'design' });
  const messages = await c.fetchMessages(group.id, { limit: 20 });
  const found = messages.find((m) => m.id === sent.messageId);
  assert.ok(found);
  const [dec] = await c.decryptMessages(group.id, [found]);
  assert.equal(dec.channel, 'design');
  assert.equal(dec.text, 'in design');
  c.disconnectSocket();
});
