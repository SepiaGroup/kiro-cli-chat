import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines } from "./lineDiff";

test("new file: every line is an addition with new line numbers", () => {
  const d = diffLines(null, "a\nb\n");
  assert.deepEqual(d, [
    { kind: "add", lineNo: 1, text: "a" },
    { kind: "add", lineNo: 2, text: "b" },
  ]);
});

test("modified line shows as delete + add", () => {
  const d = diffLines("x\ny\nz", "x\nY\nz");
  const kinds = d.map((l) => `${l.kind}:${l.lineNo}:${l.text}`);
  assert.deepEqual(kinds, ["ctx:1:x", "del:2:y", "add:2:Y", "ctx:3:z"]);
});

test("far-away unchanged lines collapse into a gap", () => {
  const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
  const neu = old.replace("l10", "CHANGED");
  const d = diffLines(old, neu, 1);
  assert.ok(d.some((l) => l.kind === "gap"));
  assert.ok(d.some((l) => l.kind === "add" && l.text === "CHANGED"));
  assert.ok(!d.some((l) => l.text === "l0"));
});
