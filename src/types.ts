// Shared types for the Kiro CLI Chat extension.

import type { ApprovalRule, RuleKind } from "./approvalRules";
export type { ApprovalRule, RuleKind } from "./approvalRules";

export type EngineVersion = "v1" | "v2" | "v3";
/** A JSON-RPC request id (the engine's own requests may use either). */
export type RpcId = number | string;
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
  /** `requestId` is the engine's JSON-RPC id, for answering (ACP only). */
  | { kind: "approvalRequest"; request: ApprovalRequest; requestId?: RpcId }
  /** A waiting approval was answered by a rule just created (no card needed). */
  | { kind: "approvalResolved"; toolCallId: string; requestId: RpcId; allowed: boolean; label: string }
  /** The agent asks a question (the `user_input` tool); answer with `AcpClient.answerQuestion`. */
  | { kind: "question"; question: Question; requestId: RpcId }
  /** A waiting question is gone (cancelled or the turn ended): remove its card. */
  | { kind: "questionResolved"; toolCallId: string; requestId: RpcId }
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
  /**
   * The engine's options. When `allowRules` / `denyRules` are set, the
   * allow_always / reject_always option opens that rule list instead of
   * answering directly (like the kiro-cli TUI's "Create allow rule…").
   */
  options: ApprovalOption[];
  /**
   * The engine asks once per command in a compound shell line
   * (`a; b && c | d`). This is the command being asked about, when it
   * differs from `question` (the whole line).
   */
  part?: string;
  /** 1-based position of `part` within the line (`consentRound`). */
  round?: number;
  /** Engine consent capability (`fs_read`, `shell`, …). */
  capability?: string;
  /** The file or command being asked about. */
  resource?: string;
  workspaceRoot?: string;
  sessionId?: string;
  /** Tool display name, e.g. "Run Command". */
  tool?: string;
  allowRules?: ApprovalRule[];
  denyRules?: ApprovalRule[];
  /** Why the engine's trust classifier wants a person to look at this. */
  flag?: string;
}

/** One choice offered by the agent's question. */
export interface QuestionOption {
  title: string;
  description?: string;
  recommended?: boolean;
  /** Extra items to pick from after choosing this option (all start selected). */
  subOptionsLabel?: string;
  subOptions?: Array<{ title: string; description?: string }>;
}

/** A question from the agent, with choices. The user may also type an answer. */
export interface Question {
  toolCallId: string;
  question: string;
  options: QuestionOption[];
}

/** How the user answered an approval. */
export interface ApprovalAnswer {
  optionId: string;
  /** For allow_always / reject_always: which rule to create. */
  rule?: RuleKind;
  /** For folder rules: the folder typed (checked again before sending). */
  folder?: string;
  /** For reject_once: why, sent to the agent. */
  reason?: string;
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
