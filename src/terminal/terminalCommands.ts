// Implementations of the terminal chat's kiro-cli slash commands that go
// beyond the basics: context, compaction, usage, knowledge, agents, rewind,
// editor round-trips, clipboard, transcripts, and so on.

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { AcpClient } from "../acpClient";
import { errorMessage } from "../format";
import { AvailableCommand, ConfigOption, PromptImage } from "../types";
import { fitAnsi, sanitize, style, stripAnsi } from "./ansi";
import { tokenize } from "./slashCommands";

export interface TranscriptEntry {
  role: "user" | "assistant" | "tool";
  text: string;
}

export interface UserTurn {
  messageId: string;
  text: string;
}

export interface TurnStat {
  at: Date;
  prompt: string;
  elapsedMs: number;
  credits?: number;
  requestIds: string[];
  status: string;
}

/** What the commands need from the chat terminal. */
export interface ChatHost {
  print(text: string): void;
  client(): AcpClient; // throws when the engine isn't running
  runBusy<T>(label: string, fn: () => Promise<T>): Promise<T>;
  confirm(question: string): Promise<boolean>;
  cwd(): string;
  cols(): number;
  cliPath(): string | undefined;
  option(id: string): ConfigOption | undefined;
  engineCommands(): AvailableCommand[];
  contextPercent(): number | undefined;
  transcript(): TranscriptEntry[];
  truncateConversation(turnIndex: number): void;
  userTurns(): UserTurn[];
  turnStats(): TurnStat[];
  mcpServers(): unknown[];
  setInput(text: string): void;
  addPendingImage(img: PromptImage): void;
  setTitle(title: string | undefined): void;
  title(): string;
  spawn(task: string): void;
  sendPrompt(text: string): Promise<void>;
  log(line: string): void;
}

interface ContextBreakdownItem {
  name?: string;
  tokens?: number;
  percent?: number;
}
interface ContextBreakdownGroup {
  tokens?: number;
  percent?: number;
  items?: ContextBreakdownItem[];
}

const BREAKDOWN_LABELS: Array<[string, string]> = [
  ["yourPrompts", "Your prompts"],
  ["kiroResponses", "Kiro responses"],
  ["tools", "Tools"],
  ["contextFiles", "Context files"],
  ["sessionFiles", "Session files"],
  ["memory", "Memory"],
];

export class TerminalCommands {
  constructor(private readonly host: ChatHost) {}

  // --- /context ---

  async context(arg: string): Promise<void> {
    const [sub = "show", ...rest] = tokenize(arg);
    const s = sub.toLowerCase();
    const client = this.host.client();
    if (s === "show") {
      const res = await client.extMethod<{
        success?: boolean;
        message?: string;
        entries?: Array<{ path: string; matched?: boolean }>;
        breakdown?: Record<string, ContextBreakdownGroup>;
      }>("_kiro/session/context", { subcommand: "show" });
      this.showContext(res.entries ?? [], res.breakdown);
      return;
    }
    if (s === "add" || s === "remove" || s === "rm") {
      const force = rest.includes("--force");
      const paths = rest.filter((p) => p !== "--force");
      if (paths.length === 0) {
        this.host.print(style.gray(`Usage: /context ${s === "add" ? "add <path|glob> [--force]" : "remove <path>"}`));
        return;
      }
      for (const p of paths) {
        const res = await client.extMethod<{ success?: boolean; message?: string }>("_kiro/session/context", {
          subcommand: s === "add" ? "add" : "remove",
          path: p,
          ...(force ? { force: true } : {}),
        });
        this.result(res);
      }
      return;
    }
    if (s === "clear") {
      this.result(await client.extMethod("_kiro/session/context", { subcommand: "clear" }));
      return;
    }
    this.host.print(style.gray("Usage: /context [show | add <path> | remove <path> | clear]"));
  }

  private showContext(entries: Array<{ path: string; matched?: boolean }>, breakdown?: Record<string, ContextBreakdownGroup>): void {
    const pct = this.host.contextPercent();
    const lines: string[] = [];
    if (pct !== undefined) {
      const width = Math.max(10, Math.min(40, this.host.cols() - 30));
      lines.push(style.bold("Context window ") + bar(pct, width) + " " + style.green(`${pct.toFixed(1)}% used`));
    } else {
      lines.push(style.bold("Context window"));
    }
    if (breakdown) {
      for (const [key, label] of BREAKDOWN_LABELS) {
        const g = breakdown[key];
        if (!g) {
          continue;
        }
        const tokens = formatNumber(g.tokens ?? 0);
        lines.push(`  ${label.padEnd(16)}${style.cyan(tokens.padStart(9))} tokens  ${style.gray(`${(g.percent ?? 0).toFixed(1)}%`)}`);
        for (const item of (g.items ?? []).slice(0, 8)) {
          if (item.name) {
            lines.push(style.gray(`      ${truncate(sanitize(item.name), 50)}  ${formatNumber(item.tokens ?? 0)} tokens`));
          }
        }
      }
    }
    lines.push("", style.bold("Context files you added"));
    if (entries.length === 0) {
      lines.push(style.gray("  none — add some with /context add <path|glob>"));
    } else {
      for (const e of entries) {
        lines.push(`  ${style.magenta(sanitize(e.path))}${e.matched === false ? style.yellow("  (no matching files)") : ""}`);
      }
    }
    this.host.print(lines.join("\n"));
  }

  // --- /compact ---

  async compact(): Promise<void> {
    const client = this.host.client();
    const before = this.host.contextPercent();
    const res = await this.host.runBusy("Compacting", () =>
      client.extMethod<{ success?: boolean }>("_kiro/session/compact")
    );
    if (res?.success) {
      // The engine pushes the new context usage right after.
      await delay(400);
      const after = this.host.contextPercent();
      const change = before !== undefined && after !== undefined ? ` Context: ${before.toFixed(0)}% → ${after.toFixed(0)}%.` : "";
      this.host.print(style.gray("Conversation compacted." + change));
    } else {
      this.host.print(style.yellow("Couldn't compact right now (a reply may still be running, or there's nothing to compact)."));
    }
  }

  // --- /usage ---

  async usage(): Promise<void> {
    const client = this.host.client();
    const res = await this.host.runBusy("Loading usage", () =>
      client.extMethod<{
        success?: boolean;
        message?: string;
        data?: {
          planName?: string;
          billingCycleReset?: string;
          overagesEnabled?: boolean;
          usageBreakdowns?: Array<{ displayName?: string; used?: number; limit?: number; percentage?: number; hasLimit?: boolean; currentOverages?: number }>;
          bonusCredits?: Array<{ displayName?: string; used?: number; limit?: number; expiresAt?: string }>;
          addOnCredits?: Array<{ displayName?: string; used?: number; limit?: number; expiresAt?: string }>;
        };
      }>("_kiro/account/getUsage")
    );
    const d = res?.data;
    if (!res?.success || !d) {
      this.host.print(style.yellow(sanitize(res?.message ?? "Usage information isn't available.")));
      return;
    }
    const lines = [style.bold("Plan: ") + sanitize(d.planName ?? "?") + (d.billingCycleReset ? style.gray(` · resets ${d.billingCycleReset}`) : "")];
    const width = Math.max(10, Math.min(30, this.host.cols() - 45));
    for (const u of d.usageBreakdowns ?? []) {
      const used = u.used ?? 0;
      const limit = u.limit ?? 0;
      const pct = u.percentage ?? (limit ? (used / limit) * 100 : 0);
      lines.push(
        `  ${sanitize(u.displayName ?? "Usage").padEnd(10)}${u.hasLimit === false ? "" : bar(pct, width) + " "}` +
          `${formatNumber(used)}${limit ? " / " + formatNumber(limit) : ""}` +
          style.gray(limit ? ` (${pct.toFixed(0)}%)` : "")
      );
      if (u.currentOverages) {
        lines.push(style.yellow(`    overages: ${formatNumber(u.currentOverages)}`));
      }
    }
    for (const [label, list] of [["Bonus credits", d.bonusCredits], ["Add-on credits", d.addOnCredits]] as const) {
      for (const b of list ?? []) {
        lines.push(`  ${label}: ${formatNumber(b.used ?? 0)} / ${formatNumber(b.limit ?? 0)}${b.expiresAt ? style.gray(` · expires ${b.expiresAt}`) : ""}`);
      }
    }
    lines.push(style.gray(`  Overages ${d.overagesEnabled ? "enabled" : "disabled"}`));
    this.host.print(lines.join("\n"));
  }

  // --- /knowledge ---

  async knowledge(arg: string): Promise<void> {
    const [sub = "show", ...rest] = tokenize(arg);
    const s = sub.toLowerCase();
    const client = this.host.client();
    const call = (params: Record<string, unknown>) =>
      client.extMethod<{ success?: boolean; message?: string; entries?: Array<Record<string, unknown>> }>("_kiro/knowledge", params);
    switch (s) {
      case "show": {
        const res = await call({ subcommand: "show" });
        const entries = res.entries ?? [];
        if (!res.success) {
          this.result(res);
          return;
        }
        if (entries.length === 0) {
          this.host.print(style.gray("The knowledge base is empty. Add something with /knowledge add <name> <path>."));
          return;
        }
        const lines = [style.bold("Knowledge base")];
        for (const e of entries) {
          const count = e.indexing ? style.yellow(String(e.items_display ?? "indexing…")) : style.gray(`${String(e.item_count ?? 0)} items`);
          lines.push(`  ${style.cyan(sanitize(String(e.name ?? "")))} ${style.gray(String(e.id ?? ""))}  ${count}`);
          if (e.path) {
            lines.push(style.gray(`      ${sanitize(String(e.path))}`));
          }
          if (e.description) {
            lines.push(style.gray(`      ${truncate(sanitize(String(e.description)), 70)}`));
          }
        }
        this.host.print(lines.join("\n"));
        return;
      }
      case "add":
        if (rest.length < 2) {
          this.host.print(style.gray("Usage: /knowledge add <name> <path>"));
          return;
        }
        this.result(await call({ subcommand: "add", name: rest[0], path: this.absPath(rest.slice(1).join(" ")) }));
        return;
      case "remove":
      case "rm":
        if (rest.length === 0) {
          this.host.print(style.gray("Usage: /knowledge remove <name|path>"));
          return;
        }
        this.result(await call({ subcommand: "remove", target: rest.join(" ") }));
        return;
      case "update":
        if (rest.length === 0) {
          this.host.print(style.gray("Usage: /knowledge update <path>"));
          return;
        }
        this.result(await call({ subcommand: "update", path: this.absPath(rest.join(" ")) }));
        return;
      case "clear":
        if (await this.host.confirm("Remove every entry from the knowledge base?")) {
          this.result(await call({ subcommand: "clear" }));
        }
        return;
      case "cancel":
        this.result(await call({ subcommand: "cancel", ...(rest[0] ? { operationId: rest[0] } : {}) }));
        return;
      default:
        this.host.print(style.gray("Usage: /knowledge [show | add <name> <path> | remove <name|path> | update <path> | clear | cancel [id]]"));
    }
  }

  // --- /mcp, /hooks, /code ---

  mcp(): void {
    const servers = this.host.mcpServers();
    if (servers.length === 0) {
      this.host.print(
        style.gray("No MCP servers are configured.") +
          "\n" +
          style.gray("Add them in ~/.kiro/settings/mcp.json (all projects) or .kiro/settings/mcp.json (this project), then /restart.")
      );
      return;
    }
    const lines = [style.bold("MCP servers")];
    for (const raw of servers) {
      const s = (raw ?? {}) as Record<string, unknown>;
      const name = sanitize(String(s.name ?? s.serverName ?? "?"));
      const status = String(s.status ?? s.state ?? "");
      const tools = Array.isArray(s.tools) ? `${s.tools.length} tools` : typeof s.toolCount === "number" ? `${s.toolCount} tools` : "";
      const color = /connect(ed)?|ready|running|ok/i.test(status) ? style.green : /error|fail/i.test(status) ? style.red : style.yellow;
      lines.push(`  ${style.cyan(name)}  ${color(status || "unknown")}${tools ? style.gray("  " + tools) : ""}`);
      if (s.error || s.message) {
        lines.push(style.red(`      ${truncate(sanitize(String(s.error ?? s.message)), 80)}`));
      }
    }
    this.host.print(lines.join("\n"));
  }

  async hooks(): Promise<void> {
    try {
      const res = await this.host.client().extMethod<{ hooks?: Array<Record<string, unknown>> }>("_kiro/hooks/list");
      const hooks = res.hooks ?? [];
      if (hooks.length === 0) {
        this.host.print(style.gray("No hooks are configured."));
        return;
      }
      const lines = [style.bold("Hooks")];
      for (const h of hooks) {
        const enabled = h.enabled === false ? style.gray("off") : style.green("on");
        lines.push(`  ${style.cyan(sanitize(String(h.name ?? h.id ?? "?")))}  ${enabled}  ${style.gray(sanitize(String(h.trigger ?? h.event ?? "")))}`);
      }
      this.host.print(lines.join("\n"));
    } catch (err) {
      const msg = errorMessage(err);
      this.host.print(
        /v2Hooks is disabled/.test(msg)
          ? style.gray("Hooks aren't enabled for this engine session, so there's nothing to show.")
          : style.red(msg)
      );
    }
  }

  async code(arg: string): Promise<void> {
    const sub = (tokenize(arg)[0] ?? "status").toLowerCase();
    if (!["status", "init", "overview"].includes(sub)) {
      this.host.print(style.gray("Usage: /code [status | init | overview]"));
      return;
    }
    const client = this.host.client();
    const res = await this.host.runBusy(sub === "init" ? "Setting up code intelligence" : "Loading", () =>
      client.extMethod<{ success?: boolean; message?: string; status?: Record<string, unknown>; overview?: unknown }>(
        "_kiro/codeIntelligence",
        { subcommand: sub }
      )
    );
    if (res.status) {
      const st = res.status;
      const lines = [style.bold("Code intelligence")];
      lines.push(`  initialized  ${st.initialized ? style.green("yes") : style.yellow("no")}`);
      if (Array.isArray(st.languages)) {
        lines.push(`  languages    ${st.languages.map((l) => sanitize(String(l))).join(", ") || style.gray("none detected")}`);
      }
      if (Array.isArray(st.lspServers)) {
        lines.push(`  servers      ${st.lspServers.map((l) => sanitize(typeof l === "string" ? l : String((l as { name?: unknown }).name ?? "?"))).join(", ") || style.gray("none")}`);
      }
      if (st.lspConfigPath) {
        lines.push(style.gray(`  config       ${sanitize(String(st.lspConfigPath))}`));
      }
      this.host.print(lines.join("\n"));
      return;
    }
    if (res.overview !== undefined) {
      this.host.print(sanitize(typeof res.overview === "string" ? res.overview : JSON.stringify(res.overview, null, 2)));
      return;
    }
    this.result(res);
  }

  // --- /agent, /plan, /prompts ---

  async agent(arg: string): Promise<void> {
    const words = tokenize(arg);
    const sub = (words[0] ?? "").toLowerCase();
    if (sub === "create" || sub === "edit") {
      const name = words[1];
      if (!name) {
        this.host.print(style.gray(`Usage: /agent ${sub} <name>`));
        return;
      }
      this.runKiroCliInShell(["agent", sub, name], `Kiro: agent ${sub}`);
      this.host.print(
        style.gray(`Opened “kiro-cli agent ${sub} ${sanitize(name)}” in a terminal; the config opens in VS Code. `) +
          style.gray("New agents show up in /agent once saved.")
      );
      return;
    }
    const mode = this.host.option("mode");
    const choices = mode?.options ?? [];
    if (!sub || sub === "list") {
      const current = String(mode?.currentValue ?? "");
      const lines = [style.bold("Agents")];
      for (const c of choices) {
        const mark = c.value === current ? style.green("●") : style.gray("○");
        lines.push(fitAnsi(`  ${mark} ${style.cyan(sanitize(c.value))}${c.name !== c.value ? " " + sanitize(c.name) : ""}${c.description ? style.gray(" – " + sanitize(c.description)) : ""}`, this.host.cols() - 1));
      }
      lines.push(style.gray("Switch with /agent <name> · create one with /agent create <name>"));
      this.host.print(lines.join("\n"));
      return;
    }
    const q = words.join(" ").toLowerCase();
    const hit =
      choices.find((c) => c.value.toLowerCase() === q || c.name.toLowerCase() === q) ??
      choices.find((c) => c.value.toLowerCase().startsWith(q) || c.name.toLowerCase().startsWith(q));
    if (!hit) {
      this.host.print(style.yellow(`No agent matches “${sanitize(q)}”.`) + style.gray(" Type /agent to list them."));
      return;
    }
    await this.host.client().setMode(hit.value);
    this.host.print(style.gray("Agent: ") + sanitize(hit.name) + style.gray("."));
  }

  async plan(): Promise<void> {
    const current = String(this.host.option("mode")?.currentValue ?? "");
    const target = current === "plan" ? "vibe" : "plan";
    await this.host.client().setMode(target);
    this.host.print(
      target === "plan"
        ? style.gray("Plan agent on: it plans without changing files. Type /plan again to switch back.")
        : style.gray("Back to the Default agent.")
    );
  }

  async prompts(arg: string): Promise<void> {
    const cmds = this.host.engineCommands();
    const name = arg.trim().replace(/^\//, "");
    if (name) {
      const hit = cmds.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (!hit) {
        this.host.print(style.yellow(`No prompt named “${sanitize(name)}”.`) + style.gray(" Type /prompts to list them."));
        return;
      }
      await this.host.sendPrompt("/" + hit.name);
      return;
    }
    if (cmds.length === 0) {
      this.host.print(style.gray("No prompts are available."));
      return;
    }
    const lines = [style.bold("Prompts and agent commands")];
    for (const c of cmds) {
      const kind = c.type ? style.gray(` [${sanitize(c.type)}]`) : "";
      lines.push(fitAnsi(`  ${style.cyan("/" + sanitize(c.name))}${kind}${c.description ? style.gray(" – " + sanitize(c.description)) : ""}`, this.host.cols() - 1));
    }
    lines.push(style.gray("Run one with /<name> or /prompts <name>."));
    this.host.print(lines.join("\n"));
  }

  // --- /copy, /editor, /reply, /paste ---

  async copy(): Promise<void> {
    const last = [...this.host.transcript()].reverse().find((e) => e.role === "assistant");
    if (!last || !last.text.trim()) {
      this.host.print(style.gray("There's no reply to copy yet."));
      return;
    }
    await vscode.env.clipboard.writeText(last.text.trim());
    this.host.print(style.gray(`Copied the last reply (${last.text.trim().length} characters).`));
  }

  async editor(reply: boolean): Promise<void> {
    let initial = "";
    if (reply) {
      const last = [...this.host.transcript()].reverse().find((e) => e.role === "assistant");
      if (!last) {
        this.host.print(style.gray("There's no reply to answer yet."));
        return;
      }
      initial = last.text.trim().split("\n").map((l) => "> " + l).join("\n") + "\n\n";
    }
    const file = path.join(os.tmpdir(), `kiro-chat-prompt-${Date.now()}.md`);
    fs.writeFileSync(file, initial, { mode: 0o600 });
    const uri = vscode.Uri.file(file);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    this.host.print(style.gray("Write your message in the editor tab, save, and close the tab. It'll appear here, ready to send."));
    await waitForTabClose(uri);
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
    text = text.replace(/\s+$/, "");
    if (!text || text === initial.trim()) {
      this.host.print(style.gray("Nothing was written (did you save before closing?)."));
      return;
    }
    this.host.setInput(text);
    this.host.print(style.gray("Your text is in the prompt below. Press Enter to send it."));
  }

  async paste(): Promise<void> {
    if (process.platform !== "darwin") {
      this.host.print(style.gray("/paste reads images from the macOS clipboard. On this system, drag image files onto the terminal instead."));
      return;
    }
    const file = path.join(os.tmpdir(), `kiro-chat-clipboard-${Date.now()}.png`);
    const script = [
      "try",
      "set d to the clipboard as «class PNGf»",
      `set f to open for access POSIX file "${file}" with write permission`,
      "set eof f to 0",
      "write d to f",
      "close access f",
      'return "ok"',
      "on error",
      'return "none"',
      "end try",
    ];
    const out = await new Promise<string>((resolve) => {
      execFile("osascript", script.flatMap((l) => ["-e", l]), { timeout: 10_000 }, (err, stdout) =>
        resolve(err ? "none" : String(stdout).trim())
      );
    });
    if (out !== "ok" || !fs.existsSync(file)) {
      this.host.print(style.gray("There's no image on the clipboard. Copy one (e.g. Cmd+Ctrl+Shift+4 for a screenshot) and try again."));
      return;
    }
    const data = fs.readFileSync(file);
    fs.unlinkSync(file);
    if (data.length > 10 * 1024 * 1024) {
      this.host.print(style.yellow("The clipboard image is larger than 10 MB and wasn't attached."));
      return;
    }
    this.host.addPendingImage({ mimeType: "image/png", data: data.toString("base64"), name: "clipboard.png" });
    this.host.print(style.gray(`📎 Clipboard image (${Math.round(data.length / 1024)} KB) will be sent with your next message.`));
  }

  // --- /transcript, /chat save ---

  async transcript(arg: string): Promise<void> {
    const [sub = "show", ...rest] = tokenize(arg);
    if (this.host.transcript().length === 0) {
      this.host.print(style.gray("The conversation is empty."));
      return;
    }
    if (sub.toLowerCase() === "save") {
      await this.saveTranscript(rest.join(" "));
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ content: this.transcriptMarkdown(), language: "markdown" });
    await vscode.window.showTextDocument(doc, { preview: false });
    this.host.print(style.gray("Opened the transcript in an editor tab."));
  }

  async saveTranscript(file: string): Promise<void> {
    if (this.host.transcript().length === 0) {
      this.host.print(style.gray("The conversation is empty; nothing to save."));
      return;
    }
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
    const target = this.absPath(file || `kiro-chat-${stamp}.md`);
    if (fs.existsSync(target) && !(await this.host.confirm(`${target} exists. Overwrite it?`))) {
      return;
    }
    fs.writeFileSync(target, this.transcriptMarkdown());
    this.host.print(style.gray("Saved the transcript to ") + style.magenta(target));
  }

  private transcriptMarkdown(): string {
    const parts = [`# ${this.host.title()}`, ""];
    for (const e of this.host.transcript()) {
      if (e.role === "user") {
        parts.push("## You", "", e.text.trim(), "");
      } else if (e.role === "assistant") {
        parts.push("## Kiro", "", e.text.trim(), "");
      } else {
        parts.push(`> 🔧 ${e.text}`, "");
      }
    }
    return parts.join("\n");
  }

  // --- /rewind ---

  async rewind(arg: string): Promise<void> {
    const turns = this.host.userTurns();
    if (turns.length === 0) {
      this.host.print(style.gray("Nothing to rewind: no messages have been sent in this chat yet (resumed history can't be rewound)."));
      return;
    }
    const n = Number.parseInt(arg.trim(), 10);
    if (!arg.trim()) {
      const lines = [style.bold("Your messages")];
      turns.forEach((t, i) => {
        lines.push(`  ${style.cyan(String(i + 1).padStart(2))}  ${truncate(oneLine(t.text), Math.max(20, this.host.cols() - 10))}`);
      });
      lines.push(style.gray("Type /rewind <n> to go back to before message n (you can then edit and resend it)."));
      this.host.print(lines.join("\n"));
      return;
    }
    const turn = turns[n - 1];
    if (!turn) {
      this.host.print(style.yellow(`There's no message #${arg.trim()}.`) + style.gray(" Type /rewind to list them."));
      return;
    }
    const later = turns.length - (n - 1);
    const ok = await this.host.confirm(
      `Go back to before message ${n}? This removes ${later === 1 ? "that message and its reply" : `${later} messages and their replies`}, ` +
        "and undoes the agent's file changes from that point on."
    );
    if (!ok) {
      return;
    }
    const client = this.host.client();
    const res = await this.host.runBusy("Rewinding", () =>
      client.extMethod<{ success?: boolean; affectedFiles?: string[] }>("_kiro/checkpoint/revertMultiple", { messageId: turn.messageId })
    );
    if (!res?.success) {
      this.host.print(style.yellow("The engine couldn't rewind to that message."));
      return;
    }
    this.host.truncateConversation(n - 1);
    const files = res.affectedFiles ?? [];
    this.host.print(
      style.gray(`Rewound to before message ${n}.`) +
        (files.length ? "\n" + style.gray("Restored files:") + "\n" + files.map((f) => "  " + style.magenta(sanitize(f))).join("\n") : "")
    );
    this.host.setInput(turn.text);
  }

  // --- /title, /stats, /changelog, /settings, /theme, /spawn ---

  async title(arg: string): Promise<void> {
    const t = arg.trim();
    if (!t) {
      this.host.print(style.gray("Title: ") + sanitize(this.host.title()) + style.gray("  (/title <text> to change, /title clear to reset)"));
      return;
    }
    if (t.toLowerCase() === "clear") {
      this.host.setTitle(undefined);
      this.host.print(style.gray("Title reset."));
      return;
    }
    this.host.setTitle(t);
    try {
      await this.host.client().extMethod("_kiro/session/rename", { title: t });
    } catch (err) {
      this.host.log("rename failed: " + errorMessage(err));
    }
    this.host.print(style.gray("Title set to ") + sanitize(t) + style.gray(" (terminal tab and session)."));
  }

  stats(): void {
    const stats = this.host.turnStats();
    if (stats.length === 0) {
      this.host.print(style.gray("No turns yet."));
      return;
    }
    const lines = [style.bold("Recent turns")];
    for (const s of stats.slice(-10)) {
      const time = s.at.toLocaleTimeString();
      const credits = s.credits !== undefined ? ` · ${s.credits.toFixed(2)} credits` : "";
      const status = s.status === "success" ? "" : style.yellow(` · ${s.status}`);
      lines.push(`  ${style.gray(time)}  ${(s.elapsedMs / 1000).toFixed(1)}s${credits}${status}  ${truncate(oneLine(s.prompt), 40)}`);
      for (const id of s.requestIds) {
        lines.push(style.gray(`      request ${id}`));
      }
    }
    this.host.print(lines.join("\n"));
  }

  async changelog(arg: string): Promise<void> {
    const cli = this.host.cliPath();
    if (!cli) {
      this.host.print(style.red("kiro-cli wasn't found."));
      return;
    }
    const a = arg.trim();
    const flag = a ? `--changelog=${a}` : "--changelog";
    const out = await this.host.runBusy("Loading changelog", () =>
      new Promise<string>((resolve) => {
        execFile(cli, ["version", flag], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
          resolve(err && !stdout ? String(stderr || err.message) : String(stdout))
        );
      })
    );
    const lines = sanitize(out).trim().split("\n");
    const shown = lines.slice(0, 200);
    this.host.print(
      shown
        .map((l) => (/^(Changelog|Version)\b/.test(l) ? style.bold(l) : /^\s*- /.test(l) ? l.replace(/^(\s*)- /, `$1${style.cyan("•")} `) : l))
        .join("\n") + (lines.length > shown.length ? "\n" + style.gray(`… ${lines.length - shown.length} more lines`) : "")
    );
  }

  async settings(): Promise<void> {
    await vscode.commands.executeCommand("workbench.action.openSettings", "kiroCliChat");
    this.host.print(style.gray("Opened the Kiro CLI Chat settings. Session settings are in /config."));
  }

  async theme(): Promise<void> {
    await vscode.commands.executeCommand("workbench.action.selectTheme");
    this.host.print(style.gray("The terminal chat uses your VS Code color theme."));
  }

  spawn(arg: string): void {
    const task = arg.trim();
    if (!task) {
      this.host.print(style.gray("Usage: /spawn <task>"));
      return;
    }
    this.host.spawn(task);
    this.host.print(style.gray("Started the task in a new Kiro Chat terminal."));
  }

  // --- helpers ---

  private runKiroCliInShell(args: string[], name: string): void {
    const cli = this.host.cliPath() ?? "kiro-cli";
    const t = vscode.window.createTerminal({
      name,
      cwd: this.host.cwd(),
      // kiro-cli opens $EDITOR for agent configs; use VS Code and wait for the tab.
      env: { EDITOR: "code --wait", VISUAL: "code --wait" },
    });
    t.show();
    t.sendText([cli, ...args].map(shellQuote).join(" "));
  }

  private absPath(p: string): string {
    const expanded = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
    return path.isAbsolute(expanded) ? expanded : path.resolve(this.host.cwd(), expanded);
  }

  /** Print an engine `{success, message}` result. */
  private result(res: unknown): void {
    const r = (res ?? {}) as { success?: boolean; message?: string };
    const msg = sanitize(r.message ?? (r.success === false ? "That didn't work." : "Done."));
    this.host.print(r.success === false ? style.yellow(msg) : style.gray(msg));
  }
}

// --- small helpers ---

function bar(pct: number, width: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  return style.green("█".repeat(filled)) + style.gray("░".repeat(width - filled));
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function truncate(s: string, max: number): string {
  const plain = stripAnsi(s);
  return plain.length > max ? plain.slice(0, Math.max(1, max - 1)) + "…" : s;
}

function oneLine(s: string): string {
  return sanitize(s).replace(/\s+/g, " ").trim();
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}


/** Resolve when no editor tab shows `uri` any more. */
function waitForTabClose(uri: vscode.Uri): Promise<void> {
  const isOpen = () =>
    vscode.window.tabGroups.all.some((g) =>
      g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === uri.fsPath)
    );
  return new Promise((resolve) => {
    const sub = vscode.window.tabGroups.onDidChangeTabs(() => {
      if (!isOpen()) {
        sub.dispose();
        resolve();
      }
    });
  });
}
