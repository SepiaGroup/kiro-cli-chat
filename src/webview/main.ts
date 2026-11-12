// Webview frontend (browser context). Bundled to media/webview.js by esbuild.
// Communicates with the extension host via postMessage.

import { renderMarkdown } from "./markdown";
import { diffLines } from "./lineDiff";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const statusEl = byId("status");
const messagesEl = byId("messages");
const inputEl = byId("input") as HTMLTextAreaElement;
const sendBtn = byId("btn-send");

let enterToSend = true;
let streamingBubble: HTMLElement | undefined;
let streamingRaw = "";
let busy = false;
let starting = true;

// --- send / input handling ---

function send(): void {
  const text = inputEl.value;
  if ((!text.trim() && attachments.length === 0) || busy || starting) {
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
  hideSettingsPanel();
  hideResumePanel();
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
  const wantSend = enterToSend ? !e.shiftKey : e.shiftKey;
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

// Drag & drop file paths into the composer.
const composerEl = byId("composer");

/** Convert a dropped URI/path string to a plain filesystem path. */
function uriToPath(raw: string): string | undefined {
  const t = raw.trim();
  if (!t || t.startsWith("#")) {
    return undefined;
  }
  if (/^file:\/\//i.test(t)) {
    try {
      return decodeURIComponent(t.replace(/^file:\/\//i, ""));
    } catch {
      return t.replace(/^file:\/\//i, "");
    }
  }
  // Non-file schemes (http, vscode-remote, …) are not local paths.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    return undefined;
  }
  return t;
}

/** Collect local file paths from every drag format VS Code / the OS may use. */
function pathsFromDrop(dt: DataTransfer): string[] {
  const out: string[] = [];
  const add = (p: string | undefined): void => {
    if (p && !out.includes(p)) {
      out.push(p);
    }
  };
  // VS Code Explorer drags: JSON array of URI strings.
  const resourceUrls = dt.getData("resourceurls");
  if (resourceUrls) {
    try {
      const arr = JSON.parse(resourceUrls) as unknown;
      if (Array.isArray(arr)) {
        for (const u of arr) {
          add(uriToPath(String(u)));
        }
      }
    } catch {
      /* ignore malformed payload */
    }
  }
  // Standard URI list.
  for (const line of dt.getData("text/uri-list").split("\n")) {
    add(uriToPath(line));
  }
  // OS file drops (Electron exposes File.path).
  for (let i = 0; i < dt.files.length; i++) {
    const f = dt.files[i] as File & { path?: string };
    add(f.path);
  }
  // Plain text fallback (only if it looks like an absolute path).
  if (out.length === 0) {
    const text = dt.getData("text/plain").trim();
    if (text.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(text)) {
      add(text);
    }
  }
  return out;
}

/** Quote a path if it contains whitespace so the agent reads it as one token. */
function formatPath(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

const IMAGE_EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** MIME type for an image file, falling back to its extension (Finder drops can omit type). */
function imageMime(name: string, type: string): string | undefined {
  if (type.startsWith("image/")) {
    return type;
  }
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXT_MIME[ext];
}

const isImagePath = (p: string): boolean => /\.(png|jpe?g|gif|webp)$/i.test(p);

/** Describe a drop for the Output channel, so failures can be diagnosed. */
function describeDrop(dt: DataTransfer): string {
  const files: string[] = [];
  for (let i = 0; i < dt.files.length; i++) {
    const f = dt.files[i];
    files.push(`${f.name}|${f.type || "?"}|${f.size}`);
  }
  const uri = dt.getData("text/uri-list").slice(0, 300);
  return `types=[${Array.from(dt.types).join(", ")}] files=[${files.join("; ")}] uri-list=${JSON.stringify(uri)}`;
}

// The whole chat is a drop target (not just the input box).
//
// Leave dragenter alone (no preventDefault): VS Code's webview host uses it to
// hand the drag to the workbench, which is what shows the native editor drop
// overlay ("Hold Shift to drop into editor") when the chat is an editor tab.
// Holding Shift lets the drop through to us.
let dragDepth = 0;
document.addEventListener("dragenter", () => {
  dragDepth++;
  composerEl.classList.add("drag-over");
});
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = "copy";
  }
});
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    composerEl.classList.remove("drag-over");
  }
});
document.addEventListener("drop", (e: DragEvent) => {
  e.preventDefault();
  dragDepth = 0;
  composerEl.classList.remove("drag-over");
  if (!e.dataTransfer) {
    return;
  }
  const dt = e.dataTransfer;
  vscode.postMessage({ type: "debugLog", text: "drop " + describeDrop(dt) });
  if (starting) {
    return;
  }
  // Image files (Finder drops) are read directly and attached.
  const otherFiles: File[] = [];
  let attachedFromFiles = false;
  for (let i = 0; i < dt.files.length; i++) {
    const f = dt.files[i];
    const mime = imageMime(f.name, f.type);
    if (mime) {
      void addImageAttachment(f, mime);
      attachedFromFiles = true;
    } else {
      otherFiles.push(f);
    }
  }
  // Paths (VS Code Explorer drops): images are read by the extension and
  // attached; everything else is inserted as a path.
  const paths = pathsFromDrop(dt);
  const imagePaths = attachedFromFiles ? [] : paths.filter(isImagePath);
  const otherPaths = paths.filter((p) => !isImagePath(p));
  if (imagePaths.length > 0) {
    vscode.postMessage({ type: "attachPaths", paths: imagePaths });
  }
  if (otherPaths.length > 0) {
    insertAtCursor(inputEl, otherPaths.map(formatPath).join(" ") + " ");
    autoGrow();
  } else if (otherFiles.length > 0 && paths.length === 0) {
    addSystem(
      "VS Code doesn't give the chat a path for files dropped from Finder. " +
        "Drag it from the VS Code Explorer, or run “Kiro CLI Chat: Attach Image or File” from the Command Palette."
    );
  }
  inputEl.focus();
});

// Paste a screenshot / copied image straight into the chat.
inputEl.addEventListener("paste", (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items || starting) {
    return;
  }
  let handled = false;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) {
        void addImageAttachment(f);
        handled = true;
      }
    }
  }
  if (handled) {
    e.preventDefault();
  }
});

// --- image attachments ---

interface Attachment {
  id: number;
  name: string;
  mimeType: string;
  data: string; // base64, no prefix
}

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
const attachmentsEl = byId("attachments");
let attachments: Attachment[] = [];
let attachSeq = 0;

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

async function addImageAttachment(file: File, mimeOverride?: string): Promise<void> {
  const name = file.name || "pasted-image";
  const mimeType = mimeOverride ?? file.type;
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    addSystem(`Unsupported image type for ${name} (use PNG, JPEG, GIF or WebP).`, "error");
    return;
  }
  if (file.size > MAX_ATTACH_BYTES) {
    addSystem(`${name} is larger than 10 MB and wasn't attached.`, "error");
    return;
  }
  try {
    const data = await readAsBase64(file);
    vscode.postMessage({ type: "debugLog", text: `read ${name} ok (${data.length} b64 chars)` });
    pushAttachment(name, mimeType, data);
  } catch (err) {
    vscode.postMessage({ type: "debugLog", text: `read ${name} FAILED: ${String(err)}` });
    addSystem(`Couldn't read ${name}: ${String(err)}`, "error");
  }
}

/** Add an already-encoded image (from the webview or the extension) to the composer. */
function pushAttachment(name: string, mimeType: string, data: string): void {
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType) || !data) {
    return;
  }
  attachments.push({ id: ++attachSeq, name, mimeType, data });
  renderAttachments();
}

function renderAttachments(): void {
  attachmentsEl.innerHTML = "";
  attachmentsEl.classList.toggle("hidden", attachments.length === 0);
  for (const a of attachments) {
    const chip = div("attach-chip");
    chip.title = a.name;
    const img = document.createElement("img");
    img.src = `data:${a.mimeType};base64,${a.data}`;
    img.alt = a.name;
    const remove = document.createElement("button");
    remove.className = "attach-remove";
    remove.textContent = "✕";
    remove.title = `Remove ${a.name}`;
    remove.setAttribute("aria-label", `Remove ${a.name}`);
    remove.addEventListener("click", () => {
      attachments = attachments.filter((x) => x.id !== a.id);
      renderAttachments();
    });
    chip.appendChild(img);
    chip.appendChild(remove);
    attachmentsEl.appendChild(chip);
  }
}

function clearAttachments(): void {
  attachments = [];
  renderAttachments();
}

// Toolbar buttons.
byId("btn-resume").addEventListener("click", () => toggleResumePanel());
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
      if (starting) {
        setWorkingLabel(String(msg.text ?? "Starting up"));
      }
      break;
    case "ready":
      enterToSend = Boolean(msg.enterToSend ?? true);
      autopilotChk.checked = Boolean(msg.autopilot);
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
    case "insertPaths": {
      const ps = (msg.paths as string[] | undefined) ?? [];
      if (ps.length > 0) {
        insertAtCursor(inputEl, ps.map(formatPath).join(" ") + " ");
        autoGrow();
        inputEl.focus();
      }
      break;
    }
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
      if (!resumeOpen) {
        toggleResumePanel();
      }
      break;
    case "restarting":
      setStarting(true);
      break;
    case "cleared":
      messagesEl.innerHTML = "";
      streamingBubble = undefined;
      streamingRaw = "";
      workingEl = undefined;
      sessionCredits = 0;
      lastCtx = { pct: 0, usedTokens: undefined, threshold: undefined };
      ctxMeterEl.classList.add("hidden");
      hideCtxCard();
      // If we're mid-startup (e.g. just after Restart), the clear wiped the
      // spinner bubble — re-show it so the "Starting up…" indicator persists.
      if (starting) {
        showWorking("Starting up");
      }
      break;
    case "models":
      // Stored for a future settings panel; no-op in this build.
      break;
    case "sessionListLoading":
      renderResumeLoading();
      break;
    case "sessionList":
      renderResumeList(
        (msg.sessions as SessionRow[]) ?? [],
        msg.error as string | undefined
      );
      break;
    case "event":
      handleEvent(msg.event as ChatEventLike);
      break;
    case "compactDone":
      compacting = false;
      addSystem(String(msg.message ?? ""), msg.ok ? "" : "error");
      if (!ctxCardEl.classList.contains("hidden")) {
        requestCtxBreakdown();
      }
      break;
    case "contextBreakdown":
      lastBreakdown = { breakdown: msg.breakdown as CtxBreakdown | undefined, error: msg.error as string | undefined };
      renderCtxCard(lastBreakdown.breakdown, lastBreakdown.error);
      break;
    default:
      break;
  }
});

interface ChatEventLike {
  kind: string;
  [k: string]: unknown;
}

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
      if (busy) {
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
      renderApproval(ev.request as ApprovalLike);
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

// --- rendering ---

function addUserMessage(
  text: string,
  images: Array<{ mimeType: string; data: string; name?: string }> = []
): void {
  const el = div("msg user");
  if (text) {
    const t = div("user-text");
    t.textContent = text;
    el.appendChild(t);
  }
  if (images.length > 0) {
    const row = div("user-images");
    for (const im of images) {
      const img = document.createElement("img");
      img.src = `data:${im.mimeType};base64,${im.data}`;
      img.alt = im.name ?? "attached image";
      img.title = im.name ?? "";
      row.appendChild(img);
    }
    el.appendChild(row);
  }
  messagesEl.appendChild(el);
  scrollToBottom();
}

function appendAssistant(text: string): void {
  if (!streamingBubble) {
    streamingBubble = div("msg assistant streaming");
    messagesEl.appendChild(streamingBubble);
    streamingRaw = "";
  }
  streamingRaw += text;
  // Render the accumulated markdown. innerHTML is safe here because
  // renderMarkdown escapes all text and only emits a fixed tag set.
  streamingBubble.innerHTML = renderMarkdown(streamingRaw);
  scrollToBottom();
}

function finalizeAssistant(): void {
  if (streamingBubble) {
    streamingBubble.classList.remove("streaming");
    wireCodeCopyButtons(streamingBubble);
    streamingBubble = undefined;
    streamingRaw = "";
  }
}

/** Attach click handlers to "Copy" buttons in rendered code blocks. */
function wireCodeCopyButtons(scope: HTMLElement): void {
  const buttons = scope.querySelectorAll<HTMLButtonElement>(".code-copy");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const pre = btn.closest(".code-block")?.querySelector("code");
      const code = pre?.textContent ?? "";
      void navigator.clipboard.writeText(code).then(() => {
        const prev = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => {
          btn.textContent = prev;
        }, 1200);
      });
    });
  });
}

interface ApprovalLike {
  toolCallId: string;
  question: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

function renderApproval(req: ApprovalLike): void {
  // Dedupe: if a card for this tool call already exists, remove it first so a
  // repeated permission request for the same tool replaces rather than stacks.
  const existing = messagesEl.querySelector(
    `.approval[data-approval-id="${CSS.escape(req.toolCallId || "")}"]`
  );
  if (existing) {
    existing.remove();
  }
  const card = div("approval");
  card.setAttribute("data-approval-id", req.toolCallId || "");
  const q = div("approval-q");
  q.textContent = "Approval required: " + req.question;
  card.appendChild(q);
  const row = div("approval-row");
  for (const opt of req.options) {
    const b = document.createElement("button");
    b.textContent = opt.name || opt.optionId;
    b.className = "approval-btn " + (opt.kind.startsWith("reject") ? "deny" : "allow");
    b.addEventListener("click", () => {
      vscode.postMessage({
        type: "approve",
        optionId: opt.optionId,
        toolCallId: req.toolCallId,
      });
      card.remove();
    });
    row.appendChild(b);
  }
  card.appendChild(row);
  messagesEl.appendChild(card);
  scrollToBottom();
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

function formatElapsed(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
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

function addToolCard(ev: ChatEventLike): void {
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

function updateToolCard(ev: ChatEventLike): void {
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

function addSystem(text: string, cls = ""): void {
  const el = div("msg system " + cls);
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
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

// --- settings panel ---

interface ConfigChoiceLike {
  value: string;
  name: string;
  description?: string;
}
interface ConfigOptionLike {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue?: unknown;
  options?: ConfigChoiceLike[];
}

const settingsEl = byId("settings");
const modeSel = byId("sel-mode") as HTMLSelectElement;
const modelSel = byId("sel-model") as HTMLSelectElement;
const autopilotChk = byId("chk-autopilot") as HTMLInputElement;
const effortRow = byId("effort-row");
const effortSel = byId("sel-effort") as HTMLSelectElement;
const memorySel = byId("sel-memory") as HTMLSelectElement;
const contentSel = byId("sel-content") as HTMLSelectElement;

byId("btn-settings").addEventListener("click", () => {
  const willOpen = settingsEl.classList.contains("hidden");
  if (willOpen) {
    hideResumePanel();
  }
  settingsEl.classList.toggle("hidden");
});

function hideSettingsPanel(): void {
  settingsEl.classList.add("hidden");
}

byId("settings-close").addEventListener("click", () => hideSettingsPanel());

// Clicking anywhere outside an open panel (or its toolbar button) closes it.
document.addEventListener("mousedown", (e) => {
  const t = e.target as Node | null;
  if (!t) {
    return;
  }
  if (!settingsEl.classList.contains("hidden") && !settingsEl.contains(t) && !byId("btn-settings").contains(t)) {
    hideSettingsPanel();
  }
  if (resumeOpen && !resumePanelEl.contains(t) && !byId("btn-resume").contains(t)) {
    hideResumePanel();
  }
});

// Esc closes open panels too.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideSettingsPanel();
    hideResumePanel();
  }
});

modeSel.addEventListener("change", () => {
  vscode.postMessage({ type: "setMode", modeId: modeSel.value });
});

modelSel.addEventListener("change", () => {
  vscode.postMessage({ type: "setConfig", id: "model", value: modelSel.value });
  modelSel.title = "Model: " + (modelSel.selectedOptions[0]?.textContent ?? "");
});

effortSel.addEventListener("change", () => {
  vscode.postMessage({ type: "setConfig", id: "effortLevel", value: effortSel.value });
});

memorySel.addEventListener("change", () => {
  vscode.postMessage({ type: "setConfig", id: "memoryReflection", value: memorySel.value });
});

contentSel.addEventListener("change", () => {
  vscode.postMessage({ type: "setConfig", id: "contentCollection", value: contentSel.value });
});

autopilotChk.addEventListener("change", () => {
  // Autopilot is a real engine option ("on"/"off").
  vscode.postMessage({
    type: "setConfig",
    id: "autopilot",
    value: autopilotChk.checked ? "on" : "off",
  });
});

function fillSelect(sel: HTMLSelectElement, opt: ConfigOptionLike): void {
  const current = String(opt.currentValue ?? "");
  sel.innerHTML = "";
  for (const choice of opt.options ?? []) {
    const o = document.createElement("option");
    o.value = choice.value;
    o.textContent = choice.name || choice.value;
    if (choice.value === current) {
      o.selected = true;
    }
    sel.appendChild(o);
  }
}

function updateSettings(options: ConfigOptionLike[]): void {
  let sawEffort = false;
  let sawModel = false;
  for (const opt of options) {
    switch (opt.id) {
      case "mode":
        fillSelect(modeSel, opt);
        modeSel.disabled = false;
        break;
      case "model":
        sawModel = true;
        fillSelect(modelSel, opt);
        modelSel.disabled = false;
        modelSel.title = "Model: " + (modelSel.selectedOptions[0]?.textContent ?? "");
        break;
      case "effortLevel":
        sawEffort = true;
        fillSelect(effortSel, opt);
        effortRow.classList.remove("hidden");
        break;
      case "autopilot":
        autopilotChk.checked = String(opt.currentValue ?? "") === "on";
        break;
      case "memoryReflection":
        fillSelect(memorySel, opt);
        break;
      case "contentCollection":
        fillSelect(contentSel, opt);
        break;
      default:
        break;
    }
  }
  // Only re-evaluate effort visibility on updates that include the model (i.e.
  // full/model-changing updates), so a partial update doesn't wrongly hide it.
  if (sawModel && !sawEffort) {
    effortRow.classList.add("hidden");
  }
}

// --- resume (previous sessions) panel ---

interface SessionRow {
  sessionId: string;
  title?: string;
  updatedAt?: string;
  source?: string;
  messageCount?: number;
}

const resumePanelEl = byId("resume-panel");
const resumeListEl = byId("resume-list");
byId("resume-close").addEventListener("click", () => hideResumePanel());

let resumeOpen = false;

function toggleResumePanel(): void {
  if (resumeOpen) {
    hideResumePanel();
  } else {
    hideSettingsPanel();
    resumeOpen = true;
    resumePanelEl.classList.remove("hidden");
    renderResumeLoading();
    vscode.postMessage({ type: "resumeSession" });
  }
}

function hideResumePanel(): void {
  resumeOpen = false;
  resumePanelEl.classList.add("hidden");
}

function renderResumeLoading(): void {
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

function renderResumeList(sessions: SessionRow[], error?: string): void {
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

// --- context meter + token/credit usage ---

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

function updateContextMeter(pct: number, usedTokens?: number, threshold?: number): void {
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

type CtxBreakdown = Record<string, CtxGroup>;

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

function requestCtxBreakdown(): void {
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

function hideCtxCard(): void {
  window.clearTimeout(ctxCardTimer);
  ctxCardEl.classList.add("hidden");
}

function hideCtxCardSoon(): void {
  window.clearTimeout(ctxCardTimer);
  ctxCardTimer = window.setTimeout(hideCtxCard, 150);
}

function renderCtxCard(breakdown?: CtxBreakdown, error?: string, loading = false): void {
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
  btn.disabled = compacting || busy || starting;
  btn.addEventListener("click", () => {
    compacting = true;
    btn.disabled = true;
    btn.textContent = "Compacting…";
    vscode.postMessage({ type: "compact" });
  });
  actions.appendChild(btn);
  if (busy && !compacting) {
    const note = document.createElement("span");
    note.className = "ctx-card-note";
    note.textContent = "Available when the reply finishes";
    actions.appendChild(note);
  }
  ctxCardEl.appendChild(actions);
}

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

function addCredits(credits: number): void {
  if (credits > 0) {
    sessionCredits += credits;
    updateContextMeter(lastCtx.pct, lastCtx.usedTokens, lastCtx.threshold);
  }
}

// --- slash-command picker ---

interface CommandLike {
  name: string;
  description?: string;
  inputHint?: string;
  type?: string;
}

const pickerEl = byId("cmd-picker");
const hintEl = byId("cmd-hint");

// Built-in commands always offered (engine may add agents/skills on top).
const BUILTIN_COMMANDS: CommandLike[] = [
  { name: "model", description: "Switch the model", inputHint: "model name", type: "builtin" },
  { name: "agent", description: "Switch the active agent", inputHint: "agent name", type: "builtin" },
  { name: "compact", description: "Compact the conversation to save context", type: "builtin" },
  { name: "clear", description: "Clear the conversation", type: "builtin" },
  { name: "help", description: "Show available commands", type: "builtin" },
];

let allCommands: CommandLike[] = [...BUILTIN_COMMANDS];
let pickerMatches: CommandLike[] = [];
let pickerIndex = 0;

function setCommands(cmds: CommandLike[]): void {
  // Merge engine-provided commands with built-ins, de-duplicating by name.
  const byName = new Map<string, CommandLike>();
  for (const c of BUILTIN_COMMANDS) {
    byName.set(c.name, c);
  }
  for (const c of cmds) {
    if (c && c.name) {
      byName.set(c.name, c);
    }
  }
  allCommands = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The leading "/token" at the start of the input, or null. */
function slashQuery(): string | null {
  const v = inputEl.value;
  // Only trigger when the slash is the very first character and there is no
  // space yet (i.e. still typing the command name, not its arguments).
  const m = /^\/([a-zA-Z0-9_-]*)$/.exec(v);
  return m ? m[1] : null;
}

function updatePicker(): void {
  const q = slashQuery();
  if (q === null) {
    hidePicker();
    return;
  }
  const ql = q.toLowerCase();
  pickerMatches = allCommands.filter((c) => c.name.toLowerCase().includes(ql));
  if (pickerMatches.length === 0) {
    hidePicker();
    return;
  }
  pickerIndex = 0;
  renderPicker();
}

function renderPicker(): void {
  pickerEl.innerHTML = "";
  pickerMatches.forEach((c, i) => {
    const item = div("cmd-item" + (i === pickerIndex ? " active" : ""));
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", i === pickerIndex ? "true" : "false");
    const name = div("cmd-name");
    name.textContent = "/" + c.name;
    item.appendChild(name);
    if (c.type && c.type !== "builtin") {
      const tag = div("cmd-tag");
      tag.textContent = c.type;
      item.appendChild(tag);
    }
    if (c.description) {
      const desc = div("cmd-desc");
      desc.textContent = c.description;
      item.appendChild(desc);
    }
    item.addEventListener("mousedown", (e) => {
      // mousedown (not click) so it fires before the textarea blur.
      e.preventDefault();
      chooseCommand(c);
    });
    pickerEl.appendChild(item);
  });
  pickerEl.classList.remove("hidden");
}

function hidePicker(): void {
  pickerEl.classList.add("hidden");
  pickerEl.innerHTML = "";
  pickerMatches = [];
}

function pickerOpen(): boolean {
  return !pickerEl.classList.contains("hidden") && pickerMatches.length > 0;
}

/** Returns true if the picker consumed the key event. */
function handlePickerKeydown(e: KeyboardEvent): boolean {
  if (!pickerOpen()) {
    return false;
  }
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      pickerIndex = (pickerIndex + 1) % pickerMatches.length;
      renderPicker();
      return true;
    case "ArrowUp":
      e.preventDefault();
      pickerIndex =
        (pickerIndex - 1 + pickerMatches.length) % pickerMatches.length;
      renderPicker();
      return true;
    case "Enter":
    case "Tab":
      e.preventDefault();
      chooseCommand(pickerMatches[pickerIndex]);
      return true;
    case "Escape":
      e.preventDefault();
      hidePicker();
      return true;
    default:
      return false;
  }
}

/** Insert the chosen command into the input (does not send). */
function chooseCommand(c: CommandLike): void {
  // Insert "/name " so the user can append arguments, then press Enter.
  inputEl.value = "/" + c.name + " ";
  const pos = inputEl.value.length;
  inputEl.setSelectionRange(pos, pos);
  inputEl.focus();
  hidePicker();
  autoGrow();
  // If the command expects an argument, show its hint as a ghost label.
  if (c.inputHint) {
    showHint(c.inputHint);
  } else {
    hideHint();
  }
}

function showHint(text: string): void {
  hintEl.textContent = "argument: " + text;
  hintEl.classList.remove("hidden");
}

function hideHint(): void {
  hintEl.classList.add("hidden");
  hintEl.textContent = "";
}

/** Hide the hint once the user has typed an argument or cleared the command. */
function updateHint(): void {
  if (hintEl.classList.contains("hidden")) {
    return;
  }
  const v = inputEl.value;
  const m = /^\/([a-zA-Z0-9_-]+)\s(.*)$/.exec(v);
  // Keep the hint only while the line is "/cmd " with no argument typed yet.
  if (!m || m[2].trim().length > 0) {
    hideHint();
  }
}

// --- utilities ---

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function setBusy(b: boolean): void {
  busy = b;
  sendBtn.toggleAttribute("disabled", b);
  sendBtn.classList.toggle("busy", b);
  // Keep the hover card's Compact button in step with the reply state.
  if (!ctxCardEl.classList.contains("hidden") && lastBreakdown) {
    renderCtxCard(lastBreakdown.breakdown, lastBreakdown.error);
  }
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
  starting = on;
  const controls = [
    "btn-resume",
    "btn-restart",
    "btn-settings",
    "btn-send",
  ];
  for (const id of controls) {
    byId(id).toggleAttribute("disabled", on);
  }
  inputEl.toggleAttribute("disabled", on);
  if (on) {
    // Close any open panels while starting.
    hideResumePanel();
    hideSettingsPanel();
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
    const txt = workingEl.querySelector(".working-label");
    if (txt) {
      txt.textContent = label + "…";
    }
  }
}

function setWorkingLabel(label: string): void {
  if (workingEl) {
    const txt = workingEl.querySelector(".working-label");
    if (txt) {
      txt.textContent = label + "…";
    }
  }
}

function hideWorking(): void {
  if (workingEl) {
    workingEl.remove();
    workingEl = undefined;
  }
}

function scrollToBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** Size the input to its content: one row when empty, up to 200px. */
function autoGrow(): void {
  inputEl.style.height = "auto";
  // border-box: scrollHeight covers content + padding; add the borders.
  const border = inputEl.offsetHeight - inputEl.clientHeight;
  inputEl.style.height = Math.min(inputEl.scrollHeight + border, 200) + "px";
}

function insertAtCursor(el: HTMLTextAreaElement, text: string): void {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const pos = start + text.length;
  el.setSelectionRange(pos, pos);
  el.focus();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\n…(truncated)" : s;
}

function div(className: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error("missing element #" + id);
  }
  return el;
}

// Enter startup mode (disables UI, shows "Starting up…") until the engine is
// ready, then signal readiness to the host.
setStarting(true);
vscode.postMessage({ type: "ready" });
