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
│         - its own engine process (AcpClient), approvals
│         - handles messages from webview/main.ts (onMessage)
│         ├─ chatTranscript.ts  what the chat showed, replayed into a new webview
│         ├─ webviewHtml.ts     the page and its CSP
│         └─ webviewInput.ts    validation of what the webview posts
│
├─ terminal/terminalChat.ts  TerminalChat: one text-mode chat per terminal
│    │                       (lifecycle, input routing, prompt, spinner, turns)
│    ├─ approvalPrompt.ts    approval keys and screens, queue (pure)
│    ├─ questionPrompt.ts    the agent's questions: choices, typed answer, checklist (pure)
│    ├─ toolLog.ts           tool call lines, diffs, completion (pure)
│    ├─ menuState.ts         the "/" menu under the prompt (pure)
│    ├─ sessionConfig.ts     the engine's session settings (pure)
│    ├─ localCommands.ts     dispatcher + help/model/effort/autopilot/tools/config/resume (pure)
│    ├─ terminalCommands.ts  the other slash commands (TerminalCommands)
│    ├─ slashCommands.ts     command specs, parsing, the "/" menu
│    ├─ lineEditor.ts        raw-input line editor (history, multi-line, footer)
│    ├─ ansiMarkdown.ts      streaming markdown → ANSI
│    ├─ ansi.ts              escape helpers, width/fit/wrap
│    └─ imagePaths.ts        finds dragged image paths in a prompt
│
├─ acpClient.ts      ACP transport: spawn, JSON-RPC, approvals (+ consent rules), questions, steering, ext methods
├─ approvalRules.ts  approval rule choices + folder checks (shared with the webview)
├─ questions.ts      the agent's questions: parse `_kiro/userInput`, build the answer text
├─ editorContext.ts  open/active editor files as a prompt context item (paths only, off by default)
├─ fileMentions.ts   `@file:path` → <attached_file> text in the prompt
├─ eventMapper.ts    engine updates → normalized ChatEvent (types.ts)
├─ uiTargets.ts      the screens one chat shows on (desktop webview, remote browsers): who gets what, when
├─ remote/           remote access (see "Remote access" below)
│    ├─ remoteAuth.ts    pairing code, device records (hashes only), cookies, rate limit
│    ├─ remotePolicy.ts  allow-list of what a remote device may send, and the shape it gets through in
│    ├─ eventLog.ts      numbered, bounded log of a chat's messages (catch-up after a dropped connection)
│    ├─ remoteServer.ts  loopback HTTP server: page, pairing, SSE streams, messages
│    ├─ remotePage.ts    the HTML and security headers
│    ├─ assets.ts        the fixed list of files served from media/
│    └─ remoteController.ts  (vscode) start/stop, status bar, pairing link, devices, settings
├─ errorAdvice.ts    tidy a failed prompt's message, add a hint (login, session, network, rate limit); the TUI's wording
├─ jsonLineParser.ts newline-delimited JSON, tolerant of non-JSON lines
├─ oneShotRunner.ts  fallback: `kiro-cli chat --output-format stream-json` per turn
├─ detect.ts         whoami, engine list + health check, models, sessions
├─ enginePrep.ts     cached cli-path/login/engine detection for terminal chats
├─ sessionList.ts    which saved sessions Resume offers (both UIs)
├─ format.ts         small shared formatters (also used by the webview)
├─ cli.ts            find kiro-cli, run it, sanitized env
└─ config.ts         reads kiroCliChat.* settings

webview/ (bundled to media/webview.js, runs inside the webview)
├─ main.ts           startup, composer, busy/starting state, routes host messages
├─ ui.ts             shared: VS Code API, state, main elements, DOM helpers, panels
├─ messages.ts       user prompts and streamed markdown replies
├─ toolCards.ts      terminal-style tool cards (paths, status, diff, output)
├─ approvalCard.ts   approval card (choices, rule list, folder, reason)
├─ questionCard.ts   the agent's question (choices, own answer, checklist)
├─ steerNotes.ts     the status line under a message sent mid-reply
├─ attachments.ts    image attachments, drag-and-drop, paste
├─ dropPaths.ts      pure: paths and image types from a drop (tested)
├─ commandPicker.ts  "/" picker and argument hint
├─ contextCard.ts    context meter and its hover card (breakdown, Compact)
├─ resumePanel.ts    Resume panel
├─ settingsPanel.ts  ⚙ Settings panel, model and mode dropdowns
├─ markdown.ts       self-contained markdown → HTML (no dependencies)
└─ lineDiff.ts       LCS line diff for tool-card `+`/`-` rendering
media/webview.css  styles (VS Code theme variables only)
```

Pure modules (no `vscode` import) are unit-tested with `node --test`.
`tsconfig.test.json` compiles only the tests and what they import, so the
webview's DOM modules stay out of the Node test build.
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

The webview's messages are handled in `ChatSession.onMessage` (the
`switch` on `msg.type`) and `webview/main.ts` (the `message` listener); those
are the source of truth for the message names.

## Remote access

A browser on another device shows and drives a webview chat while the engine
keeps running here. Plan and decisions: `docs/REMOTE-CONTROL.md`.

- `RemoteController` starts a `RemoteServer` bound to 127.0.0.1 (a tunnel such
  as Tailscale carries traffic to it). The page is the chat webview's own
  HTML and `webview.js`; `media/remoteShim.js` (built from
  `webview/remoteShim.ts`) stands in for `acquireVsCodeApi`: it pairs, picks a
  chat, reads the chat's messages from an `EventSource` into `message` events
  and posts the page's messages with `fetch`. Its decisions (pairing link,
  which chat to open, texts) are in `webview/remoteBoot.ts`.
- `ChatSession` implements `RemoteChat` (`snapshot()` from the transcript,
  `subscribe()` as a ready remote target, `send()` for a checked message).
  `UiTargets` keeps the desktop webview and the remote listener apart: the
  desktop gets messages at once, a remote listener is always ready.
- Streams: `GET /api/chats/:id/events`. A new stream gets a `snapshot` marker
  event (the page clears itself), the transcript, then a `sync` event whose id
  is where live messages continue. A reconnect sends `Last-Event-ID` and gets
  only what it missed from the bounded `EventLog`; ids carry a random epoch, so
  an id from before an extension restart means a new snapshot.
- A remote device is paired by a one-use 10-minute code in the link's
  fragment, exchanged for an `HttpOnly; SameSite=Strict` cookie (`Secure` when
  the request came through a proxy). Only a hash of the cookie value is stored
  (in SecretStorage). Every `/api` request needs the cookie and a same-origin
  request; messages pass `remotePolicy.ts` (an allow-list that also removes the
  `rule` and `folder` fields of an approval).
- A remote approval must be allow once or deny once: `AcpClient.respondToApproval`
  with `onceOnly` throws for any other option kind (the option ids come from the
  engine, `allow_always` saves a rule), leaving the request waiting.
- Whoever answers an approval, `ChatSession` posts `approvalResolved` with a
  label ("Allowed from <device>" or "on the desktop"), so the other screens
  drop their card and say who answered. Questions already did this.
- The settings (`kiroCliChat.remote.*`) have machine scope, so a workspace
  cannot turn remote access on; it also refuses to start in an untrusted
  workspace.

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
- Questions: `initialize` carries `clientCapabilities._meta.kiro.userInput:
  true`. The engine then asks with the server request `_kiro/userInput`
  (`{sessionId, toolCallId, question, options: [{title, description?,
  recommended?, subOptionsLabel?, subOptions?}]}`) and the client answers
  `{action: "answered", answer: "<option title or typed text>"}` or
  `{action: "dismissed"}`. An option with sub-options is answered
  `"title [sub1, sub2]"`, like the TUI. Without the capability the engine
  turns a question with options into a `session/request_permission` whose
  options are all `allow_once` (the UI can only show "Allow") and skips one
  without options. Only some modes have the tool (Spec does; Vibe and Plan
  just ask in prose). On cancel or turn end the client drops the question.
- Prompt extras: `session/prompt` accepts `_meta.kiro.displayText`. The engine
  sends the real prompt to the model but shows (and replays on resume) the
  display text. `@file:path` is expanded by the client, as the TUI does:
  `<attached_file path="…"> text </attached_file>`; the display text keeps
  what was typed. Verified live.
- Context items: a `resource` block with `text` in `session/prompt` reaches the
  model as a `## <uri>` section of the user message, and a resumed session
  still shows only the typed text. We use it for the editor's open and active
  files (`editorContext.ts`), sent when they change. The engine's own
  `_kiro/workspace/active_file` and `currently_open_files` requests are only
  made for `#[[currentlyOpenFiles:active|all]]` mentions in custom-agent
  prompts and steering documents, never for a chat prompt (verified live: they
  are not expanded in user text), so we don't answer them. Its own environment
  note says no files are open, hence the sentence in our text.
- Errors: a failing turn puts its text into the reply as an
  `agent_message_chunk` (`abortedWithError`) and `session/prompt` may reject.
  For `InsufficientModelCapacityError` and `HighLoadError` the engine also sends
  the notification `_kiro/error/rate_limit` `{sessionId, message}` while it
  retries; the TUI shows it as a 5 s red alert and keeps the turn going, and so
  do we (a `notice` with `isError`). `tui.js` (in `~/Library/Application
  Support/kiro-cli/`) cleans and classifies a rejected prompt's message
  (`aRt`, `Lfe`, `Pfe`) and gives a hint only for auth and session; we port
  those rules to `errorAdvice.ts` and add the hint also for network and rate
  limit. Not verified live: the engine's exact errors for a lapsed login or a
  dropped connection.
- Cancel: `session/cancel` (a notification) ends the turn with `stopReason`
  `cancelled`, also while an approval is unanswered (verified live); the
  session takes the next prompt. The unanswered approval is never answered, so
  the client forgets it when the turn ends (otherwise the quiet-turn watchdog
  would think it is waiting for the user) and the webview removes its card.
- Steering: `_session/steer` `{sessionId, message, messageId?}` while a turn
  runs returns `{queued: true, messageId: "steer-<id>"}`. Updates arrive as
  `session_info_update` with `_meta.kiro.kind` `steering_queued`,
  `steering_injected` (the agent has it: at its next model call, so after a
  running tool call) and `steering_cleared` (`messageIds`, also at the end of
  the turn for the ones read). The engine keeps a turn going until unread
  steering is delivered. `_session/steer/clear` drops unread ones and emits
  `steering_cleared` before it replies. The agent adds a `[STEERING …]` note to
  its reply. The client reports ids still unread at "cleared" or at the end of
  the turn as `dropped`, or `removed` after `clearSteers()`. Images can't be steered.
- Watchdog (as in the TUI): no `session/update` or server request within 10
  minutes of the prompt → `session/cancel` and an error. After the first
  event there is no limit; a quiet turn is logged after 30 s.
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
