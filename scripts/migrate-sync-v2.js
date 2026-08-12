'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { applySyncV2Migration, verifySyncV2Migration } = require('../src/server/sync-v2-migration');

async function main() {
  const mode = process.argv.find((arg) => ['--dry-run', '--verify', '--apply'].includes(arg));
  if (!mode) throw new Error('Choose exactly one of --dry-run, --verify, or --apply');
  const sourcePath = path.resolve(process.env.DB_PATH || './Gchat.db');
  if (!fs.existsSync(sourcePath)) throw new Error(`Database does not exist: ${sourcePath}`);

  if (mode === '--verify') {
    const db = new Database(sourcePath, { readonly: true });
    try {
      const report = verifySyncV2Migration(db);
      process.stdout.write(`${JSON.stringify({ mode, database: sourcePath, ...report }, null, 2)}\n`);
      if (!report.ok) process.exitCode = 1;
    } finally {
      db.close();
    }
    return;
  }

  if (mode === '--dry-run') {
    const rehearsalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-sync-v2-'));
    const rehearsalPath = path.join(rehearsalDir, 'rehearsal.db');
    const source = new Database(sourcePath, { readonly: true });
    try { await source.backup(rehearsalPath); } finally { source.close(); }
    const rehearsal = new Database(rehearsalPath);
    try {
      const report = applySyncV2Migration(rehearsal);
      process.stdout.write(`${JSON.stringify({ mode, source: sourcePath, rehearsal: rehearsalPath, ...report }, null, 2)}\n`);
    } finally {
      rehearsal.close();
    }
    return;
  }

  const db = new Database(sourcePath);
  try {
    db.pragma('journal_mode = WAL');
    const report = applySyncV2Migration(db);
    db.pragma('wal_checkpoint(TRUNCATE)');
    process.stdout.write(`${JSON.stringify({ mode, database: sourcePath, ...report }, null, 2)}\n`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`sync-v2 migration failed: ${error.message}\n`);
  process.exitCode = 1;
});
