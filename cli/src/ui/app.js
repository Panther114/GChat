'use strict';

/**
 * GChat inline TUI.
 *
 * Layout, top to bottom, all in the normal terminal buffer:
 *   scrollback   welcome banner, messages, command output (never repainted)
 *   live region  dialog or [status line, input box, footer / command menu]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ansi = require('../tui/ansi');
const { CLI_VERSION } = require('../version');
const { LiveScreen, wrapText } = require('./screen');
const { createKeyParser } = require('./keys');
const { renderHome } = require('./home');
const { renderBird } = require('./bird');
const { Editor } = require('./editor');
const fmt = require('./format');
const image = require('./image');
const { COMMANDS, DESTRUCTIVE, findCommand, matchCommands } = require('./commands');
const { decryptServerMessage, decryptAttachmentMeta, decryptAttachment } = require('../client/messages');
const { loadPrefs, savePrefs, getActiveChannel, setActiveChannel, rememberChannel, forgetChannel, listChannels, normalizeChannel } = require('../store/prefs');
const { loadConfig, saveConfig } = require('../store/config');
const { looksLikeImagePath, readClipboardImage } = require('../tui/clipboard-image');

const HISTORY_PAGE = 50;
const OPEN_PRINT = 30;
const MEDIA_DIR = path.join(os.tmpdir(), 'gchat-cli-media');
const MAX_THUMB_BYTES = 4 * 1024 * 1024;
const BACKFILL_MIN_INTERVAL_MS = 5000;
const FLASH_MS = 4000;
const PALETTE_ROWS = 7;

const hostOf = (server) => String(server || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');

class App {
  constructor({ client, paths, stdin = process.stdin, stdout = process.stdout, onExit } = {}) {
    this.client = client;
    this.paths = paths;
    this.stdin = stdin;
    this.stdout = stdout;
    this.onExit = onExit || ((code) => process.exit(code));
    this.screen = new LiveScreen({ stdout });
    this.input = new Editor();
    this.config = loadConfig(paths);
    fmt.setTheme(this.config.theme === 'light' ? 'light' : 'dark');

    this.running = false;
    this.focused = true;
    this.connected = false;
    this.everConnected = false;
    this.user = null;
    this.groups = [];
    this.group = null;
    this.channel = 'main';
    this.channels = ['main'];
    this.channelUnread = {};
    this.unreadTags = {};
    this.items = [];
    this.memberCount = 0;
    this.hasMore = false;
    this.dialog = null;
    this.flashState = null;
    this.typing = new Map();
    this.replying = null;
    this.editing = null;
    this.attachment = null;
    this.paletteIndex = 0;
    this.lastPrinted = null;
    this.attachments = [];
    this.mediaCache = new Map();
    this.openSeq = 0;
    this.printChain = Promise.resolve();
    this.lastCtrlC = 0;
    this.lastCursorKey = '';
    this.lastBackfillAt = 0;
    this.missedWhileAway = 0;
    this.typingSentAt = 0;
    this.timers = new Set();
    this.pendingEcho = new Set();
    this.view = 'home'; // 'home' | 'chat'
    this.homeIndex = 0;
    this.homeStart = Date.now();
    this.burstAt = -1;
    this.hits = [];
    this.mouseOn = this.config.mouse !== 'off';
    this.spinner = null;
    this.thumbs = new Map();
    this.lastLineCount = 0;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async start() {
    this.running = true;
    this.stdout.write('\u001b[?2004h\u001b[?1004h');
    this.setMouse(this.mouseOn);
    if (this.stdin.setRawMode) this.stdin.setRawMode(true);
    this.stdin.setEncoding('utf8');
    this.stdin.resume();
    const feed = createKeyParser({
      onKey: (k) => this.onKey(k),
      onPaste: (t) => this.onPaste(t),
      onFocus: (focused) => this.onFocus(focused),
      onMouse: (m) => this.onMouse(m),
      onCursor: (row) => this.screen.handleCursorReport(row),
    });
    this.stdin.on('data', (chunk) => {
      try {
        feed(chunk);
      } catch (err) {
        this.flash(`input error: ${err.message}`, 'error');
      }
    });
    this.stdout.on('resize', () => this.refresh());
    this.refresh();
    // Boot runs in the background: sign-in dialogs can stay open indefinitely.
    this.bootPromise = this.boot().catch((err) => {
      this.printSystem(`Could not start: ${err.message || err}`, 'error');
      this.refresh();
    });
  }

  stop(code = 0) {
    if (!this.running) return;
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.stopAnim();
    this.stopSpinner();
    try { this.client.disconnectSocket(); } catch { /* ignore */ }
    try { fs.rmSync(MEDIA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    this.screen.render([], null);
    this.screen.release();
    this.stdout.write('\u001b[?1000l\u001b[?1006l\u001b[?2004l\u001b[?1004l\u001b[0m');
    try { if (this.stdin.setRawMode) this.stdin.setRawMode(false); } catch { /* ignore */ }
    this.stdin.pause();
    this.onExit(code);
  }

  later(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.running) fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  async boot() {
    const hasSession = this.client.http.session?.user || Object.keys(this.client.http.session?.cookies || {}).length;
    let groupsEarly = null;
    if (hasSession) {
      // Session check and group list are independent: ask for both at once.
      const [me, groups] = await Promise.all([
        this.client.me().catch(() => null),
        this.client.listGroups().catch(() => null),
      ]);
      this.user = me;
      groupsEarly = me ? groups : null;
    }
    if (!this.user) {
      this.splash = true;
      this.homeStart = Date.now();
      this.startAnim();
      await this.authFlow();
      this.splash = false;
    }
    if (!this.running) return;
    await this.afterLogin(groupsEarly);
  }

  async afterLogin(groupsEarly = null) {
    this.client.onEvent = (event, payload) => {
      this.onClientEvent(event, payload).catch(() => { /* event handlers are best-effort */ });
    };
    // The socket connects while the group list loads; neither blocks the home screen.
    this.client.connectSocket()
      .then(() => { this.connected = true; this.everConnected = true; this.refresh(); })
      .catch((err) => { this.connected = false; this.flash(`offline: ${err.message || err}`, 'error'); });
    if (groupsEarly) this.groups = groupsEarly.map((g) => ({ ...g, name: fmt.safe(g.name) }));
    else await this.refreshGroups();
    this.view = 'home';
    this.homeStart = Date.now();
    this.homeIndex = this.defaultHomeIndex();
    this.startAnim();
    this.refresh();
  }

  /** Home selection: the chat you were last in, otherwise the first one. */
  defaultHomeIndex() {
    const prefs = loadPrefs(this.paths);
    const at = this.groups.findIndex((g) => String(g.id) === String(prefs.activeGroupId));
    return at >= 0 ? at : 0;
  }

  // ── home screen ────────────────────────────────────────────────────────────

  startAnim() {
    if (this.animTimer || !this.running) return;
    this.animTimer = setInterval(() => {
      if (this.view !== 'home' || (this.dialog && !this.splash) || !this.focused) return;
      this.refresh({ animate: true });
    }, 100);
  }

  stopAnim() {
    if (this.animTimer) clearInterval(this.animTimer);
    this.animTimer = null;
  }

  goHome() {
    if (this.view === 'home') return;
    this.group = null;
    this.items = [];
    this.typing.clear();
    this.replying = null;
    this.editing = null;
    this.view = 'home';
    this.setTitle('GChat');
    this.homeStart = Date.now();
    this.homeIndex = this.defaultHomeIndex();
    this.lastPrinted = null;
    this.screen.commit(['', fmt.rule('home', Math.min(this.screen.cols(), 72))]);
    this.refreshGroups().then(() => this.refresh()).catch(() => {});
    this.startAnim();
    this.refresh();
  }

  async activateHomeItem(index = this.homeIndex) {
    const items = [...this.groups.map((g) => ({ kind: 'group', group: g })), { kind: 'new' }, { kind: 'join' }];
    const item = items[Math.max(0, Math.min(index, items.length - 1))];
    if (!item) return;
    if (item.kind === 'group') await this.openGroup(item.group);
    else if (item.kind === 'new') await this.cmd_newGroup('');
    else await this.cmd_joinGroup('');
  }

  cmd_home() { this.goHome(); }

  setTitle(text) {
    this.stdout.write(`\u001b]0;${fmt.safe(text).replace(/\u0007/g, '')}\u0007`);
  }

  // ── mouse ──────────────────────────────────────────────────────────────────

  setMouse(on) {
    this.mouseOn = !!on;
    this.screen.trackCursor = this.mouseOn;
    this.stdout.write(this.mouseOn ? '\u001b[?1000h\u001b[?1006h' : '\u001b[?1000l\u001b[?1006l');
  }

  async cmd_mouse(arg) {
    const next = arg ? /^(on|1|true)$/i.test(arg) : !this.mouseOn;
    this.setMouse(next);
    saveConfig({ ...loadConfig(this.paths), mouse: next ? 'on' : 'off' }, this.paths);
    this.config = loadConfig(this.paths);
    this.printSystem(next
      ? 'Mouse on: click channels, chats and menu items. Hold Shift to select text.'
      : 'Mouse off: the terminal handles selection and scrolling again.');
  }

  /** Left clicks only; the wheel and drags are ignored. */
  onMouse(m) {
    if (!this.mouseOn || m.release || m.wheel || m.motion || m.button !== 0) return;
    const row = this.screen.regionRow(m.y);
    if (row < 0) return;
    const col = m.x - 1;
    const hit = this.hits.find((h) => h.row === row && col >= h.x0 && col < h.x1);
    if (!hit) return;
    Promise.resolve(hit.fn()).catch((err) => this.flash(err.message || String(err), 'error')).finally(() => this.refresh());
  }

  startSpinner(text) {
    this.spinner = { text, frame: 0 };
    if (this.spinTimer) return;
    this.spinTimer = setInterval(() => {
      if (!this.spinner) return;
      this.spinner.frame += 1;
      this.refresh({ animate: true });
    }, 80);
  }

  stopSpinner() {
    this.spinner = null;
    if (this.spinTimer) clearInterval(this.spinTimer);
    this.spinTimer = null;
  }

  // ── welcome / auth ─────────────────────────────────────────────────────────

  async authFlow() {
    for (;;) {
      const choice = await this.choose({
        title: 'Sign in to GChat',
        options: [
          { label: 'Log in', value: 'login' },
          { label: 'Create an account', value: 'register' },
          { label: `Server: ${hostOf(this.client.server)}`, hint: 'change', value: 'server' },
          { label: 'Quit', value: 'quit' },
        ],
        cancelValue: 'quit',
      });
      if (!this.running) return;
      if (choice === 'quit') {
        this.stop(0);
        return;
      }
      if (choice === 'server') {
        const url = await this.ask({ label: 'Server URL', initial: this.client.server });
        if (url) await this.setServer(url);
        continue;
      }
      const username = await this.ask({ label: 'Username' });
      if (username === null) continue;
      const password = await this.ask({ label: 'Password', mask: true });
      if (password === null) continue;
      try {
        if (choice === 'register') {
          const again = await this.ask({ label: 'Repeat password', mask: true });
          if (again === null) continue;
          if (again !== password) throw new Error('Passwords do not match');
          this.user = await this.client.register(username.trim(), password);
        } else {
          this.user = await this.client.login(username.trim(), password);
        }
        this.printSystem(`Signed in as ${this.user.username}.`, 'ok');
        return;
      } catch (err) {
        this.printSystem(err.message || String(err), 'error');
      }
    }
  }

  async setServer(url) {
    const clean = String(url).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(clean)) {
      this.printSystem('Server URL must start with http:// or https://', 'error');
      return;
    }
    this.client.http.setServer(clean);
    saveConfig({ ...loadConfig(this.paths), server: clean }, this.paths);
    this.printSystem(`Server set to ${hostOf(clean)}.`);
  }

  async logout() {
    try { await this.client.logout(); } catch { /* already signed out */ }
    this.client.disconnectSocket();
    this.group = null;
    this.groups = [];
    this.items = [];
    this.user = null;
    this.connected = false;
    this.view = 'home';
    this.screen.clearAll();
    this.splash = true;
    this.homeStart = Date.now();
    this.startAnim();
    await this.authFlow();
    this.splash = false;
    if (this.running) await this.afterLogin();
  }

  // ── dialogs ────────────────────────────────────────────────────────────────

  /** Select list. Resolves with the chosen value, or `cancelValue` (default null) on Esc. */
  choose({ title, options, body = null, cancelValue = null, index = 0 }) {
    return new Promise((resolve) => {
      const state = { index: Math.min(index, options.length - 1) };
      const finish = (value) => {
        this.dialog = null;
        this.refresh();
        resolve(value);
      };
      this.dialog = {
        render: (cols) => {
          const inner = cols - 4;
          const lines = [fmt.bold(title)];
          if (body) lines.push(...wrapText(body, inner).map((l) => fmt.muted(l)));
          lines.push('');
          const first = lines.length;
          options.forEach((opt, i) => {
            const active = i === state.index;
            const pointer = active ? fmt.color('accent', '❯') : ' ';
            const label = `${i + 1}. ${opt.label}`;
            const hint = opt.hint ? fmt.dim(`  ${opt.hint}`) : '';
            const row = `${pointer} ${active ? fmt.color('accent', label) : label}${hint}`;
            const right = opt.badge ? fmt.color('error', opt.badge) : '';
            const gap = Math.max(1, inner - ansi.width(row) - ansi.width(right));
            lines.push(right ? `${row}${' '.repeat(gap)}${right}` : row);
          });
          lines.push('', fmt.dim('↑/↓ move · Enter select · Esc cancel'));
          this.dialog.hits = options.map((opt, i) => ({ row: first + i + 1, x0: 0, x1: cols, fn: () => finish(opt.value) }));
          return fmt.box(lines, cols, { borderKey: 'borderActive' });
        },
        key: (k) => {
          if (k.name === 'up') state.index = (state.index - 1 + options.length) % options.length;
          else if (k.name === 'down' || k.name === 'tab') state.index = (state.index + 1) % options.length;
          else if (k.name === 'enter') return finish(options[state.index].value);
          else if (k.name === 'escape' || (k.name === 'ctrl' && k.ch === 'c')) return finish(cancelValue);
          else if (k.name === 'char' && /^[1-9]$/.test(k.ch) && Number(k.ch) <= options.length) return finish(options[Number(k.ch) - 1].value);
          this.refresh();
          return undefined;
        },
        paste: () => {},
      };
      this.refresh();
    });
  }

  confirm(title, body, { danger = true } = {}) {
    return this.choose({
      title,
      body,
      options: [
        { label: danger ? 'Yes, do it' : 'Yes', value: true },
        { label: 'No, cancel', value: false },
      ],
      cancelValue: false,
      index: 1,
    }).then(Boolean);
  }

  /** One-line text prompt. Resolves with the text, or null on Esc. */
  ask({ label, mask = false, initial = '', hint = '' }) {
    return new Promise((resolve) => {
      const editor = new Editor({ mask });
      editor.set(initial);
      const finish = (value) => {
        this.dialog = null;
        this.refresh();
        resolve(value);
      };
      this.dialog = {
        editor,
        render: (cols) => {
          const inner = cols - 4;
          const laid = editor.layout(Math.max(8, inner - 3));
          const shown = laid.lines.length ? laid.lines : [''];
          const lines = [fmt.bold(label), ''];
          shown.forEach((line, i) => lines.push(`${i === 0 ? fmt.color('accent', '>') : ' '} ${line}`));
          lines.push('', fmt.dim(hint || 'Enter to continue · Esc to cancel'));
          const rendered = fmt.box(lines, cols, { borderKey: 'borderActive' });
          return { lines: rendered, caret: { row: 3 + laid.caret.row, col: 4 + laid.caret.col } };
        },
        key: (k) => {
          if (k.name === 'enter') return finish(editor.text);
          if (k.name === 'escape' || (k.name === 'ctrl' && k.ch === 'c')) return finish(null);
          this.editKey(editor, k);
          this.refresh();
          return undefined;
        },
        paste: (text) => {
          editor.insert(String(text).split('\n')[0]);
          this.refresh();
        },
      };
      this.refresh();
    });
  }

  // ── input handling ─────────────────────────────────────────────────────────

  onFocus(focused) {
    this.focused = focused;
    if (focused) {
      this.missedWhileAway = 0;
      this.markReadSoon();
      this.refresh();
    }
  }

  onPaste(text) {
    if (this.dialog) {
      this.dialog.paste(text);
      return;
    }
    const file = looksLikeImagePath(text.trim());
    if (file) {
      this.attachFile(file);
      return;
    }
    this.input.insert(text);
    this.refresh();
  }

  /** Shared text-editing keys (composer and prompts). Returns true when handled. */
  editKey(editor, k) {
    if (k.name === 'char' && !k.alt) {
      editor.insert(k.ch);
      return true;
    }
    if (k.name === 'char' && k.alt) {
      if (k.ch === 'b') editor.wordLeft();
      else if (k.ch === 'f') editor.wordRight();
      else return false;
      return true;
    }
    switch (k.name) {
      case 'backspace': if (k.alt) editor.deleteWordBack(); else editor.backspace(); return true;
      case 'delete': editor.del(); return true;
      case 'left': if (k.ctrl || k.alt) editor.wordLeft(); else editor.left(); return true;
      case 'right': if (k.ctrl || k.alt) editor.wordRight(); else editor.right(); return true;
      case 'home': editor.home(); return true;
      case 'end': editor.end(); return true;
      case 'ctrl':
        if (k.ch === 'a') editor.home();
        else if (k.ch === 'e') editor.end();
        else if (k.ch === 'k') editor.killToEnd();
        else if (k.ch === 'u') editor.killToStart();
        else if (k.ch === 'w') editor.deleteWordBack();
        else if (k.ch === 'b') editor.left();
        else if (k.ch === 'f') editor.right();
        else if (k.ch === 'h') editor.backspace();
        else return false;
        return true;
      default: return false;
    }
  }

  onKey(k) {
    if (!this.running) return;
    if (this.dialog) {
      this.dialog.key(k);
      return;
    }
    const ed = this.input;
    const menu = this.paletteMatches();

    if (k.name === 'ctrl' && k.ch === 'c') return this.onCtrlC();
    if (k.name === 'ctrl' && k.ch === 'd') {
      if (!ed.text) this.stop(0);
      else ed.del();
      this.refresh();
      return undefined;
    }
    if (k.name === 'ctrl' && k.ch === 'l') {
      this.screen.clearAll();
      return undefined;
    }
    if ((k.name === 'ctrl' && k.ch === 'v') || (k.name === 'char' && k.alt && k.ch === 'v')) {
      this.pasteImage();
      return undefined;
    }
    if (k.name === 'ctrl' && k.ch === 'g') {
      this.pickGroup();
      return undefined;
    }

    if (this.view === 'home' && !ed.text) {
      const count = this.groups.length + 2;
      let moved = true;
      if (k.name === 'up') this.homeIndex = (this.homeIndex - 1 + count) % count;
      else if (k.name === 'down' || (k.name === 'tab' && !k.shift)) this.homeIndex = (this.homeIndex + 1) % count;
      else if (k.name === 'tab') this.homeIndex = (this.homeIndex - 1 + count) % count;
      else if (k.name === 'home') this.homeIndex = 0;
      else if (k.name === 'end') this.homeIndex = count - 1;
      else moved = false;
      if (moved) {
        this.refresh();
        return undefined;
      }
      if (k.name === 'enter' && !k.alt && !k.shift) {
        this.activateHomeItem().catch((err) => this.flash(err.message || String(err), 'error')).finally(() => this.refresh());
        return undefined;
      }
    }

    if (k.name === 'enter' && !k.alt && !k.shift) {
      if (menu.length && this.paletteActive()) return this.acceptPalette(menu);
      if (ed.text.endsWith('\\')) {
        ed.backspace();
        ed.insert('\n');
        this.refresh();
        return undefined;
      }
      return this.submit();
    }
    if ((k.name === 'enter' && (k.alt || k.shift)) || k.name === 'newline') {
      ed.insert('\n');
      this.refresh();
      return undefined;
    }
    if (k.name === 'escape') {
      if (menu.length && this.paletteActive()) ed.clear();
      else if (this.editing || this.replying || this.attachment) this.cancelCompose();
      else if (ed.text) ed.clear();
      this.refresh();
      return undefined;
    }
    if (k.name === 'tab') {
      if (menu.length && this.paletteActive()) {
        this.completePalette(menu);
      } else if (!ed.text && this.group) {
        this.cycleChannel(k.shift ? -1 : 1);
      }
      this.refresh();
      return undefined;
    }
    if (k.name === 'up' || k.name === 'down') {
      const dir = k.name === 'up' ? -1 : 1;
      if (menu.length && this.paletteActive()) {
        this.paletteIndex = (this.paletteIndex + dir + menu.length) % menu.length;
      } else {
        ed.arrow(dir);
      }
      this.refresh();
      return undefined;
    }
    if (k.name === 'pageup' || k.name === 'pagedown') return undefined;
    if (this.editKey(ed, k)) {
      this.paletteIndex = 0;
      this.afterEdit();
      this.refresh();
    }
    return undefined;
  }

  onCtrlC() {
    const now = Date.now();
    if (this.input.text || this.editing || this.replying || this.attachment) {
      this.input.clear();
      this.cancelCompose();
      this.refresh();
      return;
    }
    if (now - this.lastCtrlC < 2000) {
      this.stop(0);
      return;
    }
    this.lastCtrlC = now;
    this.flash('Press Ctrl+C again to exit', 'info', 2000);
  }

  afterEdit() {
    if (!this.group || this.input.text.startsWith('/')) return;
    const now = Date.now();
    if (this.input.text && now - this.typingSentAt > 2500) {
      this.typingSentAt = now;
      try { this.client.emitTyping(this.group.id); } catch { /* typing is best-effort */ }
    }
  }

  cancelCompose() {
    if (this.editing) this.input.clear();
    this.editing = null;
    this.replying = null;
    this.attachment = null;
  }

  // ── command palette ────────────────────────────────────────────────────────

  paletteActive() {
    const text = this.input.text;
    return text.startsWith('/') && !text.includes(' ') && !text.includes('\n');
  }

  paletteMatches() {
    if (!this.paletteActive()) return [];
    return matchCommands(this.input.text.slice(1)).slice(0, PALETTE_ROWS);
  }

  completePalette(menu) {
    const cmd = menu[Math.min(this.paletteIndex, menu.length - 1)];
    this.input.set(`/${cmd.name}${cmd.usage ? ' ' : ''}`);
  }

  acceptPalette(menu) {
    const cmd = menu[Math.min(this.paletteIndex, menu.length - 1)];
    const typed = this.input.text.slice(1).toLowerCase();
    const exact = typed === cmd.name || cmd.aliases.includes(typed);
    if (!exact && cmd.usage) {
      this.completePalette(menu);
      this.refresh();
      return;
    }
    this.input.set(`/${cmd.name}`);
    this.submit();
  }

  // ── submit ─────────────────────────────────────────────────────────────────

  submit() {
    const raw = this.input.text;
    const text = raw.trim();
    if (!text && !this.attachment) return;
    if (text.startsWith('/') && !this.editing) {
      this.input.submit();
      this.paletteIndex = 0;
      this.refresh();
      this.runCommandLine(text).catch((err) => this.printSystem(err.message || String(err), 'error')).finally(() => this.refresh());
      return;
    }
    if (!this.group) {
      this.flash('Pick a chat first: press Enter on one above, or type /groups.', 'error');
      return;
    }
    const editing = this.editing;
    const replying = this.replying;
    const attachment = this.attachment;
    this.input.submit();
    this.editing = null;
    this.replying = null;
    this.attachment = null;
    this.refresh();
    const work = editing
      ? this.sendEdit(editing, text)
      : this.sendMessage({ text, replying, attachment });
    work.catch((err) => {
      this.flash(err.message || String(err), 'error', 6000);
    }).finally(() => this.refresh());
  }

  async sendMessage({ text, replying, attachment }) {
    const groupId = this.group.id;
    if (attachment) {
      this.flash(`Uploading ${attachment.filename}…`, 'info', 20000);
      await this.client.uploadFile(groupId, attachment.path, {
        type: attachment.isImage ? 'image' : undefined,
        channel: this.channel,
        replyToId: replying?.msg.id || null,
      });
      this.flashState = null;
    }
    if (text) {
      await this.client.sendText({
        groupId,
        text,
        channel: this.channel,
        replyToId: replying?.msg.id || null,
        replyPreview: replying ? `${replying.msg.senderName || 'message'}: ${fmt.previewText(replying, 80)}` : null,
      });
      try { this.client.emitTyping(groupId, true); } catch { /* ignore */ }
    }
    this.scheduleBackfillCheck();
  }

  async sendEdit(item, text) {
    if (text === item.text) return;
    await this.client.editMessage(this.group.id, item.msg.id, text);
  }

  /** The server echoes our own message as a sync_event; if it never shows up, backfill once. */
  scheduleBackfillCheck() {
    this.later(4000, () => this.backfill('echo'));
  }

  // ── slash commands ─────────────────────────────────────────────────────────

  async runCommandLine(line) {
    const body = line.replace(/^\//, '');
    const [name, ...rest] = body.trim().split(/\s+/);
    const argText = body.trim().slice(name.length).trim();
    const cmd = findCommand(name);
    // `/groups settings`, `/members kick bob`: subcommands go to the shared handlers.
    const subcommand = (cmd?.name === 'groups' || cmd?.name === 'members') && argText;
    if (cmd && cmd.native && !subcommand) {
      await this[`cmd_${cmd.native}`](argText, rest);
      return;
    }
    await this.runGeneric(body.trim());
  }

  async runGeneric(line) {
    const { createContext, handleCommand } = require('../commands/handlers');
    const { parseCommand } = require('../commands/parser');
    const parsed = parseCommand(`/${line}`);
    if (DESTRUCTIVE.has(parsed.name)) {
      if (!(await this.confirm(`Run "${parsed.name}"?`, 'This cannot be undone.'))) return;
    }
    const out = [];
    const ctx = createContext({
      paths: this.paths,
      client: this.client,
      out: (text) => out.push(text),
      err: (text) => out.push(text),
      yes: true,
    });
    try {
      await handleCommand(parsed, ctx);
    } catch (err) {
      this.printSystem(err.message || String(err), 'error');
      return;
    }
    if (out.length) this.printSystem(out.join('\n'));
    if (/^(groups|join|leave|members|vault)/.test(parsed.name)) await this.refreshGroups();
  }

  cmd_help() {
    const rows = COMMANDS.map((c) => {
      const usage = c.usage ? ` ${fmt.dim(c.usage)}` : '';
      return `  ${fmt.color('accent', `/${c.name}`)}${usage}\n      ${fmt.muted(c.desc)}`;
    });
    this.printBlock([
      fmt.bold('Commands'),
      ...rows,
      '',
      fmt.dim('Enter sends · Alt+Enter or \\ + Enter adds a line · Tab cycles channels · Ctrl+V pastes an image'),
      fmt.dim('Any other `gchat <command>` also works here, e.g. /groups settings or /members kick <user>.'),
    ]);
  }

  cmd_quit() { this.stop(0); }

  cmd_clearScreen() { this.screen.clearAll(); this.lastPrinted = null; }

  async cmd_whoami() {
    this.printSystem(`${this.user?.username || '?'}  ${fmt.dim(`@ ${hostOf(this.client.server)}`)}`);
  }

  async cmd_status() {
    this.printBlock([
      `${fmt.dim('user    ')} ${this.user?.username || '-'}`,
      `${fmt.dim('server  ')} ${hostOf(this.client.server)} ${this.connected ? fmt.color('ok', '(connected)') : fmt.color('error', '(offline)')}`,
      `${fmt.dim('group   ')} ${this.group ? `${this.group.name} · ${this.memberCount} members` : '-'}`,
      `${fmt.dim('channel ')} #${this.channel}`,
      `${fmt.dim('version ')} ${CLI_VERSION}`,
    ]);
  }

  async cmd_logout() { await this.logout(); }

  async cmd_theme(arg) {
    const next = (arg || (this.config.theme === 'light' ? 'dark' : 'light')).toLowerCase();
    if (next !== 'dark' && next !== 'light') {
      this.printSystem('Usage: /theme dark|light', 'error');
      return;
    }
    this.config = { ...this.config, theme: next };
    saveConfig(this.config, this.paths);
    fmt.setTheme(next);
    this.printSystem(`Theme: ${next}`);
  }

  async cmd_groups() { await this.pickGroup(); }

  async pickGroup() {
    if (this.dialog) return;
    await this.refreshGroups();
    const options = this.groups.map((g) => ({
      label: g.name,
      value: g,
      badge: Number(g.unreadCount) > 0 && String(g.id) !== String(this.group?.id) ? `● ${g.unreadCount > 99 ? '99+' : g.unreadCount}` : '',
      hint: String(g.id) === String(this.group?.id) ? 'current' : '',
    }));
    options.push({ label: 'New group…', value: 'new' }, { label: 'Join with invite code…', value: 'join' });
    const picked = await this.choose({ title: 'Switch group', options });
    if (!picked) return;
    if (picked === 'new') await this.cmd_newGroup('');
    else if (picked === 'join') await this.cmd_joinGroup('');
    else if (String(picked.id) !== String(this.group?.id)) await this.openGroup(picked);
  }

  async cmd_newGroup(arg) {
    const name = arg || await this.ask({ label: 'Group name' });
    if (!name || !name.trim()) return;
    const { group, joinCode } = await this.client.createGroup(name.trim());
    await this.refreshGroups();
    this.printSystem(`Created ${group.name}. Invite code: ${fmt.bold(joinCode)}`, 'ok');
    await this.openGroup(this.groups.find((g) => g.id === group.id) || group);
  }

  async cmd_joinGroup(arg) {
    const code = arg || await this.ask({ label: 'Invite code' });
    if (!code || !code.trim()) return;
    const group = await this.client.joinGroup(code.trim());
    await this.refreshGroups();
    this.printSystem(`Joined ${group.name}.`, 'ok');
    await this.openGroup(this.groups.find((g) => g.id === group.id) || group);
  }

  async cmd_invite() {
    if (!this.group) return this.printSystem('Open a group first.', 'error');
    const code = this.client.inviteCode(this.group.id);
    this.printSystem(code ? `Invite code for ${this.group.name}: ${fmt.bold(code)}` : 'No invite code on file for this group.');
    return undefined;
  }

  async cmd_members() {
    if (!this.group) return this.printSystem('Open a group first.', 'error');
    const members = await this.client.listMembers(this.group.id);
    this.memberCount = members.length;
    this.printBlock([
      fmt.bold(`${this.group.name} · ${members.length} members`),
      ...members.map((m) => {
        const role = String(this.group.ownerId || this.group.owner_id) === String(m.id) ? fmt.dim(' owner') : (m.isAdministrator ? fmt.dim(' admin') : '');
        const online = m.online ? fmt.color('ok', '●') : fmt.dim('○');
        return `  ${online} ${m.username || m.id}${role}`;
      }),
    ]);
    return undefined;
  }

  async cmd_channel(arg, parts) {
    if (!this.group) return this.printSystem('Open a group first.', 'error');
    const [sub, ...rest] = parts;
    const name = normalizeChannel(rest.join(' '));
    if (sub === 'new' || sub === 'create') {
      const target = name || normalizeChannel(await this.ask({ label: 'Channel name' }));
      if (!target) return undefined;
      this.client.announceChannel(this.group.id, target, 'create');
      this.rememberChannelLocal(target, { force: true });
      await this.switchChannel(target);
      return undefined;
    }
    if (sub === 'delete' || sub === 'remove') {
      const target = name;
      if (!target || target === 'main') return this.printSystem('Usage: /channel delete <name> (#main cannot be deleted)', 'error');
      if (!(await this.confirm(`Delete #${target}?`, 'This removes the channel for everyone in the group.'))) return undefined;
      await this.client.clearMessages(this.group.id, target);
      this.client.announceChannel(this.group.id, target, 'delete');
      this.channels = forgetChannel(this.group.id, target, this.paths);
      if (this.channel === target) await this.switchChannel('main');
      return undefined;
    }
    if (arg) {
      await this.switchChannel(normalizeChannel(arg));
      return undefined;
    }
    const picked = await this.choose({
      title: 'Switch channel',
      options: this.channels.map((c) => ({
        label: `#${c}`,
        value: c,
        hint: c === this.channel ? 'current' : '',
        badge: this.channelUnread[c] > 0 ? `● ${this.channelUnread[c]}` : '',
      })),
    });
    if (picked && picked !== this.channel) await this.switchChannel(picked);
    return undefined;
  }

  // ── groups & channels ──────────────────────────────────────────────────────

  async refreshGroups() {
    try {
      this.groups = (await this.client.listGroups()).map((g) => ({ ...g, name: fmt.safe(g.name) }));
    } catch (err) {
      this.flash(`Could not load groups: ${err.message || err}`, 'error');
    }
    return this.groups;
  }

  async decorate(msg, groupId) {
    const secret = this.client.getSecret(groupId);
    if (!secret) return { msg, text: null, channel: 'main', error: 'missing key', attach: null };
    if (msg.type === 'image' || msg.type === 'file') {
      const attach = await decryptAttachmentMeta(msg, secret, groupId);
      return {
        msg,
        text: null,
        channel: normalizeChannel(attach.hashtag) || 'main',
        error: null,
        attach: { filename: attach.filename, mimeType: attach.mimeType, size: attach.size },
        replyTo: null,
      };
    }
    const dec = await decryptServerMessage(msg, secret, groupId);
    return { msg, ...dec, attach: null, replyTo: this.resolveReply(msg, dec.metadata) };
  }

  resolveReply(msg, metadata) {
    const replyId = msg.replyToId || msg.reply_to || null;
    const preview = metadata?.replyPreview || null;
    if (!replyId && !preview) return null;
    const original = replyId ? this.findItem(replyId) : null;
    const [maybeName, ...rest] = String(preview || '').split(':');
    const name = original?.msg?.senderName || (preview && rest.length ? maybeName.trim() : 'message');
    return {
      id: replyId,
      name,
      preview: original ? fmt.previewText(original, 80) : (rest.length ? rest.join(':').trim() : String(preview || '')),
    };
  }

  findItem(id) {
    return this.items.find((m) => String(m.msg.id) === String(id)) || null;
  }

  upsertItem(item) {
    const id = String(item.msg.id);
    const idx = this.items.findIndex((m) => String(m.msg.id) === id);
    if (idx >= 0) this.items[idx] = item;
    else this.items.push(item);
    this.items.sort((a, b) => String(a.msg.createdAt || '').localeCompare(String(b.msg.createdAt || '')));
    if (this.items.length > 500) {
      this.items.splice(0, this.items.length - 500);
      this.hasMore = true;
    }
  }

  channelItems(channel = this.channel) {
    return this.items.filter((m) => (m.channel || 'main') === channel);
  }

  rememberChannelLocal(name, opts) {
    const prefs = loadPrefs(this.paths);
    rememberChannel(this.group.id, name, prefs, opts);
    savePrefs(prefs, this.paths);
    this.channels = listChannels(this.group.id, this.paths);
  }

  async openGroup(ref) {
    const seq = ++this.openSeq;
    this.startSpinner(`Opening ${ref.name}\u2026`);
    this.refresh();
    try {
      // History, key and unread counts are independent requests: send them together.
      // The socket joins in the background and is not needed to show messages.
      const known = listChannels(ref.id, this.paths);
      const [opened, unread] = await Promise.all([
        this.client.openGroup(ref.id, { group: ref, waitSocket: false }),
        this.client.fetchUnread(ref.id, known).catch(() => null),
      ]);
      if (seq !== this.openSeq) return;
      const items = await Promise.all((opened.messages || []).map((msg) => this.decorate(msg, ref.id)));
      if (seq !== this.openSeq) return;
      items.sort((a, b) => String(a.msg.createdAt || '').localeCompare(String(b.msg.createdAt || '')));
      this.group = opened.group || ref;
      this.items = items;
      for (const item of items) if (item.replyTo) item.replyTo = this.resolveReply(item.msg, item.metadata) || item.replyTo;
      this.hasMore = (opened.messages || []).length >= 40;
      this.lastCursorKey = '';
      this.typing.clear();
      this.replying = null;
      this.editing = null;
      this.view = 'chat';
      this.setTitle(`${this.group.name} \u00b7 GChat`);
      const prefs = loadPrefs(this.paths);
      for (const item of items) if (item.channel) rememberChannel(ref.id, item.channel, prefs);
      savePrefs(prefs, this.paths);
      this.channels = listChannels(ref.id, this.paths);
      this.channel = getActiveChannel(ref.id, this.paths);
      if (!this.channels.includes(this.channel)) this.channel = 'main';
      this.channelUnread = unread?.counts || {};
      this.unreadTags = unread?.tagIndexes || {};
      this.memberCount = 0;
      this.stopSpinner();
      const unreadHere = Number(this.channelUnread[this.channel]) || 0;
      await this.printChannelView({ reason: 'open', unread: unreadHere });
      // Everything below only fills in details; the chat is already on screen.
      this.refreshChannels(ref.id);
      this.client.listMembers(ref.id).then((m) => { this.memberCount = m.length; this.refresh(); }).catch(() => {});
      this.markReadSoon();
      const row = this.groups.find((g) => String(g.id) === String(ref.id));
      if (row) row.unreadCount = Math.max(0, (Number(row.unreadCount) || 0) - unreadHere);
    } catch (err) {
      this.stopSpinner();
      this.printSystem(`Could not open ${ref.name}: ${err.message || err}`, 'error');
    }
    this.refresh();
  }

  /** Server-side channel discovery; adds channels nobody has posted in on this device yet. */
  async refreshChannels(groupId) {
    try {
      const rows = (await this.client.fetchChannels(groupId)) || [];
      if (String(this.group?.id) !== String(groupId)) return;
      const prefs = loadPrefs(this.paths);
      for (const row of rows) {
        const name = normalizeChannel(row?.name);
        if (name) rememberChannel(groupId, name, prefs);
      }
      savePrefs(prefs, this.paths);
      this.channels = listChannels(groupId, this.paths);
      this.refreshUnread();
      this.refresh();
    } catch { /* discovery is best-effort */ }
  }

  async switchChannel(name) {
    const target = normalizeChannel(name) || 'main';
    this.channel = target;
    setActiveChannel(this.group.id, target, this.paths);
    this.channels = listChannels(this.group.id, this.paths);
    // Channels hold only their own traffic; load a little older history when the visible tail is thin.
    for (let i = 0; i < 2 && this.channelItems().length < 20 && this.hasMore; i += 1) {
      if (!(await this.loadOlder({ print: false }))) break;
    }
    await this.printChannelView({ reason: 'switch' });
    this.refreshUnread();
    this.markReadSoon();
  }

  cycleChannel(dir) {
    if (this.channels.length < 2) return;
    const at = this.channels.indexOf(this.channel);
    const next = this.channels[(at + dir + this.channels.length) % this.channels.length];
    this.switchChannel(next).catch((err) => this.flash(err.message, 'error')).finally(() => this.refresh());
  }

  async printChannelView({ reason, unread = 0 }) {
    const cols = this.screen.cols();
    const title = reason === 'open'
      ? `${this.group.name} \u00b7 #${this.channel}`
      : `#${this.channel}`;
    this.lastPrinted = null;
    this.attachments = [];
    const items = this.channelItems().slice(-OPEN_PRINT);
    // A "new messages" rule goes above the first message you haven't read.
    let dividerId = null;
    if (unread > 0) {
      const theirs = items.filter((m) => String(m.msg.senderId) !== String(this.user?.id));
      const n = Math.min(unread, theirs.length);
      if (n > 0) dividerId = theirs[theirs.length - n].msg.id;
    }
    // Decode the images we are about to show while the earlier messages print.
    for (const item of items.filter((m) => m.attach && m.msg.type === 'image').slice(-2)) this.prefetchThumb(item);
    this.enqueue(async () => {
      this.screen.commit(['', fmt.rule(title, Math.min(cols, 72), 'accent')]);
      if (!items.length) {
        this.screen.commit([fmt.dim(`  No messages in #${this.channel} yet. Say hello.`)]);
        return;
      }
      await this.printItems(items, { dividerId, thumbnailIds: new Set(items.filter((m) => m.attach && m.msg.type === 'image').slice(-2).map((m) => String(m.msg.id))) });
    });
    await this.printChain;
  }

  async loadOlder({ print = true } = {}) {
    if (!this.group || !this.hasMore) return false;
    const oldest = this.items.find((m) => m.msg.id);
    if (!oldest) return false;
    const groupId = this.group.id;
    const page = await this.client.fetchMessages(groupId, { limit: HISTORY_PAGE, before: oldest.msg.id });
    if (String(this.group?.id) !== String(groupId)) return false;
    const fresh = [];
    for (const msg of page || []) {
      if (this.findItem(msg.id)) continue;
      const item = await this.decorate(msg, groupId);
      fresh.push(item);
      this.upsertItem(item);
    }
    this.hasMore = (page || []).length >= HISTORY_PAGE;
    if (print) {
      const mine = fresh.filter((m) => (m.channel || 'main') === this.channel);
      this.enqueue(async () => {
        const cols = this.screen.cols();
        this.screen.commit(['', fmt.rule('earlier messages', Math.min(cols, 72))]);
        this.lastPrinted = null;
        if (!mine.length) this.screen.commit([fmt.dim(`  Nothing earlier in #${this.channel} in this page.${this.hasMore ? ' Try /history again.' : ''}`)]);
        else await this.printItems(mine);
      });
      await this.printChain;
    }
    return fresh.length > 0;
  }

  async cmd_history() {
    if (!this.group) return this.printSystem('Open a group first.', 'error');
    if (!this.hasMore) return this.printSystem('You have reached the start of this group.');
    this.flash('Loading earlier messages…', 'info', 15000);
    this.refresh();
    await this.loadOlder();
    this.flashState = null;
    return undefined;
  }

  // ── printing ───────────────────────────────────────────────────────────────

  enqueue(fn) {
    this.printChain = this.printChain.then(fn).catch((err) => {
      this.screen.commit([fmt.color('error', `  display error: ${err.message || err}`)]);
    });
    return this.printChain;
  }

  printSystem(text, kind = 'info') {
    const paint = kind === 'error' ? 'error' : (kind === 'ok' ? 'ok' : 'muted');
    const cols = this.screen.cols();
    const lines = wrapText(String(text), Math.max(20, cols - 4)).map((l) => `  ${fmt.color(paint, l)}`);
    this.lastPrinted = null;
    this.enqueue(async () => { this.screen.commit(lines); });
  }

  printBlock(lines) {
    this.lastPrinted = null;
    this.enqueue(async () => { this.screen.commit(['', ...lines.map((l) => (l.startsWith('  ') ? l : `  ${l}`)), '']); });
  }

  attachmentNumber(item) {
    let at = this.attachments.findIndex((a) => String(a.msg.id) === String(item.msg.id));
    if (at < 0) {
      this.attachments.push(item);
      at = this.attachments.length - 1;
    }
    return at + 1;
  }

  async printItems(items, { dividerId = null, thumbnailIds = null } = {}) {
    const cols = this.screen.cols();
    for (const item of items) {
      if (dividerId && String(item.msg.id) === String(dividerId)) {
        this.screen.commit(['', fmt.rule('new messages', Math.min(cols, 60), 'error')]);
        this.lastPrinted = null;
      }
      let label = null;
      if (item.attach) label = `${item.msg.type === 'image' ? 'Image' : 'File'} #${this.attachmentNumber(item)}`;
      const lines = fmt.messageLines(item, { cols, me: this.user?.id, prev: this.lastPrinted, attachmentLabel: label });
      this.lastPrinted = item;
      this.screen.commit(lines);
      const wantThumb = !thumbnailIds || thumbnailIds.has(String(item.msg.id));
      if (item.attach && item.msg.type === 'image' && !item.sending && this.config.preview !== 'off' && wantThumb) {
        await this.printImage(item, { thumbnail: true });
      }
    }
  }

  async materialize(item) {
    const id = String(item.msg.id);
    if (this.mediaCache.has(id)) return this.mediaCache.get(id);
    const { bytes, metadata } = await this.client.loadAttachment(this.group.id, item.msg);
    const entry = { bytes, filename: path.basename(metadata.filename || 'file'), mimeType: metadata.mimeType || '' };
    this.mediaCache.set(id, entry);
    while (this.mediaCache.size > 8) this.mediaCache.delete(this.mediaCache.keys().next().value);
    return entry;
  }

  /** Starts decrypting and rendering a thumbnail; the result is awaited when the message prints. */
  prefetchThumb(item) {
    const id = String(item.msg.id);
    if (this.thumbs.has(id)) return this.thumbs.get(id);
    const task = (async () => {
      if ((Number(item.attach?.size) || 0) > MAX_THUMB_BYTES) return null;
      const entry = await this.materialize(item);
      return this.renderImageEntry(entry, { thumbnail: true });
    })().catch((err) => ({ error: err.message || String(err) }));
    this.thumbs.set(id, task);
    while (this.thumbs.size > 12) this.thumbs.delete(this.thumbs.keys().next().value);
    return task;
  }

  renderImageEntry(entry, { thumbnail }) {
    const cols = this.screen.cols();
    const maxCols = thumbnail ? Math.min(40, cols - 6) : Math.min(100, cols - 4);
    const maxRows = thumbnail ? 12 : Math.max(12, Math.min(34, (this.stdout.rows || 30) - 8));
    if (image.supportsInlineProtocol()) {
      return { raw: `  ${image.renderInline(entry.bytes, { maxCols, name: entry.filename })}\r\n` };
    }
    const rendered = image.renderBlocks(entry.bytes, { maxCols, maxRows });
    return { lines: rendered.lines.map((l) => `  ${l}`) };
  }

  async printImage(item, { thumbnail }) {
    let result;
    if (thumbnail) {
      result = await this.prefetchThumb(item);
    } else {
      try {
        result = this.renderImageEntry(await this.materialize(item), { thumbnail: false });
      } catch (err) {
        result = { error: err.message || String(err) };
      }
    }
    if (!result) return;
    if (result.error) {
      if (!thumbnail) throw new Error(result.error);
      this.screen.commit([fmt.dim(`  (no preview: ${result.error})`)]);
    } else if (result.raw) {
      this.screen.commitRaw(result.raw);
    } else {
      this.screen.commit(result.lines);
    }
  }

  // ── attachments ────────────────────────────────────────────────────────────

  pickAttachment(arg) {
    if (!this.attachments.length) throw new Error('No attachments in this view yet.');
    const n = Number(String(arg || '').split(/\s+/)[0]);
    if (!arg || Number.isNaN(n)) {
      const latest = [...this.attachments].reverse().find((a) => a.msg.type === 'image') || this.attachments[this.attachments.length - 1];
      return { item: latest, rest: arg || '' };
    }
    const item = this.attachments[n - 1];
    if (!item) throw new Error(`No attachment #${n}.`);
    return { item, rest: String(arg).trim().split(/\s+/).slice(1).join(' ') };
  }

  async cmd_view(arg) {
    const { item } = this.pickAttachment(arg);
    if (item.msg.type !== 'image') return this.printSystem('That attachment is not an image. Use /save or /launch.', 'error');
    this.flash('Rendering…', 'info', 15000);
    this.refresh();
    await this.enqueue(async () => {
      this.screen.commit(['', `  ${fmt.dim(item.attach.filename || 'image')}`]);
      await this.printImage(item, { thumbnail: false });
    });
    this.flashState = null;
    return undefined;
  }

  async cmd_save(arg) {
    const { item, rest } = this.pickAttachment(arg);
    const entry = await this.materialize(item);
    const target = path.resolve(rest || entry.filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.bytes);
    this.printSystem(`Saved ${target}`, 'ok');
  }

  async cmd_launch(arg) {
    const { item } = this.pickAttachment(arg);
    const entry = await this.materialize(item);
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const target = path.join(MEDIA_DIR, `${String(item.msg.id).slice(0, 8)}-${entry.filename}`);
    fs.writeFileSync(target, entry.bytes);
    const plat = process.platform;
    if (plat === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    else if (plat === 'win32') spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    this.printSystem(`Opened ${entry.filename}`);
  }

  attachFile(file) {
    let stat;
    try { stat = fs.statSync(file); } catch { stat = null; }
    if (!stat || !stat.isFile()) {
      this.flash(`Not a file: ${file}`, 'error');
      return;
    }
    const filename = path.basename(file);
    this.attachment = { path: file, filename, size: stat.size, isImage: /\.(png|jpe?g|gif|webp)$/i.test(filename) };
    this.refresh();
  }

  async cmd_upload(arg) {
    if (!arg) return this.printSystem('Usage: /upload <path>', 'error');
    const cleaned = arg.replace(/^['"]|['"]$/g, '');
    this.attachFile(path.resolve(cleaned.replace(/^~(?=$|[\\/])/, os.homedir())));
    return undefined;
  }

  async pasteImage() {
    this.flash('Reading clipboard…', 'info', 8000);
    this.refresh();
    const clip = await readClipboardImage();
    if (!clip) {
      this.flash('No image on the clipboard. Paste a file path or use /upload <path>.', 'error');
      return;
    }
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const dest = path.join(MEDIA_DIR, `paste-${Date.now()}.png`);
    fs.writeFileSync(dest, clip.bytes);
    this.flashState = null;
    this.attachFile(dest);
  }

  async cmd_pasteImage() { await this.pasteImage(); }

  // ── reply / edit / delete ──────────────────────────────────────────────────

  async pickMessage(title, { mineOnly = false }) {
    const me = String(this.user?.id);
    const list = this.channelItems().filter((m) => !m.error && (!mineOnly || String(m.msg.senderId) === me)).slice(-12).reverse();
    if (!list.length) {
      this.printSystem(mineOnly ? 'You have no messages in this channel to change.' : 'No messages to pick.', 'error');
      return null;
    }
    const cols = this.screen.cols();
    return this.choose({
      title,
      options: list.map((m) => ({
        label: ansi.truncate(`${String(m.msg.senderId) === me ? 'you' : m.msg.senderName}  ${fmt.previewText(m, 60)}`, Math.max(20, cols - 24)),
        hint: fmt.formatTime(m.msg.createdAt),
        value: m,
      })),
    });
  }

  async cmd_reply() {
    const item = await this.pickMessage('Reply to which message?', {});
    if (item) {
      this.replying = item;
      this.editing = null;
    }
  }

  async cmd_edit() {
    const me = String(this.user?.id);
    const mine = this.channelItems().filter((m) => String(m.msg.senderId) === me && !m.attach && !m.error);
    const item = mine.length ? mine[mine.length - 1] : null;
    if (!item) return this.printSystem('You have no text messages here to edit.', 'error');
    const chosen = mine.length > 1 ? await this.pickMessage('Edit which message?', { mineOnly: true }) : item;
    if (!chosen || chosen.attach) return undefined;
    this.editing = chosen;
    this.replying = null;
    this.input.set(chosen.text || '');
    return undefined;
  }

  async cmd_remove() {
    const item = await this.pickMessage('Delete which message?', { mineOnly: true });
    if (!item) return;
    if (!(await this.confirm('Delete this message?', fmt.previewText(item, 120)))) return;
    await this.client.deleteMessage(this.group.id, item.msg.id);
  }

  async cmd_search(arg) {
    if (!this.group) return this.printSystem('Open a group first.', 'error');
    if (!arg) return this.printSystem('Usage: /search <text>', 'error');
    const needle = arg.toLowerCase();
    const hits = this.items.filter((m) => !m.error && (String(m.text || '').toLowerCase().includes(needle) || String(m.attach?.filename || '').toLowerCase().includes(needle)));
    if (!hits.length) return this.printSystem(`No matches for "${arg}" in the loaded messages. Use /history to load more.`);
    this.printBlock([
      fmt.bold(`${hits.length} match${hits.length === 1 ? '' : 'es'} for "${arg}"`),
      ...hits.slice(-15).map((m) => `${fmt.dim(fmt.formatTime(m.msg.createdAt))} ${fmt.color('accent', m.msg.senderName || '?')} ${fmt.dim(`#${m.channel}`)} ${fmt.previewText(m, 100)}`),
    ]);
    return undefined;
  }

  // ── realtime events ────────────────────────────────────────────────────────

  async onClientEvent(event, payload) {
    if (!this.running) return;
    switch (event) {
      case 'connect': {
        const again = this.everConnected;
        this.everConnected = true;
        this.connected = true;
        this.refresh();
        if (again && this.group) await this.backfill('reconnect');
        break;
      }
      case 'disconnect':
        this.connected = false;
        this.refresh();
        break;
      case 'connect_error':
        this.connected = false;
        this.refresh();
        break;
      case 'sync_event':
        if (payload) await this.onSyncEvent(payload);
        break;
      case 'sync_hint':
        if (payload?.groupId && String(payload.groupId) === String(this.group?.id)) await this.backfill('sync_hint');
        break;
      case 'read_cursor_updated':
        this.onReadCursor(payload);
        break;
      case 'user_typing':
        if (payload?.username && payload.username !== this.user?.username) {
          this.typing.set(payload.username, Date.now() + 3500);
          this.later(3600, () => this.refresh());
          this.refresh();
        }
        break;
      case 'user_stop_typing':
        if (payload?.username) this.typing.delete(payload.username);
        this.refresh();
        break;
      case 'channel_announced':
        if (payload?.channel && String(payload.groupId) === String(this.group?.id)) {
          const removing = payload.action === 'remove' || payload.action === 'delete';
          if (removing) {
            this.channels = forgetChannel(this.group.id, payload.channel, this.paths);
            if (this.channel === payload.channel) await this.switchChannel('main');
          } else {
            this.rememberChannelLocal(payload.channel, { force: true });
          }
          this.refresh();
        }
        break;
      case 'member_joined':
      case 'member_left':
      case 'member_kicked':
        if (String(payload?.groupId) === String(this.group?.id)) {
          this.client.listMembers(this.group.id).then((m) => { this.memberCount = m.length; this.refresh(); }).catch(() => {});
          const who = payload.username || payload.user?.username;
          if (who) this.printSystem(`${who} ${event === 'member_joined' ? 'joined' : (event === 'member_left' ? 'left' : 'was removed from')} the group.`);
        }
        break;
      case 'group_disbanded':
        if (String(payload?.groupId) === String(this.group?.id)) {
          this.printSystem(`${this.group.name} was disbanded.`, 'error');
          this.group = null;
          this.items = [];
          await this.refreshGroups();
        }
        break;
      case 'group_renamed':
        if (String(payload?.groupId) === String(this.group?.id) && payload.name) this.group.name = payload.name;
        this.refresh();
        break;
      default:
        break;
    }
  }

  async onSyncEvent(payload) {
    if (Number(payload.protocol) !== 2 || !payload.groupId) return;
    const groupId = String(payload.groupId);
    const type = String(payload.type || '');
    const active = groupId === String(this.group?.id);

    if (type === 'history.cleared') {
      if (!active) return;
      const key = String(payload.auxiliary?.channelKey || payload.channelKey || '*');
      this.items = key === '*' ? [] : this.items.filter((m) => String(m.msg.tagIndex || '') !== key);
      this.printSystem('Chat history was cleared.');
      this.refreshUnread();
      return;
    }
    if (type === 'message.deleted') {
      if (!active) return;
      const id = String(payload.entityId || payload.message?.id || '');
      const gone = this.findItem(id);
      this.items = this.items.filter((m) => String(m.msg.id) !== id);
      if (gone && (gone.channel || 'main') === this.channel) {
        const who = String(gone.msg.senderId) === String(this.user?.id) ? 'You' : (gone.msg.senderName || 'Someone');
        this.printSystem(`${who} deleted a message: "${fmt.previewText(gone, 50)}"`);
      }
      return;
    }
    if (type !== 'message.created' && type !== 'message.edited') return;
    const raw = payload.message;
    if (!raw) return;
    const fromMe = String(raw.senderId) === String(this.user?.id);

    if (!active) {
      if (type === 'message.created' && !fromMe) {
        const row = this.groups.find((g) => String(g.id) === groupId);
        if (row) row.unreadCount = (Number(row.unreadCount) || 0) + 1;
        const prefs = loadPrefs(this.paths);
        if (this.config.bell !== false && !prefs.mutedGroups?.[groupId] && !prefs.muteAll) this.stdout.write('\u0007');
        this.refresh();
      }
      return;
    }

    if (type === 'message.edited') {
      const idx = this.items.findIndex((m) => String(m.msg.id) === String(raw.id));
      if (idx < 0) return;
      if ((Number(raw.revision) || 1) < (Number(this.items[idx].msg.revision) || 1)) return;
      // Edit payloads can omit the sender's display name; keep what we already know.
      const before = this.items[idx].msg;
      const merged = { ...raw, senderName: raw.senderName && raw.senderName !== 'Unknown' ? raw.senderName : before.senderName };
      const item = await this.decorate(merged, groupId);
      this.items[idx] = item;
      if ((item.channel || 'main') === this.channel) {
        const name = String(raw.senderId) === String(this.user?.id) ? 'You' : (merged.senderName || 'Someone');
        this.enqueue(async () => {
          this.lastPrinted = null;
          this.screen.commit([`  ${fmt.dim('↻')} ${fmt.muted(`${name} edited a message:`)} ${item.text ?? ''}`]);
        });
      }
      return;
    }

    const existing = this.findItem(raw.id);
    if (existing) return;
    const item = await this.decorate(raw, groupId);
    this.upsertItem(item);
    if (item.channel) {
      const known = this.channels.includes(item.channel);
      if (!known) this.rememberChannelLocal(item.channel, {});
    }
    if ((item.channel || 'main') === this.channel) {
      this.enqueue(async () => { await this.printItems([item]); });
      if (!fromMe) {
        if (this.focused) this.markReadSoon();
        else {
          this.missedWhileAway += 1;
          this.stdout.write('\u0007');
        }
      }
    } else if (!fromMe) {
      this.channelUnread[item.channel] = (this.channelUnread[item.channel] || 0) + 1;
      this.stdout.write('\u0007');
    }
    if (fromMe) this.typing.delete(this.user.username);
    this.refresh();
  }

  async backfill(reason) {
    if (!this.running || !this.group) return;
    const now = Date.now();
    if (reason === 'sync_hint' && now - this.lastBackfillAt < BACKFILL_MIN_INTERVAL_MS) return;
    this.lastBackfillAt = now;
    const groupId = this.group.id;
    try {
      const page = await this.client.fetchMessages(groupId, { limit: 100 });
      if (String(this.group?.id) !== String(groupId)) return;
      const fresh = [];
      for (const msg of page || []) {
        if (this.findItem(msg.id)) continue;
        const item = await this.decorate(msg, groupId);
        this.upsertItem(item);
        if ((item.channel || 'main') === this.channel) fresh.push(item);
      }
      if (fresh.length) {
        this.enqueue(async () => { await this.printItems(fresh); });
        this.markReadSoon();
      }
      this.refreshUnread();
    } catch { /* the next event or reconnect retries */ }
  }

  // ── unread tracking ────────────────────────────────────────────────────────

  markReadSoon() {
    if (this.readTimer) clearTimeout(this.readTimer);
    this.readTimer = this.later(300, () => this.markRead());
  }

  markRead() {
    if (!this.focused || !this.group) return;
    const list = this.channelItems();
    let last = null;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].msg.id && String(list[i].msg.senderId) !== String(this.user?.id)) { last = list[i]; break; }
    }
    if (!last) return;
    const key = `${this.group.id}:${this.channel}:${last.msg.id}`;
    if (key === this.lastCursorKey) return;
    this.lastCursorKey = key;
    Promise.resolve(this.client.markChannelRead(this.group.id, this.channel, {
      createdAt: last.msg.createdAt,
      messageId: last.msg.id,
    })).catch(() => { this.lastCursorKey = ''; });
    this.channelUnread[this.channel] = 0;
    const row = this.groups.find((g) => String(g.id) === String(this.group.id));
    if (row) row.unreadCount = Math.max(0, Object.values(this.channelUnread).reduce((a, b) => a + b, 0));
    this.refresh();
  }

  onReadCursor(payload) {
    if (!payload?.groupId) return;
    const row = this.groups.find((g) => String(g.id) === String(payload.groupId));
    if (row) row.unreadCount = Number(payload.groupUnreadCount) || 0;
    if (String(payload.groupId) === String(this.group?.id)) {
      const tag = payload.tagIndex == null || payload.tagIndex === '' ? '' : String(payload.tagIndex);
      const name = tag === '' ? 'main' : this.unreadTags[tag];
      if (name) this.channelUnread[name] = Number(payload.channelUnreadCount) || 0;
    }
    this.refresh();
  }

  async refreshUnread() {
    if (!this.group) return;
    const groupId = this.group.id;
    try {
      const unread = await this.client.fetchUnread(groupId, this.channels);
      if (String(this.group?.id) !== String(groupId)) return;
      this.channelUnread = unread.counts;
      this.unreadTags = unread.tagIndexes;
      const row = this.groups.find((g) => String(g.id) === String(groupId));
      if (row) row.unreadCount = unread.groupUnreadCount;
      this.refresh();
    } catch { /* counts are cosmetic; the next event refreshes them */ }
  }

  // ── view ───────────────────────────────────────────────────────────────────

  flash(text, kind = 'info', ms = FLASH_MS) {
    this.flashState = { text, kind, until: Date.now() + ms };
    this.later(ms + 20, () => this.refresh());
    this.refresh();
  }

  statusLine(cols) {
    const flash = this.flashState && this.flashState.until > Date.now() ? this.flashState : null;
    if (flash) {
      const key = flash.kind === 'error' ? 'error' : 'muted';
      return `  ${fmt.color(key, ansi.truncate(flash.text, cols - 4))}`;
    }
    if (this.spinner) {
      const frames = '\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f';
      return `  ${fmt.color('accent', frames[this.spinner.frame % frames.length])} ${fmt.muted(this.spinner.text)}`;
    }
    if (this.attachment) {
      return `  ${fmt.color('warn', `[${this.attachment.isImage ? 'Image' : 'File'}]`)} ${this.attachment.filename} ${fmt.dim(`\u00b7 ${fmt.formatBytes(this.attachment.size)} \u00b7 Enter to send \u00b7 Esc to remove`)}`;
    }
    if (this.editing) return `  ${fmt.color('warn', 'Editing your message')} ${fmt.dim('\u00b7 Enter to save \u00b7 Esc to cancel')}`;
    if (this.replying) return `  ${fmt.dim('\u21aa Replying to')} ${fmt.color('accent', this.replying.msg.senderName || 'message')}${fmt.dim(`: ${ansi.truncate(fmt.previewText(this.replying, 60), Math.max(10, cols - 40))}  \u00b7 Esc to cancel`)}`;
    const names = [...this.typing].filter(([, until]) => until > Date.now()).map(([n]) => n);
    if (names.length) {
      const dots = '.'.repeat(1 + (Math.floor(Date.now() / 400) % 3));
      return `  ${fmt.dim(names.length === 1 ? `${names[0]} is typing${dots}` : `${names.slice(0, 2).join(' and ')} are typing${dots}`)}`;
    }
    if (this.everConnected && !this.connected) return `  ${fmt.color('warn', 'Reconnecting\u2026')}`;
    if (this.missedWhileAway > 0) return `  ${fmt.dim(`${this.missedWhileAway} new while you were away`)}`;
    return null;
  }

  /**
   * Lays styled segments out on one row (left group, right group) and records a
   * click target for every segment that has a handler. Right segments are
   * dropped from the left when the row is too narrow.
   */
  layoutRow(left, right, cols, row) {
    const hits = [];
    let x = 0;
    let leftText = '';
    for (const seg of left) {
      const w = ansi.width(seg.text);
      if (seg.fn) hits.push({ row, x0: x, x1: x + w, fn: seg.fn });
      leftText += seg.text;
      x += w;
    }
    const rightSegs = right.slice();
    const widthOf = (segs) => segs.reduce((n, seg) => n + ansi.width(seg.text), 0);
    while (rightSegs.length && x + 1 + widthOf(rightSegs) > cols) rightSegs.shift();
    let rightX = cols - widthOf(rightSegs);
    let rightText = '';
    for (const seg of rightSegs) {
      const w = ansi.width(seg.text);
      if (seg.fn) hits.push({ row, x0: rightX, x1: rightX + w, fn: seg.fn });
      rightText += seg.text;
      rightX += w;
    }
    const gap = Math.max(0, cols - x - widthOf(rightSegs));
    return { line: ansi.truncate(`${leftText}${' '.repeat(gap)}${rightText}`, cols), hits };
  }

  footer(cols, row) {
    const seg = (text, fn) => ({ text, fn });
    const hint = seg(fmt.dim('/ for commands  '), () => { this.input.set('/'); });
    if (this.view === 'home' || !this.group) {
      const left = [seg(fmt.dim('  Enter opens the highlighted chat \u00b7 \u2191 \u2193 to move'))];
      return this.layoutRow(left, [hint], cols, row);
    }
    const left = [
      seg('  '),
      seg(fmt.color('accent', '\u2302'), () => this.goHome()),
      seg(' '),
      seg(fmt.muted(this.group.name), () => this.pickGroup()),
      seg(fmt.dim(' \u00b7 ')),
    ];
    this.channels.forEach((c, i) => {
      if (i) left.push(seg(' '));
      const count = this.channelUnread[c] > 0 && c !== this.channel ? fmt.color('error', `(${this.channelUnread[c]})`) : '';
      const label = c === this.channel ? fmt.color('accent', fmt.bold(`#${c}`)) : `${fmt.muted(`#${c}`)}${count}`;
      left.push(seg(label, c === this.channel ? undefined : () => this.switchChannel(c)));
    });
    left.push(seg(' '), seg(fmt.dim('+'), () => this.cmd_channel('', ['new'])));
    const right = [];
    this.groups
      .filter((g) => String(g.id) !== String(this.group.id) && Number(g.unreadCount) > 0)
      .slice(0, 2)
      .forEach((g) => {
        right.push(seg(`${fmt.color('error', '\u25cf')} ${fmt.muted(ansi.truncate(g.name, 14))} ${fmt.dim(String(g.unreadCount))}  `, () => this.openGroup(g)));
      });
    if (!this.connected) right.push(seg(`${fmt.color('warn', 'offline')}  `));
    right.push(hint);
    return this.layoutRow(left, right, cols, row);
  }

  inputBox(cols) {
    const t = fmt.getTheme();
    const innerWidth = Math.max(8, cols - 4 - 2);
    const laid = this.input.layout(innerWidth - 1);
    let lines = laid.lines;
    let caretRow = laid.caret.row;
    const MAX_LINES = 6;
    let first = 0;
    if (lines.length > MAX_LINES) {
      first = Math.max(0, Math.min(caretRow - MAX_LINES + 1, lines.length - MAX_LINES));
      lines = lines.slice(first, first + MAX_LINES);
      caretRow -= first;
    }
    let content;
    if (!this.input.text) {
      const where = this.group ? `Message #${this.channel}` : 'Type / for commands';
      const placeholder = this.replying ? 'Write your reply' : where;
      content = [`${fmt.paint(t.accent, '>')} ${fmt.dim(placeholder)}`];
    } else {
      content = lines.map((l, i) => `${i === 0 ? fmt.paint(t.accent, '>') : ' '} ${l}`);
    }
    const title = this.group ? fmt.color('accent', `#${this.channel}`) : '';
    const rendered = fmt.box(content, cols, { borderKey: 'borderActive', title });
    return { lines: rendered, caret: { row: 1 + caretRow, col: 4 + laid.caret.col } };
  }

  /** The animated bird above the sign-in menu. */
  splashLines(cols) {
    const rows = this.screen.rows();
    const age = (Date.now() - this.homeStart) / 1000;
    const width = rows >= 34 ? 28 : (rows >= 28 ? 20 : 0);
    const lines = [''];
    if (width) {
      const bird = renderBird({ width, t: age, enter: Math.min(1, age / 0.9), dark: fmt.getTheme() === fmt.THEMES.dark });
      for (const line of bird) lines.push(`${' '.repeat(Math.max(0, Math.floor((cols - (width + 10)) / 2)))}${line}`);
    }
    const title = `${fmt.bold('GChat')}  ${fmt.dim(`v${CLI_VERSION}`)}`;
    const tagline = fmt.muted('Encrypted group chat, in your terminal.');
    const pad = (t) => ' '.repeat(Math.max(0, Math.floor((cols - ansi.width(t)) / 2)));
    lines.push(`${pad(title)}${title}`, `${pad(tagline)}${tagline}`, '');
    return lines;
  }

  paletteLines(menu, cols, firstRow) {
    const width = Math.max(...menu.map((c) => c.name.length + (c.usage ? c.usage.length + 1 : 0))) + 3;
    const hits = [];
    const lines = menu.map((cmd, i) => {
      const active = i === Math.min(this.paletteIndex, menu.length - 1);
      const head = `/${cmd.name}${cmd.usage ? ` ${cmd.usage}` : ''}`;
      const pad = ' '.repeat(Math.max(1, width + 1 - head.length));
      const text = `  ${head}${pad}${cmd.desc}`;
      const clipped = ansi.truncate(text, cols - 1);
      hits.push({ row: firstRow + i, x0: 0, x1: cols, fn: () => { this.paletteIndex = i; this.acceptPalette(menu); } });
      return active ? fmt.color('accent', clipped) : fmt.dim(clipped);
    });
    return { lines, hits };
  }

  refresh({ animate = false } = {}) {
    if (!this.running) return;
    const cols = this.screen.cols();
    if (this.dialog) {
      const splash = this.splash ? this.splashLines(cols) : [];
      const out = this.dialog.render(cols);
      const shifted = (this.dialog.hits || []).map((h) => ({ ...h, row: h.row + splash.length }));
      this.hits = shifted;
      const track = !animate || splash.length + (Array.isArray(out) ? out.length : out.lines.length) !== this.lastLineCount;
      this.lastLineCount = splash.length + (Array.isArray(out) ? out.length : out.lines.length);
      if (Array.isArray(out)) this.screen.render([...splash, ...out], null, { track });
      else this.screen.render([...splash, ...out.lines], { row: out.caret.row + splash.length, col: out.caret.col }, { track });
      return;
    }
    const lines = [];
    const hits = [];
    if (this.view === 'home') {
      const age = (Date.now() - this.homeStart) / 1000;
      const prefs = this.lastGroupId ? { activeGroupId: this.lastGroupId } : loadPrefs(this.paths);
      this.lastGroupId = prefs.activeGroupId;
      const home = renderHome({
        cols,
        rows: this.screen.rows(),
        t: age,
        enter: Math.min(1, age / 0.9),
        burst: this.burstAt >= 0 ? (Date.now() - this.burstAt) / 1000 : -1,
        user: this.user?.username,
        host: hostOf(this.client.server),
        connected: this.connected,
        groups: this.groups,
        selected: this.homeIndex,
        lastId: prefs.activeGroupId,
        version: CLI_VERSION,
        dark: fmt.getTheme() === fmt.THEMES.dark,
      });
      lines.push(...home.lines);
      for (const h of home.hits) {
        hits.push({ row: h.row, x0: h.x0, x1: h.x1, fn: () => { this.homeIndex = h.index; return this.activateHomeItem(h.index); } });
      }
      if (home.birdBox) {
        for (let r = 0; r < home.birdBox.rows; r += 1) {
          hits.push({ row: home.birdBox.row + r, x0: home.birdBox.x0, x1: home.birdBox.x1, fn: () => { this.burstAt = Date.now(); } });
        }
      }
    }
    const status = this.statusLine(cols);
    if (status) lines.push(status);
    const box = this.inputBox(cols);
    const caret = { row: lines.length + box.caret.row, col: box.caret.col };
    lines.push(...box.lines);
    const menu = this.paletteMatches();
    if (menu.length) {
      const palette = this.paletteLines(menu, cols, lines.length);
      lines.push(...palette.lines);
      hits.push(...palette.hits);
    } else {
      const foot = this.footer(cols, lines.length);
      lines.push(foot.line);
      hits.push(...foot.hits);
    }
    this.hits = hits;
    const track = !animate || lines.length !== this.lastLineCount;
    this.lastLineCount = lines.length;
    this.screen.render(lines, caret, { track });
  }
}

module.exports = { App, hostOf };
