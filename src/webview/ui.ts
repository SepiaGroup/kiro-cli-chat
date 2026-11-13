// Shared pieces of the webview UI: the VS Code API handle, the busy/starting
// state, the main elements and small DOM helpers. Browser context.

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

/** The extension host. `acquireVsCodeApi` may be called only once. */
export const vscode = acquireVsCodeApi();

/** Chat state read by several parts of the UI; main.ts changes it. */
export const state = {
  /** A reply is running. */
  busy: false,
  /** The engine is starting: the UI is disabled. */
  starting: true,
  enterToSend: true,
};

export function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error("missing element #" + id);
  }
  return el;
}

export function div(className: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

export const messagesEl = byId("messages");
export const inputEl = byId("input") as HTMLTextAreaElement;

export function scrollToBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** A system line in the chat (notices and errors). */
export function addSystem(text: string, cls = ""): void {
  const el = div("msg system " + cls);
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

/** Size the input to its content: one row when empty, up to 200px. */
export function autoGrow(): void {
  inputEl.style.height = "auto";
  // border-box: scrollHeight covers content + padding; add the borders.
  const border = inputEl.offsetHeight - inputEl.clientHeight;
  inputEl.style.height = Math.min(inputEl.scrollHeight + border, 200) + "px";
}

export function insertAtCursor(el: HTMLTextAreaElement, text: string): void {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const pos = start + text.length;
  el.setSelectionRange(pos, pos);
  el.focus();
}

// Toolbar panels (Resume, Settings): only one is open at a time.
const panelHiders: Array<() => void> = [];

/** Register a panel's hide function, so others can close it. */
export function registerPanel(hide: () => void): void {
  panelHiders.push(hide);
}

export function hidePanels(): void {
  for (const hide of panelHiders) {
    hide();
  }
}
