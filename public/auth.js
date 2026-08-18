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
  const stored = wallpaperTheme.readSettingsFromStorage();
  const sourceSettings = user.clientSettings && typeof user.clientSettings === 'object'
    ? { ...user.clientSettings, theme: user.clientSettings.theme || stored.theme }
    : stored;
  const normalized = wallpaperTheme.normalizeSettings(sourceSettings);
  const payload = JSON.stringify({
    ...(user.clientSettings && typeof user.clientSettings === 'object' ? user.clientSettings : {}),
    wallpaperDataUrl: normalized.wallpaperDataUrl,
    wallpaperBlur: normalized.wallpaperBlur,
    wallpaperTransparency: normalized.wallpaperTransparency,
    theme: normalized.theme,
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

function startAuthWaveAnimation() {
  const canvas = document.getElementById('auth-wave-canvas');
  const context = canvas?.getContext('2d', { alpha: false });
  if (!canvas || !context) return;

  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let animationFrame = 0;
  let lastPaint = 0;
  let pointX = new Float32Array(0);
  let pointZ = new Float32Array(0);

  const resize = () => {
    width = window.innerWidth;
    height = window.innerHeight;
    pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(width * pixelRatio));
    canvas.height = Math.max(1, Math.round(height * pixelRatio));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const mobile = width < 600;
    const depthStep = mobile ? 28 : 24;
    const columnStep = mobile ? 30 : 27;
    const nearDepth = -120;
    const farDepth = 1200;
    const halfWorldWidth = Math.max(760, width * 1.12);
    const columns = Math.ceil((halfWorldWidth * 2) / columnStep) + 1;
    const rows = Math.ceil((farDepth - nearDepth) / depthStep) + 1;
    const pointCount = columns * rows;
    pointX = new Float32Array(pointCount);
    pointZ = new Float32Array(pointCount);

    let pointIndex = 0;
    for (let row = 0; row < rows; row += 1) {
      const z = nearDepth + row * depthStep;
      for (let column = 0; column < columns; column += 1) {
        pointX[pointIndex] = -halfWorldWidth + column * columnStep;
        pointZ[pointIndex] = z;
        pointIndex += 1;
      }
    }
    canvas.dataset.pointCount = String(pointCount);
    canvas.dataset.nearDepth = String(nearDepth);
    canvas.dataset.renderer = 'perspective-dot-wave';
  };

  const paint = (timestamp) => {
    animationFrame = window.requestAnimationFrame(paint);
    const frameInterval = 1000 / (width < 600 ? 24 : 30);
    if (document.hidden || timestamp - lastPaint < frameInterval) return;
    lastPaint = timestamp;
    const isLight = document.documentElement.dataset.theme === 'light';
    context.fillStyle = isLight ? '#f0f0f0' : '#050505';
    context.fillRect(0, 0, width, height);
    context.fillStyle = isLight ? '#000000' : '#ffffff';

    const phase = timestamp * 0.001;
    const focalLength = Math.min(640, Math.max(430, width * 0.48));
    const cameraDistance = 178;
    const cameraHeight = height < 620 ? 142 : 172;
    const horizon = height * (width < 600 ? 0.12 : 0.1);
    const vanishingX = width * 0.5;
    const lateralDrift = Math.sin(phase * 0.27) * 18;

    context.beginPath();
    for (let index = pointX.length - 1; index >= 0; index -= 1) {
      const x = pointX[index];
      const z = pointZ[index];
      const depth = z + cameraDistance;
      const perspective = focalLength / depth;
      const primaryWave = Math.sin(x * 0.0125 + z * 0.009 - phase * 1.35);
      const crossingWave = Math.cos(x * 0.006 - z * 0.015 + phase * 0.92);
      const longSwell = Math.sin((x + z) * 0.0042 + phase * 0.58);
      const elevation = primaryWave * 24 + crossingWave * 15 + longSwell * 11;
      const screenX = vanishingX + (x + lateralDrift) * perspective;
      const screenY = horizon + (cameraHeight - elevation) * perspective;
      if (screenX < -4 || screenX > width + 4 || screenY < -4 || screenY > height + 4) continue;

      const radius = Math.min(2.45, Math.max(0.72, perspective * 0.92));
      context.moveTo(screenX + radius, screenY);
      context.arc(screenX, screenY, radius, 0, Math.PI * 2);
    }
    context.fill();
  };

  resize();
  window.addEventListener('resize', resize, { passive: true });
  animationFrame = window.requestAnimationFrame(paint);
  window.addEventListener('pagehide', () => window.cancelAnimationFrame(animationFrame), { once: true });
}

startAuthWaveAnimation();

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

function setAuthLoading(loading, label = 'Signing in…') {
  const card = document.querySelector('.auth-card');
  const overlay = document.getElementById('auth-loading-overlay');
  const labelEl = document.getElementById('auth-loading-label');
  const isLoading = !!loading;
  if (labelEl && label) labelEl.textContent = label;
  if (card) {
    card.classList.toggle('is-loading', isLoading);
    card.setAttribute('aria-busy', String(isLoading));
  }
  if (overlay) {
    overlay.hidden = !isLoading;
    overlay.setAttribute('aria-busy', String(isLoading));
  }
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
  setAuthLoading(true, 'Signing in…');
  let redirecting = false;

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
      redirecting = true;
      window.location.href = chatRedirectUrl();
    }
  } catch {
    errorEl.textContent = 'Network error. Please try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
    if (!redirecting) setAuthLoading(false);
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
  setAuthLoading(true, 'Creating account…');
  let redirecting = false;

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
      redirecting = true;
      window.location.href = chatRedirectUrl();
    }
  } catch {
    errorEl.textContent = 'Network error. Please try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Account';
    if (!redirecting) setAuthLoading(false);
  }
});

