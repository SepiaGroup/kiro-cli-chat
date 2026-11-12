// One chat conversation: its own engine process, transcript and state, shown
// in one webview at a time (an editor tab or the bottom-panel view).

import * as vscode from "vscode";
import { AcpClient } from "./acpClient";
import { OneShotRunner } from "./oneShotRunner";
import { readConfig } from "./config";
import {
  checkAuth,
  listModels,
  listSessions,
  resolveEngine,
} from "./detect";
import { resolveCliPath } from "./cli";
import { isRuleKind } from "./approvalRules";
import { ApprovalAnswer, ChatEvent, EngineVersion, PromptImage } from "./types";

type Transport =
  | { mode: "persistent"; client: AcpClient }
  | { mode: "one-shot"; runner: OneShotRunner };

/** What a chat needs from the manager that owns it. */
export interface ChatSessionHooks {
  /** The user interacted with this chat (it becomes the target of commands). */
  onActive(chat: ChatSession): void;
  /** The ＋ button: open another chat tab. */
  newTab(): void;
}

export class ChatSession {
  private host?: vscode.Webview;
  private hostSub?: vscode.Disposable;
  private transport?: Transport;
  private resolvedEngine?: EngineVersion;
  private cliPath?: string;
  private startPromise?: Promise<void>;
  // Session to reopen on first start (a tab restored after a window reload).
  private resumeSessionId?: string;
  // Map ACP server-request id -> approval toolCallId, for persistent mode.
  private pendingApprovals = new Map<string, number>();
  // Transcript + latest state snapshots, replayed into a re-created webview.
  private transcript: unknown[] = [];
  private lastReady?: unknown;
  private lastConfig?: unknown;
  private lastCommands?: unknown;
  private lastContext?: unknown;
  private disposed = false;
  // Whether the current webview's script has loaded (sent "ready").
  private webviewReady = false;
  // A request (from a command) to deliver once the webview is ready.
  private pendingUiMessage?: unknown;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly label: string,
    private readonly hooks: ChatSessionHooks,
    resumeSessionId?: string
  ) {
    this.resumeSessionId = resumeSessionId;
  }

  private log(line: string): void {
    this.output.appendLine(`[${this.label}] ${line}`);
  }

  /** Show this chat in a webview (replaces any previous one). */
  attach(webview: vscode.Webview): void {
    this.hostSub?.dispose();
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webview.html = getHtml(this.context, webview);
    this.host = webview;
    this.webviewReady = false;
    this.hostSub = webview.onDidReceiveMessage((msg) => {
      this.hooks.onActive(this);
      void this.onMessage(msg, webview);
    });
  }

  /** The webview went away (e.g. the panel view is being rebuilt); keep the engine. */
  detach(webview: vscode.Webview): void {
    if (this.host === webview) {
      this.hostSub?.dispose();
      this.hostSub = undefined;
      this.host = undefined;
    }
  }

  // --- UI message handling ---

  private async onMessage(
    msg: { type: string; [k: string]: unknown },
    source: vscode.Webview
  ): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.webviewReady = true;
        if (this.pendingUiMessage) {
          void source.postMessage(this.pendingUiMessage);
          this.pendingUiMessage = undefined;
        }
        // A (re)loaded webview. If the engine is already running (the view was
        // moved and VS Code rebuilt it, or a second chat UI was opened),
        // restore state instead of waiting for a start that already happened.
        if (this.transport) {
          this.resyncWebview(source);
        } else {
          void this.ensureStarted();
        }
        break;
      case "sendPrompt":
        await this.handlePrompt(String(msg.text ?? ""), sanitizeImages(msg.images));
        break;
      case "approve":
        this.handleApproval(String(msg.toolCallId ?? ""), {
          optionId: String(msg.optionId ?? ""),
          ...(isRuleKind(msg.rule) ? { rule: msg.rule } : {}),
          ...(typeof msg.folder === "string" ? { folder: msg.folder } : {}),
          ...(typeof msg.reason === "string" ? { reason: msg.reason } : {}),
        });
        break;
      case "newSession":
        await this.newSession();
        break;
      case "resumeSession":
        await this.sendSessionList();
        break;
      case "loadSession":
        await this.loadSessionById(String(msg.sessionId ?? ""));
        break;
      case "restart":
        await this.confirmRestart();
        break;
      case "newTab":
        this.hooks.newTab();
        break;
      case "setMode":
        await this.handleSetMode(String(msg.modeId ?? ""));
        break;
      case "setConfig":
        await this.handleSetConfig(String(msg.id ?? ""), String(msg.value ?? ""));
        break;
      case "setAutoApprove":
        this.handleSetAutoApprove(Boolean(msg.enabled));
        break;
      case "login":
        await this.runLogin();
        break;
      case "debugLog":
        this.log("[webview] " + String(msg.text ?? "").slice(0, 2000));
        break;
      case "pickAttachment":
        await this.pickAttachment();
        break;
      case "getContextBreakdown":
        await this.sendContextBreakdown();
        break;
      case "compact":
        await this.compactContext();
        break;
      case "attachPaths":
        await this.attachImagePaths(
          Array.isArray(msg.paths) ? (msg.paths as unknown[]).map((p) => String(p)) : []
        );
        break;
      default:
        break;
    }
  }

  private async handlePrompt(text: string, images: PromptImage[] = []): Promise<void> {
    if (!text.trim() && images.length === 0) {
      return;
    }
    await this.ensureStarted();
    if (!this.transport) {
      this.post({ type: "error", message: "Engine not started." });
      return;
    }
    // Echo the prompt (with thumbnails) into the chat.
    this.post({ type: "userMessage", text, images });
    try {
      if (this.transport.mode === "persistent") {
        await this.transport.client.prompt(text, images);
      } else {
        if (images.length > 0) {
          this.post({
            type: "error",
            message: "Images need the persistent (ACP) mode; sending the text only.",
          });
        }
        await this.transport.runner.prompt(text);
      }
    } catch (err) {
      this.post({ type: "error", message: errorMessage(err) });
    }
  }

  /** Context usage by category (for the meter's hover card). */
  private async sendContextBreakdown(): Promise<void> {
    if (this.transport?.mode !== "persistent") {
      this.post({ type: "contextBreakdown", error: "Not available in one-shot mode." });
      return;
    }
    try {
      const res = await this.transport.client.extMethod<{ breakdown?: unknown }>("_kiro/session/context", {
        subcommand: "show",
      });
      this.post({ type: "contextBreakdown", breakdown: res.breakdown ?? {} });
    } catch (err) {
      this.post({ type: "contextBreakdown", error: errorMessage(err) });
    }
  }

  /** Summarize the conversation to free context space. */
  private async compactContext(): Promise<void> {
    if (this.transport?.mode !== "persistent") {
      this.post({ type: "compactDone", ok: false, message: "Compaction needs the persistent (ACP) mode." });
      return;
    }
    try {
      const res = await this.transport.client.extMethod<{ success?: boolean; message?: string }>("_kiro/session/compact");
      const ok = res.success !== false;
      this.post({
        type: "compactDone",
        ok,
        message: ok
          ? "Conversation compacted."
          : res.message ?? "Couldn't compact right now (a reply may be running, or there's nothing to compact).",
      });
    } catch (err) {
      this.post({ type: "compactDone", ok: false, message: errorMessage(err) });
    }
  }

  /** Once answered, don't resurrect an approval card when restoring a webview. */
  private dropApprovalCard(toolCallId: string): void {
    this.transcript = this.transcript.filter((msg) => {
      const m = msg as { type?: string; event?: { kind?: string; request?: { toolCallId?: string } } };
      return !(
        m.type === "event" &&
        m.event?.kind === "approvalRequest" &&
        (m.event.request?.toolCallId ?? "") === toolCallId
      );
    });
  }

  private handleApproval(toolCallId: string, answer: ApprovalAnswer): void {
    if (this.transport?.mode !== "persistent") {
      return;
    }
    this.dropApprovalCard(toolCallId);
    // Answer the specific pending request for this tool call. Fall back to the
    // only pending request if the UI didn't supply a toolCallId.
    let requestId = this.pendingApprovals.get(toolCallId);
    if (requestId === undefined && this.pendingApprovals.size === 1) {
      requestId = [...this.pendingApprovals.values()][0];
    }
    if (requestId === undefined) {
      return;
    }
    try {
      this.transport.client.respondToApproval(requestId, answer);
    } catch (err) {
      // A folder rule with an invalid folder (the webview checks it first).
      this.post({ type: "error", message: errorMessage(err) });
      return;
    }
    this.pendingApprovals.delete(toolCallId);
  }

  /** Live mode switch (vibe/plan/spec/…) via ACP session/set_mode. */
  private async handleSetMode(modeId: string): Promise<void> {
    if (!modeId || this.transport?.mode !== "persistent") {
      return;
    }
    try {
      await this.transport.client.setMode(modeId);
      this.log(`[config] mode -> ${modeId}`);
    } catch (err) {
      this.post({ type: "error", message: `Could not set mode: ${errorMessage(err)}` });
    }
  }

  /**
   * Generic live config change (model, autopilot, memoryReflection, …) via the
   * engine's session/set_config_option. The engine echoes a config_option_update
   * which refreshes the UI dropdowns.
   */
  private async handleSetConfig(id: string, value: string): Promise<void> {
    if (!id || this.transport?.mode !== "persistent") {
      return;
    }
    try {
      await this.transport.client.setConfigOption(id, value);
      this.log(`[config] ${id} -> ${value}`);
      // Keep the client-side auto-approve shadow consistent with the engine's
      // autopilot setting so approval cards behave as expected.
      if (id === "autopilot") {
        this.transport.client.setAutoApprove(value === "on");
      }
    } catch (err) {
      this.post({ type: "error", message: `Could not set ${id}: ${errorMessage(err)}` });
    }
  }

  /** Client-side autopilot toggle (auto-approve permission requests). */
  private handleSetAutoApprove(enabled: boolean): void {
    if (this.transport?.mode === "persistent") {
      this.transport.client.setAutoApprove(enabled);
      this.log(`[config] autopilot -> ${enabled ? "on" : "off"}`);
    }
  }

  // --- engine lifecycle ---

  private async ensureStarted(): Promise<void> {
    if (this.transport) {
      return;
    }
    // Coalesce concurrent callers onto one in-flight start, and make them all
    // await its completion (so e.g. a quick first prompt waits for the engine).
    if (!this.startPromise) {
      this.startPromise = this.doStart().finally(() => {
        this.startPromise = undefined;
      });
    }
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    try {
      const cfg = readConfig();
      const cliPath = resolveCliPath(cfg.cliPath);
      if (!cliPath) {
        this.post({
          type: "fatal",
          message:
            "Could not find the kiro-cli binary. Set kiroCliChat.kiroCliPath in settings.",
        });
        return;
      }
      this.cliPath = cliPath;

      // Auth check (once at startup).
      this.post({ type: "status", text: "Checking login..." });
      const auth = await checkAuth(cliPath);
      if (!auth.loggedIn) {
        this.post({ type: "needLogin" });
        return;
      }
      this.post({ type: "status", text: `Logged in${auth.identity ? " as " + auth.identity : ""}.` });

      // Resolve engine (auto-detect newest working).
      this.post({ type: "status", text: "Detecting engine..." });
      const engine = await resolveEngine(cliPath, cfg.engine, (m) =>
        this.log("[detect] " + m)
      );
      this.resolvedEngine = engine;

      // Load models in the background for the settings UI.
      void listModels(cliPath).then((models) =>
        this.post({ type: "models", models })
      );

      const cwd = this.workspaceCwd();

      this.log(
        `[start] engine=${engine} mode=${cfg.interactionMode} cwd=${cwd} cli=${cliPath}`
      );

      if (cfg.interactionMode === "persistent") {
        const client = new AcpClient({
          cliPath,
          engine,
          model: cfg.model,
          cwd,
          trustAllTools: cfg.autopilot,
        });
        this.wireClient(client);
        try {
          const resumeId = this.resumeSessionId;
          this.resumeSessionId = undefined;
          if (resumeId) {
            this.post({ type: "status", text: "Reopening previous session…" });
          }
          const resumed = await client.start(resumeId);
          this.log(resumeId ? `[start] resume ${resumeId}: ${resumed ? "ok" : "failed, new session"}` : "[start] new session");
          if (this.disposed) {
            client.dispose();
            return;
          }
          this.transport = { mode: "persistent", client };
          // The engine reports autopilot "on" by default, but approvals are
          // decided by kiroCliChat.autopilot; align the engine option (and so
          // the Settings checkbox) with it.
          await client
            .setConfigOption("autopilot", cfg.autopilot ? "on" : "off")
            .catch((e) => this.log(`[start] autopilot sync failed: ${errorMessage(e)}`));
          // v3 rejects --model, so apply kiroCliChat.defaultModel as a session
          // option. A reopened session keeps the model it had.
          if (engine === "v3" && !resumed && cfg.model && cfg.model !== "auto") {
            await client
              .setConfigOption("model", cfg.model)
              .catch((e) => this.post({ type: "notice", text: `Couldn't use default model "${cfg.model}": ${errorMessage(e)}`, isError: true }));
          }
        } catch (startErr) {
          client.dispose();
          this.log(
            `[start] persistent ACP failed: ${errorMessage(startErr)} — falling back to one-shot`
          );
          this.post({
            type: "status",
            text: "ACP mode failed; using one-shot mode.",
          });
          const runner = this.makeOneShot(cliPath, engine, cfg.model, cwd, cfg.autopilot);
          this.transport = { mode: "one-shot", runner };
        }
      } else {
        const runner = this.makeOneShot(cliPath, engine, cfg.model, cwd, cfg.autopilot);
        if (this.resumeSessionId) {
          runner.setSessionId(this.resumeSessionId);
          this.resumeSessionId = undefined;
        }
        this.transport = { mode: "one-shot", runner };
      }

      this.post({
        type: "ready",
        engine,
        mode: cfg.interactionMode,
        autopilot: cfg.autopilot,
        enterToSend: cfg.enterToSend,
      });
    } catch (err) {
      this.post({ type: "fatal", message: errorMessage(err) });
    }
  }

  private makeOneShot(
    cliPath: string,
    engine: EngineVersion,
    model: string,
    cwd: string,
    autopilot: boolean
  ): OneShotRunner {
    const runner = new OneShotRunner({
      cliPath,
      engine,
      model,
      cwd,
      trustAllTools: autopilot,
    });
    runner.on("event", (ev: ChatEvent) => this.post({ type: "event", event: ev }));
    runner.on("log", (line: string) => this.log("[cli] " + line));
    return runner;
  }

  private wireClient(client: AcpClient): void {
    client.on("event", (ev: ChatEvent) => this.post({ type: "event", event: ev }));
    client.on("log", (line: string) => this.log("[acp] " + line));
    client.on("permissionRequest", (requestId: number, params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const toolCall = (p.toolCall ?? {}) as Record<string, unknown>;
      const toolCallId = String(toolCall.toolCallId ?? p.toolCallId ?? "");
      this.pendingApprovals.set(toolCallId, requestId);
    });
    client.on("exit", (code: number | null) => {
      // Ignore an old engine exiting after Restart replaced it.
      if (this.transport?.mode !== "persistent" || this.transport.client !== client) {
        return;
      }
      this.post({ type: "status", text: `Engine exited (code=${code}).` });
      this.transport = undefined;
    });
  }

  /** Send a UI-only request to the webview, waiting for it to load if needed. */
  private postToUi(msg: unknown): void {
    if (this.host && this.webviewReady) {
      void this.host.postMessage(msg);
    } else {
      this.pendingUiMessage = msg;
    }
  }

  /** Command Palette "Resume Previous Session": open this chat's Resume panel. */
  openResumePanel(): void {
    this.postToUi({ type: "openResume" });
  }

  /** Command Palette "Log In". */
  async login(): Promise<void> {
    await this.runLogin();
  }

  /** Command Palette "New Session": ask, then start a fresh conversation. */
  async confirmNewSession(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      "Start a new session in this chat?",
      {
        modal: true,
        detail:
          "This clears the chat. The current conversation is saved and can be reopened with Resume.",
      },
      "New Session"
    );
    if (choice !== "New Session") {
      return;
    }
    if (!this.transport) {
      await this.ensureStarted();
      return;
    }
    await this.newSession();
  }

  private async newSession(): Promise<void> {
    if (this.transport?.mode === "persistent") {
      try {
        await this.transport.client.newSession();
        this.post({ type: "cleared" });
      } catch (err) {
        this.post({ type: "error", message: errorMessage(err) });
      }
    } else if (this.transport?.mode === "one-shot") {
      this.transport.runner.setSessionId(undefined);
      this.post({ type: "cleared" });
    }
  }

  /** Fetch sessions for this folder and send them to the webview to display. */
  private async sendSessionList(): Promise<void> {
    if (!this.cliPath) {
      this.post({ type: "sessionList", sessions: [], error: "Kiro CLI not ready yet." });
      return;
    }
    // Tell the webview we're loading (it shows a spinner).
    this.post({ type: "sessionListLoading" });

    const cwd = normalizePath(this.workspaceCwd());
    const sessions = await listSessions(this.cliPath, this.workspaceCwd(), (m) =>
      this.log(m)
    );
    const engineSource = this.resolvedEngine;

    // Prefer sessions matching this engine + folder, but progressively relax.
    const sameEngineAndCwd = sessions.filter(
      (s) => s.source === engineSource && normalizePath(s.cwd) === cwd
    );
    const sameEngine = sessions.filter((s) => s.source === engineSource);
    const candidates =
      sameEngineAndCwd.length > 0
        ? sameEngineAndCwd
        : sameEngine.length > 0
          ? sameEngine
          : sessions;

    // Sort newest first.
    candidates.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    this.log(
      `[resume] engine=${String(engineSource)} showing=${candidates.length}`
    );

    this.post({
      type: "sessionList",
      sessions: candidates.map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        updatedAt: s.updatedAt,
        source: s.source,
        messageCount: s.messageCount,
      })),
    });
  }

  /** Load a chosen session into the current transport. */
  private async loadSessionById(sessionId: string): Promise<void> {
    if (!sessionId) {
      return;
    }
    try {
      // Clear the view FIRST so the history replayed by session/load (which
      // arrives as session/update notifications during the await below)
      // populates a fresh chat instead of being wiped afterward.
      this.post({ type: "cleared" });
      this.post({ type: "status", text: "Loading session history…" });
      if (this.transport?.mode === "persistent") {
        await this.transport.client.loadSession(sessionId);
      } else if (this.transport?.mode === "one-shot") {
        this.transport.runner.setSessionId(sessionId);
      }
      this.post({ type: "status", text: "Resumed session." });
    } catch (err) {
      this.post({ type: "error", message: errorMessage(err) });
    }
  }

  /** Ask before restarting: it ends the current conversation in this chat. */
  async confirmRestart(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      "Restart the Kiro engine and start a new session?",
      {
        modal: true,
        detail:
          "This clears the chat and stops any reply in progress. The current conversation is saved and can be reopened with Resume.",
      },
      "Restart"
    );
    if (choice !== "Restart") {
      return;
    }
    this.post({ type: "restarting" });
    await this.restart();
  }

  async restart(): Promise<void> {
    this.disposeTransport();
    this.post({ type: "cleared" });
    await this.ensureStarted();
  }

  private async runLogin(): Promise<void> {
    const cliPath = this.cliPath ?? resolveCliPath(readConfig().cliPath);
    if (!cliPath) {
      return;
    }
    const terminal = vscode.window.createTerminal("Kiro CLI Login");
    terminal.show();
    terminal.sendText(`"${cliPath}" login`);
    void vscode.window
      .showInformationMessage(
        "Complete login in the terminal, then click Retry.",
        "Retry"
      )
      .then((choice) => {
        if (choice === "Retry") {
          void this.restart();
        }
      });
  }

  /** 📎: VS Code file picker. Images are attached; other files insert their path. */
  async pickAttachment(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      defaultUri: vscode.Uri.file(this.workspaceCwd()),
      openLabel: "Attach",
    });
    if (!picked || picked.length === 0) {
      return;
    }
    const fsPaths = picked.map((u) => u.fsPath);
    const images = fsPaths.filter((p) => imageMimeForPath(p));
    const others = fsPaths.filter((p) => !imageMimeForPath(p));
    await this.attachImagePaths(images);
    if (others.length > 0) {
      this.post({ type: "insertPaths", paths: others });
    }
  }

  /** Read image files from disk and hand them to the webview as attachments. */
  private async attachImagePaths(paths: string[]): Promise<void> {
    for (const p of paths.slice(0, MAX_IMAGES)) {
      const mimeType = imageMimeForPath(p);
      if (!mimeType) {
        continue;
      }
      try {
        const uri = vscode.Uri.file(p);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type !== vscode.FileType.File) {
          continue;
        }
        if (stat.size > MAX_IMAGE_BYTES) {
          this.post({ type: "notice", text: `${p} is larger than 10 MB and wasn't attached.`, isError: true });
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        this.post({
          type: "attachImage",
          name: p.split(/[\\/]/).pop() ?? "image",
          mimeType,
          data: Buffer.from(bytes).toString("base64"),
        });
      } catch (err) {
        this.post({ type: "notice", text: `Couldn't read ${p}: ${errorMessage(err)}`, isError: true });
      }
    }
  }

  private workspaceCwd(): string {
    return (
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      process.env.HOME ??
      process.cwd()
    );
  }

  private disposeTransport(): void {
    this.pendingApprovals.clear();
    if (this.transport?.mode === "persistent") {
      this.transport.client.dispose();
    } else if (this.transport?.mode === "one-shot") {
      this.transport.runner.cancel();
    }
    this.transport = undefined;
  }

  /** The chat's tab/view was closed: stop its engine. */
  dispose(): void {
    this.disposed = true;
    this.hostSub?.dispose();
    this.host = undefined;
    this.disposeTransport();
  }

  // --- helpers ---

  private post(msg: unknown): void {
    const m = msg as { type?: string; event?: { kind?: string } };
    if (m?.type === "event") {
      this.log(`[post] event:${m.event?.kind ?? "?"}`);
    } else if (m?.type) {
      this.log(`[post] ${m.type}`);
    }
    this.record(msg);
    if (this.host && !this.disposed) {
      void this.host.postMessage(msg);
    }
  }

  /**
   * Keep a transcript of what the chat shows, so a re-created webview (VS Code
   * rebuilds it when the view is moved between panel/side bar) can be restored.
   */
  private record(msg: unknown): void {
    const m = msg as { type?: string; event?: { kind?: string } };
    switch (m?.type) {
      case "ready":
        this.lastReady = msg;
        break;
      case "cleared":
        this.transcript = [];
        break;
      case "userMessage":
      case "error":
      case "notice":
        this.transcript.push(msg);
        break;
      case "event": {
        const kind = m.event?.kind;
        // Settings/commands state: keep only the latest snapshot.
        if (kind === "configOptions") {
          this.lastConfig = msg;
        } else if (kind === "availableCommands") {
          this.lastCommands = msg;
        } else if (kind === "contextUsage") {
          this.lastContext = msg;
        } else if (kind === "approvalResolved") {
          // Answered by a rule: no card to restore, and nothing pending.
          const id = (m.event as { toolCallId?: string }).toolCallId ?? "";
          this.dropApprovalCard(id);
          this.pendingApprovals.delete(id);
          this.transcript.push(msg);
        } else {
          this.transcript.push(msg);
        }
        break;
      }
      default:
        break;
    }
    if (this.transcript.length > MAX_TRANSCRIPT) {
      this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT);
    }
  }

  /** Re-sync a freshly (re)created webview with the already-running engine. */
  private resyncWebview(target: vscode.Webview): void {
    const send = (msg: unknown): void => {
      void target.postMessage(msg);
    };
    if (this.lastReady) {
      send(this.lastReady);
    }
    for (const msg of this.transcript) {
      send(msg);
    }
    for (const msg of [this.lastConfig, this.lastCommands, this.lastContext]) {
      if (msg) {
        send(msg);
      }
    }
    this.log(`[resync] restored ${this.transcript.length} messages`);
  }
}

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 10;
const MAX_TRANSCRIPT = 20000;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function imageMimeForPath(p: string): string | undefined {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME_BY_EXT[ext];
}

/** Validate image attachments posted by the webview before forwarding them. */
function sanitizeImages(raw: unknown): PromptImage[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: PromptImage[] = [];
  for (const item of raw.slice(0, MAX_IMAGES)) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const r = item as Record<string, unknown>;
    const mimeType = String(r.mimeType ?? "");
    const data = typeof r.data === "string" ? r.data : "";
    if (!ALLOWED_IMAGE_TYPES.has(mimeType) || !data || !/^[A-Za-z0-9+/=]+$/.test(data)) {
      continue;
    }
    // Base64 expands by 4/3; reject oversized payloads.
    if ((data.length * 3) / 4 > MAX_IMAGE_BYTES) {
      continue;
    }
    out.push({ mimeType, data, name: r.name ? String(r.name).slice(0, 200) : undefined });
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Normalize a filesystem path for comparison: strip a trailing slash and
 * collapse the macOS `/private` symlink prefix (e.g. `/private/tmp` vs `/tmp`)
 * so session cwd matching is resilient.
 */
function normalizePath(p: string | undefined): string {
  let s = String(p ?? "");
  if (s.length > 1 && s.endsWith("/")) {
    s = s.slice(0, -1);
  }
  if (s.startsWith("/private/")) {
    s = s.slice("/private".length);
  }
  return s;
}

function getNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/** The chat webview's HTML (same for every chat). */
function getHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "webview.js")
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "webview.css")
  );
  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${styleUri}" rel="stylesheet" />
<title>Kiro CLI Chat</title>
</head>
<body>
<div id="app">
<div id="toolbar">
  <select id="sel-model" class="toolbar-model" title="Model" aria-label="Model" disabled>
    <option>Auto</option>
  </select>
  <button id="ctx-meter" class="ctx-meter hidden" aria-describedby="ctx-card" aria-label="Context usage">
    <svg class="ctx-ring" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <circle class="ctx-ring-bg" cx="10" cy="10" r="8" />
      <circle id="ctx-ring-fg" class="ctx-ring-fg" cx="10" cy="10" r="8" />
    </svg>
    <span id="ctx-text" class="ctx-text"></span>
  </button>
  <div id="ctx-card" class="ctx-card hidden" role="tooltip"></div>
  <span id="status">Starting…</span>
  <span id="spacer"></span>
  <select id="sel-mode" class="toolbar-model toolbar-mode" title="Agent mode" aria-label="Agent mode" disabled>
    <option>Default</option>
  </select>
  <button id="btn-resume" title="Resume previous session">Resume</button>
  <button id="btn-restart" title="Restart engine">Restart</button>
  <button id="btn-new-tab" title="New chat tab" aria-label="New chat tab">＋</button>
  <button id="btn-settings" title="Settings">⚙</button>
</div>
<div id="resume-panel" class="resume-panel hidden">
  <div id="resume-header" class="resume-header">
    <span>Previous sessions</span>
    <button id="resume-close" class="resume-close" title="Close" aria-label="Close previous sessions">✕</button>
  </div>
  <div id="resume-list" class="resume-list"></div>
</div>
<div id="settings" class="settings hidden">
  <div class="panel-header settings-header">
    <span>Settings</span>
    <button id="settings-close" class="resume-close" title="Close" aria-label="Close settings">✕</button>
  </div>
  <div class="settings-row hidden" id="effort-row">
    <label for="sel-effort">Effort</label>
    <select id="sel-effort"></select>
  </div>
  <div class="settings-row">
    <label for="chk-autopilot">Autopilot</label>
    <input type="checkbox" id="chk-autopilot" />
  </div>
  <div class="settings-note">Autopilot auto-approves tool actions. Off = Supervised (approve each change).</div>
  <div class="settings-row">
    <label for="sel-memory">Memory reflection</label>
    <select id="sel-memory"></select>
  </div>
  <div class="settings-note">Lets the session learn and store new long-term memories.</div>
  <div class="settings-row">
    <label for="sel-content">Content collection</label>
    <select id="sel-content"></select>
  </div>
  <div class="settings-note">Whether your content may be used for service improvement.</div>
</div>
<div id="messages"></div>
<div id="composer">
  <div id="cmd-picker" class="cmd-picker hidden" role="listbox" aria-label="Slash commands"></div>
  <div id="cmd-hint" class="cmd-hint hidden"></div>
  <div id="attachments" class="attachments hidden" aria-label="Attached images"></div>
  <textarea id="input" rows="1" placeholder="Ask Kiro something…  (/ for commands)" aria-label="Message"></textarea>
  <button id="btn-send" title="Send (Enter)" aria-label="Send">
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>
  </button>
</div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
