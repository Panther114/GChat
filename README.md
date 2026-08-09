# Gchat

Gchat is a client-side encrypted group chat application built with Node.js, Express, Socket.IO, SQLite, and vanilla web technologies. It supports real-time group messaging, automatic per-group encryption with server-managed key recovery, media/file messages, profile customization, group administration, and an optional memory-optimized Tauri desktop shell.

The hosted web app is the primary product. The desktop app is a native system-webview shell that loads the hosted Railway deployment.

Current version: **v1.3.12** (Windows: thin WebView2 shell; macOS: Tauri/WKWebView)

---

## Features

### Messaging

- Real-time group chat via Socket.IO
- Group creation and joining through permanent six-character invite codes
- Client-side encrypted text, image, file, whisper, tagged, and disappearing-text messages
- Message replies, editing, deletion, and delivery/read indicators
- Typing indicators and online presence
- Client-side search and chat export (disappearing messages are excluded from exports)
- Image viewer and automatic image compression
- Emoji picker and mobile-responsive layout
- Installable hosted PWA for Android Chrome/Chromium and iPhone/iPad Safari home screen
- v1.4 Ask-AI agent: a tool-using DeepSeek V4 Flash assistant that can read channel history inside the current chat (enabled with `AI_ENABLED=1`)

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

- **Windows:** thin non-Tauri WebView2 host (`src-desktop-win`) with tray SPA suspend for lower idle RAM
- **macOS:** Tauri 2 / WKWebView fallback
- Hosted UI shared exactly with the browser version
- System tray support (hide on close/minimize; Windows unloads SPA while hidden)
- Native OS notifications, badges, optional launch-at-startup
- In-app Settings update check
- No bundled Chromium in production packages

### App owner account ("Furina")

The hosted deployment has a designated app-owner account with the username **Furina**. It is the operator's personal account: it already exists, it is actively used, and it will not be deleted. The owner account is the only one with global-moderation powers — clearing GChat Global history/channels and managing user accounts — so those powers are reserved to the operator by design and are not available to other members.

---

## Architecture

```txt
Browser / Tauri shell
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

The Tauri desktop app does not run the chat server locally. It loads the hosted deployment:

```txt
https://gchat.up.railway.app
```

Most product updates are delivered through the hosted web app. Native desktop updates are only needed when changing tray controls, notifications, installer metadata, or other shell behavior.

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
| Desktop | Windows thin wry/WebView2; macOS Tauri/WKWebView |
| Hosting | Railway |

---

## Mobile install notes

- **Android**: GChat installs as a hosted PWA from Chrome/Chromium using the browser's **Install app** / **Add to Home screen** flow. Android is browser-managed here, so icon refreshes, notification support, and background behavior depend on the installed browser/WebAPK refresh cycle instead of a separate native APK in this repository.
- **iPhone / iPad**: GChat installs from Safari using **Share → Add to Home Screen**. iOS also requires the home-screen app to be launched from its icon before web push notifications can be enabled.

---

## Encryption Model

Gchat encrypts message content in the client before it is sent to the server.

1. The browser generates a random 256-bit group secret and stores it in IndexedDB. A new device receives that key only through a secure invitation link.
2. Invite codes are six lowercase alphanumeric characters. After an authenticated code join succeeds, the server releases the group's escrowed key material over TLS so the member can decrypt the group.
3. HKDF derives separate content, metadata, tag-index, and spam-signature keys.
4. AES-256-GCM binds content and encrypted metadata to the group, client message ID, sender, type, key version, and revision.
5. The server stores an HMAC of the join code, a key commitment, message ciphertext, encrypted metadata, keyed blind indexes, and an AES-256-GCM encrypted group-key escrow record protected by `GROUP_KEY_ESCROW_MASTER_KEY`.

The server does not receive plaintext message content, but it can recover group secrets from escrow. An authenticated member on a new device receives its group material over TLS and can decrypt existing history immediately. This is not zero-knowledge or end-to-end encryption against the server operator.

Important limitations:

- Metadata such as usernames, group membership, timestamps, and message ownership is still visible to the server.
- Disappearing-message metadata, timers, and per-user hidden-state records are also visible to the server so the app can keep access state consistent across reloads.
- Repetitive-message and hashtag equality within a group are visible through group-keyed blind indexes.
- **Client-side caching**: to make history load instantly, the app caches *decrypted* message text and metadata in the browser's local storage (IndexedDB/localStorage) — the same trust domain as the group keys themselves. This data never leaves the device; the server still only ever receives ciphertext.
- AI routes and active client controls are disabled by default in Increment A.
- This is application-layer encryption, not a replacement for audited secure messaging infrastructure.

---

## Environment Variables

| Variable | Required | Description |
|---|---:|---|
| `SESSION_SECRET` | Yes | Secret used to sign session cookies. Use a long random value in production. |
| `PORT` | No | Server port. Railway provides this automatically. |
| `DB_PATH` | Recommended | SQLite database path. Use `/data/gchat.db` with a Railway volume for persistence. |
| `GROUP_CODE_PEPPER` | Recommended | At least 32 characters; used to HMAC normalized join codes. Falls back to the stable `SESSION_SECRET` during the v1.3.0 cutover. |
| `GROUP_KEY_ESCROW_MASTER_KEY` | Yes | Canonical base64url-encoded 32-byte server-only key that encrypts group secrets and join codes at rest. Store it only in deployment secrets. |
| `AI_ENABLED` | No | Set to `1` to enable the v1.4 Ask-AI agent. Without it all `/api/ai/*` routes return 404 and AI sends are rejected. |
| `GCHAT_LOCAL_DEBUG` | No | Set to `1` only for the local `root/root` fixtures. |
| `ADMIN_SECRET` | Optional | Enables the admin users endpoint when set. |
| `OPENCODE_ZEN_API_KEY` | Optional | Primary Ask-AI provider key (OpenCode Go subscription; the env name predates Go). Enables the v1.4 agent for DeepSeek V4 Flash via `https://opencode.ai/zen/go/v1/chat/completions`. |
| `DEEPSEEK_API_KEY` | Optional | Fallback Ask-AI provider key (official DeepSeek API) used automatically when the Zen key is missing or fails. |

| `VAPID_PUBLIC_KEY` | Optional | Public VAPID key used by the hosted PWA to subscribe to Web Push notifications. |
| `VAPID_PRIVATE_KEY` | Optional | Private VAPID key used only on the server to send Web Push notifications. Never expose this to clients. |
| `VAPID_SUBJECT` | Optional | VAPID contact subject such as `mailto:admin@example.com` or an HTTPS URL. |

Production load is bounded to 100 groups per user, 250 members per group, 100 messages per page, and eight concurrent push deliveries. Chat data is loaded lazily when a group is opened; the client does not poll or preload every group.

### Increment A deployment safety

Mount the persistent Railway volume at `/data`, set `DB_PATH=/data/gchat.db`, set a stable 32+ character `GROUP_CODE_PEPPER`, configure a random `GROUP_KEY_ESCROW_MASTER_KEY`, and leave `AI_ENABLED` unset or `0`. Normal server startup runs no database reset or destructive migration.
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
DB_PATH=/data/gchat.db
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

## Ask AI (v1.4 agent)

The Ask-AI agent is a single-model, tool-using assistant built on **DeepSeek V4 Flash** (Grok/GetGoAPI were removed in v1.4). Requests are proxied server-side through **OpenCode Go** (`OPENCODE_ZEN_API_KEY`, the OpenCode subscription key), falling back to the official **DeepSeek API** (`DEEPSEEK_API_KEY`) automatically — the fallback fires on any provider failure, so a broken primary key never blocks the agent.

- **Entry point**: the AI tool-button next to the attach button. Clicking it *arms* the composer (highlighted button + `AI` token chip); the **next message you send goes to the AI agent** in the channel you are in. No modal, no slash commands.
- The agent **decides for itself** whether it needs context:
  - No history needed → answers immediately (cheapest path).
  - Question references the conversation → it calls `get_channel_history` (and can paginate older messages with the `before` cursor).
  - Question references another channel of the same chat → it calls `get_channel_list` and reads that channel.
  - It can **never** read other chats — the tool surface is scoped to the current chat group.
- **Tools execute in the browser**: message content is E2E-encrypted, so only the client holds the keys. The server relays tool calls, the client runs them against its decrypted cache (IndexedDB + memory), and the loop continues until the agent answers. The loop is bounded: max 4 tool rounds, 40 messages / 24 KB per history fetch, 96 KB total transcript.
- The AI reply is posted as a normal E2E-encrypted message in the same channel, stamped with `ai_meta` (model, tone, tokens, cost, and tool-call stats). Prompts are tagged `@deepseek-agent-<tone>`.
- **Tone** (Casual / Professional / Playful) is chosen in the profile panel.
- Daily token quotas still apply per user (default 20,000) and globally (default 200,000), resetting at 4:00 AM Shanghai time; every agent round is billed toward the quota.
- Enable with `AI_ENABLED=1`; the per-group `ai_enabled` setting controls it per chat.

---

## Railway Deployment

1. Create a Railway project from the GitHub repository.
2. Set the required environment variables.
3. Add a Railway volume if persistent storage is needed.
4. Set:

```txt
SESSION_SECRET=<long random secret>
DB_PATH=/data/gchat.db
GROUP_CODE_PEPPER=<stable random secret of at least 32 characters>
GROUP_KEY_ESCROW_MASTER_KEY=<random canonical base64url 32-byte secret>
AI_ENABLED=1
OPENCODE_ZEN_API_KEY=<OpenCode Go subscription API key>
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
- Notification payloads: notifications shown while the app is open or backgrounded include the sender and a short preview of the (client-decrypted) message. Server-delivered web push (app fully closed) is privacy-preserving and includes only the sender and group name — never decrypted message content, because the server cannot decrypt E2E content.
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

The desktop app is a memory-optimized Tauri shell around the hosted Gchat web app. It provides the same hosted interface and functions on Windows and macOS without bundling Chromium.

### User Installation

Windows users download and run:

```txt
Gchat_<version>_x64-setup.exe
```

macOS users download:

```txt
Gchat_<version>_*.dmg
```

The macOS package runs on Apple Silicon and Intel Macs. Users do not need Node.js, npm, Git, PowerShell, or build tools.

### Updating the Desktop App

Most Gchat updates are web/server updates and are delivered through the hosted Railway deployment. Users may only need to reload or restart the desktop app to see the latest web version.

A new desktop installer is only needed when native shell behavior changes, such as:

- tray menu
- native notifications
- launch-at-startup
- offline/recovery screen
- installer configuration
- application icon
- packaged dependency changes

Tauri builds check the newest GitHub Release through signed `latest.json` metadata. Settings → Updates provides a manual check-for-updates UI. Users moving from an Electron release install the newest Tauri package and sign in once.

### Building the Desktop App

Use Node 20+ and the stable Rust toolchain. Run each target build on its native operating system.

```bash
npm install --include=dev
npm run build:win
```

On macOS:

```bash
npm install --include=dev
npm run build:mac
```

Pushing a version tag builds Windows and universal macOS packages in parallel and publishes all installers and updater metadata to the same GitHub Release.

---

## Desktop Build Notes

The desktop package contains only a compiled native shell and small recovery assets. Windows uses the shared Evergreen WebView2 runtime with memory-oriented browser flags; macOS uses the system WKWebView. Backend modules and the hosted frontend are not packaged. Railway continues to install production server dependencies and run `server.js`.

---

## Project Structure

```txt
/
├── server.js                    # Express + Socket.IO backend
├── package.json                 # Server and desktop package configuration
├── railway.json                 # Railway deployment configuration
├── README.md                    # Project documentation
├── INSTALL_DESKTOP.md           # Desktop installation notes
├── src-tauri/
│   ├── src/lib.rs               # Native shell, memory flags, bounded command bridge
│   ├── src/bridge.js            # Hosted UI compatibility bridge
│   ├── capabilities/            # Exact-origin native permissions
│   └── tauri.conf.json          # Packaging and signed updater configuration
├── scripts/
│   └── regenerate-icons.py      # Navy desktop icon source for tray/installer
└── public/
    ├── index.html               # Sign-in/sign-up page
    ├── chat.html                # Main chat UI
    ├── app.js                   # Client-side application logic
    ├── manifest.json            # Hosted PWA manifest
    ├── service-worker.js        # Hosted PWA offline/update handling
    ├── style.css                # Web UI styling
    ├── gchat_icon.png           # Web brand icon (dark UI)
    └── promo.html               # Static promotional page
```

---

## Security Notes

- Passwords are hashed with bcrypt.
- Sessions are signed with `SESSION_SECRET`.
- Production cookies use secure settings when deployed behind HTTPS.
- SQLite database files should not be committed.
- The server stores encrypted message payloads, not plaintext message content.
- Group secrets and invite codes are escrowed server-side under `GROUP_KEY_ESCROW_MASTER_KEY` so authenticated members can recover them on new devices. Run `npm run migrate:group-invite-codes` only after a verified backup; production runs additionally require `GCHAT_GROUP_CODE_MIGRATION_APPROVED=1`.
- The browser never calls AI providers directly; Ask AI requests are proxied through `server.js` with `OPENCODE_ZEN_API_KEY` (and the `DEEPSEEK_API_KEY` fallback) kept server-side.
- Large file handling should be reviewed carefully before public-scale deployment.

---

## Operational Checklist

Before using Gchat with real users:

- Set `SESSION_SECRET`.
- Mount a Railway volume.
- Set `DB_PATH=/data/gchat.db`.
- Set a stable `GROUP_CODE_PEPPER`, or verify the `SESSION_SECRET` fallback before issuing invitation links.
- Set `AI_ENABLED=1` plus `OPENCODE_ZEN_API_KEY` (and optionally `DEEPSEEK_API_KEY`) to run the Ask-AI agent; keep AI off unless provider keys and product policy explicitly enable it.
- Confirm login, invitation-link joining, message sending, and file upload behavior.
- Test the desktop installer on a clean Windows machine.
- Verify notification behavior in Windows settings.
- Keep database backups if the app is used seriously.

### One-time pre-escrow group reset

Groups created before server-managed escrow cannot be recovered without their browser-only keys. This release intentionally removes those legacy groups instead of attempting to re-encrypt their history. After deploying the escrow-enabled code and confirming a verified database backup, stop the application and run the explicit offline maintenance command against the same database:

```powershell
$env:DB_PATH = '/data/gchat.db'
$env:BACKUP_CONFIRMED = '1'
$env:CONFIRM_LEGACY_GROUP_PURGE = 'DELETE_PRE_ESCROW_GROUPS'
npm run purge:pre-escrow-groups
```

The command deletes only groups without a complete escrow record, plus their messages, memberships, read/disappearing state, and AI usage records. It never runs during normal server startup.
