'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  // Most flows share the disposable SQLite fixture. Keep those mutations
  // serialized; stateless layout/auth checks can opt into parallel mode later.
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4401',
    // Functional flows block SW state; the dedicated update-policy test opts in.
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    // v1.3.12: wipe the dev e2e DB first so read cursors / messages never
    // leak across runs (deterministic unread-badge assertions).
    command: 'node scripts/reset-e2e-db.js && npm run dev:web:e2e',
    env: {
      ...process.env,
      GROUP_KEY_ESCROW_MASTER_KEY: process.env.GROUP_KEY_ESCROW_MASTER_KEY || Buffer.alloc(32, 8).toString('base64url'),
    },
    url: 'http://127.0.0.1:4401/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
