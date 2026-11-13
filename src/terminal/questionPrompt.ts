// The terminal chat's prompt for the agent's questions. Numbered choices,
// or type your own answer: Enter sends, Esc skips. A choice with sub-options
// opens a checklist (number keys toggle, Enter sends). Questions that arrive
// while one is being answered wait in a queue.
// Pure (no vscode import): output and answers go through the host.

import { answerFor, recommendedIndex } from "../questions";
import type { Question, QuestionOption, RpcId } from "../types";
import { errorMessage } from "../format";
import { sanitize, style, visibleWidth } from "./ansi";
import { renderInline } from "./ansiMarkdown";

export interface QuestionHost {
  /** Print whole lines above the prompt. */
  print(text: string): void;
  /** Raw terminal output (the input line is redrawn in place). */
  write(s: string): void;
  cols(): number;
  /** Whether the engine can still be answered. */
  canRespond(): boolean;
  /** Send the answer (none = skipped); throws if it can't be sent. */
  respond(requestId: RpcId, answer: string | undefined): void;
}

interface PendingQuestion {
  question: Question;
  requestId?: RpcId;
  page: "main" | "subs";
  input: string;
  /** Characters on screen for the input line, to redraw it. */
  drawn: number;
  option?: QuestionOption;
  picked: boolean[];
}

const BELL = "\x07";
const PROMPT = "  Answer: ";

export class QuestionPrompt {
  private current?: PendingQuestion;
  private queue: PendingQuestion[] = [];

  constructor(private readonly host: QuestionHost) {}

  /** A question is on screen and takes the keyboard. */
  get active(): boolean {
    return this.current !== undefined;
  }

  enqueue(question: Question, requestId?: RpcId): void {
    const pending: PendingQuestion = { question, requestId, page: "main", input: "", drawn: 0, picked: [] };
    if (this.current) {
      this.queue.push(pending);
      return;
    }
    this.current = pending;
    this.showMain(pending);
  }

  /** Forget all questions (the turn ended or the engine went away). */
  clear(): void {
    this.current = undefined;
    this.queue = [];
  }

  /** The engine no longer waits for this question (cancelled). */
  dropped(requestId: RpcId): void {
    this.queue = this.queue.filter((q) => q.requestId !== requestId);
    if (this.current?.requestId === requestId) {
      this.host.write("\r\n");
      this.host.print("  " + style.gray("The question was cancelled."));
      this.current = undefined;
      this.next();
    }
  }

  handleKey(data: string): void {
    const q = this.current;
    if (!q) {
      return;
    }
    if (q.page === "subs") {
      this.handleSubsKey(q, data);
      return;
    }
    if (data === "\x1b" || data === "\x03") {
      this.host.write("\r\n");
      this.answer(undefined);
      return;
    }
    if (data.startsWith("\x1b")) {
      return; // arrows etc.: not supported in this one-line input
    }
    for (const ch of data) {
      if (ch === "\r" && data.length === 1) {
        this.host.write("\r\n");
        this.submit(q);
        return;
      }
      if (ch === "\x7f" || ch === "\b") {
        q.input = Array.from(q.input).slice(0, -1).join("");
      } else if (ch === "\x15") {
        q.input = "";
      } else if (ch === "\r" || ch === "\n" || ch === "\t") {
        q.input += " ";
      } else if (ch >= " ") {
        q.input += ch;
      }
    }
    this.drawInput(q);
  }

  private showMain(q: PendingQuestion): void {
    const { question, options } = q.question;
    const text = sanitize(question).split("\n").map(renderInline);
    const lines = [style.yellow("? ") + style.bold(text[0] ?? ""), ...text.slice(1).map((l) => "  " + l)];
    const rec = recommendedIndex(q.question);
    options.forEach((o, i) => {
      lines.push(
        `  ${style.bold(style.cyan(`[${i + 1}]`))} ${sanitize(o.title)}` +
          (i === rec ? style.gray(" (recommended)") : "") +
          (o.description ? "  " + style.gray(sanitize(o.description)) : "")
      );
    });
    const hint = options.length
      ? `Type a number or your own answer. Enter sends${rec >= 0 ? ` (empty = ${rec + 1})` : ""}, Esc skips.`
      : "Type your answer. Enter sends, Esc skips.";
    lines.push("  " + style.gray(hint));
    this.host.print(lines.join("\n"));
    q.page = "main";
    q.input = "";
    q.drawn = 0;
    this.drawInput(q);
  }

  /** Redraw the input line(s) in place. */
  private drawInput(q: PendingQuestion): void {
    const text = style.gray(PROMPT) + sanitize(q.input);
    let out = "";
    if (q.drawn > 0) {
      const rows = Math.ceil(q.drawn / Math.max(1, this.host.cols()));
      out += rows > 1 ? `\x1b[${rows - 1}A` : "";
      out += "\r\x1b[J";
    }
    q.drawn = visibleWidth(text) || 1;
    this.host.write(out + text);
  }

  private submit(q: PendingQuestion): void {
    const text = q.input.trim();
    const options = q.question.options;
    if (!text) {
      const rec = recommendedIndex(q.question);
      if (rec < 0) {
        this.host.write(BELL);
        this.drawInput(q);
        return;
      }
      this.choose(q, options[rec]);
      return;
    }
    const n = /^\d+$/.test(text) ? Number(text) : 0;
    if (n >= 1 && n <= options.length) {
      this.choose(q, options[n - 1]);
      return;
    }
    this.answer(text);
  }

  private choose(q: PendingQuestion, option: QuestionOption): void {
    if (!option.subOptions?.length) {
      this.answer(answerFor(option));
      return;
    }
    q.option = option;
    q.page = "subs";
    q.picked = option.subOptions.map(() => true);
    this.showSubs(q);
  }

  private showSubs(q: PendingQuestion): void {
    const option = q.option;
    if (!option?.subOptions) {
      return;
    }
    const lines = [style.bold("  " + sanitize(option.subOptionsLabel || option.title))];
    option.subOptions.forEach((s, i) => {
      lines.push(
        `  ${style.bold(style.cyan(`[${i + 1}]`))} [${q.picked[i] ? style.green("x") : " "}] ${sanitize(s.title)}` +
          (s.description ? "  " + style.gray(sanitize(s.description)) : "")
      );
    });
    lines.push("  " + style.gray("Press a number to toggle. Enter sends, Esc goes back."));
    this.host.print(lines.join("\n"));
  }

  private handleSubsKey(q: PendingQuestion, data: string): void {
    const option = q.option;
    if (!option?.subOptions) {
      return;
    }
    if (data === "\x1b" || data === "\x03") {
      q.option = undefined;
      this.showMain(q);
      return;
    }
    if (data === "\r") {
      const picked = option.subOptions.filter((_, i) => q.picked[i]).map((s) => s.title);
      this.answer(answerFor(option, picked));
      return;
    }
    const i = /^[1-9]$/.test(data) ? Number(data) - 1 : -1;
    if (i < 0 || i >= q.picked.length) {
      this.host.write(BELL);
      return;
    }
    q.picked[i] = !q.picked[i];
    this.showSubs(q);
  }

  /** Send the answer (none = skip), print it, and show the next waiting question. */
  private answer(text: string | undefined): void {
    const q = this.current;
    if (!q) {
      return;
    }
    if (q.requestId === undefined || !this.host.canRespond()) {
      this.host.print(style.red("  Can't answer this question (the engine isn't waiting for it any more)."));
      this.current = undefined;
      this.next();
      return;
    }
    try {
      this.host.respond(q.requestId, text);
    } catch (err) {
      this.host.print("  " + style.red(errorMessage(err)));
      return;
    }
    this.current = undefined;
    this.host.print("  " + (text ? style.green(`→ You answered: ${sanitize(text)}`) : style.gray("→ Skipped")));
    this.next();
  }

  private next(): void {
    this.current = this.queue.shift();
    if (this.current) {
      this.showMain(this.current);
    }
  }
}
