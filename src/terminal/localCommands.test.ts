import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "./ansi";
import { LocalCommands, LocalHost } from "./localCommands";
import { SessionConfig } from "./sessionConfig";

function setup(clientOk = true) {
  const printed: string[] = [];
  const calls: string[] = [];
  const config = new SessionConfig();
  config.merge([
    { id: "model", name: "Model", type: "select", currentValue: "auto", options: [
      { value: "auto", name: "Auto" },
      { value: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
      { value: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
    ] },
    { id: "autopilot", name: "Autopilot", type: "select", currentValue: "off" },
  ]);
  const client = {
    setConfigOption: async (id: string, v: string) => void calls.push(`set ${id}=${v}`),
    setAutoApprove: (on: boolean) => void calls.push(`autoApprove ${on}`),
  };
  const host = {
    print: (t: string) => printed.push(stripAnsi(t)),
    client: () => {
      if (!clientOk) {
        throw new Error("The engine isn't running. Type /restart.");
      }
      return client;
    },
    config: () => config,
    cols: () => 100,
    engineCommands: () => [{ name: "context-gatherer", description: "Gathers" }],
    toolGroups: () => [],
    updatePrompt: () => void calls.push("updatePrompt"),
    restart: async () => void calls.push("restart"),
    clearScreen: () => void calls.push("cls"),
  } as unknown as LocalHost;
  return { cmds: new LocalCommands(host), printed, calls };
}

test("/model matches by name or value prefix and sets it", async () => {
  const s = setup();
  await s.cmds.run("model", "claude haiku");
  await s.cmds.run("model", "claude-son");
  await s.cmds.run("model", "gpt");
  assert.deepEqual(s.calls, ["set model=claude-haiku-4.5", "set model=claude-sonnet-4.5"]);
  assert.match(s.printed.at(-1) ?? "", /No model matches “gpt”/);
});

test("/model without an argument lists the choices with the current one marked", async () => {
  const s = setup();
  await s.cmds.run("model", "");
  assert.deepEqual(s.printed[0].split("\n").slice(0, 2), ["Model: Auto", "  ● Auto (auto)"]);
});

test("/tools trust-all and reset switch Autopilot", async () => {
  const s = setup();
  await s.cmds.run("tools", "trust-all");
  await s.cmds.run("tools", "--reset");
  assert.deepEqual(s.calls, [
    "set autopilot=on", "autoApprove true", "updatePrompt",
    "set autopilot=off", "autoApprove false", "updatePrompt",
  ]);
  await s.cmds.run("tools", "trust shell");
  assert.match(s.printed.at(-1) ?? "", /Trusting individual tools isn't available/);
});

test("simple commands go to the host; errors are printed, not thrown", async () => {
  const s = setup(false);
  await s.cmds.run("cls", "");
  await s.cmds.run("restart", "");
  await s.cmds.run("autopilot", "on");
  await s.cmds.run("set", "");
  assert.deepEqual(s.calls, ["cls", "restart"]);
  assert.match(s.printed.join("\n"), /The engine isn't running\. Type \/restart\.\nUsage: \/set <id> <value>/);
});

test("/help lists commands, agent commands and keys", async () => {
  const s = setup();
  await s.cmds.run("help", "");
  const text = s.printed[0];
  assert.match(text, /^Commands/);
  assert.match(text, /\/context-gatherer\s+Gathers/);
  assert.match(text, /Not available in this extension: \/guide/);
});
