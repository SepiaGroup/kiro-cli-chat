import { test } from "node:test";
import assert from "node:assert/strict";
import { EventLog } from "./eventLog";

test("numbers messages and says what came after a number", () => {
  const log = new EventLog<string>();
  assert.equal(log.lastSeq, 0);
  assert.deepEqual(log.after(0), []);
  log.push("a");
  log.push("b");
  log.push("c");
  assert.equal(log.lastSeq, 3);
  assert.deepEqual(log.after(1)?.map((e) => e.msg), ["b", "c"]);
  assert.deepEqual(log.after(3), []);
  assert.deepEqual(log.after(0)?.map((e) => e.msg), ["a", "b", "c"]);
});

test("a number from the future, or from before the log, gets no answer", () => {
  const log = new EventLog<number>(4);
  for (let i = 1; i <= 20; i++) {
    log.push(i);
  }
  assert.equal(log.after(99), undefined);
  assert.equal(log.after(2), undefined);
  const recent = log.after(18);
  assert.deepEqual(recent?.map((e) => e.msg), [19, 20]);
  assert.equal(log.after(1), undefined);
});

test("the log stays bounded", () => {
  const log = new EventLog<number>(10);
  for (let i = 1; i <= 1000; i++) {
    log.push(i);
  }
  assert.equal(log.lastSeq, 1000);
  assert.ok((log.after(985)?.length ?? 0) <= 15);
  assert.equal(log.after(900), undefined);
});

test("ids carry the epoch, and ids from another log are not trusted", () => {
  const a = new EventLog();
  const b = new EventLog();
  a.push("x");
  assert.equal(a.parseId(a.idOf(1)), 1);
  assert.equal(a.parseId(b.idOf(1)), undefined);
  assert.equal(a.parseId("1"), undefined);
  assert.equal(a.parseId(undefined), undefined);
  assert.equal(a.parseId(`${a.epoch}:abc`), undefined);
  assert.equal(a.parseId(`${a.epoch}:99999999999999999999`), undefined);
});
