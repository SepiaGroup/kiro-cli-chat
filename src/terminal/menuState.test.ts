import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "./ansi";
import { MenuState } from "./menuState";

const values = () => [{ value: "claude", desc: "Claude" }, { value: "auto" }];

test("the menu shows for '/', moves with arrows, completes with Tab and hides with Esc", () => {
  const m = new MenuState();
  assert.deepEqual(m.update("hello", true, [], values, 80), []);
  const lines = m.update("/mod", true, [], values, 80).map(stripAnsi);
  assert.match(lines[0], /^› \/model/);
  assert.match(lines.at(-1) ?? "", /↑↓ select/);
  assert.deepEqual(m.handleKey("\t"), { type: "setText", text: "/model " });
  assert.deepEqual(m.handleKey("x"), undefined);
  assert.deepEqual(m.handleKey("\x1b"), { type: "redraw" });
  assert.deepEqual(m.update("/mod", true, [], values, 80), []);
  // Typing something else brings it back.
  assert.ok(m.update("/mode", true, [], values, 80).length > 0);
  assert.deepEqual(m.update("/mod", false, [], values, 80), [], "hidden while busy");
});

test("values after a command; Enter submits a complete one", () => {
  const m = new MenuState();
  const lines = m.update("/model ", true, [], values, 80).map(stripAnsi);
  assert.match(lines[0], /^› auto/);
  assert.match(lines[1], /claude/);
  m.handleKey("\x1b[B");
  assert.match(stripAnsi(m.update("/model ", true, [], values, 80)[1]), /^› claude/);
  assert.deepEqual(m.handleKey("\r"), { type: "submit", text: "/model claude" });
});
