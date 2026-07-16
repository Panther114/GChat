'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { CRYPTO_EPOCH } = require('../src/server/config');

const CONFIRMATION = 'RESET_ALL_GCHAT_CHATS_FOR_INCREMENT_A';
if (process.env.CONFIRM_RESET !== CONFIRMATION) {
  console.error(`Refusing to reset chats. Set CONFIRM_RESET=${CONFIRMATION} to continue.`);
  process.exit(2);
}

async function main() {
  const dbPath = path.resolve(process.env.DB_PATH || './Gchat.db');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.increment-a-${timestamp}.bak`;
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    await db.backup(backupPath);
    db.pragma('foreign_keys = OFF');
    const existingTables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
    );
    const deletedRows = {};
    db.transaction(() => {
      for (const table of ['message_reads', 'disappearing_message_states', 'messages', 'group_members', 'ai_usage_events', 'group_chats']) {
        if (existingTables.has(table)) deletedRows[table] = db.prepare(`DELETE FROM ${table}`).run().changes;
      }
      if (existingTables.has('_config')) {
        db.prepare("INSERT INTO _config (key, value) VALUES ('crypto_epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(String(CRYPTO_EPOCH));
      }
    })();
    db.pragma('wal_checkpoint(TRUNCATE)');
    const userCount = existingTables.has('users')
      ? Number(db.prepare('SELECT COUNT(*) AS count FROM users').get().count)
      : 0;
    console.log(JSON.stringify({ ok: true, backupPath, deletedRows, preservedUsers: userCount }));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error('Increment A migration failed; no chat reset was committed.', error);
  process.exitCode = 1;
});
