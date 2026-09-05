# Gchat Desktop for Windows and macOS

## Windows production: thin WebView2 shell

Windows packages use a **non-Tauri thin native host** (`src-desktop-win`, wry/tao) over the system **WebView2** runtime. It is not Electron/Chromium and not the full Tauri plugin stack.

Key behaviors:

- Loads only `https://gchat.up.railway.app`
- Full `window.electronAPI` bridge (tray, notifications, autostart, clipboard, offline retry, updates)
- **Tray-hide keeps the SPA alive** for instant restore (no placeholder page; only minimize/close visibility changes)
- Restoring from tray is instant (session cookies remain in the WebView2 profile)
- Memory-oriented WebView2 flags (`max-old-space-size=384`, unused features disabled)
- Installer ~1 MiB NSIS (`Gchat_1.4.6_x64-setup.exe`)

## macOS: Tauri / WKWebView fallback

macOS continues to use **Tauri 2 + WKWebView** (`npm run build:mac`). Same hosted UI and bridge contract.

## Install

Download the GitHub Release for **v1.4.6**:

- **Windows:** `Gchat_1.4.6_x64-setup.exe`
- **macOS:** universal `.dmg` from the Tauri build path when published

First launch may require SmartScreen / Privacy approval (unsigned packages).

## Build

### Windows (production thin shell)

```bash
npm ci --include=dev
npm run build:win
```

Requires Rust stable and NSIS (`makensis`). Output:

`src-desktop-win/target/release/bundle/Gchat_1.4.6_x64-setup.exe`

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
- Close hides to tray (SPA stays loaded for instant restore)
- Settings → Updates in-app check UI
- Single-instance lock (a second launch focuses the running window)
- External links open in the default browser

## Release signing (required)

The thin shell's updater verifies a minisign signature before executing a
downloaded installer: every GitHub release must ship
`Gchat_<version>_x64-setup.exe` **together with** `Gchat_<version>_x64-setup.exe.sig`,
signed with the same keypair as the Tauri updater (`src-tauri/tauri.conf.json`
`pubkey`). `build-desktop.yml` does this automatically via
`tauri signer sign` (needs the `TAURI_SIGNING_PRIVATE_KEY` secret). An update
whose signature is missing or invalid is deleted and never executed.
