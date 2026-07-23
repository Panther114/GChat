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

test('desktop updater starts once, remains callable, and disposes listeners', async () => {
  class FakeUpdater extends EventEmitter {
    constructor() {
      super();
      this.checkCount = 0;
      this.installCount = 0;
    }

    async checkForUpdatesAndNotify() {
      this.checkCount += 1;
    }

    quitAndInstall() {
      this.installCount += 1;
    }
  }

  const updater = new FakeUpdater();
  let readyCount = 0;
  let errorCount = 0;
  const controller = createUpdaterController(updater, {
    checkIntervalMs: 60 * 1000,
    isPackaged: true,
    onError: () => { errorCount += 1; },
    onUpdateReady: () => { readyCount += 1; },
  });

  assert.equal(controller.start(), true);
  assert.equal(controller.start(), false);
  assert.equal(updater.checkCount, 1);
  assert.equal(await controller.checkForUpdates(), true);
  assert.equal(updater.checkCount, 2);

  updater.emit('update-downloaded');
  assert.equal(readyCount, 1);
  assert.equal(updater.installCount, 1);

  controller.dispose();
  updater.emit('update-downloaded');
  assert.equal(readyCount, 1);
  assert.equal(updater.installCount, 1);
  updater.emit('error', new Error('late shutdown error'));
  assert.equal(errorCount, 0);
  assert.equal(await controller.checkForUpdates(), false);
});
