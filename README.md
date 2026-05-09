# Gchat

Gchat is a client-side encrypted group chat application built with Node.js, Express, Socket.IO, SQLite, and vanilla web technologies. It supports real-time group messaging, per-group encryption keys, media/file messages, profile customization, group administration, and an optional Electron desktop wrapper.

The hosted web app is the primary product. The desktop app is a native shell that loads the hosted Railway deployment.

---

## Features

### Messaging

- Real-time group chat via Socket.IO
- Group creation and joining through shareable group codes
- Client-side encrypted text, image, file, whisper, tagged, and disappearing-text messages
- Message replies, editing, deletion, and delivery/read indicators
- Typing indicators and online presence
- Client-side search and chat export (disappearing messages are excluded from exports)
- Image viewer and automatic image compression
- Emoji picker and mobile-responsive layout

### Accounts and Groups

- Username/password authentication
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
| Sessions | `express-session` + `connect-sqlite3` |
| Password hashing | bcrypt |
| Encryption | Web Crypto API, AES-GCM, PBKDF2 |
| Frontend | HTML, CSS, vanilla JavaScript |
| Desktop | Electron, Electron Builder |
| Hosting | Railway |

---

## Encryption Model

Gchat encrypts message content in the client before it is sent to the server.

1. A user sets a per-group passphrase.
2. The client derives a symmetric key using PBKDF2 with SHA-256.
3. Message content is encrypted with AES-GCM.
4. The server stores only encrypted content and IV values.
5. Users with the same group key can decrypt messages locally.
6. Users without the key see undecryptable placeholder text.

The server does not receive plaintext message content or group keys.

Important limitations:

- Group keys are user-managed.
- Lost group keys cannot be recovered by the server.
- Metadata such as usernames, group membership, timestamps, and message ownership is still visible to the server.
- Disappearing-message metadata, timers, and per-user hidden-state records are also visible to the server so the app can keep access state consistent across reloads.
- Short repeated-message spam detection hashes normalized short messages server-side, which can reveal when two short messages are identical even though the server still does not receive plaintext.
- If a user explicitly uses the Grok assistant, the selected chat context is decrypted in the browser and sent to the Gchat server only for that one OpenRouter request.
- This is application-layer encryption, not a replacement for audited secure messaging infrastructure.

---

## Environment Variables

| Variable | Required | Description |
|---|---:|---|
| `SESSION_SECRET` | Yes | Secret used to sign session cookies. Use a long random value in production. |
| `PORT` | No | Server port. Railway provides this automatically. |
| `DB_PATH` | Recommended | SQLite database path. Use `/data/Gchat.db` with a Railway volume for persistence. |
| `ADMIN_SECRET` | Optional | Enables the admin users endpoint when set. |
| `OPENROUTER_API_KEY` | Optional | Enables the server-side Grok 4.3 integration. Keep this only in server/runtime environment variables such as Railway service variables. |
| `OPENROUTER_MODEL` | No | Optional OpenRouter model override. Defaults to `x-ai/grok-4.3`. |

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

Start the local server:

```bash
node server.js
```

Open:

```txt
http://localhost:3000
```

The main application pages are served from `public/`.

---

## Railway Deployment

1. Create a Railway project from the GitHub repository.
2. Set the required environment variables.
3. Add a Railway volume if persistent storage is needed.
4. Set:

```txt
SESSION_SECRET=<long random secret>
DB_PATH=/data/Gchat.db
OPENROUTER_API_KEY=<openrouter api key>
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
│   └── icon.ico                 # Windows desktop icon
└── public/
    ├── index.html               # Sign-in/sign-up page
    ├── chat.html                # Main chat UI
    ├── app.js                   # Client-side application logic
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
- The browser never calls OpenRouter directly; Grok requests are proxied through `server.js` with `OPENROUTER_API_KEY` kept server-side.
- Large file handling should be reviewed carefully before public-scale deployment.

---

## Operational Checklist

Before using Gchat with real users:

- Set `SESSION_SECRET`.
- Mount a Railway volume.
- Set `DB_PATH=/data/Gchat.db`.
- Set `OPENROUTER_API_KEY` if Grok 4.3 should be available.
- Confirm login, group creation, message sending, and file upload behavior.
- Test the desktop installer on a clean Windows machine.
- Verify notification behavior in Windows settings.
- Keep database backups if the app is used seriously.
