'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const request = require('supertest');
const crypto = require('node:crypto');
const { purgePreEscrowGroups } = require('../src/server/legacy-group-purge');
const { migrateGroupCodes } = require('../src/server/group-code-migration');
const { decryptEscrowPayload, encryptEscrowPayload } = require('../src/server/group-key-escrow');
const { hashJoinCode } = require('../src/server/group-security');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-increment-a-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.SESSION_SECRET = 'integration-test-session-secret-at-least-32-chars';
process.env.GROUP_CODE_PEPPER = 'integration-test-group-code-pepper-32-chars';
process.env.AI_ENABLED = '0';
process.env.GROUP_KEY_ESCROW_MASTER_KEY = Buffer.alloc(32, 4).toString('base64url');

const { app, db, io, stmts } = require('../server');

async function csrf(agent) {
  const response = await agent.get('/api/auth/csrf').expect(200);
  return response.body.csrfToken;
}

async function register(agent, username) {
  return agent.post('/api/auth/register').send({ username, password: 'secure-password-123' }).expect(201);
}

let owner;
let member;
let group;
const joinCode = 'room01';
const groupSecret = Buffer.alloc(32, 5).toString('base64url');
const keyCommitment = crypto.createHash('sha256').update(Buffer.from(groupSecret, 'base64url')).digest('base64url');

before(async () => {
  owner = request.agent(app);
  member = request.agent(app);
  const ownerResponse = await register(owner, 'owner-test');
  const ownerCsrf = await csrf(owner);
  const createResponse = await owner
    .post('/api/groups/create')
    .set('X-CSRF-Token', ownerCsrf)
    .send({ name: 'Encrypted room', code: joinCode, secret: groupSecret, keyCommitment })
    .expect(201);
  group = { ...createResponse.body, ownerId: ownerResponse.body.id };
  const memberResponse = await register(member, 'member-test');
  group.memberId = memberResponse.body.id;
  const memberCsrf = await csrf(member);
  await member
    .post('/api/groups/join')
    .set('X-CSRF-Token', memberCsrf)
    .send({ code: joinCode })
    .expect(200);
});

after(() => {
  io.close();
  db.close();
});

test('group API never returns the plaintext join code and stores only its HMAC', async () => {
  assert.equal(group.code, undefined);
  assert.equal(group.encryptionVersion, 2);
  assert.equal(group.keyCommitment, keyCommitment);
  const stored = stmts.findGroupById.get(group.id);
  assert.notEqual(stored.code, joinCode);
  assert.match(stored.code, /^[a-f0-9]{64}$/);
});

test('group key recovery is membership-scoped and escrow data is not stored in plaintext', async () => {
  const ownerKeys = await owner.get('/api/groups/keys').expect(200);
  assert.deepEqual(ownerKeys.body, { keys: [{ groupId: group.id, secret: groupSecret, joinCode }] });
  assert.match(ownerKeys.headers['cache-control'], /no-store/);

  const freshDevice = request.agent(app);
  await freshDevice.post('/api/auth/login').send({ username: 'owner-test', password: 'secure-password-123' }).expect(200);
  const recovered = await freshDevice.get('/api/groups/keys').expect(200);
  assert.deepEqual(recovered.body, ownerKeys.body);

  const stored = stmts.findGroupById.get(group.id);
  assert.equal(stored.key_escrow_ciphertext.includes(groupSecret), false);
  assert.equal(stored.key_escrow_ciphertext.includes(joinCode), false);
  assert.match(stored.key_escrow_iv, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(stored.key_escrow_version, 1);
});

test('joining by invite code grants membership and returns escrowed key material', async () => {
  const attacker = request.agent(app);
  const attackerResponse = await register(attacker, 'attacker-test');
  const attackerCsrf = await csrf(attacker);
  const joined = await attacker
    .post('/api/groups/join')
    .set('X-CSRF-Token', attackerCsrf)
    .send({ code: joinCode })
    .expect(200);
  assert.equal(joined.body.secret, groupSecret);
  assert.ok(stmts.isMember.get(group.id, attackerResponse.body.id));
  await attacker.get('/api/groups/keys').expect(200, { keys: [{ groupId: group.id, secret: groupSecret, joinCode }] });
});

test('explicit invite-code migration preserves the encryption secret and is idempotent', () => {
  const masterKey = Buffer.alloc(32, 4);
  const legacyEscrow = encryptEscrowPayload(masterKey, group.id, { secret: groupSecret, joinCode: 'legacy-room' });
  const legacyCodeHash = crypto.createHmac('sha256', process.env.GROUP_CODE_PEPPER).update('legacy-room', 'utf8').digest('hex');
  db.prepare('UPDATE group_chats SET code = ?, key_escrow_ciphertext = ?, key_escrow_iv = ?, key_escrow_version = ? WHERE id = ?')
    .run(legacyCodeHash, legacyEscrow.ciphertext, legacyEscrow.iv, legacyEscrow.version, group.id);
  const result = migrateGroupCodes(db, {
    groupCodePepper: process.env.GROUP_CODE_PEPPER,
    groupKeyEscrowMasterKey: masterKey,
    generateCode: () => 'migr8a',
  });
  assert.deepEqual(result, { migrated: 1 });
  const stored = stmts.findGroupById.get(group.id);
  const payload = decryptEscrowPayload(masterKey, group.id, {
    ciphertext: stored.key_escrow_ciphertext,
    iv: stored.key_escrow_iv,
    version: stored.key_escrow_version,
  });
  assert.equal(payload.secret, groupSecret);
  assert.equal(payload.joinCode, 'migr8a');
  assert.equal(stored.code, hashJoinCode('migr8a', process.env.GROUP_CODE_PEPPER));
  assert.deepEqual(migrateGroupCodes(db, {
    groupCodePepper: process.env.GROUP_CODE_PEPPER,
    groupKeyEscrowMasterKey: masterKey,
    generateCode: () => 'migr8a',
  }), { migrated: 0 });
});

test('legacy purge removes only pre-escrow groups and their dependent records', () => {
  const legacyGroupId = 'legacy-group-for-purge';
  const legacyMessageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  db.prepare('INSERT INTO group_chats (id, name, code, created_by) VALUES (?, ?, ?, ?)')
    .run(legacyGroupId, 'Legacy room', 'f'.repeat(64), group.ownerId);
  stmts.insertMember.run(legacyGroupId, group.ownerId);
  db.prepare('INSERT INTO messages (id, group_id, sender_id, encrypted_content, iv) VALUES (?, ?, ?, ?, ?)')
    .run(legacyMessageId, legacyGroupId, group.ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA');
  stmts.markMessageRead.run(legacyMessageId, group.memberId);
  db.prepare('INSERT INTO disappearing_message_states (message_id, user_id) VALUES (?, ?)').run(legacyMessageId, group.memberId);
  db.prepare('INSERT INTO ai_usage_events (id, user_id, group_id) VALUES (?, ?, ?)')
    .run('legacy-ai-usage', group.ownerId, legacyGroupId);

  const result = purgePreEscrowGroups(db);
  assert.deepEqual(result, { groups: 1, messages: 1, memberships: 1, aiUsageEvents: 1 });
  assert.equal(stmts.findGroupById.get(legacyGroupId), undefined);
  assert.equal(stmts.findMessageById.get(legacyMessageId), undefined);
  assert.equal(stmts.findGroupById.get(group.id).key_escrow_version, 1);
});

test('AI routes are unavailable while the feature flag is disabled', async () => {
  await owner.get('/api/ai/tones').expect(404, { error: 'AI is unavailable' });
});

test('message deletion is author-only and transactionally removes dependent state', async () => {
  const messageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  stmts.insertV2Message.run(
    messageId, group.id, group.ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null,
    null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null
  );
  stmts.markMessageRead.run(messageId, group.memberId);

  const memberCsrf = await csrf(member);
  await member
    .delete(`/api/groups/${group.id}/messages/${messageId}`)
    .set('X-CSRF-Token', memberCsrf)
    .expect(403);

  const ownerCsrf = await csrf(owner);
  await owner
    .delete(`/api/groups/${group.id}/messages/${messageId}`)
    .set('X-CSRF-Token', ownerCsrf)
    .expect(200);
  assert.equal(stmts.findMessageById.get(messageId), undefined);
  assert.equal(stmts.getMessageReadCount.get(messageId).count, 0);
});
