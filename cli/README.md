# gchat

GChat in your terminal. Type `gchat` and you get a chat UI that works like Claude Code: it runs inside your normal terminal (no full-screen takeover), messages scroll into your real scrollback, and a bordered input box sits at the bottom. Signing in, switching groups and channels, replying, editing, sending and viewing images all happen in there.

![gchat in a terminal](../docs/screenshots/cli-chat.png)

It speaks the same protocol as the web and desktop apps (sync v2, AES-256-GCM, HKDF-SHA-256, group key recovery included), so the same account works everywhere.

## Install

You need Node 18 or newer.

```bash
cd cli
npm install
npm link        # puts `gchat` on your PATH
gchat
```

Without linking, `node cli/bin/gchat.js` does the same. Standalone binaries for macOS, Windows and Linux are attached to GitHub releases tagged `cli-v*`.

The first run points at `https://gchat.up.railway.app`. To use another server:

```bash
gchat --server http://127.0.0.1:4400        # this run only
gchat config set server http://127.0.0.1:4400   # remember it
```

## Using it

Run `gchat`. If you're not signed in you'll get a small menu: log in, create an account, change server, quit. After that it reopens the last group and channel you were in and prints the recent messages. Type to chat, press Enter to send.

Type `/` to open the command menu, narrow it by typing, and use the arrow keys, Tab and Enter.

![command menu](../docs/screenshots/cli-commands.png)

| Key | Does |
|---|---|
| Enter | Send |
| Alt+Enter, Ctrl+J, or `\` then Enter | New line |
| Tab / Shift+Tab (empty input) | Next / previous channel |
| Ctrl+G | Switch group |
| Ctrl+V, Alt+V | Attach the image on your clipboard |
| Up / Down | Earlier messages you typed |
| Esc | Cancel a reply, edit or attachment, or close the menu |
| Ctrl+C | Clear the input; press twice on an empty input to quit |
| Ctrl+D | Quit (empty input) |
| Ctrl+L | Clear the screen |

Pasting a file path, or dragging a file into the terminal, attaches it. Press Enter to send it.

### Commands

| Command | Does |
|---|---|
| `/groups` (`/g`) | Pick a group, or create or join one |
| `/channel [name]` | Switch channel; `new <name>` and `delete <name>` also work |
| `/new [name]`, `/join [code]`, `/invite` | Create a group, join with a code, show the invite code |
| `/members` | List members |
| `/reply`, `/edit`, `/delete` | Pick one of the recent messages and act on it |
| `/upload <path>`, `/paste` | Send a file or image, or the clipboard image |
| `/view [n]` | Show image number *n* at full size (latest image if you leave it out) |
| `/save [n] [path]`, `/launch [n]` | Save an attachment, or open it in your default app |
| `/history`, `/search <text>` | Load earlier messages; search what's loaded |
| `/whisper <user> <text>` | Private message |
| `/theme dark|light`, `/clear`, `/status`, `/whoami`, `/logout`, `/help`, `/quit` | Housekeeping |

Anything else you can run as `gchat <command>` also works after a slash, for example `/members kick <user>` or `/groups settings`. Destructive ones ask for confirmation first.

### Images

Images show up as small previews right in the chat, each labelled `[Image #n]`. `/view n` draws one larger. PNG and JPEG are decoded in the terminal using half-block characters, which works everywhere. In iTerm2 and WezTerm the real image is shown instead. GIF and WebP can't be previewed; use `/launch n` to open them. Set `gchat config set preview off` to turn previews off.

### Unread

Opening a channel marks it read on the server, so the dots on the web and desktop apps clear too. If your terminal reports focus (most do), messages that arrive while you're in another window stay unread until you come back. The footer shows unread counts for other channels, and for other groups with a dot.

## One-shot commands

Everything is also available without the UI, which is handy for scripts:

```bash
gchat login -u alice
gchat groups
gchat open "Design crew"
gchat send "build is green"
gchat upload ./screenshot.png
gchat history --limit 20 --json
```

Global flags: `--server <url>`, `--json`, `--yes`, `-h`, `-V`. Run `gchat help` for the full list.

`gchat --classic` starts the older full-screen UI.

## Where things are stored

`~/.config/gchat` on Linux and macOS, `%APPDATA%\gchat` on Windows, or the folder in `GCHAT_CONFIG_DIR`.

| File | Contents |
|---|---|
| `config.json` | server, theme, bell, preview |
| `session.json` | session cookie and CSRF token |
| `vault.json` | group encryption keys (mode 0600) |
| `prefs.json` | last group and channel, muted groups |

`vault export` writes every group key in the clear, so treat the file like a password dump. Decrypted attachments for `/launch` live in the OS temp folder and are deleted when you quit.

## Development

```bash
cd cli
npm test               # unit and integration tests
npm run test:unit      # skips the in-process server tests
```

The integration tests start their own local server and never touch the hosted one. The new UI lives in `src/ui/` (renderer, key parser, editor, image decoding, app); the shared client is in `src/client/`.
