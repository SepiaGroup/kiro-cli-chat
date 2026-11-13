import { test } from "node:test";
import assert from "node:assert/strict";
import { AcpClient } from "./acpClient";
import type { ChatEvent } from "./types";

type Sent = { id: number; result: Record<string, unknown> };

/** A client with the wire stubbed out: records what it would send. */
function fakeClient(): { client: AcpClient; sent: Sent[]; events: ChatEvent[] } {
  const client = new AcpClient({ cliPath: "kiro-cli", engine: "v3", cwd: "/ws" });
  const sent: Sent[] = [];
  const events: ChatEvent[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).sendResponse = (id: number, result: Record<string, unknown>) => sent.push({ id, result });
  client.on("event", (e: ChatEvent) => events.push(e));
  return { client, sent, events };
}

const OPTIONS = [
  { optionId: "accept", name: "Allow", kind: "allow_once" },
  { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Deny", kind: "reject_once" },
  { optionId: "always-reject", name: "Always deny", kind: "reject_always" },
];

function ask(client: AcpClient, id: number, consent: Record<string, unknown>, toolCallId = `t${id}`): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).handleServerRequest(id, "session/request_permission", {
    sessionId: "s",
    toolCall: { toolCallId, status: "pending", title: String(consent.resource ?? "") },
    options: OPTIONS,
    _meta: { kiro: { consent } },
  });
}

const shell = { capability: "shell", resource: "cat a.ts", workspaceRoot: "/ws" };
const consentOf = (s: Sent) => (s.result._meta as { kiro: Record<string, unknown> }).kiro;

test("the approval event carries the request id", () => {
  const { client, events } = fakeClient();
  ask(client, 3, shell);
  const ev = events.find((e) => e.kind === "approvalRequest");
  assert.equal(ev?.kind === "approvalRequest" ? ev.requestId : undefined, 3);
});

test("rules are sent as the TUI sends them", () => {
  const { client, sent } = fakeClient();
  ask(client, 1, shell);
  client.respondToApproval(1, { optionId: "always-accept", rule: "pattern" });
  ask(client, 2, shell);
  client.respondToApproval(2, { optionId: "always-accept", rule: "exact" });
  ask(client, 3, shell);
  client.respondToApproval(3, { optionId: "always-reject", rule: "tool" });
  ask(client, 4, shell);
  client.respondToApproval(4, "accept");
  assert.deepEqual(sent[0].result, {
    outcome: { outcome: "selected", optionId: "always-accept" },
    _meta: { kiro: { consent: { capability: "shell", scope: "session", resource: "cat *", workspaceRoot: "/ws" } } },
  });
  assert.equal((consentOf(sent[1]).consent as Record<string, unknown>).resource, "cat a.ts");
  assert.deepEqual(consentOf(sent[2]).consent, { capability: "shell", scope: "session", resource: "*", workspaceRoot: "/ws" });
  // Allow once: this call only.
  assert.deepEqual(consentOf(sent[3]).consent, { capability: "shell", scope: "invocation", workspaceRoot: "/ws" });
});

test("a folder rule sends folder/** and rejects an invalid folder", () => {
  const { client, sent } = fakeClient();
  ask(client, 1, { capability: "fs_write", resource: "src/a/b.ts", workspaceRoot: "/ws" });
  assert.throws(() => client.respondToApproval(1, { optionId: "always-accept", rule: "folder", folder: "lib" }), /must contain/);
  assert.equal(sent.length, 0);
  // Still pending after the error, so it can be answered properly.
  client.respondToApproval(1, { optionId: "always-accept", rule: "folder", folder: "src" });
  assert.equal((consentOf(sent[0]).consent as Record<string, unknown>).resource, "src/**");
});

test("deny with a reason sends rejectionReason, with or without consent info", () => {
  const { client, sent } = fakeClient();
  ask(client, 1, shell);
  client.respondToApproval(1, { optionId: "reject", reason: "  use rg instead  " });
  assert.equal(consentOf(sent[0]).rejectionReason, "use rg instead");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).handleServerRequest(2, "session/request_permission", {
    toolCall: { toolCallId: "r", title: "Review changes" },
    options: OPTIONS.filter((o) => !o.kind.endsWith("always")),
  });
  client.respondToApproval(2, { optionId: "reject", reason: "wrong file" });
  assert.deepEqual(sent[1].result._meta, { kiro: { rejectionReason: "wrong file" } });
});

test("an entire-tool rule also answers other approvals waiting for that tool", () => {
  const { client, sent, events } = fakeClient();
  ask(client, 1, shell);
  ask(client, 2, { capability: "shell", resource: "ls", workspaceRoot: "/ws" });
  ask(client, 3, { capability: "fs_read", resource: "/x", workspaceRoot: "/ws" });
  client.respondToApproval(1, { optionId: "always-accept", rule: "tool" });
  assert.deepEqual(
    sent.map((s) => [s.id, (s.result.outcome as { optionId: string }).optionId]),
    [
      [1, "always-accept"],
      [2, "accept"],
    ]
  );
  const resolved = events.filter((e) => e.kind === "approvalResolved");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].kind === "approvalResolved" && resolved[0].toolCallId, "t2");
  // A pattern rule leaves the others alone.
  const b = fakeClient();
  ask(b.client, 1, shell);
  ask(b.client, 2, { capability: "shell", resource: "cat b", workspaceRoot: "/ws" });
  b.client.respondToApproval(1, { optionId: "always-accept", rule: "pattern" });
  assert.equal(b.sent.length, 1);
});
