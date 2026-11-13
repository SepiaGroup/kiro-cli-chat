// AcpClient against a fake engine process speaking JSON-RPC over stdio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AcpClient } from "./acpClient";
import type { ChatEvent } from "./types";

const dir = mkdtempSync(join(tmpdir(), "kiro-fake-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Write an executable fake `kiro-cli`. `onRequest(msg, send)` runs in the fake
 * for each request from the client; it's given as source text.
 */
function fakeEngine(name: string, onRequest: string): string {
  const file = join(dir, name);
  writeFileSync(
    file,
    `#!/usr/bin/env node
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const answers = new Map();
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.method === undefined) { const a = answers.get(msg.id); answers.delete(msg.id); a && a(msg); continue; }
    const ask = (m) => new Promise((r) => { answers.set(m.id, r); send(m); });
    (${onRequest})(msg, send, ask);
  }
});
`
  );
  chmodSync(file, 0o755);
  return file;
}

const BASIC = `(msg, send, ask) => {
  if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === "session/new") send({ id: msg.id, result: { sessionId: "s1" } });
}`;

/** stderr and stdout are separate pipes, so a log line can arrive after the reply it belongs to. */
async function eventually(what: string, cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error("timed out waiting for " + what);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function client(
  cliPath: string,
  timeoutsMs?: Record<string, number>,
  extra: { initialResponseTimeoutMs?: number; editorContext?: () => { active?: string; open: string[] } } = {}
): { c: AcpClient; events: ChatEvent[]; logs: string[] } {
  const c = new AcpClient({ cliPath, engine: "v3", cwd: dir, timeoutsMs, ...extra });
  const events: ChatEvent[] = [];
  const logs: string[] = [];
  c.on("event", (e: ChatEvent) => events.push(e));
  c.on("log", (l: string) => logs.push(l));
  return { c, events, logs };
}

test("handshake opens a session; stopReason cancelled is reported as cancelled", async () => {
  const cli = fakeEngine(
    "cancel",
    `(msg, send, ask) => {
      (${BASIC})(msg, send, ask);
      if (msg.method === "session/prompt") send({ id: msg.id, result: { stopReason: "cancelled" } });
    }`
  );
  const { c, events } = client(cli);
  try {
    assert.equal(await c.start(), false);
    assert.equal(c.currentSessionId, "s1");
    await c.prompt("hi");
    const fin = events.find((e) => e.kind === "runFinished");
    assert.deepEqual(fin, { kind: "runFinished", status: "cancelled", stopReason: "cancelled" });
  } finally {
    c.dispose();
  }
});

test("unknown engine requests get method-not-found, string ids included", async () => {
  const cli = fakeEngine(
    "unknown",
    `async (msg, send, ask) => {
      (${BASIC})(msg, send, ask);
      if (msg.method === "session/prompt") {
        const reply = await ask({ id: "x1", method: "fs/read_text_file", params: { path: "/etc/hosts" } });
        process.stderr.write("got " + JSON.stringify(reply.error) + "\\n");
        send({ id: msg.id, result: { stopReason: "end_turn", echo: reply } });
      }
    }`
  );
  const { c, logs } = client(cli);
  try {
    await c.start();
    await c.prompt("hi");
    await eventually("the engine's report of the error it got", () => logs.some((l) => l.includes('"code":-32601')));
  } finally {
    c.dispose();
  }
});

test("a request the engine never answers times out", async () => {
  const cli = fakeEngine("hang", `(msg) => {}`);
  const { c } = client(cli, { initialize: 300 });
  try {
    await assert.rejects(c.start(), /didn't answer initialize within/);
  } finally {
    c.dispose();
  }
});

test("an engine dying mid-turn rejects the prompt, ends the turn and doesn't crash later writes", async () => {
  const cli = fakeEngine(
    "die",
    `(msg, send, ask) => {
      (${BASIC})(msg, send, ask);
      if (msg.method === "session/prompt") { process.stderr.write("boom: par"); process.stderr.write("tial line\\n"); process.exit(3); }
    }`
  );
  const { c, events, logs } = client(cli);
  const exited = new Promise((r) => c.once("exit", r));
  try {
    await c.start();
    await assert.rejects(c.prompt("hi"), /exited \(code=3\)/);
    assert.equal(await exited, 3);
    assert.ok(events.some((e) => e.kind === "runFinished" && e.status === "error"));
    // stderr split across chunks arrives as one line.
    await eventually("the split stderr line", () => logs.includes("boom: partial line"));
    // Writing after exit is a no-op, not an EPIPE crash.
    c.cancel();
    await assert.rejects(c.setMode("plan"), /isn't running/);
  } finally {
    c.dispose();
  }
});

test("a missing binary fails start with a clear error", async () => {
  const { c } = client(join(dir, "does-not-exist"));
  await assert.rejects(c.start(), /Couldn't start .*ENOENT/);
  c.dispose();
});

// Engine side of a chat message: the agent's reply as one text chunk.
const SAY = `(send, text) => send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } })`;

function chunks(events: ChatEvent[]): string[] {
  return events.flatMap((e) => (e.kind === "assistantChunk" ? [e.text] : []));
}

test("the agent's question is shown, and the answer reaches the engine", async () => {
  const cli = fakeEngine(
    "question",
    `async (msg, send, ask) => {
      if (msg.method === "initialize") {
        send({ id: msg.id, result: { protocolVersion: 1, advertised: msg.params.clientCapabilities._meta } });
      }
      if (msg.method === "session/new") send({ id: msg.id, result: { sessionId: "s1" } });
      if (msg.method === "session/prompt") {
        const a = await ask({ id: "q-1", method: "_kiro/userInput", params: { sessionId: "s1", toolCallId: "t1", question: "Pick", options: [{ title: "red" }, { title: "blue" }] } });
        (${SAY})(send, JSON.stringify(a.result));
        send({ id: msg.id, result: { stopReason: "end_turn" } });
      }
    }`
  );
  const { c, events } = client(cli);
  let advertised: unknown;
  c.once("initialized", (r: { advertised?: unknown }) => (advertised = r.advertised));
  c.on("event", (e: ChatEvent) => {
    if (e.kind === "question") {
      c.answerQuestion(e.requestId, "  blue ");
    }
  });
  try {
    await c.start();
    assert.deepEqual(advertised, { kiro: { userInput: true } });
    await c.prompt("go");
    const q = events.find((e) => e.kind === "question");
    assert.deepEqual(q && q.kind === "question" && [q.requestId, q.question], ["q-1", { toolCallId: "t1", question: "Pick", options: [{ title: "red" }, { title: "blue" }] }]);
    assert.deepEqual(chunks(events), ['{"action":"answered","answer":"blue"}']);
    // Answering twice, or an unknown id, does nothing.
    c.answerQuestion("q-1", "red");
    c.answerQuestion("nope", "red");
  } finally {
    c.dispose();
  }
});

test("cancelling skips the waiting question; a question without text is skipped too", async () => {
  const cli = fakeEngine(
    "question-cancel",
    `async (msg, send, ask) => {
      (${BASIC})(msg, send, ask);
      if (msg.method === "session/prompt") {
        const bad = await ask({ id: "q-0", method: "_kiro/userInput", params: { question: "" } });
        const a = await ask({ id: "q-1", method: "_kiro/userInput", params: { toolCallId: "t1", question: "Pick", options: [] } });
        (${SAY})(send, JSON.stringify([bad.result, a.result]));
        send({ id: msg.id, result: { stopReason: "cancelled" } });
      }
    }`
  );
  const { c, events } = client(cli);
  c.on("event", (e: ChatEvent) => {
    if (e.kind === "question") {
      c.cancel();
    }
  });
  try {
    await c.start();
    await c.prompt("go");
    assert.ok(events.some((e) => e.kind === "questionResolved" && e.toolCallId === "t1" && e.requestId === "q-1"));
    assert.deepEqual(chunks(events), ['[{"action":"dismissed"},{"action":"dismissed"}]']);
  } finally {
    c.dispose();
  }
});

test("@file: puts the file in the prompt and keeps what was typed as the display text", async () => {
  writeFileSync(join(dir, "note.txt"), "remember the milk");
  const cli = fakeEngine(
    "mention",
    `(msg, send, ask) => {
      (${BASIC})(msg, send, ask);
      if (msg.method === "session/prompt") {
        (${SAY})(send, JSON.stringify({ blocks: msg.params.prompt, meta: msg.params._meta }));
        send({ id: msg.id, result: { stopReason: "end_turn" } });
      }
    }`
  );
  const { c, events, logs } = client(cli);
  try {
    await c.start();
    await c.prompt("what is in @file:note.txt and @file:missing.txt?");
    const sent = JSON.parse(chunks(events)[0]);
    assert.deepEqual(sent.blocks, [
      { type: "text", text: 'what is in <attached_file path="note.txt"> remember the milk </attached_file> and @file:missing.txt?' },
    ]);
    assert.deepEqual(sent.meta, { kiro: { displayText: "what is in @file:note.txt and @file:missing.txt?" } });
    assert.ok(events.some((e) => e.kind === "notice" && e.text === "Attached: note.txt. Not attached: missing.txt (not a file)."));
    assert.ok(logs.includes("@file:missing.txt was not attached (not a file)"), logs.join("\n"));
    // No attachment: nothing extra is sent.
    events.length = 0;
    await c.prompt("plain");
    assert.deepEqual(JSON.parse(chunks(events)[0]), { blocks: [{ type: "text", text: "plain" }] });
    assert.ok(!events.some((e) => e.kind === "notice"));
  } finally {
    c.dispose();
  }
});

test("a prompt the engine never answers is cancelled and fails with a clear error", async () => {
  const cli = fakeEngine(
    "silent",
    `(msg, send, ask) => {
      (${BASIC})(msg, send, ask);
      if (msg.method === "session/cancel") process.stderr.write("engine got cancel\\n");
    }`
  );
  const { c, events, logs } = client(cli, undefined, { initialResponseTimeoutMs: 200 });
  try {
    await c.start();
    await assert.rejects(c.prompt("hi"), /sent nothing for 0s, so the turn was cancelled/);
    assert.ok(events.some((e) => e.kind === "runFinished" && e.status === "error"));
    assert.ok(logs.some((l) => l.includes("cancelling the turn")));
    await eventually("the engine's report of the cancel", () => logs.includes("engine got cancel"));
  } finally {
    c.dispose();
  }
});

test("any sign of life from the engine ends the first-reply limit", async () => {
  const cli = fakeEngine(
    "slow",
    `(msg, send, ask) => {
      (${BASIC})(msg, send, ask);
      if (msg.method === "session/prompt") {
        setTimeout(() => (${SAY})(send, "thinking"), 50);
        setTimeout(() => send({ id: msg.id, result: { stopReason: "end_turn" } }), 500);
      }
    }`
  );
  const { c, events } = client(cli, undefined, { initialResponseTimeoutMs: 200 });
  try {
    await c.start();
    await c.prompt("hi");
    assert.deepEqual(chunks(events), ["thinking"]);
    assert.ok(events.some((e) => e.kind === "runFinished" && e.status === "success"));
  } finally {
    c.dispose();
  }
});

test("open editor files go in as a context item, only when they changed", async () => {
  const cli = fakeEngine(
    "editor",
    `(msg, send, ask) => {
      (${BASIC})(msg, send, ask);
      if (msg.method === "session/prompt") {
        (${SAY})(send, JSON.stringify(msg.params.prompt.filter((b) => b.type === "resource")));
        send({ id: msg.id, result: { stopReason: "end_turn" } });
      }
    }`
  );
  let ctx: { active?: string; open: string[] } = { active: dir + "/a.ts", open: [dir + "/a.ts", dir + "/b.md"] };
  const { c, events } = client(cli, undefined, { editorContext: () => ctx });
  const sent = (): unknown[] => JSON.parse(chunks(events).at(-1) ?? "null");
  const notices = (): string[] => events.flatMap((e) => (e.kind === "notice" ? [e.text] : []));
  try {
    await c.start();
    await c.prompt("one");
    assert.deepEqual(sent(), [
      {
        type: "resource",
        resource: {
          uri: "vscode-editor-context",
          mimeType: "text/plain",
          text: "Editor context from the user's VS Code (paths relative to the workspace folder). It is current; an engine note saying no files are open can't see the editor.\nActive file: a.ts\nOpen files:\n- a.ts\n- b.md",
        },
      },
    ]);
    assert.deepEqual(notices(), ["Sent editor context: active a.ts, 2 open files."]);
    await c.prompt("two"); // unchanged: not sent again
    assert.deepEqual(sent(), []);
    ctx = { open: [dir + "/b.md"] };
    await c.prompt("three");
    assert.equal((sent() as Array<{ resource: { text: string } }>)[0].resource.text.includes("Active file: none"), true);
    ctx = { open: [] }; // nothing open: nothing to say
    await c.prompt("four");
    assert.deepEqual(sent(), []);
    assert.equal(notices().length, 2);
  } finally {
    c.dispose();
  }
});

// A turn that stays open until a steer says what to do next:
//   "finish" -> the agent reads it and the turn ends
//   "lose"   -> the engine clears it without the agent reading it
//   "leave"  -> the turn ends with it still unread
//   anything else is queued only
const STEER_ENGINE = `async (msg, send, ask) => {
  (${BASIC})(msg, send, ask);
  const g = globalThis;
  const info = (kind, extra) => send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "session_info_update", _meta: { kiro: { kind, ...extra } } } } });
  if (msg.method === "session/prompt") g.promptId = msg.id;
  if (msg.method === "_session/steer") {
    const id = "steer-" + msg.params.messageId;
    send({ id: msg.id, result: { queued: true, messageId: id } });
    info("steering_queued", { messageId: id, content: msg.params.message });
    const m = msg.params.message;
    if (m.includes("finish")) {
      info("steering_injected", { messageId: id, content: m });
      info("steering_cleared", { messageIds: [id] });
      send({ id: g.promptId, result: { stopReason: "end_turn" } });
    } else if (m.includes("lose")) {
      info("steering_cleared", { messageIds: [id] });
    } else if (m.includes("leave")) {
      send({ id: g.promptId, result: { stopReason: "end_turn" } });
    }
  }
  if (msg.method === "_session/steer/clear") {
    info("steering_cleared", { messageIds: ["steer-m1"] }); // before the reply, as the real engine does
    send({ id: msg.id, result: { cleared: true } });
  }
}`;

const steers = (events: ChatEvent[]): string[] =>
  events.flatMap((e) => (e.kind === "steer" ? [`${e.state}:${e.messageIds.join(",")}`] : []));

test("a message sent mid-turn is queued, then read by the agent", async () => {
  const { c, events } = client(fakeEngine("steer", STEER_ENGINE));
  try {
    await c.start();
    await assert.rejects(c.steer("too early"), /No reply is running/);
    const turn = c.prompt("work");
    await eventually("the turn to start", () => c.turnRunning);
    await c.steer("hello");
    await eventually("the queued event", () => c.hasQueuedSteers);
    await c.steer("please finish");
    await turn;
    assert.deepEqual(steers(events), ["queued:steer-m1", "queued:steer-m2", "injected:steer-m2", "dropped:steer-m1"]);
    assert.equal(c.hasQueuedSteers, false);
    assert.equal(c.turnRunning, false);
  } finally {
    c.dispose();
  }
});

test("a message the engine clears unread is reported as dropped; one left at turn end too", async () => {
  const { c, events } = client(fakeEngine("steer-lost", STEER_ENGINE));
  try {
    await c.start();
    const turn = c.prompt("work");
    await eventually("the turn to start", () => c.turnRunning);
    await c.steer("lose this");
    await eventually("the drop", () => steers(events).includes("dropped:steer-m1"));
    await c.steer("leave this");
    await turn;
    assert.deepEqual(steers(events), ["queued:steer-m1", "dropped:steer-m1", "queued:steer-m2", "dropped:steer-m2"]);
  } finally {
    c.dispose();
  }
});

test("taking back queued messages reports them as removed", async () => {
  const { c, events } = client(fakeEngine("steer-clear", STEER_ENGINE));
  try {
    await c.start();
    const turn = c.prompt("work");
    await eventually("the turn to start", () => c.turnRunning);
    await c.steer("one");
    await eventually("queued", () => c.hasQueuedSteers);
    await c.clearSteers();
    await eventually("removed", () => steers(events).includes("removed:steer-m1"));
    assert.equal(c.hasQueuedSteers, false);
    await c.steer("finish now");
    await turn;
  } finally {
    c.dispose();
  }
});

test("@file: works in a steering message", async () => {
  writeFileSync(join(dir, "steer.txt"), "from the file");
  const cli = fakeEngine(
    "steer-file",
    `async (msg, send, ask) => {
      (${BASIC})(msg, send, ask);
      if (msg.method === "_session/steer") {
        send({ id: msg.id, result: { queued: true } });
        (${SAY})(send, msg.params.message);
        send({ id: globalThis.promptId, result: { stopReason: "end_turn" } });
      }
      if (msg.method === "session/prompt") globalThis.promptId = msg.id;
    }`
  );
  const { c, events } = client(cli);
  try {
    await c.start();
    const turn = c.prompt("work");
    await eventually("the turn to start", () => c.turnRunning);
    await c.steer("see @file:steer.txt");
    await turn;
    assert.deepEqual(chunks(events), ['see <attached_file path="steer.txt"> from the file </attached_file>']);
    assert.ok(events.some((e) => e.kind === "notice" && e.text === "Attached: steer.txt."));
  } finally {
    c.dispose();
  }
});

test("the engine's rate-limit notification shows as an error notice and does not end the turn", async () => {
  const cli = fakeEngine(
    "ratelimit",
    `async (msg, send, ask) => {
      (${BASIC})(msg, send, ask);
      if (msg.method === "session/prompt") {
        send({ method: "_kiro/error/rate_limit", params: { sessionId: "s1", message: "The model is busy, retrying." } });
        send({ method: "_kiro/error/rate_limit", params: { sessionId: "s1" } });
        send({ id: msg.id, result: { stopReason: "end_turn" } });
      }
    }`
  );
  const { c, events } = client(cli);
  try {
    await c.start();
    await c.prompt("hi");
    const notices = events.flatMap((e) => (e.kind === "notice" ? [[e.text, e.isError]] : []));
    assert.deepEqual(notices, [
      ["The model is busy, retrying.", true],
      ["Rate limit exceeded. Please wait a moment before trying again.", true],
    ]);
    assert.ok(events.some((e) => e.kind === "runFinished" && e.status === "success"));
    assert.equal(events.some((e) => e.kind === "error"), false);
  } finally {
    c.dispose();
  }
});

test("cancelling a reply that waits on an approval ends it and forgets the approval", async () => {
  const cli = fakeEngine(
    "cancel-approval",
    `(msg, send, ask) => {
      (${BASIC})(msg, send, ask);
      const g = globalThis;
      if (msg.method === "session/prompt") {
        g.promptId = msg.id;
        send({ id: "p-1", method: "session/request_permission", params: { sessionId: "s1", toolCall: { toolCallId: "t1", title: "Run find ." }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } });
      }
      if (msg.method === "session/cancel") send({ id: g.promptId, result: { stopReason: "cancelled" } });
    }`
  );
  const { c, events } = client(cli);
  const pending = c as unknown as { pendingPermissions: Map<unknown, unknown> };
  try {
    await c.start();
    const turn = c.prompt("work");
    await eventually("the approval", () => pending.pendingPermissions.size === 1);
    c.cancel();
    await turn;
    assert.ok(events.some((e) => e.kind === "runFinished" && e.status === "cancelled"));
    assert.equal(pending.pendingPermissions.size, 0);
    assert.equal(c.turnRunning, false);
  } finally {
    c.dispose();
  }
});

test("a remote device can allow or deny once, but not create a rule", async () => {
  const cli = fakeEngine(
    "once-only",
    `(msg, send, ask) => {
      (${BASIC})(msg, send, ask);
      if (msg.method === "session/prompt") {
        send({ id: "p-1", method: "session/request_permission", params: { sessionId: "s1", toolCall: { toolCallId: "t1", title: "Run find ." }, options: [
          { optionId: "o-allow", name: "Allow", kind: "allow_once" },
          { optionId: "o-always", name: "Always", kind: "allow_always" },
          { optionId: "o-deny", name: "Deny", kind: "reject_once" } ] } });
      }
    }`
  );
  const { c } = client(cli);
  const pending = c as unknown as { pendingPermissions: Map<unknown, unknown> };
  try {
    await c.start();
    c.prompt("work").catch(() => undefined); // the fake engine never ends the turn; disposing rejects it
    await eventually("the approval", () => pending.pendingPermissions.size === 1);
    assert.throws(() => c.respondToApproval("p-1", { optionId: "o-always" }, { onceOnly: true }), /only allow or deny once/);
    assert.throws(() => c.respondToApproval("p-1", { optionId: "unknown" }, { onceOnly: true }), /only allow or deny once/);
    assert.equal(pending.pendingPermissions.size, 1); // still waiting
    assert.equal(c.respondToApproval("p-1", { optionId: "o-allow" }, { onceOnly: true }), "allow_once");
    assert.equal(pending.pendingPermissions.size, 0);
  } finally {
    c.dispose();
  }
});
