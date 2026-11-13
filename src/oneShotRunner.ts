// One-shot fallback transport: spawn `kiro-cli chat --output-format
// stream-json` per turn, using --resume-id for multi-turn history.
// No live tool approvals (tools must be pre-trusted). Node-only.

import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";
import { JsonLineParser, lineSplitter } from "./jsonLineParser";
import { mapStreamJsonEvent } from "./eventMapper";
import { sanitizedEnv } from "./cli";
import { ChatEvent, EngineVersion } from "./types";

export interface OneShotOptions {
  cliPath: string;
  engine: EngineVersion;
  model?: string;
  cwd: string;
  trustAllTools?: boolean;
  trustTools?: string[];
}

/**
 * Emits "event" (ChatEvent), "log" (string), "turnEnd" when the process exits.
 * Tracks sessionId to resume subsequent turns.
 */
export class OneShotRunner extends EventEmitter {
  private sessionId?: string;
  private active?: ChildProcessWithoutNullStreams;

  constructor(private readonly opts: OneShotOptions) {
    super();
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  /** Run a single turn with the given prompt. */
  prompt(text: string): Promise<void> {
    const args = [
      "chat",
      "--agent-engine",
      this.opts.engine,
      "--output-format",
      "stream-json",
      "--no-interactive",
    ];
    if (this.opts.model && this.opts.model !== "auto") {
      args.push("--model", this.opts.model);
    }
    if (this.opts.trustAllTools) {
      args.push("--trust-all-tools");
    } else if (this.opts.trustTools && this.opts.trustTools.length > 0) {
      args.push(`--trust-tools=${this.opts.trustTools.join(",")}`);
    }
    if (this.sessionId) {
      args.push("--resume-id", this.sessionId);
    }

    const parser = new JsonLineParser();

    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.cliPath, args, {
        cwd: this.opts.cwd,
        env: sanitizedEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
      this.active = child;

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        for (const parsed of parser.push(chunk)) {
          if (parsed.type === "json") {
            this.dispatch(parsed.value);
          }
        }
      });
      const stderr = lineSplitter((line) => {
        if (line.trim()) {
          this.emit("log", line);
        }
      });
      child.stderr.on("data", (chunk: string) => stderr.push(chunk));
      child.stdin.on("error", (err) => this.emit("log", `stdin error: ${err.message}`));
      child.on("error", (err) => {
        this.active = undefined;
        this.emit("turnEnd", null);
        reject(err);
      });
      child.on("exit", (code) => {
        stderr.flush();
        const tail = parser.flush();
        if (tail && tail.type === "json") {
          this.dispatch(tail.value);
        }
        this.active = undefined;
        this.emit("turnEnd", code);
        resolve();
      });

      child.stdin.write(text);
      child.stdin.end();
    });
  }

  cancel(): void {
    this.active?.kill("SIGTERM");
    this.active = undefined;
  }

  private dispatch(value: unknown): void {
    for (const ev of mapStreamJsonEvent(value)) {
      if (ev.kind === "sessionId") {
        this.sessionId = ev.sessionId;
      }
      this.emit("event", ev as ChatEvent);
    }
  }
}
