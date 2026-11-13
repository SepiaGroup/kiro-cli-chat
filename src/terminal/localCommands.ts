// The terminal chat's built-in commands that work on the session itself
// (help, model/effort/autopilot/tools/config, resume) and the dispatcher that
// sends every slash command to its implementation. Pure (no vscode import):
// everything else goes through the host.

import { listSessions } from "../detect";
import { errorMessage } from "../format";
import { pickSessions } from "../sessionList";
import type { SessionSummary } from "../types";
import { fitAnsi, sanitize, style, truncate } from "./ansi";
import type { SessionConfig } from "./sessionConfig";
import { COMMANDS } from "./slashCommands";
import type { ChatHost, TerminalCommands } from "./terminalCommands";

/** What the local commands need from the chat terminal. */
export interface LocalHost extends ChatHost {
  commands(): TerminalCommands;
  config(): SessionConfig;
  engine(): string | undefined;
  toolGroups(): Array<{ tag: string; description: string }>;
  updatePrompt(): void;
  resetConversationState(): void;
  newConversation(clearScreen: boolean): Promise<void>;
  restart(): Promise<void>;
  login(): void;
  clearScreen(): void;
  exit(): void;
}

export class LocalCommands {
  private lastSessions: SessionSummary[] = [];

  constructor(private readonly host: LocalHost) {}

  async run(cmd: string, arg: string): Promise<void> {
    try {
      switch (cmd) {
        case "help":
          this.help();
          break;
        case "clear":
        case "new":
          await this.host.newConversation(cmd === "clear");
          break;
        case "chat": {
          const [sub = "", ...rest] = arg.split(/\s+/);
          if (sub === "new") {
            await this.host.newConversation(false);
          } else if (sub === "save") {
            await this.host.commands().saveTranscript(rest.join(" "));
          } else if (sub === "load") {
            await this.resume(rest.join(" "));
          } else {
            this.host.print(style.gray("Usage: /chat new | save [file] | load"));
          }
          break;
        }
        case "context":
          await this.host.commands().context(arg);
          break;
        case "compact":
          await this.host.commands().compact();
          break;
        case "usage":
          await this.host.commands().usage();
          break;
        case "knowledge":
          await this.host.commands().knowledge(arg);
          break;
        case "mcp":
          this.host.commands().mcp();
          break;
        case "hooks":
          await this.host.commands().hooks();
          break;
        case "code":
          await this.host.commands().code(arg);
          break;
        case "agent":
          await this.host.commands().agent(arg);
          break;
        case "plan":
          await this.host.commands().plan();
          break;
        case "prompts":
          await this.host.commands().prompts(arg);
          break;
        case "copy":
          await this.host.commands().copy();
          break;
        case "editor":
        case "reply":
          // Don't block the prompt while the editor tab is open.
          void this.host.commands().editor(cmd === "reply").catch((e) => this.host.print(style.red(errorMessage(e))));
          break;
        case "paste":
          await this.host.commands().paste();
          break;
        case "transcript":
          await this.host.commands().transcript(arg);
          break;
        case "rewind":
          await this.host.commands().rewind(arg);
          break;
        case "title":
          await this.host.commands().title(arg);
          break;
        case "stats":
          this.host.commands().stats();
          break;
        case "changelog":
          await this.host.commands().changelog(arg);
          break;
        case "settings":
          await this.host.commands().settings();
          break;
        case "theme":
          await this.host.commands().theme();
          break;
        case "spawn":
          this.host.commands().spawn(arg);
          break;
        case "resume":
          await this.resume(arg);
          break;
        case "model":
          await this.selectOption("model", arg, "Model");
          break;
        case "effort":
          await this.selectOption("effortLevel", arg, "Effort");
          break;
        case "autopilot":
          await this.setAutopilot(arg);
          break;
        case "tools":
          await this.toolsCommand(arg);
          break;
        case "config":
          this.showConfig();
          break;
        case "set": {
          const m = /^(\S+)\s+(.+)$/.exec(arg);
          if (!m) {
            this.host.print(style.gray("Usage: /set <id> <value>   (see /config for ids)"));
            break;
          }
          await this.selectOption(m[1], m[2], m[1]);
          break;
        }
        case "restart":
          await this.host.restart();
          break;
        case "login":
          this.host.login();
          break;
        case "cls":
          this.host.clearScreen();
          break;
        case "quit":
          this.host.exit();
          break;
      }
    } catch (err) {
      this.host.print(style.red(errorMessage(err)));
    }
  }

  private help(): void {
    const usable = COMMANDS.filter((c) => !c.unavailable);
    const left = (c: (typeof COMMANDS)[number]) => "/" + c.name + (c.args ? " " + c.args : c.subs ? " …" : "");
    const width = Math.min(26, Math.max(...usable.map((c) => left(c).length)) + 2);
    const lines = [style.bold("Commands") + style.gray("  (type / for a menu; Tab or Enter picks)")];
    for (const c of usable) {
      lines.push("  " + style.cyan(left(c).padEnd(width)) + style.gray(c.desc));
    }
    if (this.host.engineCommands().length > 0) {
      lines.push("", style.bold("Agent commands") + style.gray(" (sent to the engine)"));
      for (const c of this.host.engineCommands()) {
        const desc = sanitize(c.description ?? "").replace(/\s+/g, " ");
        lines.push(fitAnsi("  " + style.cyan(("/" + sanitize(c.name)).padEnd(width)) + style.gray(desc), this.host.cols() - 1));
      }
    }
    const missing = COMMANDS.filter((c) => c.unavailable).map((c) => "/" + c.name);
    lines.push(
      "",
      style.bold("Keys"),
      style.gray("  Enter send · Shift+Enter, Ctrl+J or a trailing \\ for a new line · ↑/↓ history"),
      style.gray("  Esc or Ctrl+C cancel a reply · Ctrl+L clear · Ctrl+D close"),
      "",
      style.bold("Images"),
      style.gray("  Drag image files onto this terminal (or type their paths), or /paste a copied image."),
      "",
      style.gray(`Not available in this extension: ${missing.join(", ")}.`)
    );
    this.host.print(lines.join("\n"));
  }

  async resume(arg: string): Promise<void> {
    const client = this.host.client();
    if (arg) {
      const n = Number.parseInt(arg, 10);
      const pick = this.lastSessions[n - 1];
      if (!pick) {
        this.host.print(style.yellow(`No session #${arg}. Type /resume to list sessions.`));
        return;
      }
      this.host.print(style.gray(`Resuming “${sanitize(pick.title || pick.sessionId)}”…`) + "\n");
      this.host.resetConversationState();
      await this.host.runBusy("Loading history", () => client.loadSession(pick.sessionId));
      this.host.print("\n" + style.gray("Resumed. Continue the conversation below."));
      return;
    }
    const cliPath = this.host.cliPath();
    if (!cliPath) {
      throw new Error("The engine isn't running. Type /restart.");
    }
    const sessions = await this.host.runBusy("Loading sessions", () =>
      listSessions(cliPath, this.host.cwd(), (m) => this.host.log(m))
    );
    const list = pickSessions(sessions, this.host.engine(), this.host.cwd(), client.currentSessionId).slice(0, 15);
    this.lastSessions = list;
    if (list.length === 0) {
      this.host.print(style.gray("No previous sessions found."));
      return;
    }
    const lines = [style.bold("Recent sessions")];
    list.forEach((s, i) => {
      const meta = [relativeTime(s.updatedAt), s.messageCount ? `${s.messageCount} msgs` : ""]
        .filter(Boolean)
        .join(" · ");
      lines.push(
        `  ${style.cyan(String(i + 1).padStart(2))}  ${truncate(sanitize(s.title || "(untitled)"), Math.max(20, this.host.cols() - 30))}  ${style.gray(meta)}`
      );
    });
    lines.push(style.gray("Type /resume <number> to continue one."));
    this.host.print(lines.join("\n"));
  }

  private async selectOption(id: string, arg: string, label: string): Promise<void> {
    const opt = this.host.config().option(id);
    if (!opt) {
      this.host.print(
        style.yellow(
          id === "effortLevel"
            ? "The current model doesn't support effort levels."
            : `Unknown setting “${id}”. Type /config to see them.`
        )
      );
      return;
    }
    const choices = opt.options ?? [];
    if (!arg) {
      const current = String(opt.currentValue ?? "");
      const lines = [style.bold(`${label}: `) + this.host.config().valueName(opt)];
      for (const c of choices) {
        const mark = c.value === current ? style.green("●") : style.gray("○");
        const desc = c.description ? style.gray(" – " + truncate(sanitize(c.description), 60)) : "";
        lines.push(`  ${mark} ${sanitize(c.name)}${c.name !== c.value ? style.gray(` (${c.value})`) : ""}${desc}`);
      }
      if (choices.length > 0) {
        lines.push(style.gray(`Type /${id === "model" ? "model" : id === "effortLevel" ? "effort" : `set ${id}`} <name> to change it.`));
      }
      this.host.print(lines.join("\n"));
      return;
    }
    let value = arg;
    if (choices.length > 0) {
      const a = arg.toLowerCase();
      const hit =
        choices.find((c) => c.value.toLowerCase() === a || c.name.toLowerCase() === a) ??
        choices.find((c) => c.value.toLowerCase().startsWith(a) || c.name.toLowerCase().startsWith(a)) ??
        choices.find((c) => c.value.toLowerCase().includes(a) || c.name.toLowerCase().includes(a));
      if (!hit) {
        this.host.print(style.yellow(`No ${label.toLowerCase()} matches “${arg}”.`) + style.gray(` Type /${id === "model" ? "model" : id === "effortLevel" ? "effort" : `set ${id}`} to list them.`));
        return;
      }
      value = hit.value;
    }
    const client = this.host.client();
    await client.setConfigOption(id, value);
    if (id === "autopilot") {
      client.setAutoApprove(value === "on");
    }
    const name = choices.find((c) => c.value === value)?.name ?? value;
    this.host.print(style.gray(`${label} set to `) + sanitize(name) + style.gray("."));
  }

  private async setAutopilot(arg: string): Promise<void> {
    const opt = this.host.config().option("autopilot");
    const current = String(opt?.currentValue ?? "off");
    const a = arg.toLowerCase();
    if (!a) {
      this.host.print(
        style.gray("Autopilot is ") +
          (current === "on" ? style.yellow("on") + style.gray(" (tools run without asking)") : "off" + style.gray(" (Supervised: you approve changes)")) +
          style.gray(". Type /autopilot on|off.")
      );
      return;
    }
    if (a !== "on" && a !== "off") {
      this.host.print(style.gray("Usage: /autopilot on|off"));
      return;
    }
    const client = this.host.client();
    if (opt) {
      await client.setConfigOption("autopilot", a);
    }
    client.setAutoApprove(a === "on");
    this.host.updatePrompt();
    this.host.print(style.gray("Autopilot ") + (a === "on" ? style.yellow("on") : "off") + style.gray("."));
  }

  /**
   * kiro-cli's /tools. The engine only exposes all-or-nothing trust over ACP
   * (its autopilot option), so trust-all/reset map to Autopilot on/off.
   */
  private async toolsCommand(arg: string): Promise<void> {
    const a = arg.toLowerCase().replace(/^-+/, "").replace(/\s+/g, " ");
    if (a === "trust-all" || a === "trustall" || a === "trust all") {
      await this.setAutopilot("on");
      return;
    }
    if (a === "reset" || a === "untrust-all" || a === "untrust all" || a === "untrustall") {
      await this.setAutopilot("off");
      return;
    }
    if (a.startsWith("trust") || a.startsWith("untrust")) {
      this.host.print(
        style.yellow("Trusting individual tools isn't available in this engine.") +
          style.gray(" Use /tools trust-all (Autopilot) or /tools reset (Supervised).")
      );
      return;
    }
    if (a) {
      this.host.print(style.gray("Usage: /tools [trust-all|reset]"));
      return;
    }
    const auto = String(this.host.config().option("autopilot")?.currentValue ?? "off") === "on";
    const trust = auto ? style.yellow("trusted") : style.gray("ask first");
    const lines = [style.bold("Tools") + style.gray(auto ? "  (Autopilot: all trusted)" : "  (Supervised)")];
    const groups = this.host.toolGroups().length
      ? this.host.toolGroups()
      : [{ tag: "read", description: "" }, { tag: "write", description: "" }, { tag: "shell", description: "" }, { tag: "web", description: "" }];
    const width = Math.max(...groups.map((g) => g.tag.length)) + 2;
    for (const g of groups) {
      // Reading files never asks for approval; other tools follow the mode.
      const state = g.tag === "read" ? style.gray("allowed") : trust;
      lines.push(`  ${style.cyan(g.tag.padEnd(width))}${state}${g.description ? style.gray("  " + sanitize(g.description)) : ""}`);
    }
    lines.push(style.gray(auto ? "Type /tools reset to ask before changes again." : "Type /tools trust-all to run tools without asking."));
    this.host.print(lines.join("\n"));
  }

  private showConfig(): void {
    if (this.host.config().all.length === 0) {
      this.host.print(style.gray("No settings reported by the engine yet."));
      return;
    }
    const width = Math.max(...this.host.config().all.map((o) => o.id.length)) + 2;
    const lines = [style.bold("Session settings")];
    for (const o of this.host.config().all) {
      lines.push(`  ${style.cyan(o.id.padEnd(width))}${this.host.config().valueName(o)}${style.gray("  " + sanitize(o.name))}`);
    }
    lines.push(style.gray("Change one with /set <id> <value>  (e.g. /set memoryReflection off)."));
    this.host.print(lines.join("\n"));
  }
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return "";
  }
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) {
    return "just now";
  }
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.round(mins / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}
