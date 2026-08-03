'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packageJson = require('../package.json');
const tauriConfig = require('../src-tauri/tauri.conf.json');

const root = path.join(__dirname, '..');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const cargoToml = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
const installDocs = fs.readFileSync(path.join(root, 'INSTALL_DESKTOP.md'), 'utf8');

test('product version is 1.3.7 across primary and fallback shells', () => {
  assert.equal(packageJson.version, '1.3.7');
  assert.equal(tauriConfig.version, packageJson.version);
  assert.match(cargoToml, new RegExp(`^version = "${packageJson.version.replaceAll('.', '\\.')}"$`, 'm'));
});

test('Windows production packaging path is Electron, not Tauri', () => {
  assert.match(packageJson.scripts['build:win'], /electron-builder/);
  assert.ok(!packageJson.scripts['build:win'].includes('tauri'));
  assert.match(packageJson.scripts['build:mac'], /electron-builder/);
  assert.match(packageJson.scripts['build:mac:tauri'], /tauri build/);
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  assert.ok(deps.electron);
  assert.ok(deps['electron-builder']);
  assert.ok(deps['electron-updater']);
  assert.equal(packageJson.build.extraMetadata.main, 'electron/main.bundle.cjs');
  assert.equal(packageJson.build.directories.output, 'release');
});

test('hosted app receives the complete desktop bridge including update APIs', () => {
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
    'checkForUpdates',
    'getUpdateStatus',
    'installUpdate',
    'openLatestRelease',
    'onUpdateStatus',
  ]) {
    assert.match(preload, new RegExp(`\\b${method}\\b`));
  }
  assert.match(preload, /contextBridge\.exposeInMainWorld\('electronAPI'/);
  assert.match(mainJs, /check-for-updates/);
  assert.match(mainJs, /get-update-status/);
  assert.match(mainJs, /install-update/);
  assert.match(mainJs, /hideToTray|setSkipTaskbar/);
  assert.match(mainJs, /requestSingleInstanceLock/);
});

test('macOS fallback stack remains available and documented', () => {
  assert.ok(fs.existsSync(path.join(root, 'src-tauri', 'src', 'lib.rs')));
  assert.ok(fs.existsSync(path.join(root, 'src-tauri', 'tauri.conf.json')));
  assert.match(installDocs, /fallback/i);
  assert.match(installDocs, /build:mac:tauri|Tauri/i);
  assert.match(installDocs, /1\.3\.7|Electron/i);
});

test('desktop updater publishes via GitHub Releases (electron-updater)', () => {
  assert.equal(packageJson.build.publish.provider, 'github');
  assert.match(mainJs, /github\.com\/Panther114\/GChat\/releases/);
  assert.ok(packageJson.build.files.includes('electron/updater.bundle.cjs'));
});

test('desktop light-sphere pointer glow is removed from shipped web sources', () => {
  const legacyApp = fs.readFileSync(path.join(root, 'src', 'web', 'legacy-app.js'), 'utf8');
  const legacyCss = fs.readFileSync(path.join(root, 'src', 'styles', 'legacy.css'), 'utf8');
  const publicApp = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(legacyApp, /Intentionally empty: mouse-follow light sphere removed/);
  assert.ok(!legacyApp.includes('handleDesktopPointerMove'));
  assert.ok(!legacyApp.includes('flushDesktopPointerEffect'));
  assert.ok(!legacyApp.includes('scheduleDesktopPointerEffect'));
  assert.ok(!legacyApp.includes("setProperty('--desktop-pointer-x'"));
  assert.match(legacyCss, /content:\s*none/);
  assert.ok(!legacyCss.includes('var(--desktop-pointer-x)'));
  assert.ok(!publicApp.includes('handleDesktopPointerMove'));
  assert.ok(!publicApp.includes('flushDesktopPointerEffect'));
});

test('settings update UI is present without native dialogs', () => {
  const chatHtml = fs.readFileSync(path.join(root, 'public', 'chat.html'), 'utf8');
  const legacyApp = fs.readFileSync(path.join(root, 'src', 'web', 'legacy-app.js'), 'utf8');
  assert.match(chatHtml, /id="desktop-update-row"/);
  assert.match(chatHtml, /id="desktop-check-update-btn"/);
  assert.match(chatHtml, /Check for updates/);
  assert.match(legacyApp, /function bindDesktopUpdateUi/);
  assert.match(legacyApp, /function renderDesktopUpdateStatus/);
  assert.ok(!legacyApp.includes('window.alert'));
  assert.ok(!legacyApp.includes('window.confirm'));
  assert.ok(!legacyApp.includes('window.prompt'));
});
