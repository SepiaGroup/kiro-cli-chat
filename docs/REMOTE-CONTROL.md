# Remote control: implementation plan

Status: plan, no code yet. Transport: Tailscale.

## Goal

A chat keeps running on the desktop (VS Code and the Kiro engine on the Mac).
From a phone, tablet or any browser on your tailnet you can watch it live,
answer approvals and questions, send prompts, steer, and stop a reply.

Constraints: free, nothing hosted, nothing to support.

Not in the first version: terminal chats (they are not built on the webview
message protocol), running with VS Code closed, push notifications, starting
a chat from the phone.

## How you use it

1. Tailscale runs on the Mac (it can start at login) and on the phone. Both
   are logged in to your account.
2. In VS Code run **Kiro CLI Chat: Start Remote Access**. A status bar item
   shows it is on. A card shows the link and a QR code:
   `https://<mac>.<tailnet>.ts.net/#k=<secret>`.
3. On the phone, open the link. The page swaps the secret for a cookie and
   removes it from the address bar. Add the page to the home screen.
4. Pick a chat from the list. It shows the conversation as on the desktop,
   and you can use it. The phone stays paired until you remove it.
5. Next time: Tailscale on, tap the icon. No new link.

The page is served by the extension on the Mac, so it always connects back to
the address it was loaded from. There is nothing to configure in the page.

## Architecture

```
phone browser ──HTTPS (tailnet, WireGuard)──> tailscale serve ──> 127.0.0.1:PORT
                                                                   │
                                                  remoteServer.ts (node:http, SSE + POST)
                                                                   │
                                  ChatSession (one per chat) ◄── sinks: desktop webview, remote clients
```

The remote page is the existing chat UI (`media/webview.js`, `webview.css`)
plus a shim that implements `acquireVsCodeApi()`:

- `postMessage` sends `POST /api/chats/:id/message`.
- Incoming messages arrive over `EventSource` and are dispatched as `message`
  events, so `webview/main.ts` runs unchanged.
- `getState`/`setState` use `localStorage`.

### Modules

Pure (no `vscode` import, unit-tested with `node --test`), in `src/remote/`:

| File | What it does |
| --- | --- |
| `remoteAuth.ts` | Random tokens, device records (hash only), cookie format and parsing, constant-time compare, attempt rate limit. |
| `remotePolicy.ts` | Which webview messages a remote device may send, and their cleaned shapes. |
| `eventLog.ts` | Per-chat numbered log of messages posted to the UI, bounded; answers "everything after seq N" or "snapshot plus tail". |
| `remoteServer.ts` | The HTTP server: routes, SSE with heartbeat, body limits, security headers, Host/Origin checks. Talks to chats through a small interface. |
| `remotePage.ts` | The HTML for the remote page (CSP, the two scripts, manifest link). |
| `tailscale.ts` | Finds the Tailscale CLI, reads `status --json`, builds the `serve` commands and the link. Command runner injected so it is testable. |

With `vscode`:

| File | What it does |
| --- | --- |
| `remote/remoteController.ts` | Start/Stop, status bar item, pairing card and QR, device list, notifications, owns the server. |
| `chatSession.ts` | Sinks instead of one `host` (below). |
| `chatViewProvider.ts` | Lists open chats (id, title, busy) for the server and tells it when they change. |
| `webview/remoteShim.ts` | Built to `media/remoteShim.js`; loaded before `webview.js`. |

### Sinks in `ChatSession`

Today `ChatSession` has one `host` (a `vscode.Webview`) and `onMessage(msg,
source)` assumes a webview. Change to:

- `interface UiTarget { postMessage(msg: unknown): void | Thenable<unknown> }`.
- A set of targets. `post()` records into the transcript once and sends to
  every ready target. The desktop webview is one target, each remote
  connection another.
- Per-target `ready` state. A target's `ready` message resyncs only that
  target (`resyncWebview(target)`).
- `onMessage(msg, source, origin)`, where `origin` is `desktop` or a device id.
  The existing switch stays; remote messages pass `remotePolicy` first.
- `addRemoteTarget(target): Disposable` and a chat id that is stable for the
  life of the tab (the engine session id can change).

Approvals already resolve once and `approvalResolved` removes the card on
every screen, so whoever answers first wins. Same for questions.

### Protocol

- `GET /` remote page. `GET /static/*` the two scripts, CSS, manifest, icon.
- `POST /api/pair` `{secret}` sets the device cookie. Fragment secret never
  leaves the browser except in this one request.
- `GET /api/chats` list: `[{id, title, busy}]`, with `GET /api/chats/events`
  (SSE) to learn when it changes.
- `GET /api/chats/:id/events` SSE. Every message has `id: <seq>`.
  - No `Last-Event-ID` (first load): snapshot (`transcript.replay()`), then
    live.
  - With `Last-Event-ID: N` still in the log: only messages after N.
  - Too old or after a desktop reload: snapshot, then live. The snapshot is
    state-aware (latest `ready`, config and context, open approvals and
    questions), so it never starts in the middle of a card.
  - A comment line every 15 s keeps the connection open through proxies.
- `POST /api/chats/:id/message` one message from the page. Body limit equals
  the existing image and prompt limits plus a small margin. Reply `204`, or
  `403` when the policy rejects it.

When the phone's browser is suspended and the page is reloaded, `EventSource`
reconnects by itself with `Last-Event-ID` and the page catches up. Nothing is
re-paired. The server never trusts the client's sequence number for anything
but choosing what to send.

## Security

Approving a command from a phone is code execution on the Mac. If a link
leaks, the damage is the same as someone sitting at the Mac, so:

- Off by default and per VS Code session: remote access starts only from the
  command (or `kiroCliChat.remote.autoStart`, off by default). The setting is
  machine-scoped and ignored in an untrusted workspace.
- The server binds to `127.0.0.1` only. Tailscale is the only way in. No
  option to bind elsewhere.
- Pairing: 256-bit random secret in the fragment, shown only on the desktop,
  valid for 10 minutes and one use. The device then gets its own random
  secret as an `HttpOnly; Secure; SameSite=Strict` cookie; the extension
  stores only its hash. Constant-time compare. Pairing attempts are rate
  limited. A desktop notification says a device paired ("Pixel 8, Chrome").
- "Remove device" and "Stop Remote Access" invalidate cookies at once.
- Every request needs the cookie; `POST` and SSE also check `Origin` against
  the page's own origin. The remote CSP forbids inline script and style and
  third-party loads (same rule as the desktop webview).
- What a remote device may do (`remotePolicy.ts`, an allow-list; anything
  else is rejected and logged):
  - `ready`, `sendPrompt`, `steerPrompt`, `cancelTurn`, `answerQuestion`,
    `getContextBreakdown`, `compact`, `setMode`.
  - `approve` with Allow once, Deny, or Deny with a reason. The `rule` and
    `folder` fields are dropped, so no allow rules are created from a phone.
  - `setConfig` for model and effort only. Never Autopilot (`setAutoApprove`).
  - Never: `login`, `newTab`, `restart`, `newSession`, `resumeSession`,
    `loadSession`, `pickAttachment`, `attachPaths`, `debugLog`.
- A setting, `kiroCliChat.remote.permissions` (`view`, `prompt`, `approve`),
  limits a device further. Default: all three, because approving is the point.
- Text from the phone is untrusted like text from the webview: it goes through
  the same cleaners (`cleanAnswer`, `cleanSteer`, `sanitizeImages`,
  `cleanReason`) and size limits.
- Logs name the device and the message type, never prompts or secrets.

## Tailscale integration

`tailscale.ts` supports the macOS app and the standalone CLI.

1. Find the CLI: `tailscale` on PATH, or the app bundle's binary.
2. `status --json`: must be `Running`; read this machine's DNS name
   (MagicDNS). If it is not running or not logged in, the controller says what
   to do and does not start.
3. Expose the local port over HTTPS with `tailscale serve` in the background
   and record that it was this extension that did. HTTPS certificates must be
   enabled for the tailnet (a one-time admin console switch); detect the
   error and say so.
4. On Stop, remove only the serve entry the extension created, not the
   user's other serve settings.
5. Build the link `https://<dns-name>/#k=<secret>` for the card and QR.

Exact `serve` flags differ between Tailscale versions and must be checked
against the installed client before coding (`tailscale serve --help`); the
command lines are built in one place and tested as strings.

If the CLI is not found, the card shows the link for the local port and the
manual steps instead.

## Mobile UI

The webview is built for VS Code. Work for a phone browser:

- Color fallbacks for `--vscode-*` variables in `media/remote.css`: light and
  dark through `prefers-color-scheme`, loaded only on the remote page.
- Viewport meta, `visualViewport`-aware composer so the keyboard does not
  cover it, safe-area insets, 44 px touch targets, a toolbar that wraps or
  collapses into a menu.
- Chat picker as the first screen when more than one chat is open.
- A "Connection lost, reconnecting" bar driven by `EventSource` errors.
- Web app manifest and icon for add to home screen.
- Not on the remote page: Resume panel, Settings (Autopilot, memory),
  attach-file picker. Pasting and the phone's image picker work.

## Settings and commands

- Commands: **Start Remote Access**, **Stop Remote Access**, **Show Remote
  Access Link** (new pairing code), **Remove Remote Device…**.
- Settings: `kiroCliChat.remote.autoStart` (false),
  `kiroCliChat.remote.permissions` (`["view","prompt","approve"]`),
  `kiroCliChat.remote.port` (0 = pick a free port). All machine-scoped and
  restricted in an untrusted workspace (add to `package.json`
  `restrictedConfigurations`).
- Status bar: `$(broadcast) Remote: 1 device`; click opens the card.

## Pull requests

Each is its own branch and PR; each ends with compile, lint, tests, package.

1. **Sinks in ChatSession** (no new feature). `UiTarget`, the target set,
   per-target resync, `origin` on messages. Existing tests unchanged; add
   tests for two targets (both get events, a late one resyncs, an approval
   answered by one removes the card on the other).
2. **Remote core, pure.** `remoteAuth`, `remotePolicy`, `eventLog`,
   `remoteServer`, `remotePage` with tests: pairing (valid, reused, expired,
   rate limit), cookie checks, Origin checks, policy table (each message
   type), SSE replay (fresh, delta, too old), body limits. Server tested over
   real localhost sockets with a fake chat.
3. **Wire it in** (localhost only, no Tailscale yet). `remoteController`,
   commands, status bar, settings, shim, pairing card (link, no QR yet), the
   chat list. Manual: open the link in a desktop browser, chat from both.
4. **Mobile layout and install.** `remote.css`, composer and toolbar fixes,
   reconnect bar, manifest. Manual on the phone over the home Wi-Fi first
   through a temporary `serve`.
5. **Tailscale.** `tailscale.ts`, serve on Start and cleanup on Stop, the link
   with the MagicDNS name, errors for the not-running, not-logged-in and
   HTTPS-not-enabled cases, docs for setup. Manual on cellular (T-Mobile) with
   Tailscale on: connect, background the browser for a few minutes, reopen,
   catch up, approve a command.
6. **QR code.** Needs a small encoder (about 300 lines, written here and
   tested against known vectors; no dependency unless you say otherwise).
7. **Docs and release notes.** README (setup, security, limits), TEST.md
   "Remote control", ARCHITECTURE (module map, protocol), CHANGELOG, a
   `remote-control` entry in the `add-chat-feature` skill checklist.

PRs 1 and 2 are the bulk of the risk and are fully testable without a phone.

## Testing

- Automated: pure modules as above, and one end-to-end test that starts the
  server on `127.0.0.1:0` with a fake chat, pairs, subscribes, posts messages
  and checks allow-list rejections and reconnect catch-up.
- Manual (TEST.md): pair; list chats; send, steer, stop; approve and deny from
  the phone while the desktop also shows the card (the desktop card goes away);
  a question; background the phone browser and reopen; stop access and
  confirm the old cookie gets 401; remove a device; start with Tailscale off.
- Not verifiable without your devices: behavior on T-Mobile, iOS or Android
  browser quirks, Tailscale flags on your version.

## Risks and unknowns

- Tailscale CLI path and `serve` syntax on this Mac. To check at PR 5.
- Mobile browsers kill background connections. Catch-up covers this; a long
  background period just means a snapshot on return.
- The Mac sleeping ends access. A keep-awake option (`caffeinate` while remote
  access is on and a reply runs) can be added after PR 5.
- The log is bounded. The default of 2000 messages per chat is a guess.
- The webview code assumes a VS Code host in a few places (colors, panel
  click handling). PR 4 will find the rest.

## Decisions to confirm

1. A paired phone stays paired until removed (proposed), instead of pairing
   again each time remote access starts.
2. Approvals from the phone are allowed by default once remote access is on.
3. Only Allow once, Deny and Deny with a reason from the phone; no allow
   rules, no Autopilot toggle.
4. Mirror chats open on the desktop only; starting chats from the phone comes
   later.
