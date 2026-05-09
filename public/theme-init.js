(function () {
  const LEGACY_LOCAL_SETTINGS_KEY = 'gchat:local-settings';
  const ACTIVE_LOCAL_SETTINGS_KEY = 'gchat:active-local-settings';
  const DEFAULT_WALLPAPER = "url('gchat_wallpaper.jpg')";
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
    next.wallpaperDataUrl = typeof next.wallpaperDataUrl === 'string' && next.wallpaperDataUrl ? next.wallpaperDataUrl : null;
    next.wallpaperBlur = clampInteger(next.wallpaperBlur, 0, MAX_WALLPAPER_BLUR, DEFAULTS.wallpaperBlur);
    next.wallpaperTransparency = clampInteger(next.wallpaperTransparency, 0, 100, DEFAULTS.wallpaperTransparency);
    return next;
  }

  function wallpaperCssValue(dataUrl) {
    if (!dataUrl) return DEFAULT_WALLPAPER;
    return `url(${JSON.stringify(String(dataUrl))})`;
  }

  function getWallpaperOverlayOpacity(settings) {
    const normalized = normalizeSettings(settings);
    return String((100 - normalized.wallpaperTransparency) / 100);
  }

  function applyToRoot(settings, root) {
    const target = root || document.documentElement;
    const normalized = normalizeSettings(settings);
    target.style.setProperty('--chat-wallpaper', wallpaperCssValue(normalized.wallpaperDataUrl));
    target.style.setProperty('--auth-wallpaper', wallpaperCssValue(normalized.wallpaperDataUrl));
    target.style.setProperty('--wallpaper-blur', `${normalized.wallpaperBlur}px`);
    target.style.setProperty('--wallpaper-overlay-opacity', getWallpaperOverlayOpacity(normalized));
    return normalized;
  }

  function readSettingsFromStorage() {
    const active = readStoredSettings(ACTIVE_LOCAL_SETTINGS_KEY);
    if (active && typeof active === 'object') return normalizeSettings(active);
    const legacy = readStoredSettings(LEGACY_LOCAL_SETTINGS_KEY);
    if (legacy && typeof legacy === 'object') return normalizeSettings(legacy);
    return { ...DEFAULTS };
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
  };

  applyToRoot(readSettingsFromStorage());
})();
