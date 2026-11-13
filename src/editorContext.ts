// Which editor files the agent is told about (the open tabs and the active
// one). Pure: the vscode side hands in raw paths. Only paths go to the engine,
// never contents, and only for files inside the chat's folder. They travel as
// a `resource` block in the prompt, which the engine shows the model as a
// context item (the engine's own `_kiro/workspace/*` requests are only used
// for `#[[currentlyOpenFiles:…]]` mentions in agent prompts, never for a chat).

import { isAbsolute, relative } from "path";

/** Most open files reported; the engine only needs a hint, not every tab. */
export const MAX_OPEN_FILES = 50;

export interface EditorSnapshot {
  active?: string;
  open: string[];
}

function inside(cwd: string, file: string): boolean {
  if (!isAbsolute(file)) {
    return false;
  }
  const rel = relative(cwd, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function pickEditorContext(raw: EditorSnapshot, cwd: string): EditorSnapshot {
  const open = [...new Set(raw.open.filter((f) => inside(cwd, f)))].slice(0, MAX_OPEN_FILES);
  const active = raw.active && inside(cwd, raw.active) ? raw.active : undefined;
  return { active, open };
}

/** The context item's text, or undefined when there is nothing to say. Paths are relative to `cwd`. */
export function editorContextText(snap: EditorSnapshot, cwd: string): string | undefined {
  if (!snap.active && snap.open.length === 0) {
    return undefined;
  }
  const rel = (f: string): string => relative(cwd, f);
  const lines = ["Editor context from the user's VS Code (paths relative to the workspace folder). It is current; an engine note saying no files are open can't see the editor."];
  lines.push(`Active file: ${snap.active ? rel(snap.active) : "none"}`);
  if (snap.open.length) {
    lines.push("Open files:", ...snap.open.map((f) => `- ${rel(f)}`));
  }
  return lines.join("\n");
}

/** One line for the chat saying what was sent. */
export function editorContextNotice(snap: EditorSnapshot, cwd: string): string {
  const n = snap.open.length;
  const active = snap.active ? `active ${relative(cwd, snap.active)}, ` : "";
  return `Sent editor context: ${active}${n} open file${n === 1 ? "" : "s"}.`;
}
