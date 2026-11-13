// Puts the local remote-access server on the tailnet with `tailscale serve`
// (HTTPS, only devices on the user's tailnet can reach it) and takes it off
// again. Finds the CLI, reads `status --json`, builds the commands in one
// place and explains failures. The command runner is injected so the logic is
// tested without Tailscale. Pure apart from `nodeRun` (no vscode import).
//
// Facts checked against Tailscale 1.104.7 on macOS:
// - `tailscale serve --bg --https=8443 http://127.0.0.1:PORT` keeps the mapping
//   after the command returns; `tailscale serve --https=8443 off` removes it
//   (and fails with "handler does not exist" when there is none).
// - When Serve is not enabled on the tailnet the command prints an enable URL
//   (https://login.tailscale.com/f/serve?node=...) and then waits, so it must run
//   with a timeout.
// - `status --json` has BackendState, Self.DNSName (trailing dot) and CertDomains
//   (empty until HTTPS certificates are enabled for the tailnet).

import { execFile } from "child_process";

export interface RunResult {
  /** Exit code; null when the command was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Run = (cli: string, args: string[], timeoutMs: number) => Promise<RunResult>;

/** Where the CLI may be. A GUI-launched VS Code often has no /usr/local/bin on its PATH. */
export const CLI_CANDIDATES: readonly string[] = [
  "tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

/** HTTPS ports `tailscale serve` accepts. 8443 leaves 443 to whatever the user serves already. */
export const HTTPS_PORTS: readonly number[] = [443, 8443, 10000];
export const DEFAULT_HTTPS_PORT = 8443;

/** Run a command for real. Never rejects: a missing program is a result with code null. */
export const nodeRun: Run = (cli, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cli, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      resolve({
        code: e ? (typeof e.code === "number" ? e.code : null) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        timedOut: Boolean(e?.killed),
      });
    });
  });

/** The first candidate that answers `version`. */
export async function findCli(run: Run, candidates: readonly string[] = CLI_CANDIDATES): Promise<string | undefined> {
  for (const c of candidates) {
    const r = await run(c, ["version"], 5000);
    if (r.code === 0) {
      return c;
    }
  }
  return undefined;
}

export type TailscaleState =
  | { kind: "ready"; dnsName: string; certsEnabled: boolean }
  | { kind: "unavailable"; advice: string };

/** What `tailscale status --json` says about this machine. */
export function parseStatus(stdout: string): TailscaleState {
  let j: { BackendState?: unknown; Self?: { DNSName?: unknown }; CertDomains?: unknown };
  try {
    j = JSON.parse(stdout);
  } catch {
    return { kind: "unavailable", advice: "Could not read Tailscale's status. Open the Tailscale app and check that it is running." };
  }
  switch (j.BackendState) {
    case "Running":
      break;
    case "NeedsLogin":
    case "NeedsMachineAuth":
      return { kind: "unavailable", advice: "Tailscale is not logged in. Open the Tailscale app, log in, then start remote access again." };
    case "Stopped":
      return { kind: "unavailable", advice: "Tailscale is turned off. Turn it on in the Tailscale menu bar item, then start remote access again." };
    default:
      return { kind: "unavailable", advice: "Tailscale is not ready yet. Open the Tailscale app, wait until it says Connected, then start remote access again." };
  }
  const name = typeof j.Self?.DNSName === "string" ? j.Self.DNSName.replace(/\.$/, "").toLowerCase() : "";
  if (!name) {
    return { kind: "unavailable", advice: "This Mac has no Tailscale name. Turn on MagicDNS in the Tailscale admin console (DNS page)." };
  }
  return { kind: "ready", dnsName: name, certsEnabled: Array.isArray(j.CertDomains) && j.CertDomains.length > 0 };
}

export function serveArgs(localPort: number, httpsPort: number = DEFAULT_HTTPS_PORT): string[] {
  return ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`];
}

export function unserveArgs(httpsPort: number = DEFAULT_HTTPS_PORT): string[] {
  return ["serve", `--https=${httpsPort}`, "off"];
}

/** The address devices open (no trailing slash). */
export function baseUrl(dnsName: string, httpsPort: number = DEFAULT_HTTPS_PORT): string {
  return httpsPort === 443 ? `https://${dnsName}` : `https://${dnsName}:${httpsPort}`;
}

/** What is already served on `dnsName:httpsPort`, from `tailscale serve status --json`. */
export type ExistingServe = "none" | "loopbackProxy" | "other";

export function existingServe(statusJson: string, dnsName: string, httpsPort: number): ExistingServe {
  let j: { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>; TCP?: Record<string, unknown> };
  try {
    j = JSON.parse(statusJson);
  } catch {
    return "none";
  }
  const web = j.Web?.[`${dnsName}:${httpsPort}`];
  if (!web) {
    return j.TCP && String(httpsPort) in j.TCP ? "other" : "none";
  }
  const paths = Object.keys(web.Handlers ?? {});
  const proxy = web.Handlers?.["/"]?.Proxy;
  const ours = paths.length === 1 && typeof proxy === "string" && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(proxy);
  return ours ? "loopbackProxy" : "other";
}

export type ServeOutcome =
  | { ok: true }
  | { ok: false; advice: string; /** Where to switch Serve on, when Tailscale asked for it. */ enableUrl?: string };

/** What the output of `serve --bg ...` means. */
export function interpretServe(r: RunResult): ServeOutcome {
  const text = `${r.stdout}\n${r.stderr}`;
  const url = /https:\/\/login\.tailscale\.com\/\S+/.exec(text)?.[0];
  if (/not enabled on your tailnet/i.test(text) || (r.timedOut && url)) {
    return {
      ok: false,
      enableUrl: url,
      advice:
        "Tailscale Serve is not switched on for your tailnet. Open the link to enable it (this also covers HTTPS certificates), then start remote access again.",
    };
  }
  if (/https.*(not enabled|disabled)|certificate/i.test(text) && r.code !== 0) {
    return {
      ok: false,
      enableUrl: "https://login.tailscale.com/admin/dns",
      advice: "HTTPS certificates are not enabled for your tailnet. Turn on HTTPS Certificates on the DNS page of the Tailscale admin console, then start remote access again.",
    };
  }
  if (r.timedOut) {
    return { ok: false, advice: "Tailscale did not answer in time. Check that Tailscale is connected, then start remote access again." };
  }
  if (r.code !== 0) {
    const detail = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith("try `")) ?? "unknown error";
    return { ok: false, advice: `Tailscale could not share the port: ${detail.slice(0, 200)}` };
  }
  return { ok: true };
}

export type ExposeResult =
  | { ok: true; url: string }
  | { ok: false; advice: string; enableUrl?: string };

/** Shares the local port on the tailnet, and remembers that it did so it can take only that down. */
export class TailscaleServe {
  private cli?: string;
  private exposed?: { httpsPort: number };

  constructor(
    private readonly run: Run = nodeRun,
    private readonly log: (line: string) => void = () => undefined
  ) {}

  get active(): boolean {
    return this.exposed !== undefined;
  }

  async expose(localPort: number, httpsPort: number = DEFAULT_HTTPS_PORT): Promise<ExposeResult> {
    this.cli ??= await findCli(this.run);
    if (!this.cli) {
      return {
        ok: false,
        advice:
          "Tailscale is not installed on this Mac (no tailscale command found). Install it from tailscale.com/download, log in, then start remote access again.",
      };
    }
    const cli = this.cli;
    const status = parseStatus((await this.run(cli, ["status", "--json"], 8000)).stdout);
    if (status.kind === "unavailable") {
      return { ok: false, advice: status.advice };
    }
    const existing = existingServe((await this.run(cli, ["serve", "status", "--json"], 8000)).stdout, status.dnsName, httpsPort);
    if (existing === "other") {
      return {
        ok: false,
        advice: `Port ${httpsPort} is already used by one of your Tailscale Serve settings. Pick another with kiroCliChat.remote.httpsPort (443, 8443 or 10000).`,
      };
    }
    const r = await this.run(cli, serveArgs(localPort, httpsPort), 8000);
    this.log(`tailscale serve exit ${r.code}${r.timedOut ? " (timed out)" : ""}`);
    const outcome = interpretServe(r);
    if (!outcome.ok) {
      return outcome;
    }
    this.exposed = { httpsPort };
    return { ok: true, url: baseUrl(status.dnsName, httpsPort) };
  }

  /** Take down what `expose` set up; nothing else. */
  async remove(): Promise<void> {
    const exposed = this.exposed;
    if (!exposed || !this.cli) {
      return;
    }
    this.exposed = undefined;
    const r = await this.run(this.cli, unserveArgs(exposed.httpsPort), 8000);
    this.log(`tailscale serve off exit ${r.code}`);
  }
}
