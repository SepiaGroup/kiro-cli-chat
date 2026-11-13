// Chat messages: the user's prompts and the agent's streamed markdown
// replies. Browser context.

import { renderMarkdown } from "./markdown";
import { div, messagesEl, scrollToBottom } from "./ui";

let streamingBubble: HTMLElement | undefined;
let streamingRaw = "";

/** Forget the reply being streamed (the chat was cleared). */
export function resetStreaming(): void {
  streamingBubble = undefined;
  streamingRaw = "";
}

export function addUserMessage(
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

export function appendAssistant(text: string): void {
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

export function finalizeAssistant(): void {
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
