'use strict';

const { ENCRYPTION_VERSION, KEY_VERSION } = require('./config');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;

function parsePositiveInteger(value, fallback = null) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function validateV2MessageEnvelope(payload = {}) {
  if (!UUID_V4.test(String(payload.id || ''))) return { ok: false, error: 'Invalid message ID' };
  if (Number(payload.encryptionVersion) !== ENCRYPTION_VERSION) return { ok: false, error: 'Unsupported encryption version' };
  if (Number(payload.keyVersion) !== KEY_VERSION) return { ok: false, error: 'Unsupported key version' };
  const revision = parsePositiveInteger(payload.revision, 1);
  if (revision !== 1) return { ok: false, error: 'New messages must start at revision 1' };
  if (payload.replyToId != null && !UUID_V4.test(String(payload.replyToId))) {
    return { ok: false, error: 'Invalid reply target' };
  }
  for (const [field, value] of [['tagIndex', payload.tagIndex], ['spamSignature', payload.spamSignature]]) {
    if (value != null && value !== '' && !BASE64URL_SHA256.test(String(value))) {
      return { ok: false, error: `Invalid ${field}` };
    }
  }
  return { ok: true, revision };
}

function validateEditEnvelope(payload = {}, currentRevision) {
  const expectedRevision = parsePositiveInteger(payload.expectedRevision);
  if (!expectedRevision) return { ok: false, status: 400, error: 'expectedRevision is required' };
  if (expectedRevision !== Number(currentRevision)) return { ok: false, status: 409, error: 'Message was edited elsewhere' };
  if (Number(payload.encryptionVersion) !== ENCRYPTION_VERSION || Number(payload.keyVersion) !== KEY_VERSION) {
    return { ok: false, status: 400, error: 'Unsupported encryption version' };
  }
  return { ok: true, revision: expectedRevision + 1 };
}

module.exports = {
  validateEditEnvelope,
  validateV2MessageEnvelope,
};
