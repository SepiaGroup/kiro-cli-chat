// Persistent ACP (Agent Client Protocol) transport.
// Spawns `kiro-cli acp` and speaks JSON-RPC 2.0 over stdio (newline-delimited).
// stdout = JSON-RPC; stderr = logs. Node-only (child_process); no vscode import.

import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";
import { JsonLineParser } from "./jsonLineParser";
import { mapSessionUpdate } from "./eventMapper";
import { sanitizedEnv } from "./cli";
import { ChatEvent, EngineVersion, PromptImage } from "./types";

export interface AcpClientOptions {
  cliPath: string;
  engine: EngineVersion;
  model?: string;
  cwd: string;
  trustAllTools?: boolean;
}

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

/**
 * Minimal ACP client. Emits:
 *  - "event"  (ChatEvent) for normalized chat events
 *  - "log"    (string)    for stderr lines
 *  - "exit"   (code)      when the process exits
 *  - "notification" (method, params) for unmapped JSON-RPC notifications
 */
export class AcpClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private readonly parser = new JsonLineParser();
  private nextId = 1;
  private readonly pending = new Map<number, PendingResolver>();
  private sessionId?: string;
  private initialized = false;
  private autoApprove = false;
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
    this.child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) {
          this.stderrTail.push(line);
          if (this.stderrTail.length > 40) {
            this.stderrTail.shift();
          }
          this.emit("log", line);
        }
      }
    });
    this.child.on("exit", (code) => {
      const detail = this.stderrTail.slice(-6).join(" | ");
      this.rejectAllPending(
        new Error(`kiro-cli acp exited (code=${code})${detail ? " — " + detail : ""}`)
      );
      this.emit("exit", code);
    });
    this.child.on("error", (err) => this.emit("log", `spawn error: ${err.message}`));

    // ACP initialize handshake.
    const initResult = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
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
    // The engine advertises promptCapabilities.image, so images go in as
    // standard ACP image content blocks alongside the text.
    const prompt: Array<Record<string, unknown>> = [];
    if (text.trim()) {
      prompt.push({ type: "text", text });
    }
    for (const img of images) {
      prompt.push({ type: "image", mimeType: img.mimeType, data: img.data });
    }
    await this.request("session/prompt", { sessionId: this.sessionId, prompt });
    this.emit("event", { kind: "runFinished", status: "success" } as ChatEvent);
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

  /** Answer a pending tool-approval request by its id with an optionId. */
  respondToApproval(requestId: number, optionId: string): void {
    this.sendResponse(requestId, { outcome: { outcome: "selected", optionId } });
  }

  /**
   * Cancel the in-flight turn (ACP `session/cancel` notification). Verified on
   * v3: the pending session/prompt resolves with stopReason "cancelled".
   */
  cancel(): void {
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
    this.rejectAllPending(new Error("disposed"));
    this.child?.kill("SIGTERM");
    this.child = undefined;
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
    if (typeof m.id === "number" && typeof m.method === "string") {
      this.handleServerRequest(m.id, m.method, m.params);
      return;
    }

    // Notification (no id).
    if (typeof m.method === "string") {
      this.handleNotification(m.method, m.params);
    }
  }

  private handleServerRequest(id: number, method: string, params: unknown): void {
    if (method === "session/request_permission") {
      const p = (params ?? {}) as Record<string, unknown>;
      const toolCall = (p.toolCall ?? {}) as Record<string, unknown>;
      const options = Array.isArray(p.options) ? p.options : [];
      const mapped = options.map((o) => {
        const r = (o ?? {}) as Record<string, unknown>;
        return {
          optionId: String(r.optionId ?? ""),
          name: String(r.name ?? ""),
          kind: String(r.kind ?? ""),
        };
      });

      // Autopilot (client-side): auto-approve by selecting an allow option.
      if (this.autoApprove) {
        const allow =
          mapped.find((o) => o.kind === "allow_once") ??
          mapped.find((o) => o.kind.startsWith("allow")) ??
          mapped[0];
        if (allow) {
          this.sendResponse(id, {
            outcome: { outcome: "selected", optionId: allow.optionId },
          });
          return;
        }
      }

      this.emit("event", {
        kind: "approvalRequest",
        request: {
          toolCallId: String(toolCall.toolCallId ?? p.toolCallId ?? ""),
          question: String(p.question ?? toolCall.title ?? "Approve tool?"),
          options: mapped,
        },
      } as ChatEvent);
      // The caller answers via respondToApproval(id, optionId).
      this.emit("permissionRequest", id, params);
      return;
    }
    // Unknown server request: respond with empty result to avoid stalling.
    this.sendResponse(id, {});
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "session/update") {
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
      this.pending.set(id, { resolve, reject });
      this.write(payload);
    });
  }

  private sendResponse(id: number, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private write(obj: unknown): void {
    if (!this.child) {
      return;
    }
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  private rejectAllPending(err: Error): void {
    for (const resolver of this.pending.values()) {
      resolver.reject(err);
    }
    this.pending.clear();
  }
}
