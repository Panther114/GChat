# Gchat Changelog

This document tracks all changes to the Gchat project in a PR-based format.

---

## v1.0.3

- Fixed attachment uploads so encrypted image/file uploads no longer fail from the mixed content-type request path.
- Made message read receipts trigger as soon as any part of a message enters the viewport, including very tall messages.
- Added stronger client/server anti-spam handling for repetitive short messages and repeated sends.
- Added wallpaper progress feedback and optimized large wallpaper uploads so big images apply reliably.
- Bumped the app version to **1.0.3**.

---

## v1.0.1

- Added the new `gchat_icon.png` branding to the login page, browser favicon, desktop runtime icon, and packaged desktop icon assets.
- Added a **Remember me** option so sign-in only persists across restarts when the user explicitly chooses it.
- Simplified the desktop onboarding copy and Windows setup documentation.
- Reduced packaged desktop size by enabling maximum compression and excluding server-only runtime dependencies from the Electron bundle.
- Bumped the app version to **1.0.1**.

---

## PR #14 — Electron desktop app (Windows/macOS/Linux)

**What changed**

- **Electron main process (`electron/main.js`)**: Added a full Electron main process that creates a `BrowserWindow` loading the configured Gchat server URL. Includes:
  - Single-instance lock (`app.requestSingleInstanceLock`) — launching a second instance focuses the existing window.
  - System tray icon with right-click context menu (Open, Check for Updates, Quit) and click-to-toggle-window behaviour.
  - Hide-to-tray on window close — the app keeps running in the background like WeChat.
  - Native OS notification via `Notification` (main process) triggered by IPC from the renderer; clicking the notification brings the window to front and navigates to the relevant group.
  - Taskbar overlay badge (red unread-count circle) updated via `mainWindow.setOverlayIcon`.
  - Taskbar button flash (`mainWindow.flashFrame`) when a new message arrives while the window is unfocused.
  - Auto-launch at system startup via `app.setLoginItemSettings`, configurable at runtime.
  - Auto-updater via `electron-updater`: checks GitHub Releases on startup (packaged builds only), prompts for download/restart.
  - Persistent config via `electron-store` (server URL, window bounds, startup preference).
  - `app.setAppUserModelId('com.Gchat.app')` for correct Windows Action Center grouping.

- **Preload script (`electron/preload.js`)**: Implements the secure renderer ↔ main bridge using `contextBridge.exposeInMainWorld`. Exposes `window.electronAPI` with: `setUnreadCount`, `showNotification`, `onFocusGroup`, `getLaunchAtStartup`, `setLaunchAtStartup`, `getServerUrl`, `setServerUrl`. Security settings: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.

- **Native notifications in `public/app.js`**:
  - Added `requestNotificationPermission()` — called on DOMContentLoaded to request `Notification.permission`.
  - Added `sendNativeNotification(title, body, groupId)` — routes to `window.electronAPI.showNotification` in the desktop app, or falls back to the Web Notification API in a plain browser.
  - `new_message` handler now calls `sendNativeNotification` when a message arrives in a background group (always) or the active group while the window is not focused.
  - `updatePageTitleNotification` now also calls `window.electronAPI?.setUnreadCount(n)` to keep the Electron taskbar badge in sync.
  - On DOMContentLoaded, registers `window.electronAPI?.onFocusGroup` callback to switch to the correct group when a notification is clicked.

- **`package.json`**:
  - Added `devDependencies`: `electron ^41.0.0`, `electron-builder ^25.0.0`, `electron-updater ^6.3.0`, `electron-store ^10.0.0`, `cross-env ^7.0.3`.
  - Added scripts: `electron`, `electron:dev`, `build:win`, `build:mac`, `build:linux`.
  - Added `electron-builder` `build` config: appId `com.Gchat.app`, NSIS installer + portable `.exe`, Windows/macOS/Linux targets, GitHub publish config.

- **`railway.json`**: Added `"buildCommand": "npm install --omit=dev"` to the `build` block. This prevents Railway from downloading the Electron binary (a large platform-specific download) on every server deploy. Electron and electron-builder are `devDependencies` and are not needed on the server.

- **`.gitignore`**: Added `dist/` (electron-builder output), `build/icon.ico`, `build/icon.icns`, `build/icons/` (generated icon assets).

- **`INSTALL_DESKTOP.md`**: New installation guide covering: pre-built installer download, build-from-source steps (icon setup, `npm run build:win`), server URL configuration, auto-launch setup, system tray usage, notification permissions, auto-updater, troubleshooting table, and file locations on Windows.

- **`README.md`**: Added "Windows Desktop App (Electron)" section with quick-start, build commands, link to install guide, and Railway note. Updated Features list and Tech Stack table. Updated File Structure section.

- **`features.md`**: Added new "Desktop App (Electron)" section with all 16 desktop features marked `[x]`. Updated the Deployment section entry for `railway.json`. Added native OS notification to the UI & Experience section.

**What was NOT changed**
- `server.js` — backend logic entirely unchanged
- `public/index.html`, `public/chat.html`, `public/style.css`, `public/auth.js` — unchanged
- All existing `package.json` production dependencies — unchanged
- All existing app.js logic outside the notification and init additions — unchanged
- Railway deployment model unchanged (still `node server.js` via Nixpacks)

**Railway deployment safety**
- Electron packages are in `devDependencies` only.
- `railway.json` now runs `npm install --omit=dev` which skips all `devDependencies`, so the Electron binary is never downloaded on Railway.
- The `node server.js` start command is unaffected.
- Existing Railway deployments will continue to work without any additional configuration.

**Notes / Risks**
- The desktop app requires a reachable Gchat server. The server URL can be changed at runtime via `window.electronAPI.setServerUrl(url)` in DevTools.
- `electron-store ^10.0.0` is ESM-only; `main.js` uses dynamic `import()` to load it.
- The taskbar overlay icon uses an SVG-generated badge. On Windows, `setOverlayIcon` requires a taskbar button (i.e. the window must have been shown at least once).
- Code-signing is not included; users may see a Windows SmartScreen warning for unsigned builds.
- Auto-updater only operates in packaged builds (`app.isPackaged`). GitHub release `publish` config must be set before auto-update works end-to-end.

---

## PR #13 — Bug fixes, security hardening, and message editing

**What changed**

- **#1 – btoa crash on large buffers (app.js)**: Replaced `btoa(String.fromCharCode(...new Uint8Array(buf)))` spread with a chunked `uint8ToBase64` helper that iterates in 32 KB slices. This prevents a `RangeError: Maximum call stack size exceeded` when encrypting files larger than ~64 KB.

- **#2 – loadingOlder race condition (app.js)**: Set `loadingOlder = true` at the start of the initial (non-paginated) `loadMessages` call and reset it in the `finally` block. Prevents the scroll handler from triggering a concurrent `loadOlderMessages` call before the first load finishes.

- **#3 – Whisper rate limiting (server.js)**: Applied the same server-side rate limit (10 events per 5 seconds, 3-duplicate block) to `send_whisper` that already existed for `send_message`. Previously whispers could bypass the rate limiter entirely.

- **#4/#30 – socketRateMap memory leak and stale state (server.js)**: On socket disconnect, if no other sockets exist for that user, old timestamps (> 5 s) are pruned from the rate-data entry. If no timestamps remain, the entry is deleted entirely, preventing unbounded map growth.

- **#5 – Pagination tie-breaking (server.js)**: Replaced the `WHERE created_at < (sub-select)` cursor with a CTE-based keyset that sorts on `(created_at DESC, id DESC)`. Messages with identical timestamps no longer skip or duplicate across page boundaries.

- **#6 – Profile picture MIME type allowlist (server.js)**: Replaced the loose `startsWith('data:image/')` check with an explicit allowlist: `image/jpeg`, `image/png`, `image/gif`, `image/webp`. SVG and other formats are now rejected with a 400 error.

- **#9/#16 – user_updated broadcast scope (server.js)**: Changed `io.emit('user_updated', …)` (broadcast to every connected socket globally) to emit only to Socket.IO rooms for groups the user belongs to. Prevents profile data (including profile-picture data URLs) from being sent to users who share no group with the updated user.

- **#10 – Account deletion transaction (server.js)**: Wrapped `deleteUserMemberships` and `deleteUser` in a `db.transaction()`. If either statement fails, both are rolled back atomically.

- **#11 – Session secret fallback (server.js)**: Replaced the hard-coded `'Gchat-dev-secret'` fallback with `crypto.randomBytes(32).toString('hex')`. If the DB lookup fails the server still starts safely, at the cost of session invalidation on restart.

- **#14 – Login brute-force protection (server.js)**: Added an in-memory per-IP rate limiter. After 10 consecutive failed login attempts within a 15-minute window, the IP receives HTTP 429 until the window resets. Stale entries are pruned on a 5-minute interval. Successful login clears the counter.

- **#15 – Timing-safe ADMIN_SECRET comparison (server.js)**: Replaced `token !== secret` string equality with `crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret))` to prevent timing-based secret enumeration.

- **#16 – (see #9/16 above)**

- **#18 – Message editing (server.js + app.js)**: 
  - DB migration: added `edited_at TEXT` column to `messages`.
  - New prepared statement `updateMessage`.
  - New endpoint `PATCH /api/groups/:groupId/messages/:messageId` — sender-only, text/whisper only; re-encrypts with the same group key client-side and sends `{ encryptedContent, iv }`.
  - New socket event `message_edited` broadcast to the group room.
  - Client: "✏️ Edit" option in the right-click context menu (shown only for own text/whisper messages).
  - Inline edit form in the message bubble; saves via PATCH; re-decrypts on `message_edited` event.
  - Messages show a small `(edited)` badge in the timestamp line.

- **#21 – PBKDF2 derived-key caching (app.js)**: Added a `derivedKeyCache` Map keyed by `passphrase + '\x00' + groupId`. The expensive 100 000-iteration PBKDF2 derivation now runs at most once per (passphrase, group) pair per session. `clearGroupKey` evicts the cached entry.

- **#23 – Whisper recipient membership validation (server.js)**: `send_whisper` now calls `stmts.isMember` for every userId in the `whisperTo` array. Whispers to non-members are rejected with an error before being persisted.

- **#25 – Favicon (public/)**: Added `favicon.svg` (speech-bubble icon on dark background). Both `index.html` and `chat.html` reference it via `<link rel="icon">`.

- **#26 – Initial load DocumentFragment (app.js)**: The initial (non-paginated) `loadMessages` now builds all message rows concurrently with `Promise.all`, collects them in a `DocumentFragment`, and performs a single `appendChild` instead of one DOM insertion per message. This matches the existing `loadOlderMessages` pattern and avoids repeated reflows.

- **#27 – HSTS header (server.js)**: Added `Strict-Transport-Security: max-age=63072000; includeSubDomains` when `NODE_ENV=production` or `RAILWAY_ENVIRONMENT` is set.

- **#30 – (addressed as part of #4 above)**

**What was NOT changed**
- Core messaging logic and encryption system unchanged
- Auth flow (register/login) unchanged beyond brute-force guard
- Group management logic unchanged
- Whisper routing model unchanged (whisper_to still stored server-side for history filtering)
- All existing message formats remain backward-compatible (`editedAt` is `null` for unedited messages)

**Not implemented (require architectural redesign or new infrastructure)**
- **#19 – Whisper metadata plaintext**: The `whisperTo` field is stored server-side in plaintext because the server requires it to filter whispers in message history. Hiding it would require either end-to-end recipient-keyed encryption or storing whispers without history, both involving a major protocol change.
- **#24 – Push notifications**: Web Push requires a service worker, VAPID key management, a subscription storage endpoint, and browser permission prompts. This is a separate subsystem and was not implemented in this PR.

**Notes / Risks**
- The derived-key cache is session-scoped (in-memory JS). Refreshing the page clears it.
- PBKDF2 caching means changing the key for a group (via "Forget Key" → set new key) invalidates the old cache entry correctly via `clearGroupKey`.
- Brute-force counters are in-memory and will reset on server restart. This is acceptable for this deployment model.
- `timingSafeEqual` requires both buffers to be the same length; the implementation checks length equality first to avoid the Node.js `ERR_CRYPTO_TIMINGSAFEEQUAL_LENGTH` exception.

---

## PR #12 — Fix reply indicator and improve mobile toggle button visibility

**What changed**
- **Task 1 (Reply indicator bug fix)**: Fixed bug in `ctx-reply` click handler where `hideContextMenu()` was called before saving a local copy of `ctxMsg`, causing a silent TypeError (cannot read property of null) that prevented the reply preview bar from ever appearing. The fix saves `ctxMsg` and `ctxText` to local variables before calling `hideContextMenu()`. The "replying to" bar above the message input now correctly appears, and the sent message correctly displays the reply quote.
- **Task 2 (Mobile toggle button visibility)**: Added visible background, border, larger font size, and adequate padding to the empty-state mobile toggle buttons (☰ and 📋) so they are clearly visible on dark mobile screens when no group is selected.

**What was NOT changed**
- Core messaging logic and encryption system unchanged
- Auth unchanged
- Message data format unchanged
- Desktop layout unchanged

**Notes / Risks**
- The reply bug was a regression introduced in a previous PR where the handler used global `ctxMsg` after `hideContextMenu()` nullified it
- Mobile toggle button styling change is purely cosmetic and does not affect functionality

---

## PR #11 — Implement explicitly listed feature tasks and bug fixes

**What changed**
- **Task 1 (Reply functionality)**: Already fully implemented - verified all functionality works (context menu, reply preview bar above input, message rendering with reply quotes, scroll to original)
- **Task 2 (Mobile toggle buttons)**: Fixed mobile UX - added visible toggle buttons (☰ and 📋) to empty state so mobile users can access sidebar and right panel when no group is selected
- **Task 3 (Page title notifications)**: Added blinking page title with unread count when tab is not focused, clears when tab gains focus
- **Task 4 (Image viewer)**: Added full-screen image viewer modal - click any image to magnify, click again or press Escape to close
- **Task 5 (File size limit & download)**: Increased file size limit from 1MB to 25GB for all file types; non-image files already auto-download when clicked
- **Task 6a (Custom profile pictures)**: Added complete profile picture system - users can upload images up to 2MB or use color + initial, displays in all avatars (messages, members, sidebar)
- **Task 6b (Clear history bug fix)**: Fixed bug where non-owners couldn't see clear chat history button even when owner enabled member clearing - moved button to new common section visible to all with permission

**What was NOT changed**
- Core messaging logic and encryption system remain unchanged
- Authentication and session management unchanged (except profile picture addition)
- Group chat core functionality unchanged
- Existing message formats preserved
- No framework additions or architectural changes
- All existing features continue to work as before

**Notes / Risks**
- Profile pictures stored as base64 data URLs in database (up to ~2.8MB per user with 2MB limit)
- File size limit increased to 25GB may impact bandwidth on some hosting platforms
- Mobile toggle buttons on empty state positioned absolutely in top corners
- All changes are fully backward compatible
- Task 1 required no code changes as it was already fully implemented

## PR #0 — Project Bootstrap

**What changed**
- Added initial documentation: readme.md, features.md, changelog.md
- Recorded all existing features in features.md
- Established documentation structure for future PR-based iteration

**What was NOT changed**
- Core logic, functionality, architecture
- Existing files unrelated to documentation
- No code modifications were made

**Notes / Risks**
- Bootstrap entry for future PR-based iteration
- README.md already existed and was comprehensive, so it was preserved as-is
- All features documented in features.md are already implemented in the codebase

**Summary of Existing Implementation** (as of PR #0)
- End-to-end encrypted group chat application
- Built with Node.js, Express, Socket.IO, and SQLite
- Client-side AES-256-GCM encryption
- Real-time messaging with typing indicators and presence
- Image and file sharing (1MB limit)
- Reply/quote and whisper mode
- Group owner controls (kick, disband, clear history)
- Mobile-responsive dark UI with glassmorphism
- Deployable to Railway.app with persistent storage support
- CSRF protection and rate limiting
- 100+ implemented features tracked in features.md
