// Webview frontend (browser context). Bundled to media/webview.js by esbuild.
// Communicates with the extension host via postMessage. This file starts the
// UI, owns the busy/starting state and routes the host's messages; each part
// of the UI is its own module.

import type { ApprovalRequest } from "../types";
import { removeApprovalCard, renderApproval } from "./approvalCard";
import { clearAttachments, currentAttachments, initDropAndPaste, insertPaths, pushAttachment } from "./attachments";
import { CommandLike, handlePickerKeydown, hideHint, hidePicker, setCommands, updateHint, updatePicker } from "./commandPicker";
import {
  addCredits,
  compactDone,
  CtxBreakdown,
  initContextCard,
  refreshCtxCard,
  resetContext,
  showBreakdown,
  updateContextMeter,
} from "./contextCard";
import { addUserMessage, appendAssistant, finalizeAssistant, resetStreaming } from "./messages";
import { initResumePanel, isResumeOpen, renderResumeList, renderResumeLoading, SessionRow, toggleResumePanel } from "./resumePanel";
import { ConfigOptionLike, initSettingsPanel, setAutopilotChecked, updateSettings } from "./settingsPanel";
import { addToolCard, ChatEventLike, updateToolCard } from "./toolCards";
import { addSystem, autoGrow, byId, div, hidePanels, inputEl, messagesEl, scrollToBottom, state, vscode } from "./ui";

const statusEl = byId("status");
const sendBtn = byId("btn-send");

// --- send / input handling ---

function send(): void {
  const text = inputEl.value;
  const attachments = currentAttachments();
  if ((!text.trim() && attachments.length === 0) || state.busy || state.starting) {
    return;
  }
  vscode.postMessage({
    type: "sendPrompt",
    text,
    images: attachments.map((a) => ({ mimeType: a.mimeType, data: a.data, name: a.name })),
  });
  inputEl.value = "";
  clearAttachments();
  autoGrow();
  hideHint();
  // Sending a prompt dismisses any open Settings / Resume panel.
  hidePanels();
}

sendBtn.addEventListener("click", send);

inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
  // The command picker intercepts navigation keys when open.
  if (handlePickerKeydown(e)) {
    return;
  }
  const isEnter = e.key === "Enter";
  if (!isEnter) {
    return;
  }
  const wantSend = state.enterToSend ? !e.shiftKey : e.shiftKey;
  if (wantSend) {
    e.preventDefault();
    send();
  }
});

inputEl.addEventListener("input", () => {
  autoGrow();
  updatePicker();
  updateHint();
});

inputEl.addEventListener("blur", () => {
  // Delay so a click on a picker item registers first.
  setTimeout(hidePicker, 120);
});

initDropAndPaste();
initSettingsPanel();
initResumePanel();
initContextCard();

// Esc closes open panels.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hidePanels();
  }
});

// Toolbar buttons.
byId("btn-new-tab").addEventListener("click", () => vscode.postMessage({ type: "newTab" }));
// The extension asks for confirmation first, then sends "restarting".
byId("btn-restart").addEventListener("click", () => {
  vscode.postMessage({ type: "restart" });
});

// --- incoming messages from the extension host ---

window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as { type: string; [k: string]: unknown };
  switch (msg.type) {
    case "status":
      setStatus(String(msg.text ?? ""));
      // While starting up, mirror progress into the indicator label.
      if (state.starting) {
        setWorkingLabel(String(msg.text ?? "Starting up"));
      }
      break;
    case "ready":
      state.enterToSend = Boolean(msg.enterToSend ?? true);
      setAutopilotChecked(Boolean(msg.autopilot));
      setStarting(false);
      setStatus("");
      finalizeAssistant();
      setBusy(false);
      break;
    case "needLogin":
      setStarting(false);
      renderLogin();
      break;
    case "fatal":
      setStarting(false);
      setStatus("Error");
      addSystem(String(msg.message ?? "Fatal error"), "error");
      break;
    case "error":
      addSystem(String(msg.message ?? "Error"), "error");
      setBusy(false);
      break;
    case "attachImage":
      pushAttachment(String(msg.name ?? "image"), String(msg.mimeType ?? ""), String(msg.data ?? ""));
      break;
    case "insertPaths":
      insertPaths((msg.paths as string[] | undefined) ?? []);
      break;
    case "notice":
      addSystem(String(msg.text ?? ""), msg.isError ? "error" : "");
      break;
    case "userMessage":
      addUserMessage(
        String(msg.text ?? ""),
        (msg.images as Array<{ mimeType: string; data: string; name?: string }>) ?? []
      );
      setBusy(true);
      break;
    case "openResume":
      if (!isResumeOpen()) {
        toggleResumePanel();
      }
      break;
    case "restarting":
      setStarting(true);
      break;
    case "cleared":
      messagesEl.innerHTML = "";
      resetStreaming();
      workingEl = undefined;
      resetContext();
      // If we're mid-startup (e.g. just after Restart), the clear wiped the
      // spinner bubble — re-show it so the "Starting up…" indicator persists.
      if (state.starting) {
        showWorking("Starting up");
      }
      break;
    case "sessionListLoading":
      renderResumeLoading();
      break;
    case "sessionList":
      renderResumeList((msg.sessions as SessionRow[]) ?? [], msg.error as string | undefined);
      break;
    case "event":
      handleEvent(msg.event as ChatEventLike);
      break;
    case "compactDone":
      addSystem(String(msg.message ?? ""), msg.ok ? "" : "error");
      compactDone();
      break;
    case "contextBreakdown":
      showBreakdown(msg.breakdown as CtxBreakdown | undefined, msg.error as string | undefined);
      break;
    default:
      break;
  }
});

function handleEvent(ev: ChatEventLike): void {
  switch (ev.kind) {
    case "sessionId":
      // Saved by VS Code with the tab/view, so a window reload reopens it.
      if (typeof ev.sessionId === "string") {
        vscode.setState({ sessionId: ev.sessionId });
      }
      break;
    case "runStarted":
      setBusy(true);
      break;
    case "assistantChunk":
      // First visible token: switch off the working/thinking indicator.
      hideWorking();
      appendAssistant(String(ev.text ?? ""));
      break;
    case "thinking":
      if (state.busy) {
        setWorkingLabel("Thinking");
      }
      break;
    case "userMessage":
      // Replayed past user prompt from a loaded session. Close any open
      // assistant bubble so each turn renders as its own pair of bubbles.
      finalizeAssistant();
      addUserMessage(String(ev.text ?? ""));
      break;
    case "toolCall":
      hideWorking();
      addToolCard(ev);
      break;
    case "toolUpdate":
      updateToolCard(ev);
      break;
    case "approvalRequest":
      renderApproval(ev.request as ApprovalRequest);
      break;
    case "approvalResolved":
      // Answered by a rule created for another approval (entire tool).
      if (removeApprovalCard(String(ev.toolCallId ?? ""))) {
        addSystem(String(ev.label ?? ""), "");
      }
      break;
    case "availableCommands":
      setCommands((ev.commands as CommandLike[]) ?? []);
      break;
    case "configOptions":
      updateSettings((ev.options as ConfigOptionLike[]) ?? []);
      break;
    case "contextUsage":
      updateContextMeter(
        Number(ev.usagePercentage ?? 0),
        ev.usedTokens as number | undefined,
        ev.threshold as number | undefined
      );
      break;
    case "metering":
      addCredits(Number(ev.credits ?? 0));
      break;
    case "runFinished":
      finalizeAssistant();
      setBusy(false);
      break;
    case "turnCompletion":
      // Also sent for each turn replayed from a resumed session.
      finalizeAssistant();
      break;
    case "error":
      addSystem(String(ev.message ?? "Error"), "error");
      setBusy(false);
      break;
    default:
      break;
  }
}

function renderLogin(): void {
  setStatus("Not logged in");
  const card = div("login-card");
  const p = div("");
  p.textContent = "You are not logged in to Kiro CLI.";
  const b = document.createElement("button");
  b.textContent = "Log in";
  b.addEventListener("click", () => vscode.postMessage({ type: "login" }));
  card.appendChild(p);
  card.appendChild(b);
  messagesEl.appendChild(card);
}

// --- busy / starting state ---

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function setBusy(b: boolean): void {
  state.busy = b;
  sendBtn.toggleAttribute("disabled", b);
  sendBtn.classList.toggle("busy", b);
  // Keep the hover card's Compact button in step with the reply state.
  refreshCtxCard();
  if (b) {
    showWorking("Working");
  } else {
    hideWorking();
  }
}

/**
 * Startup mode: disable all interaction and show a "Starting up…" indicator
 * until the engine is ready (or needs login / fails).
 */
function setStarting(on: boolean): void {
  state.starting = on;
  const controls = ["btn-resume", "btn-restart", "btn-settings", "btn-send"];
  for (const id of controls) {
    byId(id).toggleAttribute("disabled", on);
  }
  inputEl.toggleAttribute("disabled", on);
  if (on) {
    // Close any open panels while starting.
    hidePanels();
    showWorking("Starting up");
  } else {
    hideWorking();
  }
}

/** Animated "Working/Thinking" indicator shown while awaiting a response. */
let workingEl: HTMLElement | undefined;

function showWorking(label: string): void {
  if (!workingEl) {
    workingEl = div("msg working");
    const spin = document.createElement("span");
    spin.className = "spinner";
    const txt = document.createElement("span");
    txt.className = "working-label";
    txt.textContent = label + "…";
    workingEl.appendChild(spin);
    workingEl.appendChild(txt);
    messagesEl.appendChild(workingEl);
    scrollToBottom();
  } else {
    setWorkingLabel(label);
  }
}

function setWorkingLabel(label: string): void {
  const txt = workingEl?.querySelector(".working-label");
  if (txt) {
    txt.textContent = label + "…";
  }
}

function hideWorking(): void {
  if (workingEl) {
    workingEl.remove();
    workingEl = undefined;
  }
}

// Enter startup mode (disables UI, shows "Starting up…") until the engine is
// ready, then signal readiness to the host.
setStarting(true);
vscode.postMessage({ type: "ready" });
