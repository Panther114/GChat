# Gchat Desktop for Windows and macOS

## Windows production: thin WebView2 shell

Windows packages use a **non-Tauri thin native host** (`src-desktop-win`, wry/tao) over the system **WebView2** runtime. It is not Electron/Chromium and not the full Tauri plugin stack.

Key behaviors:

- Loads only `https://gchat.up.railway.app`
- Full `window.electronAPI` bridge (tray, notifications, badges, autostart, clipboard, offline retry, updates)
- **Tray-hide unloads the SPA** into a tiny placeholder page to free WebView2/JS heap while the process stays in the tray
- Restoring from tray reloads the hosted app (session cookies remain in the WebView2 profile)
- Memory-oriented WebView2 flags (`max-old-space-size=192`, unused features disabled)
- Installer ~1 MiB NSIS (`Gchat_1.3.8_x64-setup.exe`)

## macOS: Tauri / WKWebView fallback

macOS continues to use **Tauri 2 + WKWebView** (`npm run build:mac`). Same hosted UI and bridge contract.

## Install

Download the GitHub Release for **v1.3.8**:

- **Windows:** `Gchat_1.3.8_x64-setup.exe`
- **macOS:** universal `.dmg` from the Tauri build path when published

First launch may require SmartScreen / Privacy approval (unsigned packages).

## Build

### Windows (production thin shell)

```bash
npm ci --include=dev
npm run build:win
```

Requires Rust stable and NSIS (`makensis`). Output:

`src-desktop-win/target/release/bundle/Gchat_1.3.8_x64-setup.exe`

### macOS (Tauri fallback)

```bash
npm ci --include=dev
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run build:mac
```

### Optional paths (not production Windows)

- `npm run build:win:tauri` — prior Tauri NSIS path
- `npm run build:win:electron` — Chromium (higher RAM; experimental only)

## Desktop behavior

- Hosted production service only
- Tray: left-click restore/hide; menu Open / Check for Updates / Quit
- Close hides to tray (Windows thin shell also suspends SPA HTML)
- Settings → Updates in-app check UI
- Single-instance lock
- External links open in the default browser
