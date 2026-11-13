// Manages the chat UIs: any number of editor-tab chats plus the bottom-panel
// view, each its own conversation (ChatSession) with its own engine.

import * as vscode from "vscode";
import { ChatSession, ChatSessionHooks } from "./chatSession";

/** Webview state saved per chat so a reload can reopen its session. */
interface ChatState {
  sessionId?: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "kiroCliChat.chatView";
  public static readonly editorViewType = "kiroCliChat.editor";

  private panelChat?: ChatSession;
  private readonly tabs = new Map<vscode.WebviewPanel, ChatSession>();
  private active?: ChatSession;
  private lastTab?: vscode.WebviewPanel;
  private tabCount = 0;
  private readonly changed = new vscode.EventEmitter<void>();
  /** The set of chats, or whether one is busy, changed (remote access lists them). */
  readonly onDidChangeChats = this.changed.event;
  private readonly hooks: ChatSessionHooks = {
    onActive: (chat) => {
      this.active = chat;
    },
    newTab: () => this.newTab(),
    changed: () => this.changed.fire(),
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  /** The bottom-panel chat: its own conversation, kept alive if the view is rebuilt. */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    resolveContext: vscode.WebviewViewResolveContext<ChatState>
  ): void {
    if (!this.panelChat) {
      this.panelChat = new ChatSession(
        this.context,
        this.output,
        "panel",
        this.hooks,
        sessionIdOf(resolveContext.state)
      );
    }
    const chat = this.panelChat;
    chat.attach(webviewView.webview);
    this.changed.fire();
    webviewView.onDidDispose(() => chat.detach(webviewView.webview));
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.active = chat;
      }
    });
    // Startup is triggered by the webview's "ready" message, once its message
    // listener is attached (avoids dropping early status events).
  }

  /** Reveal the most recent chat tab, or open one if there are none. */
  openInEditor(): void {
    const tab = this.lastTab ?? [...this.tabs.keys()].pop();
    if (tab) {
      tab.reveal(undefined, false);
      return;
    }
    this.newTab();
  }

  /** Open another chat tab with a new conversation. */
  newTab(): void {
    const n = ++this.tabCount;
    const panel = vscode.window.createWebviewPanel(
      ChatViewProvider.editorViewType,
      n === 1 ? "Kiro Chat" : `Kiro Chat ${n}`,
      { viewColumn: this.tabs.size > 0 ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
      }
    );
    this.adoptEditorPanel(panel);
  }

  /** Wire up a chat tab (new, or restored by VS Code after a reload). */
  adoptEditorPanel(panel: vscode.WebviewPanel, state?: ChatState): void {
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "icon.svg");
    // Keep numbering going after restored tabs ("Kiro Chat 3" -> next is 4).
    const num = /^Kiro Chat(?: (\d+))?$/.exec(panel.title);
    if (num) {
      this.tabCount = Math.max(this.tabCount, Number(num[1] ?? 1));
    }
    const chat = new ChatSession(
      this.context,
      this.output,
      panel.title,
      this.hooks,
      sessionIdOf(state)
    );
    this.tabs.set(panel, chat);
    this.changed.fire();
    this.active = chat;
    this.lastTab = panel;
    chat.attach(panel.webview);
    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.active = chat;
        this.lastTab = panel;
      }
    });
    panel.onDidDispose(() => {
      chat.dispose();
      this.tabs.delete(panel);
      this.changed.fire();
      if (this.active === chat) {
        this.active = undefined;
      }
      if (this.lastTab === panel) {
        this.lastTab = undefined;
      }
    });
  }

  /** The chat that commands (Restart, Attach, …) act on. */
  private target(): ChatSession | undefined {
    return this.active ?? (this.lastTab && this.tabs.get(this.lastTab)) ?? this.panelChat;
  }

  async confirmRestart(): Promise<void> {
    await this.target()?.confirmRestart();
  }

  async restart(): Promise<void> {
    await this.target()?.restart();
  }

  async pickAttachment(): Promise<void> {
    await this.target()?.pickAttachment();
  }

  async confirmNewSession(): Promise<void> {
    await this.target()?.confirmNewSession();
  }

  openResumePanel(): void {
    this.target()?.openResumePanel();
  }

  async login(): Promise<void> {
    await this.target()?.login();
  }

  /** Every open chat: the panel view's and each tab's. */
  chats(): ChatSession[] {
    return [...(this.panelChat ? [this.panelChat] : []), ...this.tabs.values()];
  }

  dispose(): void {
    this.changed.dispose();
    this.panelChat?.dispose();
    for (const chat of this.tabs.values()) {
      chat.dispose();
    }
    this.tabs.clear();
  }
}

function sessionIdOf(state: unknown): string | undefined {
  const id = (state as ChatState | undefined)?.sessionId;
  return typeof id === "string" && id ? id : undefined;
}
