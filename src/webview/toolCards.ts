// Tool call cards, terminal-style: title with paths, status with elapsed
// time, line-numbered diff and output. Browser context.

import { formatElapsed } from "../format";
import { diffLines } from "./lineDiff";
import { div, messagesEl, scrollToBottom } from "./ui";

export interface ChatEventLike {
  kind: string;
  [k: string]: unknown;
}

// Tool start times, for "Completed in Xs".
const toolStart = new Map<string, number>();

type DiffLike = { path?: string; oldText?: string | null; newText?: string };

/** Render the title with any known file paths highlighted (terminal-style). */
function renderToolTitle(el: HTMLElement, title: string, paths: string[]): void {
  el.textContent = "";
  const sorted = [...paths].sort((a, b) => b.length - a.length);
  let rest = title;
  while (rest.length > 0) {
    let hitIdx = -1;
    let hit = "";
    for (const p of sorted) {
      const idx = rest.indexOf(p);
      if (idx >= 0 && (hitIdx < 0 || idx < hitIdx)) {
        hitIdx = idx;
        hit = p;
      }
    }
    if (hitIdx < 0) {
      el.appendChild(document.createTextNode(rest));
      break;
    }
    el.appendChild(document.createTextNode(rest.slice(0, hitIdx)));
    const s = document.createElement("span");
    s.className = "tool-path";
    s.textContent = hit;
    el.appendChild(s);
    rest = rest.slice(hitIdx + hit.length);
  }
}

/** Build a line-numbered, colored diff like the terminal's edit preview. */
function renderToolDiff(card: Element, diff: DiffLike, startLine?: number): void {
  if (typeof diff.newText !== "string") {
    return;
  }
  card.querySelector(".tool-diff")?.remove();
  const lines = diffLines(diff.oldText ?? null, diff.newText);
  // Edits report snippets; shift numbers to real file lines when known.
  const offset = diff.oldText && startLine ? startLine - 1 : 0;
  const box = div("tool-diff");
  const shown = lines.slice(0, 400);
  for (const l of shown) {
    const row = div(`diff-line diff-${l.kind}`);
    const sign = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
    const num = l.lineNo !== undefined ? String(l.lineNo + offset) : "";
    const gutter = document.createElement("span");
    gutter.className = "diff-gutter";
    gutter.textContent = l.kind === "gap" ? "   ⋮" : `${sign} ${num.padStart(4)}:`;
    const text = document.createElement("span");
    text.className = "diff-text";
    text.textContent = l.kind === "gap" ? "" : " " + l.text;
    row.appendChild(gutter);
    row.appendChild(text);
    box.appendChild(row);
  }
  if (lines.length > shown.length) {
    const more = div("diff-line diff-gap");
    more.textContent = `… ${lines.length - shown.length} more lines`;
    box.appendChild(more);
  }
  const status = card.querySelector(".tool-status");
  card.insertBefore(box, status);
}


function setToolStatus(card: Element, id: string, statusRaw: string): void {
  const status = card.querySelector(".tool-status");
  if (!status) {
    return;
  }
  const s = statusRaw.toLowerCase();
  status.className = "tool-status";
  if (s === "completed" || s === "success") {
    const started = toolStart.get(id);
    status.textContent =
      started !== undefined ? `– Completed in ${formatElapsed(Date.now() - started)}` : "– Completed";
    status.classList.add("ok");
    toolStart.delete(id);
  } else if (s === "failed" || s === "error") {
    status.textContent = "– Failed";
    status.classList.add("fail");
    card.classList.add("failed");
    toolStart.delete(id);
  } else if (s === "in_progress") {
    status.textContent = "– Running…";
    status.classList.add("running");
  } else if (s) {
    status.textContent = `– ${statusRaw}`;
  }
}

export function addToolCard(ev: ChatEventLike): void {
  const id = String(ev.toolCallId ?? "");
  toolStart.set(id, Date.now());
  const card = div("tool");
  card.dataset.toolId = id;
  const paths = (ev.paths as string[] | undefined) ?? [];
  const title = div("tool-title");
  renderToolTitle(title, String(ev.title ?? "Tool"), paths);
  card.appendChild(title);
  // Show paths not already visible in the title.
  const titleText = String(ev.title ?? "");
  const extra = paths.filter((p) => !titleText.includes(p));
  if (extra.length > 0) {
    const p = div("tool-paths");
    p.textContent = extra.join(", ");
    card.appendChild(p);
  }
  const status = div("tool-status");
  status.textContent = "– Pending";
  card.appendChild(status);
  const diff = ev.diff as DiffLike | undefined;
  if (diff) {
    renderToolDiff(card, diff, ev.startLine as number | undefined);
  }
  messagesEl.appendChild(card);
  scrollToBottom();
}

export function updateToolCard(ev: ChatEventLike): void {
  const id = String(ev.toolCallId ?? "");
  const card = messagesEl.querySelector(`.tool[data-tool-id="${CSS.escape(id)}"]`);
  if (!card) {
    return;
  }
  const diff = ev.diff as DiffLike | undefined;
  if (diff) {
    renderToolDiff(card, diff, ev.startLine as number | undefined);
  }
  const output = ev.output as string | undefined;
  if (output) {
    let pre = card.querySelector(".tool-output") as HTMLPreElement | null;
    if (!pre) {
      pre = document.createElement("pre");
      pre.className = "tool-output";
      card.appendChild(pre);
    }
    pre.textContent = truncate(output, 4000);
  }
  if (ev.status) {
    setToolStatus(card, id, String(ev.status));
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\n…(truncated)" : s;
}
