// Shared types for the Kiro CLI Chat extension.

export type EngineVersion = "v1" | "v2" | "v3";
export type EngineSetting = "auto" | EngineVersion;
export type InteractionMode = "persistent" | "one-shot";

/** Resolved runtime configuration read from VSCode settings + detection. */
export interface ResolvedConfig {
  cliPath: string;
  engine: EngineVersion;
  model: string;
  interactionMode: InteractionMode;
  autopilot: boolean;
  enterToSend: boolean;
}

/** Result of `kiro-cli whoami --format json` evaluation. */
export interface AuthStatus {
  loggedIn: boolean;
  identity?: string;
  raw?: string;
}

/** A chat session summary from `--list-sessions --format json`. */
export interface SessionSummary {
  sessionId: string;
  source: string; // "v1" | "v2" | "v3" | "classic" | ...
  title: string;
  updatedAt: string;
  messageCount: number;
  cwd: string;
}

/** A model entry from `--list-models --format json`. */
export interface ModelInfo {
  id: string;
  name?: string;
  description?: string;
  default?: boolean;
}

/**
 * Normalized chat events the webview understands. The transport layer maps
 * raw ACP / stream-json events into these.
 */
export type ChatEvent =
  | { kind: "runStarted"; engine: string }
  | { kind: "sessionId"; sessionId: string }
  | { kind: "assistantChunk"; text: string }
  | { kind: "userMessage"; text: string }
  | { kind: "thinking" }
  | { kind: "toolCall"; toolCallId: string; title: string; toolKind?: string; paths?: string[]; startLine?: number; diff?: ToolDiff }
  | { kind: "toolUpdate"; toolCallId: string; status: string; output?: string; diff?: ToolDiff; startLine?: number }
  | { kind: "approvalRequest"; request: ApprovalRequest }
  | { kind: "contextUsage"; usagePercentage: number; usedTokens?: number; threshold?: number }
  | { kind: "metering"; credits: number }
  /** The engine's id for the user message just sent (used by /rewind). */
  | { kind: "userMessageId"; messageId: string }
  /** End-of-turn summary (used by /stats). */
  | { kind: "turnCompletion"; elapsedMs?: number; requestIds: string[]; status?: string }
  | { kind: "configOptions"; options: ConfigOption[] }
  | { kind: "availableCommands"; commands: AvailableCommand[] }
  | { kind: "runFinished"; status: string; stopReason?: string; finalText?: string }
  | { kind: "error"; message: string };

export interface ToolDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

/** An image attached to a prompt (sent as an ACP image content block). */
export interface PromptImage {
  mimeType: string;
  /** Base64-encoded bytes (no data: prefix). */
  data: string;
  name?: string;
}

export interface ApprovalOption {
  optionId: string;
  name: string;
  kind: string; // allow_once | allow_always | reject_once | reject_always
}

export interface ApprovalRequest {
  toolCallId: string;
  question: string;
  options: ApprovalOption[];
}

export interface ConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: unknown;
  options?: Array<{
    value: string;
    name: string;
    description?: string;
    /** For the "model" option: effort levels this model supports (if any). */
    effortLevels?: string[];
    defaultEffortLevel?: string;
  }>;
}

export interface AvailableCommand {
  name: string;
  description?: string;
  /** Hint text for the command's argument, if it takes one. */
  inputHint?: string;
  /** Command classification from the engine (builtin, custom-agent, skill). */
  type?: string;
}
