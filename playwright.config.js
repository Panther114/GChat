'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4400',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:web',
    url: 'http://127.0.0.1:4400/api/health',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
