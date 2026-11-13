import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalPrompt } from "./approvalPrompt";
import { stripAnsi } from "./ansi";
import type { ApprovalAnswer, ApprovalRequest, RpcId } from "../types";

const OPTIONS = [
  { kind: "allow_once", optionId: "a1", name: "Allow" },
  { kind: "allow_always", optionId: "a2", name: "Create allow rule…" },
  { kind: "reject_once", optionId: "r1", name: "Deny" },
  { kind: "reject_always", optionId: "r2", name: "Create deny rule…" },
];

function req(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolCallId: "t",
    question: "Run find . -name x",
    options: OPTIONS,
    resource: "find . -name x",
    allowRules: [
      { kind: "exact", label: "This command", description: "find . -name x" },
      { kind: "pattern", label: "Command pattern", description: "find *" },
    ],
    denyRules: [{ kind: "tool", label: "Entire tool", description: "every command" }],
    ...over,
  };
}

function setup(canRespond = true) {
  const printed: string[] = [];
  const written: string[] = [];
  const answers: Array<[RpcId, ApprovalAnswer]> = [];
  const p = new ApprovalPrompt({
    print: (t) => printed.push(stripAnsi(t)),
    write: (t) => written.push(t),
    cols: () => 80,
    canRespond: () => canRespond,
    respond: (id, a) => answers.push([id, a]),
  });
  const keys = (...ks: string[]) => ks.forEach((k) => p.handleKey(k));
  return { p, printed, written, answers, keys };
}

test("first screen lists allow choices, then deny choices", () => {
  const { p, printed } = setup();
  p.enqueue(req({ part: "find . -name x", round: 1, flag: "Reads outside the workspace" }), 7);
  assert.equal(p.active, true);
  assert.deepEqual(printed[0].split("\n"), [
    "? Run find . -name x",
    "  command 1: find . -name x",
    "  ! Reads outside the workspace",
    "  [y] Allow  [t] Create allow rule…  [n] Deny  [Tab] Deny with reason  [d] Create deny rule…",
  ]);
});

test("y allows once; n (or Esc) denies once", () => {
  const s = setup();
  s.p.enqueue(req(), 1);
  s.keys("Y");
  s.p.enqueue(req(), 2);
  s.keys("\x1b");
  assert.deepEqual(s.answers, [[1, { optionId: "a1" }], [2, { optionId: "r1" }]]);
  assert.equal(s.p.active, false);
  assert.match(s.printed.join("\n"), /→ Allow[\s\S]*→ Deny/);
});

test("t opens the rule list; a number picks a rule; Esc goes back", () => {
  const s = setup();
  s.p.enqueue(req(), 3);
  s.keys("t");
  assert.match(s.printed.at(-1) ?? "", /Create allow rule: "find \. -name x"\n {2}\[1\] This command {5}find \. -name x\n {2}\[2\] Command pattern {2}find \*/);
  s.keys("9");
  assert.deepEqual(s.written, ["\x07"]);
  s.keys("\x1b");
  assert.match(s.printed.at(-1) ?? "", /^\? Run find/);
  s.keys("t", "2");
  assert.deepEqual(s.answers, [[3, { optionId: "a2", rule: "pattern" }]]);
});

test("Tab asks for a reason, typed with backspace, sent on Enter", () => {
  const s = setup();
  s.p.enqueue(req(), 4);
  s.keys("\t", "too slo", "\x7f", "ow", "\r");
  assert.deepEqual(s.answers, [[4, { optionId: "r1", reason: "too slow" }]]);
  assert.match(s.printed.at(-1) ?? "", /→ Deny: too slow/);
});

test("folder rule: prefilled, validated, sent as a folder", () => {
  const s = setup();
  const folder = { prefill: "src", target: "src/a.ts", inWorkspace: true };
  s.p.enqueue(req({ allowRules: [{ kind: "folder", label: "Folder", description: "src/**", folder }] }), 5);
  s.keys("t", "1");
  assert.match(stripAnsi(s.written.at(-1) ?? ""), /Folder to allow \(Enter to allow, Esc to go back\): src$/);
  s.keys("\x15", "lib", "\r");
  assert.equal(s.answers.length, 0);
  assert.equal(s.p.active, true);
  s.keys("\x15", "src", "\r");
  assert.deepEqual(s.answers, [[5, { optionId: "a2", rule: "folder", folder: "src" }]]);
});

test("approvals queue up; one answered by a rule elsewhere is dropped from the queue", () => {
  const s = setup();
  s.p.enqueue(req({ question: "first" }), 1);
  s.p.enqueue(req({ question: "second" }), 2);
  s.p.enqueue(req({ question: "third" }), 3);
  s.p.resolved({ kind: "approvalResolved", toolCallId: "t", requestId: 2, allowed: true, label: "Allowed by rule" });
  assert.match(s.printed.at(-1) ?? "", /✓ Allowed by rule: second/);
  s.keys("y");
  assert.match(s.printed.at(-1) ?? "", /^\? third/);
  s.keys("y");
  assert.deepEqual(s.answers.map((a) => a[0]), [1, 3]);
  assert.equal(s.p.active, false);
});

test("without an engine to answer, the approval is dropped with a note", () => {
  const s = setup(false);
  s.p.enqueue(req(), 1);
  s.keys("y");
  assert.equal(s.answers.length, 0);
  assert.equal(s.p.active, false);
  assert.match(s.printed.at(-1) ?? "", /Can't answer this request/);
});
