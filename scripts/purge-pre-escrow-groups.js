'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { purgePreEscrowGroups } = require('../src/server/legacy-group-purge');

const CONFIRMATION = 'DELETE_PRE_ESCROW_GROUPS';

function main() {
  if (process.env.BACKUP_CONFIRMED !== '1') {
    throw new Error('Refusing to purge: verify a database backup, then set BACKUP_CONFIRMED=1');
  }
  if (process.env.CONFIRM_LEGACY_GROUP_PURGE !== CONFIRMATION) {
    throw new Error(`Refusing to purge: set CONFIRM_LEGACY_GROUP_PURGE=${CONFIRMATION}`);
  }
  const dbPath = path.resolve(process.env.DB_PATH || './Gchat.db');
  if (!fs.existsSync(dbPath)) throw new Error(`Database file does not exist: ${dbPath}`);

  const db = new Database(dbPath);
  try {
    const columns = db.prepare('PRAGMA table_info(group_chats)').all().map((column) => column.name);
    for (const column of ['key_escrow_ciphertext', 'key_escrow_iv', 'key_escrow_version']) {
      if (!columns.includes(column)) throw new Error('Escrow schema is missing. Deploy and start the escrow-enabled application before running this script.');
    }
    const result = purgePreEscrowGroups(db);
    console.log(`Purged ${result.groups} pre-escrow groups, ${result.messages} messages, ${result.memberships} memberships, and ${result.aiUsageEvents} AI usage records.`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
