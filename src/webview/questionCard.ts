// The card for the agent's question. Choose an option, or type your own answer;
// an option with sub-options opens a checklist first. Browser context.

import { answerFor, recommendedIndex } from "../questions";
import type { Question, QuestionOption } from "../types";
import { renderMarkdown } from "./markdown";
import { div, messagesEl, scrollToBottom, vscode } from "./ui";

/** Remove the card for a question that is gone; true if there was one. */
export function removeQuestionCard(toolCallId: string): boolean {
  const card = messagesEl.querySelector(`.approval[data-question-id="${CSS.escape(toolCallId)}"]`);
  card?.remove();
  return Boolean(card);
}

export function renderQuestion(q: Question): void {
  removeQuestionCard(q.toolCallId);
  const card = div("approval");
  card.setAttribute("data-question-id", q.toolCallId);
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", "Question from the agent");
  const text = div("approval-q");
  // renderMarkdown escapes all text and emits a fixed set of tags.
  text.innerHTML = renderMarkdown(q.question);
  card.appendChild(text);
  const body = div("approval-body");
  card.appendChild(body);

  /** Send the answer (none = skip) and replace the card with a line saying what was sent. */
  const send = (answer?: string): void => {
    vscode.postMessage({ type: "answerQuestion", toolCallId: q.toolCallId, ...(answer ? { answer } : {}) });
    const done = div("approval-hint");
    done.textContent = answer ? `You answered: ${answer}` : "You skipped the question.";
    card.replaceChildren(text, done);
  };
  const button = (label: string, cls: "allow" | "deny" | "plain", onClick: () => void, detail?: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = "approval-btn " + cls;
    const name = document.createElement("span");
    name.textContent = label;
    b.appendChild(name);
    if (detail) {
      const d = document.createElement("span");
      d.className = "approval-detail";
      d.textContent = detail;
      b.appendChild(d);
    }
    b.addEventListener("click", onClick);
    return b;
  };

  const main = (): void => {
    const list = div("approval-rules");
    const rec = recommendedIndex(q);
    q.options.forEach((option, i) => {
      list.appendChild(
        button(option.title + (i === rec ? " (recommended)" : ""), "allow", () => (option.subOptions?.length ? subPage(option) : send(answerFor(option))), option.description)
      );
    });
    const input = document.createElement("input");
    input.type = "text";
    input.className = "approval-input";
    input.placeholder = q.options.length ? "Or type a different answer" : "Type your answer";
    input.setAttribute("aria-label", "Your answer");
    const sendTyped = (): void => {
      if (input.value.trim()) {
        send(input.value.trim());
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendTyped();
      }
    });
    const row = div("approval-row");
    row.appendChild(button("Send answer", "allow", sendTyped));
    row.appendChild(button("Skip", "plain", () => send()));
    body.replaceChildren(...(q.options.length ? [list] : []), input, row);
    (q.options.length ? body.querySelector<HTMLElement>("button") : input)?.focus();
  };

  const subPage = (option: QuestionOption): void => {
    const title = div("approval-sub");
    title.textContent = option.subOptionsLabel || option.title;
    const list = div("approval-rules");
    const boxes: Array<{ box: HTMLInputElement; title: string }> = [];
    for (const sub of option.subOptions ?? []) {
      const label = document.createElement("label");
      label.className = "question-check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = true;
      label.appendChild(box);
      label.appendChild(document.createTextNode(sub.title + (sub.description ? ` (${sub.description})` : "")));
      list.appendChild(label);
      boxes.push({ box, title: sub.title });
    }
    const row = div("approval-row");
    row.appendChild(
      button("Send", "allow", () =>
        send(answerFor(option, boxes.filter((b) => b.box.checked).map((b) => b.title)))
      )
    );
    row.appendChild(button("Back", "plain", main));
    body.replaceChildren(title, list, row);
    body.querySelector<HTMLElement>("input")?.focus();
  };

  main();
  messagesEl.appendChild(card);
  scrollToBottom();
}
