'use strict';

const crypto = require('crypto');
const { hashJoinCode, normalizeJoinCode } = require('./group-security');
const { decryptEscrowPayload, encryptEscrowPayload } = require('./group-key-escrow');

const INVITE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const INVITE_CODE_LENGTH = 6;

function generateInviteCode(randomBytes = crypto.randomBytes) {
  let result = '';
  while (result.length < INVITE_CODE_LENGTH) {
    const bytes = randomBytes(16);
    for (const byte of bytes) {
      // Rejection sampling avoids modulo bias (252 is divisible by 36).
      if (byte >= 252) continue;
      result += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
      if (result.length === INVITE_CODE_LENGTH) break;
    }
  }
  return result;
}

function migrateGroupCodes(db, { groupCodePepper, groupKeyEscrowMasterKey, generateCode = generateInviteCode }) {
  if (!groupCodePepper || !groupKeyEscrowMasterKey) throw new Error('Group-code migration requires configured secrets');
  const groups = db.prepare(`
    SELECT id, code, key_escrow_ciphertext, key_escrow_iv, key_escrow_version
    FROM group_chats
    ORDER BY id ASC
  `).all();
  const findByCode = db.prepare('SELECT id FROM group_chats WHERE code = ?');
  const updateGroup = db.prepare(`
    UPDATE group_chats
    SET code = ?, key_escrow_ciphertext = ?, key_escrow_iv = ?, key_escrow_version = ?
    WHERE id = ?
  `);
  const assignedHashes = new Set();

  const migrate = db.transaction(() => {
    let migrated = 0;
    for (const group of groups) {
      const existingPayload = decryptEscrowPayload(groupKeyEscrowMasterKey, group.id, {
        ciphertext: group.key_escrow_ciphertext,
        iv: group.key_escrow_iv,
        version: group.key_escrow_version,
      });
      const existingCodeHash = hashJoinCode(existingPayload.joinCode, groupCodePepper);
      if (normalizeJoinCode(existingPayload.joinCode) && existingCodeHash === group.code) continue;

      let code;
      let codeHash;
      do {
        code = generateCode();
        codeHash = hashJoinCode(code, groupCodePepper);
      } while (!codeHash || assignedHashes.has(codeHash) || findByCode.get(codeHash));

      const escrow = encryptEscrowPayload(groupKeyEscrowMasterKey, group.id, {
        secret: existingPayload.secret,
        joinCode: code,
      });
      updateGroup.run(codeHash, escrow.ciphertext, escrow.iv, escrow.version, group.id);
      assignedHashes.add(codeHash);
      migrated += 1;
    }
    return migrated;
  });

  return { migrated: migrate() };
}

module.exports = { generateInviteCode, migrateGroupCodes };
