# Kiro CLI Chat

A VS Code extension for chatting with the Kiro CLI agent on Macs **without
AVX/AVX2** (for example older Intel Macs running macOS through OpenCore Legacy
Patcher).

## Why this exists

Kiro CLI's terminal UI (and the Kiro IDE) bundle a build of Bun that needs
AVX2, so they crash with `SIGILL` on older CPUs. The agent engine itself
doesn't need AVX when it runs headless. This extension starts the engine with
`kiro-cli acp` and talks to it over the Agent Client Protocol (ACP, JSON-RPC
over stdio), then draws its own chat UI in VS Code. The AVX-only UI is never
launched.

The extension is built for the **v3 engine** (the Kiro Agent Server). Model and
mode switching, approvals, context breakdown, compaction, checkpoints and most
slash commands use v3-only ACP methods.

## Requirements

- macOS. Built and tested on an Intel Mac without AVX; other platforms aren't
  supported (the extension uses `bash`, macOS paths and macOS PATH handling).
- `kiro-cli` with the v3 engine, installed and on PATH (or set
  `kiroCliChat.kiroCliPath`). Tested with kiro-cli 2.35.2.
- Logged in (`kiro-cli login`). The chat checks at startup and offers a login
  button if you aren't.
- VS Code 1.98 or later.

## Two ways to chat

### Chat tabs (webview)

`Cmd+Alt+K` (`Ctrl+Alt+K` elsewhere), the **Kiro Chat** status-bar item, or **Kiro CLI Chat:
Open Chat** opens the chat as an editor tab (set `kiroCliChat.openIn` to
`panel` to use the bottom panel instead).

- **Multiple chats.** Each tab is its own conversation with its own engine.
  Open another with the **＋** button in the toolbar or **Kiro CLI Chat: New
  Chat Tab**. The bottom-panel chat view is a separate conversation too.
- **Survives reloads.** After a window reload, every tab and the panel view
  reopen the session they had, with the history shown again.
- **Toolbar.** Model dropdown (switches live), context ring with the percentage
  used, Mode dropdown (Default, Plan, …), Resume, Restart, ＋ and ⚙ Settings.
- **Context breakdown.** Hover (or focus) the context ring to see tokens and
  percent for the conversation, MCP servers, steering/context files, session
  files and memory, plus credits used. **Compact context** summarizes the
  conversation to free space.
- **Replies** stream as markdown (headings, lists, tables, code blocks with a
  Copy button). Tool calls show as cards with the files touched, `+`/`-` diffs
  and how long they took.
- **Approvals.** In Supervised mode (Autopilot off) file changes and commands
  wait for your answer, with the same choices as kiro-cli: **Allow**,
  **Create allow rule…**, **Deny**, **Deny with reason…** (the agent is told
  why) and **Create deny rule…**. A rule covers this exact file or
  command, the command pattern (`find *`), a folder and everything under it
  (file changes; you can edit the folder), or the entire tool (every
  command, every file read, …). Rules last for the session. A line like
  `a; b && c` is asked one command at a time, and the card says which.
- **Images.** Paste a screenshot (`Cmd+V`), Shift-drag image files onto the
  chat, or use **Kiro CLI Chat: Attach Image or File**. Dropping other files
  inserts their paths.
- **Questions.** When the agent asks you something (it does in Spec mode),
  a card shows the choices. Pick one, or type your own answer. A choice
  can open a checklist first. Skip tells the agent to move on.
- **Files in a prompt.** Type `@file:path` (relative to the folder, absolute
  or `~/…`) and the file's text goes to the agent with your prompt. The chat
  keeps showing what you typed. Files must be plain text, up to 256 KB each
  (1 MB per prompt); anything else is left as typed and the Output log says why.
- **Input.** One line that grows as you type. Enter sends, Shift+Enter adds a
  line. Type `/` for a picker of the engine's commands, agents and skills.
- **Resume** lists previous sessions for this folder (title, age, message
  count). **Restart** asks before restarting the engine and clearing the chat.
  Clicking outside the Resume or Settings panel (or Esc) closes it.
- **Settings (⚙):** Effort, Autopilot, memory reflection and content
  collection, applied to the live session.

### Terminal chat (text mode)

A text-only chat in the Terminal panel, next to your shells. Open it with
**Kiro CLI Chat: New Terminal Chat (text mode)** or the **Kiro Chat** entry in
the Terminal panel's **+** dropdown. Each terminal has its own engine and
conversation, so you can open several.

It streams markdown (colors, lists, code blocks), shows tool cards with diffs
and asks for approvals with kiro-cli's keys: `y` allow, `t` create an allow
rule, `n` deny, Tab deny with a reason, `d` create a deny rule. The rule keys
list the rules to pick by number (exact, pattern, folder, entire tool); Esc
goes back. The prompt shows the context used (`17% >`,
or `17% !>` with Autopilot), and each reply ends with
`▸ Credits: … • Time: …`.

The agent's questions show as numbered choices: type a number or your own
answer, Enter sends (an empty line takes the recommended choice), Esc skips.
`@file:path` in a prompt attaches that file, as in the webview chat.

Type `/` for a menu of commands: it filters as you type, ↑/↓ selects, Tab
completes, Enter runs, Esc hides it. After a command it suggests subcommands
and values (e.g. `/context ` → add/remove/clear/show, `/model ` → models).

Commands follow kiro-cli: `/help`, `/clear`, `/new`, `/chat new|save|load`,
`/resume`, `/rewind`, `/compact`, `/title`, `/transcript`, `/copy`, `/editor`,
`/reply`, `/paste`, `/spawn`, `/context`, `/knowledge`, `/model`, `/effort`,
`/agent` (incl. `create`/`edit`), `/plan`, `/prompts`, `/tools`, `/autopilot`,
`/mcp`, `/hooks`, `/code`, `/config`, `/set`, `/usage`, `/stats`,
`/changelog`, `/settings`, `/theme`, `/restart`, `/login`, `/cls`, `/quit`.

- `/guide`, `/goal` and `/voice` aren't available (the engine or this machine
  can't support them) and say so.
- `/rewind` undoes the agent's file changes after that point, so it asks first.
- `/tools trust-all` and `/tools reset` switch Autopilot on and off (the engine
  only supports trusting all tools at once).
- Unknown slash commands aren't sent to the agent; start the line with a space
  to send `/...` as plain text.

Keys: Enter sends, Shift+Enter adds a new line, Esc cancels a reply, ↑/↓ for
history. Drag image files onto the terminal (or type their paths), or `/paste`
a copied image, to attach them.

## Commands

| Command | What it does |
| --- | --- |
| Kiro CLI Chat: Open Chat (`Cmd+Alt+K`) | Shows the most recent chat tab (or the panel, per `openIn`). |
| Kiro CLI Chat: New Chat Tab | Opens another chat tab with a new conversation. |
| Kiro CLI Chat: Open Chat in Editor Tab / in Panel | Opens the chat in that place. |
| Kiro CLI Chat: New Terminal Chat (text mode) | Opens a terminal chat. |
| Kiro CLI Chat: New Session | Asks, then starts a fresh conversation in the current chat. |
| Kiro CLI Chat: Resume Previous Session | Opens the current chat's Resume panel. |
| Kiro CLI Chat: Restart Engine | Asks, then restarts the current chat's engine. |
| Kiro CLI Chat: Log In | Runs `kiro-cli login` in a terminal. |
| Kiro CLI Chat: Attach Image or File | File picker; images attach, other files insert their path. |

"Current chat" is the chat tab or panel view you used last.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `kiroCliChat.openIn` | `editor` | Where Open Chat goes: `editor` (tab) or `panel`. |
| `kiroCliChat.kiroCliPath` | _(empty)_ | Path to `kiro-cli`. Empty = PATH, then `~/.local/bin/kiro-cli`. User settings only (a workspace can't set it). |
| `kiroCliChat.defaultModel` | `auto` | Model for new sessions (see `kiro-cli chat --list-models`). |
| `kiroCliChat.autopilot` | `false` | Off = Supervised (approve each change). On = tools run without asking. |
| `kiroCliChat.enterToSend` | `true` | Enter sends, Shift+Enter adds a line. Off reverses them. |
| `kiroCliChat.defaultEngine` | `auto` | `auto` checks that the engine runs on this machine (once, then remembered) or `v3`. |
| `kiroCliChat.interactionMode` | `persistent` | `persistent` (ACP) is required for everything above. `one-shot` is a basic fallback with no approvals. |

## Troubleshooting

Logs are in **Output → Kiro CLI Chat** (View → Output, then pick it from the
list). They show the kiro-cli path used, the engine detected and the engine's
own messages.

- **"Could not find the kiro-cli binary"**: install kiro-cli, or set
  `kiroCliChat.kiroCliPath` (user settings) to its full path. `which kiro-cli`
  in a terminal shows where it is.
- **"kiroCliChat.kiroCliPath is set to …, which doesn't exist"**: fix or clear
  the setting.
- **Login card keeps coming back**: run `kiro-cli login` in a terminal, then
  click Retry. `kiro-cli whoami` shows whether you're logged in.
- **"No Kiro engine runs on this machine"**: run
  `kiro-cli chat --agent-engine v3` in a terminal. If that crashes with
  `illegal hardware instruction` (SIGILL), your kiro-cli version needs AVX even
  for the engine; try updating it.
- **"The Kiro engine sent nothing for 10m 0s"**: the engine never replied to
  your prompt, so the turn was cancelled. Send it again; use Restart if it
  keeps happening. A turn that goes quiet after it has started is not stopped
  (a build can take a while); the log notes it after 30 seconds.
- **"The Kiro engine didn't answer … within …s"**: the engine hung while
  starting. Use **Restart** (or `/restart` in a terminal chat); the log shows
  the engine's last messages.
- **Engine exited**: the chat says so. Restart starts a new engine; Resume
  reopens the conversation.

## Privacy

Your prompts, attached images and the files the agent reads are sent to Kiro
by kiro-cli, as when you use kiro-cli directly. Kiro's own content-collection
setting is in ⚙ Settings. This extension adds no telemetry and makes no
network requests of its own.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for building, testing and releasing,
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works, and
[TEST.md](TEST.md) for the manual test checklist.

## License

MIT
