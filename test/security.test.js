'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { hashJoinCode, isValidKeyCommitment, normalizeJoinCode } = require('../src/server/group-security');
const { decryptEscrowPayload, encryptEscrowPayload, parseEscrowMasterKey } = require('../src/server/group-key-escrow');
const { validateEditEnvelope, validateV2MessageEnvelope } = require('../src/server/message-contract');
const { readConfig } = require('../src/server/config');

test('production config keeps AI disabled and can use the stable session secret as the join-code pepper', () => {
  const sessionSecret = 's'.repeat(32);
  const config = readConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: sessionSecret,
    AI_ENABLED: '1',
    GROUP_KEY_ESCROW_MASTER_KEY: Buffer.alloc(32, 7).toString('base64url'),
  });
  assert.equal(config.aiEnabled, false);
  assert.equal(config.groupCodePepper, sessionSecret);
  assert.throws(() => readConfig({ NODE_ENV: 'production', SESSION_SECRET: sessionSecret }));
});

test('group key escrow requires a canonical 256-bit master key and authenticates its group binding', () => {
  const masterKey = parseEscrowMasterKey(Buffer.alloc(32, 9).toString('base64url'));
  const payload = { secret: crypto.randomBytes(32).toString('base64url'), joinCode: 'room01' };
  const encrypted = encryptEscrowPayload(masterKey, 'group-one', payload);
  assert.deepEqual(decryptEscrowPayload(masterKey, 'group-one', encrypted), payload);
  assert.throws(() => decryptEscrowPayload(masterKey, 'group-two', encrypted));
  assert.throws(() => parseEscrowMasterKey('not-a-256-bit-key'));
  assert.equal(encrypted.ciphertext.includes(payload.secret), false);
  assert.equal(encrypted.ciphertext.includes(payload.joinCode), false);
});

test('invite codes are six lowercase alphanumeric characters and stored as keyed hashes', () => {
  const pepper = 'p'.repeat(32);
  assert.equal(normalizeJoinCode('  A1B2C3  '), 'a1b2c3');
  assert.equal(normalizeJoinCode('too-long'), null);
  assert.equal(normalizeJoinCode('abc-12'), null);
  const digest = hashJoinCode('a1b2c3', pepper);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, hashJoinCode('A1B2C3', pepper));
  assert.notEqual(digest, hashJoinCode('z9y8x7', pepper));
  assert.equal(digest.includes('a1b2c3'), false);
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
