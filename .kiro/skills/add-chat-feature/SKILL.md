---
name: add-chat-feature
description: Checklist for adding or changing a user-facing chat feature so it works in both the webview chat and the terminal chat. Use when a feature touches engine events, approvals, slash commands, toolbar items, settings or session handling.
---

# Add a chat feature

Both UIs sit on the same engine code. Build the shared part first, then each
UI, then tests and docs. Keep new logic in pure modules (no `vscode` import).

## 1. Find out what the engine does

If the feature depends on engine behavior, use the `verify-engine-behavior`
skill first. Don't build on a guessed message shape.

## 2. Engine side (shared)

- `src/types.ts`: add the `ChatEvent` variant or option types. Events are a
  discriminated union on `kind`.
- `src/eventMapper.ts`: map the raw ACP notification/request to the event.
  Validate every field (`typeof` checks); unknown or malformed input maps to
  nothing, not a throw.
- `src/acpClient.ts`: new requests go through `request()` (add a timeout to
  `TIMEOUTS_MS` if it should answer quickly), engine extension methods through
  `extMethod()`. Engine-to-client requests go in `handleServerRequest`.
- Pure helpers (parsing, rule building, formatting) in their own module, like
  `approvalRules.ts`, so both UIs share them and they can be unit-tested.

## 3. Webview chat

- Extension side, `src/chatSession.ts`: handle webview messages in
  `onMessage` (the `switch` on `msg.type`); validate them, they're
  untrusted. Post results back with `this.post(...)`. Engine events are
  forwarded as `{ type: "event", event }` and kept in the transcript for
  replay after reloads.
- Browser side, `src/webview/main.ts`: render in the `message` listener. Build
  DOM with `textContent` or escaped HTML; styles as classes in
  `media/webview.css` using `--vscode-*` theme variables. No `style=`
  attributes (the CSP blocks them). Keyboard-accessible controls with labels.

## 4. Terminal chat

- `src/terminal/terminalChat.ts`: handle the event; print with `print()` (whole
  lines, the prompt is redrawn after). Use `ansi.ts` styles and `sanitize()`
  on any engine text.
- Slash commands: declare them in `src/terminal/slashCommands.ts` (`COMMANDS`;
  `<arg>` required, `[arg]` optional, `subs` for subcommands), route them in
  `LocalCommands.run` (`src/terminal/localCommands.ts`) and implement them
  there (session settings, resume) or in `src/terminal/terminalCommands.ts`
  (everything else). Match kiro-cli's names, keys and wording.
- Approvals, tool lines and the "/" menu live in `approvalPrompt.ts`,
  `toolLog.ts` and `menuState.ts`: pure classes with tests.
- If the feature can't work here, add it with `unavailable: "<why>"` rather
  than leaving it out.

## 5. Tests

- Unit tests next to each pure module (`foo.test.ts`, `node:test`,
  `node:assert/strict`). Mapper changes get cases in `eventMapper.test.ts`.
- Transport changes: extend `acpClient.engine.test.ts` (fake engine process).
- Whole terminal-chat flows: extend `terminal/terminalChat.test.ts` (fake
  `vscode` plus a fake kiro-cli).
- Run `npm run compile`, `npm run lint`, `npm test`, `npm run package`.
- If it depends on the real engine, run a short live probe as well.

## 6. Docs

- README: what the user sees and how to use it, in both UI sections.
- TEST.md: manual checks for both UIs.
- `docs/ARCHITECTURE.md`: design and any new engine facts.
- CHANGELOG.md: one line under the unreleased version.

Then install the build (`code --install-extension kiro-cli-chat-<version>.vsix
--force`), ask the user to reload and try it, and open a PR from a `feat/…`
branch.
