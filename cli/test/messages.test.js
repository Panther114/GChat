'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  parseDurationToMs,
  MIN_DISAPPEARING_MS,
  MAX_DISAPPEARING_MS,
  formatMessageLine,
  encryptAttachmentEnvelope,
  decryptAttachmentMeta,
} = require('../src/client/messages');
const cryptoV2 = require('../src/crypto-v2');

test('parseDurationToMs accepts server-allowed range', () => {
  assert.equal(parseDurationToMs('5s'), 5000);
  assert.equal(parseDurationToMs('3000'), 3000);
  assert.equal(parseDurationToMs('3s'), 3000);
  assert.equal(parseDurationToMs('22s'), 22000);
  assert.equal(parseDurationToMs('1s'), null); // below min
  assert.equal(parseDurationToMs('60s'), null); // above max
  assert.ok(MIN_DISAPPEARING_MS >= 3000);
  assert.ok(MAX_DISAPPEARING_MS <= 22500);
});

test('formatMessageLine includes sender and text', () => {
  const line = formatMessageLine(
    { senderName: 'alice', createdAt: '2026-01-01T00:00:00.000Z', type: 'text' },
    { text: 'hi', channel: 'main' }
  );
  assert.match(line, /alice/);
  assert.match(line, /hi/);
  assert.match(line, /#main/);
});

test('decryptAttachmentMeta returns filename without needing the bytes', async () => {
  const secret = cryptoV2.generateGroupSecret();
  const groupId = cryptoV2.randomUuid();
  const senderId = cryptoV2.randomUuid();
  const prepared = await encryptAttachmentEnvelope({
    buffer: Buffer.from('png-bytes'),
    filename: 'shot.png',
    mimeType: 'image/png',
    secret,
    groupId,
    senderId,
    type: 'image',
    channel: 'main',
  });
  const meta = await decryptAttachmentMeta({
    id: prepared.identity.id,
    groupId,
    senderId,
    type: 'image',
    encryptedMetadata: prepared.encryptedMetadata,
    metadataIv: prepared.metadataIv,
    keyVersion: 1,
    revision: 1,
  }, secret, groupId);
  assert.equal(meta.filename, 'shot.png');
  assert.equal(meta.mimeType, 'image/png');
  assert.equal(meta.hashtag, 'main');
});
