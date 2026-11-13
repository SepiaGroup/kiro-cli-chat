# Architecture

How Kiro CLI Chat is built, and the engine behavior it relies on. This is the
reference for future work. Everything under "Engine facts" was checked against
a live `kiro-cli` v3 engine on the target machine (an AVX-less Intel Mac).

## The problem and the approach

Kiro CLI's TUI and the Kiro IDE bundle a Bun binary that needs AVX2, so they
die with `SIGILL` on older CPUs. The agent engine itself doesn't need AVX:
`kiro-cli acp --agent-engine v3` starts the Kiro Agent Server (Node.js) and
speaks the Agent Client Protocol (ACP) — JSON-RPC 2.0, newline-delimited, on
stdin/stdout. The extension is an ACP client with its own UI. It never starts
the TUI.

The extension targets **v3 only**. Model/mode switching, approvals, context
breakdown, compaction, checkpoints and most slash commands use v3 extension
methods. Engine detection still knows v1/v2 and a one-shot fallback exists,
but those paths only provide basic chat.

## Components

```
extension.ts ── activates, registers commands, status bar, terminal profile
│
├─ chatViewProvider.ts  ChatViewProvider: manages chat UIs
│    │  - any number of editor tabs (WebviewPanel), one ChatSession each
│    │  - the bottom-panel view (WebviewView), its own ChatSession
│    │  - "current chat" for commands = last-used tab or view
│    └─ chatSession.ts  ChatSession: one conversation
│         - its own engine process (AcpClient), transcript, approvals
│         - HTML for the webview; handles messages from webview/main.ts
│
├─ terminal/terminalChat.ts  TerminalChat: one text-mode chat per terminal
│    ├─ terminalCommands.ts  slash-command implementations (TerminalCommands)
│    ├─ slashCommands.ts     command specs, parsing, the "/" menu
│    ├─ lineEditor.ts        raw-input line editor (history, multi-line, footer)
│    ├─ ansiMarkdown.ts      streaming markdown → ANSI
│    ├─ ansi.ts              escape helpers, width/fit/wrap
│    └─ imagePaths.ts        finds dragged image paths in a prompt
│
├─ acpClient.ts      ACP transport: spawn, JSON-RPC, approvals (+ consent rules), ext methods
├─ approvalRules.ts  approval rule choices + folder checks (shared with the webview)
├─ eventMapper.ts    engine updates → normalized ChatEvent (types.ts)
├─ jsonLineParser.ts newline-delimited JSON, tolerant of non-JSON lines
├─ oneShotRunner.ts  fallback: `kiro-cli chat --output-format stream-json` per turn
├─ detect.ts         whoami, engine list + health check, models, sessions
├─ enginePrep.ts     cached cli-path/login/engine detection for terminal chats
├─ cli.ts            find kiro-cli, run it, sanitized env
└─ config.ts         reads kiroCliChat.* settings

webview/ (bundled to media/webview.js, runs inside the webview)
├─ main.ts       the chat UI: toolbar, messages, tool cards, approvals,
│                composer, "/" picker, Resume/Settings panels, context card
├─ markdown.ts   self-contained markdown → HTML (no dependencies)
└─ lineDiff.ts   LCS line diff for tool-card `+`/`-` rendering
media/webview.css  styles (VS Code theme variables only)
```

Pure modules (no `vscode` import) are unit-tested with `node --test`.
`chatViewProvider.test.ts` tests the tab manager against a small fake `vscode`
module.

## Chat lifecycle (webview)

1. A tab or the panel view is created. `ChatSession.attach()` sets the HTML.
2. The webview script loads and posts `ready`. The session then starts its
   engine (`ensureStarted`): find `kiro-cli`, `whoami`, resolve the engine,
   spawn `kiro-cli acp --agent-engine v3 --auth-method cli`, `initialize`,
   then `session/load` (if reopening) or `session/new`.
3. After start it syncs `autopilot` (and `defaultModel` for new sessions) with
   `session/set_config_option`.
4. Every engine event is posted to the webview as `{type:"event", event}` and
   recorded in the session's transcript.
5. The webview stores the current `sessionId` with `vscode.setState`. VS Code
   keeps that state with the tab/view, so after a window reload
   `deserializeWebviewPanel` (tabs) or `resolveWebviewView` (panel) gets it
   back and the session reopens it. If the load fails, it starts a new session.
6. If the panel view is moved and VS Code rebuilds its webview, the same
   `ChatSession` replays its transcript into the new webview (`resyncWebview`).
7. Closing a tab disposes its session and kills its engine. The conversation
   stays on disk and appears under Resume.

The webview's messages are handled in `ChatSession.handleMessage` (the
`switch` on `msg.type`) and `webview/main.ts` (the `message` listener); those
are the source of truth for the message names.

## Terminal chat

Each terminal is a `vscode.Pseudoterminal` backed by a `TerminalChat` with its
own `AcpClient`. Output is printed as whole lines. `print()` erases the prompt,
writes, then redraws it. The prompt shows context use (`17% >`, or `17% !>`
with Autopilot on). The "/" menu is drawn as a footer below the prompt, one
row per item, fitted to the terminal width. Slash commands are defined once in
`slashCommands.ts`: `<arg>` is required, `[arg]` optional. Unknown commands
are never sent to the model.

## Engine facts (v3, verified)

Transport:
- `kiro-cli acp` with `--agent-engine v3` accepts only `--agent-engine` and
  `--auth-method`. It rejects `--model`, `--trust-all-tools`, `--agent`, etc.
  Model and autopilot are set per session with `session/set_config_option`.
- stdout is clean JSON-RPC, stderr has `[INFO]`/`[ERROR]` logs.
- `initialize` → `session/new` (`{cwd, mcpServers: []}`) or `session/load`
  (`{sessionId, cwd, mcpServers: []}`). `session/load` replays the history as
  `session/update` notifications before it returns, so the UI is cleared first.
  Loading an unknown session ID doesn't fail; the client then has an empty
  session.
- `session/prompt` resolves when the turn ends with a `stopReason`
  (`end_turn`, `cancelled`, `refusal`, …); the client reports it in
  `runFinished` and always emits `runFinished`, also when the request fails.
  `session/cancel` (a notification) stops it with `stopReason: "cancelled"`.
- Request timeouts: `initialize`/`session/new` 120 s, `session/load` 180 s,
  `set_mode`/`set_config_option` 30 s. `session/prompt` and extension methods
  have none. `dispose()` sends SIGTERM, then SIGKILL after 3 s.
- The client advertises no `fs` or `terminal` capabilities, so the engine
  uses its own. Any other engine request gets JSON-RPC `-32601`.
- `session/set_mode` switches mode (vibe/plan/…). `session/set_config_option`
  sets `model`, `autopilot` (`on`/`off`), `effortLevel`, `memoryReflection`,
  `contentCollection`. Setting `model` to an invalid name isn't rejected.
- The engine starts with autopilot `on`, so the client always syncs it to
  `kiroCliChat.autopilot`.

Events (`session/update` and `_meta.kiro`, mapped in `eventMapper.ts`):
- `agent_message_chunk`, `user_message_chunk`, `tool_call`, `tool_call_update`
  (with diffs and `rawOutput`), `available_commands_update` (commands, agents,
  skills), `config_option_update` (settings schema + current values).
- `session_info_update` kinds: `context_usage` (percent, tokens, compaction
  threshold), `turn_completion` (credits, elapsed time, request IDs),
  `user_message_id_assigned` (the ID `/rewind` reverts to),
  `pending_interaction` (tool approval), `focus_update` (title and status).
- Tool approvals arrive as the server request `session/request_permission`
  with options `accept`, `always-accept`, `reject`, `always-reject` and
  `_meta.kiro.consent` (`capability` such as `fs_read`, `fs_write`, `shell`,
  `web_fetch`, `mcp`; `resource`; `workspaceRoot`). A compound shell line is
  asked once per command: same `toolCallId` and title, with
  `consent.triggeringResource` (the command) and `consentRound` (1, 2, …).
- The client answers with the chosen `optionId` and a response
  `_meta.kiro`: `consent: {capability, scope, resource?, workspaceRoot?}`
  and, for deny-once, `rejectionReason` (the engine reads it even without
  consent and passes it to the agent; verified). `scope` is `session` |
  `workspace` | `user` | `invocation`. Without a `resource`, allow-always
  saves a session rule for the exact file/command only.
- The approval UI follows the kiro-cli TUI (`tui.js`): Allow / Create allow
  rule… / Deny / Deny with reason / Create deny rule…. The rule list
  (`approvalRules.ts` `buildRules`) is exact match, command pattern (shell:
  `cat *`), folder (file changes, allow only: an editable folder, checked
  like the TUI by `checkFolder`, sent as `folder/**`) and entire tool
  (`*`). Allow-once sends `scope: "invocation"`. Rules are always `session`
  scope here (the TUI can also save `workspace`/`user` rules; not
  implemented). Unlike the TUI, one-word commands also get the pattern
  (`head` → `head *`); the engine's `head *` matches a bare `head`.
- After an entire-tool rule, `AcpClient` answers other approvals already
  waiting for that tool (same capability, workspace and session) with
  allow/deny once and emits `approvalResolved`, as the TUI does; the engine
  doesn't re-check them.
- Verified live: after "cat \*" another `cat` isn't asked but `ls` is; after
  "head \*" neither `head` nor `head -3`; entire tool on command 1 of
  `find …; ls` skips `ls`; after a `src/**` folder rule a write to
  `src/two.txt` isn't asked but `lib/three.txt` is. The resource must cover
  the command being asked about, or the engine asks again (in a loop).
- `_meta.kiro.trustClassifier: {decision: "prompt", reason}` is the reason a
  person should look at the call; shown on the card.
- The engine decides per command whether to ask at all (e.g. `wc`, or `head`
  after `echo`, aren't asked).
- File writes are followed by a separate "Review changes" approval with only
  Allow/Deny and no consent info.
- Other notifications seen: `_kiro/mcp/status` (`servers: []` when none),
  `_kiro/tools/didChange` (built-in tool tags), `_kiro/memory/syncStatus`.

Extension methods used (`AcpClient.extMethod`):

| Method | Used for |
| --- | --- |
| `_kiro/session/context` | `show` → per-category breakdown; `add`/`remove`/`clear` context files |
| `_kiro/session/compact` | Compact context (hover card, `/compact`) |
| `_kiro/session/rename` | `/title` |
| `_kiro/checkpoint/revertMultiple` | `/rewind` (by user message ID) |
| `_kiro/account/getUsage` | `/usage` |
| `_kiro/knowledge` | `/knowledge` |
| `_kiro/hooks/list` | `/hooks` (errors if v2 hooks are disabled) |
| `_kiro/codeIntelligence` | `/code` (fails if code intelligence isn't enabled) |

`_kiro/tools/list` isn't callable (it has no persistence classification).

Context breakdown (`_kiro/session/context` `show`):
- Categories: `yourPrompts`, `kiroResponses`, `tools` (with `mcp` and
  `builtin`), `contextFiles`, `sessionFiles`, `memory`.
- The per-category `percent` values use a different denominator from the
  overall `context_usage` percent, and can disagree with their own `tokens`.
  The hover card therefore recomputes each row from tokens against the window
  implied by the header (`usedTokens / pct`).
- Built-in tool definitions cost about 5K tokens in every session and only
  change with the agent's tool set, so the card hides them. MCP is its own row.

Other CLI calls (`detect.ts`):
- `kiro-cli whoami --format json` — login check.
- `kiro-cli chat --help` — lists engines. Each is health-checked headless,
  newest first; the result is cached per binary for all chats until Restart.
  If none runs, start fails with an error (no fallback).
- `kiro-cli chat --list-models --format json` — models (`model_id`, context
  window, rate multiplier).
- `kiro-cli chat --list-sessions --format json` — sessions for Resume
  (filtered to this engine and folder, newest first).
- `kiro-cli login` runs in an integrated terminal.

## Security

- `kiroCliChat.kiroCliPath` is `machine` scoped: a workspace's
  `.vscode/settings.json` can't make the extension run another binary. A set
  path must be an executable file.
- `capabilities.untrustedWorkspaces` is `limited`: in Restricted Mode VS Code
  ignores workspace values of `autopilot`, `defaultEngine` and
  `interactionMode`.
- The webview CSP is `default-src 'none'`, scripts by nonce, styles only from
  the extension's CSS file (no inline styles).
- Dropped/picked images are read only from absolute paths with an image
  extension, up to 10 MB, and the bytes must be a PNG, JPEG, GIF or WebP.

## Build and package

- `esbuild.js` bundles `src/extension.ts` → `dist/extension.js` and
  `src/webview/main.ts` → `media/webview.js`.
- `tsconfig.test.json` compiles everything except `extension.ts` and the
  webview entry to `dist-test/` for `node --test`.
- `.vscodeignore` keeps sources, tests and docs out of the `.vsix`.
- `npm run package` uses the pinned `@vscode/vsce` devDependency.

## Known limits

- No `/guide`, `/goal` or `/voice` (unsupported by the engine or the machine).
- `/tools trust-all` / `reset` can only switch Autopilot for all tools; the
  engine has no per-tool trust over ACP.
- Each chat tab and terminal runs its own engine process (memory grows per
  open chat).
- Files dropped from Finder onto a webview don't come with a path (a VS Code
  limitation); drag from the Explorer or use Attach instead.
