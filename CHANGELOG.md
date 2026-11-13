# Changelog

## 0.1.0 (unreleased)

First release.

- Chat with the Kiro CLI v3 engine in editor tabs, the panel, or a text-mode
  terminal chat, on Macs without AVX/AVX2.
- Approvals like kiro-cli: Allow, Create allow rule… (exact, command pattern,
  folder, entire tool), Deny, Deny with reason…, Create deny rule….
- The agent's questions (Spec mode) as a card or numbered choices, with your
  own answer or Skip. `@file:path` in a prompt attaches the file. A prompt the
  engine never answers is cancelled after 10 minutes.
- Remote access (preview): watch and use a chat tab from another browser,
  paired once with a link, on this Mac for now. Approvals can be allowed or
  denied once from the other screen; no rules, Autopilot or restart.
- A Stop button (and Esc) ends a reply in the chat tabs, as Esc does in the
  terminal chat. Send stays on during a reply and steers it.
- A failed prompt shows a short message with a hint (log in again, network,
  session). The engine's rate-limit warning shows as a red line and the reply
  carries on.
- Typing while the agent works sends your message to it (it reads it at its
  next step); in the terminal Esc takes back a message it hasn't read yet.
- Optional (`kiroCliChat.shareEditorContext`, off by default): tell the agent
  which files are open and which is active.
- Model, mode, effort and Autopilot switching; context breakdown and
  compaction; Resume; images; slash commands.
