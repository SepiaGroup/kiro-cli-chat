import { test } from "node:test";
import assert from "node:assert/strict";
import { fragmentSecret, GATE_TEXT, parseChatList, pickChat } from "./remoteBoot";

test("the pairing secret is read from the fragment, and only a well-formed one", () => {
  const secret = "A".repeat(43);
  assert.equal(fragmentSecret(`#k=${secret}`), secret);
  assert.equal(fragmentSecret(`#x=1&k=${secret}`), secret);
  assert.equal(fragmentSecret(`#k=${secret}&x=1`), secret);
  assert.equal(fragmentSecret(""), undefined);
  assert.equal(fragmentSecret("#k=short"), undefined);
  assert.equal(fragmentSecret(`#k=${"A".repeat(300)}`), undefined);
  assert.equal(fragmentSecret(`#k=${secret}<script>`), undefined);
  assert.equal(fragmentSecret(`#key=${secret}`), undefined);
});

test("the chat list drops malformed entries and long titles", () => {
  const list = parseChatList([
    { id: "a", title: "One", busy: true },
    { id: "", title: "x" },
    { title: "no id" },
    null,
    { id: "b", title: "x".repeat(200) },
    { id: 5, title: "n" },
  ]);
  assert.deepEqual(list.map((c) => [c.id, c.busy]), [["a", true], ["b", false]]);
  assert.equal(list[1].title.length, 80);
  assert.deepEqual(parseChatList("nope"), []);
});

test("the last chat is reopened, or the only one; otherwise the user chooses", () => {
  const a = { id: "a", title: "A", busy: false };
  const b = { id: "b", title: "B", busy: false };
  assert.equal(pickChat([a, b], "b"), "b");
  assert.equal(pickChat([a, b], "gone"), undefined);
  assert.equal(pickChat([a, b], null), undefined);
  assert.equal(pickChat([a], null), "a");
  assert.equal(pickChat([a], "zzz"), "a");
  assert.equal(pickChat([], "a"), undefined);
});

test("the start-up texts say what to do and use no em dashes", () => {
  for (const text of Object.values(GATE_TEXT)) {
    assert.ok(text.length > 5);
    assert.doesNotMatch(text, /\u2014/);
  }
  assert.match(GATE_TEXT.unpaired, /Show Remote Access Link/);
});
