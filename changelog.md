# Gchat Changelog

This document tracks all changes to the Gchat project in a PR-based format.

---

## v1.3.4

- Replaced invite links with permanent six-character invite codes, code-only joining, encrypted server-side key recovery, and an explicit backup-confirmed migration command for existing groups.
- Made received disappearing messages indistinguishable from ordinary messages, retained sender-only indicators, and repaired message-series headers after disappearance.
- Improved group previews, composer modes, reply/disappearing metadata spacing, panel transitions, and desktop sidebar-width startup behavior.
- Made light mode the first-run default and synchronized theme preference between auth and chat views.
- Refined the mobile chat list, full-width Group Details panel, compact plus menu, and five-action bottom navigation.

## v1.3.2

- Historical v1.3.2 desktop/web release: restored group message keys and invite-link data across authenticated sessions through bounded, encrypted-at-rest device recovery. The current invite-only follow-up is listed under Unreleased above.
- Fixed v2 chat export to use the active v2 decryptor and removed encryption-state placeholders from visible messages and previews.
- Made Invite Link and Group Color equal-width right-panel actions, with the color popup available from the visible Group Color button.
- Ensured desktop native notifications appear for every incoming message, including messages in the active group.
- Reduced the Windows installer payload by packaging only the English Electron locale.

## v1.3.0

- Reworked Gchat Desktop into a direct, persistent Electron wrapper for the hosted production web app: no first-run wizard, shared hosted feature set, and fast return to the saved authenticated session.
- Replaced the interactive installer/portable pair with a lightweight one-click per-user NSIS installer that launches Gchat when installation completes.
- Reduced desktop package surface by removing the onboarding UI and `electron-store`; production installers now build into the tracked `release/` folder with maximum compression and updater metadata.

- Added an isolated web-debug environment on port `4400` with a `root/root` local account and encrypted offline chat fixtures.
- Started the `Increment-A` web-optimization cycle and bumped the application version to **1.3.0**.
- Added server-blind encryption v2 with IndexedDB key storage, HKDF-separated keys, authenticated metadata, secure invite fragments, HMAC join codes, and blind indexes.
- Added author-only optimistic message editing/deletion, Discord-inspired left-aligned message series, System/Dark/Light themes, modular esbuild sources, and AI-off feature gating.
- Added Node, integration, crypto, and Playwright tests plus a Node 22 verification workflow and a zero-finding production dependency audit.
- Preserved secure invite fragments across unauthenticated login and registration so hosted invitation links complete the join flow.
- Bounded hosted-server work to 100 groups per user, 250 members per group, 100 messages per page, and eight concurrent push deliveries; removed eager all-group client preloading.

---

## v1.2.4

- Forced the hosted PWA to use freshly versioned mobile icon assets so updated home-screen installs pick up the current branding on iOS and Android.
- Expanded the in-app refresh/reset flow so it clears local site data more completely while preserving saved group keys, local user settings, and the active login session.
- Fixed unread-count desyncs by filtering whispers consistently for the current user in both backend message queries and client-side unread calculations.
- Bumped the app version to **1.2.4** and documented the Android/iOS install behavior for the hosted mobile app.

---

## v1.1.4

- Added a manual `Search the web` toggle to the Ask AI modal for both DeepSeek V4 Flash and Grok 4.3 in both Fast and Context mode.
- Kept Fast mode context-free, preserved existing Context-mode chat scoping, and added server-side OpenRouter web-search tools plus prompt privacy guidance only when the toggle is enabled.
- Extended Ask AI metadata/rendering so messages can show when web search was enabled and how many web searches were used when OpenRouter reports it.
- Updated Ask AI documentation and bumped the app version to **1.1.4**.

---

## v1.1.3

- Replaced the plain `@AI` composer/message tag with model-mode-tone tags like `@grok-fast-playful` without changing the existing AI request logic.
- Renamed the visible Ask AI `Thinking` mode label to `Context` across the modal and chat metadata.
- Changed Ask AI chat submits to send the user's AI prompt immediately, close the modal, and post the AI reply later when the background request finishes.
- Added model-aware AI avatars so DeepSeek replies use the new `deepseek.webp` icon while Grok replies keep the Grok icon.
- Tightened the user list layout and right-panel action icon sizing, and fixed the User List button to show an icon in the left sidebar.
- Bumped the app version to **1.1.3**.

---

## v1.1.2

- Added the new Ask AI modal flow for both `/ai ` and the right-panel Ask AI button.
- Added model selection for `DeepSeek V4 Flash` and `Grok 4.3`, plus Fast/Thinking mode and Casual/Professional/Playful tone controls.
- Updated the OpenRouter request payload so Fast mode skips chat context while Thinking mode keeps existing tag-aware context rules.
- Added richer AI metadata with model, mode, tone, token totals, and estimated RMB cost display.
- Replaced Ask Grok labels with Ask AI labels across the UI.
- Removed lingering successful attachment upload placeholders without requiring a refresh.
- Bumped the app version to **1.1.2**.

---

## PR — Composer repair after v1.0.4

**What was broken**

- The v1.0.4 composer refactor left the bottom message bar in a broken state: the new token/menu wrapper could collapse the textarea width, the slash-command menu could be clipped, and the composer no longer behaved like a stable chat input bar.
- Slash suggestions were also too eager because the menu appeared for any leading slash text, even when the input did not match a supported command prefix.

**Root cause**

- The new `#message-composer-shell` was added inside the existing `.message-input-bar`, but the parent bar still used `overflow: hidden` while the slash menu was absolutely positioned above the shell. That caused the slash UI to be clipped by its parent container.
- The shell also switched the textarea area to a wrapping row layout without giving the token strip and textarea stable full-width behavior, so the token strip and textarea could fight over horizontal space instead of stacking cleanly.

**What was fixed**

- Changed the composer shell to a vertical layout so the token strip sits above the textarea instead of competing with it for width.
- Restored stable textarea sizing by giving the textarea and token strip full-width behavior inside the shell.
- Allowed the composer container to overflow visibly so the slash-command menu can open above the input instead of being clipped.
- Tightened slash-menu visibility so it only appears when the first character is `/` and the current prefix still matches a supported command (`/`, `/w`, `/#`, `/d`).

**What was NOT changed**

- Normal message encryption, send routing, uploads, read receipts, edits, deletes, group switching, local cache behavior, and Electron packaging were not redesigned.
- The v1.0.4 command/message model was left in place; this repair only stabilizes the composer layout and the slash-menu trigger behavior.

**Manual test notes**

- Verified JavaScript syntax with `node --check public/app.js` and `node --check server.js`.
- Verified the existing build path with `npm run build:linux -- --publish never`.
- Manually reasoned through the repaired composer flow for normal typing, Enter vs Shift+Enter, slash-menu visibility, whisper/tag token display, and attachment uploads sharing the same composer state.

---

## PR — Disappearing text messages

**What changed**

- Added lowercase `/d` disappearing text messages, including send-time parsing for:
  - `/d message`
  - `/# topic /d message`
  - `/w username /d message`
- Added backend message metadata for disappearing messages plus per-user disappearance state so expired receiver copies stay hidden across refresh, reconnect, group switching, and tag filtering.
- Reused the existing viewport/read-observer flow so receiver timers start only after a disappearing message enters the focused viewport.
- Added receiver-specific disappearance timers with persisted start/expiry state and local hidden-state persistence to prevent expired messages from reappearing from cached UI state.
- Added red disappearing-message styling with a red outline, temporary glow, and clear disappearing label.
- Preserved sender visibility for disappearing messages while keeping receiver expiration independent per user.
- Extended uploads so tagged image/file messages continue to work when a hashtag token or active tag filter is present.
- Excluded disappearing messages from chat export.
- Added a slash-menu shortcut entry for `/d`.

**What was NOT changed**

- No disappearing behavior was added to images, files, profile pictures, wallpapers, or other attachments.
- Whisper routing rules remain text-only; attachments were not upgraded to support whisper delivery.
- Core encryption, group membership, delivery ticks, read receipts, local settings, and Electron wrapper behavior were not redesigned.

**Notes / Risks**

- Disappearing-message duration is computed client-side from plaintext length, then stored as encrypted-message metadata so reloads can resume the same expiry window.
- Disappearing messages are intentionally omitted from local message cache snapshots to avoid stale local cache entries resurrecting expired messages before a fresh fetch.
- Tags and whispers are now rejected together for text sends and tagged uploads to avoid ambiguous mixed-command behavior.

**Manual test checklist**

- [ ] `/d hello` sends a disappearing text message
- [ ] lowercase `/d` works
- [ ] uppercase `/D` does not activate disappearing behavior
- [ ] sender sees the message with red outline/glow and it does not disappear for sender
- [ ] receiver timer starts only after the message enters the focused viewport
- [ ] longer disappearing messages remain visible longer than short ones
- [ ] receiver loses access after the timer completes
- [ ] expired disappearing messages do not reappear after refresh/reload/reconnect
- [ ] different receivers lose access independently
- [ ] disappearing messages are excluded from export
- [ ] `/# games /d hello` works as a tagged disappearing message
- [ ] `/w Gavin /d hello` works as a whisper disappearing message
- [ ] `/# games /w Gavin hello` is rejected cleanly
- [ ] `/w Gavin /# games hello` is rejected cleanly
- [ ] tagged image uploads still work
- [ ] tagged file uploads still work
- [ ] image/file uploads cannot become disappearing messages
- [ ] existing whisper behavior is preserved
- [ ] existing tag-filter behavior is preserved
- [ ] normal messages still work

---

## v1.0.4

- Removed the one-character message block while keeping the short-message anti-spam checks in place.
- Added a slash-command menu with `/w` whisper tokenization and `/#` hashtag tokenization in the chat composer.
- Added hashtag chips on sent messages plus top-bar tag filters that can auto-apply the active tag to new messages.
- Bumped the app version to **1.0.4**.

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
