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
const { decryptEscrowPayload, encryptEscrowPayload, parseEscrowMasterKey } = require('../src/server/group-key-escrow');
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

// The shared HTTP server may already be listening from an earlier socket test.
async function ensureServerListening() {
  const { server } = require('../server');
  if (server.listening) return `http://localhost:${server.address().port}`;
  await new Promise((resolve) => server.listen(0, resolve));
  return `http://localhost:${server.address().port}`;
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

test('identity payloads keep avatars compact and protected avatar bytes are cacheable', async () => {
  const picture = 'data:image/png;base64,aW1hZ2UtYnl0ZXM=';
  const ownerCsrf = await csrf(owner);
  const updated = await owner
    .patch('/api/auth/profile')
    .set('X-CSRF-Token', ownerCsrf)
    .send({ profilePicture: picture })
    .expect(200);

  const assertCompact = (payload) => {
    const json = JSON.stringify(payload);
    assert.equal(json.includes(picture), false);
    assert.equal(json.includes('image-bytes'), false);
  };

  assertCompact(updated.body);
  assert.equal(updated.body.profilePicture, null);
  assert.equal(updated.body.hasProfilePicture, true);
  assert.match(updated.body.profilePictureUrl, /^\/api\/profile-pictures\/.+\?v=/);
  assert.ok(updated.body.profilePictureVersion);

  const loginAgent = request.agent(app);
  const login = await loginAgent
    .post('/api/auth/login')
    .send({ username: 'owner-test', password: 'secure-password-123' })
    .expect(200);
  assertCompact(login.body);
  assertCompact((await owner.get('/api/auth/me').expect(200)).body);

  const members = await member.get(`/api/groups/${group.id}/members`).expect(200);
  assertCompact(members.body);
  const ownerMember = members.body.find((entry) => entry.id === ownerResponseId());
  assert.ok(ownerMember);
  assert.equal(ownerMember.profilePicture, null);
  assert.equal(ownerMember.profilePictureUrl, updated.body.profilePictureUrl);
  assert.ok(Buffer.byteLength(JSON.stringify(members.body)) < 32 * 1024);

  const preload = await owner.get('/api/groups/preload?limit=1').expect(200);
  assertCompact(preload.body);
  assert.ok(Buffer.byteLength(JSON.stringify(preload.body)) < 64 * 1024);

  process.env.ADMIN_SECRET = 'integration-admin-secret';
  try {
    const admin = await owner
      .get('/api/admin/users')
      .set('Authorization', 'Bearer integration-admin-secret')
      .expect(200);
    assertCompact(admin.body);
  } finally {
    delete process.env.ADMIN_SECRET;
  }

  const management = await owner.get('/api/users/management').expect(200);
  assertCompact(management.body);

  const avatar = await member.get(updated.body.profilePictureUrl).expect(200);
  assert.equal(avatar.headers['content-type'], 'image/png');
  assert.match(avatar.headers['cache-control'], /private/);
  assert.ok(avatar.headers.etag);
  assert.deepEqual(avatar.body, Buffer.from('image-bytes'));
  await member
    .get(updated.body.profilePictureUrl)
    .set('If-None-Match', avatar.headers.etag)
    .expect(304);

  const outsider = request.agent(app);
  const outsiderResponse = await register(outsider, 'picture-outsider-test');
  // Every normal account is in GChat Global; remove the test account from the
  // shared room so this assertion exercises the authorization boundary itself.
  stmts.deleteMember.run('gchat-global', outsiderResponse.body.id);
  await outsider.get(updated.body.profilePictureUrl).expect(403);
  await owner.get('/api/profile-pictures/not-a-user').expect(404);
  await request(app).get(updated.body.profilePictureUrl).expect(401);
});

function ownerResponseId() {
  return stmts.findUserByUsername.get('owner-test').id;
}

test('sync-v2 bootstrap is summary-only, bounded, and conditionally cacheable', async () => {
  const response = await owner.get('/api/sync/bootstrap').expect(200);
  assert.equal(response.body.protocol, 2);
  const summary = response.body.groups.find((entry) => entry.id === group.id);
  assert.ok(summary);
  assert.equal(summary.epoch, 1);
  assert.ok(summary.latestSeq >= 1);
  assert.ok(summary.membershipRevision >= 1);
  assert.equal(summary.messages, undefined);
  assert.equal(summary.members, undefined);
  assert.ok(response.headers.etag);
  assert.ok(Buffer.byteLength(JSON.stringify(response.body)) < 64 * 1024);
  await owner.get('/api/sync/bootstrap').set('If-None-Match', response.headers.etag).expect(304);
});

test('group key recovery is membership-scoped and escrow data is not stored in plaintext', async () => {
  const ownerKeys = await owner.get('/api/groups/keys').expect(200);
  const keysByGroupId = Object.fromEntries(ownerKeys.body.keys.map((key) => [key.groupId, key]));
  assert.deepEqual(keysByGroupId[group.id], { groupId: group.id, secret: groupSecret, joinCode });
  // Every user also holds the GChat Global escrow key material.
  assert.ok(keysByGroupId['gchat-global']);
  assert.match(keysByGroupId['gchat-global'].secret, /^[A-Za-z0-9_-]{43}$/);
  assert.match(keysByGroupId['gchat-global'].joinCode, /^[a-z0-9]{6}$/);
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
  const attackerKeys = await attacker.get('/api/groups/keys').expect(200);
  const attackerKeysByGroupId = Object.fromEntries(attackerKeys.body.keys.map((key) => [key.groupId, key]));
  assert.deepEqual(attackerKeysByGroupId[group.id], { groupId: group.id, secret: groupSecret, joinCode });
  assert.ok(attackerKeysByGroupId['gchat-global']);
  const repeatedJoin = await attacker
    .post('/api/groups/join')
    .set('X-CSRF-Token', attackerCsrf)
    .send({ code: joinCode })
    .expect(200);
  assert.equal(repeatedJoin.body.alreadyJoined, true);
});

test('only owners manage administrator roles and administrators receive bounded elevated permissions', async () => {
  const memberCsrf = await csrf(member);
  await member
    .patch(`/api/groups/${group.id}/settings`)
    .set('X-CSRF-Token', memberCsrf)
    .send({ allowMemberExport: true })
    .expect(403);

  const ownerCsrf = await csrf(owner);
  const roleResponse = await owner
    .patch(`/api/groups/${group.id}/members/${group.memberId}/administrator`)
    .set('X-CSRF-Token', ownerCsrf)
    .send({ isAdministrator: true })
    .expect(200);
  assert.equal(roleResponse.body.ok, true);
  assert.equal(roleResponse.body.isAdministrator, true);
  assert.ok(roleResponse.body.seq > 0);

  const memberList = await member.get(`/api/groups/${group.id}/members`).expect(200);
  assert.equal(memberList.body.find((entry) => entry.id === group.memberId).isAdministrator, true);
  const memberGroups = await member.get('/api/groups/mine').expect(200);
  assert.equal(memberGroups.body.find((entry) => entry.id === group.id).viewerIsAdmin, true);

  await member
    .patch(`/api/groups/${group.id}/settings`)
    .set('X-CSRF-Token', memberCsrf)
    .send({ allowMemberExport: true })
    .expect(200, { ok: true });

  const secondAdmin = request.agent(app);
  const secondAdminResponse = await register(secondAdmin, 'second-admin-test');
  const secondAdminCsrf = await csrf(secondAdmin);
  await secondAdmin
    .post('/api/groups/join')
    .set('X-CSRF-Token', secondAdminCsrf)
    .send({ code: joinCode })
    .expect(200);
  await owner
    .patch(`/api/groups/${group.id}/members/${secondAdminResponse.body.id}/administrator`)
    .set('X-CSRF-Token', ownerCsrf)
    .send({ isAdministrator: true })
    .expect(200);

  await member
    .delete(`/api/groups/${group.id}/members/${secondAdminResponse.body.id}`)
    .set('X-CSRF-Token', memberCsrf)
    .expect(403, { error: 'Administrators cannot remove other administrators' });

  const demoteResponse = await owner
    .patch(`/api/groups/${group.id}/members/${group.memberId}/administrator`)
    .set('X-CSRF-Token', ownerCsrf)
    .send({ isAdministrator: false })
    .expect(200);
  assert.equal(demoteResponse.body.ok, true);
  assert.equal(demoteResponse.body.isAdministrator, false);
  assert.equal(demoteResponse.body.epoch, 1);
  assert.equal(Number.isInteger(demoteResponse.body.seq), true);
  assert.equal(typeof demoteResponse.body.clientMutationId, 'string');
  await member
    .patch(`/api/groups/${group.id}/settings`)
    .set('X-CSRF-Token', memberCsrf)
    .send({ allowMemberExport: false })
    .expect(403);
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

test('v1.4.3 channels endpoint lists distinct blind tag indexes with sample messages', async () => {
  const tagA = 'A'.repeat(43);
  const tagB = 'B'.repeat(43);
  const ids = [
    'cccccccc-0000-4ccc-8ccc-cccccccccc01',
    'cccccccc-0000-4ccc-8ccc-cccccccccc02',
    'cccccccc-0000-4ccc-8ccc-cccccccccc03',
  ];
  stmts.insertV2Message.run(
    ids[0], group.id, group.ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null,
    null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', tagA, null,
    '2026-02-01T00:00:00.000Z'
  );
  stmts.insertV2Message.run(
    ids[1], group.id, group.ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null,
    null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', tagB, null,
    '2026-02-02T00:00:00.000Z'
  );
  // #main (NULL tag index) must never be listed.
  stmts.insertV2Message.run(
    ids[2], group.id, group.ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null,
    null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null,
    '2026-02-03T00:00:00.000Z'
  );
  const insertSummary = db.prepare(`
    INSERT OR REPLACE INTO group_channels (
      group_id, channel_key, last_message_id, last_message_at, message_count
    ) VALUES (?, ?, ?, ?, ?)
  `);
  insertSummary.run(group.id, tagA, ids[0], '2026-02-01T00:00:00.000Z', 1);
  insertSummary.run(group.id, tagB, ids[1], '2026-02-02T00:00:00.000Z', 1);

  const res = await owner.get(`/api/groups/${group.id}/channels`).expect(200);
  assert.equal(res.body.ok, true);
  const channels = res.body.channels;
  assert.equal(channels.length, 2);
  const byTag = Object.fromEntries(channels.map((c) => [c.tagIndex, c]));
  assert.equal(byTag[tagA].sampleMessageId, ids[0]);
  assert.equal(byTag[tagA].sampleMessage.id, ids[0]);
  assert.equal(byTag[tagA].messageCount, 1);
  assert.equal(byTag[tagB].sampleMessageId, ids[1]);
  assert.ok(byTag[tagB].lastMessageAt >= byTag[tagA].lastMessageAt);

  const ownerCsrf = await csrf(owner);
  await owner
    .delete(`/api/groups/${group.id}/messages/${ids[0]}`)
    .set('X-CSRF-Token', ownerCsrf)
    .expect(200);
  const afterDelete = await owner.get(`/api/groups/${group.id}/channels`).expect(200);
  assert.deepEqual(afterDelete.body.channels.map((channel) => channel.tagIndex), [tagB]);

  await owner
    .delete(`/api/groups/${group.id}/tags/${tagB}/messages`)
    .set('X-CSRF-Token', ownerCsrf)
    .expect(200);
  const afterClear = await owner.get(`/api/groups/${group.id}/channels`).expect(200);
  assert.deepEqual(afterClear.body.channels, []);

  // Membership is enforced.
  const outsider = request.agent(app);
  await register(outsider, 'channels-outsider');
  await outsider.get(`/api/groups/${group.id}/channels`).expect(403);
});

test('v1.4.3 uploads can carry a reply target', async () => {
  const targetMessageId = '99999999-9999-4999-8999-999999999901';
  stmts.insertV2Message.run(
    targetMessageId, group.id, group.ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null,
    null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null,
    '2026-03-01T00:00:00.000Z'
  );
  const ownerCsrf = await csrf(owner);
  const uploadId = '88888888-8888-4888-8888-888888888801';
  await owner
    .post(`/api/groups/${group.id}/upload`)
    .set('X-CSRF-Token', ownerCsrf)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Upload-IV', 'AAAAAAAAAAAAAAAA')
    .set('X-Upload-Type', 'file')
    .set('X-Message-Id', uploadId)
    .set('X-Encrypted-Metadata', Buffer.from('metadata').toString('base64'))
    .set('X-Metadata-IV', 'AAAAAAAAAAAAAAAA')
    .set('X-Encryption-Version', '2')
    .set('X-Key-Version', '1')
    .set('X-Reply-To-Id', targetMessageId)
    .send(Buffer.from('encrypted-bytes'))
    .expect(200);
  const stored = stmts.findMessageById.get(uploadId);
  assert.equal(stored.reply_to_id, targetMessageId);

  // Unknown reply targets are rejected and nothing is persisted.
  const badUploadId = '88888888-8888-4888-8888-888888888802';
  await owner
    .post(`/api/groups/${group.id}/upload`)
    .set('X-CSRF-Token', ownerCsrf)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Upload-IV', 'AAAAAAAAAAAAAAAA')
    .set('X-Upload-Type', 'file')
    .set('X-Message-Id', badUploadId)
    .set('X-Encrypted-Metadata', Buffer.from('metadata').toString('base64'))
    .set('X-Metadata-IV', 'AAAAAAAAAAAAAAAA')
    .set('X-Encryption-Version', '2')
    .set('X-Key-Version', '1')
    .set('X-Reply-To-Id', 'missing-target')
    .send(Buffer.from('encrypted-bytes'))
    .expect(400);
  assert.equal(stmts.findMessageById.get(badUploadId), undefined);
});

test('v1.4.3 AI assistant messages serialize with the GChat AI display name', async () => {
  const aiMessageId = '77777777-7777-4777-8777-777777777701';
  stmts.insertV2Message.run(
    aiMessageId, group.id, '__gchat_ai_grok__', 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null,
    null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null,
    '2026-04-01T00:00:00.000Z'
  );
  const res = await owner.get(`/api/groups/${group.id}/messages/${aiMessageId}`).expect(200);
  assert.equal(res.body.senderName, 'GChat AI');
});

test('message deletion is author-only and creates a recoverable tombstone event', async () => {
  const messageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  stmts.insertV2Message.run(
    messageId, group.id, group.ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null,
    null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null,
    '2026-01-01T00:00:00.000Z'
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
  const deleted = stmts.findMessageById.get(messageId);
  assert.ok(deleted.deleted_at);
  assert.equal(deleted.deleted_by, group.ownerId);
  assert.equal(deleted.revision, 2);
  await owner.get(`/api/groups/${group.id}/messages/${messageId}`).expect(404);
  const delta = await owner.get(`/api/groups/${group.id}/sync?epoch=1&after=0&limit=200`).expect(200);
  const deletedEvent = delta.body.events.find((event) => event.entityId === messageId);
  assert.equal(deletedEvent.type, 'message.deleted');
  assert.equal(deletedEvent.revision, 2);
});

test('incremental since-cursor sync returns only newer messages in ascending order', async () => {
  const base = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb';
  const ids = [1, 2, 3].map((n) => `${base}${n}`);
  for (const id of ids) {
    stmts.insertV2Message.run(
      id, group.id, group.ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null,
      null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null,
      '2030-01-01T00:00:00.000Z'
    );
  }
  const setTime = db.prepare('UPDATE messages SET created_at = ? WHERE id = ?');
  setTime.run('2030-01-01T10:00:00.000Z', ids[0]);
  setTime.run('2030-01-01T10:01:00.000Z', ids[1]);
  setTime.run('2030-01-01T10:02:00.000Z', ids[2]);

  const afterSecond = await owner
    .get(`/api/groups/${group.id}/messages?since=2030-01-01T10:01:00.000Z&sinceId=${ids[1]}`)
    .expect(200);
  assert.deepEqual(afterSecond.body.map((m) => m.id), [ids[2]]);

  const afterFirst = await owner
    .get(`/api/groups/${group.id}/messages?since=2030-01-01T10:00:00.000Z&sinceId=${ids[0]}`)
    .expect(200);
  assert.deepEqual(afterFirst.body.map((m) => m.id), [ids[1], ids[2]]);

  // v1.3.12: a cursor WITHOUT the id tie-break must still include every
  // message at the boundary timestamp (previously `created_at > since` skipped
  // them forever — the "missing chunks" root cause).
  const legacyCursor = await owner
    .get(`/api/groups/${group.id}/messages?since=2030-01-01T10:01:00.000Z`)
    .expect(200);
  assert.deepEqual(legacyCursor.body.map((m) => m.id), [ids[1], ids[2]]);
});

test('composite since-cursor never skips messages sharing the boundary millisecond', async () => {
  // H1 regression: two messages with the SAME created_at; the cursor points at
  // the first one. A time-only cursor would skip the second FOREVER (and each
  // device missed different messages). The composite (created_at, id) cursor
  // includes it via the id tie-break.
  const base = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd';
  const sameMs = '2031-05-05T05:05:05.000Z';
  const idA = `${base}0`;
  const idB = `${base}1`;
  stmts.insertV2Message.run(
    idA, group.id, group.ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null,
    null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null, sameMs
  );
  stmts.insertV2Message.run(
    idB, group.id, group.ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null,
    null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null, sameMs
  );

  // Cursor at (sameMs, idA) → idB (same millisecond, larger id) must be returned.
  const boundary = await owner
    .get(`/api/groups/${group.id}/messages?since=${encodeURIComponent(sameMs)}&sinceId=${idA}`)
    .expect(200);
  assert.deepEqual(boundary.body.map((m) => m.id), [idB]);

  // Cursor at (sameMs, idB) → nothing more at this boundary.
  const pastBoundary = await owner
    .get(`/api/groups/${group.id}/messages?since=${encodeURIComponent(sameMs)}&sinceId=${idB}`)
    .expect(200);
  assert.deepEqual(pastBoundary.body.map((m) => m.id), []);
});

test('real-send created_at is ISO and the broadcast cursor drives the since-sync (no format drift)', async () => {
  // Regression guard for the root cause of "messages disappear on resync":
  // inserts used to fall back to SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS")
  // while broadcasts sent new Date().toISOString() ("YYYY-MM-DDTHH:MM:SS.sssZ").
  // A T-format cursor against space-format rows made `?since=` return nothing.
  const { io: socketClient } = require('socket.io-client');
  const url = await ensureServerListening();

  const agent = request.agent(app);
  const agentResponse = await register(agent, 'cursor-sync-test');
  const agentCsrf = await csrf(agent);
  const secret = Buffer.alloc(32, 7).toString('base64url');
  const commitment = crypto.createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64url');
  const created = await agent
    .post('/api/groups/create')
    .set('X-CSRF-Token', agentCsrf)
    .send({ name: 'Cursor room', code: 'curs01', secret, keyCommitment: commitment })
    .expect(201);
  const groupId = created.body.id;

  const cookie = agentResponse.headers['set-cookie'][0].split(';')[0];
  const sock = socketClient(url, { transports: ['polling'], extraHeaders: { Cookie: cookie } });
  await new Promise((resolve) => sock.on('connect', resolve));
  sock.emit('join_room', groupId);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const received = [];
  sock.on('sync_event', (event) => {
    if (event.type === 'message.created' && event.message) received.push(event.message);
  });

  const sendOne = (id) => new Promise((resolve) => {
    sock.emit('send_message', {
      id, groupId, encryptedContent: 'AAAA', iv: 'AAAAAAAAAAAAAAAA',
      encryptedMetadata: 'AAAA', metadataIv: 'AAAAAAAAAAAAAAAA',
      replyToId: null, tagIndex: null, isDisappearing: false, disappearingDurationMs: 0,
      encryptionVersion: 2, keyVersion: 1, revision: 1,
    }, resolve);
    setTimeout(() => resolve('NO_ACK'), 4000);
  });

  const idA = crypto.randomUUID();
  const ackA = await sendOne(idA);
  assert.equal(ackA.ok, true);
  assert.equal(ackA.messageId, idA);
  // Let the broadcast settle so the cursor message is captured before sending B.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const idB = crypto.randomUUID();
  const ackB = await sendOne(idB);
  assert.equal(ackB.ok, true);
  assert.equal(ackB.messageId, idB);
  await new Promise((resolve) => setTimeout(resolve, 50));

  // The broadcast createdAt must be ISO (T separator + Z suffix)…
  const msgA = received.find((m) => m.id === idA);
  const msgB = received.find((m) => m.id === idB);
  assert.ok(msgA && msgB, 'both broadcasts should be received');
  assert.ok(/T.*Z$/.test(msgA.createdAt), `broadcast createdAt must be ISO, got ${msgA.createdAt}`);
  // …and the DB must store the SAME ISO format (no space-separated drift).
  const dbRowA = stmts.findMessageById.get(idA);
  assert.ok(/T.*Z$/.test(dbRowA.created_at), `DB created_at must be ISO, got ${dbRowA.created_at}`);

  // The composite incremental cursor (created_at + id) keyed on the broadcast
  // must return exactly B — the id tie-break makes the boundary deterministic.
  const afterA = await agent
    .get(`/api/groups/${groupId}/messages?since=${encodeURIComponent(msgA.createdAt)}&sinceId=${idA}`)
    .expect(200);
  assert.deepEqual(afterA.body.map((m) => m.id), [idB]);

  // A legacy space-format cursor is normalized and still surfaces newer
  // messages (defensive; without an id tie-break it also re-includes A).
  const legacyCursor = dbRowA.created_at.replace('T', ' ').replace(/\.\d{3}Z$/, '');
  const afterLegacy = await agent
    .get(`/api/groups/${groupId}/messages?since=${encodeURIComponent(legacyCursor)}`)
    .expect(200);
  assert.ok(afterLegacy.body.some((m) => m.id === idB), 'legacy cursor must still surface newer messages');

  sock.close();
});

test('quotes to deleted targets are accepted and marked replyTargetMissing', async () => {
  const quotedId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const msgId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  stmts.insertV2Message.run(
    msgId, group.id, group.ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', quotedId,
    null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null,
    '2030-01-01T11:00:00.000Z'
  );
  db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run('2030-01-01T11:00:00.000Z', msgId);

  const res = await owner.get(`/api/groups/${group.id}/messages?limit=100`).expect(200);
  const found = res.body.find((m) => m.id === msgId);
  assert.ok(found, 'quoted message row should be present');
  assert.equal(found.replyToId, quotedId);
  assert.equal(found.replyTargetMissing, true);

  // A quote of an existing message is NOT marked missing.
  const existing = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  stmts.insertV2Message.run(
    existing, group.id, group.ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', msgId,
    null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null,
    '2030-01-01T11:01:00.000Z'
  );
  db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run('2030-01-01T11:01:00.000Z', existing);
  const res2 = await owner.get(`/api/groups/${group.id}/messages?limit=100`).expect(200);
  const found2 = res2.body.find((m) => m.id === existing);
  assert.equal(found2.replyTargetMissing, undefined);
});

test('single-message quote hydration enforces membership and whisper visibility', async () => {
  const msgId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const asMember = await member.get(`/api/groups/${group.id}/messages/${msgId}`).expect(200);
  assert.equal(asMember.body.id, msgId);

  const outsider = request.agent(app);
  await register(outsider, 'quote-outsider');
  await outsider.get(`/api/groups/${group.id}/messages/${msgId}`).expect(403);

  // Whisper visible only to the sender and listed recipients.
  const whisperId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  stmts.insertV2Message.run(
    whisperId, group.id, group.ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'whisper', null,
    JSON.stringify([group.memberId]), 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null,
    '2026-01-01T00:00:00.000Z'
  );
  const asOwner = await owner.get(`/api/groups/${group.id}/messages/${whisperId}`).expect(200);
  assert.equal(asOwner.body.id, whisperId);
  const asRecipient = await member.get(`/api/groups/${group.id}/messages/${whisperId}`).expect(200);
  assert.equal(asRecipient.body.id, whisperId);

  const otherMember = request.agent(app);
  await register(otherMember, 'quote-other-member');
  const otherCsrf = await csrf(otherMember);
  // The invite-code migration test above rehashed this group's code to
  // 'migr8a' — join with the current code.
  await otherMember
    .post('/api/groups/join')
    .set('X-CSRF-Token', otherCsrf)
    .send({ code: 'migr8a' })
    .expect(200);
  await otherMember.get(`/api/groups/${group.id}/messages/${whisperId}`).expect(404);
});

test('login issues a 30-day persistent session cookie so users are not logged out by inactivity', async () => {
  const fresh = request.agent(app);
  const registerResponse = await register(fresh, 'cookie-user-test');
  const setCookie = registerResponse.headers['set-cookie'] || [];
  const sessionCookie = setCookie.find((header) => header.includes('connect.sid'));
  assert.ok(sessionCookie, `expected a session cookie, got: ${setCookie.join(' | ')}`);
  const expiresMatch = /Expires=([^;]+)/.exec(sessionCookie);
  assert.ok(expiresMatch, `expected an Expires attribute, got: ${sessionCookie}`);
  const expiresAt = new Date(expiresMatch[1]).getTime();
  assert.ok(
    expiresAt > Date.now() + 25 * 24 * 60 * 60 * 1000,
    `expected ~30-day cookie expiry, got: ${expiresMatch[1]}`
  );
});

test('GChat Global auto-joins every user, has no owner, and cannot be left', async () => {
  const globalGroup = stmts.findGroupById.get('gchat-global');
  assert.ok(globalGroup);
  assert.equal(globalGroup.created_by, '__gchat_global_owner__');

  const fresh = request.agent(app);
  const freshResponse = await register(fresh, 'global-fresh-user');
  assert.ok(stmts.isMember.get('gchat-global', freshResponse.body.id));

  const mine = await fresh.get('/api/groups/mine').expect(200);
  const globalPayload = mine.body.find((g) => g.isGlobal === true);
  assert.equal(globalPayload.name, 'GChat Global');
  assert.equal(globalPayload.createdBy, '__gchat_global_owner__');
  assert.equal(globalPayload.viewerIsAdmin, false);
  assert.equal(globalPayload.allowMemberInvite, true);

  const globalCsrf = await csrf(fresh);
  await fresh
    .delete('/api/groups/gchat-global/leave')
    .set('X-CSRF-Token', globalCsrf)
    .expect(400, { error: 'You cannot leave GChat Global' });
  await fresh
    .patch('/api/groups/gchat-global/settings')
    .set('X-CSRF-Token', globalCsrf)
    .send({ allowMemberExport: true })
    .expect(403);
  await fresh
    .patch('/api/groups/gchat-global/name')
    .set('X-CSRF-Token', globalCsrf)
    .send({ name: 'Renamed' })
    .expect(400);
});

test('any GChat Global member can delete any message and set memberships stay bounded', async () => {
  const memberA = request.agent(app);
  const memberAResponse = await register(memberA, 'global-member-a');
  const memberB = request.agent(app);
  await register(memberB, 'global-member-b');
  const messageId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  stmts.insertV2Message.run(
    messageId, 'gchat-global', memberAResponse.body.id, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null,
    null, 0, null, 2, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null,
    '2026-01-01T00:00:00.000Z'
  );
  const memberBCsrf = await csrf(memberB);
  await memberB
    .delete('/api/groups/gchat-global/messages/' + messageId)
    .set('X-CSRF-Token', memberBCsrf)
    .expect(200);
  assert.ok(stmts.findMessageById.get(messageId).deleted_at);
  // The phantom sentinel owner must never appear as a member.
  const memberIds = stmts.getGroupMemberIds.all('gchat-global').map((row) => row.user_id);
  assert.ok(!memberIds.includes('__gchat_global_owner__'));
});

test('invite permission defaults on, admin-only when disabled, and enforces caps', async () => {
  const inviter = request.agent(app);
  await register(inviter, 'inviter-test');
  const target = request.agent(app);
  const targetResponse = await register(target, 'invitee-test');

  const inviterCsrf = await csrf(inviter);
  const createResponse = await inviter
    .post('/api/groups/create')
    .set('X-CSRF-Token', inviterCsrf)
    .send({ name: 'Invite room', code: 'invt01', secret: groupSecret, keyCommitment })
    .expect(201);
  const inviteRoomId = createResponse.body.id;

  // "Invite members" defaults ON — any member can invite.
  assert.equal(createResponse.body.allowMemberInvite, true);

  const candidates = await inviter
    .get(`/api/groups/invite-candidates/${targetResponse.body.id}`)
    .expect(200);
  assert.ok(candidates.body.some((group) => group.id === inviteRoomId));
  assert.ok(!candidates.body.some((group) => group.id === 'gchat-global'));

  const inviteResponse = await inviter
    .post(`/api/groups/${inviteRoomId}/invite`)
    .set('X-CSRF-Token', inviterCsrf)
    .send({ userId: targetResponse.body.id })
    .expect(200);
  assert.equal(inviteResponse.body.ok, true);
  assert.ok(inviteResponse.body.seq > 0);
  assert.ok(stmts.isMember.get(inviteRoomId, targetResponse.body.id));
  await inviter
    .post(`/api/groups/${inviteRoomId}/invite`)
    .set('X-CSRF-Token', inviterCsrf)
    .send({ userId: targetResponse.body.id })
    .expect(409);

  // After disabling the permission, a regular member cannot invite…
  await inviter
    .patch(`/api/groups/${inviteRoomId}/settings`)
    .set('X-CSRF-Token', inviterCsrf)
    .send({ allowMemberInvite: false })
    .expect(200);
  const bystander = request.agent(app);
  await register(bystander, 'bystander-test');
  const bystanderCsrf = await csrf(bystander);
  await bystander
    .post('/api/groups/join')
    .set('X-CSRF-Token', bystanderCsrf)
    .send({ code: 'invt01' })
    .expect(200);
  const secondTarget = request.agent(app);
  const secondTargetResponse = await register(secondTarget, 'invitee-2-test');
  await bystander
    .post(`/api/groups/${inviteRoomId}/invite`)
    .set('X-CSRF-Token', bystanderCsrf)
    .send({ userId: secondTargetResponse.body.id })
    .expect(403);

  // …but the owner always can.
  await inviter
    .post(`/api/groups/${inviteRoomId}/invite`)
    .set('X-CSRF-Token', inviterCsrf)
    .send({ userId: secondTargetResponse.body.id })
    .expect(200);
  assert.ok(stmts.isMember.get(inviteRoomId, secondTargetResponse.body.id));

  // Inviting into GChat Global is a no-op-by-design.
  await inviter
    .post('/api/groups/gchat-global/invite')
    .set('X-CSRF-Token', inviterCsrf)
    .send({ userId: targetResponse.body.id })
    .expect(400);
});

test('socket sends: legit members send, non-members are rejected, and batched read receipts tolerate malformed payloads', async () => {
  const { io: socketClient } = require('socket.io-client');
  const url = await ensureServerListening();

  const memberAgent = request.agent(app);
  const memberResponse = await register(memberAgent, 'socket-member-test');
  const memberCsrf = await csrf(memberAgent);
  const secret = Buffer.alloc(32, 6).toString('base64url');
  const commitment = crypto.createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64url');
  const created = await memberAgent
    .post('/api/groups/create')
    .set('X-CSRF-Token', memberCsrf)
    .send({ name: 'Socket room', code: 'sock01', secret, keyCommitment: commitment })
    .expect(201);
  const groupId = created.body.id;

  const memberCookie = memberResponse.headers['set-cookie'][0].split(';')[0];
  const memberSocket = socketClient(url, { transports: ['polling'], extraHeaders: { Cookie: memberCookie } });
  await new Promise((resolve) => memberSocket.on('connect', resolve));

  // A legit member can send — v1.3.11 regression guard for the desktop
  // "not a member" report.
  const msgId = crypto.randomUUID();
  const sendAck = await new Promise((resolve) => {
    memberSocket.emit('send_message', {
      id: msgId, groupId, encryptedContent: 'AAAA', iv: 'AAAAAAAAAAAAAAAA',
      encryptedMetadata: 'AAAA', metadataIv: 'AAAAAAAAAAAAAAAA',
      replyToId: null, tagIndex: null, isDisappearing: false, disappearingDurationMs: 0,
      encryptionVersion: 2, keyVersion: 1, revision: 1,
    }, resolve);
    setTimeout(() => resolve('NO_ACK'), 4000);
  });
  assert.equal(sendAck.ok, true);
  assert.equal(sendAck.messageId, msgId);
  assert.equal(sendAck.epoch, 1);
  assert.equal(sendAck.seq, 1);
  assert.ok(stmts.findMessageById.get(msgId));

  // Batched read receipts tolerate malformed/missing ids without throwing
  // (an uncaught SQLite binding error here would crash the whole server).
  const memberErrors = [];
  memberSocket.on('error', (payload) => memberErrors.push(payload));
  memberSocket.emit('mark_messages_read', { groupId, messageIds: [msgId, null, undefined, 'garbage-id'] });
  memberSocket.emit('mark_messages_read', { groupId: null, messageIds: [msgId] });
  memberSocket.emit('mark_messages_read', { groupId: 'not-a-group', messageIds: [msgId] });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(memberErrors.length, 0);

  // A non-member is rejected with 'Not a member of this group' (server-side
  // truth — the client reconciles on this message in v1.3.11).
  const outsider = request.agent(app);
  const outsiderResponse = await register(outsider, 'socket-outsider-test');
  const outsiderCookie = outsiderResponse.headers['set-cookie'][0].split(';')[0];
  const outsiderSocket = socketClient(url, { transports: ['polling'], extraHeaders: { Cookie: outsiderCookie } });
  await new Promise((resolve) => outsiderSocket.on('connect', resolve));
  const outsiderErrors = [];
  outsiderSocket.on('error', (payload) => outsiderErrors.push(payload));
  const outsiderAck = await new Promise((resolve) => {
    outsiderSocket.emit('send_message', {
      id: crypto.randomUUID(), groupId, encryptedContent: 'AAAA', iv: 'AAAAAAAAAAAAAAAA',
      encryptedMetadata: 'AAAA', metadataIv: 'AAAAAAAAAAAAAAAA',
      replyToId: null, tagIndex: null, isDisappearing: false, disappearingDurationMs: 0,
      encryptionVersion: 2, keyVersion: 1, revision: 1,
    }, resolve);
    setTimeout(() => resolve('NO_ACK'), 4000);
  });
  assert.equal(outsiderAck.ok, false);
  assert.match(outsiderAck.error, /not a member/i);
  assert.ok(outsiderErrors.some((e) => /not a member/i.test(e.message || '')));

  memberSocket.close();
  outsiderSocket.close();
});

test('socket reconnect re-authenticates and durable sequences replace packet recovery', async () => {
  const { io: socketServer } = require('../server');
  const { io: socketClient } = require('socket.io-client');
  const url = await ensureServerListening();

  const memberAgent = request.agent(app);
  const memberResponse = await register(memberAgent, 'recovery-member-test');
  const memberCsrf = await csrf(memberAgent);
  const secret = Buffer.alloc(32, 7).toString('base64url');
  const commitment = crypto.createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64url');
  const created = await memberAgent
    .post('/api/groups/create')
    .set('X-CSRF-Token', memberCsrf)
    .send({ name: 'Recovery room', code: 'recov1', secret, keyCommitment: commitment })
    .expect(201);
  const groupId = created.body.id;

  const cookie = memberResponse.headers['set-cookie'][0].split(';')[0];
  const memberSocket = socketClient(url, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 100,
    extraHeaders: { Cookie: cookie },
  });
  await new Promise((resolve) => memberSocket.on('connect', resolve));
  memberSocket.emit('join_room', groupId);
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Simulate the real-world trigger: a server ping-timeout closes the
  // transport ABRUPTLY (no clean disconnect packet) — exactly what happens
  // when a backgrounded app's throttled heartbeat stalls. The client then
  // auto-reconnects inside the connectionStateRecovery window (2 min).
  const serverSocket = socketServer.sockets.sockets.get(memberSocket.id);
  assert.ok(serverSocket, 'server-side socket should exist before the drop');
  serverSocket.conn.onClose('ping timeout');
  const reconnected = await Promise.race([
    new Promise((resolve) => memberSocket.on('connect', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 10000)),
  ]);
  assert.ok(reconnected, 'client should auto-reconnect after the abrupt transport drop');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const recovered = socketServer.sockets.sockets.get(memberSocket.id);
  assert.ok(recovered, 'socket should be reconnected');
  assert.equal(recovered.recovered, false, 'v1.4.5 intentionally disables in-memory packet recovery');
  assert.ok(recovered.userId, 'recovered socket must be re-authenticated (userId set)');
  assert.equal(recovered.username, 'recovery-member-test');
  memberSocket.emit('join_room', groupId);

  const msgId = crypto.randomUUID();
  const sendAck = await new Promise((resolve) => {
    memberSocket.emit('send_message', {
      id: msgId, groupId, encryptedContent: 'AAAA', iv: 'AAAAAAAAAAAAAAAA',
      encryptedMetadata: 'AAAA', metadataIv: 'AAAAAAAAAAAAAAAA',
      replyToId: null, tagIndex: null, isDisappearing: false, disappearingDurationMs: 0,
      encryptionVersion: 2, keyVersion: 1, revision: 1,
    }, resolve);
    setTimeout(() => resolve('NO_ACK'), 4000);
  });
  assert.equal(sendAck.ok, true);
  assert.equal(sendAck.messageId, msgId);
  assert.ok(Number(sendAck.seq) >= 1);
  assert.ok(stmts.findMessageById.get(msgId));

  memberSocket.close();
});

test('heartbeat hardening: server pingTimeout tolerates throttled background tabs (no transport-drop flash)', async () => {
  // v1.3.12: browser timer throttling while the tab/app is backgrounded stalls
  // client heartbeats. A short pingTimeout killed the transport on every
  // return-to-app, flashing "Reconnecting, transport closed". The timeout must
  // stay generous (>= 60s) — the Socket.IO recovery window is 120s.
  const { io: socketServer } = require('../server');
  const engineOpts = socketServer?.engine?.opts || {};
  assert.ok(
    Number(engineOpts.pingTimeout) >= 60000,
    `pingTimeout must tolerate backgrounded tabs (got ${engineOpts.pingTimeout})`
  );
  assert.ok(Number(engineOpts.pingInterval) > 0, 'pingInterval must stay configured');
});

test('new GChat Global registrations announce a member_joined event to the global room', async () => {
  const { io: socketClient } = require('socket.io-client');
  const url = await ensureServerListening();

  const watcher = request.agent(app);
  const watcherResponse = await register(watcher, 'global-watcher-test');
  const watcherCookie = watcherResponse.headers['set-cookie'][0].split(';')[0];
  const watcherSocket = socketClient(url, { transports: ['polling'], extraHeaders: { Cookie: watcherCookie } });
  await new Promise((resolve) => watcherSocket.on('connect', resolve));
  watcherSocket.emit('join_room', 'gchat-global');
  await new Promise((resolve) => setTimeout(resolve, 300));

  const joins = [];
  watcherSocket.on('member_joined', (payload) => joins.push(payload));
  await register(request.agent(app), 'global-newcomer-test');

  await new Promise((resolve) => setTimeout(resolve, 500));
  const join = joins.find((j) => j.username === 'global-newcomer-test' && j.groupId === 'gchat-global');
  assert.ok(join, 'global room must announce the new registration');
  assert.equal(join.userId, stmts.findUserByUsername.get('global-newcomer-test').id);
  assert.equal(join.profilePicture, null);
  assert.equal(join.profilePictureUrl, null);
  assert.equal(join.hasProfilePicture, false);
  assert.equal(join.profilePictureVersion, null);

  watcherSocket.close();
});

test('joining a group bumps delivery totals of previous messages (whispers excluded)', async () => {
  await ensureServerListening();

  const ownerAgent = request.agent(app);
  await register(ownerAgent, 'ticks-owner-test');
  const ownerCsrf = await csrf(ownerAgent);
  const secret = Buffer.alloc(32, 8).toString('base64url');
  const commitment = crypto.createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64url');
  const created = await ownerAgent
    .post('/api/groups/create')
    .set('X-CSRF-Token', ownerCsrf)
    .send({ name: 'Ticks room', code: 'ticks1', secret, keyCommitment: commitment })
    .expect(201);
  const groupId = created.body.id;
  const ownerId = stmts.findUserByUsername.get('ticks-owner-test').id;

  const textId = crypto.randomUUID();
  const whisperId = crypto.randomUUID();
  stmts.insertV2Message.run(textId, groupId, ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null, null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null, '2026-01-01T00:00:00.000Z');
  stmts.insertV2Message.run(whisperId, groupId, ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'whisper', null, JSON.stringify([ownerId]), 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null, '2026-01-01T00:00:01.000Z');
  const before = stmts.findMessageById.get(textId).total_recipients;
  const whisperBefore = stmts.findMessageById.get(whisperId).total_recipients;
  assert.equal(before, 1);
  assert.equal(whisperBefore, 1);

  const newcomer = request.agent(app);
  await register(newcomer, 'ticks-newcomer-test');
  const newcomerCsrf = await csrf(newcomer);
  await newcomer
    .post('/api/groups/join')
    .set('X-CSRF-Token', newcomerCsrf)
    .send({ code: 'ticks1' })
    .expect(200);

  assert.equal(stmts.findMessageById.get(textId).total_recipients, before + 1);
  assert.equal(stmts.findMessageById.get(whisperId).total_recipients, whisperBefore, 'whisper totals must stay recipient-scoped');
});

test('per-channel read cursors drive unread counts and broadcast to every device', async () => {
  const { io: socketClient } = require('socket.io-client');
  const url = await ensureServerListening();

  const memberAgent = request.agent(app);
  const memberResponse = await register(memberAgent, 'cursor-unread-test');
  const memberCsrf = await csrf(memberAgent);
  const secret = Buffer.alloc(32, 9).toString('base64url');
  const commitment = crypto.createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64url');
  const created = await memberAgent
    .post('/api/groups/create')
    .set('X-CSRF-Token', memberCsrf)
    .send({ name: 'Unread room', code: 'unrd01', secret, keyCommitment: commitment })
    .expect(201);
  const groupId = created.body.id;
  const memberId = memberResponse.body.id;
  const otherId = stmts.findUserByUsername.get('owner-test').id;

  // Two messages: one in #main (tag_index NULL), one in a channel (blind index).
  const mainId = crypto.randomUUID();
  const channelTag = Buffer.alloc(32, 3).toString('base64url');
  const channelId = crypto.randomUUID();
  stmts.insertV2Message.run(mainId, groupId, otherId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null, null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null, '2026-01-02T00:00:00.000Z');
  stmts.insertV2Message.run(channelId, groupId, otherId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null, null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', channelTag, null, '2026-01-02T00:00:01.000Z');

  // The group list reports 2 unread (no cursors yet — counts are capped/bounded).
  const mine = await memberAgent.get('/api/groups/mine').expect(200);
  const myGroup = mine.body.find((g) => g.id === groupId);
  assert.equal(myGroup.unreadCount, 2);

  // Per-channel counts are exact: #main = 1, the channel = 1.
  const perChannel = await memberAgent
    .get(`/api/groups/${groupId}/unread?tags=${encodeURIComponent(channelTag)}`)
    .expect(200);
  assert.deepEqual(perChannel.body.counts, { '': 1, [channelTag]: 1 });

  // A non-member cannot read unread counts.
  const outsider = request.agent(app);
  await register(outsider, 'cursor-unread-outsider');
  await outsider.get(`/api/groups/${groupId}/unread`).expect(403);

  // Advance the #main cursor via socket and verify the broadcast + counts.
  const cookie = memberResponse.headers['set-cookie'][0].split(';')[0];
  const sock = socketClient(url, { transports: ['polling'], extraHeaders: { Cookie: cookie } });
  await new Promise((resolve) => sock.on('connect', resolve));
  const broadcasts = [];
  sock.on('read_cursor_updated', (payload) => broadcasts.push(payload));

  sock.emit('mark_channel_read', {
    groupId,
    tagIndex: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    messageId: mainId,
  });
  await new Promise((resolve) => setTimeout(resolve, 400));

  // #main unread is now 0; the untouched channel stays 1; group total is 1.
  const perChannelAfter = await memberAgent
    .get(`/api/groups/${groupId}/unread?tags=${encodeURIComponent(channelTag)}`)
    .expect(200);
  assert.deepEqual(perChannelAfter.body.counts, { '': 0, [channelTag]: 1 });

  const mineAfter = await memberAgent.get('/api/groups/mine').expect(200);
  const myGroupAfter = mineAfter.body.find((g) => g.id === groupId);
  assert.equal(myGroupAfter.unreadCount, 1);

  // The broadcast reached this device with the fresh counts (cross-device sync).
  const broadcast = broadcasts[broadcasts.length - 1];
  assert.ok(broadcast, 'read_cursor_updated must be broadcast to the user room');
  assert.equal(broadcast.groupId, groupId);
  assert.equal(broadcast.tagIndex, null);
  assert.equal(broadcast.channelUnreadCount, 0);
  assert.equal(broadcast.groupUnreadCount, 1);

  // Own messages never count as unread, and a cursor covering the channel's
  // newest message zeroes the channel too.
  stmts.upsertChannelReadCursor.run(groupId, memberId, channelTag, '2026-01-02T00:00:01.000Z', channelId, '2026-01-02T00:00:02.000Z');
  const mineAfterAll = await memberAgent.get('/api/groups/mine').expect(200);
  const myGroupAfterAll = mineAfterAll.body.find((g) => g.id === groupId);
  assert.equal(myGroupAfterAll.unreadCount, 0);

  sock.close();
});

test('deleted and cleared messages never contribute to group, channel, or push unread counts', async () => {
  const viewer = request.agent(app);
  const viewerResponse = await register(viewer, 'bounded-unread-history-test');
  const viewerCsrf = await csrf(viewer);
  const secret = Buffer.alloc(32, 31).toString('base64url');
  const commitment = crypto.createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64url');
  const created = await viewer
    .post('/api/groups/create')
    .set('X-CSRF-Token', viewerCsrf)
    .send({ name: 'Bounded unread room', code: 'bound1', secret, keyCommitment: commitment })
    .expect(201);
  const groupId = created.body.id;
  const viewerId = viewerResponse.body.id;
  const otherId = stmts.findUserByUsername.get('owner-test').id;
  const tagIndex = Buffer.alloc(32, 7).toString('base64url');
  const deletedId = crypto.randomUUID();
  const clearedId = crypto.randomUUID();

  stmts.insertV2Message.run(deletedId, groupId, otherId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null, null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null, '2026-06-01T00:00:00.000Z');
  stmts.insertV2Message.run(clearedId, groupId, otherId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null, null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', tagIndex, null, '2026-06-01T00:00:01.000Z');
  db.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?').run('2026-06-01T00:01:00.000Z', deletedId);
  db.prepare(`
    INSERT INTO group_history_boundaries (group_id, channel_key, cleared_at, cleared_seq, cleared_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(groupId, tagIndex, '2026-06-01T00:02:00.000Z', Number.MAX_SAFE_INTEGER, viewerId);

  const mine = await viewer.get('/api/groups/mine').expect(200);
  assert.equal(mine.body.find((group) => group.id === groupId).unreadCount, 0);
  const channel = await viewer.get(`/api/groups/${groupId}/unread?tags=${encodeURIComponent(tagIndex)}`).expect(200);
  assert.deepEqual(channel.body.counts, { '': 0, [tagIndex]: 0 });
  const push = await viewer.get('/api/push/status').expect(200);
  assert.equal(push.body.totalUnreadCount, 0);
});

test('one-shot migration nulls the phantom #main blind tag index so cursors cover it', async () => {
  const { nullMainTagIndexes } = require('../src/server/main-tag-index-migration');
  const agent = request.agent(app);
  await register(agent, 'main-index-migrate-test');
  const csrfToken = await csrf(agent);
  const groupSecret = Buffer.alloc(32, 12).toString('base64url');
  const commitment = crypto.createHash('sha256').update(Buffer.from(groupSecret, 'base64url')).digest('base64url');
  const created = await agent
    .post('/api/groups/create')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Main index room', code: 'main01', secret: groupSecret, keyCommitment: commitment })
    .expect(201);
  const groupId = created.body.id;
  const otherId = stmts.findUserByUsername.get('owner-test').id;
  const viewerId = stmts.findUserByUsername.get('main-index-migrate-test').id;

  // Reproduce the pre-1.3.13 bug: a #main message stamped with the blind index
  // of the literal topic "main".
  const indexKey = crypto.hkdfSync('sha256', Buffer.from(groupSecret, 'base64url'), Buffer.from(groupId), Buffer.from('gchat-tag-index-v2'), 32);
  const mainIndex = crypto.createHmac('sha256', indexKey).update('main').digest('base64url');
  const channelIndex = crypto.createHmac('sha256', indexKey).update('general').digest('base64url');
  const mainId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  stmts.insertV2Message.run(mainId, groupId, otherId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null, null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', mainIndex, null, '2026-01-02T00:00:00.000Z');
  stmts.insertV2Message.run(channelId, groupId, otherId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null, null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', channelIndex, null, '2026-01-02T00:00:01.000Z');

  // Before the migration, a NULL #main cursor does NOT cover the phantom row —
  // this is the phantom-badge condition: the GROUP unread count stays stuck at
  // 2 (phantom row + real channel row) even though #main was fully read.
  stmts.upsertChannelReadCursor.run(groupId, viewerId, null, '2026-01-02T00:00:00.000Z', mainId, '2026-01-02T00:00:02.000Z');
  const mineBefore = await agent.get('/api/groups/mine').expect(200);
  const groupBefore = mineBefore.body.find((g) => g.id === groupId);
  assert.equal(groupBefore.unreadCount, 2, 'phantom "main"-indexed row must keep the group badge stuck before the migration');

  // Run the migration: it must NULL only the "main" index rows.
  const fixed = nullMainTagIndexes(db, parseEscrowMasterKey(process.env.GROUP_KEY_ESCROW_MASTER_KEY));
  assert.ok(fixed >= 1, `migration must fix at least the phantom row (fixed=${fixed})`);
  assert.equal(stmts.findMessageById.get(mainId).tag_index, null);
  assert.equal(stmts.findMessageById.get(channelId).tag_index, channelIndex, 'real channel indexes must be untouched');

  // After the migration the NULL #main cursor covers the row — the group badge
  // drops to the single genuinely-unread channel message.
  const mineAfter = await agent.get('/api/groups/mine').expect(200);
  const groupAfter = mineAfter.body.find((g) => g.id === groupId);
  assert.equal(groupAfter.unreadCount, 1);
  const unreadAfter = await agent.get(`/api/groups/${groupId}/unread?tags=${encodeURIComponent(channelIndex)}`).expect(200);
  assert.deepEqual(unreadAfter.body.counts, { '': 0, [channelIndex]: 1 });
});

test('leaving a group removes the member read cursors', async () => {
  const ownerAgent = request.agent(app);
  await register(ownerAgent, 'cursor-leave-owner');
  const ownerCsrf = await csrf(ownerAgent);
  const secret = Buffer.alloc(32, 10).toString('base64url');
  const commitment = crypto.createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64url');
  const created = await ownerAgent
    .post('/api/groups/create')
    .set('X-CSRF-Token', ownerCsrf)
    .send({ name: 'Leave room', code: 'leave1', secret, keyCommitment: commitment })
    .expect(201);
  const groupId = created.body.id;

  const leaverAgent = request.agent(app);
  const leaverResponse = await register(leaverAgent, 'cursor-leaver-test');
  const leaverCsrf = await csrf(leaverAgent);
  await leaverAgent
    .post('/api/groups/join')
    .set('X-CSRF-Token', leaverCsrf)
    .send({ code: 'leave1' })
    .expect(200);
  const leaverId = leaverResponse.body.id;

  stmts.upsertChannelReadCursor.run(groupId, leaverId, null, '2026-01-01T00:00:00.000Z', 'x', '2026-01-01T00:00:00.000Z');
  assert.ok(stmts.getChannelReadCursor.get(groupId, leaverId, null));

  await ownerAgent
    .delete(`/api/groups/${groupId}/members/${leaverId}`)
    .set('X-CSRF-Token', await csrf(ownerAgent))
    .expect(200);

  assert.equal(stmts.getChannelReadCursor.get(groupId, leaverId, null), undefined, 'kicked member cursors must be removed');
  assert.equal(stmts.isMember.get(groupId, leaverId), undefined);
});

test('Furina can clear GChat Global history and delete channels; other members cannot', async () => {
  // GChat Global has no owner — the app owner (username "Furina") is the only
  // one who can clear the full history and delete channels there.
  const furina = request.agent(app);
  const furinaResponse = await register(furina, 'Furina');
  const furinaId = furinaResponse.body.id;
  const furinaCsrf = await csrf(furina);

  const globalTag = Buffer.alloc(32, 11).toString('base64url');
  const globalMainId = crypto.randomUUID();
  const globalTagId = crypto.randomUUID();
  const senderId = stmts.findUserByUsername.get('owner-test').id;
  stmts.insertV2Message.run(globalMainId, 'gchat-global', senderId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null, null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null, '2026-02-01T00:00:00.000Z');
  stmts.insertV2Message.run(globalTagId, 'gchat-global', senderId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null, null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', globalTag, null, '2026-02-01T00:00:01.000Z');

  // A non-Furina member cannot clear Global history.
  const memberAgent = request.agent(app);
  await register(memberAgent, 'furina-bystander');
  await memberAgent
    .delete('/api/groups/gchat-global/messages')
    .set('X-CSRF-Token', await csrf(memberAgent))
    .expect(403);
  // …nor delete a Global channel.
  await memberAgent
    .delete(`/api/groups/gchat-global/tags/${encodeURIComponent(globalTag)}/messages`)
    .set('X-CSRF-Token', await csrf(memberAgent))
    .expect(403);
  // The messages are untouched.
  assert.ok(stmts.findMessageById.get(globalMainId));
  assert.ok(stmts.findMessageById.get(globalTagId));

  // Furina can delete a Global channel…
  await furina
    .delete(`/api/groups/gchat-global/tags/${encodeURIComponent(globalTag)}/messages`)
    .set('X-CSRF-Token', furinaCsrf)
    .expect(200);
  assert.ok(stmts.findMessageById.get(globalTagId), 'Global channel clear must preserve recoverable ciphertext');

  // …and clear the full Global history.
  await furina
    .delete('/api/groups/gchat-global/messages')
    .set('X-CSRF-Token', furinaCsrf)
    .expect(200);
  assert.ok(stmts.findMessageById.get(globalMainId), 'Global clear must preserve recoverable ciphertext');
  assert.ok(furinaId, 'Furina is a registered member of GChat Global');
});

test('C1: malformed socket payloads are rejected without crashing the server', async () => {
  const { io: socketClient } = require('socket.io-client');
  const url = await ensureServerListening();
  const agent = request.agent(app);
  const response = await register(agent, 'crash-guard-test');
  const csrfToken = await csrf(agent);
  const secret = Buffer.alloc(32, 21).toString('base64url');
  const commitment = crypto.createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64url');
  const created = await agent
    .post('/api/groups/create')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Crash guard room', code: 'cras01', secret, keyCommitment: commitment })
    .expect(201);
  const groupId = created.body.id;

  const cookie = response.headers['set-cookie'][0].split(';')[0];
  const sock = socketClient(url, { transports: ['polling'], extraHeaders: { Cookie: cookie } });
  await new Promise((resolve) => sock.on('connect', resolve));
  const errors = [];
  sock.on('error', (error) => errors.push(error.message));

  // Object groupId — used to throw inside better-sqlite3 and kill the process.
  sock.emit('send_message', { groupId: {}, encryptedContent: 'AAAA', iv: 'AAAAAAAAAAAAAAAA' });
  // Object messageId on the disappearing-timer path.
  sock.emit('start_disappearing_timer', { groupId, messageId: {} });
  // Object whisper recipients list entries are normalized to strings; a groupId object must be rejected.
  sock.emit('send_whisper', { groupId: {}, whisperTo: ['owner-test'], encryptedContent: 'AAAA', iv: 'AAAAAAAAAAAAAAAA' });
  // Array groupId.
  sock.emit('send_message', { groupId: [], encryptedContent: 'AAAA', iv: 'AAAAAAAAAAAAAAAA' });

  await new Promise((resolve) => setTimeout(resolve, 500));

  // And a well-formed message still works.
  let acked = false;
  sock.emit('send_message', {
    id: crypto.randomUUID(),
    groupId,
    encryptedContent: Buffer.from('aGVsbG8=', 'base64').toString('base64url'),
    iv: 'AAAAAAAAAAAAAAAA',
    encryptedMetadata: 'e30=',
    metadataIv: 'AAAAAAAAAAAAAAAA',
    encryptionVersion: 2,
    keyVersion: 1,
    revision: 1,
    tagIndex: null,
    replyToId: null,
    isDisappearing: false,
  }, () => { acked = true; });
  await new Promise((resolve) => setTimeout(resolve, 500));

  // The server must still be alive and the socket still connected.
  const stayedConnected = sock.connected;
  sock.close();
  assert.equal(stayedConnected, true, 'socket must stay connected after malformed payloads');
  assert.equal(acked, true, 'a valid send must still be acknowledged after the malformed ones');
  assert.ok(errors.length >= 1, 'malformed payloads must be rejected with an error event');
  assert.ok(errors.some((message) => /group/i.test(message)), 'rejections mention the group id');
});

test('C2 + H1: #main read cursors upsert (no duplicates) and never regress', async () => {
  const { io: socketClient } = require('socket.io-client');
  const url = await ensureServerListening();
  const agent = request.agent(app);
  const response = await register(agent, 'cursor-upsert-test');
  const csrfToken = await csrf(agent);
  const secret = Buffer.alloc(32, 22).toString('base64url');
  const commitment = crypto.createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64url');
  const created = await agent
    .post('/api/groups/create')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Cursor upsert room', code: 'curs02', secret, keyCommitment: commitment })
    .expect(201);
  const groupId = created.body.id;
  const viewerId = response.body.id;
  const otherId = stmts.findUserByUsername.get('owner-test').id;
  const m1 = crypto.randomUUID();
  const m2 = crypto.randomUUID();
  stmts.insertV2Message.run(m1, groupId, otherId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null, null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null, '2026-03-01T00:00:00.000Z');
  stmts.insertV2Message.run(m2, groupId, otherId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null, null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null, '2026-03-01T00:00:01.000Z');

  const cookie = response.headers['set-cookie'][0].split(';')[0];
  const sock = socketClient(url, { transports: ['polling'], extraHeaders: { Cookie: cookie } });
  await new Promise((resolve) => sock.on('connect', resolve));

  const cursorRows = () => stmts.getChannelReadCursor.all(groupId, viewerId, null).length;

  // First #main cursor event inserts exactly ONE row.
  sock.emit('mark_channel_read', { groupId, tagIndex: null, createdAt: '2026-03-01T00:00:00.000Z', messageId: m1 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(cursorRows(), 1, 'first #main cursor event must insert exactly one row (C2)');
  assert.equal(stmts.getChannelReadCursor.get(groupId, viewerId, null).last_read_id, m1);

  // A NEWER cursor event UPDATES the same row (no duplicate).
  sock.emit('mark_channel_read', { groupId, tagIndex: null, createdAt: '2026-03-01T00:00:01.000Z', messageId: m2 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(cursorRows(), 1, 'a newer #main cursor event must update the existing row (C2)');
  assert.equal(stmts.getChannelReadCursor.get(groupId, viewerId, null).last_read_id, m2);

  // An OLDER cursor event must NOT regress the stored cursor (H1).
  sock.emit('mark_channel_read', { groupId, tagIndex: null, createdAt: '2026-03-01T00:00:00.000Z', messageId: m1 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(cursorRows(), 1, 'stale cursor events must not add rows');
  assert.equal(stmts.getChannelReadCursor.get(groupId, viewerId, null).last_read_id, m2, 'stale cursor events must not regress the cursor (H1)');

  sock.close();
});

test('H4: negative message limit is clamped to a bounded page', async () => {
  const agent = request.agent(app);
  await register(agent, 'limit-clamp-test');
  const csrfToken = await csrf(agent);
  const secret = Buffer.alloc(32, 23).toString('base64url');
  const commitment = crypto.createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64url');
  const created = await agent
    .post('/api/groups/create')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Limit clamp room', code: 'limi01', secret, keyCommitment: commitment })
    .expect(201);
  const groupId = created.body.id;
  const otherId = stmts.findUserByUsername.get('owner-test').id;

  // Seed 120 messages so a negative limit would expose the whole history.
  for (let i = 0; i < 120; i += 1) {
    const id = crypto.randomUUID();
    const createdAt = `2026-04-01T00:00:${String(i).padStart(2, '0')}.000Z`;
    stmts.insertV2Message.run(id, groupId, otherId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null, null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null, createdAt);
  }

  const negative = await agent.get(`/api/groups/${groupId}/messages?limit=-1`).expect(200);
  assert.ok(Array.isArray(negative.body));
  assert.ok(negative.body.length <= 100, `negative limit must be clamped (got ${negative.body.length})`);

  const huge = await agent.get(`/api/groups/${groupId}/messages?limit=999999`).expect(200);
  assert.ok(huge.body.length <= 100, 'huge limits must be clamped to 100');
});

test('H6: login regenerates the session so the pre-auth session id dies', async () => {
  await register(request.agent(app), 'session-regen-test');
  const bare = request.agent(app);
  // Create a pre-auth session (the CSRF fetch issues one).
  const csrfRes = await bare.get('/api/auth/csrf').expect(200);
  const preAuthSid = csrfRes.headers['set-cookie'][0].split(';')[0];
  assert.ok(preAuthSid, 'pre-auth session cookie exists');

  const loginRes = await bare
    .post('/api/auth/login')
    .send({ username: 'session-regen-test', password: 'secure-password-123', rememberMe: true })
    .expect(200);
  const postAuthSid = loginRes.headers['set-cookie'][0].split(';')[0];
  assert.ok(postAuthSid, 'post-login session cookie exists');
  assert.notEqual(postAuthSid.split('=')[1], preAuthSid.split('=')[1], 'login must issue a NEW session id (H6)');

  // The OLD session id must no longer be authenticated.
  const staleAgent = request.agent(app);
  staleAgent.jar.setCookie(preAuthSid);
  await staleAgent.get('/api/auth/me').expect(401);
  // The NEW session id works.
  await bare.get('/api/auth/me').expect(200);
});

test('H7: whisper recipient lists are bounded (no event-loop DoS)', async () => {
  const { io: socketClient } = require('socket.io-client');
  const url = await ensureServerListening();
  const agent = request.agent(app);
  const response = await register(agent, 'whisper-cap-test');
  const csrfToken = await csrf(agent);
  const secret = Buffer.alloc(32, 24).toString('base64url');
  const commitment = crypto.createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64url');
  const created = await agent
    .post('/api/groups/create')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Whisper cap room', code: 'whis01', secret, keyCommitment: commitment })
    .expect(201);
  const groupId = created.body.id;

  const cookie = response.headers['set-cookie'][0].split(';')[0];
  const sock = socketClient(url, { transports: ['polling'], extraHeaders: { Cookie: cookie } });
  await new Promise((resolve) => sock.on('connect', resolve));
  const errors = [];
  sock.on('error', (error) => errors.push(error.message));

  // 5000 fake recipient ids: must be capped, validated in bounded time, and
  // rejected (they are not members) — never crash or block the server.
  const manyRecipients = Array.from({ length: 5000 }, (_, i) => `fake-recipient-${i}`);
  sock.emit('send_whisper', {
    id: crypto.randomUUID(),
    groupId,
    whisperTo: manyRecipients,
    encryptedContent: Buffer.from('aGVsbG8=', 'base64').toString('base64url'),
    iv: 'AAAAAAAAAAAAAAAA',
    encryptedMetadata: 'e30=',
    metadataIv: 'AAAAAAAAAAAAAAAA',
    encryptionVersion: 2,
    keyVersion: 1,
    revision: 1,
    tagIndex: null,
    replyToId: null,
    isDisappearing: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 800));

  const stayedConnected = sock.connected;
  sock.close();
  assert.equal(stayedConnected, true, 'socket must survive an oversized whisper recipient list (H7)');
  assert.ok(errors.some((message) => /recipient/i.test(message)), 'oversized whisper lists are rejected cleanly');
});
