# Agent guide: Kiro CLI Chat

VS Code extension (`sepiagroup.kiro-cli-chat`) that chats with the Kiro CLI
agent on Macs without AVX/AVX2. The kiro-cli terminal UI crashes there with
SIGILL, so the extension runs the headless engine, `kiro-cli acp --agent-engine
v3 --auth-method cli`, speaks ACP (JSON-RPC over stdio) to it and draws its own
UI. **v3 engine only, macOS only** (Windows is out of scope).

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing behavior; it
has the module map, lifecycles and verified engine facts. Build and release
steps are in [CONTRIBUTING.md](CONTRIBUTING.md), manual checks in
[TEST.md](TEST.md).

## Layout

- Engine side, shared by both UIs: `acpClient.ts` (transport), `eventMapper.ts`
  (ACP → `ChatEvent`), `approvalRules.ts`, `questions.ts`, `fileMentions.ts`,
  `editorContext.ts`, `errorAdvice.ts`, `remote/*` (remote access core, pure), `detect.ts`, `cli.ts`, `enginePrep.ts`,
  `types.ts`.
- Webview chat (editor tabs + panel view): `chatViewProvider.ts`,
  `chatSession.ts` (extension side, with `uiTargets.ts` for its screens) and `webview/*.ts` (browser side, bundled
  to `media/webview.js`, styled by `media/webview.css`).
- Terminal chat (text mode, a Pseudoterminal): `terminal/*.ts`.
- Only `extension.ts`, `config.ts` (settings and editor state), `chatViewProvider.ts`, `chatSession.ts`,
  `terminal/terminalChat.ts` and `terminal/terminalCommands.ts` import
  `vscode`. Everything else is pure so `node --test` can test it. Keep it so:
  put new logic in a pure module and test it there.

## Design rules

- Keep both UIs. A user-facing feature normally lands in both, built on the
  same engine code.
- The terminal chat mimics kiro-cli (commands, keys, wording). Approvals match
  the kiro-cli TUI. When unsure how kiro-cli behaves, check it (see the
  `verify-engine-behavior` skill); don't guess.
- Prefer VS Code-native behavior (theme variables `--vscode-*`, commands,
  settings, output channel `Kiro CLI Chat`).
- No runtime dependencies. Markdown rendering is self-contained. Tool calls
  render as terminal-style cards.
- The webview CSP allows no inline styles or scripts: use classes in
  `webview.css`, never `style=`. Escape all text put into HTML.
- Treat everything from the webview and the engine as untrusted: validate
  shapes and sizes (see `sanitizeImages`, `cleanReason`).
- Never send the engine a request it may answer with a loop or a hang
  without a way out (timeouts in `acpClient.ts`; approval rules must cover
  the asked command).

## Code conventions

- TypeScript strict, `noUnused*`, eslint (`typescript-eslint` recommended).
  Unused params start with `_`.
- Each file starts with a `//` comment saying what it is and whether it is
  pure. Comments explain why, not what.
- Small pure helpers with unit tests next to them (`foo.ts` / `foo.test.ts`,
  `node:test` + `node:assert/strict`).
- Dev dependencies are pinned to exact versions. Ask before adding any.
- User-facing text (UI, errors, docs): plain, short sentences, no em dashes,
  say what to do next.

## Workflow

- Work on a branch (`feat/…`, `fix/…`, `refactor/…`, `docs/…`) and open a PR
  to `main`. `main` is protected: PR plus a passing `build` check, no direct
  or force pushes. Commit, push or merge only when the user asks.
- Before a PR, all must pass: `npm run compile`, `npm run lint` (no output),
  `npm test`, `npm run package`.
- To try a build: `npm run package`, then
  `code --install-extension kiro-cli-chat-<version>.vsix --force` and ask the
  user to reload the window.
- With a behavior change, update README (user docs), TEST.md (manual checks),
  `docs/ARCHITECTURE.md` (design, engine facts) and CHANGELOG.md.
- Clean up probe processes and temp files. Never kill the user's own
  `kiro-cli acp` processes (their parent is VS Code's Code Helper).

## Skills

- `.kiro/skills/verify-engine-behavior`: find out what the engine or the
  kiro-cli TUI really does (bundle reading, live probes).
- `.kiro/skills/add-chat-feature`: checklist for a feature in both UIs.
- `.kiro/skills/release`: version, changelog, package, tag, publish.
