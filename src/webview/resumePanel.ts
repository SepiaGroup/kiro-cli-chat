// The Resume panel: previous sessions for this folder. Browser context.

import { byId, hidePanels, registerPanel, vscode } from "./ui";

export interface SessionRow {
  sessionId: string;
  title?: string;
  updatedAt?: string;
  source?: string;
  messageCount?: number;
}

const resumePanelEl = byId("resume-panel");
const resumeListEl = byId("resume-list");

let resumeOpen = false;

export function initResumePanel(): void {
  registerPanel(hideResumePanel);
  const button = byId("btn-resume");
  button.addEventListener("click", () => toggleResumePanel());
  byId("resume-close").addEventListener("click", () => hideResumePanel());
  // Clicking anywhere outside the open panel (or its toolbar button) closes it.
  document.addEventListener("mousedown", (e) => {
    const t = e.target as Node | null;
    if (t && resumeOpen && !resumePanelEl.contains(t) && !button.contains(t)) {
      hideResumePanel();
    }
  });
}

export function isResumeOpen(): boolean {
  return resumeOpen;
}

export function toggleResumePanel(): void {
  if (resumeOpen) {
    hideResumePanel();
  } else {
    hidePanels();
    resumeOpen = true;
    resumePanelEl.classList.remove("hidden");
    renderResumeLoading();
    vscode.postMessage({ type: "resumeSession" });
  }
}

export function hideResumePanel(): void {
  resumeOpen = false;
  resumePanelEl.classList.add("hidden");
}

export function renderResumeLoading(): void {
  resumeListEl.innerHTML =
    '<div class="resume-loading"><span class="spinner"></span>Loading sessions…</div>';
}

/** Format an ISO timestamp as a short relative time, e.g. "3 min ago". */
function relativeTime(iso?: string): string {
  if (!iso) {
    return "";
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) {
    return "just now";
  }
  const mins = Math.round(secs / 60);
  if (mins < 60) {
    return `${mins} min ago`;
  }
  const hrs = Math.round(mins / 60);
  if (hrs < 24) {
    return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  }
  const days = Math.round(hrs / 24);
  if (days < 7) {
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
  return new Date(iso).toLocaleDateString();
}

export function renderResumeList(sessions: SessionRow[], error?: string): void {
  if (error) {
    resumeListEl.innerHTML = "";
    const e = document.createElement("div");
    e.className = "resume-empty";
    e.textContent = error;
    resumeListEl.appendChild(e);
    return;
  }
  if (sessions.length === 0) {
    resumeListEl.innerHTML =
      '<div class="resume-empty">No previous sessions for this folder.</div>';
    return;
  }

  resumeListEl.innerHTML = "";
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "resume-item";
    const untitled = !s.title || s.title === "New Session";
    if (untitled) {
      row.classList.add("resume-untitled");
    }

    const title = document.createElement("div");
    title.className = "resume-title";
    title.textContent = untitled ? "Untitled session" : (s.title as string);

    const meta = document.createElement("div");
    meta.className = "resume-meta";
    const parts = [relativeTime(s.updatedAt)];
    if (typeof s.messageCount === "number" && s.messageCount > 0) {
      parts.push(`${s.messageCount} msgs`);
    }
    meta.textContent = parts.filter(Boolean).join(" · ");

    // Full timestamp on hover.
    if (s.updatedAt) {
      row.title = new Date(s.updatedAt).toLocaleString();
    }

    row.appendChild(title);
    row.appendChild(meta);
    row.addEventListener("click", () => {
      vscode.postMessage({ type: "loadSession", sessionId: s.sessionId });
      hideResumePanel();
    });
    resumeListEl.appendChild(row);
  }
}
