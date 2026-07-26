# Gchat Desktop for Windows and macOS

Gchat Desktop is a lightweight Electron shell for the hosted Gchat application. It loads the same production service at `https://gchat.up.railway.app`, so chat, invitations, encryption, account behavior, and UI are identical across the web, Windows, and macOS versions.

## Install on Windows

1. Download `Gchat-Setup-<version>.exe` from the latest GitHub Release.
2. Follow the setup wizard. It installs for the current user by default and lets you choose the destination folder and shortcuts.
3. Gchat opens automatically when setup finishes unless you clear that option.

The desktop window opens the hosted sign-in page immediately. Electron stores the authenticated web session and client-side encrypted group keys in its persistent `persist:gchat` profile, so a returning user is taken straight back to the hosted app without repeating desktop setup.

> The installer is currently unsigned. Windows SmartScreen may require **More info → Run anyway** until a trusted code-signing certificate is configured for release builds.

## Install on macOS

1. Download `Gchat-<version>-mac-universal.dmg` from the latest GitHub Release.
2. Open the disk image and drag Gchat into Applications.
3. Open Gchat from Applications.

The universal package runs natively on both Apple Silicon and Intel Macs.

> The app is currently unsigned and not notarized. macOS may require you to approve its first launch in **System Settings → Privacy & Security**.

## Build desktop packages

Run the Windows build on Windows:

```bash
npm install --include=dev
npm run build:win
```

Run the macOS build on macOS:

```bash
npm install --include=dev
npm run build:mac
```

Packages are written to `release/`:

| File | Description |
|---|---|
| `Gchat-Setup-<version>.exe` | Assisted, per-user Windows installer with destination and shortcut choices. |
| `latest.yml` and `.blockmap` | Windows updater metadata. |
| `Gchat-<version>-mac-universal.dmg` | Universal macOS installer for Apple Silicon and Intel Macs. |
| `Gchat-<version>-mac-universal.zip` | Universal macOS update payload. |
| `latest-mac.yml` and `.blockmap` | macOS updater metadata. |

The build keeps the main-process cold-start bundle under a 32 KiB budget and packages the updater separately. Packaged apps initialize update checks after the window is usable, while the tray's manual update action remains available immediately. Because Gchat does not use WebGPU, the Windows build removes only its optional DXIL compiler binaries; Chromium's normal graphics fallbacks and media codecs remain packaged.

Pushing a version tag such as `v1.3.4` starts parallel Windows and macOS builds. After both builds succeed, the workflow combines their installers and updater metadata into one GitHub Release.

## Desktop behavior

- Uses the production hosted service only; no local chat server is packaged.
- Persists the Chromium session, web cache, IndexedDB keys, and login cookies in the Electron profile.
- Provides native notifications, an unread badge, system tray/menu bar controls, single-instance behavior, and optional launch at system sign-in.
- Downloads versioned GitHub Release updates in the background and installs them after the app exits.
- Opens external links in the default browser.
- Retains Electron security boundaries: `contextIsolation`, sandboxing, and no Node integration in the hosted renderer.

## Troubleshooting

| Problem | What to do |
|---|---|
| Installer is blocked by SmartScreen | Use **More info → Run anyway**, or use a release signed with the Gchat Windows code-signing certificate. |
| macOS blocks the first launch | In **System Settings → Privacy & Security**, approve Gchat, or distribute a future notarized build. |
| Gchat shows its connection-recovery screen | Confirm access to `https://gchat.up.railway.app`, then choose retry. |
| Notifications do not appear | Check the operating system notification settings for Gchat. |
| A second launch does not open another window | This is expected; Gchat brings the existing single instance to the front. |

## File locations

Electron stores its profile under `%APPDATA%\Gchat\` on Windows and `~/Library/Application Support/Gchat/` on macOS. Do not remove this directory unless you intend to sign out and remove local encrypted group keys.
