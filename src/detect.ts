// Auth, engine detection, and model listing. Node-only; no vscode import.

import { runCli } from "./cli";
import { AuthStatus, EngineVersion, ModelInfo, SessionSummary } from "./types";

/** Check login status via `whoami`. Logged in when exit 0 and non-empty output. */
export async function checkAuth(cliPath: string): Promise<AuthStatus> {
  const res = await runCli(cliPath, ["whoami", "--format", "json"], {
    timeoutMs: 15000,
  });
  if (res.code === 0 && res.stdout.trim().length > 0) {
    let identity: string | undefined;
    try {
      const parsed = JSON.parse(res.stdout);
      identity =
        parsed?.email ?? parsed?.account ?? parsed?.startUrl ?? undefined;
    } catch {
      identity = res.stdout.trim().split("\n")[0];
    }
    return { loggedIn: true, identity, raw: res.stdout.trim() };
  }
  // Fall back to plain format (older CLIs may not support json for whoami).
  const plain = await runCli(cliPath, ["whoami"], { timeoutMs: 15000 });
  const loggedIn =
    plain.code === 0 && /logged in/i.test(plain.stdout + plain.stderr);
  return {
    loggedIn,
    identity: loggedIn ? plain.stdout.trim().split("\n")[0] : undefined,
    raw: (plain.stdout || plain.stderr).trim(),
  };
}

/**
 * Enumerate the engine versions the CLI advertises by parsing
 * `chat --help` (looks for `[possible values: v2, v1, v3]`).
 * Falls back to the known set if parsing fails.
 */
export async function listEngines(cliPath: string): Promise<EngineVersion[]> {
  const res = await runCli(cliPath, ["chat", "--help"], { timeoutMs: 15000 });
  const text = res.stdout + res.stderr;
  // The help text has multiple "possible values:" lines (e.g. --session-source
  // lists only v1,v2). Scan ALL of them and union any engine tokens, so we
  // don't accidentally match a non-engine option and miss v3.
  const found = new Set<EngineVersion>();
  const re = /possible values:\s*([a-z0-9.,\s-]+)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    for (const tok of m[1].split(",")) {
      const t = tok.trim();
      if (t === "v1" || t === "v2" || t === "v3") {
        found.add(t);
      }
    }
  }
  if (found.size === 0) {
    return ["v3", "v2", "v1"];
  }
  return [...found].sort(compareEngineDesc);
}

/** Sort engine ids newest-first (v3 > v2 > v1). */
export function compareEngineDesc(a: EngineVersion, b: EngineVersion): number {
  return engineNum(b) - engineNum(a);
}

function engineNum(e: EngineVersion): number {
  return parseInt(e.slice(1), 10);
}

/**
 * Quick, zero-cost headless health check: does the binary start and run far
 * enough to emit structured output without crashing (e.g. SIGILL on non-AVX)?
 *
 * We send EMPTY input. A healthy engine runs far enough to emit a structured
 * `runError` ("Input must be supplied ...") — which proves it executed and did
 * not crash, and costs no model credits. A real SIGILL crash dies by signal
 * with no JSON output at all. So "emitted any JSON event" == healthy.
 */
export async function engineHealthy(
  cliPath: string,
  engine: EngineVersion
): Promise<boolean> {
  // v1 does not support stream-json; probe a plain no-op run instead.
  if (engine === "v1") {
    const r = await runCli(
      cliPath,
      ["chat", "--agent-engine", "v1", "--no-interactive"],
      { input: "", timeoutMs: 45000 }
    );
    // Healthy if it produced any output / exited cleanly (not a signal crash).
    return r.code !== null;
  }

  const res = await runCli(
    cliPath,
    [
      "chat",
      "--agent-engine",
      engine,
      "--output-format",
      "stream-json",
      "--no-interactive",
    ],
    { input: "", timeoutMs: 60000 }
  );
  // Any structured event (runStarted/runError/metadata) proves the binary ran.
  // A SIGILL crash produces no such output.
  return /"type"\s*:\s*"(runStarted|runError|metadata)"/.test(res.stdout);
}

/**
 * Resolve the engine to use given the setting. For "auto", probe engines
 * newest-first and return the first healthy one.
 */
export async function resolveEngine(
  cliPath: string,
  setting: "auto" | EngineVersion,
  log: (msg: string) => void = () => {}
): Promise<EngineVersion> {
  if (setting !== "auto") {
    return setting;
  }
  // Health checks start engine processes; do them once per binary, shared by
  // every chat tab and terminal.
  const cached = autoEngines.get(cliPath);
  if (cached) {
    log(`Using engine ${cached} (detected earlier).`);
    return cached;
  }
  const engines = await listEngines(cliPath);
  for (const e of engines) {
    log(`Health-checking engine ${e}...`);
    if (await engineHealthy(cliPath, e)) {
      log(`Selected engine ${e}.`);
      autoEngines.set(cliPath, e);
      return e;
    }
    log(`Engine ${e} failed health check; trying next.`);
  }
  throw new Error(
    `No Kiro engine runs on this machine (tried ${engines.join(", ")}). ` +
      `Check that "${cliPath} chat --agent-engine v3" works, and see the Kiro CLI Chat output for details.`
  );
}

const autoEngines = new Map<string, EngineVersion>();

/** Forget detected engines (e.g. after kiro-cli was updated). */
export function resetEngineCache(): void {
  autoEngines.clear();
}

/** List available models via `chat --list-models --format json`. */
export async function listModels(cliPath: string): Promise<ModelInfo[]> {
  const res = await runCli(
    cliPath,
    ["chat", "--list-models", "--format", "json"],
    { timeoutMs: 15000 }
  );
  if (res.code !== 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(res.stdout);
    const arr = Array.isArray(parsed) ? parsed : parsed?.models ?? [];
    return arr.map((m: Record<string, unknown>) => ({
      id: String(m.id ?? m.model ?? m.name ?? ""),
      name: m.name as string | undefined,
      description: m.description as string | undefined,
      default: Boolean(m.default),
    }));
  } catch {
    return [];
  }
}

/** List saved sessions via `chat --list-sessions --format json`. */
export async function listSessions(
  cliPath: string,
  cwd?: string,
  log?: (msg: string) => void
): Promise<SessionSummary[]> {
  const res = await runCli(
    cliPath,
    ["chat", "--list-sessions", "--format", "json"],
    { timeoutMs: 20000, cwd }
  );
  log?.(
    `[listSessions] code=${String(res.code)} count~=${(res.stdout.match(/"sessionId"/g) ?? []).length}`
  );
  if (res.code !== 0) {
    log?.(`[listSessions] non-zero exit: ${res.stderr.slice(0, 200).replace(/\n/g, " ")}`);
    return [];
  }
  try {
    const parsed = JSON.parse(res.stdout);
    const groups = Array.isArray(parsed) ? parsed : [];
    const out: SessionSummary[] = [];
    for (const g of groups) {
      const gcwd = String(g.cwd ?? "");
      for (const s of g.sessions ?? []) {
        out.push({
          sessionId: String(s.sessionId),
          source: String(s.source ?? ""),
          title: String(s.title ?? ""),
          updatedAt: String(s.updatedAt ?? ""),
          messageCount: Number(s.messageCount ?? 0),
          cwd: gcwd,
        });
      }
    }
    return out;
  } catch (err) {
    log?.(
      `[listSessions] JSON parse failed: ${err instanceof Error ? err.message : String(err)}; ` +
        `stdout head: ${res.stdout.slice(0, 200)}`
    );
    return [];
  }
}
