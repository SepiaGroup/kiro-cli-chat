// Input line editor for the terminal chat. Pure (no vscode import).
//
// Handles raw pseudoterminal input: cursor movement, editing, history,
// multi-line input (Shift+Enter / Ctrl+J / trailing "\"), bracketed paste, and
// draws itself below the chat output with correct wrapping.

import { rowsBelowStart, style, term } from "./ansi";

export type EditorAction =
  | { type: "submit"; text: string }
  | { type: "interrupt" } // Ctrl+C
  | { type: "escape" } // lone Esc
  | { type: "eof" } // Ctrl+D on an empty line
  | { type: "complete" } // Tab
  | { type: "clearScreen" } // Ctrl+L
  | { type: "changed" }; // buffer or cursor changed → redraw

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const DEFAULT_PROMPT = "› ";

export class LineEditor {
  private chars: string[] = [];
  private cursor = 0;
  private history: string[] = [];
  private historyIdx = -1; // -1 = editing the draft
  private draft = "";
  /** Row of the cursor relative to the first prompt row (as last drawn). */
  private cursorRow = 0;
  private drawn = false;
  private pasteBuf: string | undefined;
  private promptStyled = style.bold(style.magenta(DEFAULT_PROMPT));
  private promptWidth = Array.from(DEFAULT_PROMPT).length;

  private footer: string[] = [];

  /**
   * Lines drawn under the input (e.g. the slash-command menu). Each must fit
   * in one row (cols - 1 visible characters). Takes effect on the next render.
   */
  setFooter(lines: string[]): void {
    this.footer = lines;
  }

  /**
   * Change the prompt. `styled` may contain color escapes; `plain` is the same
   * text without them (used for width). Takes effect on the next render.
   */
  setPrompt(plain: string, styled = plain): void {
    this.promptStyled = styled;
    this.promptWidth = Array.from(plain).length;
  }

  get text(): string {
    return this.chars.join("");
  }

  get isEmpty(): boolean {
    return this.chars.length === 0;
  }

  get isDrawn(): boolean {
    return this.drawn;
  }

  setText(text: string): void {
    this.chars = Array.from(text);
    this.cursor = this.chars.length;
  }

  clear(): void {
    this.chars = [];
    this.cursor = 0;
    this.historyIdx = -1;
    this.draft = "";
  }

  addHistory(text: string): void {
    if (text.trim() && this.history[this.history.length - 1] !== text) {
      this.history.push(text);
      if (this.history.length > 500) {
        this.history.shift();
      }
    }
    this.historyIdx = -1;
  }

  // --- input ---

  handleInput(data: string): EditorAction[] {
    const actions: EditorAction[] = [];
    let changed = false;
    let i = 0;

    // Continue a bracketed paste split across chunks.
    if (this.pasteBuf !== undefined) {
      const end = data.indexOf(PASTE_END);
      if (end < 0) {
        this.pasteBuf += data;
        return actions;
      }
      this.insert(normalizePaste(this.pasteBuf + data.slice(0, end)));
      this.pasteBuf = undefined;
      changed = true;
      i = end + PASTE_END.length;
    }

    // A lone ESC chunk is the Esc key (not the start of a sequence).
    if (data === "\x1b") {
      return [{ type: "escape" }];
    }

    while (i < data.length) {
      if (data.startsWith(PASTE_START, i)) {
        const from = i + PASTE_START.length;
        const end = data.indexOf(PASTE_END, from);
        if (end < 0) {
          this.pasteBuf = data.slice(from);
          break;
        }
        this.insert(normalizePaste(data.slice(from, end)));
        changed = true;
        i = end + PASTE_END.length;
        continue;
      }

      const ch = data[i];

      if (ch === "\x1b") {
        const consumed = this.handleEscape(data, i);
        i += consumed.length;
        if (consumed.changed) {
          changed = true;
        }
        continue;
      }

      i++;
      switch (ch) {
        case "\r": {
          // An unbracketed multi-line paste arrives as text with \r inside:
          // treat \r followed by more text in the same chunk as a newline.
          if (i < data.length && data.length > 1 && !data.startsWith("\x1b", i)) {
            if (data[i] === "\n") {
              i++;
            }
            this.insert("\n");
            changed = true;
            break;
          }
          // Trailing backslash = line continuation.
          if (this.chars[this.cursor - 1] === "\\" && this.cursor === this.chars.length) {
            this.chars.splice(this.cursor - 1, 1, "\n");
            changed = true;
            break;
          }
          if (changed) {
            actions.push({ type: "changed" });
            changed = false;
          }
          actions.push({ type: "submit", text: this.text });
          break;
        }
        case "\n": // Ctrl+J
          this.insert("\n");
          changed = true;
          break;
        case "\x7f":
        case "\b":
          changed = this.backspace() || changed;
          break;
        case "\x03":
          actions.push({ type: "interrupt" });
          break;
        case "\x04":
          if (this.chars.length === 0) {
            actions.push({ type: "eof" });
          } else {
            changed = this.deleteForward() || changed;
          }
          break;
        case "\x01": // Ctrl+A
          this.cursor = this.lineStart();
          changed = true;
          break;
        case "\x05": // Ctrl+E
          this.cursor = this.lineEnd();
          changed = true;
          break;
        case "\x02": // Ctrl+B
          changed = this.moveLeft() || changed;
          break;
        case "\x06": // Ctrl+F
          changed = this.moveRight() || changed;
          break;
        case "\x0b": // Ctrl+K
          this.chars.splice(this.cursor, this.lineEnd() - this.cursor);
          changed = true;
          break;
        case "\x15": {
          // Ctrl+U
          const s = this.lineStart();
          this.chars.splice(s, this.cursor - s);
          this.cursor = s;
          changed = true;
          break;
        }
        case "\x17": // Ctrl+W
          changed = this.deleteWordBack() || changed;
          break;
        case "\x0c":
          actions.push({ type: "clearScreen" });
          break;
        case "\t":
          actions.push({ type: "complete" });
          break;
        case "\x10": // Ctrl+P
          changed = this.historyPrev() || changed;
          break;
        case "\x0e": // Ctrl+N
          changed = this.historyNext() || changed;
          break;
        default:
          if (ch >= " " || ch > "\x7f") {
            // Keep surrogate pairs together.
            const cp = data.codePointAt(i - 1) ?? 0;
            const s = String.fromCodePoint(cp);
            if (s.length === 2) {
              i++;
            }
            this.insert(s);
            changed = true;
          }
          break;
      }
    }
    if (changed) {
      actions.push({ type: "changed" });
    }
    return actions;
  }

  private handleEscape(data: string, i: number): { length: number; changed: boolean } {
    const next = data[i + 1];
    if (next === "\r" || next === "\n") {
      // Shift/Alt+Enter → newline.
      this.insert("\n");
      return { length: 2, changed: true };
    }
    if (next === "[" || next === "O") {
      // CSI / SS3: params then a final byte in @-~.
      let j = i + 2;
      while (j < data.length && /[0-9;?]/.test(data[j])) {
        j++;
      }
      const params = data.slice(i + 2, j);
      const final = data[j] ?? "";
      const length = j - i + 1;
      const mod = params.split(";")[1] ?? "";
      const word = mod === "3" || mod === "5" || mod === "9";
      let changed = true;
      switch (final) {
        case "A":
          changed = this.moveUp() || this.historyPrev();
          break;
        case "B":
          changed = this.moveDown() || this.historyNext();
          break;
        case "C":
          changed = word ? this.wordRight() : this.moveRight();
          break;
        case "D":
          changed = word ? this.wordLeft() : this.moveLeft();
          break;
        case "H":
          this.cursor = this.lineStart();
          break;
        case "F":
          this.cursor = this.lineEnd();
          break;
        case "~":
          if (params === "3") {
            changed = this.deleteForward();
          } else if (params === "1" || params === "7") {
            this.cursor = this.lineStart();
          } else if (params === "4" || params === "8") {
            this.cursor = this.lineEnd();
          } else {
            changed = false;
          }
          break;
        default:
          changed = false;
      }
      return { length: Math.min(length, data.length - i), changed };
    }
    // Alt+<key>
    switch (next) {
      case "b":
        return { length: 2, changed: this.wordLeft() };
      case "f":
        return { length: 2, changed: this.wordRight() };
      case "\x7f":
        return { length: 2, changed: this.deleteWordBack() };
      default:
        return { length: next === undefined ? 1 : 2, changed: false };
    }
  }

  // --- editing primitives ---

  private insert(s: string): void {
    const add = Array.from(s);
    this.chars.splice(this.cursor, 0, ...add);
    this.cursor += add.length;
  }

  private backspace(): boolean {
    if (this.cursor === 0) {
      return false;
    }
    this.chars.splice(this.cursor - 1, 1);
    this.cursor--;
    return true;
  }

  private deleteForward(): boolean {
    if (this.cursor >= this.chars.length) {
      return false;
    }
    this.chars.splice(this.cursor, 1);
    return true;
  }

  private deleteWordBack(): boolean {
    const to = this.cursor;
    const from = this.wordStartBefore(to);
    if (from === to) {
      return false;
    }
    this.chars.splice(from, to - from);
    this.cursor = from;
    return true;
  }

  private moveLeft(): boolean {
    if (this.cursor === 0) {
      return false;
    }
    this.cursor--;
    return true;
  }

  private moveRight(): boolean {
    if (this.cursor >= this.chars.length) {
      return false;
    }
    this.cursor++;
    return true;
  }

  private wordStartBefore(pos: number): number {
    let p = pos;
    while (p > 0 && /\s/.test(this.chars[p - 1])) {
      p--;
    }
    while (p > 0 && !/\s/.test(this.chars[p - 1])) {
      p--;
    }
    return p;
  }

  private wordLeft(): boolean {
    const p = this.wordStartBefore(this.cursor);
    const moved = p !== this.cursor;
    this.cursor = p;
    return moved;
  }

  private wordRight(): boolean {
    let p = this.cursor;
    const n = this.chars.length;
    while (p < n && /\s/.test(this.chars[p])) {
      p++;
    }
    while (p < n && !/\s/.test(this.chars[p])) {
      p++;
    }
    const moved = p !== this.cursor;
    this.cursor = p;
    return moved;
  }

  private lineStart(pos = this.cursor): number {
    let p = pos;
    while (p > 0 && this.chars[p - 1] !== "\n") {
      p--;
    }
    return p;
  }

  private lineEnd(pos = this.cursor): number {
    let p = pos;
    while (p < this.chars.length && this.chars[p] !== "\n") {
      p++;
    }
    return p;
  }

  /** Move to the same column on the previous logical line, if any. */
  private moveUp(): boolean {
    const s = this.lineStart();
    if (s === 0) {
      return false;
    }
    const col = this.cursor - s;
    const prevStart = this.lineStart(s - 1);
    this.cursor = Math.min(prevStart + col, s - 1);
    return true;
  }

  private moveDown(): boolean {
    const e = this.lineEnd();
    if (e >= this.chars.length) {
      return false;
    }
    const col = this.cursor - this.lineStart();
    const nextStart = e + 1;
    this.cursor = Math.min(nextStart + col, this.lineEnd(nextStart));
    return true;
  }

  private historyPrev(): boolean {
    if (this.history.length === 0) {
      return false;
    }
    if (this.historyIdx === -1) {
      this.draft = this.text;
      this.historyIdx = this.history.length - 1;
    } else if (this.historyIdx > 0) {
      this.historyIdx--;
    } else {
      return false;
    }
    this.setText(this.history[this.historyIdx]);
    return true;
  }

  private historyNext(): boolean {
    if (this.historyIdx === -1) {
      return false;
    }
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      this.setText(this.history[this.historyIdx]);
    } else {
      this.historyIdx = -1;
      this.setText(this.draft);
    }
    return true;
  }

  // --- drawing ---

  /**
   * Bytes that draw the prompt + buffer, assuming the cursor is at column 0 of
   * an empty area. Leaves the terminal cursor at the edit position.
   */
  render(cols: number): string {
    const width = Math.max(4, cols);
    const lines = this.text.split("\n");
    let out = "";
    let row = 0;
    const lineStartRow: number[] = [];
    let freshRow = false; // cursor already at column 0 of an empty row
    lines.forEach((line, idx) => {
      lineStartRow.push(row);
      out += (idx === 0 ? this.promptStyled : " ".repeat(this.promptWidth)) + line;
      const k = this.promptWidth + Array.from(line).length;
      if (idx < lines.length - 1) {
        out += "\r\n";
        row += rowsBelowStart(k, width) + 1;
      } else if (k % width === 0) {
        // Exactly filled: step onto the next row so positions stay simple.
        out += "\r\n";
        row += k / width;
        freshRow = true;
      } else {
        row += Math.floor(k / width);
      }
    });
    for (const line of this.footer) {
      out += (freshRow ? "" : "\r\n") + line;
      if (!freshRow) {
        row++;
      }
      freshRow = false;
    }
    const endRow = row;

    // Where the cursor should be.
    let li = 0;
    let offset = this.cursor;
    for (; li < lines.length; li++) {
      const len = Array.from(lines[li]).length;
      if (offset <= len) {
        break;
      }
      offset -= len + 1;
    }
    li = Math.min(li, lines.length - 1);
    const len = Array.from(lines[li]).length;
    const j = this.promptWidth + offset;
    const k = this.promptWidth + len;
    let cRow: number;
    let cCol: number;
    if (offset === len && k % width === 0 && li < lines.length - 1) {
      cRow = lineStartRow[li] + k / width - 1;
      cCol = width - 1;
    } else {
      cRow = lineStartRow[li] + Math.floor(j / width);
      cCol = j % width;
    }
    out += term.up(endRow - cRow) + "\r" + term.right(cCol);
    this.cursorRow = cRow;
    this.drawn = true;
    return out;
  }

  /** Bytes that erase the drawn prompt, leaving the cursor at its column 0. */
  erase(): string {
    if (!this.drawn) {
      return "";
    }
    const out = "\r" + term.up(this.cursorRow) + term.clearToEnd;
    this.cursorRow = 0;
    this.drawn = false;
    return out;
  }

  /** Erase + redraw. */
  redraw(cols: number): string {
    return this.erase() + this.render(cols);
  }
}

function normalizePaste(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
}
