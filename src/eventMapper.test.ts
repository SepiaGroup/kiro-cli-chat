import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPermissionRequest, mapSessionUpdate, mapStreamJsonEvent } from "./eventMapper";
import type { ChatEvent } from "./types";

test("maps runStarted", () => {
  const ev = mapStreamJsonEvent({
    type: "runStarted",
    data: { engine: "v2" },
  });
  assert.deepEqual(ev, [{ kind: "runStarted", engine: "v2" }]);
});

test("maps metadata with sessionId, context, credits", () => {
  const ev = mapStreamJsonEvent({
    type: "metadata",
    data: {
      sessionId: "abc",
      contextUsagePercentage: 1.7,
      meteringUsage: [{ value: 0.03, unit: "credit" }],
    },
  });
  assert.deepEqual(ev, [
    { kind: "sessionId", sessionId: "abc" },
    { kind: "contextUsage", usagePercentage: 1.7 },
    { kind: "metering", credits: 0.03 },
  ]);
});

test("maps agent_message_chunk to assistantChunk", () => {
  const ev = mapStreamJsonEvent({
    type: "sessionUpdate",
    data: {
      sessionId: "s",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    },
  });
  assert.ok(ev.some((e: ChatEvent) => e.kind === "assistantChunk" && e.text === "hello"));
});

test("maps tool_call with diff and paths", () => {
  const ev = mapStreamJsonEvent({
    type: "sessionUpdate",
    data: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Creating hello.txt",
        kind: "edit",
        locations: [{ path: "/tmp/hello.txt" }],
        content: [{ type: "diff", path: "/tmp/hello.txt", oldText: null, newText: "hi\n" }],
      },
    },
  });
  const tc = ev.find((e: ChatEvent) => e.kind === "toolCall") as Extract<ChatEvent, { kind: "toolCall" }>;
  assert.ok(tc);
  assert.equal(tc.toolCallId, "t1");
  assert.deepEqual(tc.paths, ["/tmp/hello.txt"]);
  assert.equal(tc.diff?.newText, "hi\n");
});

test("maps v3 pending_interaction to approvalRequest", () => {
  const ev = mapStreamJsonEvent({
    type: "sessionUpdate",
    data: {
      update: {
        sessionUpdate: "session_info_update",
        _meta: {
          kiro: {
            kind: "pending_interaction",
            interactionType: "tool_approval",
            toolCallId: "t9",
            question: "Write File",
            options: [
              { optionId: "accept", name: "Allow", kind: "allow_once" },
              { optionId: "reject", name: "Deny", kind: "reject_once" },
            ],
          },
        },
      },
    },
  });
  const ap = ev.find((e: ChatEvent) => e.kind === "approvalRequest") as Extract<ChatEvent, { kind: "approvalRequest" }>;
  assert.ok(ap);
  assert.equal(ap.request.toolCallId, "t9");
  assert.equal(ap.request.options.length, 2);
});

test("maps runFinished", () => {
  const ev = mapStreamJsonEvent({
    type: "runFinished",
    data: { status: "success", stopReason: "end_turn", finalText: "done" },
  });
  assert.deepEqual(ev, [
    { kind: "runFinished", status: "success", stopReason: "end_turn", finalText: "done" },
  ]);
});

test("ignores unknown event types", () => {
  assert.deepEqual(mapStreamJsonEvent({ type: "whoKnows", data: {} }), []);
  assert.deepEqual(mapStreamJsonEvent("not an object"), []);
});

test("maps v3 context_usage with breakdown to usedTokens + threshold", () => {
  const ev: ChatEvent[] = mapStreamJsonEvent({
    type: "sessionUpdate",
    data: {
      update: {
        sessionUpdate: "session_info_update",
        _meta: {
          kiro: {
            kind: "context_usage",
            contextUsage: { usagePercentage: 2.5, summarizationThreshold: 80 },
            breakdown: {
              tools: { tokens: 5150 },
              kiroResponses: { tokens: 27 },
              yourPrompts: { tokens: 1 },
              memory: { tokens: 0 },
            },
          },
        },
      },
    },
  });
  assert.deepEqual(ev, [
    { kind: "contextUsage", usagePercentage: 2.5, usedTokens: 5178, threshold: 80 },
  ]);
});

test("maps user_message_chunk (session replay) to userMessage", () => {
  const ev = mapStreamJsonEvent({
    type: "sessionUpdate",
    data: {
      update: { sessionUpdate: "user_message_chunk", content: { text: "hello from the past" } },
    },
  });
  assert.deepEqual(ev, [{ kind: "userMessage", text: "hello from the past" }]);
});

test("maps agent_thought_chunk to thinking", () => {
  const ev = mapStreamJsonEvent({
    type: "sessionUpdate",
    data: { update: { sessionUpdate: "agent_thought_chunk", content: { text: "..." } } },
  });
  assert.deepEqual(ev, [{ kind: "thinking" }]);
});

test("maps user_message_id_assigned and turn_completion summaries", () => {
  const info = (kiro: Record<string, unknown>) => ({ update: { sessionUpdate: "session_info_update", _meta: { kiro } } });
  assert.deepEqual(mapSessionUpdate(info({ kind: "user_message_id_assigned", userMessageId: "m1" })), [
    { kind: "userMessageId", messageId: "m1" },
  ]);
  const evs = mapSessionUpdate(
    info({ kind: "turn_completion", elapsedTime: 1828, status: "success", requestIds: ["r1"],
      promptTurnSummaries: [{ unit: "credit", usage: 0.09 }] })
  );
  assert.deepEqual(evs, [
    { kind: "turnCompletion", elapsedMs: 1828, requestIds: ["r1"], status: "success" },
    { kind: "metering", credits: 0.09 },
  ]);
});

test("mapPermissionRequest names the command being asked about in a compound line", () => {
  const params = (resource: string, round: number) => ({
    toolCall: { toolCallId: "run_1", status: "pending", title: "ls /tmp && cat a | head -1" },
    options: [
      { optionId: "accept", name: "Allow", kind: "allow_once" },
      { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
    ],
    _meta: { kiro: { toolId: "run_command", consent: { capability: "shell", triggeringResource: resource }, consentRound: round } },
  });
  const r = mapPermissionRequest(params("cat a", 2));
  assert.equal(r.toolCallId, "run_1");
  assert.equal(r.question, "ls /tmp && cat a | head -1");
  assert.equal(r.part, "cat a");
  assert.equal(r.round, 2);
  assert.equal(r.options[1].optionId, "always-accept");
  // A single command: nothing extra to show.
  const single = mapPermissionRequest({
    toolCall: { toolCallId: "run_2", title: "echo four" },
    options: [],
    _meta: { kiro: { consent: { triggeringResource: "echo four" }, consentRound: 1 } },
  });
  assert.equal(single.part, undefined);
  assert.equal(single.round, undefined);
});

const permission = (consent: Record<string, unknown>, title = "Read File", kiro: Record<string, unknown> = {}) => ({
  sessionId: "s1",
  toolCall: { toolCallId: "t1", status: "pending", title },
  options: [
    { optionId: "accept", name: "Allow", kind: "allow_once" },
    { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
    { optionId: "reject", name: "Deny", kind: "reject_once" },
    { optionId: "always-reject", name: "Always deny", kind: "reject_always" },
  ],
  _meta: { kiro: { consent, ...kiro } },
});

const rules = (list: ReadonlyArray<{ kind: string; label: string; description: string; resource?: string }> = []) =>
  list.map((r) => [r.kind, r.label, r.description, r.resource]);

test("a file read offers this file or the entire tool, like the kiro-cli TUI", () => {
  const r = mapPermissionRequest(permission({ capability: "fs_read", resource: "/tmp/a.txt", askType: "implicit" }));
  assert.equal(r.capability, "fs_read");
  assert.equal(r.tool, "Read File");
  assert.equal(r.sessionId, "s1");
  assert.deepEqual(r.options.map((o) => o.name), ["Allow", "Create allow rule…", "Deny", "Create deny rule…"]);
  assert.deepEqual(rules(r.allowRules), [
    ["exact", 'Trust "/tmp/a.txt"', "exact match · session", "/tmp/a.txt"],
    ["tool", "Trust entire tool (Read File)", "every file read · session", "*"],
  ]);
  assert.deepEqual(rules(r.denyRules), [
    ["exact", 'Deny "/tmp/a.txt"', "exact match · session", "/tmp/a.txt"],
    ["tool", "Deny entire tool (Read File)", "every file read · session", "*"],
  ]);
});

test("a shell command offers exact, pattern and entire tool", () => {
  const r = mapPermissionRequest(
    permission({ capability: "shell", resource: "cat a.ts; ls", triggeringResource: "cat a.ts", workspaceRoot: "/ws" }, "cat a.ts; ls")
  );
  assert.equal(r.workspaceRoot, "/ws");
  assert.equal(r.resource, "cat a.ts");
  assert.deepEqual(rules(r.allowRules), [
    ["exact", 'Trust "cat a.ts"', "exact match · session", "cat a.ts"],
    ["pattern", 'Trust "cat *"', "pattern · session", "cat *"],
    ["tool", "Trust entire tool (Run Command)", "every command · session", "*"],
  ]);
  // sudo: the first word says nothing about what runs, so no pattern.
  const sudo = mapPermissionRequest(permission({ capability: "shell", resource: "sudo rm x" }, "sudo rm x"));
  assert.deepEqual(sudo.allowRules?.map((x) => x.kind), ["exact", "tool"]);
});

test("a file change in the workspace also offers its folder", () => {
  const r = mapPermissionRequest(
    permission({ capability: "fs_write", resource: "src/a/b.ts", workspaceRoot: "/ws" }, "Write File")
  );
  const folder = r.allowRules?.find((x) => x.kind === "folder");
  assert.deepEqual(folder?.folder, { prefill: "src/a", target: "src/a/b.ts", inWorkspace: true });
  assert.equal(folder?.label, "Allow a folder for this session…");
  assert.deepEqual(r.allowRules?.map((x) => x.kind), ["exact", "folder", "tool"]);
  // Not for deny rules, and not for a file at the workspace root.
  assert.deepEqual(r.denyRules?.map((x) => x.kind), ["exact", "tool"]);
  const root = mapPermissionRequest(permission({ capability: "fs_write", resource: "README.md", workspaceRoot: "/ws" }));
  assert.deepEqual(root.allowRules?.map((x) => x.kind), ["exact", "tool"]);
});

test("the trust classifier's reason is shown", () => {
  const r = mapPermissionRequest(
    permission({ capability: "shell", resource: "rm -rf build" }, "rm -rf build", {
      trustClassifier: { decision: "prompt", reason: "Deletes files." },
    })
  );
  assert.equal(r.flag, "Deletes files.");
});

test("approvals without consent info keep the engine's options", () => {
  const r = mapPermissionRequest({
    toolCall: { toolCallId: "t2", title: "Review changes" },
    options: [
      { optionId: "accept", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Deny", kind: "reject_once" },
    ],
  });
  assert.deepEqual(r.options.map((o) => o.name), ["Allow", "Deny"]);
  assert.equal(r.allowRules, undefined);
});

test("steering updates map to steer events", () => {
  const upd = (kiro: Record<string, unknown>) => ({ sessionId: "s", update: { sessionUpdate: "session_info_update", _meta: { kiro } } });
  assert.deepEqual(mapSessionUpdate(upd({ kind: "steering_queued", messageId: "steer-1", content: "x" })).filter((e) => e.kind === "steer"), [
    { kind: "steer", state: "queued", messageIds: ["steer-1"] },
  ]);
  assert.deepEqual(mapSessionUpdate(upd({ kind: "steering_injected", messageId: "steer-1" })).filter((e) => e.kind === "steer"), [
    { kind: "steer", state: "injected", messageIds: ["steer-1"] },
  ]);
  assert.deepEqual(mapSessionUpdate(upd({ kind: "steering_cleared", messageIds: ["a", 5, "b"] })).filter((e) => e.kind === "steer"), [
    { kind: "steer", state: "cleared", messageIds: ["a", "b"] },
  ]);
  assert.deepEqual(mapSessionUpdate(upd({ kind: "steering_queued" })).filter((e) => e.kind === "steer"), []);
});
