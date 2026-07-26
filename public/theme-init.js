(function () {
  const LEGACY_LOCAL_SETTINGS_KEY = 'gchat:local-settings';
  const ACTIVE_LOCAL_SETTINGS_KEY = 'gchat:active-local-settings';
  const THEME_CACHE_KEY = 'gchat:theme-preference';
  const DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY = 'gchat:desktop-sidebar-width';
  // Solid Discord fills only — wallpaper images are intentionally disabled.
  const DEFAULT_WALLPAPER = 'none';
  const DEFAULTS = Object.freeze({
    wallpaperDataUrl: null,
    wallpaperBlur: 0,
    wallpaperTransparency: 100,
  });
  const MAX_WALLPAPER_BLUR = 24;

  function readStoredSettings(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function clampInteger(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  }

  function normalizeSettings(settings) {
    const next = settings && typeof settings === 'object' ? { ...settings } : {};
    // Force solid fill: ignore any stored wallpaper image.
    next.wallpaperDataUrl = null;
    next.wallpaperBlur = clampInteger(next.wallpaperBlur, 0, MAX_WALLPAPER_BLUR, DEFAULTS.wallpaperBlur);
    next.wallpaperTransparency = 100;
    next.theme = ['system', 'dark', 'light'].includes(next.theme) ? next.theme : 'light';
    return next;
  }

  function applyTheme(preference, root) {
    const target = root || document.documentElement;
    const selected = ['system', 'dark', 'light'].includes(preference) ? preference : 'system';
    const resolved = selected === 'system'
      ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : selected;
    // Smooth theme cross-fade class for one transition cycle
    target.classList.add('theme-switching');
    target.dataset.theme = resolved;
    target.dataset.themePreference = selected;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = resolved === 'light' ? '#ffffff' : '#0a0a0a';
    try {
      localStorage.setItem(THEME_CACHE_KEY, selected);
      const settings = readSettingsFromStorage();
      localStorage.setItem(ACTIVE_LOCAL_SETTINGS_KEY, JSON.stringify({ ...settings, theme: selected }));
    } catch {
      /* ignore quota / private mode */
    }
    window.setTimeout(() => target.classList.remove('theme-switching'), 360);
    return selected;
  }

  function wallpaperCssValue() {
    return DEFAULT_WALLPAPER;
  }

  function getWallpaperOverlayOpacity() {
    return 0;
  }

  function applyToRoot(settings, root) {
    const target = root || document.documentElement;
    const normalized = normalizeSettings(settings);
    target.style.setProperty('--chat-wallpaper', 'none');
    target.style.setProperty('--auth-wallpaper', 'none');
    target.style.setProperty('--wallpaper-blur', '0px');
    target.style.setProperty('--wallpaper-overlay-opacity', '0');
    return normalized;
  }

  function readSettingsFromStorage() {
    const active = readStoredSettings(ACTIVE_LOCAL_SETTINGS_KEY);
    if (active && typeof active === 'object') return normalizeSettings(active);
    const legacy = readStoredSettings(LEGACY_LOCAL_SETTINGS_KEY);
    if (legacy && typeof legacy === 'object') return normalizeSettings(legacy);
    return { ...DEFAULTS, theme: 'light' };
  }

  window.GChatWallpaperTheme = {
    ACTIVE_LOCAL_SETTINGS_KEY,
    LEGACY_LOCAL_SETTINGS_KEY,
    DEFAULTS,
    MAX_WALLPAPER_BLUR,
    applyToRoot,
    getWallpaperOverlayOpacity,
    normalizeSettings,
    readSettingsFromStorage,
    readStoredSettings,
    wallpaperCssValue,
    applyTheme,
  };

  const initialSettings = readSettingsFromStorage();
  try {
    const width = Number(localStorage.getItem(DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY));
    if (Number.isFinite(width) && width >= 104) document.documentElement.style.setProperty('--sidebar-width', `${Math.round(width)}px`);
  } catch {
    /* ignore */
  }
  applyToRoot(initialSettings);
  const cachedTheme = (() => {
    try {
      return localStorage.getItem(THEME_CACHE_KEY);
    } catch {
      return null;
    }
  })();
  applyTheme(cachedTheme || initialSettings.theme || 'light');
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (document.documentElement.dataset.themePreference === 'system') applyTheme('system');
  });
})();
