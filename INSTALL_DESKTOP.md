# Desktop app

The desktop app is the hosted GChat web app in a native window, with a tray icon, notifications, launch at login and an in-app update check. It only ever loads `https://gchat.up.railway.app`; if the service or your connection is down you get a retry screen instead.

- **Windows** uses a thin WebView2 host (`src-desktop-win`, built on wry and tao). The installer is about 1 MB because it relies on the WebView2 runtime that ships with Windows 10 and 11.
- **macOS** uses a Tauri 2 shell around WKWebView, as a fallback build. It's a universal `.dmg`.

## Install

Download the file for your system from the [latest release](https://github.com/Panther114/GChat/releases/latest):

- Windows: `Gchat_<version>_x64-setup.exe`
- macOS: `Gchat_<version>_universal.dmg`

The builds aren't code-signed, so Windows SmartScreen or macOS Gatekeeper will ask you to confirm the first launch. The Windows installer is per-user (no admin rights) and puts the app in `%LOCALAPPDATA%\Programs\Gchat`.

## Behavior worth knowing

- Closing or minimizing the window hides it to the tray. Left-click the tray icon to bring it back, right-click for Open, Check for Updates and Quit.
- Starting the app a second time brings the running window to the front.
- Sign-in data lives in the WebView2 profile next to the executable (`Gchat.exe.WebView2`), so install it somewhere your user can write to.
- Most updates ship on the server side and only need a reload. You only need a new installer when the shell itself changes (tray, notifications, installer, icon).
- Settings → Updates checks GitHub. The Windows updater verifies a minisign signature before running a downloaded installer, so every release must include `Gchat_<version>_x64-setup.exe.sig` next to the installer. `build-desktop.yml` creates it with `tauri signer sign`, using the `TAURI_SIGNING_PRIVATE_KEY` secret and the public key in `src-tauri/tauri.conf.json`. An installer with a missing or bad signature is deleted without being run.

## Build it yourself

You need Node 20+ and stable Rust. Build each target on its own OS.

```bash
npm ci --include=dev
npm run build:win     # needs NSIS (makensis); output in src-desktop-win/target/release/bundle/
npm run build:mac     # needs the aarch64 and x86_64 Apple Rust targets
```

Pushing a `v*` tag builds both and publishes the installers and updater metadata to one GitHub release. `npm run build:win:tauri` and `npm run build:win:electron` are older Windows paths kept for comparison; the Electron one uses much more memory.

`npm run desktop` runs the Windows shell straight from the source tree.
