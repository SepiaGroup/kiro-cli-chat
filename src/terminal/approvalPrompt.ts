// The terminal chat's approval prompt, like the kiro-cli TUI: a first screen
// (y allow, t allow rule, n deny, Tab deny with a reason, d deny rule), a
// numbered rule screen, and a one-line input for a folder rule or a reason.
// Approvals that arrive while one is being answered wait in a queue.
// Pure (no vscode import): output and answers go through the host.

import { checkFolder, truncate as shorten } from "../approvalRules";
import { errorMessage } from "../format";
import type { ApprovalAnswer, ApprovalOption, ApprovalRequest, ChatEvent, RpcId } from "../types";
import { sanitize, style, visibleWidth } from "./ansi";

export interface ApprovalHost {
  /** Print whole lines above the prompt. */
  print(text: string): void;
  /** Raw terminal output (the input line is redrawn in place). */
  write(s: string): void;
  cols(): number;
  /** Whether the engine can still be answered. */
  canRespond(): boolean;
  /** Send the answer to the engine; throws if it can't be sent. */
  respond(requestId: RpcId, answer: ApprovalAnswer): void;
}

interface PendingApproval {
  request: ApprovalRequest;
  requestId?: RpcId;
  page: "main" | "allow" | "deny" | "folder" | "reason";
  input: string;
  /** Characters on screen for the input line, to redraw it. */
  drawn: number;
}

const BELL = "\x07";

export class ApprovalPrompt {
  private current?: PendingApproval;
  /** Approvals that arrived while another was being answered. */
  private queue: PendingApproval[] = [];

  constructor(private readonly host: ApprovalHost) {}

  /** An approval is on screen and takes the keyboard. */
  get active(): boolean {
    return this.current !== undefined;
  }

  /** Show a new approval, or queue it behind the one on screen. */
  enqueue(request: ApprovalRequest, requestId?: RpcId): void {
    const pending: PendingApproval = { request, requestId, page: "main", input: "", drawn: 0 };
    if (this.current) {
      this.queue.push(pending);
      return;
    }
    this.current = pending;
    this.showMain();
  }

  /** Forget all approvals (the turn ended or the engine went away). */
  clear(): void {
    this.current = undefined;
    this.queue = [];
  }

  /** A queued approval was answered by a rule created for another one. */
  resolved(ev: Extract<ChatEvent, { kind: "approvalResolved" }>): void {
    const q = this.queue.find((a) => a.requestId === ev.requestId);
    if (!q) {
      return;
    }
    this.queue = this.queue.filter((a) => a !== q);
    const mark = ev.allowed ? style.green("✓") : style.red("✗");
    this.host.print(`  ${mark} ${style.gray(sanitize(ev.label) + ": ")}${sanitize(q.request.part ?? q.request.question)}`);
  }

  /** Handle a key while an approval is on screen. */
  handleKey(data: string): void {
    const a = this.current;
    if (!a) {
      return;
    }
    if (a.page === "folder" || a.page === "reason") {
      this.handleInputKey(a, data);
      return;
    }
    const k = data.length === 1 ? data.toLowerCase() : data;
    if (a.page === "allow" || a.page === "deny") {
      this.handleRuleKey(a, a.page, k);
      return;
    }
    // First screen.
    if (k === "\x03" || k === "\x1b" || k === "n") {
      const deny = this.option("reject_once") ?? this.option("reject_always");
      if (deny) {
        this.answer({ optionId: deny.optionId }, deny.name || "Deny", false);
      }
      return;
    }
    if (k === "\t" && this.option("reject_once")) {
      this.startInput(a, "reason", "");
      return;
    }
    const allow = this.option("allow_once");
    if (k === "y" && allow) {
      this.answer({ optionId: allow.optionId }, allow.name || "Allow", true);
      return;
    }
    const effect = k === "t" ? "allow" : k === "d" ? "deny" : undefined;
    const opt = effect && this.option(effect === "allow" ? "allow_always" : "reject_always");
    if (effect && opt) {
      const rules = effect === "allow" ? a.request.allowRules : a.request.denyRules;
      if (rules?.length) {
        a.page = effect;
        this.showRules(effect);
      } else {
        this.answer({ optionId: opt.optionId }, opt.name, effect === "allow");
      }
      return;
    }
    this.host.write(BELL);
  }

  private option(kind: string): ApprovalOption | undefined {
    return this.current?.request.options.find((o) => o.kind === kind);
  }

  /** First screen: the question and y / t / n / Tab / d. */
  private showMain(): void {
    const r = this.current?.request;
    if (!r) {
      return;
    }
    const key = (k: string, label: string): string => `${style.bold(style.cyan(`[${k}]`))} ${label}`;
    const choices: string[] = [];
    const allow = this.option("allow_once");
    const deny = this.option("reject_once");
    const allowRule = this.option("allow_always");
    const denyRule = this.option("reject_always");
    // Allow choices first, then deny choices.
    if (allow) {
      choices.push(key("y", sanitize(allow.name || "Allow")));
    }
    if (allowRule) {
      choices.push(key("t", sanitize(allowRule.name)));
    }
    if (deny) {
      choices.push(key("n", sanitize(deny.name || "Deny")), key("Tab", "Deny with reason"));
    }
    if (denyRule) {
      choices.push(key("d", sanitize(denyRule.name)));
    }
    const lines = [style.yellow("? ") + style.bold(sanitize(r.question))];
    // A compound shell line is approved one command at a time; say which.
    if (r.part) {
      lines.push("  " + style.gray(r.round ? `command ${r.round}: ` : "command: ") + style.bold(sanitize(r.part)));
    }
    if (r.flag) {
      lines.push("  " + style.yellow("! ") + style.gray(sanitize(r.flag)));
    }
    lines.push("  " + choices.join("  "));
    this.host.print(lines.join("\n"));
  }

  /** Rule screen: numbered rules, like the TUI's "Create allow rule". */
  private showRules(effect: "allow" | "deny"): void {
    const r = this.current?.request;
    const rules = (effect === "allow" ? r?.allowRules : r?.denyRules) ?? [];
    const what = r?.resource ? `: "${shorten(r.resource)}"` : r?.tool ? `: ${r.tool}` : "";
    const width = Math.max(...rules.map((x) => x.label.length));
    const lines = [style.bold(`  Create ${effect} rule${sanitize(what)}`)];
    rules.forEach((rule, i) => {
      lines.push(
        `  ${style.bold(style.cyan(`[${i + 1}]`))} ${sanitize(rule.label.padEnd(width))}  ${style.gray(sanitize(rule.description))}`
      );
    });
    lines.push("  " + style.gray("Esc to go back"));
    this.host.print(lines.join("\n"));
  }

  private handleRuleKey(a: PendingApproval, effect: "allow" | "deny", k: string): void {
    if (k === "\x1b" || k === "\x03") {
      a.page = "main";
      this.showMain();
      return;
    }
    const rules = (effect === "allow" ? a.request.allowRules : a.request.denyRules) ?? [];
    const rule = /^[1-9]$/.test(k) ? rules[Number(k) - 1] : undefined;
    const opt = this.option(effect === "allow" ? "allow_always" : "reject_always");
    if (!rule || !opt) {
      this.host.write(BELL);
      return;
    }
    if (rule.kind === "folder" && rule.folder) {
      this.startInput(a, "folder", rule.folder.prefill);
      return;
    }
    this.answer({ optionId: opt.optionId, rule: rule.kind }, rule.label, effect === "allow");
  }

  private startInput(a: PendingApproval, page: "folder" | "reason", initial: string): void {
    a.page = page;
    a.input = initial;
    a.drawn = 0;
    this.drawInput(a);
  }

  /** Redraw the input line(s) in place. */
  private drawInput(a: PendingApproval): void {
    const prefix =
      a.page === "folder"
        ? "  " + style.gray("Folder to allow (Enter to allow, Esc to go back): ")
        : "  " + style.gray("Reason (Enter to deny, Esc to go back): ");
    const text = prefix + sanitize(a.input);
    let out = "";
    if (a.drawn > 0) {
      const rows = Math.ceil(a.drawn / Math.max(1, this.host.cols()));
      out += rows > 1 ? `\x1b[${rows - 1}A` : "";
      out += "\r\x1b[J";
    }
    a.drawn = visibleWidth(text) || 1;
    this.host.write(out + text);
  }

  private handleInputKey(a: PendingApproval, data: string): void {
    if (data === "\x1b" || data === "\x03") {
      // Back to the screen this input came from.
      this.host.write("\r\n");
      if (a.page === "folder") {
        a.page = "allow";
        this.showRules("allow");
      } else {
        a.page = "main";
        this.showMain();
      }
      return;
    }
    if (data.startsWith("\x1b")) {
      return; // arrows etc.: not supported in this one-line input
    }
    for (const ch of data) {
      if (ch === "\r" && data.length === 1) {
        this.host.write("\r\n");
        this.submitInput(a);
        return;
      }
      if (ch === "\x7f" || ch === "\b") {
        a.input = Array.from(a.input).slice(0, -1).join("");
      } else if (ch === "\x15") {
        a.input = "";
      } else if (ch === "\r" || ch === "\n" || ch === "\t") {
        a.input += " ";
      } else if (ch >= " ") {
        a.input += ch;
      }
    }
    this.drawInput(a);
  }

  private submitInput(a: PendingApproval): void {
    if (a.page === "reason") {
      const deny = this.option("reject_once");
      if (deny) {
        const reason = a.input.trim();
        this.answer({ optionId: deny.optionId, reason }, reason ? `Deny: ${reason}` : deny.name || "Deny", false);
      }
      return;
    }
    const rule = a.request.allowRules?.find((r) => r.kind === "folder");
    const opt = this.option("allow_always");
    if (!rule?.folder || !opt) {
      return;
    }
    const check = checkFolder(rule.folder, a.input);
    if (!check.ok) {
      this.host.print("  " + style.red(check.reason));
      this.drawInput(a);
      return;
    }
    this.answer({ optionId: opt.optionId, rule: "folder", folder: check.path }, `Trust folder ${check.path} and everything under it`, true);
  }

  /** Send the answer, print it, and show the next waiting approval. */
  private answer(answer: ApprovalAnswer, label: string, allowed: boolean): void {
    const a = this.current;
    if (!a) {
      return;
    }
    if (a.requestId === undefined || !this.host.canRespond()) {
      this.host.print(style.red("  Can't answer this request (the engine isn't waiting for it any more)."));
      this.next();
      return;
    }
    try {
      this.host.respond(a.requestId, answer);
    } catch (err) {
      this.host.print("  " + style.red(errorMessage(err)));
      return;
    }
    this.current = undefined;
    const text = sanitize(label);
    this.host.print("  " + (allowed ? style.green(`→ ${text}`) : style.red(`→ ${text}`)));
    this.next();
  }

  private next(): void {
    this.current = this.queue.shift();
    if (this.current) {
      this.showMain();
    }
  }
}
