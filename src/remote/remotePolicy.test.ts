import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_PERMISSIONS, checkRemoteMessage, MAX_REMOTE_PROMPT, parsePermissions, Permission } from "./remotePolicy";

const ALL = [...ALL_PERMISSIONS];
const ok = (raw: unknown, perms: Permission[] = ALL) => {
  const r = checkRemoteMessage(raw, perms);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.ok ? r.msg : { type: "" };
};
const refused = (raw: unknown, status: number, perms: Permission[] = ALL) => {
  const r = checkRemoteMessage(raw, perms);
  assert.equal(r.ok, false, JSON.stringify(raw));
  if (!r.ok) {
    assert.equal(r.status, status, r.reason);
  }
};

test("bad shapes are refused", () => {
  for (const raw of [null, undefined, 5, "x", [], {}, { type: 5 }, { type: "x".repeat(50) }]) {
    refused(raw, 400);
  }
});

test("only the listed message types get through", () => {
  for (const type of [
    "login",
    "newTab",
    "restart",
    "newSession",
    "resumeSession",
    "loadSession",
    "pickAttachment",
    "attachPaths",
    "debugLog",
    "setAutoApprove",
    "__proto__",
    "constructor",
  ]) {
    refused({ type }, 403);
  }
});

test("view, prompt and approve are separate permissions", () => {
  ok({ type: "ready" }, ["view"]);
  refused({ type: "sendPrompt", text: "hi" }, 403, ["view"]);
  refused({ type: "cancelTurn" }, 403, ["view"]);
  refused({ type: "approve", toolCallId: "t", optionId: "allow_once" }, 403, ["view", "prompt"]);
  refused({ type: "ready" }, 403, ["prompt", "approve"]);
  ok({ type: "approve", toolCallId: "t", optionId: "allow_once" }, ["approve"]);
  refused({ type: "ready" }, 403, []);
});

test("parsePermissions keeps the known ones and defaults to all", () => {
  assert.deepEqual(parsePermissions(undefined), ALL);
  assert.deepEqual(parsePermissions("view"), ALL);
  assert.deepEqual(parsePermissions(["prompt", "view", "root"]), ["view", "prompt"]);
  assert.deepEqual(parsePermissions([]), []);
});

test("an approval keeps the answer and the reason but never a rule or folder", () => {
  const m = ok({
    type: "approve",
    toolCallId: "t1",
    optionId: "reject_once",
    reason: "no thanks",
    rule: "entire-tool",
    folder: "/",
    extra: true,
  });
  assert.deepEqual(m, { type: "approve", toolCallId: "t1", optionId: "reject_once", reason: "no thanks" });
  refused({ type: "approve", optionId: "allow_once" }, 400);
  refused({ type: "approve", toolCallId: "t", optionId: "" }, 400);
  refused({ type: "approve", toolCallId: "t".repeat(300), optionId: "a" }, 400);
  assert.equal((ok({ type: "approve", toolCallId: "t", optionId: "a", reason: "x".repeat(5000) }).reason as string).length, 2000);
});

test("prompts: text and images, size limited, nothing else passes", () => {
  assert.deepEqual(ok({ type: "sendPrompt", text: "hello", secret: 1 }), { type: "sendPrompt", text: "hello", images: [] });
  refused({ type: "sendPrompt" }, 400);
  refused({ type: "sendPrompt", text: "   " }, 400);
  refused({ type: "sendPrompt", text: "x".repeat(MAX_REMOTE_PROMPT + 1) }, 413);
  const withImage = ok({
    type: "sendPrompt",
    text: "",
    images: [{ mimeType: "image/png", data: "AAAA", name: "a.png" }, { mimeType: "text/html", data: "AAAA" }, "junk"],
  });
  assert.deepEqual(withImage.images, [{ mimeType: "image/png", data: "AAAA", name: "a.png" }]);
});

test("steering, answers, mode and settings", () => {
  assert.deepEqual(ok({ type: "steerPrompt", text: " also this " }), { type: "steerPrompt", text: "also this" });
  refused({ type: "steerPrompt", text: " " }, 400);
  assert.deepEqual(ok({ type: "answerQuestion", toolCallId: "q", answer: " red " }), { type: "answerQuestion", toolCallId: "q", answer: "red" });
  assert.deepEqual(ok({ type: "answerQuestion", toolCallId: "q", answer: "" }), { type: "answerQuestion", toolCallId: "q" });
  refused({ type: "answerQuestion", answer: "x" }, 400);
  assert.deepEqual(ok({ type: "setMode", modeId: "plan" }), { type: "setMode", modeId: "plan" });
  refused({ type: "setMode" }, 400);
  assert.deepEqual(ok({ type: "setConfig", id: "model", value: "auto" }), { type: "setConfig", id: "model", value: "auto" });
  assert.deepEqual(ok({ type: "setConfig", id: "effortLevel", value: "high" }), { type: "setConfig", id: "effortLevel", value: "high" });
  for (const id of ["autopilot", "memoryReflection", "contentCollection", "anything"]) {
    refused({ type: "setConfig", id, value: "on" }, 403);
  }
  refused({ type: "setConfig", id: "model" }, 400);
});

test("simple requests carry no fields", () => {
  assert.deepEqual(ok({ type: "cancelTurn", x: 1 }), { type: "cancelTurn" });
  assert.deepEqual(ok({ type: "compact" }), { type: "compact" });
  assert.deepEqual(ok({ type: "getContextBreakdown" }), { type: "getContextBreakdown" });
});
