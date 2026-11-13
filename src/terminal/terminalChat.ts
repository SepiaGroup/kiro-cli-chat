// Text-only chat that runs inside a VS Code terminal (a Pseudoterminal).
//
// Each terminal owns its own engine process and conversation, so several can
// run side by side in the Terminal panel. The webview chat is unaffected.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AcpClient } from "../acpClient";
import { editorContextFor, readConfig } from "../config";
import { NotLoggedInError, prepareEngine, resetPreparedEngine } from "../enginePrep";
import { errorMessage, formatDuration } from "../format";
import { AvailableCommand, ChatEvent, PromptImage } from "../types";
import { crlf, sanitize, style, term, truncate } from "./ansi";
import { MarkdownStream } from "./ansiMarkdown";
import { ApprovalPrompt } from "./approvalPrompt";
import { findImagePaths, imageMimeForPath } from "./imagePaths";
import { LineEditor } from "./lineEditor";
import { LocalCommands } from "./localCommands";
import { MenuState } from "./menuState";
import { QuestionPrompt } from "./questionPrompt";
import { SessionConfig } from "./sessionConfig";
import { findCommand, MenuValue, ValueSource } from "./slashCommands";
import { ChatHost, TerminalCommands, TranscriptEntry, TurnStat, UserTurn } from "./terminalCommands";
import { ToolLog } from "./toolLog";

type State = "starting" | "idle" | "busy" | "closed";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 10;

export interface TerminalChatOptions {
  /** Sent as soon as the engine is ready (used by /spawn). */
  initialPrompt?: string;
  /** Open another chat terminal running `task`. */
  spawn?: (task: string) => void;
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

  private readonly config = new SessionConfig();
  private engineCommands: AvailableCommand[] = [];
  private usagePct?: number;
  /** Credits reported for the current turn (engine sends one per reply). */
  private turnCredits?: number;
  private readonly toolLog = new ToolLog();
  private readonly approvals: ApprovalPrompt;
  private readonly questions: QuestionPrompt;
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
  private readonly menu = new MenuState();

  private readonly commands: TerminalCommands;
  private readonly local: LocalCommands;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly name: string,
    private readonly options: TerminalChatOptions = {}
  ) {
    const host = this.makeHost();
    this.commands = new TerminalCommands(host);
    this.local = new LocalCommands({
      ...host,
      commands: () => this.commands,
      config: () => this.config,
      engine: () => this.engine,
      toolGroups: () => this.toolGroups,
      updatePrompt: () => this.updatePrompt(),
      resetConversationState: () => this.resetConversationState(),
      newConversation: (clear) => this.newConversation(clear),
      restart: () => this.restart(),
      login: () => this.login(),
      clearScreen: () => this.clearScreen(),
      exit: () => this.exit(),
    });
    this.questions = new QuestionPrompt({
      print: (t) => this.print(t),
      write: (t) => this.write(t),
      cols: () => this.cols,
      canRespond: () => this.client !== undefined,
      respond: (id, answer) => this.requireClient().answerQuestion(id, answer),
    });
    this.approvals = new ApprovalPrompt({
      print: (t) => this.print(t),
      write: (t) => this.write(t),
      cols: () => this.cols,
      canRespond: () => this.client !== undefined,
      respond: (id, answer) => this.requireClient().respondToApproval(id, answer),
    });
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
    if (this.approvals.active) {
      this.approvals.handleKey(data);
      return;
    }
    if (this.questions.active) {
      this.questions.handleKey(data);
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
        editorContext: editorContextFor(this.cwd()),
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
      this.approvals.clear();
      this.questions.clear();
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
      case "toolCall": {
        this.endAssistant();
        this.spinnerLabel = "Working";
        const { title, text } = this.toolLog.start(ev);
        this.transcript.push({ role: "tool", text: title });
        this.print(text);
        break;
      }
      case "toolUpdate": {
        const { diff, status } = this.toolLog.update(ev);
        if (diff) {
          this.print(diff);
        }
        if (status) {
          this.endAssistant();
          this.print(status);
        }
        break;
      }
      case "approvalRequest":
        if (!this.approvals.active) {
          this.endAssistant();
        }
        this.approvals.enqueue(ev.request, ev.requestId);
        break;
      case "approvalResolved":
        this.approvals.resolved(ev);
        break;
      case "question":
        if (!this.questions.active && !this.approvals.active) {
          this.endAssistant();
        }
        this.questions.enqueue(ev.question, ev.requestId);
        break;
      case "questionResolved":
        this.questions.dropped(ev.requestId);
        break;
      case "contextUsage":
        this.usagePct = ev.usagePercentage;
        this.updatePrompt();
        break;
      case "metering":
        this.turnCredits = (this.turnCredits ?? 0) + ev.credits;
        break;
      case "configOptions":
        this.config.merge(ev.options);
        // Autopilot on/off changes the prompt ("!>" vs ">").
        this.updatePrompt();
        break;
      case "availableCommands":
        this.engineCommands = ev.commands;
        break;
      case "notice":
        this.endAssistant();
        this.print(style.gray(sanitize(ev.text)));
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
          await this.local.run(spec.name, arg);
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
    this.toolLog.reset();
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
    this.approvals.clear();
    this.questions.clear();
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

  private requireClient(): AcpClient {
    if (!this.client) {
      throw new Error("The engine isn't running. Type /restart.");
    }
    return this.client;
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

  private async restart(): Promise<void> {
    this.client?.dispose();
    this.client = undefined;
    this.approvals.clear();
    this.questions.clear();
    this.config.clear();
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

  /** Recompute the "/" menu for the current input and hand it to the editor. */
  private updateMenu(): void {
    const lines = this.menu.update(this.editor.text, this.state === "idle", this.engineCommands, (src) => this.menuValues(src), this.cols);
    this.editor.setFooter(lines);
  }

  /** Values for the menu (model names, agents, …) from the engine's settings. */
  private menuValues(source: ValueSource): MenuValue[] {
    const fromOption = (id: string): MenuValue[] =>
      (this.config.option(id)?.options ?? []).map((o) => ({ value: o.value, desc: o.name !== o.value ? o.name : o.description }));
    switch (source) {
      case "model":
        return fromOption("model");
      case "effort":
        return fromOption("effortLevel");
      case "agent":
        return fromOption("mode");
      case "configId":
        return this.config.all.map((o) => ({ value: o.id, desc: `${o.name}: ${this.config.valueName(o)}` }));
      case "prompt":
        return this.engineCommands.map((c) => ({ value: c.name, desc: c.description }));
    }
  }

  /** Keys the menu handles (↑ ↓ Tab Enter Esc). Returns true if consumed. */
  private handleMenuKey(data: string): boolean {
    const r = this.menu.handleKey(data);
    if (!r) {
      return false;
    }
    if (r.type === "submit") {
      this.editor.setText(r.text);
      void this.submit(r.text);
    } else {
      if (r.type === "setText") {
        this.editor.setText(r.text);
      }
      this.redrawPrompt();
    }
    return true;
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
      option: (id) => this.config.option(id),
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
    const autopilot = this.config.autopilot;
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
    const model = this.config.option("model");
    const auto = this.config.autopilot;
    const bits = [
      `engine ${this.engine ?? "?"}`,
      model ? `model ${this.config.valueName(model)}` : "",
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
    if (!this.md.atLineStart || this.editor.isDrawn || this.approvals.active || this.questions.active || this.isClosed()) {
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
