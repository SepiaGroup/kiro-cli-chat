---
name: verify-engine-behavior
description: Find out what the Kiro v3 engine (kiro-cli acp) or the kiro-cli TUI really does before building on it. Use when adding or changing anything that depends on ACP messages, _meta fields, approval/consent behavior, slash commands or kiro-cli wording and keys.
---

# Verify engine behavior

The engine's protocol details (`_meta.kiro.*`, extension methods, consent
rules) are mostly undocumented. Guessing has been the main source of bugs.
Check the source, then confirm with a live probe. Record what you learn in the
"Engine facts" section of `docs/ARCHITECTURE.md`.

## Where the code is

Under `~/Library/Application Support/kiro-cli/`:

- Engine (ACP server): `kas/<version>/node_modules/@kiro/agent/dist/server/acp-server.js`
  (plus `.d.ts` files next to it for types). One big bundle.
- kiro-cli TUI (the UI to mimic: approval choices, keys, wording): `tui.js`,
  directly in `~/Library/Application Support/kiro-cli/` (not under `kas/`).

```sh
D="$HOME/Library/Application Support/kiro-cli"
E=$(ls "$D"/kas/*/node_modules/@kiro/agent/dist/server/acp-server.js | head -1)
grep -o '"_kiro/[a-zA-Z/_]*"' "$E" | sort -u          # extension methods
grep -n -o '.\{200\}rejectionReason.\{200\}' "$E" | head   # context around a name
```

The bundles are minified; search for string literals (method names, `_meta`
keys, UI text) and read a few hundred characters around them. A small
`python3` script that prints windows around matches works better than `grep`
for long lines.

## Live probe

1. `npm run test:build` (compiles `src/` to `dist-test/`).
2. Write a throwaway script in `/tmp` that uses `dist-test/acpClient.js`:
   `new AcpClient({ cliPath, engine: "v3", cwd: <temp folder> })`, listen to
   `"event"`, `"log"` and `"permissionRequest"`, `await start()`, then send
   prompts or `extMethod(...)`.
3. Use a temp folder (`mktemp -d`) as `cwd`, never the repo or the user's
   projects: the agent may edit files there.
4. Bound it: run in the background with a `sleep N; kill` guard, since a turn
   can hang waiting for an approval.
5. Always `dispose()` the client, then delete the temp folder and the script.

Logging in: probes use the user's `kiro-cli login`. Each prompt costs credits;
keep prompts tiny ("Reply with just ok.").

## Known traps

- `kiro-cli acp --agent-engine v3` rejects most flags (`--model`,
  `--trust-all-tools`, `--agent`). Set model/autopilot with
  `session/set_config_option` after `session/new`.
- If an approval answer's rule `resource` doesn't cover the command being
  asked about, the engine asks again, forever. Test rules against the exact
  command.
- The engine decides per command whether to ask at all (e.g. `wc` isn't
  asked), so a probe may need a command that is asked (`find`, `head`).
- Compound shell lines are asked one command at a time
  (`consent.triggeringResource`, `consentRound`).
- Never kill `kiro-cli acp` processes whose parent is VS Code's Code Helper:
  those are the user's chats. Kill only the PIDs your probe started.
