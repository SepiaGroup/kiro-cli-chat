// The approval card shown when the agent asks to run a tool. Browser context.

import { checkFolder, truncate as shorten } from "../approvalRules";
import type { ApprovalRule, FolderOffer } from "../approvalRules";
import type { ApprovalAnswer, ApprovalOption as ApprovalOptionLike, ApprovalRequest } from "../types";
import { div, messagesEl, scrollToBottom, vscode } from "./ui";

/** Remove the card for an approval answered elsewhere; true if there was one. */
export function removeApprovalCard(toolCallId: string): boolean {
  const card = messagesEl.querySelector(`.approval[data-approval-id="${CSS.escape(toolCallId)}"]`);
  card?.remove();
  return Boolean(card);
}

/** Remove every approval card still waiting: the reply ended, so nobody can answer them. */
export function removeAllApprovalCards(): void {
  messagesEl.querySelectorAll(".approval").forEach((card) => card.remove());
}

/**
 * An approval card, like the kiro-cli TUI: Allow / Deny / Deny with reason /
 * Create allow rule… / Create deny rule…. The rule buttons open a list of
 * rules (exact, pattern, folder, entire tool); the folder rule and the deny
 * reason open a text field.
 */
export function renderApproval(req: ApprovalRequest): void {
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
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", "Approval required");
  const q = div("approval-q");
  q.textContent = "Approval required: " + req.question;
  card.appendChild(q);
  if (req.part) {
    // A compound shell line is approved one command at a time; say which.
    const part = div("approval-part");
    part.appendChild(document.createTextNode(req.round ? `Command ${req.round}: ` : "Command: "));
    const code = document.createElement("code");
    code.textContent = req.part;
    part.appendChild(code);
    card.appendChild(part);
  }
  if (req.flag) {
    const flag = div("approval-flag");
    flag.textContent = req.flag;
    card.appendChild(flag);
  }
  const body = div("approval-body");
  card.appendChild(body);

  const opt = (kind: string) => req.options.find((o) => o.kind === kind);
  const send = (answer: ApprovalAnswer): void => {
    vscode.postMessage({ type: "approve", toolCallId: req.toolCallId, ...answer });
    card.remove();
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
  const show = (...els: HTMLElement[]): void => {
    body.replaceChildren(...els);
    const first = body.querySelector<HTMLElement>("input, button");
    first?.focus();
    scrollToBottom();
  };
  const back = (to: () => void): HTMLButtonElement => button("Back", "plain", to);

  const main = (): void => {
    const row = div("approval-row");
    const allow = opt("allow_once");
    const deny = opt("reject_once");
    const allowRule = opt("allow_always");
    const denyRule = opt("reject_always");
    // Allow choices first, then deny choices.
    if (allow) {
      row.appendChild(button(allow.name || "Allow", "allow", () => send({ optionId: allow.optionId })));
    }
    if (allowRule) {
      row.appendChild(
        button(allowRule.name, "allow", () =>
          req.allowRules?.length ? rulePage("allow", allowRule, req.allowRules) : send({ optionId: allowRule.optionId })
        )
      );
    }
    if (deny) {
      row.appendChild(button(deny.name || "Deny", "deny", () => send({ optionId: deny.optionId })));
      row.appendChild(button("Deny with reason…", "deny", () => reasonPage(deny)));
    }
    if (denyRule) {
      row.appendChild(
        button(denyRule.name, "deny", () =>
          req.denyRules?.length ? rulePage("deny", denyRule, req.denyRules) : send({ optionId: denyRule.optionId })
        )
      );
    }
    body.replaceChildren(row);
  };

  const rulePage = (effect: "allow" | "deny", option: ApprovalOptionLike, rules: ApprovalRule[]): void => {
    const title = div("approval-sub");
    title.textContent = `Create ${effect} rule` + (req.resource ? `: "${shorten(req.resource)}"` : req.tool ? `: ${req.tool}` : "");
    const list = div("approval-rules");
    for (const rule of rules) {
      list.appendChild(
        button(rule.label, effect, () =>
          rule.kind === "folder" && rule.folder ? folderPage(option, rule.folder) : send({ optionId: option.optionId, rule: rule.kind })
        , rule.description)
      );
    }
    const row = div("approval-row");
    row.appendChild(back(main));
    show(title, list, row);
  };

  const field = (label: string, value: string, onEnter: () => void, onEsc: () => void): HTMLInputElement => {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "approval-input";
    input.value = value;
    input.setAttribute("aria-label", label);
    input.placeholder = label;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onEnter();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onEsc();
      }
    });
    return input;
  };

  const folderPage = (option: ApprovalOptionLike, offer: FolderOffer): void => {
    const title = div("approval-sub");
    title.textContent = "Allow a folder for this session";
    const hint = div("approval-hint");
    hint.setAttribute("aria-live", "polite");
    const submit = (): void => {
      const check = checkFolder(offer, input.value);
      if (check.ok) {
        send({ optionId: option.optionId, rule: "folder", folder: check.path });
      } else {
        hint.classList.add("error");
        hint.textContent = check.reason;
      }
    };
    const input = field("folder to allow", offer.prefill, submit, () => rulePage("allow", option, req.allowRules ?? []));
    const update = (): void => {
      const check = checkFolder(offer, input.value);
      hint.classList.remove("error");
      hint.textContent = check.ok
        ? `Allows writes in ${check.path} and every folder under it, for this session only.`
        : check.reason;
    };
    input.addEventListener("input", update);
    update();
    const row = div("approval-row");
    row.appendChild(button("Allow this folder", "allow", submit));
    row.appendChild(back(() => rulePage("allow", option, req.allowRules ?? [])));
    show(title, input, hint, row);
  };

  const reasonPage = (deny: ApprovalOptionLike): void => {
    const title = div("approval-sub");
    title.textContent = "Deny, and tell the agent why";
    const submit = (): void => send({ optionId: deny.optionId, reason: input.value });
    const input = field("reason (optional)", "", submit, main);
    const row = div("approval-row");
    row.appendChild(button("Deny", "deny", submit));
    row.appendChild(back(main));
    show(title, input, row);
  };

  main();
  messagesEl.appendChild(card);
  scrollToBottom();
}
