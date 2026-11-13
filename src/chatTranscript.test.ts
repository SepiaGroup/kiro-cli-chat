import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatTranscript, MAX_TRANSCRIPT } from "./chatTranscript";

const ev = (event: Record<string, unknown>) => ({ type: "event", event });

test("replay: ready first, then messages, then the latest state snapshots", () => {
  const t = new ChatTranscript();
  t.record({ type: "ready", n: 1 });
  t.record(ev({ kind: "configOptions", n: 1 }));
  t.record({ type: "userMessage", text: "hi" });
  t.record(ev({ kind: "assistantChunk", text: "yo" }));
  t.record(ev({ kind: "configOptions", n: 2 }));
  t.record(ev({ kind: "contextUsage", usagePercentage: 3 }));
  t.record({ type: "status", text: "ignored" });
  assert.deepEqual(t.replay(), [
    { type: "ready", n: 1 },
    { type: "userMessage", text: "hi" },
    ev({ kind: "assistantChunk", text: "yo" }),
    ev({ kind: "configOptions", n: 2 }),
    ev({ kind: "contextUsage", usagePercentage: 3 }),
  ]);
  t.record({ type: "cleared" });
  assert.equal(t.replay().length, 3);
});

test("answered approvals don't come back on restore", () => {
  const t = new ChatTranscript();
  t.record(ev({ kind: "approvalRequest", request: { toolCallId: "a" } }));
  t.record(ev({ kind: "approvalRequest", request: { toolCallId: "b" } }));
  t.dropApprovalCard("a");
  t.record(ev({ kind: "approvalResolved", toolCallId: "b", label: "Allowed by rule" }));
  assert.deepEqual(t.replay(), [ev({ kind: "approvalResolved", toolCallId: "b", label: "Allowed by rule" })]);
});

test("keeps at most MAX_TRANSCRIPT messages", () => {
  const t = new ChatTranscript();
  for (let i = 0; i < MAX_TRANSCRIPT + 5; i++) {
    t.record({ type: "notice", i });
  }
  const r = t.replay() as Array<{ i: number }>;
  assert.equal(r.length, MAX_TRANSCRIPT);
  assert.equal(r[0].i, 5);
});
