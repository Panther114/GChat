'use strict';

const crypto = require('node:crypto');
const { ciphertextSampleHash } = require('./sync-v2-migration');

const EXPECTED_SUMMARIES_SQL = `
  SELECT group_id,
         COALESCE(tag_index, 'main') AS channel_key,
         id AS last_message_id,
         created_at AS last_message_at,
         message_count
  FROM (
    SELECT m.*,
           COUNT(*) OVER (PARTITION BY m.group_id, m.tag_index) AS message_count,
           ROW_NUMBER() OVER (
             PARTITION BY m.group_id, m.tag_index
             ORDER BY m.created_at DESC, m.id DESC
           ) AS rn
    FROM messages m
    WHERE m.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM group_history_boundaries boundary
        WHERE boundary.group_id = m.group_id
          AND boundary.channel_key IN ('*', COALESCE(m.tag_index, 'main'))
          AND ((m.created_seq > 0 AND m.created_seq <= boundary.cleared_seq)
            OR (m.created_seq = 0 AND m.created_at <= boundary.cleared_at))
      )
  )
  WHERE rn = 1
  ORDER BY group_id, channel_key
`;

function summaryHash(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function getExpectedRows(db) {
  return db.prepare(EXPECTED_SUMMARIES_SQL).all();
}

function getCurrentRows(db) {
  return db.prepare(`
    SELECT group_id, channel_key, last_message_id, last_message_at, message_count
    FROM group_channels ORDER BY group_id, channel_key
  `).all();
}

function verifyChannelSummaries(db) {
  const expected = getExpectedRows(db);
  const current = getCurrentRows(db);
  const expectedHash = summaryHash(expected);
  const currentHash = summaryHash(current);
  return {
    ok: expected.length === current.length && expectedHash === currentHash,
    expectedRows: expected.length,
    currentRows: current.length,
    expectedHash,
    currentHash,
    ciphertext: ciphertextSampleHash(db),
  };
}

function applyChannelSummaryReconciliation(db) {
  const ciphertextBefore = ciphertextSampleHash(db);
  const expected = getExpectedRows(db);
  const reconcile = db.transaction(() => {
    db.prepare('DELETE FROM group_channels').run();
    const insert = db.prepare(`
      INSERT INTO group_channels (
        group_id, channel_key, last_message_id, last_message_at, message_count
      ) VALUES (@group_id, @channel_key, @last_message_id, @last_message_at, @message_count)
    `);
    for (const row of expected) insert.run(row);
  });
  reconcile();
  const ciphertextAfter = ciphertextSampleHash(db);
  if (ciphertextBefore.rows !== ciphertextAfter.rows || ciphertextBefore.sha256 !== ciphertextAfter.sha256) {
    throw new Error('Reconciliation changed message rows or ciphertext');
  }
  const verification = verifyChannelSummaries(db);
  if (!verification.ok) throw new Error('Channel-summary verification failed');
  return { appliedRows: expected.length, ciphertextBefore, ciphertextAfter, verification };
}

module.exports = { applyChannelSummaryReconciliation, verifyChannelSummaries };
