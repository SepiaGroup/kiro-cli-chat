import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePath, pickSessions } from "./sessionList";
import type { SessionSummary } from "./types";

const s = (sessionId: string, source: string, cwd: string, updatedAt: string): SessionSummary => ({
  sessionId, source, cwd, updatedAt, title: sessionId, messageCount: 1,
});

test("normalizePath drops trailing slashes and /private", () => {
  assert.equal(normalizePath("/private/tmp/x/"), "/tmp/x");
  assert.equal(normalizePath("/"), "/");
});

test("pickSessions prefers this engine and folder, newest first, without the open one", () => {
  const all = [
    s("old", "v3", "/w", "2026-01-01"),
    s("new", "v3", "/w/", "2026-02-01"),
    s("open", "v3", "/w", "2026-03-01"),
    s("elsewhere", "v3", "/x", "2026-04-01"),
    s("v2", "v2", "/w", "2026-05-01"),
  ];
  assert.deepEqual(pickSessions(all, "v3", "/w", "open").map((x) => x.sessionId), ["new", "old"]);
  assert.deepEqual(pickSessions(all, "v3", "/none").map((x) => x.sessionId), ["elsewhere", "open", "new", "old"]);
  assert.deepEqual(pickSessions(all, "v1", "/w").map((x) => x.sessionId), ["v2", "elsewhere", "open", "new", "old"]);
});
