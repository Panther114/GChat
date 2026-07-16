'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const request = require('supertest');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-increment-a-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.SESSION_SECRET = 'integration-test-session-secret-at-least-32-chars';
process.env.GROUP_CODE_PEPPER = 'integration-test-group-code-pepper-32-chars';
process.env.AI_ENABLED = '0';

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
const joinCode = 'integration-secure-room';
const keyCommitment = 'A'.repeat(43);

before(async () => {
  owner = request.agent(app);
  member = request.agent(app);
  const ownerResponse = await register(owner, 'owner-test');
  const ownerCsrf = await csrf(owner);
  const createResponse = await owner
    .post('/api/groups/create')
    .set('X-CSRF-Token', ownerCsrf)
    .send({ name: 'Encrypted room', code: joinCode, keyCommitment })
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

test('authenticated members can recover a device key without storing it plaintext', async () => {
  const recoveryCode = 'recovery-secure-room';
  const secret = crypto.randomBytes(32).toString('base64url');
  const commitment = crypto.createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64url');
  const ownerCsrf = await csrf(owner);
  const created = await owner
    .post('/api/groups/create')
    .set('X-CSRF-Token', ownerCsrf)
    .send({ name: 'Recovery room', code: recoveryCode, keyCommitment: commitment })
    .expect(201);

  const memberJoinCsrf = await csrf(member);
  await member
    .post('/api/groups/join')
    .set('X-CSRF-Token', memberJoinCsrf)
    .send({ code: recoveryCode })
    .expect(200);

  const backupCsrf = await csrf(owner);
  await owner
    .post('/api/groups/keys')
    .set('X-CSRF-Token', backupCsrf)
    .send({ keys: [{ groupId: created.body.id, secret, joinCode: recoveryCode }] })
    .expect(200, { ok: true, saved: 1 });

  const stored = stmts.findGroupById.get(created.body.id);
  assert.equal(stored.key_backup.includes(secret), false);

  const recovered = await member.get('/api/groups/keys').expect(200);
  assert.deepEqual(recovered.body.keys.find((entry) => entry.groupId === created.body.id), {
    groupId: created.body.id,
    secret,
    joinCode: recoveryCode,
  });
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
