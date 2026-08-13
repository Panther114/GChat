'use strict';

/**
 * GChat CLI TUI entry — landing page, then Mini GChat.
 *
 * Handles terminal lifecycle (alternate screen, raw mode, resize, exit),
 * drives the pure frame builder in landing.js, and submits credentials to
 * the GChat backend through the shared GChatClient. On success it hands
 * off to the chat screen (groups / transcript / composer). An existing
 * session skips the landing page.
 */

const { stdin, stdout } = require('node:process');
const ansi = require('./ansi');
const {
  buildLandingFrame,
  DEFAULT_UI,
  TRANSITION_FRAMES,
  ERROR_HINT_MS,
  USERNAME_FIELD_WIDTH,
  PASSWORD_FIELD_WIDTH,
  clampScroll,
} = require('./landing');
const { GChatClient } = require('../client/api');
const { configPaths } = require('../store/paths');
const { createChatController } = require('./chat');

/** Milliseconds between animation frames (~20 fps). */
const FRAME_MS = 50;

/** How long a login failure message stays on the hint (ms). */
const LOGIN_ERROR_MS = 3000;

/** Field length caps (keeps typed input and drawn lines bounded). */
const MAX_USERNAME = 64;
const MAX_PASSWORD = 128;

function terminalSize() {
  return {
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
  };
}

/**
 * Pure: build the exact byte output for one frame at a given terminal size.
 * Kept separate from draw() so the render pipeline is unit-testable and the
 * erase-before-content invariant is enforced in one place.
 *
 * Invariant: each line is (eraseLine → content). Erase must come FIRST —
 * eraseLine wipes the entire current line, so writing it after content would
 * blank the frame.
 */
function composeFrame(cols, rows, frame, ui) {
  const { lines, originX, originY } = buildLandingFrame(cols, rows, frame, ui);
  let out = ansi.cursorHide();
  for (let i = 0; i < lines.length; i += 1) {
    out += ansi.cursorTo(originX, originY + i) + ansi.eraseLine() + ansi.truncate(lines[i], Math.max(0, cols - originX));
  }
  return out;
}

/**
 * A geometry change means the terminal already re-wrapped the alternate
 * screen; glyphs outside the new frame box (plus wrapped remnants from the
 * resize itself) must be cleared before redrawing, or stale copies of the
 * art/text accumulate on every resize.
 */
function redrawRequired(lastCols, lastRows, cols, rows) {
  return lastCols !== null && (lastCols !== cols || lastRows !== rows);
}

/**
 * Run the TUI.
 * @param {{ paths?: object, server?: string }} [options] kept for future use (chat TUI wiring)
 */
async function runTui(options = {}) {
  if (!stdout.isTTY || !stdin.isTTY) {
    stdout.write('GChat CLI TUI requires an interactive terminal.\nRun "gchat --help" for commands.\n');
    return;
  }

  let frame = 0;
  let timer = null;
  let done = false;
  let lastCols = null;
  let lastRows = null;
  let pendingKeys = '';
  let inputBuffer = '';
  let lastBounds = null;
  let screen = 'landing'; // 'landing' | 'chat'
  let chat = null;
  const ui = { ...DEFAULT_UI };

  /** Apply one keystroke to the login form (inserts at the active caret). */
  function handleKey(ch) {
    if (ch === '\r' || ch === '\n') {
      submit().catch(() => {});
      return;
    }
    if (ch === '\t') {
      ui.activeField = ui.activeField === 'username' ? 'password' : 'username';
      return;
    }
    if (ch === '\u007f' || ch === '\b') {
      if (ui.activeField === 'username') {
        const at = ui.usernameCaret;
        if (at > 0) {
          ui.username = ui.username.slice(0, at - 1) + ui.username.slice(at);
          ui.usernameCaret = at - 1;
        }
      } else if (ui.passwordCaret > 0) {
        ui.password.splice(ui.passwordCaret - 1, 1);
        ui.passwordCaret -= 1;
      }
      return;
    }
    if (ch < ' ') return; // printable only
    if (ui.activeField === 'username') {
      if (ui.username.length < MAX_USERNAME) {
        const at = ui.usernameCaret;
        ui.username = ui.username.slice(0, at) + ch + ui.username.slice(at);
        ui.usernameCaret = at + 1;
      }
    } else if (ui.password.length < MAX_PASSWORD) {
      ui.password.splice(ui.passwordCaret, 0, { ch, at: Date.now() });
      ui.passwordCaret += 1;
    }
  }

  /** Move the active field's caret by `delta` (-1 / +1). */
  function moveCaret(delta) {
    const len = ui.activeField === 'username' ? ui.username.length : ui.password.length;
    const at = ui.activeField === 'username' ? ui.usernameCaret : ui.passwordCaret;
    const next = Math.max(0, Math.min(len, at + delta));
    if (ui.activeField === 'username') ui.usernameCaret = next;
    else ui.passwordCaret = next;
  }

  /** Set the active field's caret to `pos` (clamped). */
  function setCaret(pos) {
    const len = ui.activeField === 'username' ? ui.username.length : ui.password.length;
    const next = Math.max(0, Math.min(len, pos));
    if (ui.activeField === 'username') ui.usernameCaret = next;
    else ui.passwordCaret = next;
  }

  /** Handle one escape sequence; returns the number of bytes consumed (0 = incomplete). */
  function consumeEscape(sequence) {
    const match = String(sequence).match(/^\u001b\[[0-9;<=>?]*[@-~]/);
    if (!match) return 0;
    const seq = match[0];
    if (seq.startsWith('\u001b[<')) {
      const mouse = ansi.parseSgrMouse(seq);
      if (mouse && mouse.press && mouse.button === 0) applyMouse(mouse);
    } else {
      const motion = seq.match(/^\u001b\[(\d*)([DC])$/);
      if (motion) {
        const count = motion[1] ? Number(motion[1]) : 1;
        moveCaret(motion[2] === 'D' ? -count : count);
      } else if (seq === '\u001b[H') {
        setCaret(0);
      } else if (seq === '\u001b[F') {
        setCaret(Number.MAX_SAFE_INTEGER);
      }
    }
    return seq.length;
  }

  /** Process raw login-mode input: plain text → keys, escapes → caret/mouse. */
  function processLoginInput(str) {
    let rest = String(str);
    while (rest.length > 0) {
      const escAt = rest.indexOf('\u001b');
      if (escAt === -1) {
        for (const ch of rest) handleKey(ch);
        return;
      }
      if (escAt > 0) {
        for (const ch of rest.slice(0, escAt)) handleKey(ch);
        rest = rest.slice(escAt);
        continue;
      }
      const consumed = consumeEscape(rest);
      if (consumed === 0) {
        // Partial escape sequence — hold it until the rest arrives (bounded).
        inputBuffer = rest.slice(0, 64);
        return;
      }
      rest = rest.slice(consumed);
    }
  }

  /** Map a left-click (1-based terminal coords) onto the form fields. */
  function applyMouse(mouse) {
    if (!lastBounds) return;
    const cx = mouse.x - 1;
    const cy = mouse.y - 1;
    let field = null;
    // Clicking anywhere on a field row focuses that field (caret clamped to the text).
    if (cy === lastBounds.username.row) field = 'username';
    else if (cy === lastBounds.password.row) field = 'password';
    if (!field) return;
    ui.activeField = field;
    const len = field === 'username' ? ui.username.length : ui.password.length;
    const caret = Math.max(0, Math.min(len, cx - lastBounds[field].x));
    if (field === 'username') ui.usernameCaret = caret;
    else ui.passwordCaret = caret;
  }

  function cleanup() {
    if (done) return;
    done = true;
    if (timer) clearInterval(timer);
    if (chat) {
      try { chat.stop(); } catch { /* ignore */ }
    }
    try {
      stdin.setRawMode(false);
    } catch {
      /* not in raw mode */
    }
    stdin.pause();
    stdout.write(ansi.cursorShow() + ansi.mouseDisable() + ansi.pasteDisable() + ansi.exitAltScreen() + ansi.clearScreen());
  }

  function exit(code = 0) {
    cleanup();
    process.exit(code);
  }

  function draw() {
    const { cols, rows } = terminalSize();
    if (redrawRequired(lastCols, lastRows, cols, rows)) {
      stdout.write(ansi.clearScreen());
    }
    lastCols = cols;
    lastRows = rows;
    if (screen === 'chat' && chat) {
      chat.draw();
      return;
    }
    ui.now = Date.now();
    // Lazy scroll: the window only moves when the caret leaves it.
    ui.usernameScroll = clampScroll(ui.usernameScroll, ui.usernameCaret, ui.username.length, USERNAME_FIELD_WIDTH);
    ui.passwordScroll = clampScroll(ui.passwordScroll, ui.passwordCaret, ui.password.length, PASSWORD_FIELD_WIDTH);
    const built = buildLandingFrame(cols, rows, frame, ui);
    lastBounds = built.fieldBounds;
    stdout.write(composeFrame(cols, rows, frame, ui));
  }

  const paths = options.paths || configPaths(options.configDir);
  const client = options.client || new GChatClient({ server: options.server, paths });

  /** Map a login failure to a user-facing message (server errors pass through). */
  function mapLoginError(err) {
    if (err && err.status) return err.message || 'Login failed';
    return "Couldn't connect";
  }

  function stopLandingTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function startLandingTimer() {
    if (timer) return;
    timer = setInterval(() => {
      frame += 1;
      if (ui.error && Date.now() >= ui.error.until) ui.error = null;
      if (ui.mode === 'transition') {
        ui.modeFrame += 1;
        if (ui.modeFrame >= TRANSITION_FRAMES) {
          ui.mode = 'login';
          if (pendingKeys) {
            const replay = pendingKeys;
            pendingKeys = '';
            processLoginInput(replay);
          }
        }
      }
      draw();
    }, FRAME_MS);
  }

  async function enterChat() {
    screen = 'chat';
    stopLandingTimer();
    stdout.write(ansi.clearScreen());
    lastCols = null;
    lastRows = null;
    chat = createChatController({
      client,
      paths,
      stdout,
      getSize: terminalSize,
      onQuit: () => exit(0),
    });
    await chat.start();
    draw();
  }

  /** After a successful login, hand off to the chat screen. */
  function finishLogin() {
    enterChat().catch((err) => {
      ui.loggingIn = false;
      ui.error = {
        until: Date.now() + LOGIN_ERROR_MS,
        fields: [],
        message: (err && err.message) || "Couldn't open chat",
      };
      screen = 'landing';
      startLandingTimer();
      draw();
    });
  }

  /** Submit the login form (Enter with both fields filled). */
  async function submit() {
    // Match the server spec: username 2-32 chars, password at least 6.
    const invalid = [];
    if (ui.username.trim().length < 2) invalid.push('username');
    if (ui.password.length < 6) invalid.push('password');
    if (invalid.length > 0) {
      ui.error = { until: Date.now() + ERROR_HINT_MS, fields: invalid, message: null };
      ui.activeField = invalid.includes('username') ? 'username' : 'password';
      return;
    }
    ui.error = null;
    const username = ui.username.trim();
    const password = ui.password.map((entry) => entry.ch).join('');
    if (options.onSubmit) {
      options.onSubmit({ username, password });
      return;
    }
    ui.loggingIn = true;
    try {
      await client.login(username, password);
      await client.listGroups().catch(() => []);
      finishLogin();
    } catch (err) {
      ui.loggingIn = false;
      ui.error = {
        until: Date.now() + LOGIN_ERROR_MS,
        fields: [],
        message: mapLoginError(err),
      };
    }
  }

  // --- terminal setup ------------------------------------------------------
  stdout.write(ansi.enterAltScreen() + ansi.clearScreen() + ansi.mouseEnable() + ansi.pasteEnable());
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  // --- input ---------------------------------------------------------------
  stdin.on('data', (chunk) => {
    const text = String(chunk);
    if (text.includes('\u0003') || text.includes('\u0004')) {
      exit(0);
      return;
    }
    if (screen === 'chat' && chat) {
      chat.pushInput(text);
      return;
    }
    if (ui.loggingIn) return; // ignore input while the login request is in flight
    const combined = inputBuffer + text;
    inputBuffer = '';
    if (ui.mode === 'idle') {
      // Enter morphs the "[x] login via username" line into the login form.
      if (combined.includes('\r') || combined.includes('\n')) {
        ui.mode = 'transition';
        ui.modeFrame = 0;
      }
      return;
    }
    if (ui.mode === 'transition') {
      // Buffer keys typed during the morph; replayed once the form settles.
      pendingKeys = (pendingKeys + combined).slice(0, 1024);
      return;
    }
    processLoginInput(combined);
  });

  process.on('SIGINT', () => exit(0));
  process.on('SIGTERM', () => exit(0));
  process.on('exit', cleanup);
  stdout.on('resize', () => {
    draw();
  });

  // --- start: restore a session into chat, otherwise play the landing ------
  let startOnChat = false;
  try {
    const cookies = client.session && client.session.cookies;
    if (client.user || client.session?.user || (cookies && Object.keys(cookies).length > 0)) {
      await client.me();
      startOnChat = true;
    }
  } catch {
    startOnChat = false;
  }

  if (startOnChat) {
    await enterChat();
  } else {
    draw();
    startLandingTimer();
  }

  // Keep alive until the process is told to exit.
  await new Promise(() => {});
}

module.exports = {
  runTui,
  FRAME_MS,
  terminalSize,
  composeFrame,
  redrawRequired,
};
