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

All three must exit 0. The tests cover the event mapper, approval rules,
JSON line parser, markdown (HTML and ANSI), line diff, line editor,
slash-command parsing and menu, image-path detection, the chat-tab manager
(with a fake `vscode`), and `AcpClient` against a fake engine process
(handshake, timeouts, cancelled turns, unknown requests, the engine dying).
CI (`.github/workflows/ci.yml`) runs them plus `npm run package` on every
push and pull request.

## Install

```sh
npm run package   # builds and writes kiro-cli-chat-<version>.vsix
code --install-extension kiro-cli-chat-0.1.0.vsix --force
```

Then run **Developer: Reload Window**.

## Manual checks

### Opening chats
- [ ] `Cmd+Alt+K` and the **Kiro Chat** status-bar item open a chat tab. `Cmd+Shift+K` still deletes the line in an editor.
- [ ] With `openIn` = `panel`, they open the bottom-panel chat instead.
- [ ] Pressing `Cmd+Alt+K` again brings the same tab forward; it doesn't open another.
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
- [ ] With `autopilot` off, a file write shows a card with Allow / Create allow rule… / Deny / Deny with reason… / Create deny rule….
- [ ] Create allow rule on a file read outside the workspace lists `Trust "<file>"` and `Trust entire tool (Read File)`. Entire tool → reading a second file doesn't ask.
- [ ] A shell command lists `Trust "<command>"`, `Trust "cat *"` and `Trust entire tool (Run Command)`. After "cat \*", another `cat` doesn't ask but `ls` does.
- [ ] On `find …; ls`, entire tool for command 1 means `ls` isn't asked.
- [ ] A write to `src/a/x.txt` offers "Allow a folder for this session…" prefilled with `src/a`. Change it to `src` → a write to `src/y.txt` only shows Review changes; `lib/z.txt` asks. `..`, `~`, `*` or a folder not containing the file show an error.
- [ ] Deny with reason: type "use rg instead" → the agent's reply reflects it.
- [ ] Back returns from the rule list and the text fields; Esc in a text field does too.
- [ ] `cat a; echo b` asks twice, each card naming its command ("Command 1: …", "Command 2: …").
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
- [ ] Approvals take `y` / `n` / Tab (reason) / `t` (allow rule) / `d` (deny rule); rules are picked by number, Esc goes back. Compound lines name the command. Esc cancels a reply.
- [ ] The folder rule's input is prefilled and editable (Backspace, Ctrl+U); an invalid folder prints the reason and asks again.

### Startup errors
- [ ] With an invalid `kiroCliPath`, the chat shows a clear error.
- [ ] Logged out (`kiro-cli logout`), the chat offers a login button.

### Untrusted workspaces
- [ ] Open a folder whose `.vscode/settings.json` sets `kiroCliChat.kiroCliPath` and `kiroCliChat.autopilot: true`. VS Code reports `kiroCliPath` as a machine setting that a workspace can't set; the chat uses the user-level path.
- [ ] Choose "Don't Trust" (Restricted Mode): the chat still works, and approvals are still asked (the workspace `autopilot` is ignored).

### Engine failures
- [ ] Set `kiroCliChat.kiroCliPath` to a file that doesn't exist → the chat says the setting points to a missing file.
- [ ] Start a long reply, then `pkill -f "kiro-cli-chat acp"` → the chat says the engine exited, leaves the busy state, and Restart works.
- [ ] Esc / Stop during a reply → the terminal footer shows "■ Cancelled".
