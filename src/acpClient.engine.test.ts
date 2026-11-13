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

function client(cliPath: string, timeoutsMs?: Record<string, number>): { c: AcpClient; events: ChatEvent[]; logs: string[] } {
  const c = new AcpClient({ cliPath, engine: "v3", cwd: dir, timeoutsMs });
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
    assert.ok(logs.some((l) => l.includes('"code":-32601')), logs.join("\n"));
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
    assert.ok(logs.includes("boom: partial line"), logs.join("\n"));
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
