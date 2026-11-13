import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonLineParser, lineSplitter } from "./jsonLineParser";

test("parses complete JSON lines", () => {
  const p = new JsonLineParser();
  const out = p.push('{"a":1}\n{"b":2}\n');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { type: "json", value: { a: 1 } });
  assert.deepEqual(out[1], { type: "json", value: { b: 2 } });
});

test("buffers partial lines across chunks", () => {
  const p = new JsonLineParser();
  assert.equal(p.push('{"a":').length, 0);
  const out = p.push('1}\n');
  assert.deepEqual(out, [{ type: "json", value: { a: 1 } }]);
});

test("treats non-JSON lines as raw (log tolerance)", () => {
  const p = new JsonLineParser();
  const out = p.push('[INFO] starting\n{"ok":true}\n');
  assert.equal(out[0].type, "raw");
  assert.equal(out[1].type, "json");
});

test("skips blank lines", () => {
  const p = new JsonLineParser();
  const out = p.push('\n\n{"a":1}\n');
  assert.equal(out.length, 1);
});

test("flush returns trailing content", () => {
  const p = new JsonLineParser();
  p.push('{"a":1}');
  assert.deepEqual(p.flush(), { type: "json", value: { a: 1 } });
  assert.equal(p.flush(), undefined);
});

test("malformed JSON becomes raw, not a throw", () => {
  const p = new JsonLineParser();
  const out = p.push('{bad json}\n');
  assert.deepEqual(out, [{ type: "raw", text: "{bad json}" }]);
});

test("lineSplitter keeps a partial line for the next chunk", () => {
  const lines: string[] = [];
  const s = lineSplitter((l) => lines.push(l));
  s.push("a\nb");
  s.push("c\r\nd");
  assert.deepEqual(lines, ["a", "bc"]);
  s.flush();
  assert.deepEqual(lines, ["a", "bc", "d"]);
});
