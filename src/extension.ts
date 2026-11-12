// Extension entry point.

import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider";
import { TerminalChat } from "./terminal/terminalChat";

export function activate(context: vscode.ExtensionContext): void {
  // `log: true` also persists the channel to the extension's log folder, which
  // makes field diagnostics (e.g. drag-and-drop) readable after the fact.
  const output = vscode.window.createOutputChannel("Kiro CLI Chat", { log: true });
  context.subscriptions.push(output);

  const provider = new ChatViewProvider(context, output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  context.subscriptions.push({ dispose: () => provider.dispose() });

  // Bring an open chat editor tab back after a window reload.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(ChatViewProvider.editorViewType, {
      deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: unknown) => {
        provider.adoptEditorPanel(panel, state as { sessionId?: string } | undefined);
      },
    })
  );

  registerTerminalChat(context, output);

  const openInPanel = async () => {
    await vscode.commands.executeCommand("kiroCliChat.chatView.focus");
  };
  // Open wherever the user prefers (kiroCliChat.openIn).
  const reveal = async () => {
    const where = vscode.workspace.getConfiguration("kiroCliChat").get<string>("openIn", "editor");
    if (where === "panel") {
      await openInPanel();
    } else {
      provider.openInEditor();
    }
  };

  // Always-visible entry point (the view itself can live in the panel or a
  // side bar, and may be closed, so this guarantees a way to reopen it).
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.text = "$(comment-discussion) Kiro Chat";
  statusItem.tooltip = "Open Kiro CLI Chat (⌘⇧K)";
  statusItem.command = "kiroCliChat.open";
  statusItem.show();
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("kiroCliChat.open", reveal),
    vscode.commands.registerCommand("kiroCliChat.openInEditor", () => provider.openInEditor()),
    vscode.commands.registerCommand("kiroCliChat.newChatTab", () => provider.newTab()),
    vscode.commands.registerCommand("kiroCliChat.openInPanel", openInPanel),
    vscode.commands.registerCommand("kiroCliChat.newSession", async () => {
      await reveal();
      await provider.confirmNewSession();
    }),
    vscode.commands.registerCommand("kiroCliChat.resumeSession", async () => {
      await reveal();
      provider.openResumePanel();
    }),
    vscode.commands.registerCommand("kiroCliChat.restart", async () => {
      await provider.confirmRestart();
    }),
    vscode.commands.registerCommand("kiroCliChat.login", async () => {
      await reveal();
      await provider.login();
    }),
    vscode.commands.registerCommand("kiroCliChat.attach", async () => {
      await reveal();
      await provider.pickAttachment();
    })
  );
}

export function deactivate(): void {
  // Subscriptions dispose automatically.
}

/**
 * Text-mode chats in the Terminal panel: a "Kiro Chat" terminal profile (shows
 * in the terminal "+" dropdown) and a command. Each terminal is independent.
 */
function registerTerminalChat(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  let count = 0;
  const makeOptions = (initialPrompt?: string): vscode.ExtensionTerminalOptions => {
    count++;
    const name = count === 1 ? "Kiro Chat" : `Kiro Chat ${count}`;
    return {
      name,
      pty: new TerminalChat(output, name, { initialPrompt, spawn: openChat }),
      iconPath: new vscode.ThemeIcon("comment-discussion"),
    };
  };
  // A new chat terminal in the panel (optionally starting with a task, for /spawn).
  function openChat(initialPrompt?: string): void {
    const terminal = vscode.window.createTerminal({
      ...makeOptions(initialPrompt),
      location: vscode.TerminalLocation.Panel,
    });
    terminal.show();
  }

  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider("kiroCliChat.terminal", {
      provideTerminalProfile: () => new vscode.TerminalProfile(makeOptions()),
    }),
    vscode.commands.registerCommand("kiroCliChat.newTerminalChat", () => openChat())
  );

  // Context key so Shift+Enter (→ newline) only applies to our terminals.
  const isChat = (t: vscode.Terminal | undefined): boolean =>
    !!t && (t.creationOptions as vscode.ExtensionTerminalOptions).pty instanceof TerminalChat;
  const update = (t: vscode.Terminal | undefined): void => {
    void vscode.commands.executeCommand("setContext", "kiroCliChat.terminalChatFocused", isChat(t));
  };
  update(vscode.window.activeTerminal);
  context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(update));
}
