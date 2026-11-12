import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, findCommand, slashMenu, tokenize, MenuValue, ValueSource } from "./slashCommands";

const noValues = (): MenuValue[] => [];
const labels = (m: ReturnType<typeof slashMenu>) => m?.items.map((i) => i.label) ?? [];

test("every kiro-cli command has a spec", () => {
  const kiro = [
    "agent", "changelog", "chat", "clear", "code", "compact", "context", "copy", "editor", "effort",
    "goal", "guide", "help", "hooks", "knowledge", "mcp", "model", "paste", "plan", "prompts", "reply",
    "rewind", "settings", "spawn", "stats", "theme", "title", "tools", "transcript", "usage", "voice", "quit",
  ];
  for (const name of kiro) {
    assert.ok(findCommand(name), `missing /${name}`);
  }
  assert.equal(findCommand("exit")?.name, "quit");
});

test("bare / lists all commands alphabetically", () => {
  const m = slashMenu("/", [], noValues);
  assert.equal(m?.items.length, COMMANDS.length);
  assert.equal(m?.items[0].label, "/agent");
});

test("command name filtering: exact, prefix, then substring", () => {
  assert.deepEqual(labels(slashMenu("/co", [], noValues)), ["/code", "/compact", "/config", "/context", "/copy"]);
  assert.deepEqual(labels(slashMenu("/compact", [], noValues)), ["/compact"]);
  assert.ok(labels(slashMenu("/ext", [], noValues)).includes("/context")); // substring
});

test("Enter runs commands unless a required argument is missing", () => {
  const compact = slashMenu("/compact", [], noValues)?.items[0];
  assert.deepEqual([compact?.insert, compact?.submit], ["/compact", true]);
  // Optional arguments: runs, but Tab leaves room to type them.
  const ctx = slashMenu("/context", [], noValues)?.items[0];
  assert.deepEqual([ctx?.insert, ctx?.submit], ["/context ", true]);
  const spawn = slashMenu("/spawn", [], noValues)?.items[0];
  assert.deepEqual([spawn?.insert, spawn?.submit], ["/spawn ", false]);
  const add = slashMenu("/context ad", [], noValues)?.items[0];
  assert.equal(add?.submit, false); // <path|glob> is required
});

test("engine commands appear in the menu", () => {
  const m = slashMenu("/context-g", [{ name: "context-gatherer", description: "Gather context" }], noValues);
  assert.deepEqual(labels(m), ["/context-gatherer"]);
});

test("subcommands are offered after the command", () => {
  assert.deepEqual(labels(slashMenu("/context ", [], noValues)), ["add", "clear", "remove", "show"]);
  const add = slashMenu("/context a", [], noValues)?.items[0];
  assert.deepEqual([add?.label, add?.insert], ["add", "/context add "]);
});

test("runtime values are offered (models)", () => {
  const values = (s: ValueSource): MenuValue[] =>
    s === "model" ? [{ value: "auto" }, { value: "claude-sonnet-4.5" }, { value: "claude-haiku-4.5" }] : [];
  assert.deepEqual(labels(slashMenu("/model claude-s", [], values)), ["claude-sonnet-4.5"]);
  assert.equal(slashMenu("/model auto", [], values)?.items[0].submit, true);
});

test("usage hints for free-text arguments", () => {
  assert.match(slashMenu("/spawn ", [], noValues)?.hint ?? "", /^\/spawn <task>/);
  assert.match(slashMenu("/context add src", [], noValues)?.hint ?? "", /^\/context add <path\|glob>/);
});

test("non-commands get no menu (dropped paths, multi-line)", () => {
  assert.equal(slashMenu("/Users/me/pic.png", [], noValues), undefined);
  assert.equal(slashMenu("/Users/me/pic.png what is it", [], noValues), undefined);
  assert.equal(slashMenu("hello", [], noValues), undefined);
  assert.equal(slashMenu("/help\nmore", [], noValues), undefined);
});

test("tokenize honors quotes and escapes", () => {
  assert.deepEqual(tokenize(`add "My Docs" ~/a\\ b.md 'x y'`), ["add", "My Docs", "~/a b.md", "x y"]);
});
