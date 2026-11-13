// Text-only chat that runs inside a VS Code terminal (a Pseudoterminal).
//
// Each terminal owns its own engine process and conversation, so several can
// run side by side in the Terminal panel. The webview chat is unaffected.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AcpClient } from "../acpClient";
import { checkFolder, truncate as shorten } from "../approvalRules";
import { readConfig } from "../config";
import { listSessions } from "../detect";
import { NotLoggedInError, prepareEngine, resetPreparedEngine } from "../enginePrep";
import {
  ApprovalAnswer,
  ApprovalOption,
  ApprovalRequest,
  RpcId,
  AvailableCommand,
  ChatEvent,
  ConfigOption,
  PromptImage,
  SessionSummary,
  ToolDiff,
} from "../types";
import { diffLines } from "../webview/lineDiff";
import { crlf, fitAnsi, sanitize, stripAnsi, style, term, visibleWidth } from "./ansi";
import { MarkdownStream } from "./ansiMarkdown";
import { findImagePaths, imageMimeForPath } from "./imagePaths";
import { LineEditor } from "./lineEditor";
import { COMMANDS, findCommand, Menu, MenuValue, slashMenu, ValueSource } from "./slashCommands";
import { ChatHost, TerminalCommands, TranscriptEntry, TurnStat, UserTurn } from "./terminalCommands";

type State = "starting" | "idle" | "busy" | "closed";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 10;
const MAX_DIFF_LINES = 60;
const MENU_ROWS = 8;

export interface TerminalChatOptions {
  /** Sent as soon as the engine is ready (used by /spawn). */
  initialPrompt?: string;
  /** Open another chat terminal running `task`. */
  spawn?: (task: string) => void;
}

interface ToolState {
  title: string;
  started: number;
  diffShown: boolean;
  done: boolean;
}

/**
 * An approval being answered. Like the kiro-cli TUI: a first screen
 * (y / n / Tab for a reason / t allow rule / d deny rule), a rule screen,
 * and text input for a folder rule or a deny reason.
 */
interface PendingApproval {
  request: ApprovalRequest;
  requestId?: RpcId;
  page: "main" | "allow" | "deny" | "folder" | "reason";
  input: string;
  /** Characters on screen for the input line, to redraw it. */
  drawn: number;
}

export class TerminalChat implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidClose = this.closeEmitter.event;
  private readonly nameEmitter = new vscode.EventEmitter<string>();
  readonly onDidChangeName = this.nameEmitter.event;

  private cols = 80;
  private rows = 24;
  private state: State = "starting";
  private client?: AcpClient;
  private engine?: string;
  private readonly editor = new LineEditor();
  private readonly md = new MarkdownStream(
    () => this.cols,
    () => this.rows
  );
  private inAssistant = false;

  private spinnerTimer?: ReturnType<typeof setInterval>;
  private spinnerFrame = 0;
  private spinnerVisible = false;
  private spinnerLabel = "Thinking";
  private busySince = 0;

  private configOptions: ConfigOption[] = [];
  private engineCommands: AvailableCommand[] = [];
  private usagePct?: number;
  /** Credits reported for the current turn (engine sends one per reply). */
  private turnCredits?: number;
  private readonly tools = new Map<string, ToolState>();
  private lastToolId?: string;
  private approval?: PendingApproval;
  /** Approvals that arrived while another was being answered. */
  private approvalQueue: PendingApproval[] = [];
  private lastSessions: SessionSummary[] = [];
  private toolGroups: Array<{ tag: string; description: string }> = [];
  private lastInterrupt = 0;
  private cancelled = false;
  private cliPath?: string;

  // Conversation bookkeeping for /copy, /transcript, /rewind, /stats.
  private transcript: TranscriptEntry[] = [];
  private userTurns: UserTurn[] = [];
  private turnStats: TurnStat[] = [];
  private currentPrompt?: string;
  private lastTurn?: { elapsedMs?: number; requestIds: string[]; status?: string };
  private mcpServers: unknown[] = [];
  private pendingImages: PromptImage[] = [];
  private customTitle?: string;

  // y/n question asked by a command (e.g. /rewind).
  private confirmState?: (yes: boolean) => void;

  // Slash menu shown under the prompt while typing "/…".
  private menu?: Menu;
  private menuSel = 0;
  private menuText = "";
  private menuDismissedFor?: string;

  private readonly commands: TerminalCommands;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly name: string,
    private readonly options: TerminalChatOptions = {}
  ) {
    this.commands = new TerminalCommands(this.makeHost());
  }

  // --- Pseudoterminal ---

  open(dims: vscode.TerminalDimensions | undefined): void {
    if (dims) {
      this.cols = dims.columns;
      this.rows = dims.rows;
    }
    this.write(term.bracketedPasteOn);
    this.write(style.bold(style.magenta("Kiro Chat")) + style.gray(" · text mode") + "\r\n\r\n");
    void this.start();
  }

  close(): void {
    this.shutdown();
  }

  setDimensions(dims: vscode.TerminalDimensions): void {
    this.cols = dims.columns;
    this.rows = dims.rows;
    if (this.state === "idle" && this.editor.isDrawn) {
      this.redrawPrompt();
    }
  }

  handleInput(data: string): void {
    if (this.state === "closed") {
      return;
    }
    if (this.confirmState) {
      this.handleConfirmKey(data);
      return;
    }
    if (this.approval) {
      this.handleApprovalKey(data);
      return;
    }
    if (this.state === "idle" && this.handleMenuKey(data)) {
      return;
    }
    for (const action of this.editor.handleInput(data)) {
      switch (action.type) {
        case "changed":
          if (this.state === "idle") {
            this.redrawPrompt();
          }
          break;
        case "submit":
          if (this.state === "idle") {
            void this.submit(action.text);
          } else {
            this.write("\x07"); // bell: still busy (the text stays in the box)
          }
          break;
        case "interrupt":
          this.onInterrupt();
          break;
        case "escape":
          if (this.state === "busy") {
            this.cancelTurn();
          }
          break;
        case "eof":
          if (this.state === "idle") {
            this.exit();
          }
          break;
        case "complete":
          // Tab with no menu showing: nothing to complete.
          this.write("\x07");
          break;
        case "clearScreen":
          this.clearScreen();
          break;
      }
    }
  }

  // --- lifecycle ---

  private async start(): Promise<void> {
    this.state = "starting";
    this.busySince = Date.now();
    this.startSpinner("Starting up");
    const cfg = readConfig();
    try {
      const prep = await prepareEngine(cfg.cliPath, cfg.engine, (m) => this.log("[detect] " + m));
      if (this.isClosed()) {
        return;
      }
      const client = new AcpClient({
        cliPath: prep.cliPath,
        engine: prep.engine,
        model: cfg.model,
        cwd: this.cwd(),
        trustAllTools: cfg.autopilot,
      });
      this.wire(client);
      await client.start();
      if (this.isClosed()) {
        client.dispose();
        return;
      }
      this.client = client;
      this.engine = prep.engine;
      this.cliPath = prep.cliPath;
      // The engine starts with autopilot "on", but approvals follow the
      // extension's setting. Always sync (even if the engine's settings list
      // hasn't arrived yet — it can come after session/new returns).
      await client
        .setConfigOption("autopilot", cfg.autopilot ? "on" : "off")
        .catch((e) => this.log(`autopilot sync failed: ${errorMessage(e)}`));
      // v3 rejects --model, so apply kiroCliChat.defaultModel as a session option.
      if (prep.engine === "v3" && cfg.model && cfg.model !== "auto") {
        await client
          .setConfigOption("model", cfg.model)
          .catch((e) => this.log(`default model "${cfg.model}" not applied: ${errorMessage(e)}`));
      }
      this.stopSpinner();
      this.printBanner();
    } catch (err) {
      this.stopSpinner();
      if (err instanceof NotLoggedInError) {
        this.print(
          style.yellow("You're not logged in to Kiro CLI.") +
            "\n" +
            style.gray("Type /login, finish logging in in the terminal that opens, then type /restart.")
        );
      } else {
        this.print(style.red(`Couldn't start the engine: ${errorMessage(err)}`) + "\n" + style.gray("Type /restart to try again."));
      }
    }
    if (this.isClosed()) {
      return;
    }
    this.state = "idle";
    this.updatePrompt();
    this.showPrompt();
    const initial = this.options.initialPrompt;
    if (initial && this.client) {
      this.options.initialPrompt = undefined;
      await this.submit(initial);
    }
  }

  private wire(client: AcpClient): void {
    client.on("event", (ev: ChatEvent) => {
      if (this.client === client || this.state === "starting") {
        this.onEvent(ev);
      }
    });
    client.on("log", (line: string) => this.log("[acp] " + line));
    client.on("notification", (method: string, params: unknown) => {
      if (method === "_kiro/mcp/status") {
        const servers = (params as { servers?: unknown })?.servers;
        this.mcpServers = Array.isArray(servers) ? servers : [];
        return;
      }
      if (method === "_kiro/tools/didChange") {
        const tags = (params as { tags?: unknown })?.tags;
        if (Array.isArray(tags)) {
          this.toolGroups = tags
            .map((t) => t as { tag?: unknown; description?: unknown })
            .filter((t) => typeof t.tag === "string")
            .map((t) => ({ tag: String(t.tag), description: String(t.description ?? "") }));
        }
      }
    });
    client.on("exit", (code: number | null) => {
      if (this.client !== client || this.isClosed()) {
        return;
      }
      this.client = undefined;
      this.clearApprovals();
      this.endAssistant();
      this.print(style.red(`Engine exited (code ${String(code)}).`) + style.gray(" Type /restart to start it again."));
    });
  }

  private shutdown(): void {
    this.state = "closed";
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
    this.client?.dispose();
    this.client = undefined;
  }

  private exit(): void {
    this.shutdown();
    this.closeEmitter.fire();
  }

  private isClosed(): boolean {
    return this.state === "closed";
  }

  // --- engine events ---

  private onEvent(ev: ChatEvent): void {
    switch (ev.kind) {
      case "assistantChunk":
        this.writeAssistant(ev.text);
        break;
      case "thinking":
        this.spinnerLabel = "Thinking";
        break;
      case "userMessage":
        // Replayed history (from /resume).
        this.endAssistant();
        this.transcript.push({ role: "user", text: ev.text });
        this.print(this.formatUser(ev.text) + "\n");
        break;
      case "userMessageId":
        if (this.currentPrompt !== undefined) {
          this.userTurns.push({ messageId: ev.messageId, text: this.currentPrompt });
        }
        break;
      case "turnCompletion":
        this.lastTurn = { elapsedMs: ev.elapsedMs, requestIds: ev.requestIds, status: ev.status };
        break;
      case "toolCall":
        this.onToolCall(ev);
        break;
      case "toolUpdate":
        this.onToolUpdate(ev);
        break;
      case "approvalRequest":
        this.queueApproval(ev.request, ev.requestId);
        break;
      case "approvalResolved":
        this.onApprovalResolved(ev);
        break;
      case "contextUsage":
        this.usagePct = ev.usagePercentage;
        this.updatePrompt();
        break;
      case "metering":
        this.turnCredits = (this.turnCredits ?? 0) + ev.credits;
        break;
      case "configOptions":
        this.mergeConfig(ev.options);
        // Autopilot on/off changes the prompt ("!>" vs ">").
        this.updatePrompt();
        break;
      case "availableCommands":
        this.engineCommands = ev.commands;
        break;
      case "error":
        this.endAssistant();
        this.print(style.red(sanitize(ev.message)));
        break;
      default:
        break;
    }
  }

  private writeAssistant(text: string): void {
    let out = this.hideSpinner();
    if (!this.inAssistant) {
      this.inAssistant = true;
      this.md.reset();
      this.transcript.push({ role: "assistant", text: "" });
    }
    const last = this.transcript[this.transcript.length - 1];
    if (last?.role === "assistant") {
      last.text += text;
    }
    out += this.md.feed(text);
    this.write(out);
  }

  private endAssistant(): void {
    if (this.inAssistant) {
      this.inAssistant = false;
      this.write(this.hideSpinner() + this.md.flush());
    }
  }

  private onToolCall(ev: Extract<ChatEvent, { kind: "toolCall" }>): void {
    this.endAssistant();
    this.spinnerLabel = "Working";
    const title = sanitize(ev.title || "Tool");
    this.tools.set(ev.toolCallId, { title, started: Date.now(), diffShown: false, done: false });
    this.transcript.push({ role: "tool", text: title });
    this.lastToolId = ev.toolCallId;
    const paths = (ev.paths ?? []).map(sanitize);
    let text = style.yellow("●") + " " + highlightPaths(title, paths);
    const extra = paths.filter((p) => !title.includes(p));
    if (extra.length > 0) {
      text += "\n  " + extra.map((p) => style.magenta(p)).join(style.gray(", "));
    }
    this.print(text);
    if (ev.diff) {
      this.printDiff(ev.toolCallId, ev.diff, ev.startLine);
    }
  }

  private onToolUpdate(ev: Extract<ChatEvent, { kind: "toolUpdate" }>): void {
    const tool = this.tools.get(ev.toolCallId);
    if (ev.diff && tool && !tool.diffShown) {
      this.printDiff(ev.toolCallId, ev.diff, ev.startLine);
    }
    const s = (ev.status ?? "").toLowerCase();
    const ok = s === "completed" || s === "success";
    const failed = s === "failed" || s === "error";
    if (!ok && !failed) {
      return;
    }
    if (tool?.done) {
      return;
    }
    this.endAssistant();
    const label =
      tool && this.lastToolId !== ev.toolCallId ? `${truncate(tool.title, 50)} ` : "";
    if (ok) {
      const elapsed = tool ? ` in ${formatElapsed(Date.now() - tool.started)}` : "";
      this.print(style.gray(`  – ${label}${label ? "completed" : "Completed"}${elapsed}`));
    } else {
      let text = style.red(`  – ${label}${label ? "failed" : "Failed"}`);
      const outText = sanitize(ev.output ?? "").trim();
      if (outText) {
        const lines = outText.split("\n");
        text += "\n" + lines.slice(0, 8).map((l) => style.red("    " + l)).join("\n");
        if (lines.length > 8) {
          text += "\n" + style.gray(`    … ${lines.length - 8} more lines`);
        }
      }
      this.print(text);
    }
    if (tool) {
      tool.done = true;
    }
  }

  private printDiff(toolCallId: string, diff: ToolDiff, startLine?: number): void {
    if (typeof diff.newText !== "string") {
      return;
    }
    const tool = this.tools.get(toolCallId);
    if (tool) {
      tool.diffShown = true;
    }
    const lines = diffLines(diff.oldText ?? null, diff.newText);
    const offset = diff.oldText && startLine ? startLine - 1 : 0;
    const shown = lines.slice(0, MAX_DIFF_LINES);
    const rows = shown.map((l) => {
      if (l.kind === "gap") {
        return style.gray("       ⋮");
      }
      const num = l.lineNo !== undefined ? String(l.lineNo + offset) : "";
      const text = sanitize(l.text);
      if (l.kind === "add") {
        return style.green(`  + ${num.padStart(4)}: ${text}`);
      }
      if (l.kind === "del") {
        return style.red(`  - ${num.padStart(4)}: ${text}`);
      }
      return style.gray(`    ${num.padStart(4)}:`) + " " + text;
    });
    if (lines.length > shown.length) {
      rows.push(style.gray(`  … ${lines.length - shown.length} more lines`));
    }
    this.print(rows.join("\n"));
  }

  // --- approvals ---

  private clearApprovals(): void {
    this.approval = undefined;
    this.approvalQueue = [];
  }

  private queueApproval(request: ApprovalRequest, requestId?: RpcId): void {
    const pending: PendingApproval = { request, requestId, page: "main", input: "", drawn: 0 };
    if (this.approval) {
      this.approvalQueue.push(pending);
      return;
    }
    this.approval = pending;
    this.endAssistant();
    this.showApproval();
  }

  /** Answered by a rule created for another approval (entire tool). */
  private onApprovalResolved(ev: Extract<ChatEvent, { kind: "approvalResolved" }>): void {
    const before = this.approvalQueue.length;
    const q = this.approvalQueue.find((a) => a.requestId === ev.requestId);
    this.approvalQueue = this.approvalQueue.filter((a) => a.requestId !== ev.requestId);
    if (q && this.approvalQueue.length < before) {
      const mark = ev.allowed ? style.green("✓") : style.red("✗");
      this.print(`  ${mark} ${style.gray(sanitize(ev.label) + ": ")}${sanitize(q.request.part ?? q.request.question)}`);
    }
  }

  private nextApproval(): void {
    this.approval = this.approvalQueue.shift();
    if (this.approval) {
      this.showApproval();
    }
  }

  private approvalOption(kind: string): ApprovalOption | undefined {
    return this.approval?.request.options.find((o) => o.kind === kind);
  }

  /** First screen: the question and y / n / Tab / t / d. */
  private showApproval(): void {
    const a = this.approval;
    if (!a) {
      return;
    }
    const r = a.request;
    const key = (k: string, label: string): string => `${style.bold(style.cyan(`[${k}]`))} ${label}`;
    const choices: string[] = [];
    const allow = this.approvalOption("allow_once");
    const deny = this.approvalOption("reject_once");
    const allowRule = this.approvalOption("allow_always");
    const denyRule = this.approvalOption("reject_always");
    // Allow choices first, then deny choices.
    if (allow) {
      choices.push(key("y", sanitize(allow.name || "Allow")));
    }
    if (allowRule) {
      choices.push(key("t", sanitize(allowRule.name)));
    }
    if (deny) {
      choices.push(key("n", sanitize(deny.name || "Deny")), key("Tab", "Deny with reason"));
    }
    if (denyRule) {
      choices.push(key("d", sanitize(denyRule.name)));
    }
    const lines = [style.yellow("? ") + style.bold(sanitize(r.question))];
    // A compound shell line is approved one command at a time; say which.
    if (r.part) {
      lines.push("  " + style.gray(r.round ? `command ${r.round}: ` : "command: ") + style.bold(sanitize(r.part)));
    }
    if (r.flag) {
      lines.push("  " + style.yellow("! ") + style.gray(sanitize(r.flag)));
    }
    lines.push("  " + choices.join("  "));
    this.print(lines.join("\n"));
  }

  /** Rule screen: numbered rules, like the TUI's "Create allow rule". */
  private showRules(effect: "allow" | "deny"): void {
    const r = this.approval?.request;
    const rules = (effect === "allow" ? r?.allowRules : r?.denyRules) ?? [];
    const what = r?.resource ? `: "${shorten(r.resource)}"` : r?.tool ? `: ${r.tool}` : "";
    const width = Math.max(...rules.map((x) => x.label.length));
    const lines = [style.bold(`  Create ${effect} rule${sanitize(what)}`)];
    rules.forEach((rule, i) => {
      lines.push(
        `  ${style.bold(style.cyan(`[${i + 1}]`))} ${sanitize(rule.label.padEnd(width))}  ${style.gray(sanitize(rule.description))}`
      );
    });
    lines.push("  " + style.gray("Esc to go back"));
    this.print(lines.join("\n"));
  }

  private startInput(page: "folder" | "reason", initial: string): void {
    const a = this.approval;
    if (!a) {
      return;
    }
    a.page = page;
    a.input = initial;
    a.drawn = 0;
    this.drawInput();
  }

  private inputPrefix(): string {
    return this.approval?.page === "folder"
      ? "  " + style.gray("Folder to allow (Enter to allow, Esc to go back): ")
      : "  " + style.gray("Reason (Enter to deny, Esc to go back): ");
  }

  /** Redraw the input line(s) in place. */
  private drawInput(): void {
    const a = this.approval;
    if (!a) {
      return;
    }
    const prefix = this.inputPrefix();
    const text = prefix + sanitize(a.input);
    let out = "";
    if (a.drawn > 0) {
      const rows = Math.ceil(a.drawn / Math.max(1, this.cols));
      out += rows > 1 ? `\x1b[${rows - 1}A` : "";
      out += "\r\x1b[J";
    }
    a.drawn = visibleWidth(text) || 1;
    this.write(out + text);
  }

  private handleInputKey(data: string): void {
    const a = this.approval;
    if (!a) {
      return;
    }
    if (data === "\x1b" || data === "\x03") {
      // Back to the screen this input came from.
      this.write("\r\n");
      if (a.page === "folder") {
        a.page = "allow";
        this.showRules("allow");
      } else {
        a.page = "main";
        this.showApproval();
      }
      return;
    }
    if (data.startsWith("\x1b")) {
      return; // arrows etc.: not supported in this one-line input
    }
    for (const ch of data) {
      if (ch === "\r" && data.length === 1) {
        this.write("\r\n");
        this.submitInput();
        return;
      }
      if (ch === "\x7f" || ch === "\b") {
        a.input = Array.from(a.input).slice(0, -1).join("");
      } else if (ch === "\x15") {
        a.input = "";
      } else if (ch === "\r" || ch === "\n" || ch === "\t") {
        a.input += " ";
      } else if (ch >= " ") {
        a.input += ch;
      }
    }
    this.drawInput();
  }

  private submitInput(): void {
    const a = this.approval;
    if (!a) {
      return;
    }
    if (a.page === "reason") {
      const deny = this.approvalOption("reject_once");
      if (deny) {
        const reason = a.input.trim();
        this.answer({ optionId: deny.optionId, reason }, reason ? `Deny: ${reason}` : deny.name || "Deny", false);
      }
      return;
    }
    const rule = a.request.allowRules?.find((r) => r.kind === "folder");
    const opt = this.approvalOption("allow_always");
    if (!rule?.folder || !opt) {
      return;
    }
    const check = checkFolder(rule.folder, a.input);
    if (!check.ok) {
      this.print("  " + style.red(check.reason));
      this.drawInput();
      return;
    }
    this.answer({ optionId: opt.optionId, rule: "folder", folder: check.path }, `Trust folder ${check.path} and everything under it`, true);
  }

  private handleApprovalKey(data: string): void {
    const a = this.approval;
    if (!a) {
      return;
    }
    if (a.page === "folder" || a.page === "reason") {
      this.handleInputKey(data);
      return;
    }
    const k = data.length === 1 ? data.toLowerCase() : data;
    if (a.page === "allow" || a.page === "deny") {
      if (k === "\x1b" || k === "\x03") {
        a.page = "main";
        this.showApproval();
        return;
      }
      const effect = a.page;
      const rules = (effect === "allow" ? a.request.allowRules : a.request.denyRules) ?? [];
      const rule = /^[1-9]$/.test(k) ? rules[Number(k) - 1] : undefined;
      const opt = this.approvalOption(effect === "allow" ? "allow_always" : "reject_always");
      if (!rule || !opt) {
        this.write("\x07");
        return;
      }
      if (rule.kind === "folder" && rule.folder) {
        this.startInput("folder", rule.folder.prefill);
        return;
      }
      this.answer({ optionId: opt.optionId, rule: rule.kind }, rule.label, effect === "allow");
      return;
    }
    // First screen.
    if (k === "\x03" || k === "\x1b" || k === "n") {
      const deny = this.approvalOption("reject_once") ?? this.approvalOption("reject_always");
      if (deny) {
        this.answer({ optionId: deny.optionId }, deny.name || "Deny", false);
      }
      return;
    }
    if (k === "\t" && this.approvalOption("reject_once")) {
      this.startInput("reason", "");
      return;
    }
    if (k === "y" && this.approvalOption("allow_once")) {
      const o = this.approvalOption("allow_once") as ApprovalOption;
      this.answer({ optionId: o.optionId }, o.name || "Allow", true);
      return;
    }
    const effect = k === "t" ? "allow" : k === "d" ? "deny" : undefined;
    const opt = effect && this.approvalOption(effect === "allow" ? "allow_always" : "reject_always");
    if (effect && opt) {
      const rules = effect === "allow" ? a.request.allowRules : a.request.denyRules;
      if (rules?.length) {
        a.page = effect;
        this.showRules(effect);
      } else {
        this.answer({ optionId: opt.optionId }, opt.name, effect === "allow");
      }
      return;
    }
    this.write("\x07");
  }

  /** Send the answer, print it, and show the next waiting approval. */
  private answer(answer: ApprovalAnswer, label: string, allowed: boolean): void {
    const a = this.approval;
    if (!a) {
      return;
    }
    if (a.requestId === undefined || !this.client) {
      this.print(style.red("  Can't answer this request (the engine isn't waiting for it any more)."));
      this.nextApproval();
      return;
    }
    try {
      this.client.respondToApproval(a.requestId, answer);
    } catch (err) {
      this.print("  " + style.red(errorMessage(err)));
      return;
    }
    this.approval = undefined;
    const text = sanitize(label);
    this.print("  " + (allowed ? style.green(`→ ${text}`) : style.red(`→ ${text}`)));
    this.nextApproval();
  }

  // --- prompt submission ---

  private async submit(text: string): Promise<void> {
    this.write(this.editor.erase());
    this.editor.addHistory(text);
    this.editor.clear();
    const trimmed = text.trim();
    if (!trimmed) {
      this.showPrompt();
      return;
    }
    // A leading space sends "/..." to the agent as plain text.
    if (text.startsWith("/")) {
      const match = /^\/(\S+)\s*([\s\S]*)$/.exec(trimmed);
      const cmd = match?.[1].toLowerCase() ?? "";
      const arg = (match?.[2] ?? "").trim();
      const spec = findCommand(cmd);
      if (spec) {
        this.print(this.formatUser(trimmed));
        if (spec.unavailable) {
          this.print(style.yellow(spec.unavailable));
        } else {
          await this.runLocalCommand(spec.name, arg);
        }
        if (!this.isClosed()) {
          this.showPrompt();
        }
        return;
      }
      // Agent commands the engine advertises (e.g. /context-gatherer) go to it.
      const isEngineCmd = this.engineCommands.some((c) => c.name.toLowerCase() === cmd);
      // "/Users/me/pic.png what's this?" (a dropped path) is a normal message.
      const looksLikeCommand = /^[a-z][\w-]*$/i.test(match?.[1] ?? "");
      if (!isEngineCmd && looksLikeCommand) {
        this.print(this.formatUser(trimmed));
        this.print(
          style.yellow(`Unknown command /${sanitize(match?.[1] ?? "")}.`) +
            style.gray(" Type /help to see commands (start with a space to send it to the agent as text).")
        );
        this.showPrompt();
        return;
      }
    }
    await this.sendPrompt(text);
  }

  private async sendPrompt(text: string): Promise<void> {
    if (!this.client) {
      this.print(style.red("The engine isn't running.") + style.gray(" Type /restart."));
      this.showPrompt();
      return;
    }
    this.print(this.formatUser(text));
    const { images, notes } = this.loadImages(text);
    if (this.pendingImages.length > 0) {
      images.push(...this.pendingImages.splice(0));
      notes.push(style.gray("  📎 attached clipboard image"));
    }
    for (const n of notes) {
      this.print(n);
    }
    this.transcript.push({ role: "user", text });
    this.currentPrompt = text;
    this.lastTurn = undefined;
    this.write("\r\n");

    this.state = "busy";
    this.cancelled = false;
    this.busySince = Date.now();
    this.tools.clear();
    this.lastToolId = undefined;
    this.turnCredits = undefined;
    this.startSpinner("Thinking");
    try {
      await this.client.prompt(text, images);
    } catch (err) {
      if (!this.isClosed()) {
        this.endAssistant();
        this.print(style.red(errorMessage(err)));
      }
    }
    if (this.isClosed()) {
      return;
    }
    this.endAssistant();
    this.stopSpinner();
    this.clearApprovals();
    // "▸ Credits: 0.09 • Time: 2s" (like the Kiro CLI).
    const parts: string[] = [];
    // Set by "metering" events during the await above.
    const credits = this.turnCredits as number | undefined;
    if (credits !== undefined) {
      parts.push(`Credits: ${credits.toFixed(2)}`);
    }
    parts.push(`Time: ${formatDuration(Date.now() - this.busySince)}`);
    const footer =
      (this.cancelled ? style.yellow("■ Cancelled") + "  " : "") +
      style.magenta("▸ ") +
      style.gray(parts.join(" • "));
    const turn = this.lastTurn as { elapsedMs?: number; requestIds: string[]; status?: string } | undefined;
    this.turnStats.push({
      at: new Date(),
      prompt: text,
      elapsedMs: turn?.elapsedMs ?? Date.now() - this.busySince,
      credits,
      requestIds: turn?.requestIds ?? [],
      status: this.cancelled ? "cancelled" : turn?.status ?? "success",
    });
    if (this.turnStats.length > 50) {
      this.turnStats.shift();
    }
    this.currentPrompt = undefined;
    this.print("\n" + footer + "\n");
    this.state = "idle";
    this.showPrompt();
  }

  /** Attach image files whose paths appear in the prompt (e.g. dropped files). */
  private loadImages(text: string): { images: PromptImage[]; notes: string[] } {
    const images: PromptImage[] = [];
    const notes: string[] = [];
    for (const p of findImagePaths(text, this.cwd())) {
      if (images.length >= MAX_IMAGES) {
        notes.push(style.yellow(`  Only the first ${MAX_IMAGES} images were attached.`));
        break;
      }
      const name = path.basename(p);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) {
          continue;
        }
        if (st.size > MAX_IMAGE_BYTES) {
          notes.push(style.yellow(`  ${name} is larger than 10 MB and wasn't attached.`));
          continue;
        }
        const mimeType = imageMimeForPath(p);
        if (!mimeType) {
          continue;
        }
        images.push({ mimeType, data: fs.readFileSync(p).toString("base64"), name });
        notes.push(style.gray(`  📎 attached ${name}`));
      } catch {
        // Not an existing file: leave it as plain text.
      }
    }
    return { images, notes };
  }

  private onInterrupt(): void {
    if (this.state === "busy") {
      this.cancelTurn();
      return;
    }
    if (this.state !== "idle") {
      return;
    }
    if (!this.editor.isEmpty) {
      this.editor.clear();
      this.redrawPrompt();
      return;
    }
    const now = Date.now();
    if (now - this.lastInterrupt < 2000) {
      this.exit();
      return;
    }
    this.lastInterrupt = now;
    this.print(style.gray("Press Ctrl+C again to close this chat (or type /exit)."));
  }

  private cancelTurn(): void {
    if (!this.client || this.cancelled) {
      return;
    }
    this.cancelled = true;
    this.spinnerLabel = "Cancelling";
    this.client.cancel();
  }

  // --- local commands ---

  private async runLocalCommand(cmd: string, arg: string): Promise<void> {
    try {
      switch (cmd) {
        case "help":
          this.showHelp();
          break;
        case "clear":
        case "new":
          await this.newConversation(cmd === "clear");
          break;
        case "chat": {
          const [sub = "", ...rest] = arg.split(/\s+/);
          if (sub === "new") {
            await this.newConversation(false);
          } else if (sub === "save") {
            await this.commands.saveTranscript(rest.join(" "));
          } else if (sub === "load") {
            await this.resume(rest.join(" "));
          } else {
            this.print(style.gray("Usage: /chat new | save [file] | load"));
          }
          break;
        }
        case "context":
          await this.commands.context(arg);
          break;
        case "compact":
          await this.commands.compact();
          break;
        case "usage":
          await this.commands.usage();
          break;
        case "knowledge":
          await this.commands.knowledge(arg);
          break;
        case "mcp":
          this.commands.mcp();
          break;
        case "hooks":
          await this.commands.hooks();
          break;
        case "code":
          await this.commands.code(arg);
          break;
        case "agent":
          await this.commands.agent(arg);
          break;
        case "plan":
          await this.commands.plan();
          break;
        case "prompts":
          await this.commands.prompts(arg);
          break;
        case "copy":
          await this.commands.copy();
          break;
        case "editor":
        case "reply":
          // Don't block the prompt while the editor tab is open.
          void this.commands.editor(cmd === "reply").catch((e) => this.print(style.red(errorMessage(e))));
          break;
        case "paste":
          await this.commands.paste();
          break;
        case "transcript":
          await this.commands.transcript(arg);
          break;
        case "rewind":
          await this.commands.rewind(arg);
          break;
        case "title":
          await this.commands.title(arg);
          break;
        case "stats":
          this.commands.stats();
          break;
        case "changelog":
          await this.commands.changelog(arg);
          break;
        case "settings":
          await this.commands.settings();
          break;
        case "theme":
          await this.commands.theme();
          break;
        case "spawn":
          this.commands.spawn(arg);
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
            this.print(style.gray("Usage: /set <id> <value>   (see /config for ids)"));
            break;
          }
          await this.selectOption(m[1], m[2], m[1]);
          break;
        }
        case "restart":
          await this.restart();
          break;
        case "login":
          this.login();
          break;
        case "cls":
          this.clearScreen();
          break;
        case "quit":
          this.exit();
          break;
      }
    } catch (err) {
      this.print(style.red(errorMessage(err)));
    }
  }

  private requireClient(): AcpClient {
    if (!this.client) {
      throw new Error("The engine isn't running. Type /restart.");
    }
    return this.client;
  }

  private showHelp(): void {
    const usable = COMMANDS.filter((c) => !c.unavailable);
    const left = (c: (typeof COMMANDS)[number]) => "/" + c.name + (c.args ? " " + c.args : c.subs ? " …" : "");
    const width = Math.min(26, Math.max(...usable.map((c) => left(c).length)) + 2);
    const lines = [style.bold("Commands") + style.gray("  (type / for a menu; Tab or Enter picks)")];
    for (const c of usable) {
      lines.push("  " + style.cyan(left(c).padEnd(width)) + style.gray(c.desc));
    }
    if (this.engineCommands.length > 0) {
      lines.push("", style.bold("Agent commands") + style.gray(" (sent to the engine)"));
      for (const c of this.engineCommands) {
        const desc = sanitize(c.description ?? "").replace(/\s+/g, " ");
        lines.push(fitAnsi("  " + style.cyan(("/" + sanitize(c.name)).padEnd(width)) + style.gray(desc), this.cols - 1));
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
    this.print(lines.join("\n"));
  }

  private async resume(arg: string): Promise<void> {
    const client = this.requireClient();
    if (arg) {
      const n = Number.parseInt(arg, 10);
      const pick = this.lastSessions[n - 1];
      if (!pick) {
        this.print(style.yellow(`No session #${arg}. Type /resume to list sessions.`));
        return;
      }
      this.print(style.gray(`Resuming “${sanitize(pick.title || pick.sessionId)}”…`) + "\n");
      this.resetConversationState();
      await this.runBusy("Loading history", () => client.loadSession(pick.sessionId));
      this.print("\n" + style.gray("Resumed. Continue the conversation below."));
      return;
    }
    const prep = await prepareEngine(readConfig().cliPath, readConfig().engine);
    const sessions = await this.runBusy("Loading sessions", () =>
      listSessions(prep.cliPath, this.cwd(), (m) => this.log(m))
    );
    const cwd = normalizePath(this.cwd());
    const others = sessions.filter((s) => s.sessionId !== client.currentSessionId);
    const sameBoth = others.filter((s) => s.source === this.engine && normalizePath(s.cwd) === cwd);
    const sameEngine = others.filter((s) => s.source === this.engine);
    const list = (sameBoth.length ? sameBoth : sameEngine.length ? sameEngine : others)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, 15);
    this.lastSessions = list;
    if (list.length === 0) {
      this.print(style.gray("No previous sessions found."));
      return;
    }
    const lines = [style.bold("Recent sessions")];
    list.forEach((s, i) => {
      const meta = [relativeTime(s.updatedAt), s.messageCount ? `${s.messageCount} msgs` : ""]
        .filter(Boolean)
        .join(" · ");
      lines.push(
        `  ${style.cyan(String(i + 1).padStart(2))}  ${truncate(sanitize(s.title || "(untitled)"), Math.max(20, this.cols - 30))}  ${style.gray(meta)}`
      );
    });
    lines.push(style.gray("Type /resume <number> to continue one."));
    this.print(lines.join("\n"));
  }

  /** Run an operation with the spinner shown and input held. */
  private async runBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.state = "busy";
    this.busySince = Date.now();
    this.inAssistant = false;
    this.startSpinner(label);
    try {
      return await fn();
    } finally {
      if (!this.isClosed()) {
        this.endAssistant();
        this.stopSpinner();
        this.state = "idle";
      }
    }
  }

  private option(id: string): ConfigOption | undefined {
    return this.configOptions.find((o) => o.id === id);
  }

  private mergeConfig(opts: ConfigOption[]): void {
    const map = new Map(this.configOptions.map((o) => [o.id, o] as const));
    for (const o of opts) {
      map.set(o.id, o);
    }
    // The engine only offers effortLevel for effort-capable models.
    if (opts.some((o) => o.id === "model") && !opts.some((o) => o.id === "effortLevel")) {
      map.delete("effortLevel");
    }
    this.configOptions = [...map.values()];
  }

  private valueName(opt: ConfigOption): string {
    const v = String(opt.currentValue ?? "");
    return opt.options?.find((o) => o.value === v)?.name ?? v;
  }

  private async selectOption(id: string, arg: string, label: string): Promise<void> {
    const opt = this.option(id);
    if (!opt) {
      this.print(
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
      const lines = [style.bold(`${label}: `) + this.valueName(opt)];
      for (const c of choices) {
        const mark = c.value === current ? style.green("●") : style.gray("○");
        const desc = c.description ? style.gray(" – " + truncate(sanitize(c.description), 60)) : "";
        lines.push(`  ${mark} ${sanitize(c.name)}${c.name !== c.value ? style.gray(` (${c.value})`) : ""}${desc}`);
      }
      if (choices.length > 0) {
        lines.push(style.gray(`Type /${id === "model" ? "model" : id === "effortLevel" ? "effort" : `set ${id}`} <name> to change it.`));
      }
      this.print(lines.join("\n"));
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
        this.print(style.yellow(`No ${label.toLowerCase()} matches “${arg}”.`) + style.gray(` Type /${id === "model" ? "model" : id === "effortLevel" ? "effort" : `set ${id}`} to list them.`));
        return;
      }
      value = hit.value;
    }
    const client = this.requireClient();
    await client.setConfigOption(id, value);
    if (id === "autopilot") {
      client.setAutoApprove(value === "on");
    }
    const name = choices.find((c) => c.value === value)?.name ?? value;
    this.print(style.gray(`${label} set to `) + sanitize(name) + style.gray("."));
  }

  private async setAutopilot(arg: string): Promise<void> {
    const opt = this.option("autopilot");
    const current = String(opt?.currentValue ?? "off");
    const a = arg.toLowerCase();
    if (!a) {
      this.print(
        style.gray("Autopilot is ") +
          (current === "on" ? style.yellow("on") + style.gray(" (tools run without asking)") : "off" + style.gray(" (Supervised: you approve changes)")) +
          style.gray(". Type /autopilot on|off.")
      );
      return;
    }
    if (a !== "on" && a !== "off") {
      this.print(style.gray("Usage: /autopilot on|off"));
      return;
    }
    const client = this.requireClient();
    if (opt) {
      await client.setConfigOption("autopilot", a);
    }
    client.setAutoApprove(a === "on");
    this.updatePrompt();
    this.print(style.gray("Autopilot ") + (a === "on" ? style.yellow("on") : "off") + style.gray("."));
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
      this.print(
        style.yellow("Trusting individual tools isn't available in this engine.") +
          style.gray(" Use /tools trust-all (Autopilot) or /tools reset (Supervised).")
      );
      return;
    }
    if (a) {
      this.print(style.gray("Usage: /tools [trust-all|reset]"));
      return;
    }
    const auto = String(this.option("autopilot")?.currentValue ?? "off") === "on";
    const trust = auto ? style.yellow("trusted") : style.gray("ask first");
    const lines = [style.bold("Tools") + style.gray(auto ? "  (Autopilot: all trusted)" : "  (Supervised)")];
    const groups = this.toolGroups.length
      ? this.toolGroups
      : [{ tag: "read", description: "" }, { tag: "write", description: "" }, { tag: "shell", description: "" }, { tag: "web", description: "" }];
    const width = Math.max(...groups.map((g) => g.tag.length)) + 2;
    for (const g of groups) {
      // Reading files never asks for approval; other tools follow the mode.
      const state = g.tag === "read" ? style.gray("allowed") : trust;
      lines.push(`  ${style.cyan(g.tag.padEnd(width))}${state}${g.description ? style.gray("  " + sanitize(g.description)) : ""}`);
    }
    lines.push(style.gray(auto ? "Type /tools reset to ask before changes again." : "Type /tools trust-all to run tools without asking."));
    this.print(lines.join("\n"));
  }

  private showConfig(): void {
    if (this.configOptions.length === 0) {
      this.print(style.gray("No settings reported by the engine yet."));
      return;
    }
    const width = Math.max(...this.configOptions.map((o) => o.id.length)) + 2;
    const lines = [style.bold("Session settings")];
    for (const o of this.configOptions) {
      lines.push(`  ${style.cyan(o.id.padEnd(width))}${this.valueName(o)}${style.gray("  " + sanitize(o.name))}`);
    }
    lines.push(style.gray("Change one with /set <id> <value>  (e.g. /set memoryReflection off)."));
    this.print(lines.join("\n"));
  }

  private async restart(): Promise<void> {
    this.client?.dispose();
    this.client = undefined;
    this.clearApprovals();
    this.configOptions = [];
    this.usagePct = undefined;
    this.updatePrompt();
    resetPreparedEngine();
    await this.start();
  }

  private login(): void {
    const t = vscode.window.createTerminal("Kiro CLI Login");
    t.show();
    t.sendText("kiro-cli login");
    this.print(style.gray("Finish logging in in the “Kiro CLI Login” terminal, then come back and type /restart."));
  }

  private clearScreen(): void {
    const promptWasDrawn = this.editor.isDrawn;
    this.write(this.editor.erase() + term.clearScreen);
    if (promptWasDrawn || this.state === "idle") {
      this.renderPrompt();
    }
  }

  // --- slash menu ---

  /** Values for the menu (model names, agents, …) from the engine's settings. */
  private menuValues(source: ValueSource): MenuValue[] {
    const fromOption = (id: string): MenuValue[] =>
      (this.option(id)?.options ?? []).map((o) => ({ value: o.value, desc: o.name !== o.value ? o.name : o.description }));
    switch (source) {
      case "model":
        return fromOption("model");
      case "effort":
        return fromOption("effortLevel");
      case "agent":
        return fromOption("mode");
      case "configId":
        return this.configOptions.map((o) => ({ value: o.id, desc: `${o.name}: ${this.valueName(o)}` }));
      case "prompt":
        return this.engineCommands.map((c) => ({ value: c.name, desc: c.description }));
    }
  }

  /** Recompute the menu for the current input and hand it to the editor. */
  private updateMenu(): void {
    const text = this.editor.text;
    if (text !== this.menuText) {
      this.menuText = text;
      this.menuSel = 0;
      if (this.menuDismissedFor !== undefined && text !== this.menuDismissedFor) {
        this.menuDismissedFor = undefined;
      }
    }
    this.menu =
      this.state === "idle" && this.menuDismissedFor === undefined
        ? slashMenu(text, this.engineCommands, (s) => this.menuValues(s))
        : undefined;
    this.editor.setFooter(this.menu ? this.menuLines(this.menu) : []);
  }

  private menuLines(menu: Menu): string[] {
    const width = Math.max(10, this.cols - 1);
    if (menu.items.length === 0) {
      return menu.hint ? [fitAnsi(style.gray("  " + sanitize(menu.hint)), width)] : [];
    }
    const n = menu.items.length;
    this.menuSel = Math.min(this.menuSel, n - 1);
    const start = Math.max(0, Math.min(this.menuSel - Math.floor(MENU_ROWS / 2), n - MENU_ROWS));
    const shown = menu.items.slice(start, start + MENU_ROWS);
    const labelW = Math.min(24, Math.max(...shown.map((i) => i.label.length)) + 2);
    const lines = shown.map((item, i) => {
      const selected = start + i === this.menuSel;
      const label = sanitize(item.label).padEnd(labelW);
      const desc = item.desc ? sanitize(item.desc) : "";
      const line = selected
        ? style.magenta("› ") + style.bold(style.cyan(label)) + desc
        : "  " + style.cyan(label) + style.gray(desc);
      return fitAnsi(line, width);
    });
    if (n > MENU_ROWS) {
      lines.push(style.gray(fitAnsi(`  ${this.menuSel + 1}/${n} · ↑↓ select · Tab complete · Enter run · Esc hide`, width)));
    } else {
      lines.push(style.gray(fitAnsi("  ↑↓ select · Tab complete · Enter run · Esc hide", width)));
    }
    return lines;
  }

  /** Keys the menu handles (↑ ↓ Tab Enter Esc). Returns true if consumed. */
  private handleMenuKey(data: string): boolean {
    const items = this.menu?.items ?? [];
    if (items.length === 0) {
      return false;
    }
    switch (data) {
      case "\x1b[A":
      case "\x1bOA":
        this.menuSel = (this.menuSel - 1 + items.length) % items.length;
        this.redrawPrompt();
        return true;
      case "\x1b[B":
      case "\x1bOB":
        this.menuSel = (this.menuSel + 1) % items.length;
        this.redrawPrompt();
        return true;
      case "\t":
        this.editor.setText(items[this.menuSel].insert);
        this.redrawPrompt();
        return true;
      case "\x1b":
        this.menuDismissedFor = this.editor.text;
        this.redrawPrompt();
        return true;
      case "\r": {
        const item = items[this.menuSel];
        if (item.submit) {
          const text = item.insert.trimEnd();
          this.editor.setText(text);
          void this.submit(text);
        } else {
          this.editor.setText(item.insert);
          this.redrawPrompt();
        }
        return true;
      }
      default:
        return false;
    }
  }

  private renderPrompt(): void {
    this.updateMenu();
    this.write(this.editor.render(this.cols));
  }

  private redrawPrompt(): void {
    this.updateMenu();
    this.write(this.editor.redraw(this.cols));
  }

  // --- y/n questions ---

  private confirm(question: string): Promise<boolean> {
    this.print(style.yellow("? ") + style.bold(question) + "  " + style.cyan("[y]") + " Yes  " + style.cyan("[n]") + " No");
    return new Promise((resolve) => {
      this.confirmState = resolve;
    });
  }

  private handleConfirmKey(data: string): void {
    const resolve = this.confirmState;
    const k = data.toLowerCase();
    let yes: boolean;
    if (k === "y") {
      yes = true;
    } else if (k === "n" || data === "\x1b" || data === "\x03" || data === "\r") {
      yes = false;
    } else {
      this.write("\x07");
      return;
    }
    this.confirmState = undefined;
    this.print("  " + (yes ? style.green("→ Yes") : style.red("→ No")));
    resolve?.(yes);
  }

  // --- conversation state ---

  private resetConversationState(): void {
    this.transcript = [];
    this.userTurns = [];
    this.usagePct = undefined;
    this.updatePrompt();
  }

  private async newConversation(clearScreen: boolean): Promise<void> {
    await this.requireClient().newSession();
    this.resetConversationState();
    if (clearScreen) {
      this.write(term.clearScreen);
    }
    this.print(style.gray("Started a new conversation."));
  }

  /** After /rewind: drop user turn `index` (sent in this terminal) and everything after it. */
  private truncateConversation(index: number): void {
    // Transcript user entries = replayed history (from /resume) + turns sent here.
    const userIdx = this.transcript.flatMap((e, i) => (e.role === "user" ? [i] : []));
    const replayed = Math.max(0, userIdx.length - this.userTurns.length);
    const cut = userIdx[replayed + index];
    if (cut !== undefined) {
      this.transcript = this.transcript.slice(0, cut);
    }
    this.userTurns = this.userTurns.slice(0, index);
  }

  private setTitle(title: string | undefined): void {
    this.customTitle = title;
    this.nameEmitter.fire(title ? `Kiro: ${title}` : this.name);
  }

  private makeHost(): ChatHost {
    return {
      print: (t) => this.print(t),
      client: () => this.requireClient(),
      runBusy: (label, fn) => this.runBusy(label, fn),
      confirm: (q) => this.confirm(q),
      cwd: () => this.cwd(),
      cols: () => this.cols,
      cliPath: () => this.cliPath,
      option: (id) => this.option(id),
      engineCommands: () => this.engineCommands,
      contextPercent: () => this.usagePct,
      transcript: () => this.transcript,
      truncateConversation: (i) => this.truncateConversation(i),
      userTurns: () => this.userTurns,
      turnStats: () => this.turnStats,
      mcpServers: () => this.mcpServers,
      setInput: (text) => {
        this.editor.setText(text);
        if (this.state === "idle" && this.editor.isDrawn) {
          this.redrawPrompt();
        }
      },
      addPendingImage: (img) => this.pendingImages.push(img),
      setTitle: (t) => this.setTitle(t),
      title: () => this.customTitle ?? this.name,
      spawn: (task) => this.options.spawn?.(task),
      sendPrompt: (text) => this.sendPrompt(text),
      log: (line) => this.log(line),
    };
  }

  // --- output helpers ---

  private write(s: string): void {
    if (this.state !== "closed") {
      this.writeEmitter.fire(s);
    }
  }

  /** Print whole lines above the prompt/spinner (which are redrawn after). */
  private print(text: string): void {
    let out = this.hideSpinner();
    const promptWasDrawn = this.editor.isDrawn;
    if (promptWasDrawn) {
      out += this.editor.erase();
    }
    if (this.inAssistant && !this.md.atLineStart) {
      out += this.md.flush();
    }
    out += crlf(text) + "\r\n";
    if (promptWasDrawn) {
      this.updateMenu();
      out += this.editor.render(this.cols);
    }
    this.write(out);
  }

  /**
   * Prompt like kiro-cli: "17% > " in Supervised mode, "17% !> " when
   * Autopilot runs tools without asking. The % (context used) is green.
   */
  private promptText(): { plain: string; styled: string } {
    const autopilot = String(this.option("autopilot")?.currentValue ?? "off") === "on";
    const arrow = autopilot ? "!> " : "> ";
    if (this.usagePct === undefined) {
      return { plain: arrow, styled: style.bold(style.magenta(arrow)) };
    }
    const pct = `${Math.round(this.usagePct)}%`;
    return { plain: `${pct} ${arrow}`, styled: style.green(pct) + " " + style.bold(style.magenta(arrow)) };
  }

  /** Apply a changed context % to the prompt (redrawing it if it's showing). */
  private updatePrompt(): void {
    const p = this.promptText();
    this.editor.setPrompt(p.plain, p.styled);
    if (this.state === "idle" && this.editor.isDrawn) {
      this.redrawPrompt();
    }
  }

  /** Echo a sent message the way it looked in the prompt. */
  private formatUser(text: string): string {
    const p = this.promptText();
    const pad = " ".repeat(Array.from(p.plain).length);
    return sanitize(text)
      .split("\n")
      .map((l, i) => (i === 0 ? p.styled : pad) + l)
      .join("\n");
  }

  private showPrompt(): void {
    if (this.state === "idle" && !this.editor.isDrawn) {
      this.renderPrompt();
    }
  }

  private printBanner(): void {
    const model = this.option("model");
    const auto = String(this.option("autopilot")?.currentValue ?? "off") === "on";
    const bits = [
      `engine ${this.engine ?? "?"}`,
      model ? `model ${this.valueName(model)}` : "",
      auto ? style.yellow("Autopilot") : "Supervised",
    ].filter(Boolean);
    this.print(
      style.gray("Ready · ") +
        bits.join(style.gray(" · ")) +
        "\n" +
        style.gray("Enter send · Shift+Enter new line · Esc cancel · /help commands · drop images to attach") +
        "\n"
    );
  }

  // --- spinner ---

  private startSpinner(label: string): void {
    this.spinnerLabel = label;
    if (!this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => this.tickSpinner(), 100);
    }
    this.tickSpinner();
  }

  private tickSpinner(): void {
    // Only on an empty line, never over the prompt or a pending approval.
    if (!this.md.atLineStart || this.editor.isDrawn || this.approval || this.isClosed()) {
      return;
    }
    const frame = SPINNER[this.spinnerFrame++ % SPINNER.length];
    const secs = Math.floor((Date.now() - this.busySince) / 1000);
    const hint = this.state === "busy" && !this.cancelled ? " · Esc to cancel" : "";
    const text = truncate(`${this.spinnerLabel}… ${secs}s${hint}`, Math.max(10, this.cols - 4));
    this.write(term.clearLine + style.magenta(frame) + " " + style.gray(text));
    this.spinnerVisible = true;
  }

  private hideSpinner(): string {
    if (!this.spinnerVisible) {
      return "";
    }
    this.spinnerVisible = false;
    return term.clearLine;
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
    this.write(this.hideSpinner());
  }

  // --- misc ---

  private cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? process.cwd();
  }

  private log(line: string): void {
    this.output.appendLine(`[${this.name}] ${line}`);
  }
}

// --- formatting helpers ---

function highlightPaths(title: string, paths: string[]): string {
  const sorted = [...paths].filter(Boolean).sort((a, b) => b.length - a.length);
  let out = "";
  let rest = title;
  while (rest.length > 0) {
    let idx = -1;
    let hit = "";
    for (const p of sorted) {
      const i = rest.indexOf(p);
      if (i >= 0 && (idx < 0 || i < idx)) {
        idx = i;
        hit = p;
      }
    }
    if (idx < 0) {
      out += rest;
      break;
    }
    out += rest.slice(0, idx) + style.magenta(hit);
    rest = rest.slice(idx + hit.length);
  }
  return out;
}

/** "2s", "15m 30s", "1h 5m" — for the per-reply footer. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function formatElapsed(ms: number): string {
  return ms < 60_000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function truncate(s: string, max: number): string {
  const plain = stripAnsi(s);
  return plain.length > max ? plain.slice(0, Math.max(1, max - 1)) + "…" : s;
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

function normalizePath(p: string): string {
  return path.resolve(p).replace(/\/+$/, "");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
