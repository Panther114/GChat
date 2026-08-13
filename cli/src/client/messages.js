'use strict';

const cryptoV2 = require('../crypto-v2');
const { normalizeChannel } = require('../store/prefs');

const DEFAULT_CHANNEL = 'main';
const MIN_DISAPPEARING_MS = 3000;
const MAX_DISAPPEARING_MS = 22500;

function parseDurationToMs(input) {
  if (input == null || input === '') return null;
  if (typeof input === 'number' && Number.isFinite(input)) {
    return clampDisappearing(input);
  }
  const raw = String(input).trim().toLowerCase();
  if (/^\d+$/.test(raw)) return clampDisappearing(Number(raw));
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2] || 'ms';
  let ms = n;
  if (unit === 's') ms = n * 1000;
  if (unit === 'm') ms = n * 60 * 1000;
  if (unit === 'h') ms = n * 60 * 60 * 1000;
  return clampDisappearing(ms);
}

function clampDisappearing(ms) {
  const duration = Math.round(Number(ms));
  if (!Number.isFinite(duration)) return null;
  if (duration < MIN_DISAPPEARING_MS || duration > MAX_DISAPPEARING_MS) return null;
  return duration;
}

function buildMessageIdentity({ id, groupId, senderId, type = 'text', revision = 1 }) {
  return {
    id: id || cryptoV2.randomUuid(),
    groupId,
    senderId,
    type,
    encryptionVersion: cryptoV2.ENCRYPTION_VERSION,
    keyVersion: cryptoV2.KEY_VERSION,
    revision,
  };
}

async function encryptTextEnvelope({
  text,
  secret,
  groupId,
  senderId,
  type = 'text',
  channel = DEFAULT_CHANNEL,
  replyToId = null,
  replyPreview = null,
  isDisappearing = false,
  disappearingDurationMs = null,
  messageId = null,
  revision = 1,
}) {
  const identity = buildMessageIdentity({
    id: messageId,
    groupId,
    senderId,
    type,
    revision,
  });
  const hashtag = normalizeChannel(channel) || DEFAULT_CHANNEL;
  const metadata = {
    hashtag,
    replyPreview: replyPreview || null,
  };
  const aad = cryptoV2.messageAad(identity);
  const content = await cryptoV2.encryptJson({ text }, secret, groupId, 'content', aad);
  const encMeta = await cryptoV2.encryptJson(metadata, secret, groupId, 'metadata', aad);
  const tagIndex = await cryptoV2.blindIndex(hashtag, secret, groupId, 'tag-index');
  const spamSignature = await cryptoV2.blindIndex(text, secret, groupId, 'spam-signature');

  const envelope = {
    ...identity,
    encryptedContent: content.encryptedContent,
    iv: content.iv,
    encryptedMetadata: encMeta.encryptedContent,
    metadataIv: encMeta.iv,
    replyToId: replyToId || null,
    tagIndex,
    spamSignature,
    isDisappearing: !!isDisappearing,
    disappearingDurationMs: isDisappearing ? (disappearingDurationMs || MIN_DISAPPEARING_MS) : null,
  };
  return { envelope, plaintext: text, channel: hashtag };
}

async function decryptServerMessage(msg, secret, groupId = msg.groupId) {
  if (!msg || !secret) {
    return { text: null, metadata: {}, error: 'missing message or secret' };
  }
  const identity = {
    groupId: msg.groupId || groupId,
    id: msg.id,
    senderId: msg.senderId,
    type: msg.type || 'text',
    keyVersion: msg.keyVersion || cryptoV2.KEY_VERSION,
    revision: msg.revision || 1,
  };
  const aad = cryptoV2.messageAad(identity);
  try {
    const content = await cryptoV2.decryptJson(
      msg.encryptedContent,
      msg.iv,
      secret,
      groupId,
      'content',
      aad
    );
    let metadata = {};
    if (msg.encryptedMetadata && msg.metadataIv) {
      metadata = await cryptoV2.decryptJson(
        msg.encryptedMetadata,
        msg.metadataIv,
        secret,
        groupId,
        'metadata',
        aad
      );
    }
    return {
      text: content?.text ?? null,
      metadata,
      channel: normalizeChannel(metadata.hashtag) || DEFAULT_CHANNEL,
      error: null,
    };
  } catch (err) {
    return { text: null, metadata: {}, channel: DEFAULT_CHANNEL, error: err.message || String(err) };
  }
}

async function encryptAttachmentEnvelope({
  buffer,
  filename,
  mimeType,
  secret,
  groupId,
  senderId,
  type = 'file',
  channel = DEFAULT_CHANNEL,
  messageId = null,
}) {
  const identity = buildMessageIdentity({
    id: messageId,
    groupId,
    senderId,
    type,
    revision: 1,
  });
  const hashtag = normalizeChannel(channel) || DEFAULT_CHANNEL;
  const aad = cryptoV2.messageAad(identity);
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const encrypted = await cryptoV2.encryptBytes(bytes, secret, groupId, aad);
  const metadata = {
    hashtag,
    filename: filename || 'file',
    mimeType: mimeType || 'application/octet-stream',
    size: bytes.byteLength,
  };
  const encMeta = await cryptoV2.encryptJson(metadata, secret, groupId, 'metadata', aad);
  const tagIndex = await cryptoV2.blindIndex(hashtag, secret, groupId, 'tag-index');
  return {
    identity,
    encryptedBytes: encrypted.encryptedBytes,
    iv: encrypted.iv,
    encryptedMetadata: encMeta.encryptedContent,
    metadataIv: encMeta.iv,
    tagIndex,
    metadata,
  };
}

/**
 * Decrypt only attachment metadata (filename, mime, size) — not the bytes.
 * Cheap enough to run for every visible card without touching the payload.
 */
async function decryptAttachmentMeta(msg, secret, groupId = msg.groupId) {
  if (!msg || !secret || !msg.encryptedMetadata || !msg.metadataIv) return {};
  const identity = {
    groupId: msg.groupId || groupId,
    id: msg.id,
    senderId: msg.senderId,
    type: msg.type || 'file',
    keyVersion: msg.keyVersion || cryptoV2.KEY_VERSION,
    revision: msg.revision || 1,
  };
  const aad = cryptoV2.messageAad(identity);
  try {
    return await cryptoV2.decryptJson(
      msg.encryptedMetadata,
      msg.metadataIv,
      secret,
      groupId,
      'metadata',
      aad
    );
  } catch {
    return {};
  }
}

async function decryptAttachment(msg, secret, groupId = msg.groupId) {
  const identity = {
    groupId: msg.groupId || groupId,
    id: msg.id,
    senderId: msg.senderId,
    type: msg.type || 'file',
    keyVersion: msg.keyVersion || cryptoV2.KEY_VERSION,
    revision: msg.revision || 1,
  };
  const aad = cryptoV2.messageAad(identity);
  // Server stores standard base64 for binary uploads; try both encodings.
  let cipherBytes;
  try {
    cipherBytes = cryptoV2.base64UrlToBytes(msg.encryptedContent);
  } catch {
    cipherBytes = new Uint8Array(Buffer.from(msg.encryptedContent, 'base64'));
  }
  // Server uses base64 (not base64url) for raw upload body.
  if (!msg.encryptedContent.includes('-') && !msg.encryptedContent.includes('_')) {
    cipherBytes = new Uint8Array(Buffer.from(msg.encryptedContent, 'base64'));
  }
  const plain = await cryptoV2.decryptBytes(cipherBytes, msg.iv, secret, groupId, aad);
  let metadata = {};
  if (msg.encryptedMetadata && msg.metadataIv) {
    metadata = await cryptoV2.decryptJson(
      msg.encryptedMetadata,
      msg.metadataIv,
      secret,
      groupId,
      'metadata',
      aad
    );
  }
  return { bytes: Buffer.from(plain), metadata };
}

function formatMessageLine(msg, decrypted) {
  const time = msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString() : '';
  const name = msg.senderName || msg.senderId || '?';
  const channel = decrypted?.channel ? `#${decrypted.channel}` : '';
  const edited = msg.editedAt ? ' (edited)' : '';
  const disappearing = msg.isDisappearing ? ' [disappear]' : '';
  const type = msg.type && msg.type !== 'text' ? ` <${msg.type}>` : '';
  const text = decrypted?.text != null
    ? decrypted.text
    : (decrypted?.error ? `[unable to decrypt: ${decrypted.error}]` : '[encrypted]');
  return `${time} ${name}${type}${disappearing}${edited} ${channel}: ${text}`;
}

module.exports = {
  DEFAULT_CHANNEL,
  MIN_DISAPPEARING_MS,
  MAX_DISAPPEARING_MS,
  parseDurationToMs,
  clampDisappearing,
  buildMessageIdentity,
  encryptTextEnvelope,
  decryptServerMessage,
  encryptAttachmentEnvelope,
  decryptAttachmentMeta,
  decryptAttachment,
  formatMessageLine,
};
