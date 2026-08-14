'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const {
  createSyncService,
  decodeHistoryCursor,
  initializeSyncBaselines,
  installSyncV2Schema,
  normalizeChannelKey,
} = require('../src/server/sync-v2');
const { applySyncV2Migration, ciphertextSampleHash } = require('../src/server/sync-v2-migration');
const {
  applyChannelSummaryReconciliation,
  verifyChannelSummaries,
} = require('../src/server/channel-summary-reconciliation');

function fixtureDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-sync-v2-test-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE group_chats (id TEXT PRIMARY KEY);
    CREATE TABLE group_members (group_id TEXT, user_id TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, icon_color TEXT);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      encrypted_content TEXT NOT NULL, iv TEXT NOT NULL, created_at TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text', whisper_to TEXT, tag_index TEXT,
      revision INTEGER NOT NULL DEFAULT 1, encrypted_metadata TEXT, metadata_iv TEXT
    );
    CREATE TABLE message_reads (message_id TEXT, user_id TEXT, PRIMARY KEY (message_id, user_id));
    INSERT INTO group_chats (id) VALUES ('g1');
    INSERT INTO users (id, username, icon_color) VALUES ('u1', 'alice', '#fff');
    INSERT INTO group_members (group_id, user_id) VALUES ('g1', 'u1');
  `);
  return db;
}

test('sync migration is additive and preserves sampled ciphertext', () => {
  const db = fixtureDb();
  try {
    db.prepare(`INSERT INTO messages (id, group_id, sender_id, encrypted_content, iv, created_at, encrypted_metadata, metadata_iv)
      VALUES (?, 'g1', 'u1', ?, ?, ?, ?, ?)`)
      .run('m1', 'ciphertext', 'AAAAAAAAAAAAAAAA', '2026-01-01T00:00:00.000Z', 'metadata', 'BBBBBBBBBBBBBBBB');
    const before = ciphertextSampleHash(db);
    const report = applySyncV2Migration(db);
    assert.equal(report.ok, true);
    assert.equal(report.verification.groupCount, 1);
    assert.equal(report.verification.stateCount, 1);
    assert.deepEqual(ciphertextSampleHash(db), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM group_channels').get().count, 1);
  } finally { db.close(); }
});

test('channel-summary reconciliation respects delete/clear boundaries and preserves ciphertext', () => {
  const db = fixtureDb();
  try {
    installSyncV2Schema(db);
    const insert = db.prepare(`INSERT INTO messages
      (id, group_id, sender_id, encrypted_content, iv, created_at, created_seq, type, tag_index, deleted_at)
      VALUES (?, 'g1', 'u1', ?, 'AAAAAAAAAAAAAAAA', ?, ?, 'text', ?, ?)`);
    insert.run('old', 'cipher-old', '2026-01-01T00:00:00.000Z', 1, 'channel-a', null);
    insert.run('deleted', 'cipher-deleted', '2026-01-02T00:00:00.000Z', 2, 'channel-a', '2026-01-03T00:00:00.000Z');
    insert.run('visible', 'cipher-visible', '2026-01-04T00:00:00.000Z', 4, 'channel-a', null);
    db.prepare(`INSERT INTO group_history_boundaries
      (group_id, channel_key, cleared_at, cleared_seq, cleared_by)
      VALUES ('g1', 'channel-a', '2026-01-03T00:00:00.000Z', 3, 'u1')`).run();
    const before = ciphertextSampleHash(db);
    const report = applyChannelSummaryReconciliation(db);
    assert.equal(report.appliedRows, 1);
    assert.deepEqual(ciphertextSampleHash(db), before);
    assert.equal(verifyChannelSummaries(db).ok, true);
    const summary = db.prepare("SELECT * FROM group_channels WHERE group_id = 'g1' AND channel_key = 'channel-a'").get();
    assert.equal(summary.last_message_id, 'visible');
    assert.equal(summary.message_count, 1);
  } finally { db.close(); }
});

test('transaction failure cannot publish a sequence or partial mutation', () => {
  const db = fixtureDb();
  try {
    installSyncV2Schema(db);
    initializeSyncBaselines(db);
    const sync = createSyncService(db);
    assert.throws(() => sync.commit({
      groupId: 'g1', userId: 'u1', eventType: 'message.created', entityId: 'm1',
      clientMutationId: 'mutation-1',
      apply: () => {
        db.prepare(`INSERT INTO messages (id, group_id, sender_id, encrypted_content, iv, created_at)
          VALUES ('m1', 'g1', 'u1', 'cipher', 'AAAAAAAAAAAAAAAA', '2026-01-01T00:00:00.000Z')`).run();
        throw new Error('fault');
      },
    }), /fault/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = 'm1'").get().count, 0);
    assert.equal(sync.ensureState('g1').next_seq, 0);
  } finally { db.close(); }
});

test('mutation IDs are idempotent and events are monotonically ordered', () => {
  const db = fixtureDb();
  try {
    const sync = createSyncService(db);
    initializeSyncBaselines(db);
    const first = sync.commit({
      groupId: 'g1', userId: 'u1', eventType: 'message.created', entityId: 'm1',
      clientMutationId: 'same-mutation', apply: () => {},
    });
    const duplicate = sync.commit({
      groupId: 'g1', userId: 'u1', eventType: 'message.created', entityId: 'm2',
      clientMutationId: 'same-mutation', apply: () => { throw new Error('must not run'); },
    });
    const second = sync.commit({
      groupId: 'g1', userId: 'u1', eventType: 'message.deleted', entityId: 'm1',
      clientMutationId: 'second-mutation', apply: () => {},
    });
    assert.equal(first.seq, 1);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.seq, 1);
    assert.equal(second.seq, 2);
    const delta = sync.getEvents('g1', 1, 0, 200);
    assert.deepEqual(delta.events.map((event) => event.seq), [1, 2]);
  } finally { db.close(); }
});

test('channel history is isolated, bounded, cursor-stable, and clear-boundary aware', () => {
  const db = fixtureDb();
  try {
    const sync = createSyncService(db);
    const insert = db.prepare(`INSERT INTO messages
      (id, group_id, sender_id, encrypted_content, iv, created_at, type, tag_index)
      VALUES (?, 'g1', 'u1', 'cipher', 'AAAAAAAAAAAAAAAA', ?, 'text', ?)`);
    for (let index = 0; index < 60; index += 1) {
      insert.run(`a-${String(index).padStart(2, '0')}`, `2026-01-01T00:${String(index).padStart(2, '0')}:00.000Z`, 'channel-a');
      insert.run(`b-${String(index).padStart(2, '0')}`, `2026-01-01T00:${String(index).padStart(2, '0')}:30.000Z`, 'channel-b');
    }
    const first = sync.getChannelHistory({ groupId: 'g1', viewerId: 'u1', channelKey: 'channel-a', limit: 500 });
    assert.equal(first.rows.length, 50);
    assert.ok(first.rows.every((row) => row.tag_index === 'channel-a'));
    assert.ok(decodeHistoryCursor(first.nextCursor));
    const second = sync.getChannelHistory({ groupId: 'g1', viewerId: 'u1', channelKey: 'channel-a', before: first.nextCursor, limit: 50 });
    assert.equal(second.rows.length, 10);
    assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.id)).size, 60);
    db.prepare(`INSERT INTO group_history_boundaries (group_id, channel_key, cleared_at, cleared_seq, cleared_by)
      VALUES ('g1', 'channel-a', '2026-01-01T00:30:00.000Z', 1, 'u1')`).run();
    const afterClear = sync.getChannelHistory({ groupId: 'g1', viewerId: 'u1', channelKey: 'channel-a', limit: 50 });
    assert.ok(afterClear.rows.every((row) => row.created_at > '2026-01-01T00:30:00.000Z'));
  } finally { db.close(); }
});

test('post-clear messages remain visible when their wall-clock timestamp ties the clear', () => {
  const db = fixtureDb();
  try {
    const sync = createSyncService(db);
    initializeSyncBaselines(db);
    const tiedAt = '2026-01-01T00:00:00.000Z';
    const clear = sync.commit({
      groupId: 'g1', userId: 'u1', eventType: 'history.cleared',
      channelKey: 'main', clientMutationId: 'clear-main', createdAt: tiedAt,
      apply: ({ seq }) => db.prepare(`
        INSERT INTO group_history_boundaries (group_id, channel_key, cleared_at, cleared_seq, cleared_by)
        VALUES ('g1', 'main', ?, ?, 'u1')
      `).run(tiedAt, seq),
    });
    const sent = sync.commit({
      groupId: 'g1', userId: 'u1', eventType: 'message.created', entityId: 'after-clear',
      channelKey: 'main', clientMutationId: 'send-after-clear', createdAt: tiedAt,
      apply: ({ seq }) => db.prepare(`INSERT INTO messages
        (id, group_id, sender_id, encrypted_content, iv, created_at, created_seq, type)
        VALUES ('after-clear', 'g1', 'u1', 'cipher', 'AAAAAAAAAAAAAAAA', ?, ?, 'text')
      `).run(tiedAt, seq),
    });
    assert.equal(clear.seq, 1);
    assert.equal(sent.seq, 2);
    const history = sync.getChannelHistory({ groupId: 'g1', viewerId: 'u1', channelKey: 'main' });
    assert.deepEqual(history.rows.map((row) => row.id), ['after-clear']);
  } finally { db.close(); }
});

test('bootstrap ETag changes with the durable latest sequence', () => {
  const db = fixtureDb();
  try {
    const sync = createSyncService(db);
    const base = [{ id: 'g1', epoch: 1, latestSeq: 0, membershipRevision: 0, unreadCount: 0 }];
    const advanced = [{ ...base[0], latestSeq: 1 }];
    assert.notEqual(sync.etagForBootstrap(base), sync.etagForBootstrap(advanced));
  } finally { db.close(); }
});

test('channel identity never collapses an opaque tag into main', () => {
  assert.equal(normalizeChannelKey(null), 'main');
  assert.equal(normalizeChannelKey('opaque_tag-1'), 'opaque_tag-1');
  assert.equal(normalizeChannelKey('bad channel'), null);
  assert.notEqual(normalizeChannelKey('opaque_tag-1'), normalizeChannelKey(null));
});
