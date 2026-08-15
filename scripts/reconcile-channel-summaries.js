'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  applyChannelSummaryReconciliation,
  verifyChannelSummaries,
} = require('../src/server/channel-summary-reconciliation');

async function main() {
  const modes = process.argv.filter((arg) => ['--dry-run', '--verify', '--apply'].includes(arg));
  if (modes.length !== 1) throw new Error('Choose exactly one of --dry-run, --verify, or --apply');
  const mode = modes[0];
  const sourcePath = path.resolve(process.env.DB_PATH || './Gchat.db');
  if (!fs.existsSync(sourcePath)) throw new Error(`Database does not exist: ${sourcePath}`);

  if (mode === '--verify') {
    const db = new Database(sourcePath, { readonly: true });
    try {
      const report = verifyChannelSummaries(db);
      process.stdout.write(`${JSON.stringify({ mode, database: sourcePath, ...report }, null, 2)}\n`);
      if (!report.ok) process.exitCode = 1;
    } finally { db.close(); }
    return;
  }

  if (mode === '--dry-run') {
    const rehearsalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gchat-channel-summary-'));
    const rehearsalPath = path.join(rehearsalDir, 'rehearsal.db');
    const source = new Database(sourcePath, { readonly: true });
    try { await source.backup(rehearsalPath); } finally { source.close(); }
    const rehearsal = new Database(rehearsalPath);
    try {
      const report = applyChannelSummaryReconciliation(rehearsal);
      process.stdout.write(`${JSON.stringify({ mode, source: sourcePath, rehearsal: rehearsalPath, ...report }, null, 2)}\n`);
    } finally { rehearsal.close(); }
    return;
  }

  const backupArg = process.argv.find((arg) => arg.startsWith('--backup='));
  if (!backupArg) throw new Error('--apply requires --backup=/path/to/backup.db');
  const backupPath = path.resolve(backupArg.slice('--backup='.length));
  if (backupPath === sourcePath) throw new Error('Backup path must differ from the source database');
  if (fs.existsSync(backupPath)) throw new Error(`Refusing to overwrite existing backup: ${backupPath}`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  const db = new Database(sourcePath);
  try {
    await db.backup(backupPath);
    const report = applyChannelSummaryReconciliation(db);
    process.stdout.write(`${JSON.stringify({ mode, database: sourcePath, backup: backupPath, ...report }, null, 2)}\n`);
  } finally { db.close(); }
}

main().catch((error) => {
  process.stderr.write(`channel-summary reconciliation failed: ${error.message}\n`);
  process.exitCode = 1;
});
