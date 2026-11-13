import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "./ansi";
import { diffText, highlightPaths, ToolLog } from "./toolLog";

test("a tool call, its diff once, and its completion once", () => {
  let now = 1000;
  const log = new ToolLog(() => now);
  const start = log.start({ kind: "toolCall", toolCallId: "1", title: "Edit src/a.ts", paths: ["src/a.ts", "src/b.ts"] });
  assert.equal(start.title, "Edit src/a.ts");
  assert.deepEqual(stripAnsi(start.text).split("\n"), ["● Edit src/a.ts", "  src/b.ts"]);
  const diff = { path: "src/a.ts", oldText: "x\n", newText: "y\n" };
  const u1 = log.update({ kind: "toolUpdate", toolCallId: "1", status: "in_progress", diff, startLine: 10 });
  assert.deepEqual(stripAnsi(u1.diff ?? "").split("\n"), ["  -   10: x", "  +   10: y"]);
  assert.equal(u1.status, undefined);
  now = 3500;
  const u2 = log.update({ kind: "toolUpdate", toolCallId: "1", status: "completed", diff });
  assert.equal(u2.diff, undefined);
  assert.equal(stripAnsi(u2.status ?? ""), "  – Completed in 2.5s");
  assert.deepEqual(log.update({ kind: "toolUpdate", toolCallId: "1", status: "completed" }), {});
});

test("a failure names the tool when another ran since, with its output", () => {
  const log = new ToolLog(() => 0);
  log.start({ kind: "toolCall", toolCallId: "1", title: "Run make" });
  log.start({ kind: "toolCall", toolCallId: "2", title: "Read x" });
  const out = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  const u = log.update({ kind: "toolUpdate", toolCallId: "1", status: "failed", output: out });
  const lines = stripAnsi(u.status ?? "").split("\n");
  assert.equal(lines[0], "  – Run make failed");
  assert.equal(lines.length, 10);
  assert.equal(lines.at(-1), "    … 2 more lines");
});

test("diffText needs new text; highlightPaths colors the longest match", () => {
  assert.equal(diffText({ path: "a", oldText: null, newText: undefined as unknown as string }), undefined);
  assert.equal(stripAnsi(diffText({ path: "a", oldText: null, newText: "n" }) ?? ""), "  +    1: n");
  const h = highlightPaths("Edit /a/b.ts and /a", ["/a", "/a/b.ts"]);
  assert.equal(stripAnsi(h), "Edit /a/b.ts and /a");
  assert.ok(h.includes("\x1b[35m/a/b.ts"));
});
