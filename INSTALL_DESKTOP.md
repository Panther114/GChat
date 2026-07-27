# Gchat Desktop for Windows and macOS

Gchat Desktop is a lightweight Tauri shell for the hosted application at `https://gchat.up.railway.app`. The browser and desktop versions use the same deployed HTML, CSS, JavaScript, APIs, encryption, and account data.

## Install

Download the newest stable package from GitHub Releases:

- Windows: run the x64 `-setup.exe` installer.
- macOS: open the universal `.dmg` and drag Gchat into Applications.

The Tauri release uses a new system-webview profile. Users upgrading from an Electron release sign in once; membership-scoped server escrow restores group encryption keys and history. Local-only preferences may return to their defaults.

Windows uses the shared Evergreen WebView2 runtime. Windows 11 includes it, and the installer downloads Microsoft's small bootstrapper only when the runtime is missing. macOS uses WKWebView supplied by the operating system.

The packages are currently not OS code-signed or notarized. Windows SmartScreen or macOS Privacy & Security may therefore require explicit first-launch approval.

## Build

Install Node.js 20+ and stable Rust, then run on the target operating system:

```bash
npm ci --include=dev
npm run build:win
```

```bash
npm ci --include=dev
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run build:mac
```

Bundles are written beneath `src-tauri/target/<target>/release/bundle/`. Pushing a version tag matching `package.json` runs verification, builds Windows x64 and universal macOS packages, signs updater artifacts, and publishes them together as the newest stable GitHub Release.

## Desktop behavior

- Loads the production hosted service only; no local chat server or Chromium runtime is packaged.
- Persists login cookies, browser storage, web cache, and IndexedDB in the system webview profile.
- Provides tray controls, close-to-tray, notifications, unread badges, single-instance focusing, external-link handling, attachment clipboard support, and optional launch at sign-in.
- Checks GitHub Releases after startup and every 30 minutes while running; it does not poll Railway.
- Restricts native commands to the exact production Gchat origin.

## Troubleshooting

| Problem | Resolution |
|---|---|
| Windows blocks the installer | Choose **More info → Run anyway** until a Windows signing certificate is configured. |
| macOS blocks first launch | Approve Gchat in **System Settings → Privacy & Security**. |
| The connection-recovery screen appears | Confirm access to the hosted service and choose **Retry connection**. |
| Notifications do not appear | Enable Gchat notifications in operating-system settings. |
| A second launch opens the existing window | This is the intended single-instance behavior. |
| An Electron installation remains | Uninstall the old Electron release, then install the newest GitHub Release. Account data remains hosted. |
