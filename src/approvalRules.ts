/**
 * "Always" rules for tool approvals, modelled on the kiro-cli TUI.
 *
 * The engine (v3) offers one "always allow" / "always deny" option. What the
 * rule covers is up to the client, sent back in the response's
 * `_meta.kiro.consent.resource`: an exact file/command, a command pattern
 * (`find *`), a folder (`src/**`, file changes only) or `*` (the entire tool).
 *
 * Pure functions with no dependencies, so the webview can use them too.
 */

export type RuleKind = "exact" | "pattern" | "folder" | "tool";

export const isRuleKind = (v: unknown): v is RuleKind =>
  v === "exact" || v === "pattern" || v === "folder" || v === "tool";

export interface FolderOffer {
  /** Suggested folder: the parent of the file being changed. */
  prefill: string;
  /** The file the folder must contain. */
  target: string;
  /** Workspace files are relative paths; outside files are absolute. */
  inWorkspace: boolean;
}

export interface ApprovalRule {
  kind: RuleKind;
  label: string;
  description: string;
  /** Rule resource for exact and pattern rules (`*` for the entire tool). */
  resource?: string;
  /** For folder rules: the folder to ask for. */
  folder?: FolderOffer;
}

export const isShell = (capability: string | undefined): boolean =>
  capability === "shell" || capability === "exec" || capability === "shell:exec";

/** Display names for tools, by engine capability. */
const TOOL_NAMES: Record<string, string> = {
  fs_read: "Read File",
  fs_write: "Write File",
  shell: "Run Command",
  web_fetch: "Web Fetch",
  web_search: "Web Search",
};

/** What "entire tool" covers, by capability. */
const WHOLE: Record<string, string> = {
  fs_read: "every file read",
  fs_write: "every file change",
  shell: "every command",
  web_fetch: "every web fetch",
  web_search: "every web search",
  mcp: "every MCP tool",
  subagent: "every subagent",
  skill: "every skill",
  power: "every power",
};

export function toolName(capability: string | undefined, fallback?: string): string | undefined {
  return (capability && TOOL_NAMES[isShell(capability) ? "shell" : capability]) || fallback || undefined;
}

/**
 * The command pattern for a shell rule: `cat src/a.ts` → `cat *`. The TUI
 * offers none for one-word commands; we do (`head` → `head *`), since the
 * engine's `head *` also matches a bare `head`. None for assignments or
 * sudo/doas/env, where the first word says nothing about what runs.
 */
export function shellPattern(command: string): string | undefined {
  const first = command.trim().split(/\s+/)[0] ?? "";
  if (!first || first === "*" || first.includes("=") || ["sudo", "doas", "env"].includes(first)) {
    return undefined;
  }
  return `${first} *`;
}

/** Shorten long resources for labels, as the TUI does (50 chars). */
export function truncate(s: string, max = 50): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max - 3).join("") + "…" : s;
}

// --- folder rules (file changes) ---

const GLOB = /[*?[\]{}!$]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b\u200e\u200f\u2028-\u202f\u2060-\u206f\ufeff]/;
const isAbsolute = (p: string): boolean => p.startsWith("/") || /^[A-Za-z]:\//.test(p);

/** Normalize slashes and `.` segments; undefined if the path uses `..`. */
export function normalizePath(p: string): string | undefined {
  let s = p.replace(/\\/g, "/");
  while (s.length > 1 && s.endsWith("/")) {
    s = s.slice(0, -1);
  }
  const abs = isAbsolute(s);
  const root = /^[A-Za-z]:\//.exec(s)?.[0] ?? (abs ? "/" : "");
  const parts: string[] = [];
  for (const seg of s.slice(root.length).split("/")) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      return undefined;
    }
    parts.push(seg);
  }
  return parts.length === 0 ? (abs ? root : ".") : root + parts.join("/");
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  if (i === -1) {
    return ".";
  }
  if (i === 0) {
    return "/";
  }
  const parent = p.slice(0, i);
  return /^[A-Za-z]:$/.test(parent) ? parent + "/" : parent;
}

function folderContains(folder: string, target: string): boolean {
  if (folder === ".") {
    return !isAbsolute(target);
  }
  if (folder === "/" || /^[A-Za-z]:\/?$/.test(folder)) {
    return target.startsWith(folder.endsWith("/") ? folder : folder + "/");
  }
  return target === folder || target.startsWith(folder + "/");
}

/** The "Allow a folder…" offer for a file change, if one makes sense. */
export function folderOffer(consent: {
  capability?: string;
  askType?: string;
  resource?: string;
  workspaceRoot?: string;
}): FolderOffer | undefined {
  if (consent.capability !== "fs_write" || consent.askType === "explicit") {
    return undefined;
  }
  const file = consent.resource ?? "";
  if (!file.trim() || file === "*" || GLOB.test(file)) {
    return undefined;
  }
  const inWorkspace = !!consent.workspaceRoot?.trim();
  if (inWorkspace && isAbsolute(file.replace(/\\/g, "/"))) {
    return undefined;
  }
  const target = normalizePath(file);
  if (target === undefined) {
    return undefined;
  }
  const prefill = parentOf(target);
  // A file at the workspace root: the folder would be the whole workspace.
  return prefill === "." ? undefined : { prefill, target, inWorkspace };
}

export type FolderCheck = { ok: true; path: string } | { ok: false; reason: string };

/** Check a folder typed for a folder rule (same rules as the TUI). */
export function checkFolder(offer: FolderOffer, input: string): FolderCheck {
  const text = input.trim();
  if (!text) {
    return { ok: false, reason: "Type a folder path." };
  }
  if (CONTROL.test(text)) {
    return { ok: false, reason: "The folder contains unprintable characters." };
  }
  const path = normalizePath(text);
  if (path === undefined) {
    return { ok: false, reason: 'The folder cannot step up with "..".' };
  }
  if (path.startsWith("~")) {
    return { ok: false, reason: "Spell out the folder instead of using ~." };
  }
  if (path.startsWith("#")) {
    return { ok: false, reason: 'The folder cannot start with "#".' };
  }
  if (GLOB.test(path)) {
    return { ok: false, reason: "Type one folder, not a pattern; everything under it is included." };
  }
  if ((offer.inWorkspace || !isAbsolute(path)) && (isAbsolute(path) || path === ".")) {
    return {
      ok: false,
      reason: offer.inWorkspace
        ? "Type a folder inside the workspace, like src/MyPackage."
        : "Type the full path of the folder.",
    };
  }
  if (!folderContains(path, offer.target)) {
    return { ok: false, reason: `The folder must contain ${offer.target}.` };
  }
  return { ok: true, path };
}

/** Rule resource for a folder: the folder and everything under it. */
export const folderResource = (path: string): string => (path.endsWith("/") ? `${path}**` : `${path}/**`);

// --- rule lists ---

/**
 * The choices on the "Create allow/deny rule" screen, in the TUI's order:
 * exact match, command pattern (shell), folder (file changes, allow only),
 * entire tool.
 */
export function buildRules(
  effect: "allow" | "deny",
  consent: { capability: string; resource?: string; askType?: string; workspaceRoot?: string },
  tool?: string
): ApprovalRule[] {
  const verb = effect === "allow" ? "Trust" : "Deny";
  const scope = "session";
  const rules: ApprovalRule[] = [];
  const res = consent.resource;
  if (res && res !== "*") {
    rules.push({ kind: "exact", label: `${verb} "${truncate(res)}"`, description: `exact match · ${scope}`, resource: res });
  }
  const pattern = res && isShell(consent.capability) ? shellPattern(res) : undefined;
  if (pattern && pattern !== res) {
    rules.push({ kind: "pattern", label: `${verb} "${pattern}"`, description: `pattern · ${scope}`, resource: pattern });
  }
  const folder = effect === "allow" ? folderOffer(consent) : undefined;
  if (folder) {
    rules.push({
      kind: "folder",
      label: "Allow a folder for this session…",
      description: `${truncate(folder.prefill)} · ${scope}`,
      folder,
    });
  }
  const whole = WHOLE[isShell(consent.capability) ? "shell" : consent.capability] ?? "every use";
  rules.push({
    kind: "tool",
    label: `${verb} entire tool${tool ? ` (${tool})` : ""}`,
    description: `${whole} · ${scope}`,
    resource: "*",
  });
  return rules;
}

/** Longest deny reason sent to the engine (TUI limit). */
export const MAX_REASON = 1000;

export function cleanReason(text: string | undefined): string | undefined {
  const t = (text ?? "").trim();
  return t ? t.slice(0, MAX_REASON).trimEnd() : undefined;
}
