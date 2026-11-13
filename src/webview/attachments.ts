// Images attached to the next prompt, and the chat's drag-and-drop and paste
// handling. Browser context.

import { describeDrop, formatPath, imageMime, isImagePath, pathsFromDrop } from "./dropPaths";
import { addSystem, autoGrow, byId, div, inputEl, insertAtCursor, state, vscode } from "./ui";

export interface Attachment {
  id: number;
  name: string;
  mimeType: string;
  data: string; // base64, no prefix
}

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
const attachmentsEl = byId("attachments");
const composerEl = byId("composer");
let attachments: Attachment[] = [];
let attachSeq = 0;

/** The images attached to the prompt being written. */
export function currentAttachments(): readonly Attachment[] {
  return attachments;
}

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
export function pushAttachment(name: string, mimeType: string, data: string): void {
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

export function clearAttachments(): void {
  attachments = [];
  renderAttachments();
}

/** Insert paths into the input, quoted if needed. */
export function insertPaths(paths: string[]): void {
  if (paths.length > 0) {
    insertAtCursor(inputEl, paths.map(formatPath).join(" ") + " ");
    autoGrow();
    inputEl.focus();
  }
}

/** The whole chat is a drop target, and the input takes pasted images. */
export function initDropAndPaste(): void {
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
    if (state.starting) {
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
    if (!items || state.starting) {
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
}
