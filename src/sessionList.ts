// Choosing which saved sessions to offer for Resume. Shared by the webview
// chat and the terminal chat. Pure (no vscode import).

import * as path from "path";
import type { SessionSummary } from "./types";

/**
 * Normalize a folder path for comparison: resolve it, strip trailing slashes
 * and drop macOS's `/private` prefix (`/private/tmp` is `/tmp`).
 */
export function normalizePath(p: string | undefined): string {
  let s = path.resolve(String(p ?? "")).replace(/\/+$/, "") || "/";
  if (s.startsWith("/private/")) {
    s = s.slice("/private".length);
  }
  return s;
}

/**
 * Sessions to offer, newest first: those of this engine in this folder; if
 * none, those of this engine; if none, all. `excludeId` is the open session.
 */
export function pickSessions(
  sessions: SessionSummary[],
  engine: string | undefined,
  cwd: string,
  excludeId?: string
): SessionSummary[] {
  const folder = normalizePath(cwd);
  const others = sessions.filter((s) => s.sessionId !== excludeId);
  const sameBoth = others.filter((s) => s.source === engine && normalizePath(s.cwd) === folder);
  const sameEngine = others.filter((s) => s.source === engine);
  const list = sameBoth.length ? sameBoth : sameEngine.length ? sameEngine : others;
  return [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
