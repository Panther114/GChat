'use strict';

const {
  createUpdateStatus,
  reduceUpdateStatus,
} = require('./update-status');

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

function createUpdaterController(updater, {
  checkIntervalMs = UPDATE_CHECK_INTERVAL_MS,
  isPackaged,
  currentVersion = null,
  onError = () => {},
  onUpdateReady = () => {},
  onStatus = () => {},
  autoInstallOnDownload = true,
} = {}) {
  let interval = null;
  let started = false;
  let disposed = false;
  let checkInFlight = false;
  let status = createUpdateStatus({ currentVersion });

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  function publish(event) {
    status = reduceUpdateStatus(status, {
      ...event,
      currentVersion: event.currentVersion ?? currentVersion ?? status.currentVersion,
    });
    try {
      onStatus({ ...status });
    } catch {
      // Status listeners must not break the updater.
    }
    return status;
  }

  // The shell only starts checks itself (manual publish at 'check-start' or a
  // silent interval check); the updater's own 'checking-for-update' event
  // would double-publish the same state, so it is intentionally not broadcast.

  const handleAvailable = (info) => {
    publish({
      type: 'available',
      availableVersion: info?.version || null,
      checkedAt: new Date().toISOString(),
    });
    // autoDownload is forced on: the installer download starts immediately
    // after 'update-available'. Expose 'downloading' right away so the
    // renderer's Install button (shown at 'available', accepted only at
    // 'ready') never sits on a dead 'available' state.
    if (updater.autoDownload !== false) {
      publish({
        type: 'download-progress',
        percent: 0,
        availableVersion: status.availableVersion,
      });
    }
  };

  const handleNotAvailable = () => {
    publish({
      type: 'up-to-date',
      checkedAt: new Date().toISOString(),
    });
  };

  const handleProgress = (progress) => {
    const percent = Number(progress?.percent);
    publish({
      type: 'download-progress',
      percent: Number.isFinite(percent) ? percent : undefined,
      availableVersion: status.availableVersion,
    });
  };

  const handleDownloaded = (info) => {
    publish({
      type: 'ready',
      availableVersion: info?.version || status.availableVersion,
      checkedAt: new Date().toISOString(),
    });
    onUpdateReady({ ...status });
    if (autoInstallOnDownload) {
      try {
        updater.quitAndInstall(true, true);
      } catch (error) {
        publish({
          type: 'error',
          error: error?.message || 'Failed to install update.',
        });
      }
    }
  };

  const handleError = (error) => {
    if (disposed) return;
    publish({
      type: 'error',
      error: error?.message || String(error || 'Update error'),
    });
    onError(error);
  };

  updater.on('update-available', handleAvailable);
  updater.on('update-not-available', handleNotAvailable);
  updater.on('download-progress', handleProgress);
  updater.on('update-downloaded', handleDownloaded);
  updater.on('error', handleError);

  async function checkForUpdates({ silent = false } = {}) {
    if (!isPackaged || disposed) {
      if (!silent) {
        publish({
          type: 'error',
          error: isPackaged
            ? 'Updater is unavailable.'
            : 'Update checks are only available in packaged desktop builds.',
        });
      }
      return { ok: false, status: { ...status } };
    }
    // A manual check colliding with an interval check must not error — report
    // the current status and skip the redundant network round-trip.
    if (checkInFlight) return { ok: true, skipped: true, status: { ...status } };
    if (!silent) publish({ type: 'check-start' });
    checkInFlight = true;
    try {
      const result = await updater.checkForUpdatesAndNotify();
      return { ok: true, status: { ...status }, result: result || null };
    } catch (error) {
      handleError(error);
      return { ok: false, status: { ...status } };
    } finally {
      checkInFlight = false;
    }
  }

  function start() {
    if (!isPackaged || started || disposed) return false;
    started = true;
    void checkForUpdates({ silent: true });
    interval = setInterval(() => {
      void checkForUpdates({ silent: true });
    }, checkIntervalMs);
    interval.unref?.();
    return true;
  }

  function installUpdate() {
    if (disposed || status.state !== 'ready') return false;
    onUpdateReady({ ...status });
    try {
      updater.quitAndInstall(true, true);
      return true;
    } catch (error) {
      handleError(error);
      return false;
    }
  }

  function getStatus() {
    return { ...status };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (interval) clearInterval(interval);
    interval = null;
    updater.removeListener('update-available', handleAvailable);
    updater.removeListener('update-not-available', handleNotAvailable);
    updater.removeListener('download-progress', handleProgress);
    updater.removeListener('update-downloaded', handleDownloaded);
    // Keep an inert error listener through process shutdown. EventEmitter
    // treats an unhandled late updater error as fatal.
  }

  return {
    checkForUpdates,
    dispose,
    getStatus,
    installUpdate,
    start,
  };
}

module.exports = {
  UPDATE_CHECK_INTERVAL_MS,
  createUpdaterController,
};
