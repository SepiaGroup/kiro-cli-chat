# Test Plan

Automated and manual checks for Kiro CLI Chat. Run the automated checks on
every change. Run the manual checks before a release, on the target machine
(no AVX), with `kiro-cli` installed and logged in.

## Automated

```sh
npm run compile   # type-check
npm run lint      # eslint, must report nothing
npm test          # builds dist-test/ and runs node --test
```

All three must exit 0. The tests cover the event mapper, JSON line parser,
markdown (HTML and ANSI), line diff, line editor, slash-command parsing and
menu, image-path detection, and the chat-tab manager (with a fake `vscode`).

## Install

```sh
npm run build
npx @vscode/vsce package --no-dependencies
code --install-extension kiro-cli-chat-0.1.0.vsix --force
```

Then run **Developer: Reload Window**.

## Manual checks

### Opening chats
- [ ] `Cmd+Shift+K` and the **Kiro Chat** status-bar item open a chat tab.
- [ ] With `openIn` = `panel`, they open the bottom-panel chat instead.
- [ ] Pressing `Cmd+Shift+K` again brings the same tab forward; it doesn't open another.
- [ ] ＋ (right of Restart) and **New Chat Tab** open "Kiro Chat 2", "Kiro Chat 3", …
- [ ] A prompt in one tab gets its reply only in that tab. The panel chat is separate too.
- [ ] Closing a tab stops its engine (`pgrep -fl "kiro-cli.*acp"` count drops).

### Reload
- [ ] With two tabs and the panel chat holding different conversations, reload the window.
- [ ] Each reopens its own session with the history shown, and no reply bubble is left with a blinking cursor.
- [ ] A new tab opened after the reload continues the numbering.

### Toolbar
- [ ] The model dropdown lists the engine's models and switches the live session.
- [ ] `defaultModel` set to a model ID is selected in a new chat. A reopened chat keeps the model it had.
- [ ] The Mode dropdown (left of Resume) switches modes (Default, Plan, …).
- [ ] The context ring shows a percentage; the unused part of the ring is clearly visible.
- [ ] The ring turns yellow at 60% and red at the compaction threshold.
- [ ] The engine status ("engine v3 …") isn't shown once ready.

### Context card
- [ ] Hovering or focusing the ring shows Conversation, MCP servers, Steering & context files, Session files and Memory.
- [ ] Every value has a unit (`0K`, `0.8K`, `16K`). With no MCP servers, MCP shows `0.0% · 0K`.
- [ ] Row percentages are consistent with their tokens and the header.
- [ ] **Compact context** compacts and posts a note; it's disabled while a reply runs.

### Panels
- [ ] Resume lists sessions with title, age and message count (no session ID).
- [ ] Picking a session loads it with its history.
- [ ] Settings has a ✕. Resume has a ✕.
- [ ] Clicking outside either panel, or Esc, closes it. Opening one closes the other.

### Chatting
- [ ] Replies stream as markdown (see `docs/samples/` for test content); code blocks have Copy.
- [ ] The input starts one row high and grows with content up to 200px.
- [ ] Enter sends, Shift+Enter adds a line; with `enterToSend` off they swap.
- [ ] `/` opens the command picker with engine commands, agents and skills.
- [ ] Paste a screenshot (`Cmd+V`) → it attaches. Shift-drag an image file → it attaches.
- [ ] Dragging a non-image file from the Explorer inserts its path.

### Approvals
- [ ] With `autopilot` off, a file write shows a card with Allow / Always allow / Deny / Always deny.
- [ ] Allow applies the change; Deny skips it.
- [ ] With `autopilot` on, tools run without asking.

### Commands (Command Palette)
- [ ] **Restart Engine** and the Restart button ask first; Cancel does nothing.
- [ ] **New Session** asks first, then clears the chat with a new session.
- [ ] **Resume Previous Session** opens the Resume panel (also on a just-opened tab).
- [ ] **Log In** opens a terminal running `kiro-cli login`.
- [ ] **Attach Image or File** opens a picker; images attach, other files insert their path.

### Terminal chat
- [ ] **New Terminal Chat** and the Terminal "+" → **Kiro Chat** each open an independent chat.
- [ ] The prompt shows `N% >`, or `N% !>` with Autopilot.
- [ ] Each reply ends with `▸ Credits: … • Time: …`.
- [ ] `/` shows the menu; ↑/↓, Tab, Enter and Esc work; it fits narrow terminals.
- [ ] `/help` lists all commands; unknown `/foo` isn't sent to the model.
- [ ] Spot-check: `/context show`, `/compact`, `/usage`, `/model`, `/rewind` (asks first), `/title`, `/spawn`, `/resume`.
- [ ] Approvals take `y` / `a` / `n`. Esc cancels a reply.

### Startup errors
- [ ] With an invalid `kiroCliPath`, the chat shows a clear error.
- [ ] Logged out (`kiro-cli logout`), the chat offers a login button.
