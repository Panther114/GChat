/**
 * v1.3.13 one-shot data migration: NULL the phantom #main blind tag index.
 *
 * Pre-1.3.13 clients stamped EVERY message with a blind index of the active
 * channel topic — including the literal topic "main" — while read cursors for
 * #main are stored with tag_index NULL. The unread query matches
 * `crc.tag_index IS m.tag_index`, so a "main"-indexed row could never be
 * covered by the #main cursor: it stayed unread forever and the group badge
 * showed a phantom red count even after everything was read.
 *
 * This module recomputes each group's "main" blind index from its escrowed
 * secret and NULLs matching rows. Bounded: one UPDATE per escrowed group
 * (≤ MAX_GROUPS_PER_USER + global). Idempotent — the runtime gates it with a
 * one-shot _config flag.
 */

'use strict';

const crypto = require('crypto');
const { decryptEscrowPayload } = require('./group-key-escrow');

function nullMainTagIndexes(db, masterKey) {
  const escrowedGroups = db.prepare(`
    SELECT id, key_escrow_ciphertext, key_escrow_iv, key_escrow_version
    FROM group_chats
    WHERE key_escrow_ciphertext IS NOT NULL AND key_escrow_iv IS NOT NULL
  `).all();
  let fixed = 0;
  const nullMainIndex = db.prepare('UPDATE messages SET tag_index = NULL WHERE group_id = ? AND tag_index = ?');
  const fixTx = db.transaction((rows) => {
    for (const group of rows) {
      try {
        const escrowPayload = decryptEscrowPayload(masterKey, group.id, {
          ciphertext: group.key_escrow_ciphertext,
          iv: group.key_escrow_iv,
          version: group.key_escrow_version,
        });
        const groupSecret = Buffer.from(escrowPayload.secret, 'base64url');
        const indexKey = crypto.hkdfSync('sha256', groupSecret, Buffer.from(group.id), Buffer.from('gchat-tag-index-v2'), 32);
        const mainIndex = crypto.createHmac('sha256', indexKey).update('main').digest('base64url');
        fixed += Number(nullMainIndex.run(group.id, mainIndex).changes || 0);
      } catch {
        // Group whose escrow cannot be decrypted — skip (rare, isolated).
      }
    }
  });
  fixTx(escrowedGroups);
  return fixed;
}

module.exports = { nullMainTagIndexes };
