// Slash commands of the terminal chat (mirrors kiro-cli's set) and the
// "type / for help" menu logic. Pure (no vscode import) so it can be tested.

export interface SubSpec {
  name: string;
  /** Usage of the rest of the line after the subcommand, e.g. "<path>". */
  args?: string;
  desc: string;
}

/** Keys for values that come from the engine at runtime. */
export type ValueSource = "model" | "effort" | "agent" | "configId" | "prompt";

export interface CommandSpec {
  name: string;
  /** Usage after the name, e.g. "[n]" or "<task>". */
  args?: string;
  desc: string;
  subs?: SubSpec[];
  values?: ValueSource;
  aliases?: string[];
  /** Exists in kiro-cli but can't work here; the reason is shown instead. */
  unavailable?: string;
}

export const COMMANDS: CommandSpec[] = [
  // Conversation
  { name: "help", desc: "Show commands and keys" },
  { name: "clear", desc: "Clear the conversation and start fresh" },
  { name: "new", desc: "Start a new conversation" },
  {
    name: "chat",
    desc: "New, save or load a conversation",
    subs: [
      { name: "new", desc: "Start a fresh conversation" },
      { name: "save", args: "[file]", desc: "Save the transcript as Markdown" },
      { name: "load", desc: "Resume a saved session (same as /resume)" },
    ],
  },
  { name: "resume", args: "[n]", desc: "List recent sessions, or resume #n" },
  { name: "rewind", args: "[n]", desc: "Go back to an earlier message (undoes later file changes)" },
  { name: "compact", desc: "Summarize the conversation to free context space" },
  { name: "title", args: "[text|clear]", desc: "Show, set or clear the session/terminal title" },
  { name: "transcript", desc: "Open or save the conversation transcript", subs: [
    { name: "show", desc: "Open the transcript in an editor tab" },
    { name: "save", args: "[file]", desc: "Save the transcript as Markdown" },
  ] },
  { name: "copy", desc: "Copy the last reply to the clipboard" },
  { name: "editor", desc: "Write a prompt in an editor tab (close the tab to use it)" },
  { name: "reply", desc: "Reply in an editor tab with the last answer quoted" },
  { name: "paste", desc: "Attach the clipboard image to your next message" },
  { name: "spawn", args: "<task>", desc: "Run a task in a new Kiro Chat terminal" },

  // Context
  {
    name: "context",
    desc: "Show context usage, or manage context files",
    subs: [
      { name: "show", desc: "Show what's using the context window" },
      { name: "add", args: "<path|glob>", desc: "Add files to the context" },
      { name: "remove", args: "<path>", desc: "Remove a context entry" },
      { name: "clear", desc: "Remove all context entries" },
    ],
  },
  {
    name: "knowledge",
    desc: "Manage the knowledge base",
    subs: [
      { name: "show", desc: "List knowledge entries" },
      { name: "add", args: "<name> <path>", desc: "Index a folder or file" },
      { name: "remove", args: "<name|path>", desc: "Remove an entry" },
      { name: "update", args: "<path>", desc: "Re-index an entry" },
      { name: "clear", desc: "Remove all entries" },
      { name: "cancel", args: "[operation-id]", desc: "Cancel indexing" },
    ],
  },

  // Model & agent
  { name: "model", args: "[name]", desc: "Show or switch the model", values: "model" },
  { name: "effort", args: "[level]", desc: "Show or set reasoning effort", values: "effort" },
  {
    name: "agent",
    args: "[name]",
    desc: "Show or switch the agent",
    values: "agent",
    subs: [
      { name: "list", desc: "List agents" },
      { name: "create", args: "<name>", desc: "Create an agent config (opens in VS Code)" },
      { name: "edit", args: "<name>", desc: "Edit an agent config (opens in VS Code)" },
    ],
  },
  { name: "plan", desc: "Switch to the Plan agent (again to switch back)" },
  { name: "prompts", args: "[name]", desc: "List or run prompts", values: "prompt" },

  // Tools
  {
    name: "tools",
    desc: "Show tools and permissions",
    subs: [
      { name: "trust-all", desc: "Run all tools without asking (Autopilot)" },
      { name: "reset", desc: "Ask before changes again (Supervised)" },
    ],
  },
  {
    name: "autopilot",
    desc: "Run tools without asking, or Supervised",
    subs: [
      { name: "on", desc: "Tools run without asking" },
      { name: "off", desc: "Ask before changes (Supervised)" },
    ],
  },
  { name: "mcp", desc: "Show MCP servers" },
  { name: "hooks", desc: "Show hooks" },
  {
    name: "code",
    desc: "Code intelligence",
    subs: [
      { name: "status", desc: "Show code intelligence status" },
      { name: "init", desc: "Set up code intelligence for this workspace" },
      { name: "overview", desc: "Show a workspace overview" },
    ],
  },

  // Settings & info
  { name: "config", desc: "Show session settings" },
  { name: "set", args: "<id> <value>", desc: "Change a session setting", values: "configId" },
  { name: "usage", desc: "Show plan, credits and limits" },
  { name: "stats", desc: "Show request IDs and timings of recent turns" },
  { name: "changelog", args: "[all|version]", desc: "Show Kiro CLI release notes" },
  { name: "settings", desc: "Open the extension's settings" },
  { name: "theme", desc: "Pick a color theme (VS Code's)" },

  // Terminal
  { name: "restart", desc: "Restart the engine" },
  { name: "login", desc: "Log in to Kiro CLI" },
  { name: "cls", desc: "Clear the screen" },
  { name: "quit", desc: "Close this chat", aliases: ["exit", "q"] },

  // In kiro-cli, but not possible here.
  { name: "guide", desc: "Guide agent", unavailable: "The engine doesn't include the guide agent. Type /help for commands." },
  { name: "goal", args: "<goal>", desc: "Iterate toward a goal", unavailable: "Goals aren't enabled for this kind of engine connection." },
  { name: "voice", desc: "Voice input", unavailable: "Voice input needs the kiro-cli terminal app, which can't run on this Mac." },
];

export function findCommand(name: string, commands: CommandSpec[] = COMMANDS): CommandSpec | undefined {
  const n = name.toLowerCase();
  return commands.find((c) => c.name === n || c.aliases?.includes(n));
}

/** Split arguments, honoring 'single' / "double" quotes and backslash escapes. */
export function tokenize(arg: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|((?:\\.|[^\s'"])+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arg)) !== null) {
    out.push(m[1] ?? m[2] ?? (m[3] ?? "").replace(/\\(.)/g, "$1"));
  }
  return out;
}

// --- menu ---

export interface Suggestion {
  /** What's shown (e.g. "/context" or "add"). */
  label: string;
  /** Full input text after accepting it. */
  insert: string;
  desc?: string;
  /** Enter runs it right away (nothing required is left to type). */
  submit: boolean;
}

export interface Menu {
  items: Suggestion[];
  /** Usage line when there's nothing to pick from (e.g. "<task>"). */
  hint?: string;
}

export interface MenuValue {
  value: string;
  desc?: string;
}

/** Commands from the engine (agent commands, prompts, skills). */
export interface EngineCommand {
  name: string;
  description?: string;
}

/**
 * The slash menu for `input`, or undefined when there's nothing to show.
 * `values(source)` supplies runtime values (model names, agents, …).
 */
export function slashMenu(
  input: string,
  engineCommands: EngineCommand[],
  values: (source: ValueSource) => MenuValue[],
  commands: CommandSpec[] = COMMANDS
): Menu | undefined {
  if (!input.startsWith("/") || input.includes("\n")) {
    return undefined;
  }

  // 1) Typing the command name.
  const nameOnly = /^\/(\S*)$/.exec(input);
  if (nameOnly) {
    const q = nameOnly[1].toLowerCase();
    const all: Suggestion[] = [];
    for (const c of commands) {
      all.push({
        label: "/" + c.name,
        insert: "/" + c.name + (takesArgs(c) ? " " : ""),
        desc: c.unavailable ? `${c.desc} (not available here)` : c.desc,
        submit: !isRequired(c.args),
      });
    }
    for (const c of engineCommands) {
      if (!findCommand(c.name, commands)) {
        all.push({ label: "/" + c.name, insert: "/" + c.name + " ", desc: c.description, submit: true });
      }
    }
    const items = rank(all, q, (s) => s.label.slice(1));
    return items.length > 0 ? { items } : undefined;
  }

  const m = /^\/(\S+)\s+([\s\S]*)$/.exec(input);
  if (!m) {
    return undefined;
  }
  const spec = findCommand(m[1], commands);
  if (!spec) {
    const engine = engineCommands.find((c) => c.name.toLowerCase() === m[1].toLowerCase());
    return engine?.description ? { items: [], hint: `/${engine.name} – ${engine.description}` } : undefined;
  }
  const rest = m[2];
  const usage = `/${spec.name}${spec.args ? " " + spec.args : ""}`;

  // 2) Typing the first argument: offer subcommands and runtime values.
  if (!/\s/.test(rest)) {
    const options: Suggestion[] = [];
    for (const s of spec.subs ?? []) {
      options.push({
        label: s.name,
        insert: `/${m[1]} ${s.name}${s.args ? " " : ""}`,
        desc: s.args ? `${s.args}  ${s.desc}` : s.desc,
        submit: !isRequired(s.args),
      });
    }
    if (spec.values) {
      for (const v of values(spec.values)) {
        if (!options.some((o) => o.label === v.value)) {
          const more = spec.values === "configId";
          options.push({ label: v.value, insert: `/${m[1]} ${v.value}${more ? " " : ""}`, desc: v.desc, submit: !more });
        }
      }
    }
    const items = rank(options, rest.toLowerCase(), (s) => s.label);
    if (items.length > 0) {
      return { items };
    }
    return spec.args || spec.subs ? { items: [], hint: `${usage}  ${spec.desc}` } : undefined;
  }

  // 3) Further arguments: show the usage of the chosen subcommand.
  const first = rest.split(/\s+/)[0].toLowerCase();
  const sub = spec.subs?.find((s) => s.name === first);
  if (sub?.args) {
    return { items: [], hint: `/${spec.name} ${sub.name} ${sub.args}  ${sub.desc}` };
  }
  return spec.args ? { items: [], hint: `${usage}  ${spec.desc}` } : undefined;
}

/** "<x>" is required; "[x]" (or nothing) is optional. */
function isRequired(args: string | undefined): boolean {
  return Boolean(args && args.startsWith("<"));
}

function takesArgs(c: CommandSpec): boolean {
  return Boolean(c.args || c.subs || c.values);
}

/** Exact match first, then prefix matches (alphabetical), then substring matches. */
function rank(items: Suggestion[], q: string, key: (s: Suggestion) => string): Suggestion[] {
  if (!q) {
    return [...items].sort((a, b) => key(a).localeCompare(key(b)));
  }
  const k = (s: Suggestion) => key(s).toLowerCase();
  const exact = items.filter((s) => k(s) === q);
  const prefix = items.filter((s) => k(s) !== q && k(s).startsWith(q)).sort((a, b) => k(a).localeCompare(k(b)));
  const inner = items.filter((s) => !k(s).startsWith(q) && k(s).includes(q)).sort((a, b) => k(a).localeCompare(k(b)));
  return [...exact, ...prefix, ...inner];
}
