'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const cryptoV2 = require('../src/crypto-v2');
const {
  encryptTextEnvelope,
  decryptServerMessage,
  encryptAttachmentEnvelope,
  decryptAttachment,
} = require('../src/client/messages');

test('generateGroupSecret and keyCommitment are base64url 43-char digests', async () => {
  const secret = cryptoV2.generateGroupSecret();
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  const commitment = await cryptoV2.keyCommitment(secret);
  assert.match(commitment, /^[A-Za-z0-9_-]{43}$/);
  const again = await cryptoV2.keyCommitment(secret);
  assert.equal(commitment, again);
});

test('invite codes are 6 lowercase alphanumeric chars', () => {
  for (let i = 0; i < 20; i += 1) {
    assert.match(cryptoV2.generateInviteCode(), /^[a-z0-9]{6}$/);
  }
});

test('encryptTextEnvelope → decryptServerMessage round-trips plaintext and channel', async () => {
  const secret = cryptoV2.generateGroupSecret();
  const groupId = cryptoV2.randomUuid();
  const senderId = cryptoV2.randomUuid();
  const text = 'hello from gchat-cli crypto test';
  const { envelope, channel } = await encryptTextEnvelope({
    text,
    secret,
    groupId,
    senderId,
    channel: 'design',
  });

  assert.equal(envelope.encryptionVersion, 2);
  assert.equal(envelope.keyVersion, 1);
  assert.equal(envelope.revision, 1);
  assert.equal(envelope.type, 'text');
  assert.ok(envelope.encryptedContent);
  assert.ok(envelope.iv);
  assert.ok(envelope.encryptedMetadata);
  assert.ok(envelope.metadataIv);
  assert.ok(envelope.tagIndex);
  assert.ok(envelope.spamSignature);
  assert.equal(channel, 'design');

  const dec = await decryptServerMessage(envelope, secret, groupId);
  assert.equal(dec.error, null);
  assert.equal(dec.text, text);
  assert.equal(dec.channel, 'design');
  assert.equal(dec.metadata.hashtag, 'design');
});

test('tampered AAD fails decrypt', async () => {
  const secret = cryptoV2.generateGroupSecret();
  const groupId = cryptoV2.randomUuid();
  const senderId = cryptoV2.randomUuid();
  const { envelope } = await encryptTextEnvelope({
    text: 'sealed',
    secret,
    groupId,
    senderId,
  });
  const tampered = { ...envelope, senderId: cryptoV2.randomUuid() };
  const dec = await decryptServerMessage(tampered, secret, groupId);
  assert.equal(dec.text, null);
  assert.ok(dec.error);
});

test('attachment encrypt/decrypt round-trip', async () => {
  const secret = cryptoV2.generateGroupSecret();
  const groupId = cryptoV2.randomUuid();
  const senderId = cryptoV2.randomUuid();
  const payload = Buffer.from('file-bytes-xyz');
  const prepared = await encryptAttachmentEnvelope({
    buffer: payload,
    filename: 'note.txt',
    mimeType: 'text/plain',
    secret,
    groupId,
    senderId,
    type: 'file',
    channel: 'main',
  });
  const msg = {
    id: prepared.identity.id,
    groupId,
    senderId,
    type: 'file',
    encryptionVersion: 2,
    keyVersion: 1,
    revision: 1,
    encryptedContent: Buffer.from(prepared.encryptedBytes).toString('base64'),
    iv: prepared.iv,
    encryptedMetadata: prepared.encryptedMetadata,
    metadataIv: prepared.metadataIv,
  };
  const result = await decryptAttachment(msg, secret, groupId);
  assert.equal(result.bytes.toString('utf8'), 'file-bytes-xyz');
  assert.equal(result.metadata.filename, 'note.txt');
});
