'use strict';

const retryBtn = document.getElementById('retry-btn');
const offlineStatusMeta = document.getElementById('offline-status-meta');
const offlineMessage = document.getElementById('offline-message');
const offlineServerUrl = document.getElementById('offline-server-url');
const offlineErrorDetail = document.getElementById('offline-error-detail');

async function loadConnectionContext() {
  try {
    const context = await window.electronAPI.getConnectionContext();
    offlineServerUrl.textContent = context.serverUrl || 'https://gchat.up.railway.app';

    if (context.lastLoadError) {
      const { errorDescription, errorCode, failedAt, url } = context.lastLoadError;
      offlineStatusMeta.textContent = failedAt
        ? `Last failed attempt: ${new Date(failedAt).toLocaleString()}`
        : 'Latest startup attempt failed.';
      offlineMessage.textContent = url
        ? `Unable to load ${url}. Retry after the connection improves.`
        : 'The hosted app could not be reached.';
      offlineErrorDetail.textContent = [errorDescription, errorCode].filter(Boolean).join(' · ');
      return;
    }

    offlineStatusMeta.textContent = 'No detailed failure information was stored.';
    offlineMessage.textContent = 'Retry when the hosted app is reachable again.';
    offlineErrorDetail.textContent = 'Unavailable';
  } catch (error) {
    offlineStatusMeta.textContent = 'Unable to read the latest connection state.';
    offlineMessage.textContent = 'Retry when the hosted app is reachable again.';
    offlineErrorDetail.textContent = error?.message || 'Unavailable';
  }
}

retryBtn.addEventListener('click', async () => {
  retryBtn.disabled = true;
  retryBtn.textContent = 'Retrying…';
  try {
    await window.electronAPI.retryConnection();
  } catch {
    retryBtn.disabled = false;
    retryBtn.textContent = 'Retry connection';
    await loadConnectionContext();
  }
});

window.addEventListener('DOMContentLoaded', loadConnectionContext);
