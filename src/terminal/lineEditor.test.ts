import { test } from "node:test";
import assert from "node:assert/strict";
import { LineEditor } from "./lineEditor";

const types = (a: Array<{ type: string }>) => a.map((x) => x.type);

test("typing and Enter submits the text", () => {
  const ed = new LineEditor();
  assert.deepEqual(types(ed.handleInput("hi")), ["changed"]);
  const acts = ed.handleInput("\r");
  assert.deepEqual(acts, [{ type: "submit", text: "hi" }]);
});

test("cursor movement and editing", () => {
  const ed = new LineEditor();
  ed.handleInput("helo");
  ed.handleInput("\x1b[D"); // left
  ed.handleInput("l");
  assert.equal(ed.text, "hello");
  ed.handleInput("\x01X"); // Ctrl+A, insert at start
  assert.equal(ed.text, "Xhello");
  ed.handleInput("\x05\x7f"); // End, backspace
  assert.equal(ed.text, "Xhell");
  ed.handleInput("\x01\x1b[3~"); // Home, Delete
  assert.equal(ed.text, "hell");
});

test("word delete and kill line", () => {
  const ed = new LineEditor();
  ed.handleInput("one two three");
  ed.handleInput("\x17");
  assert.equal(ed.text, "one two ");
  ed.handleInput("\x15");
  assert.equal(ed.text, "");
});

test("Shift+Enter (ESC CR), Ctrl+J and trailing backslash insert newlines", () => {
  const ed = new LineEditor();
  ed.handleInput("a\x1b\rb\nc\\");
  ed.handleInput("\r");
  assert.equal(ed.text, "a\nb\nc\n");
  const acts = ed.handleInput("d\r");
  assert.deepEqual(acts.at(-1), { type: "submit", text: "a\nb\nc\nd" });
});

test("bracketed paste keeps newlines, even split across chunks", () => {
  const ed = new LineEditor();
  ed.handleInput("\x1b[200~line1\r\nli");
  assert.equal(ed.text, "");
  const acts = ed.handleInput("ne2\x1b[201~");
  assert.equal(ed.text, "line1\nline2");
  assert.deepEqual(types(acts), ["changed"]);
});

test("unbracketed multi-line paste doesn't submit mid-paste", () => {
  const ed = new LineEditor();
  const acts = ed.handleInput("x\ry");
  assert.equal(ed.text, "x\ny");
  assert.ok(!types(acts).includes("submit"));
});

test("history navigation with up/down restores the draft", () => {
  const ed = new LineEditor();
  ed.addHistory("first");
  ed.addHistory("second");
  ed.handleInput("draft");
  ed.handleInput("\x1b[A");
  assert.equal(ed.text, "second");
  ed.handleInput("\x1b[A");
  assert.equal(ed.text, "first");
  ed.handleInput("\x1b[B\x1b[B");
  assert.equal(ed.text, "draft");
});

test("control keys map to actions", () => {
  const ed = new LineEditor();
  assert.deepEqual(types(ed.handleInput("\x03")), ["interrupt"]);
  assert.deepEqual(types(ed.handleInput("\x04")), ["eof"]);
  assert.deepEqual(types(ed.handleInput("\t")), ["complete"]);
  assert.deepEqual(types(ed.handleInput("\x1b")), ["escape"]);
});

test("render positions the cursor; erase returns to the prompt start", () => {
  const ed = new LineEditor();
  ed.handleInput("abc\x1b[D");
  const out = ed.render(80);
  // prompt "› " (2 cols) + "abc", then back to column 2+2=4.
  assert.ok(out.endsWith("\r\x1b[4C"));
  assert.equal(ed.erase(), "\r\x1b[J");
});

test("render handles wrapping and multi-line", () => {
  const ed = new LineEditor();
  ed.setText("x".repeat(18) + "\nyy"); // line 1: 20 cols → exactly 2 rows of 10
  const out = ed.render(10);
  // Cursor at end of "yy": row 2, col 4 → no upward move needed.
  assert.ok(out.endsWith("\r\x1b[4C"));
  assert.equal(ed.erase(), "\r\x1b[2A\x1b[J");
});

test("emoji (surrogate pairs) are one character", () => {
  const ed = new LineEditor();
  ed.handleInput("a😀b");
  ed.handleInput("\x1b[D\x7f");
  assert.equal(ed.text, "ab");
});

test("custom prompt width is used for cursor position and continuation lines", () => {
  const ed = new LineEditor();
  ed.setPrompt("17% !> ", "\x1b[90m17%\x1b[39m !> ");
  ed.setText("ab\ncd");
  const out = ed.render(80);
  assert.ok(out.startsWith("\x1b[90m17%\x1b[39m !> ab\r\n       cd"));
  // Cursor after "cd" on the second row: column 7 + 2 = 9.
  assert.ok(out.endsWith("\r\x1b[9C"));
});

test("footer lines are drawn below the input and the cursor returns to the input", () => {
  const ed = new LineEditor();
  ed.setText("/co");
  ed.setFooter(["  /code", "  /compact"]);
  const out = ed.render(80);
  assert.ok(out.includes("/co\r\n  /code\r\n  /compact"));
  // Two rows down for the footer → move up 2, then to column 2+3=5.
  assert.ok(out.endsWith("\x1b[2A\r\x1b[5C"));
  // Erase clears from the prompt row down, which includes the footer.
  assert.equal(ed.erase(), "\r\x1b[J");
});
