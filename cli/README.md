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

- Hover outlines a message; click to select (click again to deselect). Then `r` reply, `e` edit, `d` delete, Esc clear, `p` preview
- Esc with nothing selected leaves the chat for the idle bird
- The sidebar profile chip opens a Log out control that clears the session
- Click a selected channel again to delete (`d`); drag chips to reorder (`#main` stays first)
- Icons (`↩` `✎` `×`) sit packed to the right of the content; ticks sit on the far right
- Up / down moves to the previous / next message while one is selected
- Paste an image (or a path) to auto-upload; `p` opens Quick Look on macOS
- Tab / Shift+Tab cycles channels; `+ Create` adds a channel
- Enter sends; Alt+Enter inserts a newline; Alt+Backspace deletes the current word
- `:q` or Ctrl+C to quit

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
