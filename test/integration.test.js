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
  await owner
    .patch(`/api/groups/${group.id}/members/${group.memberId}/administrator`)
    .set('X-CSRF-Token', ownerCsrf)
    .send({ isAdministrator: true })
    .expect(200, { ok: true, isAdministrator: true });

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

  await owner
    .patch(`/api/groups/${group.id}/members/${group.memberId}/administrator`)
    .set('X-CSRF-Token', ownerCsrf)
    .send({ isAdministrator: false })
    .expect(200, { ok: true, isAdministrator: false });
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

test('incremental since-cursor sync returns only newer messages in ascending order', async () => {
  const base = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb';
  const ids = [1, 2, 3].map((n) => `${base}${n}`);
  for (const id of ids) {
    stmts.insertV2Message.run(
      id, group.id, group.ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', null,
      null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null
    );
  }
  const setTime = db.prepare('UPDATE messages SET created_at = ? WHERE id = ?');
  setTime.run('2030-01-01T10:00:00.000Z', ids[0]);
  setTime.run('2030-01-01T10:01:00.000Z', ids[1]);
  setTime.run('2030-01-01T10:02:00.000Z', ids[2]);

  const afterSecond = await owner
    .get(`/api/groups/${group.id}/messages?since=2030-01-01T10:01:00.000Z`)
    .expect(200);
  assert.deepEqual(afterSecond.body.map((m) => m.id), [ids[2]]);

  const afterFirst = await owner
    .get(`/api/groups/${group.id}/messages?since=2030-01-01T10:00:00.000Z`)
    .expect(200);
  assert.deepEqual(afterFirst.body.map((m) => m.id), [ids[1], ids[2]]);
});

test('quotes to deleted targets are accepted and marked replyTargetMissing', async () => {
  const quotedId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const msgId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  stmts.insertV2Message.run(
    msgId, group.id, group.ownerId, 'AAAA', 'AAAAAAAAAAAAAAAA', 'text', quotedId,
    null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null
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
    null, 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null
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
    JSON.stringify([group.memberId]), 0, null, 1, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null
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
    null, 0, null, 2, 2, 1, 1, 'AAAA', 'AAAAAAAAAAAAAAAA', null, null
  );
  const memberBCsrf = await csrf(memberB);
  await memberB
    .delete('/api/groups/gchat-global/messages/' + messageId)
    .set('X-CSRF-Token', memberBCsrf)
    .expect(200);
  assert.equal(stmts.findMessageById.get(messageId), undefined);
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

  await inviter
    .post(`/api/groups/${inviteRoomId}/invite`)
    .set('X-CSRF-Token', inviterCsrf)
    .send({ userId: targetResponse.body.id })
    .expect(200, { ok: true });
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
  const { server } = require('../server');
  const { io: socketClient } = require('socket.io-client');
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${server.address().port}`;

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
  assert.deepEqual(sendAck, { ok: true, messageId: msgId });
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
