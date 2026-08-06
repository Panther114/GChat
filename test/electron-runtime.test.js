'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  MAX_UNREAD_COUNT,
  badgeLabelForUnread,
  normalizeUnreadCount,
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
  assert.equal(compareSemver('1.4.0', '1.3.9'), 1);
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
    availableVersion: '1.3.9',
  });
  assert.equal(status.state, 'available');
  assert.equal(status.availableVersion, '1.3.9');

  status = reduceUpdateStatus(status, { type: 'download-progress', percent: 42.7 });
  assert.equal(status.state, 'downloading');
  assert.equal(status.percent, 42);

  status = reduceUpdateStatus(status, { type: 'ready', availableVersion: '1.3.9' });
  assert.equal(status.state, 'ready');
  assert.equal(status.percent, 100);

  status = reduceUpdateStatus(status, { type: 'error', error: 'network down' });
  assert.equal(status.state, 'error');
  assert.equal(status.error, 'network down');
  assert.match(updateStatusLabel(status), /network down/);
});

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

  const manual = await controller.checkForUpdates();
  assert.equal(manual.ok, true);
  assert.equal(updater.checkCount, 2);
  assert.ok(statuses.includes('checking'));
  assert.ok(statuses.includes('up-to-date'));

  updater.emit('update-downloaded', { version: '1.3.9' });
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
