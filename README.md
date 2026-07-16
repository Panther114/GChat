# Gchat

Gchat is a client-side encrypted group chat application built with Node.js, Express, Socket.IO, SQLite, and vanilla web technologies. It supports real-time group messaging, automatic per-group encryption, media/file messages, profile customization, group administration, and an optional Electron desktop wrapper.

The hosted web app is the primary product. The desktop app is a native shell that loads the hosted Railway deployment.

Current version: **v1.3.0**

---

## Features

### Messaging

- Real-time group chat via Socket.IO
- Group creation and joining through fragment-only secure invite links
- Client-side encrypted text, image, file, whisper, tagged, and disappearing-text messages
- Message replies, editing, deletion, and delivery/read indicators
- Typing indicators and online presence
- Client-side search and chat export (disappearing messages are excluded from exports)
- Image viewer and automatic image compression
- Emoji picker and mobile-responsive layout
- Installable hosted PWA for Android Chrome/Chromium and iPhone/iPad Safari home screen
- AI is disabled in Increment A; dormant backend modules are retained behind `AI_ENABLED`

### Accounts and Groups

- Username/password authentication with mandatory email verification
- Email verified once at registration (or on first login for legacy accounts); login/logout afterward uses only username and password
- bcrypt password hashing
- Custom profile color or profile picture
- Group owner controls:
  - rename group
  - kick members
  - disband group
  - clear chat history
  - configure member permissions
  - configure group color

### Desktop Shell

- Electron-based Windows desktop wrapper
- First-run setup wizard
- System tray support
- Native OS notifications
- Taskbar unread badge and taskbar flash
- Optional launch-at-startup
- Windows installer and portable executable builds

---

## Architecture

```txt
Browser / Electron shell
        |
        v
Hosted Gchat web app
        |
        v
Express + Socket.IO server
        |
        v
SQLite database
```

The Electron desktop app does not run the chat server locally. It loads the hosted deployment:

```txt
https://gchat.up.railway.app
```

Most product updates are delivered through the hosted web app. Native desktop updates are only needed when changing Electron-specific behavior such as tray controls, native notifications, setup screens, installer metadata, or app icons.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express |
| Real-time transport | Socket.IO |
| Database | SQLite via `better-sqlite3` |
| Sessions | `express-session` + bounded `better-sqlite3` store |
| Password hashing | bcrypt |
| Email delivery | Logto Cloud M2M API |
| Encryption | Web Crypto API, AES-256-GCM, HKDF-SHA-256 |
| Frontend | HTML, CSS, vanilla JavaScript |
| Desktop | Electron, Electron Builder |
| Hosting | Railway |

---

## Mobile install notes

- **Android**: GChat installs as a hosted PWA from Chrome/Chromium using the browser's **Install app** / **Add to Home screen** flow. Android is browser-managed here, so icon refreshes, notification support, and background behavior depend on the installed browser/WebAPK refresh cycle instead of a separate native APK in this repository.
- **iPhone / iPad**: GChat installs from Safari using **Share → Add to Home Screen**. iOS also requires the home-screen app to be launched from its icon before web push notifications can be enabled.

---

## Encryption Model

Gchat encrypts message content in the client before it is sent to the server.

1. The browser generates a random 256-bit group secret and stores it in IndexedDB.
2. Secure invite URL fragments carry the join code and secret; fragments are removed immediately, kept only in same-tab session storage across authentication, and never reach the server.
3. HKDF derives separate content, metadata, tag-index, and spam-signature keys.
4. AES-256-GCM binds content and encrypted metadata to the group, client message ID, sender, type, key version, and revision.
5. The server stores an HMAC of the join code, a key commitment, ciphertext, encrypted metadata, and keyed blind indexes—never the group secret.

The server does not receive plaintext message content.

Important limitations:

- Metadata such as usernames, group membership, timestamps, and message ownership is still visible to the server.
- Disappearing-message metadata, timers, and per-user hidden-state records are also visible to the server so the app can keep access state consistent across reloads.
- Repetitive-message and hashtag equality within a group are visible through group-keyed blind indexes.
- AI routes and active client controls are disabled by default in Increment A.
- This is application-layer encryption, not a replacement for audited secure messaging infrastructure.

---

## Environment Variables

| Variable | Required | Description |
|---|---:|---|
| `SESSION_SECRET` | Yes | Secret used to sign session cookies. Use a long random value in production. |
| `PORT` | No | Server port. Railway provides this automatically. |
| `DB_PATH` | Recommended | SQLite database path. Use `/data/Gchat.db` with a Railway volume for persistence. |
| `GROUP_CODE_PEPPER` | Recommended | At least 32 characters; used to HMAC normalized join codes. Falls back to the stable `SESSION_SECRET` during the v1.3.0 cutover. |
| `AI_ENABLED` | No | Reserved for a later release. v1.3.0 keeps AI disabled in code even if this variable is set. |
| `GCHAT_LOCAL_DEBUG` | No | Set to `1` only for the local `root/root` fixtures. |
| `ADMIN_SECRET` | Optional | Enables the admin users endpoint when set. |
| `OPENROUTER_API_KEY` | Optional | Enables the server-side Ask AI integration for DeepSeek V4 Flash. Keep this only in server/runtime environment variables such as Railway service variables. |
| `GETGOAPI_API_KEY` | Optional | Enables the server-side Ask AI integration for Grok 4.1 Fast through GetGoAPI. Keep this only in server/runtime environment variables such as Railway service variables. |

| `VAPID_PUBLIC_KEY` | Optional | Public VAPID key used by the hosted PWA to subscribe to Web Push notifications. |
| `VAPID_PRIVATE_KEY` | Optional | Private VAPID key used only on the server to send Web Push notifications. Never expose this to clients. |
| `VAPID_SUBJECT` | Optional | VAPID contact subject such as `mailto:admin@example.com` or an HTTPS URL. |

Production load is bounded to 100 groups per user, 250 members per group, 100 messages per page, and eight concurrent push deliveries. Chat data is loaded lazily when a group is opened; the client does not poll or preload every group.

### Increment A production cutover

Before deploying v1.3.0, mount the persistent Railway volume at `/data`, set `DB_PATH=/data/Gchat.db`, set a stable 32+ character `GROUP_CODE_PEPPER`, and leave `AI_ENABLED` unset or `0`. Back up the database, then run the explicit chat-only reset once:

```bash
CONFIRM_RESET=RESET_ALL_GCHAT_CHATS_FOR_INCREMENT_A DB_PATH=/data/Gchat.db npm run migrate:increment-a
```

The reset is transactional, creates a timestamped backup, deletes groups, memberships, messages, read/disappearing state, and AI usage events, and preserves `users`, settings, sessions, and push subscriptions.
| `LOGTO_ENDPOINT` | Optional* | Logto tenant URL for email verification (e.g. `https://your-tenant.logto.app`). |
| `LOGTO_M2M_APP_ID` | Optional* | App ID of a Logto M2M application with Management API `all` role. |
| `LOGTO_M2M_APP_SECRET` | Optional* | App Secret of the same Logto M2M application. |

\* If `LOGTO_ENDPOINT`, `LOGTO_M2M_APP_ID`, and `LOGTO_M2M_APP_SECRET` are all unset, verification emails will not be sent. In development mode a warning is logged; production deployments will reject verification requests. **Configure Logto for any production deployment.**

---

## Persistent Storage on Railway

Railway filesystem storage is ephemeral unless a volume is mounted. Without a volume, users, groups, messages, sessions, and SQLite configuration can be lost on redeploy.

Recommended Railway setup:

1. Create a Railway volume.
2. Mount it at:

```txt
/data
```

3. Set:

```txt
DB_PATH=/data/Gchat.db
```

This stores the SQLite database on persistent storage.

---

## Local Development

Install dependencies:

```bash
npm install --include=dev
```

The local-debug database is stored under `.gchat-local/` and is seeded with an
`Increment A Playground` chat. Sign in with username `root` and password `root`.
The account and fixture messages are enabled only when `GCHAT_LOCAL_DEBUG=1`;
they are not created by the production start command.

To start the isolated debug environment:

```bash
npm run dev:web
```

To start the regular local server without debug fixtures:

```bash
node server.js
```

Open:

```txt
http://localhost:3000
```

The main application pages are served from `public/`.

---

## Ask AI (temporarily disabled in v1.3.0)

Client controls are hidden, `/api/ai/*` returns 404, socket AI sends are rejected, group settings cannot enable AI, and the server reports `aiEnabled: false`. The notes below describe the dormant v1.2.4 implementation retained for a later reviewed release.

- Typing `/ai ` in the chat composer or clicking **Ask AI** in the right panel opens the same modal before the AI-tagged prompt is sent into chat.
- The modal defaults to:
  - Model: `DeepSeek V4 Flash`
  - Mode: `Context`
  - Tone: `Casual`
- Model options:
  - `DeepSeek V4 Flash` → `deepseek/deepseek-v4-flash`
  - `Grok 4.1 Fast` → `grok-4-1-fast-non-reasoning`
- Mode behavior:
  - `Fast` normally sends only the user prompt plus the selected system prompt.
  - `Context` can include eligible decrypted chat context, while still respecting `/ai` vs `/# tag /ai` scoping rules.
- Tone options map to built-in system prompts:
  - `Casual`
  - `Professional`
  - `Playful`
- `Search the web` is a manual toggle and defaults to OFF.
- When `Search the web` is ON, web search can be used in both `Fast` and `Context` mode.
- Web search works for `DeepSeek V4 Flash` through the server-side OpenRouter integration.
- `Grok 4.1 Fast` is routed through GetGoAPI.
- Submitted Ask AI prompts are tagged in chat with model/mode/tone labels such as `@deepseek-context-casual`, and the AI reply is posted when the background request completes.
- AI replies show the selected model, mode, tone, token count, and estimated RMB cost in the response metadata line.

---

## Railway Deployment

1. Create a Railway project from the GitHub repository.
2. Set the required environment variables.
3. Add a Railway volume if persistent storage is needed.
4. Set:

```txt
SESSION_SECRET=<long random secret>
DB_PATH=/data/Gchat.db
GROUP_CODE_PEPPER=<stable random secret of at least 32 characters>
AI_ENABLED=0
```

5. Deploy.

Railway uses `railway.json` for deployment. The server entry point is:

```bash
node server.js
```

The recommended healthcheck endpoint is:

```txt
/api/health
```

It verifies that the Express process is running and that SQLite is responding before Railway marks the deployment healthy.

For users in mainland China, deployment reliability recommendations:

- Prefer a Railway region closer to users (for example, Singapore) when available.
- Keep Socket.IO fallback transports enabled (`polling` + `websocket`) for unstable networks.
- Prefer a stable custom domain if access to `*.railway.app` is inconsistent on local networks.
- Validate connectivity using Wi-Fi, mobile hotspot, VPN off, and VPN on.

---

## Hosted PWA Installation

The hosted web app at `https://gchat.up.railway.app` can be installed as a free Progressive Web App without building native Android or iOS packages.

### Android (Chrome / Chromium)

1. Open `https://gchat.up.railway.app`.
2. Open the browser menu.
3. Tap **Install app** or **Add to Home screen**.
4. Confirm the install prompt.
5. Open GChat from the installed home screen or app icon.

### iPhone / iPad (Safari)

1. Open `https://gchat.up.railway.app` in Safari.
2. Tap the **Share** button.
3. Tap **Add to Home Screen**.
4. Optionally rename `GChat`.
5. Tap **Add**.
6. Open GChat from the Home Screen icon.

### Notification setup

1. Install and open the GChat PWA from its icon.
2. Sign in.
3. Keep **Remember Me** enabled so the installed PWA keeps a native-app-like signed-in session.
4. Open the **Profile** panel.
5. Tap **Enable notifications**.
6. Allow the system permission prompt.
7. To disable notifications later, return to the same Profile section and tap **Disable notifications**.

### Platform limitations

- iPhone and iPad push notifications require the Home Screen web app on supported iOS/iPadOS versions.
- Android notification support depends on browser and installed PWA support.
- Notification sound is controlled by the operating system, mute switch, Focus / Do Not Disturb, and notification settings.
- App icon badge support varies by browser and platform. GChat still works when the Badging API is unavailable.
- Notification payloads are privacy-preserving and generic. They do not contain decrypted message content, sender names, or group names.
- GChat keeps form controls at 16px or larger on mobile to avoid iOS input auto-zoom and does not force `user-scalable=no` by default to preserve accessibility zoom.

### VAPID key generation

Generate VAPID keys before enabling Web Push on the server:

```bash
npx web-push generate-vapid-keys
```

Then set:

```txt
VAPID_PUBLIC_KEY=<public key>
VAPID_PRIVATE_KEY=<private key>
VAPID_SUBJECT=mailto:admin@example.com
```

### Update behavior

- Normal product updates still deploy through Railway.
- Installed users do not need to reinstall after normal web app updates.
- When online, the PWA fetches the newest hosted version on refresh or reopen.
- When offline, a cached fallback page is available until connectivity returns.

---

## Scaling Limits of the Current Architecture

The current hosted app is designed for a single Node.js instance with local SQLite storage.

That is acceptable for a small MVP, but it is **not** globally scalable yet. Multi-instance or multi-region deployment would require:

- a shared database such as PostgreSQL instead of local SQLite
- a Socket.IO adapter such as Redis so events and presence are shared across instances
- sticky sessions or a WebSocket-only deployment strategy for consistent realtime connections
- a shared session store instead of per-node local session files
- object storage for encrypted attachments instead of storing large blobs in SQLite

---

## Admin Endpoint

If `ADMIN_SECRET` is configured, the server exposes an admin endpoint for listing registered users:

```bash
curl https://<deployment-url>/api/admin/users \
  -H "Authorization: Bearer <ADMIN_SECRET>"
```

Example response:

```json
[
  {
    "id": "uuid",
    "username": "alice",
    "iconColor": "#4A90D9",
    "createdAt": "2024-01-01 00:00:00"
  }
]
```

Password hashes are not returned.

---

## Desktop App

The desktop app is an Electron wrapper around the hosted Gchat web app. It is intended for users who want a native Windows-style app experience without opening a browser manually.

### User Installation

Download and run:

```txt
Gchat Setup <version>.exe
```

For portable use, run:

```txt
Gchat <version>.exe
```

Users do not need Node.js, npm, Git, PowerShell, or Visual Studio Build Tools.

### Updating the Desktop App

Most Gchat updates are web/server updates and are delivered through the hosted Railway deployment. Users may only need to reload or restart the desktop app to see the latest web version.

A new desktop installer is only needed when Electron-specific behavior changes, such as:

- setup wizard
- tray menu
- native notifications
- launch-at-startup
- offline/recovery screen
- installer configuration
- application icon
- packaged dependency changes

Current practical update flow:

```txt
Quit Gchat from the system tray
Run the newer Gchat Setup <version>.exe
Install over the existing app
Launch Gchat again
```

Manual uninstall is usually not required.

### Building the Desktop App

Use Node 20 for Windows packaging.

```bash
npm install --include=dev
npm run build:win
```

Output:

```txt
dist/Gchat Setup <version>.exe
dist/Gchat <version>.exe
```

The GitHub Actions workflow can also build the Windows installer and upload it as an artifact.

---

## Desktop Build Notes

The repository contains both the web server and the desktop wrapper. The desktop build excludes unused backend runtime modules from the packaged Electron app and disables native dependency rebuilds during Electron packaging.

Relevant Electron Builder behavior:

- `npmRebuild` is disabled for desktop packaging.
- Backend modules such as SQLite server dependencies are not needed inside the Electron shell.
- Railway still installs production server dependencies and runs `server.js`.

---

## Project Structure

```txt
/
├── server.js                    # Express + Socket.IO backend
├── package.json                 # Server and desktop package configuration
├── railway.json                 # Railway deployment configuration
├── README.md                    # Project documentation
├── INSTALL_DESKTOP.md           # Desktop installation notes
├── electron/
│   ├── main.js                  # Electron main process
│   ├── preload.js               # Secure IPC bridge
│   ├── wizard.html              # First-run desktop setup
│   ├── offline.html             # Desktop connection recovery page
│   └── desktop.css              # Desktop setup/recovery styling
├── build/
│   └── icon.ico                 # Generated desktop icon artifact
└── public/
    ├── index.html               # Sign-in/sign-up page
    ├── chat.html                # Main chat UI
    ├── app.js                   # Client-side application logic
    ├── manifest.json            # Hosted PWA manifest
    ├── service-worker.js        # Hosted PWA offline/update handling
    ├── style.css                # Web UI styling
    ├── gchat_icon.png           # App icon asset
    └── promo.html               # Static promotional page
```

---

## Security Notes

- Passwords are hashed with bcrypt.
- Sessions are signed with `SESSION_SECRET`.
- Production cookies use secure settings when deployed behind HTTPS.
- SQLite database files should not be committed.
- The server stores encrypted message payloads, not plaintext message content.
- Group keys are client-managed and cannot be recovered by the server.
- The browser never calls AI providers directly; Ask AI requests are proxied through `server.js` with `OPENROUTER_API_KEY` and `GETGOAPI_API_KEY` kept server-side.
- Large file handling should be reviewed carefully before public-scale deployment.

---

## Operational Checklist

Before using Gchat with real users:

- Set `SESSION_SECRET`.
- Mount a Railway volume.
- Set `DB_PATH=/data/Gchat.db`.
- Set `OPENROUTER_API_KEY` for DeepSeek Ask AI access.
- Set `GETGOAPI_API_KEY` for Grok Ask AI access.
- Confirm login, group creation, message sending, and file upload behavior.
- Test the desktop installer on a clean Windows machine.
- Verify notification behavior in Windows settings.
- Keep database backups if the app is used seriously.
