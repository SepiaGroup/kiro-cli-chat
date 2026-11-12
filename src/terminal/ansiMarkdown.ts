// Streaming markdown → ANSI renderer for the terminal chat. Pure (no vscode).
//
// Text is streamed in chunks. The current (incomplete) line is shown raw as it
// arrives so output feels live; when its newline arrives, the raw line is
// erased and re-drawn formatted (bold, code, bullets, headings, code blocks…).

import { rowsBelowStart, sanitize, style, term, visibleWidth, wrapAnsi } from "./ansi";

export interface MdState {
  inCode: boolean;
  fence: string;
  lang: string;
}

export function newMdState(): MdState {
  return { inCode: false, fence: "", lang: "" };
}

/** Inline formatting: `code`, **bold**, *italic*, ~~strike~~, [links](url). */
export function renderInline(text: string): string {
  // Split out code spans first; nothing inside them is formatted.
  const parts = text.split(/(`[^`\n]+`)/);
  return parts
    .map((part) => {
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
        return style.cyan(part.slice(1, -1));
      }
      return formatEmphasis(part);
    })
    .join("");
}

function formatEmphasis(s: string): string {
  return (
    s
      // [text](https://url) → underlined text + dim url (VS Code auto-links it).
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_m, t: string, u: string) =>
        `${style.underline(t)} ${style.gray(`(${u})`)}`
      )
      .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, (_m, t: string) => style.bold(t))
      .replace(/(^|[^\w])__(?=\S)([^_\n]*?\S)__(?=[^\w]|$)/g, (_m, pre: string, t: string) => pre + style.bold(t))
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?=[^*\w]|$)/g, (_m, pre: string, t: string) => pre + style.italic(t))
      .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?=[^\w]|$)/g, (_m, pre: string, t: string) => pre + style.italic(t))
      .replace(/~~(?=\S)([^~\n]*?\S)~~/g, (_m, t: string) => style.strike(t))
      .replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, "$1")
  );
}

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;

/** Render one complete markdown line (no trailing newline). Mutates `state`. */
export function renderMarkdownLine(line: string, state: MdState, cols = 80): string {
  if (state.inCode) {
    if (line.trim().startsWith(state.fence)) {
      state.inCode = false;
      state.fence = "";
      state.lang = "";
      return style.gray("╰─");
    }
    return style.gray("│ ") + colorCodeLine(line, state.lang);
  }

  const fence = FENCE_RE.exec(line);
  if (fence) {
    state.inCode = true;
    state.fence = fence[1];
    state.lang = fence[2] ?? "";
    return style.gray("╭─" + (state.lang ? ` ${state.lang}` : ""));
  }

  const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) {
    const body = renderInline(heading[2]);
    return heading[1].length <= 2 ? style.bold(style.cyan(body)) : style.bold(body);
  }

  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
    return style.gray("─".repeat(Math.max(3, Math.min(cols - 1, 60))));
  }

  const quote = /^\s*>\s?(.*)$/.exec(line);
  if (quote) {
    return style.gray("│ ") + style.italic(renderInline(quote[1]));
  }

  const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
  if (task) {
    const box = task[2] === " " ? "☐" : style.green("☑");
    return `${task[1]}${box} ${renderInline(task[3])}`;
  }

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) {
    return `${bullet[1]}${style.cyan("•")} ${renderInline(bullet[2])}`;
  }

  const ordered = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line);
  if (ordered) {
    return `${ordered[1]}${style.cyan(ordered[2] + ordered[3])} ${renderInline(ordered[4])}`;
  }

  if (/^\s*\|/.test(line)) {
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)) {
      return style.gray(line.replace(/\|/g, "┼").replace(/-/g, "─"));
    }
    return line
      .split("|")
      .map((cell) => renderInline(cell))
      .join(style.gray("│"));
  }

  return renderInline(line);
}

function colorCodeLine(line: string, lang: string): string {
  const isDiff = lang === "diff" || lang === "patch";
  if (isDiff) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      return style.bold(line);
    }
    if (line.startsWith("+")) {
      return style.green(line);
    }
    if (line.startsWith("-")) {
      return style.red(line);
    }
    if (line.startsWith("@@")) {
      return style.cyan(line);
    }
  }
  return line;
}

/**
 * Stateful streaming renderer. `feed()` / `flush()` return the exact bytes to
 * write to the terminal. Assumes output starts at column 0.
 */
export class MarkdownStream {
  private state = newMdState();
  /** Raw text of the current line already shown on screen. */
  private partial = "";

  constructor(
    private readonly getCols: () => number,
    private readonly getRows: () => number = () => 24
  ) {}

  /** True when nothing is pending on the current line (cursor at column 0). */
  get atLineStart(): boolean {
    return this.partial.length === 0;
  }

  feed(chunk: string): string {
    const text = sanitize(chunk);
    let out = "";
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      if (nl < 0) {
        const rest = text.slice(start);
        if (rest) {
          this.partial += rest;
          out += rest;
        }
        return out;
      }
      const piece = text.slice(start, nl);
      out += this.completeLine(this.partial + piece, this.partial);
      this.partial = "";
      start = nl + 1;
    }
  }

  /** Finish the current line (if any) and close an unterminated code block. */
  flush(): string {
    let out = "";
    if (this.partial) {
      out += this.completeLine(this.partial, this.partial);
      this.partial = "";
    }
    if (this.state.inCode) {
      this.state = newMdState();
      out += style.gray("╰─") + "\r\n";
    }
    return out;
  }

  /** Forget any block state (e.g. a new assistant message). */
  reset(): void {
    this.state = newMdState();
    this.partial = "";
  }

  private completeLine(line: string, shownRaw: string): string {
    const cols = Math.max(1, this.getCols());
    let out = "";
    if (shownRaw) {
      const up = rowsBelowStart(visibleWidth(shownRaw), cols);
      if (up < this.getRows() - 1) {
        // Erase the raw preview of this line, then draw it formatted.
        out += "\r" + term.up(up) + term.clearToEnd;
      } else {
        // Too tall to rewrite safely (scrolled off): leave the raw text.
        renderMarkdownLine(line, this.state, cols); // keep block state in sync
        return "\r\n";
      }
    }
    out += this.formatLine(line, cols) + "\r\n";
    return out;
  }

  /** Render + word-wrap (prose only; code keeps the terminal's hard wrap). */
  private formatLine(line: string, cols: number): string {
    const wasCode = this.state.inCode;
    const rendered = renderMarkdownLine(line, this.state, cols);
    if (wasCode || this.state.inCode) {
      return rendered;
    }
    // Hanging indent under list markers / quotes so wrapped text lines up.
    const marker = /^(\s*)([-*+]\s+\[[ xX]\]|[-*+]|\d+[.)]|>)\s+/.exec(line);
    let indent = "";
    if (marker) {
      const isTask = /\[[ xX]\]/.test(marker[2]);
      const markerW = marker[2] === ">" ? 2 : isTask ? 2 : Array.from(marker[2]).length + 1;
      indent = " ".repeat(marker[1].length + markerW);
    }
    return wrapAnsi(rendered, cols, indent);
  }
}
