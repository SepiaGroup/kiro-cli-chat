// Map raw ACP / stream-json event objects into normalized ChatEvents.
// Pure functions; unit-testable. Handles both the lean v2 stream-json shape
// and the richer v3 shape (session_info_update with _meta.kiro.kind).

import {
  ApprovalRequest,
  AvailableCommand,
  ChatEvent,
  ConfigOption,
  ToolDiff,
} from "./types";

/**
 * Map a top-level stream-json event (from `chat --output-format stream-json`).
 * Shape: { type: "runStarted" | "metadata" | "sessionUpdate" | "runFinished", data: {...} }
 */
export function mapStreamJsonEvent(obj: unknown): ChatEvent[] {
  if (!isRecord(obj)) {
    return [];
  }
  const type = obj.type;
  const data = isRecord(obj.data) ? obj.data : {};

  switch (type) {
    case "runStarted":
      return [{ kind: "runStarted", engine: String(data.engine ?? "") }];
    case "metadata":
      return mapMetadata(data);
    case "sessionUpdate":
      return mapSessionUpdate(data);
    case "runFinished":
      return [
        {
          kind: "runFinished",
          status: String(data.status ?? ""),
          stopReason: data.stopReason ? String(data.stopReason) : undefined,
          finalText: data.finalText ? String(data.finalText) : undefined,
        },
      ];
    default:
      return [];
  }
}

function mapMetadata(data: Record<string, unknown>): ChatEvent[] {
  const out: ChatEvent[] = [];
  if (data.sessionId) {
    out.push({ kind: "sessionId", sessionId: String(data.sessionId) });
  }
  if (typeof data.contextUsagePercentage === "number") {
    out.push({
      kind: "contextUsage",
      usagePercentage: data.contextUsagePercentage,
    });
  }
  const metering = data.meteringUsage;
  if (Array.isArray(metering)) {
    const credits = metering
      .filter((m) => isRecord(m) && m.unit === "credit")
      .reduce((sum, m) => sum + Number((m as Record<string, unknown>).value ?? 0), 0);
    if (credits > 0) {
      out.push({ kind: "metering", credits });
    }
  }
  return out;
}

/**
 * Map a `sessionUpdate` data object. The discriminator is
 * `data.update.sessionUpdate` (or `_meta.kiro.kind` for v3 session_info).
 */
export function mapSessionUpdate(data: Record<string, unknown>): ChatEvent[] {
  const out: ChatEvent[] = [];
  if (data.sessionId) {
    out.push({ kind: "sessionId", sessionId: String(data.sessionId) });
  }
  const update = isRecord(data.update) ? data.update : {};
  const kind = String(update.sessionUpdate ?? "");

  switch (kind) {
    case "agent_message_chunk": {
      const content = isRecord(update.content) ? update.content : {};
      if (typeof content.text === "string") {
        out.push({ kind: "assistantChunk", text: content.text });
      }
      break;
    }
    case "user_message_chunk": {
      // Emitted when replaying a loaded session's history (session/load).
      const content = isRecord(update.content) ? update.content : {};
      if (typeof content.text === "string") {
        out.push({ kind: "userMessage", text: content.text });
      }
      break;
    }
    case "agent_thought_chunk": {
      // The model is reasoning before producing a visible reply.
      out.push({ kind: "thinking" });
      break;
    }
    case "tool_call": {
      out.push({
        kind: "toolCall",
        toolCallId: String(update.toolCallId ?? ""),
        title: String(update.title ?? "Tool"),
        toolKind: update.kind ? String(update.kind) : undefined,
        paths: extractPaths(update.locations),
        startLine: extractStartLine(update.locations),
        diff: extractDiff(update.content),
      });
      break;
    }
    case "tool_call_update": {
      out.push({
        kind: "toolUpdate",
        toolCallId: String(update.toolCallId ?? ""),
        status: String(update.status ?? ""),
        output: extractToolOutput(update.rawOutput),
        diff: extractDiff(update.content),
        startLine: extractStartLine(update.locations),
      });
      break;
    }
    case "available_commands_update": {
      out.push({
        kind: "availableCommands",
        commands: extractCommands(update.availableCommands),
      });
      break;
    }
    case "config_option_update": {
      out.push({
        kind: "configOptions",
        options: extractConfigOptions(update.configOptions),
      });
      break;
    }
    case "session_info_update": {
      out.push(...mapSessionInfo(update));
      break;
    }
    default:
      break;
  }
  return out;
}

/** v3 session_info_update carries many sub-kinds under _meta.kiro.kind. */
function mapSessionInfo(update: Record<string, unknown>): ChatEvent[] {
  const out: ChatEvent[] = [];
  const meta = isRecord(update._meta) ? update._meta : {};
  const kiro = isRecord(meta.kiro) ? meta.kiro : {};
  const kind = String(kiro.kind ?? "");

  if (kind === "context_usage") {
    const cu = isRecord(kiro.contextUsage) ? kiro.contextUsage : {};
    const pct =
      typeof cu.usagePercentage === "number"
        ? cu.usagePercentage
        : typeof kiro.usagePercentage === "number"
          ? kiro.usagePercentage
          : undefined;
    if (typeof pct === "number") {
      const breakdown = isRecord(kiro.breakdown) ? kiro.breakdown : undefined;
      let usedTokens: number | undefined;
      if (breakdown) {
        usedTokens = Object.values(breakdown).reduce<number>((sum, v) => {
          const t = isRecord(v) ? Number(v.tokens ?? 0) : 0;
          return sum + (Number.isFinite(t) ? t : 0);
        }, 0);
      }
      const threshold =
        typeof cu.summarizationThreshold === "number" ? cu.summarizationThreshold : undefined;
      out.push({ kind: "contextUsage", usagePercentage: pct, usedTokens, threshold });
    }
  }
  if (kind === "user_message_id_assigned" && typeof kiro.userMessageId === "string") {
    out.push({ kind: "userMessageId", messageId: kiro.userMessageId });
  }
  if (kind === "turn_completion") {
    out.push({
      kind: "turnCompletion",
      elapsedMs: typeof kiro.elapsedTime === "number" ? kiro.elapsedTime : undefined,
      requestIds: Array.isArray(kiro.requestIds) ? kiro.requestIds.map((r) => String(r)) : [],
      status: typeof kiro.status === "string" ? kiro.status : undefined,
    });
  }
  if (kind === "turn_completion") {
    const summaries = kiro.promptTurnSummaries;
    if (Array.isArray(summaries)) {
      const credits = summaries
        .filter((s) => isRecord(s) && s.unit === "credit")
        .reduce((sum, s) => sum + Number((s as Record<string, unknown>).usage ?? 0), 0);
      if (credits > 0) {
        out.push({ kind: "metering", credits });
      }
    }
  }
  if (kind === "pending_interaction" && kiro.interactionType === "tool_approval") {
    out.push({ kind: "approvalRequest", request: extractApproval(kiro) });
  }
  return out;
}

function extractApproval(kiro: Record<string, unknown>): ApprovalRequest {
  const options = Array.isArray(kiro.options) ? kiro.options : [];
  return {
    toolCallId: String(kiro.toolCallId ?? ""),
    question: String(kiro.question ?? "Approve tool?"),
    options: options.map((o) => {
      const r = isRecord(o) ? o : {};
      return {
        optionId: String(r.optionId ?? ""),
        name: String(r.name ?? ""),
        kind: String(r.kind ?? ""),
      };
    }),
  };
}

function extractPaths(locations: unknown): string[] | undefined {
  if (!Array.isArray(locations)) {
    return undefined;
  }
  const paths = locations
    .map((l) => (isRecord(l) ? String(l.path ?? "") : ""))
    .filter((p) => p.length > 0);
  return paths.length > 0 ? paths : undefined;
}

/** First 1-based line number reported in ACP tool locations, if any. */
function extractStartLine(locations: unknown): number | undefined {
  if (!Array.isArray(locations)) {
    return undefined;
  }
  for (const l of locations) {
    if (isRecord(l) && typeof l.line === "number" && l.line > 0) {
      return l.line;
    }
  }
  return undefined;
}

function extractDiff(content: unknown): ToolDiff | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const item of content) {
    if (isRecord(item) && item.type === "diff") {
      return {
        path: String(item.path ?? ""),
        oldText: item.oldText === null ? null : String(item.oldText ?? ""),
        newText: String(item.newText ?? ""),
      };
    }
  }
  return undefined;
}

function extractToolOutput(rawOutput: unknown): string | undefined {
  if (rawOutput === undefined || rawOutput === null) {
    return undefined;
  }
  if (typeof rawOutput === "string") {
    return rawOutput;
  }
  if (isRecord(rawOutput) && typeof rawOutput.message === "string") {
    return rawOutput.message;
  }
  try {
    return JSON.stringify(rawOutput);
  } catch {
    return undefined;
  }
}

function extractCommands(cmds: unknown): AvailableCommand[] {
  if (!Array.isArray(cmds)) {
    return [];
  }
  return cmds.map((c) => {
    const r = isRecord(c) ? c : {};
    const input = isRecord(r.input) ? r.input : undefined;
    const meta = isRecord(r._meta) ? r._meta : undefined;
    const kiro = meta && isRecord(meta.kiro) ? meta.kiro : undefined;
    return {
      name: String(r.name ?? ""),
      description: r.description ? String(r.description) : undefined,
      inputHint:
        input && typeof input.hint === "string" ? input.hint : undefined,
      type: kiro && typeof kiro.type === "string" ? kiro.type : undefined,
    };
  });
}

function extractConfigOptions(opts: unknown): ConfigOption[] {
  if (!Array.isArray(opts)) {
    return [];
  }
  return opts.map((o) => {
    const r = isRecord(o) ? o : {};
    return {
      id: String(r.id ?? ""),
      name: String(r.name ?? ""),
      category: r.category ? String(r.category) : undefined,
      type: String(r.type ?? "select"),
      currentValue: r.currentValue,
      options: Array.isArray(r.options)
        ? r.options.map((x) => {
            const xr = isRecord(x) ? x : {};
            const meta = isRecord(xr._meta) ? xr._meta : {};
            const kiro = isRecord(meta.kiro) ? meta.kiro : {};
            const effortLevels = Array.isArray(kiro.effortLevels)
              ? kiro.effortLevels.map((e) => String(e))
              : undefined;
            return {
              value: String(xr.value ?? ""),
              name: String(xr.name ?? ""),
              description: xr.description ? String(xr.description) : undefined,
              effortLevels,
              defaultEffortLevel: kiro.defaultEffortLevel
                ? String(kiro.defaultEffortLevel)
                : undefined,
            };
          })
        : undefined,
    };
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
