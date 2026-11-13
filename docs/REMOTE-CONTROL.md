# Remote control: design proposal

Status: proposal, no code yet. For discussion before any work starts.

## Goal

The conversation keeps running on the desktop (VS Code and the Kiro engine on
the Mac). From a phone, tablet or any browser you can see the chat live,
answer approvals and questions, send prompts, stop a reply and steer it.

Constraints: free, nothing to host or support, safe enough that approving a
shell command from a phone is not a new way to get hurt.

Out of scope for the first version: terminal chats (they are not built on the
webview message protocol), running when VS Code is closed, push notifications.

## What the code already gives us

- The chat UI talks to the extension with plain JSON messages in both
  directions (`sendPrompt`, `approve`, `cancelTurn`, `steerPrompt`,
  `answerQuestion` and so on, and `event` messages back). Nothing else is
  shared between the two.
- `ChatTranscript` keeps what a webview has shown, and `resyncWebview` replays
  it into a freshly created webview. A phone that connects late or reconnects
  is the same problem.
- Messages from the webview are already treated as untrusted and validated.

So the plan is not a new UI. The same `media/webview.js` runs in a phone
browser, served by the extension, talking to the same `ChatSession`.

## Recommended design

### Transport: HTTP plus Server-Sent Events

- The extension runs a small HTTP server (Node `http`, no dependency) bound to
  `127.0.0.1` only.
- `GET /` and static files: the webview HTML, JS and CSS, plus a tiny shim that
  provides `acquireVsCodeApi()` (post = `POST`, receive = `EventSource`,
  `getState`/`setState` = `localStorage`).
- `GET /api/chats`: the open chats (id, title, busy).
- `GET /api/chats/:id/events`: SSE. Sends the transcript replay, then live
  messages. Each message has a sequence number; on reconnect the browser sends
  `Last-Event-ID` and gets only what it missed (full replay if too old).
- `POST /api/chats/:id/message`: one message from the browser, checked against
  an allow-list (below).
- SSE rather than WebSocket: no dependency (we would otherwise hand-write
  RFC 6455), reconnects by itself, and passes through every proxy and tunnel.

### Sessions: one chat, several screens

`ChatSession` has a single `host` webview today. Change it to a set of sinks
(desktop webview plus any number of remote clients): `post()` fans out,
inbound messages carry their source. Desktop and phone then show the same chat
at the same time. Approvals already resolve once (`approvalResolved` removes
the card elsewhere), so whoever answers first wins.

### Security

Approving a command from a phone is remote code execution on the Mac if the
link leaks, so this is the part to get right.

- Off by default. A command ("Kiro CLI Chat: Start Remote Access") and a
  status bar item show when it runs and how many devices are connected. The
  setting is machine-scoped and ignored in an untrusted workspace.
- Pairing: starting remote access makes a random 256-bit token. The pairing
  link carries it in the URL fragment (`/#k=...`, never sent to a server or
  logged). The page swaps it for an `HttpOnly; Secure; SameSite=Strict` cookie
  and removes the fragment. Constant-time comparison, rate-limited attempts,
  "Stop Remote Access" invalidates everything. A notification on the desktop
  says when a device pairs.
- Origin check on every `POST` and on the SSE request.
- Least privilege from a remote device: the message allow-list covers
  prompts, steering, cancel, approvals (Allow once and Deny only), questions,
  mode and model, compact, resume. It does not include allow rules for a whole
  tool, turning Autopilot on, restarting the engine, or anything that opens
  VS Code UI (file picker, login, new tab). Whether approvals are allowed at
  all can be a setting (`view` / `prompt` / `approve`).
- Reachability is a separate layer (next section), so the server itself never
  listens on a public interface by default.
- Limits already in place apply: image size, prompt size, `@file:` rules.

### Reaching the Mac from a phone: free options

| Option | Cost | Public? | Notes |
| --- | --- | --- | --- |
| Tailscale (recommended) | Free Personal plan: 6 users, unlimited devices, non-commercial | No, only your own devices | App on the Mac and the phone. `tailscale serve` puts HTTPS in front of the local port. Stable name, nothing exposed, nothing to run or patch. |
| Cloudflare Quick Tunnel | Free, no account or domain | Yes, random `trycloudflare.com` URL | Nothing to install on the phone. The URL changes every run, and anyone with it reaches the login page, so our token is the only protection. Good fallback. |
| VS Code port forwarding (Ports view) | Free with a GitHub login | Private by default (same GitHub login on the phone) | No extra install on the Mac. Manual: Forward a Port in the Ports view. I found no stable API for an extension to do it, so the extension could only tell you how. URL stability not checked. |
| Same Wi-Fi only | Free | LAN | Simplest; plain HTTP; only at home. Opt-in, bind to the LAN address. |
| Own relay (Workers, Firebase, ...) | Free tiers | Yes | Rejected: code to maintain, end-to-end encryption to build ourselves, free tier can change. |

My recommendation: Tailscale as the documented path, Quick Tunnel as the
"no app on the phone" alternative, LAN for a quick start. The extension does
not depend on any of them: it serves on localhost, and the README says how to
put each in front of it. Neither `tailscale` nor `cloudflared` is installed on
this Mac today.

Both free services depend on someone else's company staying free (Tailscale's
plan is for personal use; Cloudflare could change Quick Tunnels). Because the
extension only binds to localhost, switching is a documentation change.

### Mobile UI

The existing webview assumes VS Code. Work needed: a `--vscode-*` color
fallback (light and dark by `prefers-color-scheme`), viewport meta and
keyboard-aware layout, touch-sized buttons, a toolbar that fits, an add-to-
home-screen manifest. Not available remotely: file picker and drag-drop of
paths (paste and the phone's image picker work).

### Limits to accept

- VS Code must be open and the Mac awake. A "keep awake while a reply runs"
  option (`caffeinate`) is possible.
- No push notification. An approval waits until you look at the page. The
  free options (a public ntfy.sh topic) send data to a third party, so that is
  a separate decision, not part of the first version.
- Closing a chat tab on the desktop ends that chat for the phone too.

## Plan

1. Sinks refactor in `ChatSession` and the pure parts, with tests:
   `remoteAuth.ts` (token, cookie, compare, rate limit), `remotePolicy.ts`
   (message allow-list and shapes), `remoteServer.ts` (HTTP and SSE, no
   `vscode` import, tested with a fake session).
2. Wire into the extension: command, status bar, pairing notification, shim,
   settings. Works on `localhost` and LAN.
3. Mobile layout and manifest.
4. Docs for Tailscale, Quick Tunnel and Ports; QR code for the pairing link
   (needs a small encoder: ask before adding anything vendored).
5. Later, if wanted: terminal chats, remote-created chats without a tab,
   notifications.

Each step is its own PR. TEST.md gets a "Remote control" section; the
engine is unaffected.

## Open questions

1. Is Tailscale (an app on both devices, free for personal use) acceptable as
   the main path?
2. Should approvals from the phone be on by default once remote access is
   started, or opt in?
3. Mirror chats that are open on the desktop only, or also let the phone start
   a chat (no VS Code tab, same folder)?
4. Is the Mac normally awake with VS Code open when you would use this?
5. Do you want phone alerts for approvals badly enough to use a third-party
   push service?
