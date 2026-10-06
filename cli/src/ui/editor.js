'use strict';

const { layoutText } = require('./screen');

const MAX_HISTORY = 100;

function prevBoundary(text, index) {
  if (index <= 0) return 0;
  const code = text.charCodeAt(index - 1);
  if (code >= 0xdc00 && code <= 0xdfff && index >= 2) {
    const hi = text.charCodeAt(index - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return index - 2;
  }
  return index - 1;
}

function nextBoundary(text, index) {
  if (index >= text.length) return text.length;
  const code = text.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) return index + 2;
  return index + 1;
}

/** Multi-line text editor state for the input box. */
class Editor {
  constructor({ mask = false, history = [] } = {}) {
    this.text = '';
    this.caret = 0;
    this.mask = mask;
    this.history = history.slice(-MAX_HISTORY);
    this.historyIndex = -1;
    this.draft = '';
  }

  set(text) {
    this.text = String(text);
    this.caret = this.text.length;
  }

  clear() {
    this.text = '';
    this.caret = 0;
    this.historyIndex = -1;
  }

  insert(str) {
    const clean = String(str).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (!clean) return;
    this.text = this.text.slice(0, this.caret) + clean + this.text.slice(this.caret);
    this.caret += clean.length;
  }

  backspace() {
    if (this.caret === 0) return false;
    const from = prevBoundary(this.text, this.caret);
    this.text = this.text.slice(0, from) + this.text.slice(this.caret);
    this.caret = from;
    return true;
  }

  del() {
    if (this.caret >= this.text.length) return;
    const to = nextBoundary(this.text, this.caret);
    this.text = this.text.slice(0, this.caret) + this.text.slice(to);
  }

  left() { this.caret = prevBoundary(this.text, this.caret); }

  right() { this.caret = nextBoundary(this.text, this.caret); }

  lineStart() {
    const at = this.text.lastIndexOf('\n', this.caret - 1);
    return at < 0 ? 0 : at + 1;
  }

  lineEnd() {
    const at = this.text.indexOf('\n', this.caret);
    return at < 0 ? this.text.length : at;
  }

  home() { this.caret = this.lineStart(); }

  end() { this.caret = this.lineEnd(); }

  wordLeft() {
    let i = this.caret;
    while (i > 0 && /\s/.test(this.text[i - 1])) i -= 1;
    while (i > 0 && !/\s/.test(this.text[i - 1])) i -= 1;
    this.caret = i;
  }

  wordRight() {
    let i = this.caret;
    while (i < this.text.length && /\s/.test(this.text[i])) i += 1;
    while (i < this.text.length && !/\s/.test(this.text[i])) i += 1;
    this.caret = i;
  }

  deleteWordBack() {
    const end = this.caret;
    this.wordLeft();
    this.text = this.text.slice(0, this.caret) + this.text.slice(end);
  }

  killToEnd() {
    const end = this.text[this.caret] === '\n' ? this.caret + 1 : this.lineEnd();
    this.text = this.text.slice(0, this.caret) + this.text.slice(end);
  }

  killToStart() {
    const start = this.lineStart();
    this.text = this.text.slice(0, start) + this.text.slice(this.caret);
    this.caret = start;
  }

  /** Moves the caret one line up/down; returns false at the first/last line. */
  moveLine(dir) {
    const start = this.lineStart();
    const col = this.caret - start;
    if (dir < 0) {
      if (start === 0) return false;
      const prevEnd = start - 1;
      const prevStart = this.text.lastIndexOf('\n', prevEnd - 1) + 1;
      this.caret = prevStart + Math.min(col, prevEnd - prevStart);
      return true;
    }
    const end = this.lineEnd();
    if (end >= this.text.length) return false;
    const nextStart = end + 1;
    const nextEndAt = this.text.indexOf('\n', nextStart);
    const nextEnd = nextEndAt < 0 ? this.text.length : nextEndAt;
    this.caret = nextStart + Math.min(col, nextEnd - nextStart);
    return true;
  }

  /** Up/down arrows: move within the text, else walk the submit history. */
  historyStep(dir) {
    if (!this.history.length) return;
    if (this.historyIndex === -1) {
      if (dir > 0) return;
      this.draft = this.text;
      this.historyIndex = this.history.length - 1;
    } else {
      const next = this.historyIndex + dir;
      if (next < 0) return;
      if (next >= this.history.length) {
        this.historyIndex = -1;
        this.set(this.draft);
        return;
      }
      this.historyIndex = next;
    }
    this.set(this.history[this.historyIndex]);
  }

  arrow(dir) {
    if (this.moveLine(dir)) return;
    if (this.text.indexOf('\n') < 0 || this.historyIndex !== -1) this.historyStep(dir);
  }

  /** Records a submitted line in history and clears the editor. */
  submit() {
    const value = this.text;
    if (!this.mask && value.trim() && this.history[this.history.length - 1] !== value) {
      this.history.push(value);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
    this.clear();
    return value;
  }

  layout(cols) {
    return layoutText(this.text, cols, this.caret, { mask: this.mask });
  }
}

module.exports = { Editor };
