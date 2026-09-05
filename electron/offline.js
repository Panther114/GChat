'use strict';

const retryBtn = document.getElementById('retry-btn');
const offlineStatusMeta = document.getElementById('offline-status-meta');
const offlineMessage = document.getElementById('offline-message');
const offlineServerUrl = document.getElementById('offline-server-url');
const offlineErrorDetail = document.getElementById('offline-error-detail');

// Fail loudly on DOM drift, but never kill the whole script over one
// missing element — the page degrades to a static notice instead.
const MISSING_ELEMENT_IDS = [
  ['retry-btn', retryBtn],
  ['offline-status-meta', offlineStatusMeta],
  ['offline-message', offlineMessage],
  ['offline-server-url', offlineServerUrl],
  ['offline-error-detail', offlineErrorDetail],
]
  .filter(([, element]) => !element)
  .map(([id]) => id);
if (MISSING_ELEMENT_IDS.length) {
  console.error(`[offline] DOM drift: missing element(s) #${MISSING_ELEMENT_IDS.join(', #')}`);
}

function setText(element, text) {
  if (element) element.textContent = text;
}

async function loadConnectionContext() {
  if (MISSING_ELEMENT_IDS.length) return;
  try {
    const context = await window.electronAPI.getConnectionContext();
    setText(offlineServerUrl, context.serverUrl || 'https://gchat.up.railway.app');

    if (context.lastLoadError) {
      const { errorDescription, errorCode, failedAt, url } = context.lastLoadError;
      setText(offlineStatusMeta, failedAt
        ? `Last failed attempt: ${new Date(failedAt).toLocaleString()}`
        : 'Latest startup attempt failed.');
      setText(offlineMessage, url
        ? `Unable to load ${url}. Retry after the connection improves.`
        : 'The hosted app could not be reached.');
      setText(offlineErrorDetail, [errorDescription, errorCode].filter(Boolean).join(' · '));
      return;
    }

    setText(offlineStatusMeta, 'No detailed failure information was stored.');
    setText(offlineMessage, 'Retry when the hosted app is reachable again.');
    setText(offlineErrorDetail, 'Unavailable');
  } catch (error) {
    setText(offlineStatusMeta, 'Unable to read the latest connection state.');
    setText(offlineMessage, 'Retry when the hosted app is reachable again.');
    setText(offlineErrorDetail, error?.message || 'Unavailable');
  }
}

if (retryBtn) {
  retryBtn.addEventListener('click', async () => {
    retryBtn.disabled = true;
    retryBtn.textContent = 'Retrying…';
    try {
      // v1.3.9: retryConnection now reports success/failure — the button must
      // re-enable when the retry didn't actually recover.
      const ok = await window.electronAPI.retryConnection();
      if (!ok) throw new Error('retry did not recover');
    } catch {
      retryBtn.disabled = false;
      retryBtn.textContent = 'Retry connection';
      await loadConnectionContext();
    }
  });
}

window.addEventListener('DOMContentLoaded', loadConnectionContext);
