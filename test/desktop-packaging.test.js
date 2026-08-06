'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packageJson = require('../package.json');
const tauriConfig = require('../src-tauri/tauri.conf.json');

const root = path.join(__dirname, '..');
const cargoWin = fs.readFileSync(path.join(root, 'src-desktop-win', 'Cargo.toml'), 'utf8');
const mainWin = fs.readFileSync(path.join(root, 'src-desktop-win', 'src', 'main.rs'), 'utf8');
const bridgeWin = fs.readFileSync(path.join(root, 'src-desktop-win', 'src', 'bridge.js'), 'utf8');
const cargoMac = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
const installDocs = fs.readFileSync(path.join(root, 'INSTALL_DESKTOP.md'), 'utf8');
const buildWin = fs.readFileSync(path.join(root, 'scripts', 'build-win-thin.js'), 'utf8');

test('product version is 1.3.11 across thin Windows shell and macOS fallback', () => {
  assert.equal(packageJson.version, '1.3.11');
  assert.equal(tauriConfig.version, packageJson.version);
  assert.match(cargoWin, /version = "1.3.11"/);
  assert.match(cargoMac, /^version = "1.3.11"$/m);
});

test('Windows production path is non-Tauri thin WebView2 shell', () => {
  assert.match(packageJson.scripts['build:win'], /build-win-thin/);
  assert.ok(!packageJson.scripts['build:win'].includes('tauri build'));
  assert.ok(!packageJson.scripts['build:win'].includes('electron-builder'));
  assert.match(packageJson.scripts['build:mac'], /tauri build/);
  assert.match(packageJson.scripts['build:win:tauri'] || '', /tauri/);
  assert.match(buildWin, /src-desktop-win/);
  assert.match(mainWin, /WEBVIEW_MEMORY_BROWSER_ARGS/);
  assert.match(mainWin, /fn suspend_to_tray/);
  assert.match(mainWin, /max-old-space-size=384/);
  assert.ok(fs.existsSync(path.join(root, 'src-desktop-win', 'src', 'main.rs')));
  const prodDeps = packageJson.dependencies || {};
  assert.equal(prodDeps.electron, undefined);
  assert.equal(prodDeps['electron-updater'], undefined);
});

test('thin Windows bridge exposes full electronAPI surface including updates', () => {
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
    assert.match(bridgeWin, new RegExp(`\\b${method}\\b`));
  }
  assert.match(bridgeWin, /Object\.defineProperty\(window, 'electronAPI'/);
  assert.match(bridgeWin, /Object\.freeze/);
});

test('macOS fallback Tauri stack remains documented and buildable', () => {
  assert.ok(fs.existsSync(path.join(root, 'src-tauri', 'src', 'lib.rs')));
  assert.match(installDocs, /fallback|macOS|WKWebView|Tauri/i);
  assert.match(installDocs, /thin|WebView2|1.3.11/i);
  assert.match(packageJson.scripts['build:mac'], /tauri build/);
});

test('desktop light-sphere pointer glow is removed from shipped web sources', () => {
  const legacyApp = fs.readFileSync(path.join(root, 'src', 'web', 'legacy-app.js'), 'utf8');
  const legacyCss = fs.readFileSync(path.join(root, 'src', 'styles', 'legacy.css'), 'utf8');
  const publicApp = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(legacyApp, /Intentionally empty: mouse-follow light sphere removed/);
  assert.ok(!legacyApp.includes('handleDesktopPointerMove'));
  assert.ok(!legacyApp.includes('flushDesktopPointerEffect'));
  assert.match(legacyCss, /content:\s*none/);
  assert.ok(!publicApp.includes('handleDesktopPointerMove'));
});

test('settings update UI is present without native dialogs', () => {
  const chatHtml = fs.readFileSync(path.join(root, 'public', 'chat.html'), 'utf8');
  const legacyApp = fs.readFileSync(path.join(root, 'src', 'web', 'legacy-app.js'), 'utf8');
  assert.match(chatHtml, /id="desktop-update-row"/);
  assert.match(chatHtml, /id="desktop-check-update-btn"/);
  assert.match(chatHtml, /Check for updates/);
  assert.match(legacyApp, /function bindDesktopUpdateUi/);
  assert.ok(!legacyApp.includes('window.alert'));
  assert.ok(!legacyApp.includes('window.confirm'));
  assert.ok(!legacyApp.includes('window.prompt'));
});

test('thin shell keeps SPA alive while tray-hidden for instant restore', () => {
  assert.match(mainWin, /fn suspend_to_tray/);
  assert.match(mainWin, /fn resume_hosted/);
  assert.match(mainWin, /should_reload_on_resume/);
  // v1.3.8: hiding to tray must NOT unload the hosted SPA — no suspend
  // placeholder page, so restoring from the tray is instant.
  assert.ok(!mainWin.includes('SUSPEND_HTML'));
  assert.ok(!mainWin.includes('Gchat is running in the tray'));
});

test('thin shell matches tray parity: minimize-to-tray, offline recovery, safe updates', () => {
  // Minimize and close both hide to tray
  assert.match(mainWin, /WindowEvent::CloseRequested/);
  assert.match(mainWin, /is_minimized/);
  assert.match(mainWin, /suspend_to_tray/);
  // Offline recovery page + connection timeout
  assert.match(mainWin, /OFFLINE_HTML/);
  assert.match(mainWin, /ShowOffline|show_offline_page/);
  assert.match(mainWin, /schedule_connection_timeout/);
  assert.match(mainWin, /LOAD_TIMEOUT/);
  // Notifications must not force-focus / resume SPA
  assert.match(mainWin, /Toast only/);
  assert.ok(!/show-notification[\s\S]{0,400}ShowWindow/.test(mainWin));
  // Tray check-for-updates must not auto-install
  assert.match(mainWin, /check_updates_sync\(false\)/);
  assert.match(mainWin, /never auto-downloads|Manual tray check only/i);
  // install-update must report failure when status is error
  assert.match(mainWin, /Update install failed|status\.state == "ready"/);
});
