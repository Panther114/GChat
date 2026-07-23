'use strict';

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

function createUpdaterController(updater, {
  checkIntervalMs = UPDATE_CHECK_INTERVAL_MS,
  isPackaged,
  onError = () => {},
  onUpdateReady = () => {},
} = {}) {
  let interval = null;
  let started = false;
  let disposed = false;

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  const handleDownloaded = () => {
    onUpdateReady();
    updater.quitAndInstall(true, true);
  };
  const handleError = (error) => {
    if (!disposed) onError(error);
  };

  updater.on('update-downloaded', handleDownloaded);
  updater.on('error', handleError);

  async function checkForUpdates() {
    if (!isPackaged || disposed) return false;
    try {
      await updater.checkForUpdatesAndNotify();
      return true;
    } catch {
      return false;
    }
  }

  function start() {
    if (!isPackaged || started || disposed) return false;
    started = true;
    void checkForUpdates();
    interval = setInterval(() => {
      void checkForUpdates();
    }, checkIntervalMs);
    interval.unref?.();
    return true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (interval) clearInterval(interval);
    interval = null;
    updater.removeListener('update-downloaded', handleDownloaded);
    // Keep an inert error listener through process shutdown. EventEmitter
    // treats an unhandled late updater error as fatal.
  }

  return {
    checkForUpdates,
    dispose,
    start,
  };
}

module.exports = {
  UPDATE_CHECK_INTERVAL_MS,
  createUpdaterController,
};
