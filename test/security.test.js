'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { hashJoinCode, isValidKeyCommitment, normalizeJoinCode } = require('../src/server/group-security');
const { validateEditEnvelope, validateV2MessageEnvelope } = require('../src/server/message-contract');
const { readConfig } = require('../src/server/config');

test('production config keeps AI disabled and can use the stable session secret as the join-code pepper', () => {
  const sessionSecret = 's'.repeat(32);
  const config = readConfig({ NODE_ENV: 'production', SESSION_SECRET: sessionSecret, AI_ENABLED: '1' });
  assert.equal(config.aiEnabled, false);
  assert.equal(config.groupCodePepper, sessionSecret);
});

test('join codes are normalized and stored as keyed hashes', () => {
  const pepper = 'p'.repeat(32);
  assert.equal(normalizeJoinCode('  My Secure Room  '), 'my-secure-room');
  const digest = hashJoinCode('My Secure Room', pepper);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, hashJoinCode('my-secure-room', pepper));
  assert.notEqual(digest, hashJoinCode('another-room', pepper));
  assert.equal(digest.includes('my-secure-room'), false);
});

test('key commitments accept only 32-byte base64url digests', () => {
  const commitment = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('base64url');
  assert.equal(isValidKeyCommitment(commitment), true);
  assert.equal(isValidKeyCommitment('secret-crew-2024'), false);
});

test('v2 message contract rejects legacy and malformed envelopes', () => {
  const id = crypto.randomUUID();
  assert.equal(validateV2MessageEnvelope({ id, encryptionVersion: 1, keyVersion: 1 }).ok, false);
  assert.equal(validateV2MessageEnvelope({ id, encryptionVersion: 2, keyVersion: 1, revision: 1 }).ok, true);
  assert.equal(validateV2MessageEnvelope({ id, encryptionVersion: 2, keyVersion: 1, revision: 2 }).ok, false);
});

test('edits use optimistic revisions', () => {
  assert.deepEqual(validateEditEnvelope({ expectedRevision: 2, encryptionVersion: 2, keyVersion: 1 }, 2), { ok: true, revision: 3 });
  assert.equal(validateEditEnvelope({ expectedRevision: 1, encryptionVersion: 2, keyVersion: 1 }, 2).status, 409);
});
