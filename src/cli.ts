// Locating the kiro-cli binary and running short-lived helper commands
// (whoami, --list-models, --help, health checks). Node-only; no vscode import.

import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Candidate locations checked when no explicit path is configured. */
export function candidateCliPaths(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin", "kiro-cli"),
    "/usr/local/bin/kiro-cli",
    "/opt/homebrew/bin/kiro-cli",
  ];
}

/**
 * Resolve the kiro-cli path. If `configured` is set and exists, use it.
 * Otherwise try `kiro-cli` on PATH, then well-known locations.
 * Returns undefined if nothing is found.
 */
export function resolveCliPath(configured?: string): string | undefined {
  if (configured && configured.trim().length > 0) {
    return configured.trim();
  }
  // Try PATH via `command -v`.
  const onPath = spawnSync("bash", ["-lc", "command -v kiro-cli"], {
    encoding: "utf8",
  });
  if (onPath.status === 0) {
    const p = onPath.stdout.trim();
    if (p.length > 0) {
      return p;
    }
  }
  for (const c of candidateCliPaths()) {
    if (existsSync(c)) {
      return c;
    }
  }
  return undefined;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a kiro-cli command to completion with an optional stdin payload and a
 * timeout. Used for quick, non-interactive helper calls.
 */
export function runCli(
  cliPath: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ?? sanitizedEnv(),
      cwd: opts.cwd,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ code, stdout, stderr });
    };

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          finish(null);
        }, opts.timeoutMs)
      : undefined;

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => finish(null));
    child.on("exit", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      finish(code);
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

/**
 * Build an environment that excludes the AVX-dependent bundled Bun inside the
 * Kiro app bundles from PATH, so nothing AVX-only is ever invoked.
 */
export function sanitizedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  const path = env.PATH ?? "";
  const filtered = path
    .split(":")
    .filter((seg) => !/Kiro( CLI)?\.app\/Contents/i.test(seg))
    .join(":");
  env.PATH = filtered;
  return env;
}
