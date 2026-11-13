import { test } from "node:test";
import assert from "node:assert/strict";
import { deliver, UiTarget, UiTargets } from "./uiTargets";

function screen(): UiTarget & { got: unknown[] } {
  const got: unknown[] = [];
  return { got, postMessage: (m) => void got.push(m) };
}

test("the desktop gets messages at once, a remote screen only after it is ready", () => {
  const t = new UiTargets();
  const desk = screen();
  const phone = screen();
  t.add(desk, "desktop");
  t.add(phone, "remote");
  t.broadcast("a");
  assert.deepEqual(desk.got, ["a"]);
  assert.deepEqual(phone.got, []);
  t.markReady(phone);
  t.broadcast("b");
  assert.deepEqual(desk.got, ["a", "b"]);
  assert.deepEqual(phone.got, ["b"]);
});

test("a removed screen gets nothing more", () => {
  const t = new UiTargets();
  const a = screen();
  const b = screen();
  t.add(a, "desktop");
  t.add(b, "remote");
  t.markReady(b);
  t.remove(b);
  t.broadcast("x");
  assert.deepEqual(a.got, ["x"]);
  assert.deepEqual(b.got, []);
  assert.equal(t.size, 1);
  assert.equal(t.remoteCount, 0);
});

test("postToDesktop needs a ready desktop page and skips remote screens", () => {
  const t = new UiTargets();
  const desk = screen();
  const phone = screen();
  t.add(desk, "desktop");
  t.add(phone, "remote");
  t.markReady(phone);
  assert.equal(t.postToDesktop("resume"), false);
  t.markReady(desk);
  assert.equal(t.postToDesktop("resume"), true);
  assert.deepEqual(desk.got, ["resume"]);
  assert.deepEqual(phone.got, []);
});

test("a screen that throws or rejects does not stop the others", async () => {
  const t = new UiTargets();
  const bad: UiTarget = {
    postMessage: () => {
      throw new Error("disposed");
    },
  };
  const rejecting: UiTarget = { postMessage: () => Promise.reject(new Error("closed")) };
  const ok = screen();
  t.add(bad, "desktop");
  t.add(rejecting, "remote");
  t.markReady(rejecting);
  t.add(ok, "remote");
  t.markReady(ok);
  t.broadcast("m");
  await new Promise((r) => setImmediate(r)); // an unhandled rejection would fail the run
  assert.deepEqual(ok.got, ["m"]);
  deliver(bad, "x");
});

test("a page that is replaced is not ready until it says so again", () => {
  const t = new UiTargets();
  const phone = screen();
  t.add(phone, "remote");
  t.markReady(phone);
  t.markNotReady(phone);
  t.broadcast("m");
  assert.deepEqual(phone.got, []);
  assert.equal(t.kindOf(phone), "remote");
  assert.equal(t.has(phone), true);
});

test("unknown screens are ignored", () => {
  const t = new UiTargets();
  const s = screen();
  t.markReady(s);
  t.remove(s);
  assert.equal(t.kindOf(s), undefined);
  assert.equal(t.postToDesktop("x"), false);
});
