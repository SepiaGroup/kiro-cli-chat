// Shared engine preparation (CLI path, login check, engine detection) for the
// terminal chats. Detection health-checks engines, which takes a few seconds,
// so the result is cached and reused by every terminal. No vscode import.

import { resolveCliPath } from "./cli";
import { checkAuth, resetEngineCache, resolveEngine } from "./detect";
import { EngineSetting, EngineVersion } from "./types";

export interface PreparedEngine {
  cliPath: string;
  engine: EngineVersion;
  identity?: string;
}

export class NotLoggedInError extends Error {
  constructor(readonly cliPath: string) {
    super("Not logged in to Kiro CLI.");
  }
}

let cache: { key: string; promise: Promise<PreparedEngine> } | undefined;

export function prepareEngine(
  cliPathSetting: string,
  engineSetting: EngineSetting,
  log: (m: string) => void = () => {}
): Promise<PreparedEngine> {
  const key = `${cliPathSetting}|${engineSetting}`;
  if (cache && cache.key === key) {
    return cache.promise;
  }
  const promise = (async (): Promise<PreparedEngine> => {
    const cliPath = resolveCliPath(cliPathSetting);
    if (!cliPath) {
      throw new Error("Could not find the kiro-cli binary. Set kiroCliChat.kiroCliPath in settings.");
    }
    const auth = await checkAuth(cliPath);
    if (!auth.loggedIn) {
      throw new NotLoggedInError(cliPath);
    }
    const engine = await resolveEngine(cliPath, engineSetting, log);
    return { cliPath, engine, identity: auth.identity };
  })();
  cache = { key, promise };
  // Don't cache failures (e.g. the user logs in and retries).
  promise.catch(() => {
    if (cache?.promise === promise) {
      cache = undefined;
    }
  });
  return promise;
}

/** Forget the cached result (e.g. on /restart after changing settings). */
export function resetPreparedEngine(): void {
  cache = undefined;
  resetEngineCache();
}
