// The toolbar's context meter and its hover card (breakdown, credits,
// Compact). Browser context.

import { byId, state, vscode } from "./ui";

const ctxMeterEl = byId("ctx-meter");
const ctxTextEl = byId("ctx-text");
const ctxRingEl = byId("ctx-ring-fg") as unknown as SVGCircleElement;
const ctxCardEl = byId("ctx-card");
const RING_LEN = 2 * Math.PI * 8;
let sessionCredits = 0;


/** Tokens in thousands, always with a unit: 0K, 0.8K, 16.2K, 1.2M. */
function fmtK(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(1) + "M";
  }
  const k = n / 1000;
  return (k === 0 ? "0" : k < 10 ? k.toFixed(1) : k.toFixed(0)) + "K";
}

let lastCtx = { pct: 0, usedTokens: undefined as number | undefined, threshold: undefined as number | undefined };

export function updateContextMeter(pct: number, usedTokens?: number, threshold?: number): void {
  lastCtx = { pct, usedTokens, threshold };
  ctxMeterEl.classList.remove("hidden");
  ctxTextEl.textContent = `${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}%`;
  const frac = Math.max(0, Math.min(1, pct / 100));
  ctxRingEl.style.strokeDasharray = `${frac * RING_LEN} ${RING_LEN}`;
  const level = threshold && pct >= threshold ? "full" : pct >= 60 ? "high" : "ok";
  ctxMeterEl.dataset.level = level;
  if (!ctxCardEl.classList.contains("hidden")) {
    requestCtxBreakdown();
  }
}

// Hover card with the context breakdown (fetched from the engine on demand).
interface CtxGroup {
  tokens?: number;
  percent?: number;
  mcp?: CtxGroup;
  builtin?: CtxGroup;
}

export type CtxBreakdown = Record<string, CtxGroup>;

// Rows shown in the hover card. Kiro's built-in tool definitions (~5K tokens,
// fixed for a given agent) are left out; MCP servers are shown on their own.
const CTX_ROWS: Array<[string, (b: CtxBreakdown) => Array<CtxGroup | undefined>]> = [
  ["Conversation", (b) => [b.yourPrompts, b.kiroResponses]],
  ["MCP servers", (b) => [b.tools?.mcp]],
  ["Steering & context files", (b) => [b.contextFiles]],
  ["Session files", (b) => [b.sessionFiles]],
  ["Memory", (b) => [b.memory]],
];

/**
 * Context window size implied by the header meter. The engine's per-category
 * percentages use a different denominator, so rows are recomputed from tokens
 * against this to stay consistent with the header.
 */
function ctxWindowTokens(): number | undefined {
  const { pct, usedTokens } = lastCtx;
  return usedTokens && pct > 0 ? usedTokens / (pct / 100) : undefined;
}

let ctxCardTimer: number | undefined;
let compacting = false;
let lastBreakdown: { breakdown?: CtxBreakdown; error?: string } | undefined;

export function requestCtxBreakdown(): void {
  vscode.postMessage({ type: "getContextBreakdown" });
}

function showCtxCard(): void {
  window.clearTimeout(ctxCardTimer);
  if (ctxCardEl.classList.contains("hidden")) {
    renderCtxCard(undefined, undefined, true);
    ctxCardEl.classList.remove("hidden");
    requestCtxBreakdown();
  }
}

export function hideCtxCard(): void {
  window.clearTimeout(ctxCardTimer);
  ctxCardEl.classList.add("hidden");
}

function hideCtxCardSoon(): void {
  window.clearTimeout(ctxCardTimer);
  ctxCardTimer = window.setTimeout(hideCtxCard, 150);
}

export function renderCtxCard(breakdown?: CtxBreakdown, error?: string, loading = false): void {
  ctxCardEl.innerHTML = "";
  const head = document.createElement("div");
  head.className = "ctx-card-head";
  const used = lastCtx.usedTokens ? ` · ${fmtK(lastCtx.usedTokens)} tokens` : "";
  head.textContent = `Context window ${lastCtx.pct.toFixed(1)}% used${used}`;
  ctxCardEl.appendChild(head);
  if (loading || error || !breakdown) {
    const note = document.createElement("div");
    note.className = "ctx-card-note";
    note.textContent = loading ? "Loading breakdown…" : error ? `Breakdown unavailable: ${error}` : "";
    ctxCardEl.appendChild(note);
  } else {
    const windowTokens = ctxWindowTokens();
    for (const [label, pick] of CTX_ROWS) {
      const groups = pick(breakdown).filter((g): g is CtxGroup => Boolean(g));
      if (groups.length === 0) {
        continue;
      }
      const tokens = groups.reduce((n, g) => n + (g.tokens ?? 0), 0);
      const percent = windowTokens
        ? (tokens / windowTokens) * 100
        : groups.reduce((n, g) => n + (g.percent ?? 0), 0);
      const row = document.createElement("div");
      row.className = "ctx-card-row";
      const name = document.createElement("span");
      name.textContent = label;
      const bar = document.createElement("span");
      bar.className = "ctx-card-bar";
      const fill = document.createElement("span");
      fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
      bar.appendChild(fill);
      const val = document.createElement("span");
      val.className = "ctx-card-val";
      val.textContent = `${percent.toFixed(1)}% · ${fmtK(tokens)}`;
      row.append(name, bar, val);
      ctxCardEl.appendChild(row);
    }
  }
  if (sessionCredits > 0) {
    const foot = document.createElement("div");
    foot.className = "ctx-card-note";
    foot.textContent = `${sessionCredits.toFixed(2)} credits used this session`;
    ctxCardEl.appendChild(foot);
  }
  const actions = document.createElement("div");
  actions.className = "ctx-card-actions";
  const btn = document.createElement("button");
  btn.className = "ctx-compact";
  btn.textContent = compacting ? "Compacting…" : "Compact context";
  btn.title = "Summarize the conversation so far to free context space";
  btn.disabled = compacting || state.busy || state.starting;
  btn.addEventListener("click", () => {
    compacting = true;
    btn.disabled = true;
    btn.textContent = "Compacting…";
    vscode.postMessage({ type: "compact" });
  });
  actions.appendChild(btn);
  if (state.busy && !compacting) {
    const note = document.createElement("span");
    note.className = "ctx-card-note";
    note.textContent = "Available when the reply finishes";
    actions.appendChild(note);
  }
  ctxCardEl.appendChild(actions);
}

export function addCredits(credits: number): void {
  if (credits > 0) {
    sessionCredits += credits;
    updateContextMeter(lastCtx.pct, lastCtx.usedTokens, lastCtx.threshold);
  }
}

export function initContextCard(): void {
  ctxMeterEl.addEventListener("mouseenter", showCtxCard);
  ctxMeterEl.addEventListener("mouseleave", hideCtxCardSoon);
  ctxMeterEl.addEventListener("focus", showCtxCard);
  ctxMeterEl.addEventListener("blur", hideCtxCardSoon);
  ctxMeterEl.addEventListener("click", () => (ctxCardEl.classList.contains("hidden") ? showCtxCard() : hideCtxCard()));
  ctxMeterEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideCtxCard();
    }
  });
  ctxCardEl.addEventListener("mouseenter", () => window.clearTimeout(ctxCardTimer));
  ctxCardEl.addEventListener("mouseleave", hideCtxCardSoon);
}

/** The chat was cleared: hide the meter and forget usage. */
export function resetContext(): void {
  sessionCredits = 0;
  lastCtx = { pct: 0, usedTokens: undefined, threshold: undefined };
  ctxMeterEl.classList.add("hidden");
  hideCtxCard();
}

/** Compaction finished: refresh the open card. */
export function compactDone(): void {
  compacting = false;
  if (!ctxCardEl.classList.contains("hidden")) {
    requestCtxBreakdown();
  }
}

/** The engine's breakdown arrived. */
export function showBreakdown(breakdown: CtxBreakdown | undefined, error: string | undefined): void {
  lastBreakdown = { breakdown, error };
  renderCtxCard(breakdown, error);
}

/** Redraw the open card (e.g. the Compact button after a reply ends). */
export function refreshCtxCard(): void {
  if (!ctxCardEl.classList.contains("hidden") && lastBreakdown) {
    renderCtxCard(lastBreakdown.breakdown, lastBreakdown.error);
  }
}
