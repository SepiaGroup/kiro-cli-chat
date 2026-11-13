// Tool calls in the terminal chat, terminal-style: "● title" with paths, a
// line-numbered diff for edits, and "– Completed in 1.2s" / "– Failed".
// Pure (no vscode import): it returns the text to print.

import { formatElapsed } from "../format";
import type { ChatEvent, ToolDiff } from "../types";
import { diffLines } from "../webview/lineDiff";
import { sanitize, style, truncate } from "./ansi";

const MAX_DIFF_LINES = 60;
const MAX_FAILED_OUTPUT_LINES = 8;

interface ToolState {
  title: string;
  started: number;
  diffShown: boolean;
  done: boolean;
}

export class ToolLog {
  private readonly tools = new Map<string, ToolState>();
  private lastToolId?: string;

  constructor(private readonly now: () => number = Date.now) {}

  /** A new turn: forget the previous turn's tools. */
  reset(): void {
    this.tools.clear();
    this.lastToolId = undefined;
  }

  /** Lines for a new tool call. `title` is the sanitized title (for the transcript). */
  start(ev: Extract<ChatEvent, { kind: "toolCall" }>): { title: string; text: string } {
    const title = sanitize(ev.title || "Tool");
    this.tools.set(ev.toolCallId, { title, started: this.now(), diffShown: false, done: false });
    this.lastToolId = ev.toolCallId;
    const paths = (ev.paths ?? []).map(sanitize);
    let text = style.yellow("●") + " " + highlightPaths(title, paths);
    const extra = paths.filter((p) => !title.includes(p));
    if (extra.length > 0) {
      text += "\n  " + extra.map((p) => style.magenta(p)).join(style.gray(", "));
    }
    const diff = ev.diff ? this.diff(ev.toolCallId, ev.diff, ev.startLine) : undefined;
    return { title, text: diff ? text + "\n" + diff : text };
  }

  /**
   * Lines for a tool update: a diff not shown yet, and/or the final status
   * (only once, when the tool completes or fails).
   */
  update(ev: Extract<ChatEvent, { kind: "toolUpdate" }>): { diff?: string; status?: string } {
    const tool = this.tools.get(ev.toolCallId);
    const out: { diff?: string; status?: string } = {};
    if (ev.diff && tool && !tool.diffShown) {
      out.diff = this.diff(ev.toolCallId, ev.diff, ev.startLine);
    }
    const s = (ev.status ?? "").toLowerCase();
    const ok = s === "completed" || s === "success";
    const failed = s === "failed" || s === "error";
    if ((!ok && !failed) || tool?.done) {
      return out;
    }
    // Name the tool if other tools ran since it started.
    const label = tool && this.lastToolId !== ev.toolCallId ? `${truncate(tool.title, 50)} ` : "";
    if (ok) {
      const elapsed = tool ? ` in ${formatElapsed(this.now() - tool.started)}` : "";
      out.status = style.gray(`  – ${label}${label ? "completed" : "Completed"}${elapsed}`);
    } else {
      let text = style.red(`  – ${label}${label ? "failed" : "Failed"}`);
      const outText = sanitize(ev.output ?? "").trim();
      if (outText) {
        const lines = outText.split("\n");
        text += "\n" + lines.slice(0, MAX_FAILED_OUTPUT_LINES).map((l) => style.red("    " + l)).join("\n");
        if (lines.length > MAX_FAILED_OUTPUT_LINES) {
          text += "\n" + style.gray(`    … ${lines.length - MAX_FAILED_OUTPUT_LINES} more lines`);
        }
      }
      out.status = text;
    }
    if (tool) {
      tool.done = true;
    }
    return out;
  }

  private diff(toolCallId: string, diff: ToolDiff, startLine?: number): string | undefined {
    const text = diffText(diff, startLine);
    const tool = this.tools.get(toolCallId);
    if (text !== undefined && tool) {
      tool.diffShown = true;
    }
    return text;
  }
}

/** A colored, line-numbered diff; undefined if there's no new text. */
export function diffText(diff: ToolDiff, startLine?: number): string | undefined {
  if (typeof diff.newText !== "string") {
    return undefined;
  }
  const lines = diffLines(diff.oldText ?? null, diff.newText);
  // Edits report snippets; shift numbers to real file lines when known.
  const offset = diff.oldText && startLine ? startLine - 1 : 0;
  const shown = lines.slice(0, MAX_DIFF_LINES);
  const rows = shown.map((l) => {
    if (l.kind === "gap") {
      return style.gray("       ⋮");
    }
    const num = l.lineNo !== undefined ? String(l.lineNo + offset) : "";
    const text = sanitize(l.text);
    if (l.kind === "add") {
      return style.green(`  + ${num.padStart(4)}: ${text}`);
    }
    if (l.kind === "del") {
      return style.red(`  - ${num.padStart(4)}: ${text}`);
    }
    return style.gray(`    ${num.padStart(4)}:`) + " " + text;
  });
  if (lines.length > shown.length) {
    rows.push(style.gray(`  … ${lines.length - shown.length} more lines`));
  }
  return rows.join("\n");
}

/** The title with known file paths in magenta. */
export function highlightPaths(title: string, paths: string[]): string {
  const sorted = [...paths].filter(Boolean).sort((a, b) => b.length - a.length);
  let out = "";
  let rest = title;
  while (rest.length > 0) {
    let idx = -1;
    let hit = "";
    for (const p of sorted) {
      const i = rest.indexOf(p);
      if (i >= 0 && (idx < 0 || i < idx)) {
        idx = i;
        hit = p;
      }
    }
    if (idx < 0) {
      out += rest;
      break;
    }
    out += rest.slice(0, idx) + style.magenta(hit);
    rest = rest.slice(idx + hit.length);
  }
  return out;
}
