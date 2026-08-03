'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packageJson = require('../package.json');
const tauriConfig = require('../src-tauri/tauri.conf.json');
const capability = require('../src-tauri/capabilities/remote.json');

const root = path.join(__dirname, '..');
const cargoToml = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'bridge.js'), 'utf8');
const libRs = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
const installDocs = fs.readFileSync(path.join(root, 'INSTALL_DESKTOP.md'), 'utf8');
const permissions = fs.readFileSync(
  path.join(root, 'src-tauri', 'permissions', 'desktop-bridge.toml'),
  'utf8',
);

test('product version is 1.3.7 across shell metadata', () => {
  assert.equal(packageJson.version, '1.3.7');
  assert.equal(tauriConfig.version, packageJson.version);
  assert.match(cargoToml, new RegExp(`^version = "${packageJson.version.replaceAll('.', '\\.')}"$`, 'm'));
});

test('Windows production packaging path is memory-optimized Tauri/WebView2, not Electron', () => {
  assert.match(packageJson.scripts['build:win'], /tauri build/);
  assert.ok(!packageJson.scripts['build:win'].includes('electron-builder'));
  assert.match(packageJson.scripts['build:mac'], /tauri build/);
  // Electron remains optional only via explicit non-production scripts.
  assert.match(packageJson.scripts['build:win:electron'] || '', /electron-builder/);
  const prodDeps = packageJson.dependencies || {};
  assert.equal(prodDeps.electron, undefined);
  assert.equal(prodDeps['electron-builder'], undefined);
  assert.equal(prodDeps['electron-updater'], undefined);
  assert.equal(tauriConfig.bundle.windows.webviewInstallMode.type, 'downloadBootstrapper');
  assert.match(libRs, /WEBVIEW_MEMORY_BROWSER_ARGS/);
  assert.match(libRs, /max-old-space-size=256/);
  assert.match(libRs, /disable-background-networking/);
  assert.match(libRs, /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/);
  // Flags string must not enable low-end-device-mode (comment may mention it).
  const argsMatch = libRs.match(/pub const WEBVIEW_MEMORY_BROWSER_ARGS: &str = concat!\(([\s\S]*?)\);/);
  assert.ok(argsMatch, 'WEBVIEW_MEMORY_BROWSER_ARGS concat block present');
  assert.ok(!argsMatch[1].includes('enable-low-end-device-mode'));
});

test('remote native capability is locked to the exact production origin', () => {
  assert.deepEqual(capability.remote.urls, ['https://gchat.up.railway.app/*']);
  assert.deepEqual(capability.windows, ['main']);
  assert.deepEqual(capability.permissions, ['allow-desktop-bridge']);
  assert.equal(tauriConfig.bundle.windows.nsis.installerIcon, 'icons/icon.ico');
  assert.equal(tauriConfig.app.withGlobalTauri, false);
  assert.ok(!JSON.stringify(capability).includes('shell:'));
  assert.ok(!JSON.stringify(capability).includes('fs:'));
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
    assert.match(bridge, new RegExp(`\\b${method}\\b`));
  }
  assert.match(bridge, /Object\.freeze/);
  assert.match(bridge, /Object\.defineProperty\(window, 'electronAPI'/);
  for (const command of [
    'get_update_status',
    'check_for_updates_cmd',
    'install_update',
    'open_latest_release',
  ]) {
    assert.match(permissions, new RegExp(`"${command}"`));
    assert.match(libRs, new RegExp(command));
  }
  assert.match(bridge, /check_for_updates_cmd|checkForUpdates/);
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

test('macOS uses the same Tauri shell (no dual production stack required)', () => {
  assert.ok(fs.existsSync(path.join(root, 'src-tauri', 'src', 'lib.rs')));
  assert.match(packageJson.scripts['build:mac'], /tauri build/);
  assert.match(installDocs, /Tauri|WebView2|WKWebView/i);
  assert.match(installDocs, /1\.3\.7/);
});

test('desktop light-sphere pointer glow is removed from shipped web sources', () => {
  const legacyApp = fs.readFileSync(path.join(root, 'src', 'web', 'legacy-app.js'), 'utf8');
  const legacyCss = fs.readFileSync(path.join(root, 'src', 'styles', 'legacy.css'), 'utf8');
  const publicApp = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(legacyApp, /Intentionally empty: mouse-follow light sphere removed/);
  assert.ok(!legacyApp.includes('handleDesktopPointerMove'));
  assert.ok(!legacyApp.includes('flushDesktopPointerEffect'));
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
