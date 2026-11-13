// End-to-end test of the terminal chat: a fake `vscode` module and a fake
// kiro-cli (whoami + an ACP engine) drive a real TerminalChat through a turn
// with streamed text, a tool call, an approval and the footer.

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stripAnsi } from "./ansi";

class Emitter<T> {
  private listeners: Array<(v: T) => void> = [];
  readonly event = (l: (v: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(v: T): void {
    for (const l of [...this.listeners]) {
      l(v);
    }
  }
  dispose(): void {}
}

const dir = mkdtempSync(join(tmpdir(), "kiro-term-"));
const cli = join(dir, "kiro-cli");
writeFileSync(
  cli,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "whoami") { console.log(JSON.stringify({ email: "test@example.com" })); process.exit(0); }
if (args[0] !== "acp") process.exit(2);
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const update = (u) => send({ method: "session/update", params: { sessionId: "s1", update: u } });
let waiting;
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.method === undefined) { process.stderr.write("answer " + JSON.stringify(msg.result) + "\\n"); waiting(msg); continue; }
    if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1 } });
    else if (msg.method === "session/new") send({ id: msg.id, result: { sessionId: "s1" } });
    else if (msg.method === "session/set_config_option") send({ id: msg.id, result: {} });
    else if (msg.method === "session/prompt" && msg.params.prompt[0].text.includes("ask me")) {
      waiting = (m) => {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "You picked " + JSON.stringify(m.result) } });
        send({ id: msg.id, result: { stopReason: "end_turn" } });
      };
      send({ id: "q-1", method: "_kiro/userInput", params: { sessionId: "s1", toolCallId: "q1", question: "Pick **one**", options: [{ title: "red" }, { title: "blue", recommended: true }] } });
    }
    else if (msg.method === "session/prompt" && msg.params.prompt[0].text.includes("attached_file")) {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "GOT " + JSON.stringify(msg.params.prompt[0].text) } });
      send({ id: msg.id, result: { stopReason: "end_turn" } });
    }
    else if (msg.method === "session/prompt") {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello **there**.\\n" } });
      update({ sessionUpdate: "tool_call", toolCallId: "tc1", title: "Run find .", status: "pending" });
      waiting = () => {
        update({ sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed" });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "All done." } });
        send({ id: msg.id, result: { stopReason: "end_turn" } });
      };
      send({ id: "perm-1", method: "session/request_permission", params: {
        sessionId: "s1",
        toolCall: { toolCallId: "tc1", title: "find ." },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
        _meta: { kiro: { consent: { capability: "shell", triggeringResource: "find ." } } },
      } });
    }
  }
});
`
);
chmodSync(cli, 0o755);
test.after(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(join(dir, "n.txt"), "remember the milk");

const settings: Record<string, unknown> = { kiroCliPath: cli, defaultEngine: "v3", autopilot: false };
const fakeVscode = {
  EventEmitter: Emitter,
  workspace: {
    workspaceFolders: [{ uri: { fsPath: dir } }],
    getConfiguration: () => ({ get: (k: string, d: unknown) => (k in settings ? settings[k] : d) }),
  },
  window: { createTerminal: () => ({ show() {}, sendText() {} }) },
};
const mod = Module as unknown as { _load: (req: string, ...rest: unknown[]) => unknown };
const origLoad = mod._load;
mod._load = function (req: string, ...rest: unknown[]) {
  return req === "vscode" ? fakeVscode : origLoad.call(this, req, ...rest);
};
// Loaded after the fake is installed, so it can't be a hoisted `import`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TerminalChat } = require("./terminalChat") as typeof import("./terminalChat");

async function until(what: string, cond: () => boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error("timed out waiting for " + what);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("a turn: streamed reply, tool card, approval answered with y, footer", async () => {
  const logs: string[] = [];
  const chat = new TerminalChat({ appendLine: (l: string) => logs.push(l) } as never, "Kiro Chat");
  let screen = "";
  chat.onDidWrite((s) => (screen += s));
  const text = () => stripAnsi(screen).replace(/\r\n/g, "\n");
  chat.open({ columns: 100, rows: 30 });
  try {
    await until("ready", () => text().includes("Ready · engine v3"));
    assert.match(text(), /Supervised/);
    for (const ch of "list files") {
      chat.handleInput(ch);
    }
    chat.handleInput("\r");
    await until("approval", () => text().includes("[y] Allow"));
    assert.match(text(), /Hello there\./);
    assert.match(text(), /● Run find \./);
    assert.match(text(), /\? find \.\n {2}\[y\] Allow {2}\[n\] Deny {2}\[Tab\] Deny with reason/);
    chat.handleInput("y");
    await until("footer", () => text().includes("Time:"));
    assert.match(text(), /→ Allow/);
    assert.match(text(), /– Completed in \d/);
    assert.match(text(), /All done\./);
    assert.match(text(), /▸ Time: \d+s/);
    assert.ok(logs.some((l) => l.includes('answer {"outcome":{"outcome":"selected","optionId":"allow"}')), logs.join("\n"));
    // The "/" menu and a local command.
    screen = "";
    chat.handleInput("/");
    chat.handleInput("h");
    chat.handleInput("e");
    await until("menu", () => text().includes("/help"));
    chat.handleInput("\r");
    await until("help", () => text().includes("Commands"));
  } finally {
    chat.close();
  }
});

test("a question from the agent is answered with the keyboard; @file: is attached", async () => {
  const chat = new TerminalChat({ appendLine: () => undefined } as never, "Kiro Chat");
  let screen = "";
  chat.onDidWrite((s) => (screen += s));
  const text = () => stripAnsi(screen).replace(/\r\n/g, "\n");
  const send = (line: string) => {
    for (const ch of line) {
      chat.handleInput(ch);
    }
    chat.handleInput("\r");
  };
  chat.open({ columns: 100, rows: 30 });
  try {
    await until("ready", () => text().includes("Ready · engine v3"));
    send("please ask me something");
    await until("question", () => text().includes("[2] blue (recommended)"));
    assert.match(text(), /\? Pick one\n {2}\[1\] red/);
    chat.handleInput("\r"); // empty answer = the recommended choice
    await until("answer", () => text().includes("Time:"));
    assert.match(text(), /→ You answered: blue/);
    assert.match(text(), /You picked \{"action":"answered","answer":"blue"\}/);

    screen = "";
    send("what is in @file:n.txt?");
    await until("echo", () => text().includes("GOT"));
    assert.match(text(), /GOT .*attached_file.*remember the milk/);
  } finally {
    chat.close();
  }
});
