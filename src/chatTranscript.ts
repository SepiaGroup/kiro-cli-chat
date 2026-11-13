// What a webview chat has shown, kept so a re-created webview can be restored
// (VS Code rebuilds the webview when the panel view is moved, and a tab's
// webview after a reload). Pure (no vscode import).

/** Most messages kept; older ones are dropped. */
export const MAX_TRANSCRIPT = 20000;

type Msg = {
  type?: string;
  event?: { kind?: string; toolCallId?: string; request?: { toolCallId?: string }; question?: { toolCallId?: string } };
};

export class ChatTranscript {
  private messages: unknown[] = [];
  // Latest state snapshots: only the newest one matters.
  private lastReady?: unknown;
  private lastConfig?: unknown;
  private lastCommands?: unknown;
  private lastContext?: unknown;

  /** Record a message posted to the webview. */
  record(msg: unknown): void {
    const m = msg as Msg;
    switch (m?.type) {
      case "ready":
        this.lastReady = msg;
        break;
      case "cleared":
        this.messages = [];
        break;
      case "userMessage":
      case "error":
      case "notice":
        this.messages.push(msg);
        break;
      case "event": {
        const kind = m.event?.kind;
        if (kind === "configOptions") {
          this.lastConfig = msg;
        } else if (kind === "availableCommands") {
          this.lastCommands = msg;
        } else if (kind === "contextUsage") {
          this.lastContext = msg;
        } else {
          if (kind === "approvalResolved") {
            // Answered by a rule: no card to restore.
            this.dropApprovalCard(m.event?.toolCallId ?? "");
          }
          if (kind === "questionResolved") {
            this.dropQuestionCard(m.event?.toolCallId ?? "");
            break; // nothing to show for it on restore
          }
          this.messages.push(msg);
        }
        break;
      }
      default:
        break;
    }
    if (this.messages.length > MAX_TRANSCRIPT) {
      this.messages.splice(0, this.messages.length - MAX_TRANSCRIPT);
    }
  }

  /** Once answered, don't bring an approval card back on restore. */
  dropApprovalCard(toolCallId: string): void {
    this.messages = this.messages.filter((msg) => {
      const m = msg as Msg;
      return !(m.type === "event" && m.event?.kind === "approvalRequest" && (m.event.request?.toolCallId ?? "") === toolCallId);
    });
  }

  /** Same for the agent's questions. */
  dropQuestionCard(toolCallId: string): void {
    this.messages = this.messages.filter((msg) => {
      const m = msg as Msg;
      return !(m.type === "event" && m.event?.kind === "question" && (m.event.question?.toolCallId ?? "") === toolCallId);
    });
  }

  /** Messages to post to a new webview, in order. */
  replay(): unknown[] {
    const out: unknown[] = [];
    if (this.lastReady) {
      out.push(this.lastReady);
    }
    out.push(...this.messages);
    for (const msg of [this.lastConfig, this.lastCommands, this.lastContext]) {
      if (msg) {
        out.push(msg);
      }
    }
    return out;
  }
}
