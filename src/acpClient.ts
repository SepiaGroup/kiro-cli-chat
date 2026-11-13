// Persistent ACP (Agent Client Protocol) transport.
// Spawns `kiro-cli acp` and speaks JSON-RPC 2.0 over stdio (newline-delimited).
// stdout = JSON-RPC; stderr = logs. Node-only (child_process); no vscode import.

import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";
import { JsonLineParser, lineSplitter } from "./jsonLineParser";
import { mapPermissionRequest, mapSessionUpdate } from "./eventMapper";
import { sanitizedEnv } from "./cli";
import { checkFolder, cleanReason, folderResource, isShell } from "./approvalRules";
import { expandFileMentions, mentionNotice } from "./fileMentions";
import { formatDuration } from "./format";
import { mapUserInput } from "./questions";
import { ApprovalAnswer, ApprovalRequest, ChatEvent, EngineVersion, PromptImage, Question, RpcId } from "./types";

export interface AcpClientOptions {
  cliPath: string;
  engine: EngineVersion;
  model?: string;
  cwd: string;
  trustAllTools?: boolean;
  /** Override request timeouts (tests). */
  timeoutsMs?: Record<string, number>;
  /** Override how long a prompt may get no reply at all before it's cancelled (tests). */
  initialResponseTimeoutMs?: number;
}

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

/**
 * Timeouts for requests that should answer quickly. `session/prompt` has none
 * (a turn can run for a long time); extension methods like compaction can
 * also be slow and have none. Generous because older Macs start slowly.
 */
const TIMEOUTS_MS: Record<string, number> = {
  initialize: 120_000,
  "session/new": 120_000,
  "session/load": 180_000,
  "session/set_mode": 30_000,
  "session/set_config_option": 30_000,
};

/**
 * A turn that gets no event at all this long after the prompt is cancelled,
 * like the kiro-cli TUI (10 minutes). After the first event there's no limit
 * (a build can be silent for a long time), but a quiet turn is logged.
 */
const INITIAL_RESPONSE_TIMEOUT_MS = 600_000;
const QUIET_LOG_AFTER_MS = 30_000;

/** How long to wait after SIGTERM before SIGKILL on dispose. */
const KILL_AFTER_MS = 3000;

export class AcpClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private readonly parser = new JsonLineParser();
  private nextId = 1;
  private readonly pending = new Map<number, PendingResolver>();
  private exited = false;
  private sessionId?: string;
  private initialized = false;
  private autoApprove = false;
  /** Permission requests waiting for an answer, by JSON-RPC id. */
  private pendingPermissions = new Map<RpcId, ApprovalRequest>();
  /** Questions from the agent waiting for an answer, by JSON-RPC id. */
  private pendingQuestions = new Map<RpcId, Question>();
  /** Set while a prompt runs: called for every sign of life from the engine. */
  private onActivity?: () => void;
  private readonly stderrTail: string[] = [];

  constructor(private readonly opts: AcpClientOptions) {
    super();
    // On v3 the engine can't be told to autopilot via flags, so we emulate it
    // client-side by auto-approving permission requests.
    this.autoApprove = Boolean(opts.trustAllTools);
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Spawn the process and run the ACP initialize handshake, then open a
   * session: `resumeSessionId` if given and loadable, otherwise a new one.
   * Resolves to whether the requested session was resumed.
   */
  async start(resumeSessionId?: string): Promise<boolean> {
    const args = ["acp", "--agent-engine", this.opts.engine];
    // IMPORTANT: v3's `acp` subcommand only accepts --agent-engine and
    // --auth-method. It hard-rejects --model, --trust-all-tools, --agent, etc.
    // (verified: "the following arguments are not supported with
    // --agent-engine=v3"). So those flags may ONLY be passed to v1/v2.
    if (this.opts.engine === "v3") {
      args.push("--auth-method", "cli");
    } else {
      if (this.opts.model && this.opts.model !== "auto") {
        args.push("--model", this.opts.model);
      }
      if (this.opts.trustAllTools) {
        args.push("--trust-all-tools");
      }
    }

    this.child = spawn(this.opts.cliPath, args, {
      cwd: this.opts.cwd,
      env: sanitizedEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    const stderr = lineSplitter((line) => {
      if (line.trim()) {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) {
          this.stderrTail.shift();
        }
        this.emit("log", line);
      }
    });
    this.child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    // Writing to an engine that just died raises EPIPE here; without a
    // handler it would be an uncaught exception in the extension host.
    this.child.stdin.on("error", (err) => this.emit("log", `stdin error: ${err.message}`));
    this.child.on("exit", (code) => {
      this.exited = true;
      stderr.flush();
      const detail = this.stderrTail.slice(-6).join(" | ");
      this.rejectAllPending(
        new Error(`kiro-cli acp exited (code=${code})${detail ? " — " + detail : ""}`)
      );
      this.emit("exit", code);
    });
    this.child.on("error", (err) => {
      // E.g. ENOENT: the binary can't be started. "exit" may not follow.
      this.exited = true;
      this.emit("log", `spawn error: ${err.message}`);
      this.rejectAllPending(new Error(`Couldn't start ${this.opts.cliPath}: ${err.message}`));
    });

    // ACP initialize handshake.
    const initResult = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        // Tell the engine we can show its questions (`_kiro/userInput`);
        // without this it asks in prose or skips them.
        _meta: { kiro: { userInput: true } },
      },
    });
    this.initialized = true;
    this.emit("initialized", initResult);

    if (resumeSessionId) {
      try {
        await this.loadSession(resumeSessionId);
        return true;
      } catch (err) {
        this.emit("log", `resume ${resumeSessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await this.newSession();
    return false;
  }

  /** Create a new ACP session in the working directory. */
  async newSession(): Promise<string> {
    const result = (await this.request("session/new", {
      cwd: this.opts.cwd,
      mcpServers: [],
    })) as { sessionId?: string } | undefined;
    const id = result?.sessionId;
    if (!id) {
      throw new Error("session/new did not return a sessionId");
    }
    this.sessionId = id;
    this.emit("event", { kind: "sessionId", sessionId: id } as ChatEvent);
    return id;
  }

  /** Load/resume an existing session by id. */
  async loadSession(sessionId: string): Promise<void> {
    await this.request("session/load", {
      sessionId,
      cwd: this.opts.cwd,
      mcpServers: [],
    });
    this.sessionId = sessionId;
    this.emit("event", { kind: "sessionId", sessionId } as ChatEvent);
  }

  /** Send a user prompt. Resolves when the turn completes. */
  async prompt(text: string, images: PromptImage[] = []): Promise<void> {
    if (!this.initialized || !this.sessionId) {
      throw new Error("ACP client not ready");
    }
    this.emit("event", { kind: "runStarted", engine: this.opts.engine } as ChatEvent);
    // `@file:path` puts the file in the prompt, like the kiro-cli TUI. The chat
    // history (and a resumed session) keeps showing what was typed.
    const mentions = expandFileMentions(text, this.opts.cwd);
    for (const s of mentions.skipped) {
      this.emit("log", `@file:${s.path} was not attached (${s.reason})`);
    }
    const notice = mentionNotice(mentions);
    if (notice) {
      this.emit("event", { kind: "notice", text: notice } as ChatEvent);
    }
    const meta = mentions.attached.length > 0 ? { kiro: { displayText: text } } : undefined;
    // The engine advertises promptCapabilities.image, so images go in as
    // standard ACP image content blocks alongside the text.
    const prompt: Array<Record<string, unknown>> = [];
    if (mentions.text.trim()) {
      prompt.push({ type: "text", text: mentions.text });
    }
    for (const img of images) {
      prompt.push({ type: "image", mimeType: img.mimeType, data: img.data });
    }
    // Always report the end of the turn, so the UI leaves its busy state.
    let status = "error";
    let stopReason: string | undefined;
    const watchdog = this.startWatchdog();
    try {
      const turn = this.request("session/prompt", { sessionId: this.sessionId, prompt, ...(meta ? { _meta: meta } : {}) });
      turn.catch(() => undefined); // if the watchdog wins, a late failure isn't "unhandled"
      const res = (await Promise.race([turn, watchdog.failed])) as { stopReason?: unknown } | undefined;
      stopReason = typeof res?.stopReason === "string" ? res.stopReason : undefined;
      status = stopReason === "cancelled" ? "cancelled" : stopReason === "refusal" ? "error" : "success";
    } finally {
      watchdog.stop();
      // The turn is over, so nobody is waiting for these any more.
      this.dropQuestions(false);
      this.emit("event", { kind: "runFinished", status, ...(stopReason ? { stopReason } : {}) } as ChatEvent);
    }
  }

  /**
   * Cancel a prompt that gets no reply at all, and log a turn that goes quiet.
   * `failed` rejects when the engine never answered; `stop` ends the watch.
   */
  private startWatchdog(): { failed: Promise<never>; stop: () => void } {
    const limit = this.opts.initialResponseTimeoutMs ?? INITIAL_RESPONSE_TIMEOUT_MS;
    let first: NodeJS.Timeout | undefined;
    let lastEvent = Date.now();
    let logged = false;
    const stop = (): void => {
      clearTimeout(first);
      clearInterval(quiet);
      this.onActivity = undefined;
    };
    const failed = new Promise<never>((_, reject) => {
      first = setTimeout(() => {
        this.emit("log", `no reply from the engine after ${formatDuration(limit)}; cancelling the turn`);
        this.cancel();
        reject(
          new Error(
            `The Kiro engine sent nothing for ${formatDuration(limit)}, so the turn was cancelled. Send the prompt again, or use Restart if it keeps happening.`
          )
        );
      }, limit);
      first.unref();
    });
    failed.catch(() => undefined);
    const quiet = setInterval(() => {
      if (this.pendingQuestions.size > 0 || this.pendingPermissions.size > 0) {
        lastEvent = Date.now(); // waiting for the user, not for the engine
        return;
      }
      const silent = Date.now() - lastEvent;
      if (silent >= QUIET_LOG_AFTER_MS && !logged) {
        logged = true;
        this.emit("log", `no events for ${formatDuration(silent)}; the turn may be stuck`);
      }
    }, QUIET_LOG_AFTER_MS / 2);
    quiet.unref();
    this.onActivity = () => {
      clearTimeout(first); // the engine is alive: no more first-reply limit
      lastEvent = Date.now();
      logged = false;
    };
    return { failed, stop };
  }

  /**
   * Call one of the engine's extension methods (e.g. "_kiro/session/context").
   * The session id is added automatically.
   */
  async extMethod<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.sessionId) {
      throw new Error("no active session");
    }
    return (await this.request(method, { sessionId: this.sessionId, ...params })) as T;
  }

  /**
   * Answer a pending tool-approval request. Sends `_meta.kiro.consent` the
   * way the kiro-cli TUI does: for allow_always / reject_always the rule to
   * create (exact, pattern, `folder/**` or `*` for the entire tool; session
   * scope), otherwise an `invocation`-scoped consent, plus the deny reason.
   * After an entire-tool rule, approvals already waiting for the same tool
   * are answered too (the engine doesn't re-check them).
   */
  respondToApproval(requestId: RpcId, answer: string | ApprovalAnswer): void {
    const a: ApprovalAnswer = typeof answer === "string" ? { optionId: answer } : answer;
    const req = this.pendingPermissions.get(requestId);
    const kind = req?.options.find((o) => o.optionId === a.optionId)?.kind ?? "";
    const result: Record<string, unknown> = { outcome: { outcome: "selected", optionId: a.optionId } };
    // Throws for an invalid folder, leaving the request pending.
    const meta = req ? consentMeta(req, kind, a) : undefined;
    this.pendingPermissions.delete(requestId);
    if (meta) {
      result._meta = meta;
    }
    this.sendResponse(requestId, result);

    const always = kind === "allow_always" || kind === "reject_always";
    if (req?.capability && always && a.rule === "tool") {
      this.resolveWaiting(req, kind === "allow_always");
    }
  }

  /**
   * Answer the agent's question: `answer` is an option's title or typed text;
   * without one the question is skipped (the agent is told to move on).
   */
  answerQuestion(requestId: RpcId, answer?: string): void {
    if (!this.pendingQuestions.delete(requestId)) {
      return;
    }
    const text = answer?.trim();
    this.sendResponse(requestId, text ? { action: "answered", answer: text } : { action: "dismissed" });
  }

  /** Forget waiting questions and tell the UI to remove them. */
  private dropQuestions(answerEngine: boolean): void {
    for (const [id, q] of [...this.pendingQuestions]) {
      this.pendingQuestions.delete(id);
      if (answerEngine) {
        this.sendResponse(id, { action: "dismissed" });
      }
      this.emit("event", { kind: "questionResolved", toolCallId: q.toolCallId, requestId: id } as ChatEvent);
    }
  }

  /** Answer other waiting approvals for the same tool after an entire-tool rule. */
  private resolveWaiting(rule: ApprovalRequest, allow: boolean): void {
    const group = (r: ApprovalRequest): string =>
      [isShell(r.capability) ? "shell" : r.capability, r.workspaceRoot ?? "", r.sessionId ?? ""].join("\0");
    const key = group(rule);
    for (const [id, req] of [...this.pendingPermissions]) {
      if (!req.capability || group(req) !== key) {
        continue;
      }
      const opt = req.options.find((o) => o.kind === (allow ? "allow_once" : "reject_once"));
      if (!opt) {
        continue;
      }
      this.respondToApproval(id, { optionId: opt.optionId });
      this.emit("event", {
        kind: "approvalResolved",
        toolCallId: req.toolCallId,
        requestId: id,
        allowed: allow,
        label: `${allow ? "Allowed" : "Denied"} by rule: entire tool${rule.tool ? ` (${rule.tool})` : ""}`,
      } as ChatEvent);
    }
  }

  /**
   * Cancel the in-flight turn (ACP `session/cancel` notification). Verified on
   * v3: the pending session/prompt resolves with stopReason "cancelled".
   */
  cancel(): void {
    this.dropQuestions(true);
    if (this.sessionId) {
      this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
    }
  }

  /**
   * Switch the session mode live (vibe/plan/spec/bug-fix/etc.). This is the
   * one session-config change v3 supports over ACP (via session/set_mode).
   */
  async setMode(modeId: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error("no active session");
    }
    await this.request("session/set_mode", { sessionId: this.sessionId, modeId });
  }

  /**
   * Set any session config option live (model, autopilot, memoryReflection,
   * contentCollection, …) via the generic ACP method. The engine echoes the
   * updated state back as a `config_option_update` notification.
   * NOTE: the field is `configId` (not `id`) and `value` must be the option's
   * string value (e.g. autopilot "on"/"off", not a boolean).
   */
  async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error("no active session");
    }
    await this.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId,
      value,
    });
  }

  /**
   * Client-side autopilot toggle. Because v3 does not expose an autopilot
   * switch over ACP, we emulate it: when enabled, incoming permission requests
   * are auto-approved (allow-once) instead of surfacing an approval card.
   */
  setAutoApprove(enabled: boolean): void {
    this.autoApprove = enabled;
  }

  dispose(): void {
    this.pendingPermissions.clear();
    this.pendingQuestions.clear();
    this.rejectAllPending(new Error("disposed"));
    const child = this.child;
    this.child = undefined;
    if (child && !this.exited) {
      child.kill("SIGTERM");
      // Don't leave an engine behind if it ignores SIGTERM.
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, KILL_AFTER_MS);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    }
  }

  // --- internals ---

  private onStdout(chunk: string): void {
    for (const parsed of this.parser.push(chunk)) {
      if (parsed.type !== "json") {
        continue; // stdout should be pure JSON-RPC; ignore stray lines
      }
      this.handleMessage(parsed.value);
    }
  }

  private handleMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) {
      return;
    }
    const m = msg as Record<string, unknown>;

    // Response to one of our requests.
    if (typeof m.id === "number" && (m.result !== undefined || m.error !== undefined)) {
      const resolver = this.pending.get(m.id);
      if (resolver) {
        this.pending.delete(m.id);
        if (m.error) {
          // Prefer the engine's detail ("… is not available when …") over
          // the generic "Internal error".
          const err = m.error as { message?: string; data?: { details?: unknown } };
          const details = typeof err.data?.details === "string" ? err.data.details : "";
          resolver.reject(new Error(details || err.message || "ACP error"));
        } else {
          resolver.resolve(m.result);
        }
      }
      return;
    }

    // Server-initiated request (e.g. permission prompt) — has id + method.
    if ((typeof m.id === "number" || typeof m.id === "string") && typeof m.method === "string") {
      this.onActivity?.();
      this.handleServerRequest(m.id, m.method, m.params);
      return;
    }

    // Notification (no id).
    if (typeof m.method === "string") {
      this.handleNotification(m.method, m.params);
    }
  }

  private handleServerRequest(id: RpcId, method: string, params: unknown): void {
    if (method === "session/request_permission") {
      const request = mapPermissionRequest(params);
      const mapped = request.options;

      // Autopilot (client-side): auto-approve by selecting an allow option.
      if (this.autoApprove) {
        const allow =
          mapped.find((o) => o.kind === "allow_once") ??
          mapped.find((o) => o.kind.startsWith("allow")) ??
          mapped[0];
        if (allow) {
          this.sendResponse(id, { outcome: { outcome: "selected", optionId: allow.optionId } });
          return;
        }
      }

      this.pendingPermissions.set(id, request);
      this.emit("event", { kind: "approvalRequest", request, requestId: id } as ChatEvent);
      // The caller answers via respondToApproval(id, optionId).
      this.emit("permissionRequest", id, params);
      return;
    }
    if (method === "_kiro/userInput") {
      const question = mapUserInput(params, `question-${String(id)}`);
      if (!question) {
        this.emit("log", "ignored a question without text");
        this.sendResponse(id, { action: "dismissed" });
        return;
      }
      this.pendingQuestions.set(id, question);
      this.emit("event", { kind: "question", question, requestId: id } as ChatEvent);
      return;
    }
    // Not something this client implements (we advertise no fs/terminal
    // capabilities): answer "method not found" so the engine doesn't wait.
    this.emit("log", `unsupported engine request: ${method}`);
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "session/update") {
      this.onActivity?.();
      const data = (params ?? {}) as Record<string, unknown>;
      // ACP wraps the update; reuse the stream-json session-update mapper.
      // Suppress two kinds that don't belong on the ACP path:
      //  - sessionId: we track it from session/new.
      //  - approvalRequest: in ACP, the actionable approval arrives as a
      //    `session/request_permission` server-request (handled above). The
      //    pending_interaction notification is a non-answerable duplicate.
      for (const ev of mapSessionUpdate(data)) {
        if (ev.kind === "sessionId" || ev.kind === "approvalRequest") {
          continue;
        }
        this.emit("event", ev);
      }
      return;
    }
    this.emit("notification", method, params);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      if (!this.canWrite()) {
        reject(new Error("The Kiro engine isn't running."));
        return;
      }
      const ms = this.opts.timeoutsMs?.[method] ?? TIMEOUTS_MS[method];
      const timer = ms
        ? setTimeout(() => {
            if (this.pending.delete(id)) {
              reject(new Error(`The Kiro engine didn't answer ${method} within ${Math.round(ms / 1000)}s.`));
            }
          }, ms)
        : undefined;
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.write(payload);
    });
  }

  private sendResponse(id: RpcId, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private canWrite(): boolean {
    return !!this.child && !this.exited && this.child.stdin.writable;
  }

  private write(obj: unknown): void {
    if (!this.canWrite()) {
      return;
    }
    this.child?.stdin.write(JSON.stringify(obj) + "\n");
  }

  private rejectAllPending(err: Error): void {
    for (const resolver of this.pending.values()) {
      resolver.reject(err);
    }
    this.pending.clear();
  }
}

/**
 * The response `_meta` for an approval answer, as the kiro-cli TUI builds it.
 * Throws if a folder rule's folder isn't valid (the UIs check it first).
 */
export function consentMeta(req: ApprovalRequest, kind: string, a: ApprovalAnswer): Record<string, unknown> | undefined {
  const reason = kind === "reject_once" ? cleanReason(a.reason) : undefined;
  if (!req.capability) {
    // The engine reads a deny reason even without consent info.
    return reason ? { kiro: { rejectionReason: reason } } : undefined;
  }
  const always = kind === "allow_always" || kind === "reject_always";
  const rules = kind === "allow_always" ? req.allowRules : kind === "reject_always" ? req.denyRules : undefined;
  const rule = always && a.rule ? rules?.find((r) => r.kind === a.rule) : undefined;
  let resource: string | undefined;
  if (rule?.kind === "folder" && rule.folder) {
    const check = checkFolder(rule.folder, a.folder ?? rule.folder.prefill);
    if (!check.ok) {
      throw new Error(check.reason);
    }
    resource = folderResource(check.path);
  } else if (rule) {
    resource = rule.resource;
  }
  // allow_always always saves a session rule (exact when no resource);
  // reject_always only with a resource; anything else is this call only.
  const scope = kind === "allow_always" || (always && resource) ? "session" : "invocation";
  return {
    kiro: {
      consent: {
        capability: req.capability,
        scope,
        ...(resource ? { resource } : {}),
        ...(req.workspaceRoot ? { workspaceRoot: req.workspaceRoot } : {}),
      },
      ...(reason ? { rejectionReason: reason } : {}),
    },
  };
}
