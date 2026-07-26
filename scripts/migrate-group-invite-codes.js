'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { readConfig } = require('../src/server/config');
const { migrateGroupCodes } = require('../src/server/group-code-migration');

if (process.env.NODE_ENV === 'production' && process.env.GCHAT_GROUP_CODE_MIGRATION_APPROVED !== '1') {
  throw new Error('Set GCHAT_GROUP_CODE_MIGRATION_APPROVED=1 after taking a verified database backup.');
}

const dbPath = path.resolve(process.env.DB_PATH || './Gchat.db');
const db = new Database(dbPath);
try {
  const config = readConfig();
  const result = migrateGroupCodes(db, config);
  console.log(`Migrated ${result.migrated} group invite code(s).`);
} finally {
  db.close();
}
