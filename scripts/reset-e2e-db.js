'use strict';

// v1.3.12: wipe the dev e2e SQLite DB before the e2e server boots, so read
// cursors, sent messages, and groups never leak across runs. Runs as part of
// the Playwright webServer command (guaranteed to execute after any previous
// server has exited and before the new server opens the database).
const fs = require('node:fs');
const path = require('node:path');

const dbDir = path.join(__dirname, '..', '.gchat-local', 'e2e');
if (!fs.existsSync(dbDir)) return;
for (const name of fs.readdirSync(dbDir)) {
  if (name.startsWith('Gchat.db') || name.startsWith('sessions.db')) {
    try {
      fs.rmSync(path.join(dbDir, name), { force: true });
    } catch (error) {
      // The previous server may still be releasing the file — retry shortly.
      if (error.code === 'EBUSY' || error.code === 'EPERM') {
        setTimeout(() => {
          try {
            fs.rmSync(path.join(dbDir, name), { force: true });
          } catch {
            /* best effort */
          }
        }, 1500).unref();
      }
    }
  }
}
