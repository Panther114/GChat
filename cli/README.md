# gchat-cli

Terminal client for [GChat](https://gchat.up.railway.app): encrypted group chat over the same HTTP + Socket.IO API as the web and desktop apps. Speaks sync protocol v2 (`X-GChat-Sync-Protocol: 2`), receives live traffic as `sync_event` / `sync_hint`, and uses the same AES-256-GCM + HKDF-SHA-256 message crypto (key escrow recovery included).

## Install

From the monorepo:

```bash
cd cli
npm install
npm link          # puts `gchat` on your PATH
# or
node bin/gchat.js --help
```

Prebuilt binaries (macOS arm64/x64, Windows x64, Linux x64) are published to GitHub Releases on `cli-v*` tags. Linux users can also run from source via `npm link`. Pack without publishing to npm:

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

Global flags: `--server <url>`, `--json`, `--yes`, `-h/--help`, `-V/--version`.
Aliases: `q`/`exit`→`quit`, `ls`/`g`→`groups`, `m`→`members`, `c`→`channel`, `h`→`history`, `s`→`send`.

## Command reference

Session: `help [command]`, `version`, `doctor`, `status`, `connect`, `disconnect`, `tui`, `quit`

Config: `config get <key>`, `config set <key> <value>`, `config path`
Keys: `server`, `theme` (dark|light), `bell` (on|off, terminal bell on new messages), `notify`, `scrollSensitivity` (1–20), `adminSecret`

Auth & account: `login -u <user> [-p <pass>] [--remember]`, `register -u <user> [-p <pass>] [--color <hex>]`, `logout`, `whoami`, `account show`, `account rename <name>`, `account color <hex>`, `account avatar <path>`, `account delete`, `settings get`, `settings set <key> <value>`

Groups: `groups` (`groups list`), `groups open <name|id>`, `open <name|id>`, `groups create <name> [--code <invite>]`, `groups join <code>` (`join`), `groups invite` (show code), `groups rename <name>`, `groups leave`, `groups disband`, `groups clear [--channel <name>]`, `groups settings`, `groups settings set <key> <value>`, `groups color <hex>`, `groups icon <path>`, `groups preload`, `groups keys sync` (`vault sync`, recover escrowed keys)

Members: `members` (`members list`), `members kick <user>`, `members admin grant|revoke <user>`, `presence`

Channels: `channel` (`channel list`), `channel switch <name>`, `channel main`, `channel create <name>`, `channel delete <name>`. On group open the CLI converges its channel list with the server's; messages are stamped with their channel (part of the encrypted identity) and edits never move a message between channels.

Messaging: `send <text>`, `reply <messageId> <text>`, `edit <messageId> <text>` (revision-guarded), `delete <messageId>`, `history [--limit N] [--before <id>] [--channel <name>] [--group <id>]` (≤100 per page), `read <messageId>`, `typing [--stop]`, `whisper <user> <text>`, `disappear <messageId>`, `hide <messageId>`, `timer start <messageId>`

Files: `upload <path> [--as image|file]`, `upload-image <path>`, `file list`, `file save <messageId> [path]`, `file open <messageId>`. Uploads over 15MB are rejected before reading into memory; `.jpg` maps to `image/jpeg`.

Search & export: `search <query>`, `export [-o file]`, `copy invite`, `copy message <messageId>`. Search/export cover the latest 100 messages.

Local prefs: `mute <group>`, `unmute <group>`, `notify on|off` (also toggles the terminal bell)

Vault & crypto: `vault` (`vault list`), `vault export [--out file]` (0600 mode, contains secrets — treat like a password dump), `vault import <file>`, `vault forget <groupId>`, `crypto selftest` (`crypto`)

Admin & AI: `admin users` (requires `adminSecret` in config); `admin user delete` is disabled; `ai` is unavailable in Increment A.

## Interactive TUI

`gchat` with no command (or `gchat tui`) opens the full-screen terminal UI: group sidebar with unread badges, per-channel transcript, multi-line composer, channel chips (create/delete/cycle with Tab), replies/edits/delete confirmations, typing indicators, file preview/open, clipboard copy, and image paste (clipboard-image paste is macOS-only; elsewhere paste a file path).

Keys:

- Hover outlines a message; click to select (click again to deselect). Then `r` reply, `e` edit, `d` delete, Esc clear, `p` preview, `c` copy
- Up / down moves between messages while one is selected; left / right cycle channels when the transcript is focused (`ctrl+f` toggles focus)
- Enter sends; Alt+Enter inserts a newline; Alt+Backspace deletes the current word
- Tab / Shift+Tab cycles channels; `+ Create` adds a channel; click a selected channel chip again (or `d`) to delete it; drag chips to reorder with the mouse (`#main` stays first)
- Ctrl+C cancels the current edit/reply/composer draft; Ctrl+C again copies the selected message or quits; Ctrl+D always quits; `:q` quits
- `p` opens Quick Look on macOS; pasted images auto-upload
- Composer slash commands: `:q` (quit), `:channel <name>`, `:open <group>`

The bell rings on new messages in groups other than the open one (disable with `bell off`).

## Config & data

Stored under `~/.config/gchat` (Linux/macOS) or `%APPDATA%\gchat` (Windows), or `GCHAT_CONFIG_DIR`:

| File | Purpose |
|---|---|
| `config.json` | Server URL, bell, theme |
| `session.json` | Session cookie + CSRF |
| `vault.json` | Group encryption secrets (0600 on POSIX) |
| `prefs.json` | Active group/channel, mutes |

A non-empty store file that fails to parse produces a stderr warning and falls back to defaults (it is never silently discarded).

## Safety

- This client talks to the **same** GChat server as the browser; it does not start a local chat server.
- Respect server load limits: message pages ≤100, single bounded backfill per reconnect (no polling, no unbounded reads), capped reconnection backoff, socket events only.
- Vault export contains secrets — treat it like a password dump.
- Decrypted attachment previews live in the OS temp dir only while the process runs and are wiped on exit.

## Tests

```bash
cd cli && npm test
```

Unit tests plus `test/regressions.test.js` (socket lifecycle, prompt, sync_event decrypt/render semantics, read cursors, channel convergence). Integration tests start an isolated in-process server (never Railway production).
