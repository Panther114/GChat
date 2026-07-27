# Gchat Desktop for Windows and macOS

Gchat Desktop is a lightweight Tauri 2 shell for the hosted application at `https://gchat.up.railway.app`. Browser and desktop share the same HTML, CSS, JavaScript, APIs, encryption, and account data. Windows and macOS builds use the same native shell behavior (tray, close/minimize-to-tray, notifications, updater, bridge).

## Install

Download the newest stable package from the GitHub Release matching this repo version (for example **v1.3.6**):

- **Windows:** run the x64 `Gchat_*_x64-setup.exe` installer (branded Gchat icon).
- **macOS:** open the universal `.dmg` and drag **Gchat** into Applications (Apple Silicon + Intel).

Users upgrading from an older Electron release should install the newest Tauri package and sign in once; membership-scoped server escrow restores group encryption keys and history. Local-only preferences may reset.

Windows uses the shared Evergreen WebView2 runtime (bootstrapper downloads only when missing). macOS uses the system WKWebView.

### Code signing (current limitation)

Packages are **not** OS code-signed or notarized yet (no Apple/Windows developer certificate in CI). First launch may require:

- Windows SmartScreen → **More info → Run anyway**
- macOS → **System Settings → Privacy & Security** → allow Gchat

Updater artifacts are still **Tauri minisign-signed** via `TAURI_SIGNING_PRIVATE_KEY` so in-app updates verify integrity.

## Build

Install Node.js 20+ and the stable Rust toolchain on the target OS:

```bash
npm ci --include=dev
npm run build:win
```

```bash
npm ci --include=dev
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run build:mac
```

Regenerate desktop icons (navy square + white mark) when branding changes:

```bash
python scripts/regenerate-icons.py
npx tauri icon src-tauri/icons/app-icon-source.png --output src-tauri/icons
```

Bundles land under `src-tauri/target/.../release/bundle/`. Pushing a git tag `v*` that matches `package.json` runs `.github/workflows/build-desktop.yml`: verify → Windows + macOS builds → publish GitHub Release with installers and `latest.json`.

## Desktop behavior

- Loads only the production hosted service; no local chat server or Chromium is packaged.
- Persists cookies, storage, cache, and IndexedDB in the system webview profile.
- Tray: left-click restores/focuses (or hides when already frontmost); right-click menu (Open, Check for Updates, Quit).
- Close and minimize both hide to tray (no taskbar entry while hidden).
- Native notifications, unread badges, single-instance focus, external links, attachment clipboard, optional launch-at-sign-in.
- Auto-update checks GitHub Releases after startup and every 30 minutes (not Railway).
- Native bridge IPC is ACL-limited to the official hosted origin plus the bundled offline page.

## Troubleshooting

| Problem | Resolution |
|---|---|
| Windows blocks the installer | **More info → Run anyway** until an Authenticode certificate is configured. |
| Installer/tray icon looks blank | Install **v1.3.6+** (navy branded icon). Uninstall older builds first. |
| Tray click does nothing | Use **v1.3.6+**. Left-click should restore; right-click opens the menu with **Open Gchat**. |
| macOS blocks first launch | Approve Gchat in **System Settings → Privacy & Security**. |
| Connection-recovery screen | Confirm network access to `gchat.up.railway.app`, then **Retry connection**. |
| Notifications do not appear | Enable Gchat notifications in OS settings. |
| Second launch focuses existing window | Intended single-instance behavior. |
| Old Electron install remains | Uninstall Electron Gchat, install the newest Tauri GitHub Release. Hosted accounts stay intact. |
