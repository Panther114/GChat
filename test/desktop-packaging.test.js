'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packageJson = require('../package.json');
const tauriConfig = require('../src-tauri/tauri.conf.json');
const capability = require('../src-tauri/capabilities/remote.json');

const cargoToml = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'Cargo.toml'), 'utf8');
const bridge = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'bridge.js'), 'utf8');

test('desktop package versions stay aligned', () => {
  assert.equal(packageJson.version, '1.3.5');
  assert.equal(tauriConfig.version, packageJson.version);
  assert.match(cargoToml, new RegExp(`^version = "${packageJson.version.replaceAll('.', '\\.')}"$`, 'm'));
});

test('desktop package excludes Electron and bundled browser runtimes', () => {
  const allDependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  assert.equal(allDependencies.electron, undefined);
  assert.equal(allDependencies['electron-builder'], undefined);
  assert.equal(allDependencies['electron-updater'], undefined);
  assert.equal(tauriConfig.bundle.windows.webviewInstallMode.type, 'downloadBootstrapper');
});

test('remote native capability is locked to the exact production origin', () => {
  assert.deepEqual(capability.remote.urls, ['https://gchat.up.railway.app/*']);
  assert.deepEqual(capability.windows, ['main']);
  assert.deepEqual(capability.permissions, []);
  assert.equal(tauriConfig.app.withGlobalTauri, false);
  assert.ok(!JSON.stringify(capability).includes('shell:'));
  assert.ok(!JSON.stringify(capability).includes('fs:'));
});

test('hosted app receives the complete backwards-compatible desktop bridge', () => {
  for (const method of [
    'setUnreadCount',
    'showNotification',
    'onFocusGroup',
    'getLaunchAtStartup',
    'setLaunchAtStartup',
    'retryConnection',
    'getConnectionContext',
    'copyBinaryToClipboard',
    'clearCacheAndRestart',
    'reloadHostedApp',
  ]) {
    assert.match(bridge, new RegExp(`\\b${method}\\b`));
  }
  assert.match(bridge, /Object\.freeze/);
  assert.match(bridge, /Object\.defineProperty\(window, 'electronAPI'/);
});

test('future desktop updates use signed latest-release metadata', () => {
  const updater = tauriConfig.plugins.updater;
  assert.deepEqual(updater.endpoints, [
    'https://github.com/Panther114/GChat/releases/latest/download/latest.json',
  ]);
  assert.match(updater.pubkey, /^[A-Za-z0-9+/]+=*$/);
  assert.ok(updater.pubkey.length > 100);
  assert.equal(tauriConfig.bundle.createUpdaterArtifacts, true);
  assert.match(packageJson.scripts['build:mac'], /--bundles app,dmg/);
});
