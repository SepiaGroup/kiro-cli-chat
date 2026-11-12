import { test } from "node:test";
import assert from "node:assert/strict";
import { mapSessionUpdate, mapStreamJsonEvent } from "./eventMapper";
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
