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
const PANELS = ['signin-form', 'signup-form', 'add-email-form', 'verify-email-form'];

function showPanel(panelId) {
  const isVerifyPanel = panelId === 'verify-email-form' || panelId === 'add-email-form';
  const tabsEl = document.getElementById('auth-tabs');
  if (tabsEl) tabsEl.style.display = isVerifyPanel ? 'none' : '';

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

async function redirectIfAuthenticated() {
  try {
    const res = await fetch('/api/auth/me', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data.needsEmailVerification) {
        if (data.needsEmailEntry) {
          showPanel('add-email-form');
        } else {
          showPanel('verify-email-form');
        }
        return;
      }
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
    } else if (data.needsEmailVerification) {
      persistUserWallpaperSettings(data);
      if (data.needsEmailEntry) {
        showPanel('add-email-form');
      } else {
        showPanel('verify-email-form');
      }
    } else {
      persistUserWallpaperSettings(data);
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
  const email = document.getElementById('signup-email').value.trim();
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
      body: JSON.stringify({ username, email, password, iconColor }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Registration failed';
    } else {
      persistUserWallpaperSettings(data);
      // After registration, always need email verification
      const infoEl = document.getElementById('verify-email-info');
      if (infoEl) infoEl.textContent = `A 6-digit verification code has been sent to ${email}. Enter it below.`;
      showPanel('verify-email-form');
    }
  } catch {
    errorEl.textContent = 'Network error. Please try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Account';
  }
});

// ── Add Email (existing users without email) ──────────────────────────────
document.getElementById('add-email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('add-email-btn');
  const errorEl = document.getElementById('add-email-error');
  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Sending code…';

  const email = document.getElementById('add-email-input').value.trim();

  try {
    const res = await fetch('/api/auth/add-email', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Failed to send code';
    } else {
      const infoEl = document.getElementById('verify-email-info');
      if (infoEl) infoEl.textContent = `A 6-digit verification code has been sent to ${email}. Enter it below.`;
      showPanel('verify-email-form');
    }
  } catch {
    errorEl.textContent = 'Network error. Please try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Verification Code';
  }
});

// ── Email Verification ────────────────────────────────────────────────────
document.getElementById('verify-email-btn').addEventListener('click', async () => {
  const btn = document.getElementById('verify-email-btn');
  const errorEl = document.getElementById('verify-email-error');
  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Verifying…';

  const code = document.getElementById('verify-code-input').value.trim();

  try {
    const res = await fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Verification failed';
    } else {
      persistUserWallpaperSettings(data);
      window.location.href = 'chat.html';
    }
  } catch {
    errorEl.textContent = 'Network error. Please try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify Email';
  }
});

// ── Resend code ───────────────────────────────────────────────────────────
document.getElementById('resend-code-btn').addEventListener('click', async () => {
  const btn = document.getElementById('resend-code-btn');
  const errorEl = document.getElementById('verify-email-error');
  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const res = await fetch('/api/auth/send-verification-email', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Failed to resend code';
    } else {
      errorEl.style.color = 'var(--accent2)';
      errorEl.textContent = 'Code resent. Check your email.';
      setTimeout(() => {
        errorEl.textContent = '';
        errorEl.style.color = '';
      }, 4000);
    }
  } catch {
    errorEl.textContent = 'Network error. Please try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Resend Code';
  }
});
