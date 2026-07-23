// ── CSRF token (fetched once, reused for all state-changing requests) ─────
let csrfToken = null;
const wallpaperTheme = window.GChatWallpaperTheme || null;
const LEGACY_LOCAL_SETTINGS_KEY = wallpaperTheme ? wallpaperTheme.LEGACY_LOCAL_SETTINGS_KEY : 'gchat:local-settings';
const ACTIVE_LOCAL_SETTINGS_KEY = wallpaperTheme ? wallpaperTheme.ACTIVE_LOCAL_SETTINGS_KEY : 'gchat:active-local-settings';
const LOCAL_SETTINGS_KEY_PREFIX = 'gchat:local-settings:user:';

function applyAuthWallpaperFromStorage() {
  if (!wallpaperTheme) return;
  wallpaperTheme.applyToRoot(wallpaperTheme.readSettingsFromStorage());
}

function persistUserWallpaperSettings(user) {
  if (!wallpaperTheme || !user || typeof user !== 'object') return;
  const normalized = wallpaperTheme.normalizeSettings(user.clientSettings || {});
  const payload = JSON.stringify({
    ...(user.clientSettings && typeof user.clientSettings === 'object' ? user.clientSettings : {}),
    wallpaperDataUrl: normalized.wallpaperDataUrl,
    wallpaperBlur: normalized.wallpaperBlur,
    wallpaperTransparency: normalized.wallpaperTransparency,
  });
  try {
    localStorage.setItem(ACTIVE_LOCAL_SETTINGS_KEY, payload);
    if (user.id) localStorage.setItem(`${LOCAL_SETTINGS_KEY_PREFIX}${user.id}`, payload);
    localStorage.removeItem(LEGACY_LOCAL_SETTINGS_KEY);
  } catch {
    // best effort only
  }
  wallpaperTheme.applyToRoot(normalized);
}

applyAuthWallpaperFromStorage();

function syncAuthThemeControls() {
  const isLight = document.documentElement.dataset.theme === 'light';
  const logo = document.querySelector('.auth-logo-icon');
  if (logo) {
    const nextSrc = isLight ? logo.dataset.lightSrc : logo.dataset.darkSrc;
    if (nextSrc && logo.getAttribute('src') !== nextSrc) logo.src = nextSrc;
  }
  const toggle = document.getElementById('auth-theme-toggle');
  if (!toggle) return;
  const label = isLight ? 'Switch to dark mode' : 'Switch to light mode';
  toggle.textContent = isLight ? '☾' : '☀';
  toggle.title = label;
  toggle.setAttribute('aria-label', label);
}

document.getElementById('auth-theme-toggle')?.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  if (wallpaperTheme) wallpaperTheme.applyTheme(next);
  else document.documentElement.dataset.theme = next;
  syncAuthThemeControls();
});

syncAuthThemeControls();

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

// ── Panel management ─────────────────────────────────────────────────────
const PANELS = ['signin-form', 'signup-form'];

function showPanel(panelId) {
  PANELS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === panelId) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });
}


const SECURE_INVITE_SESSION_KEY = 'gchat:pending-secure-invite';
if (/^#invite=/.test(window.location.hash)) {
  sessionStorage.setItem(SECURE_INVITE_SESSION_KEY, window.location.hash);
}

function chatRedirectUrl() {
  const inviteFragment = sessionStorage.getItem(SECURE_INVITE_SESSION_KEY) || window.location.hash;
  return `chat.html${inviteFragment}`;
}

async function redirectIfAuthenticated() {
  try {
    const res = await fetch('/api/auth/me', { cache: 'no-store' });
    if (res.ok) {
      window.location.replace(chatRedirectUrl());
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
    tab.classList.add('active');
    showPanel(`${target}-form`);
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
      persistUserWallpaperSettings(data);
      window.location.href = chatRedirectUrl();
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
      persistUserWallpaperSettings(data);
      window.location.href = chatRedirectUrl();
    }
  } catch {
    errorEl.textContent = 'Network error. Please try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Account';
  }
});

