'use strict';

const { autoUpdater } = require('electron-updater');
const {
  UPDATE_CHECK_INTERVAL_MS,
  createUpdaterController: createController,
} = require('./updater-controller');

module.exports = {
  UPDATE_CHECK_INTERVAL_MS,
  createUpdaterController(options) {
    return createController(autoUpdater, options);
  },
};
