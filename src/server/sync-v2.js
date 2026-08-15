'use strict';

const crypto = require('node:crypto');

const SYNC_PROTOCOL_VERSION = 2;
const SYNC_EVENT_LIMIT = 200;
const SYNC_EVENT_RETENTION = 10_000;
const SYNC_PRUNE_INTERVAL = 256;
const HISTORY_PAGE_LIMIT = 50;
const GROUP_CLEAR_CHANNEL = '*';
const MAIN_CHANNEL = 'main';

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function addColumn(db, table, definition) {
  const column = definition.trim().split(/\s+/)[0];
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function installSyncV2Schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_sync_state (
      group_id TEXT PRIMARY KEY,
      epoch INTEGER NOT NULL DEFAULT 1,
      next_seq INTEGER NOT NULL DEFAULT 0,
      min_retained_seq INTEGER NOT NULL DEFAULT 0,
      membership_revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_sync_events (
      group_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      entity_id TEXT,
      channel_key TEXT NOT NULL DEFAULT 'main',
      revision INTEGER NOT NULL DEFAULT 1,
      auxiliary_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (group_id, epoch, seq)
    );

    CREATE TABLE IF NOT EXISTS group_channels (
      group_id TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      encrypted_descriptor TEXT,
      descriptor_iv TEXT,
      key_version INTEGER NOT NULL DEFAULT 1,
      last_message_id TEXT,
      last_message_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (group_id, channel_key)
    );

    CREATE TABLE IF NOT EXISTS group_history_boundaries (
      group_id TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      cleared_at TEXT NOT NULL,
      cleared_seq INTEGER NOT NULL,
      cleared_by TEXT NOT NULL,
      PRIMARY KEY (group_id, channel_key)
    );

    CREATE TABLE IF NOT EXISTS client_mutations (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      client_mutation_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      entity_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (group_id, user_id, client_mutation_id)
    );

    CREATE TABLE IF NOT EXISTS pending_uploads (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      object_key TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      expected_size INTEGER NOT NULL,
      expected_sha256 TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (group_id, user_id, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sync_events_group_seq
      ON group_sync_events (group_id, epoch, seq);
    CREATE INDEX IF NOT EXISTS idx_client_mutations_created
      ON client_mutations (created_at);
    CREATE INDEX IF NOT EXISTS idx_pending_uploads_expiry
      ON pending_uploads (completed_at, expires_at);
  `);

  addColumn(db, 'messages', 'created_seq INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'messages', 'deleted_at TEXT');
  addColumn(db, 'messages', 'deleted_by TEXT');
  addColumn(db, 'messages', 'attachment_object_key TEXT');
  addColumn(db, 'messages', 'attachment_size INTEGER');
  addColumn(db, 'messages', 'attachment_sha256 TEXT');
  addColumn(db, 'users', 'profile_object_key TEXT');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_group_channel_history
      ON messages (group_id, tag_index, created_at DESC, id DESC)
      WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_group_created_seq
      ON messages (group_id, created_seq, id);
    CREATE INDEX IF NOT EXISTS idx_messages_attachment_object
      ON messages (attachment_object_key)
      WHERE attachment_object_key IS NOT NULL;
  `);
}

function initializeSyncBaselines(db, now = new Date().toISOString()) {
  return db.prepare(`
    INSERT OR IGNORE INTO group_sync_state (
      group_id, epoch, next_seq, min_retained_seq, membership_revision, updated_at
    )
    SELECT id, 1, 0, 0, 0, ? FROM group_chats
  `).run(now).changes;
}

function rebuildChannelSummaries(db) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM group_channels').run();
    return db.prepare(`
      INSERT INTO group_channels (
        group_id, channel_key, last_message_id, last_message_at, message_count
      )
      SELECT group_id,
             CASE WHEN tag_index IS NULL THEN 'main' ELSE tag_index END,
             max_id,
             max_created_at,
             message_count
      FROM (
        SELECT group_id,
               tag_index,
               id AS max_id,
               created_at AS max_created_at,
               COUNT(*) OVER (PARTITION BY group_id, tag_index) AS message_count,
               ROW_NUMBER() OVER (
                 PARTITION BY group_id, tag_index
                 ORDER BY created_at DESC, id DESC
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
    `).run().changes;
  });
  return tx();
}

function normalizeChannelKey(value) {
  if (value == null || value === '' || value === MAIN_CHANNEL) return MAIN_CHANNEL;
  const normalized = String(value).slice(0, 128);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalized)) return null;
  return normalized;
}

function channelKeyToTagIndex(channelKey) {
  return channelKey === MAIN_CHANNEL ? null : channelKey;
}

function encodeHistoryCursor(message) {
  if (!message) return null;
  return Buffer.from(JSON.stringify({ at: message.created_at, id: message.id }), 'utf8').toString('base64url');
}

function decodeHistoryCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value).slice(0, 512), 'base64url').toString('utf8'));
    if (typeof parsed.at !== 'string' || typeof parsed.id !== 'string') return null;
    return { at: parsed.at.slice(0, 64), id: parsed.id.slice(0, 64) };
  } catch {
    return null;
  }
}

function parseAuxiliary(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function createSyncService(db, { install = true } = {}) {
  if (install) installSyncV2Schema(db);

  const ensureStateStmt = db.prepare(`
    INSERT OR IGNORE INTO group_sync_state (
      group_id, epoch, next_seq, min_retained_seq, membership_revision, updated_at
    ) VALUES (?, 1, 0, 0, 0, ?)
  `);
  const getStateStmt = db.prepare('SELECT * FROM group_sync_state WHERE group_id = ?');
  const updateStateStmt = db.prepare(`
    UPDATE group_sync_state SET next_seq = ?, min_retained_seq = ?, updated_at = ? WHERE group_id = ?
  `);
  const bumpMembershipRevisionStmt = db.prepare(`
    UPDATE group_sync_state SET membership_revision = membership_revision + 1 WHERE group_id = ?
  `);
  const insertEventStmt = db.prepare(`
    INSERT INTO group_sync_events (
      group_id, epoch, seq, event_type, entity_id, channel_key, revision, auxiliary_json, created_at
    ) VALUES (@groupId, @epoch, @seq, @eventType, @entityId, @channelKey, @revision, @auxiliaryJson, @createdAt)
  `);
  const findMutationStmt = db.prepare(`
    SELECT epoch, seq, entity_id FROM client_mutations
    WHERE group_id = ? AND user_id = ? AND client_mutation_id = ?
  `);
  const insertMutationStmt = db.prepare(`
    INSERT INTO client_mutations (
      group_id, user_id, client_mutation_id, epoch, seq, entity_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const pruneEventsStmt = db.prepare(`
    DELETE FROM group_sync_events
    WHERE rowid IN (
      SELECT rowid FROM group_sync_events
      WHERE group_id = ? AND epoch = ? AND seq < ?
      ORDER BY seq ASC LIMIT ?
    )
  `);
  const upsertChannelStmt = db.prepare(`
    INSERT INTO group_channels (
      group_id, channel_key, encrypted_descriptor, descriptor_iv, key_version,
      last_message_id, last_message_at, message_count
    ) VALUES (@groupId, @channelKey, @encryptedDescriptor, @descriptorIv, @keyVersion,
              @lastMessageId, @lastMessageAt, 1)
    ON CONFLICT(group_id, channel_key) DO UPDATE SET
      encrypted_descriptor = COALESCE(excluded.encrypted_descriptor, group_channels.encrypted_descriptor),
      descriptor_iv = COALESCE(excluded.descriptor_iv, group_channels.descriptor_iv),
      key_version = excluded.key_version,
      last_message_id = excluded.last_message_id,
      last_message_at = excluded.last_message_at,
      message_count = group_channels.message_count + 1
  `);
  const getChannelSummaryStmt = db.prepare(`
    SELECT last_message_id, message_count FROM group_channels
    WHERE group_id = ? AND channel_key = ?
  `);
  const deleteChannelSummaryStmt = db.prepare('DELETE FROM group_channels WHERE group_id = ? AND channel_key = ?');
  const deleteGroupChannelSummariesStmt = db.prepare('DELETE FROM group_channels WHERE group_id = ?');
  const decrementChannelSummaryStmt = db.prepare(`
    UPDATE group_channels SET message_count = MAX(0, message_count - 1)
    WHERE group_id = ? AND channel_key = ?
  `);
  const replaceChannelSummaryTailStmt = db.prepare(`
    UPDATE group_channels
    SET last_message_id = ?, last_message_at = ?, message_count = MAX(0, message_count - 1)
    WHERE group_id = ? AND channel_key = ?
  `);
  const getLatestVisibleChannelMessageStmt = db.prepare(`
    SELECT m.id, m.created_at
    FROM messages m
    WHERE m.group_id = @groupId
      AND m.deleted_at IS NULL
      AND ((@tagIndex IS NULL AND m.tag_index IS NULL) OR m.tag_index = @tagIndex)
      AND NOT EXISTS (
        SELECT 1 FROM group_history_boundaries boundary
        WHERE boundary.group_id = m.group_id
          AND boundary.channel_key IN ('*', @channelKey)
          AND ((m.created_seq > 0 AND m.created_seq <= boundary.cleared_seq)
            OR (m.created_seq = 0 AND m.created_at <= boundary.cleared_at))
      )
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  `);

  function removeMessageFromChannelSummary(groupId, channelKey, messageId) {
    const normalizedChannel = normalizeChannelKey(channelKey) || MAIN_CHANNEL;
    const summary = getChannelSummaryStmt.get(groupId, normalizedChannel);
    if (!summary) return;
    if (Number(summary.message_count) <= 1) {
      deleteChannelSummaryStmt.run(groupId, normalizedChannel);
      return;
    }
    if (String(summary.last_message_id) !== String(messageId)) {
      decrementChannelSummaryStmt.run(groupId, normalizedChannel);
      return;
    }
    const latest = getLatestVisibleChannelMessageStmt.get({
      groupId,
      channelKey: normalizedChannel,
      tagIndex: channelKeyToTagIndex(normalizedChannel),
    });
    if (!latest) deleteChannelSummaryStmt.run(groupId, normalizedChannel);
    else replaceChannelSummaryTailStmt.run(latest.id, latest.created_at, groupId, normalizedChannel);
  }

  function clearChannelSummaries(groupId, channelKey = GROUP_CLEAR_CHANNEL) {
    if (channelKey === GROUP_CLEAR_CHANNEL) deleteGroupChannelSummariesStmt.run(groupId);
    else deleteChannelSummaryStmt.run(groupId, normalizeChannelKey(channelKey) || MAIN_CHANNEL);
  }

  const commitTx = db.transaction((options) => {
    const now = options.createdAt || new Date().toISOString();
    ensureStateStmt.run(options.groupId, now);
    if (options.clientMutationId && options.userId) {
      const duplicate = findMutationStmt.get(options.groupId, options.userId, options.clientMutationId);
      if (duplicate) {
        return {
          duplicate: true,
          epoch: duplicate.epoch,
          seq: duplicate.seq,
          entityId: duplicate.entity_id,
        };
      }
    }

    const state = getStateStmt.get(options.groupId);
    const seq = Number(state.next_seq) + 1;
    const result = typeof options.apply === 'function' ? options.apply({ epoch: state.epoch, seq, now }) : null;
    const entityId = options.entityId || result?.entityId || null;
    const channelKey = normalizeChannelKey(options.channelKey || result?.channelKey) || MAIN_CHANNEL;
    const revision = Math.max(1, Number(options.revision || result?.revision) || 1);
    insertEventStmt.run({
      groupId: options.groupId,
      epoch: state.epoch,
      seq,
      eventType: options.eventType,
      entityId,
      channelKey,
      revision,
      auxiliaryJson: options.auxiliary == null ? null : JSON.stringify(options.auxiliary),
      createdAt: now,
    });

    const minRetainedSeq = Math.max(0, seq - SYNC_EVENT_RETENTION + 1);
    updateStateStmt.run(seq, minRetainedSeq, now, options.groupId);
    if (options.membershipChange) bumpMembershipRevisionStmt.run(options.groupId);
    if (options.clientMutationId && options.userId) {
      insertMutationStmt.run(
        options.groupId,
        options.userId,
        options.clientMutationId,
        state.epoch,
        seq,
        entityId,
        now
      );
    }
    if (options.updateChannel) {
      upsertChannelStmt.run({
        groupId: options.groupId,
        channelKey,
        encryptedDescriptor: options.updateChannel.encryptedDescriptor || null,
        descriptorIv: options.updateChannel.descriptorIv || null,
        keyVersion: Math.max(1, Number(options.updateChannel.keyVersion) || 1),
        lastMessageId: entityId,
        lastMessageAt: now,
      });
    }
    if (seq % SYNC_PRUNE_INTERVAL === 0 && minRetainedSeq > 0) {
      pruneEventsStmt.run(options.groupId, state.epoch, minRetainedSeq, SYNC_PRUNE_INTERVAL);
    }
    return { duplicate: false, epoch: state.epoch, seq, entityId, result };
  });

  function commit(options) {
    if (!options?.groupId || !options?.eventType) throw new TypeError('groupId and eventType are required');
    if (options.clientMutationId && !/^[A-Za-z0-9_-]{1,128}$/.test(options.clientMutationId)) {
      throw new TypeError('Invalid clientMutationId');
    }
    return commitTx(options);
  }

  function ensureState(groupId) {
    const now = new Date().toISOString();
    ensureStateStmt.run(groupId, now);
    return getStateStmt.get(groupId);
  }

  function getEvents(groupId, epoch, after, limit = SYNC_EVENT_LIMIT) {
    const state = ensureState(groupId);
    const normalizedEpoch = Number(epoch);
    const normalizedAfter = Math.max(0, Number(after) || 0);
    if (!Number.isInteger(normalizedEpoch) || normalizedEpoch !== Number(state.epoch)) {
      return { resetRequired: true, reason: 'epoch_mismatch', state };
    }
    if (normalizedAfter > 0 && normalizedAfter < Number(state.min_retained_seq) - 1) {
      return { resetRequired: true, reason: 'token_expired', state };
    }
    const safeLimit = Math.min(Math.max(Number(limit) || SYNC_EVENT_LIMIT, 1), SYNC_EVENT_LIMIT);
    const rows = db.prepare(`
      SELECT group_id, epoch, seq, event_type, entity_id, channel_key, revision, auxiliary_json, created_at
      FROM group_sync_events
      WHERE group_id = ? AND epoch = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `).all(groupId, state.epoch, normalizedAfter, safeLimit);
    return {
      resetRequired: false,
      state,
      events: rows.map((row) => ({
        groupId: row.group_id,
        epoch: row.epoch,
        seq: row.seq,
        type: row.event_type,
        entityId: row.entity_id,
        channelKey: row.channel_key,
        revision: row.revision,
        auxiliary: parseAuxiliary(row.auxiliary_json),
        createdAt: row.created_at,
      })),
    };
  }

  function getChannelHistory({ groupId, viewerId, channelKey, before, limit = HISTORY_PAGE_LIMIT }) {
    const normalizedChannel = normalizeChannelKey(channelKey);
    if (!normalizedChannel) throw new TypeError('Invalid channel');
    const cursor = decodeHistoryCursor(before);
    if (before && !cursor) throw new TypeError('Invalid history cursor');
    const tagIndex = channelKeyToTagIndex(normalizedChannel);
    const safeLimit = Math.min(Math.max(Number(limit) || HISTORY_PAGE_LIMIT, 1), HISTORY_PAGE_LIMIT);
    const rows = db.prepare(`
      SELECT m.*, u.username AS sender_name, u.icon_color AS sender_color,
             (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id) AS read_count,
             EXISTS(
               SELECT 1 FROM message_reads mr2
               WHERE mr2.message_id = m.id AND mr2.user_id = @viewerId
             ) AS has_read
      FROM messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.group_id = @groupId
        AND m.deleted_at IS NULL
        AND ((@tagIndex IS NULL AND m.tag_index IS NULL) OR m.tag_index = @tagIndex)
        AND (@beforeAt IS NULL OR m.created_at < @beforeAt OR (m.created_at = @beforeAt AND m.id < @beforeId))
        AND NOT EXISTS (
          SELECT 1 FROM group_history_boundaries boundary
          WHERE boundary.group_id = @groupId
            AND boundary.channel_key IN ('*', @channelKey)
            AND (
              (m.created_seq > 0 AND m.created_seq <= boundary.cleared_seq)
              OR (m.created_seq = 0 AND m.created_at <= boundary.cleared_at)
            )
        )
        AND (
          m.type != 'whisper'
          OR m.sender_id = @viewerId
          OR EXISTS (
            SELECT 1 FROM json_each(COALESCE(m.whisper_to, '[]')) recipient
            WHERE recipient.value = CAST(@viewerId AS TEXT)
          )
        )
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT @limit
    `).all({
      groupId,
      viewerId,
      tagIndex,
      channelKey: normalizedChannel,
      beforeAt: cursor?.at || null,
      beforeId: cursor?.id || null,
      limit: safeLimit,
    });
    const ordered = rows.reverse();
    return {
      rows: ordered,
      nextCursor: rows.length === safeLimit ? encodeHistoryCursor(rows[0]) : null,
    };
  }

  function getMessagesByIds(groupId, ids) {
    const unique = [...new Set(ids.filter(Boolean).map(String))].slice(0, SYNC_EVENT_LIMIT);
    if (!unique.length) return new Map();
    const placeholders = unique.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT m.*, u.username AS sender_name, u.icon_color AS sender_color,
             (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id) AS read_count
      FROM messages m LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.group_id = ? AND m.id IN (${placeholders})
    `).all(groupId, ...unique);
    return new Map(rows.map((row) => [String(row.id), row]));
  }

  function etagForBootstrap(rows) {
    const source = JSON.stringify(rows);
    return `"sync2-${crypto.createHash('sha256').update(source).digest('base64url').slice(0, 22)}"`;
  }

  return {
    clearChannelSummaries,
    commit,
    ensureState,
    etagForBootstrap,
    getChannelHistory,
    getEvents,
    getMessagesByIds,
    removeMessageFromChannelSummary,
  };
}

module.exports = {
  GROUP_CLEAR_CHANNEL,
  HISTORY_PAGE_LIMIT,
  MAIN_CHANNEL,
  SYNC_EVENT_LIMIT,
  SYNC_EVENT_RETENTION,
  SYNC_PROTOCOL_VERSION,
  createSyncService,
  decodeHistoryCursor,
  encodeHistoryCursor,
  initializeSyncBaselines,
  installSyncV2Schema,
  normalizeChannelKey,
  rebuildChannelSummaries,
};
