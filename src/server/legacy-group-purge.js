'use strict';

function purgePreEscrowGroups(db) {
  const legacyWhere = `
    key_escrow_ciphertext IS NULL
    OR key_escrow_iv IS NULL
    OR key_escrow_version IS NULL
  `;
  const count = db.prepare(`SELECT COUNT(*) AS count FROM group_chats WHERE ${legacyWhere}`)
    .get().count;
  if (!count) return { groups: 0, messages: 0, memberships: 0, aiUsageEvents: 0 };

  const deleteMessageReads = db.prepare(`
    DELETE FROM message_reads
    WHERE message_id IN (
      SELECT id FROM messages WHERE group_id IN (SELECT id FROM group_chats WHERE ${legacyWhere})
    )
  `);
  const deleteDisappearingStates = db.prepare(`
    DELETE FROM disappearing_message_states
    WHERE message_id IN (
      SELECT id FROM messages WHERE group_id IN (SELECT id FROM group_chats WHERE ${legacyWhere})
    )
  `);
  const deleteMessages = db.prepare(`DELETE FROM messages WHERE group_id IN (SELECT id FROM group_chats WHERE ${legacyWhere})`);
  const deleteMemberships = db.prepare(`DELETE FROM group_members WHERE group_id IN (SELECT id FROM group_chats WHERE ${legacyWhere})`);
  const deleteAiUsageEvents = db.prepare(`DELETE FROM ai_usage_events WHERE group_id IN (SELECT id FROM group_chats WHERE ${legacyWhere})`);
  const deleteGroups = db.prepare(`DELETE FROM group_chats WHERE ${legacyWhere}`);

  return db.transaction(() => {
    deleteMessageReads.run();
    deleteDisappearingStates.run();
    const messages = deleteMessages.run().changes;
    const memberships = deleteMemberships.run().changes;
    const aiUsageEvents = deleteAiUsageEvents.run().changes;
    const groups = deleteGroups.run().changes;
    return { groups, messages, memberships, aiUsageEvents };
  })();
}

module.exports = { purgePreEscrowGroups };
