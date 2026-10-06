'use strict';

/**
 * Turns raw stdin chunks into key events.
 *
 * Event shape: { name, ch, ctrl, alt, shift }
 * name is one of: char, enter, newline, backspace, delete, up, down, left,
 * right, home, end, pageup, pagedown, tab, escape, ctrl (with ch = letter).
 * Bracketed paste and focus reports are delivered through their own callbacks.
 */

const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

const CSI_LETTERS = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end',
};
const CSI_TILDE = {
  1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end',
};

function mods(code) {
  const m = Math.max(0, (Number(code) || 1) - 1);
  return { shift: !!(m & 1), alt: !!(m & 2), ctrl: !!(m & 4) };
}

function key(name, extra = {}) {
  return { name, ch: '', ctrl: false, alt: false, shift: false, ...extra };
}

/** Maps a CSI `code;mod u` / `27;mod;code ~` key (kitty / modifyOtherKeys) to an event. */
function fromCodepoint(code, modifier) {
  const m = mods(modifier);
  if (code === 13) return key('enter', m);
  if (code === 27) return key('escape', m);
  if (code === 9) return key('tab', m);
  if (code === 127 || code === 8) return key('backspace', m);
  if (code >= 32 && code !== 127) {
    const ch = String.fromCodePoint(code);
    if (m.ctrl) return key('ctrl', { ch: ch.toLowerCase(), alt: m.alt, shift: m.shift });
    return key('char', { ch, alt: m.alt, shift: m.shift });
  }
  return null;
}

function parseCsi(params, final) {
  const parts = params.split(';');
  if (final === 'u') {
    return fromCodepoint(Number(parts[0]), parts[1]);
  }
  if (final === '~') {
    if (parts[0] === '27' && parts.length === 3) return fromCodepoint(Number(parts[2]), parts[1]);
    const name = CSI_TILDE[Number(parts[0])];
    return name ? key(name, mods(parts[1])) : null;
  }
  if (final === 'Z') return key('tab', { shift: true });
  const name = CSI_LETTERS[final];
  if (name) return key(name, mods(parts[1]));
  return null;
}

function createKeyParser({ onKey, onPaste, onFocus, onMouse, onCursor } = {}) {
  let pasting = false;
  let pasteBuf = '';
  let carry = '';

  return function feed(chunk) {
    let s = carry + String(chunk);
    carry = '';
    let i = 0;
    const emit = (event) => { if (event && onKey) onKey(event); };

    while (i < s.length) {
      if (pasting) {
        const end = s.indexOf(PASTE_END, i);
        if (end < 0) {
          pasteBuf += s.slice(i);
          return;
        }
        pasteBuf += s.slice(i, end);
        pasting = false;
        const text = pasteBuf;
        pasteBuf = '';
        if (onPaste) onPaste(text);
        i = end + PASTE_END.length;
        continue;
      }

      const c = s[i];
      if (c === '\u001b') {
        if (s.startsWith(PASTE_START, i)) {
          pasting = true;
          pasteBuf = '';
          i += PASTE_START.length;
          continue;
        }
        const rest = s.slice(i);
        if (rest === '\u001b') {
          emit(key('escape'));
          i += 1;
          continue;
        }
        if (rest[1] === '[') {
          const m = /^\u001b\[([0-9;?<]*)([A-Za-z~])/.exec(rest);
          if (!m) {
            // Incomplete sequence at the end of a chunk: wait for the rest.
            if (/^\u001b\[[0-9;?<]*$/.test(rest)) {
              carry = rest;
              return;
            }
            emit(key('escape', { alt: true }));
            i += 2;
            continue;
          }
          if (m[2] === 'I' || m[2] === 'O') {
            if (onFocus) onFocus(m[2] === 'I');
          } else if ((m[2] === 'M' || m[2] === 'm') && m[1].startsWith('<')) {
            // SGR mouse report: button;column;row (1-based), `m` marks the release.
            const [button, x, y] = m[1].slice(1).split(';').map(Number);
            if (onMouse && Number.isFinite(x) && Number.isFinite(y)) {
              onMouse({
                button: button & 3,
                wheel: button & 64 ? (button & 1 ? 'down' : 'up') : null,
                motion: !!(button & 32),
                release: m[2] === 'm',
                shift: !!(button & 4),
                x,
                y,
              });
            }
          } else if (m[2] === 'R' && /^\d+;\d+$/.test(m[1])) {
            // Cursor position report answering our ESC[6n.
            const [row, col] = m[1].split(';').map(Number);
            if (onCursor) onCursor(row, col);
          } else {
            emit(parseCsi(m[1], m[2]));
          }
          i += m[0].length;
          continue;
        }
        if (rest[1] === 'O' && rest.length >= 3) {
          const name = CSI_LETTERS[rest[2]];
          if (name) emit(key(name));
          i += 3;
          continue;
        }
        // ESC <char>: alt+char
        const next = String.fromCodePoint(rest.codePointAt(1));
        if (next === '\r' || next === '\n') emit(key('enter', { alt: true }));
        else if (next === '\u007f' || next === '\b') emit(key('backspace', { alt: true }));
        else if (next >= ' ') emit(key('char', { ch: next, alt: true }));
        i += 1 + next.length;
        continue;
      }
      if (c === '\r') {
        emit(key('enter'));
        i += 1;
        continue;
      }
      if (c === '\n') {
        emit(key('newline'));
        i += 1;
        continue;
      }
      if (c === '\t') {
        emit(key('tab'));
        i += 1;
        continue;
      }
      if (c === '\u007f' || c === '\b') {
        emit(key('backspace'));
        i += 1;
        continue;
      }
      const code = c.charCodeAt(0);
      if (code < 32) {
        emit(key('ctrl', { ch: String.fromCharCode(code + 96), ctrl: true }));
        i += 1;
        continue;
      }
      const cp = String.fromCodePoint(s.codePointAt(i));
      emit(key('char', { ch: cp }));
      i += cp.length;
    }
  };
}

module.exports = { createKeyParser, PASTE_START, PASTE_END };
