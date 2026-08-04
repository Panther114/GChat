# gchat-cli

Terminal client for [GChat](https://gchat.up.railway.app): encrypted group chat over the same HTTP + Socket.IO API as the web and desktop apps.

## Install

From the monorepo:

```bash
cd cli
npm install
npm link          # puts `gchat` on your PATH
# or
node bin/gchat.js --help
```

Pack without publishing to npm:

```bash
cd cli && npm pack
```

## Quick start

```bash
gchat config set server http://127.0.0.1:4400   # local dev
gchat login -u alice
gchat groups create "my-team"
gchat send "hello from the terminal"
gchat                                    # interactive TUI
```

In the TUI:

- Type a message and press Enter to send to the active group/channel
- Use `:command` for everything else (`:help`, `:groups`, `:open name`, `:channel design`, `:q`)

## Config & data

Stored under `~/.config/gchat` (Linux/macOS) or `%APPDATA%\gchat` (Windows), or `GCHAT_CONFIG_DIR`:

| File | Purpose |
|---|---|
| `config.json` | Server URL, bell, theme |
| `session.json` | Session cookie + CSRF |
| `vault.json` | Group encryption secrets |
| `prefs.json` | Active group/channel, mutes |

## Safety

- This client talks to the **same** GChat server as the browser; it does not start a local chat server.
- Respect server load limits: message pages ≤100, no polling, socket events only.
- Vault export contains secrets — treat it like a password dump.

## Tests

```bash
cd cli && npm test
```

Integration tests start an isolated in-process server (never Railway production).
