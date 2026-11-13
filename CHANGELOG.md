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
- Optional (`kiroCliChat.shareEditorContext`, off by default): tell the agent
  which files are open and which is active.
- Model, mode, effort and Autopilot switching; context breakdown and
  compaction; Resume; images; slash commands.
