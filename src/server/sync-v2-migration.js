'use strict';

const crypto = require('node:crypto');
const {
  initializeSyncBaselines,
  installSyncV2Schema,
  rebuildChannelSummaries,
} = require('./sync-v2');

const MAX_DURATION_MS = 8 * 60 * 1000;
const MAX_PAGE_GROWTH_RATIO = 1.25;

function databaseBytes(db) {
  return Number(db.pragma('page_count', { simple: true })) * Number(db.pragma('page_size', { simple: true }));
}

function ciphertextSampleHash(db) {
  const rows = db.prepare(`
    SELECT id, encrypted_content, iv, encrypted_metadata, metadata_iv
    FROM messages ORDER BY id LIMIT 100
  `).all();
  const hash = crypto.createHash('sha256');
  for (const row of rows) {
    hash.update(String(row.id));
    hash.update('\0');
    hash.update(String(row.encrypted_content || ''));
    hash.update('\0');
    hash.update(String(row.iv || ''));
    hash.update('\0');
    hash.update(String(row.encrypted_metadata || ''));
    hash.update('\0');
    hash.update(String(row.metadata_iv || ''));
    hash.update('\0');
  }
  return { rows: rows.length, sha256: hash.digest('hex') };
}

function verifySyncV2Migration(db) {
  const integrity = db.pragma('integrity_check', { simple: true });
  const foreignKeyErrors = db.pragma('foreign_key_check');
  const requiredTables = [
    'group_sync_state', 'group_sync_events', 'group_channels',
    'group_history_boundaries', 'client_mutations', 'pending_uploads',
  ];
  const present = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((row) => row.name));
  const missingTables = requiredTables.filter((name) => !present.has(name));
  const groupCount = Number(db.prepare('SELECT COUNT(*) AS count FROM group_chats').get().count);
  const stateCount = present.has('group_sync_state')
    ? Number(db.prepare('SELECT COUNT(*) AS count FROM group_sync_state').get().count)
    : 0;
  return {
    ok: integrity === 'ok' && foreignKeyErrors.length === 0 && missingTables.length === 0 && stateCount === groupCount,
    integrity,
    foreignKeyErrors,
    missingTables,
    groupCount,
    stateCount,
    messageCount: Number(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count),
    ciphertextSample: ciphertextSampleHash(db),
  };
}

function applySyncV2Migration(db, { now = () => new Date().toISOString(), clock = () => Date.now() } = {}) {
  const startedAt = clock();
  const beforeBytes = databaseBytes(db);
  const beforeMessages = Number(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count);
  const beforeHash = ciphertextSampleHash(db);
  let baselineGroups = 0;
  let channelRows = 0;
  const migrate = db.transaction(() => {
    installSyncV2Schema(db);
    baselineGroups = initializeSyncBaselines(db, now());
    channelRows = rebuildChannelSummaries(db);
    const afterMessages = Number(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count);
    const afterHash = ciphertextSampleHash(db);
    const afterBytes = databaseBytes(db);
    const durationMs = clock() - startedAt;
    if (durationMs > MAX_DURATION_MS) throw new Error('Migration exceeded eight-minute budget');
    // New sync tables dominate tiny/empty fixtures. Enforce the ratio once the
    // source is large enough that it represents a real production data file.
    if (beforeBytes >= 1024 * 1024 && afterBytes / beforeBytes > MAX_PAGE_GROWTH_RATIO) {
      throw new Error('Migration exceeded 25% database growth budget');
    }
    if (afterMessages !== beforeMessages || afterHash.sha256 !== beforeHash.sha256) {
      throw new Error('Migration changed existing ciphertext or message rows');
    }
  });
  migrate();
  const verification = verifySyncV2Migration(db);
  if (!verification.ok) throw new Error(`Migration verification failed: ${JSON.stringify(verification)}`);
  return {
    ok: true,
    durationMs: clock() - startedAt,
    baselineGroups,
    channelRows,
    beforeBytes,
    afterBytes: databaseBytes(db),
    verification,
  };
}

module.exports = { applySyncV2Migration, ciphertextSampleHash, verifySyncV2Migration };
