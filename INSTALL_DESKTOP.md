# Gchat Desktop for Windows and macOS

Gchat Desktop is a lightweight **Electron** shell for the hosted application at `https://gchat.up.railway.app`. Browser and desktop share the same HTML, CSS, JavaScript, APIs, encryption, and account data.

Windows and macOS production builds use Electron (tray, close/minimize-to-tray, notifications, GitHub auto-update, `window.electronAPI` bridge). Memory-oriented Chromium flags reduce the renderer surface (`WebGPU` off, capped V8 heap, reduced background networking).

## Install

Download the newest stable package from the GitHub Release matching this repo version (for example **v1.3.7**):

- **Windows:** run `Gchat-Setup-1.3.7.exe` (NSIS, current-user friendly).
- **macOS:** open the universal `Gchat-1.3.7-mac-universal.dmg` and drag **Gchat** into Applications (Apple Silicon + Intel).

Users upgrading from the older Tauri (WebView2 / WKWebView) packages should install the newest Electron package and sign in once; membership-scoped server escrow restores group encryption keys and history. Local-only preferences may reset when the shell profile path changes.

### Code signing (current limitation)

Packages are **not** OS code-signed or notarized yet (no Apple/Windows developer certificate in CI). First launch may require:

- Windows SmartScreen → **More info → Run anyway**
- macOS → **System Settings → Privacy & Security** → allow Gchat

In-app updates use **electron-updater** against GitHub Releases (`latest.yml` / `latest-mac.yml`).

## Build

Install Node.js 20+ on the target OS:

```bash
npm ci --include=dev
npm run build:win
```

```bash
npm ci --include=dev
npm run build:mac
```

Bundles land under `release/`. Pushing a git tag `v*` that matches `package.json` runs `.github/workflows/build-desktop.yml`: verify → Windows + macOS Electron builds → publish GitHub Release with installers and updater metadata.

### macOS Tauri fallback

If Electron packaging cannot run on a given Mac toolchain, the previous **Tauri 2 / WKWebView** shell remains in `src-tauri/` as a documented fallback:

```bash
npm ci --include=dev
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run build:mac:tauri
```

Prefer the Electron primary build for release parity (settings update UI, shared installer naming). Use Tauri only when Electron is blocked on that machine.

Regenerate branded icons when needed:

```bash
python scripts/regenerate-icons.py
```

## Desktop behavior

- Loads only the production hosted service; no local chat server is packaged.
- Persists cookies, storage, cache, and IndexedDB in the Electron `persist:gchat` profile.
- Tray: left-click restores/focuses (or hides when already frontmost); right-click menu (Open, Check for Updates, Quit).
- Close and minimize both hide to tray.
- Native notifications, unread badges, single-instance focus, external links, attachment clipboard, optional launch-at-sign-in.
- Auto-update checks GitHub Releases after startup and every 30 minutes (not Railway).
- **Settings → Updates:** in-app Check for updates, status (idle / checking / up to date / available / downloading / ready / error), Install and restart when ready, or open the latest GitHub Release.
- Native bridge is the `window.electronAPI` preload surface (contextIsolation + sandbox).

## Troubleshooting

| Problem | Resolution |
|---|---|
| Windows blocks the installer | **More info → Run anyway** until an Authenticode certificate is configured. |
| macOS blocks first launch | Approve Gchat in **System Settings → Privacy & Security**. |
| Connection-recovery screen | Confirm network access to `gchat.up.railway.app`, then **Retry connection**. |
| Notifications do not appear | Enable Gchat notifications in OS settings. |
| Second launch focuses existing window | Intended single-instance behavior. |
| Old Tauri install remains | Uninstall Tauri Gchat, install the newest Electron GitHub Release. Hosted accounts stay intact. |
| Need system webview only (Mac) | Build with `npm run build:mac:tauri` fallback when Electron cannot be packaged. |

## File locations

Electron stores its profile under `%APPDATA%\Gchat\` on Windows and `~/Library/Application Support/Gchat/` on macOS. Do not remove this directory unless you intend to sign out and remove local encrypted group keys.
