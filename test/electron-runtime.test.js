'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  MAX_UNREAD_COUNT,
  badgeLabelForUnread,
  buildFocusGroupPayload,
  isAbortedLoadError,
  normalizeUnreadCount,
  resolveIconPath,
} = require('../electron/runtime-helpers');
const { createUpdaterController } = require('../electron/updater-controller');
const {
  compareSemver,
  createUpdateStatus,
  reduceUpdateStatus,
  updateStatusLabel,
} = require('../electron/update-status');

test('desktop unread counts are integer and strictly bounded', () => {
  assert.equal(normalizeUnreadCount(undefined), 0);
  assert.equal(normalizeUnreadCount(-4), 0);
  assert.equal(normalizeUnreadCount(2.9), 2);
  assert.equal(normalizeUnreadCount('18'), 18);
  assert.equal(normalizeUnreadCount(Number.POSITIVE_INFINITY), 0);
  assert.equal(normalizeUnreadCount(MAX_UNREAD_COUNT + 5000), MAX_UNREAD_COUNT);
});

test('desktop badge labels have a bounded cache key space', () => {
  assert.equal(badgeLabelForUnread(0), '0');
  assert.equal(badgeLabelForUnread(8), '8');
  assert.equal(badgeLabelForUnread(99), '99');
  assert.equal(badgeLabelForUnread(100), '99+');
  assert.equal(badgeLabelForUnread(500000), '99+');
});

test('semver compare drives update availability decisions', () => {
  assert.equal(compareSemver('1.3.6', '1.3.7'), -1);
  assert.equal(compareSemver('1.3.7', '1.3.7'), 0);
  assert.equal(compareSemver('1.4.0', '1.3.11'), 1);
  assert.equal(compareSemver('v1.3.7', '1.3.7'), 0);
  assert.equal(compareSemver('nope', '1.0.0'), null);
});

test('update status state machine covers settings UI states', () => {
  let status = createUpdateStatus({ currentVersion: '1.3.7' });
  assert.equal(status.state, 'idle');
  assert.match(updateStatusLabel(status), /1\.3\.7/);

  status = reduceUpdateStatus(status, { type: 'check-start', currentVersion: '1.3.7' });
  assert.equal(status.state, 'checking');
  assert.match(updateStatusLabel(status), /Checking/i);

  status = reduceUpdateStatus(status, { type: 'up-to-date', currentVersion: '1.3.7' });
  assert.equal(status.state, 'up-to-date');

  status = reduceUpdateStatus(status, {
    type: 'available',
    currentVersion: '1.3.7',
    availableVersion: '1.3.11',
  });
  assert.equal(status.state, 'available');
  assert.equal(status.availableVersion, '1.3.11');

  status = reduceUpdateStatus(status, { type: 'download-progress', percent: 42.7 });
  assert.equal(status.state, 'downloading');
  assert.equal(status.percent, 42);

  status = reduceUpdateStatus(status, { type: 'ready', availableVersion: '1.3.11' });
  assert.equal(status.state, 'ready');
  assert.equal(status.percent, 100);

  status = reduceUpdateStatus(status, { type: 'error', error: 'network down' });
  assert.equal(status.state, 'error');
  assert.equal(status.error, 'network down');
  assert.match(updateStatusLabel(status), /network down/);
});

test('aborted loads are never treated as connectivity failures', () => {
  assert.equal(isAbortedLoadError(null), false);
  assert.equal(isAbortedLoadError(undefined), false);
  assert.equal(isAbortedLoadError('ERR_ABORTED'), false);
  assert.equal(isAbortedLoadError({ code: -3 }), true);
  assert.equal(isAbortedLoadError({ errorCode: -3 }), true);
  assert.equal(isAbortedLoadError({ code: -2 }), false);
  assert.equal(isAbortedLoadError({ errorCode: -2 }), false);
  assert.equal(isAbortedLoadError(new Error('Page load failed: ERR_ABORTED (-3)')), true);
  assert.equal(isAbortedLoadError(new Error('net::ERR_INTERNET_DISCONNECTED')), false);
});

test('focus-group payload forwards the channel hint and keeps bare groupId otherwise', () => {
  assert.equal(buildFocusGroupPayload(null), null);
  assert.equal(buildFocusGroupPayload('group-1'), null);
  assert.equal(buildFocusGroupPayload({ title: 'Gchat', body: 'hi' }), null);
  assert.equal(buildFocusGroupPayload({ groupId: 'group-1' }), 'group-1');
  assert.equal(buildFocusGroupPayload({ groupId: 'group-1', channelId: null }), 'group-1');
  assert.equal(buildFocusGroupPayload({ groupId: 'group-1', channelId: '' }), 'group-1');
  assert.deepEqual(buildFocusGroupPayload({ groupId: 'group-1', channelId: '#main' }), {
    groupId: 'group-1',
    channelId: '#main',
  });
});

test('icon path resolution falls through missing candidates and caches empty results', () => {
  const existing = ['/app/public/gchat_icon.png'];
  assert.equal(resolveIconPath(existing, () => true), '/app/public/gchat_icon.png');
  assert.equal(
    resolveIconPath(
      ['/missing/gchat_icon.png', '/app/build/icon.ico'],
      (candidate) => candidate.includes('build'),
    ),
    '/app/build/icon.ico',
  );
  assert.equal(resolveIconPath(['/missing/a.png', '/missing/b.ico'], () => false), '');
  assert.equal(resolveIconPath([], () => true), '');
  assert.equal(resolveIconPath(['/skipped-empty', '/ok.png'], (c) => c === '/ok.png'), '/ok.png');
});

class RecordingFakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.checkCount = 0;
    this.installCount = 0;
    this.autoDownload = false;
    this.autoInstallOnAppQuit = false;
    this.installError = null;
    this.holdChecks = false;
    this.releaseChecks = null;
  }

  async checkForUpdatesAndNotify() {
    this.checkCount += 1;
    this.emit('checking-for-update');
    this.emit('update-not-available', { version: '1.3.7' });
    return { updateInfo: { version: '1.3.7' } };
  }

  quitAndInstall() {
    this.installCount += 1;
    if (this.installError) throw this.installError;
  }
}

test('desktop updater starts once, reports status, and disposes listeners', async () => {
  class FakeUpdater extends EventEmitter {
    constructor() {
      super();
      this.checkCount = 0;
      this.installCount = 0;
      this.autoDownload = false;
      this.autoInstallOnAppQuit = false;
    }

    async checkForUpdatesAndNotify() {
      this.checkCount += 1;
      this.emit('checking-for-update');
      this.emit('update-not-available', { version: '1.3.7' });
      return { updateInfo: { version: '1.3.7' } };
    }

    quitAndInstall() {
      this.installCount += 1;
    }
  }

  const updater = new FakeUpdater();
  const statuses = [];
  let readyCount = 0;
  let errorCount = 0;
  const controller = createUpdaterController(updater, {
    checkIntervalMs: 60 * 1000,
    isPackaged: true,
    currentVersion: '1.3.7',
    autoInstallOnDownload: false,
    onError: () => { errorCount += 1; },
    onUpdateReady: () => { readyCount += 1; },
    onStatus: (status) => { statuses.push(status.state); },
  });

  assert.equal(controller.start(), true);
  assert.equal(controller.start(), false);
  assert.equal(updater.checkCount, 1);

  // Let the started (silent) check settle: a manual check issued while that
  // round-trip is still in flight is intentionally skipped by the guard.
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  const manual = await controller.checkForUpdates();
  assert.equal(manual.ok, true);
  assert.equal(updater.checkCount, 2);
  assert.ok(statuses.includes('checking'));
  assert.ok(statuses.includes('up-to-date'));

  updater.emit('update-downloaded', { version: '1.3.11' });
  assert.equal(readyCount, 1);
  assert.equal(updater.installCount, 0);
  assert.equal(controller.getStatus().state, 'ready');
  assert.equal(controller.installUpdate(), true);
  assert.equal(updater.installCount, 1);
  // installUpdate notifies readiness again before quitAndInstall
  assert.equal(readyCount, 2);

  controller.dispose();
  updater.emit('update-downloaded');
  assert.equal(readyCount, 2);
  assert.equal(updater.installCount, 1);
  updater.emit('error', new Error('late shutdown error'));
  assert.equal(errorCount, 0);
  const afterDispose = await controller.checkForUpdates();
  assert.equal(afterDispose.ok, false);
});

test('manual update checks publish check-start exactly once', async () => {
  const updater = new RecordingFakeUpdater();
  const statuses = [];
  const controller = createUpdaterController(updater, {
    isPackaged: true,
    currentVersion: '1.3.7',
    onStatus: (status) => { statuses.push(status.state); },
  });

  const result = await controller.checkForUpdates({ silent: false });
  assert.equal(result.ok, true);
  assert.equal(updater.checkCount, 1);
  // The updater's own 'checking-for-update' event must not double-publish.
  assert.equal(statuses.filter((state) => state === 'checking').length, 1);
  controller.dispose();
});

test('concurrent update checks share one in-flight round-trip', async () => {
  let releaseCheck = null;
  class HeldUpdater extends RecordingFakeUpdater {
    async checkForUpdatesAndNotify() {
      this.checkCount += 1;
      this.emit('checking-for-update');
      if (this.checkCount === 1) {
        await new Promise((resolve) => { releaseCheck = resolve; });
      }
      this.emit('update-not-available', { version: '1.3.7' });
      return { updateInfo: { version: '1.3.7' } };
    }
  }
  const updater = new HeldUpdater();
  const controller = createUpdaterController(updater, {
    isPackaged: true,
    currentVersion: '1.3.7',
  });

  const first = controller.checkForUpdates({ silent: false });
  const second = controller.checkForUpdates({ silent: true });
  const secondResult = await second;
  // The overlapping check reports the current status instead of erroring or
  // starting a redundant network round-trip.
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.skipped, true);
  assert.equal(secondResult.status.state, 'checking');
  assert.equal(updater.checkCount, 1);

  releaseCheck?.();
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.status.state, 'up-to-date');
  assert.equal(updater.checkCount, 1);

  // The guard releases: a fresh check runs for real again.
  const third = await controller.checkForUpdates({ silent: true });
  assert.equal(third.ok, true);
  assert.equal(third.skipped, undefined);
  assert.equal(updater.checkCount, 2);
  controller.dispose();
});

test('an available update exposes downloading promptly and only installs from ready', async () => {
  const updater = new RecordingFakeUpdater();
  const controller = createUpdaterController(updater, {
    isPackaged: true,
    currentVersion: '1.3.7',
    autoInstallOnDownload: false,
  });

  // autoDownload is forced on by the controller, so 'available' must flip to
  // 'downloading' immediately — the renderer shows its Install button at
  // 'available' but the shell only accepts installs at 'ready'.
  assert.equal(updater.autoDownload, true);
  updater.emit('update-available', { version: '1.3.11' });
  let status = controller.getStatus();
  assert.equal(status.state, 'downloading');
  assert.equal(status.availableVersion, '1.3.11');

  // Not installable while the download is in flight.
  assert.equal(controller.installUpdate(), false);
  assert.equal(updater.installCount, 0);

  updater.emit('download-progress', { percent: 55.4 });
  status = controller.getStatus();
  assert.equal(status.state, 'downloading');
  assert.equal(status.percent, 55);

  updater.emit('update-downloaded', { version: '1.3.11' });
  status = controller.getStatus();
  assert.equal(status.state, 'ready');
  assert.equal(status.percent, 100);
  assert.equal(controller.installUpdate(), true);
  assert.equal(updater.installCount, 1);
  controller.dispose();
});

test('installUpdate reports failure when quitAndInstall throws', () => {
  const updater = new RecordingFakeUpdater();
  updater.installError = new Error('spawn EBUSY');
  const controller = createUpdaterController(updater, {
    isPackaged: true,
    currentVersion: '1.3.7',
    autoInstallOnDownload: false,
  });
  updater.emit('update-downloaded', { version: '1.3.11' });
  assert.equal(controller.getStatus().state, 'ready');
  // A failed install must report false (the shell only quits on true).
  assert.equal(controller.installUpdate(), false);
  assert.equal(updater.installCount, 1);
  assert.equal(controller.getStatus().state, 'error');
  controller.dispose();
});
