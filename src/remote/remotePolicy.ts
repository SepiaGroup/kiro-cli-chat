// What a remote device may ask a chat to do, and in what shape. An allow-list:
// anything not listed is refused, and only the listed fields get through.
// Approving from a phone is running a command on the Mac, so a remote device
// gets Allow once, Deny and Deny with a reason, and no way to create rules,
// turn on Autopilot, restart the engine or open anything in VS Code.
// (The chat also refuses answers that are not once-only; see ChatSession.)
// Pure (no vscode import).

import { MAX_ANSWER, MAX_IMAGES, MAX_STEER, cleanAnswer, cleanSteer, sanitizeImages } from "../webviewInput";

export type Permission = "view" | "prompt" | "approve";
export const ALL_PERMISSIONS: readonly Permission[] = ["view", "prompt", "approve"];

export type RemoteMessage = { type: string; [k: string]: unknown };

export type PolicyResult =
  | { ok: true; msg: RemoteMessage }
  | { ok: false; status: 400 | 403 | 413; reason: string };

/** Longest prompt accepted from a remote device. */
export const MAX_REMOTE_PROMPT = 200_000;
/** Settings a remote device may change. */
export const REMOTE_CONFIG_IDS: readonly string[] = ["model", "effortLevel"];

const MAX_ID = 200;

/** The permissions in a setting value: unknown entries dropped, all of them when it is not a list. */
export function parsePermissions(raw: unknown): Permission[] {
  if (!Array.isArray(raw)) {
    return [...ALL_PERMISSIONS];
  }
  return ALL_PERMISSIONS.filter((p) => raw.includes(p));
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

export function checkRemoteMessage(raw: unknown, granted: readonly Permission[]): PolicyResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, reason: "not a message" };
  }
  const m = raw as Record<string, unknown>;
  const type = m.type;
  if (typeof type !== "string" || type.length > 40) {
    return { ok: false, status: 400, reason: "no message type" };
  }
  const need = (p: Permission): PolicyResult | undefined =>
    granted.includes(p) ? undefined : { ok: false, status: 403, reason: `this device may not ${verb(p)}` };
  const bad = (reason: string): PolicyResult => ({ ok: false, status: 400, reason });
  const pass = (msg: RemoteMessage): PolicyResult => ({ ok: true, msg });

  switch (type) {
    case "ready":
    case "getContextBreakdown":
      return need("view") ?? pass({ type });

    case "cancelTurn":
    case "compact":
      return need("prompt") ?? pass({ type });

    case "sendPrompt": {
      const denied = need("prompt");
      if (denied) {
        return denied;
      }
      if (typeof m.text !== "string") {
        return bad("no text");
      }
      if (m.text.length > MAX_REMOTE_PROMPT) {
        return { ok: false, status: 413, reason: "message too long" };
      }
      const images = sanitizeImages(m.images).slice(0, MAX_IMAGES);
      if (!m.text.trim() && images.length === 0) {
        return bad("empty message");
      }
      return pass({ type, text: m.text, images });
    }

    case "steerPrompt": {
      const denied = need("prompt");
      if (denied) {
        return denied;
      }
      const text = cleanSteer(m.text);
      return text ? pass({ type, text: text.slice(0, MAX_STEER) }) : bad("empty message");
    }

    case "answerQuestion": {
      const denied = need("prompt");
      if (denied) {
        return denied;
      }
      const toolCallId = str(m.toolCallId, MAX_ID);
      if (!toolCallId) {
        return bad("no question id");
      }
      const answer = cleanAnswer(m.answer);
      return pass({ type, toolCallId, ...(answer ? { answer: answer.slice(0, MAX_ANSWER) } : {}) });
    }

    case "setMode": {
      const denied = need("prompt");
      if (denied) {
        return denied;
      }
      const modeId = str(m.modeId, 100);
      return modeId ? pass({ type, modeId }) : bad("no mode");
    }

    case "setConfig": {
      const denied = need("prompt");
      if (denied) {
        return denied;
      }
      const id = str(m.id, 100);
      const value = str(m.value, 100);
      if (!id || !value) {
        return bad("no setting");
      }
      if (!REMOTE_CONFIG_IDS.includes(id)) {
        return { ok: false, status: 403, reason: `this device may not change ${id}` };
      }
      return pass({ type, id, value });
    }

    case "approve": {
      const denied = need("approve");
      if (denied) {
        return denied;
      }
      const toolCallId = str(m.toolCallId, MAX_ID);
      const optionId = str(m.optionId, 100);
      if (!toolCallId || !optionId) {
        return bad("no approval id");
      }
      // `rule` and `folder` are dropped on purpose: no allow or deny rules from a remote device.
      const reason = typeof m.reason === "string" ? m.reason.slice(0, 2000) : undefined;
      return pass({ type, toolCallId, optionId, ...(reason ? { reason } : {}) });
    }

    default:
      return { ok: false, status: 403, reason: `"${type.replace(/[^\w.-]/g, "?")}" is not allowed from a remote device` };
  }
}

function verb(p: Permission): string {
  return p === "view" ? "view chats" : p === "prompt" ? "send to the agent" : "answer approvals";
}
