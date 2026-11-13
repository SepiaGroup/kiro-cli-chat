// The status line under a message sent while the agent works: queued, then
// "read" (or "not received" / "removed"). One line per message, updated in
// place. Browser context.

import { div, messagesEl, scrollToBottom } from "./ui";

const lines = new Map<string, HTMLElement>();

export function showSteer(state: string, ids: string[]): void {
  for (const id of ids) {
    let el = lines.get(id);
    if (!el) {
      if (state !== "queued") {
        // A line from before a reload may be gone; say it once anyway for failures.
        if (state !== "dropped") {
          continue;
        }
      }
      el = div("msg system");
      el.setAttribute("role", "status");
      messagesEl.appendChild(el);
      lines.set(id, el);
    }
    el.classList.toggle("error", state === "dropped");
    el.textContent =
      state === "queued"
        ? "Queued. The agent reads it at its next step."
        : state === "injected"
          ? "The agent has read your message."
          : state === "removed"
            ? "Message removed."
            : "The agent did not get your message. Send it again.";
    scrollToBottom();
  }
}
