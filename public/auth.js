// ── CSRF token (fetched once, reused for all state-changing requests) ─────
let csrfToken = null;
const LEGACY_LOCAL_SETTINGS_KEY = 'gchat:local-settings';
const ACTIVE_LOCAL_SETTINGS_KEY = 'gchat:active-local-settings';

function readStoredSettings(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function toWallpaperCssValue(dataUrl) {
  if (!dataUrl) return "url('gchat_wallpaper.jpg')";
  return `url("${String(dataUrl).replace(/"/g, '\\"')}")`;
}

function applyAuthWallpaperFromStorage() {
  const settings = readStoredSettings(ACTIVE_LOCAL_SETTINGS_KEY) || readStoredSettings(LEGACY_LOCAL_SETTINGS_KEY) || {};
  document.documentElement.style.setProperty('--auth-wallpaper', toWallpaperCssValue(settings.wallpaperDataUrl || null));
}

applyAuthWallpaperFromStorage();

async function fetchCsrfToken() {
  try {
    const res = await fetch('/api/auth/csrf');
    const data = await res.json();
    csrfToken = data.csrfToken;
  } catch {
    // Will retry on next request if needed
  }
}
fetchCsrfToken();
window.addEventListener('storage', (event) => {
  if (event.key !== ACTIVE_LOCAL_SETTINGS_KEY && event.key !== LEGACY_LOCAL_SETTINGS_KEY) return;
  applyAuthWallpaperFromStorage();
});

async function redirectIfAuthenticated() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      window.location.replace('chat.html');
    }
  } catch {
    // Stay on the login page when the session check fails.
  }
}
redirectIfAuthenticated();

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (csrfToken) h['X-CSRF-Token'] = csrfToken;
  return h;
}

// ── Tab switching ────────────────────────────────────────────────────────
document.querySelectorAll('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    document.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach((f) => f.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`${target}-form`).classList.add('active');
  });
});

// ── Color preview ────────────────────────────────────────────────────────
const colorInput = document.getElementById('signup-color');
const colorPreview = document.getElementById('color-preview');
colorInput.addEventListener('input', () => {
  colorPreview.style.color = colorInput.value;
});
colorPreview.style.color = colorInput.value;

// ── Sign In ──────────────────────────────────────────────────────────────
document.getElementById('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('signin-btn');
  const errorEl = document.getElementById('signin-error');
  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  const username = document.getElementById('signin-username').value.trim();
  const password = document.getElementById('signin-password').value;
  const rememberMe = document.getElementById('signin-remember').checked;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ username, password, rememberMe }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Sign in failed';
    } else {
      window.location.href = 'chat.html';
    }
  } catch {
    errorEl.textContent = 'Network error. Please try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

// ── Sign Up ──────────────────────────────────────────────────────────────
document.getElementById('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('signup-btn');
  const errorEl = document.getElementById('signup-error');
  errorEl.textContent = '';

  const username = document.getElementById('signup-username').value.trim();
  const password = document.getElementById('signup-password').value;
  const confirm = document.getElementById('signup-confirm').value;
  const iconColor = document.getElementById('signup-color').value;

  if (password !== confirm) {
    errorEl.textContent = 'Passwords do not match';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating account…';

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ username, password, iconColor }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Registration failed';
    } else {
      window.location.href = 'chat.html';
    }
  } catch {
    errorEl.textContent = 'Network error. Please try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Account';
  }
});
