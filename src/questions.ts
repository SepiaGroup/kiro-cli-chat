// The agent's questions (the `user_input` tool, sent by the engine as the
// `_kiro/userInput` request): parsing what the engine sent and building the
// answer text, like the kiro-cli TUI. Pure (no vscode import).

import type { Question, QuestionOption } from "./types";

const MAX_QUESTION = 8000;
const MAX_OPTIONS = 30;
const MAX_SUB_OPTIONS = 9;
const MAX_TEXT = 500;

function text(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() ? v.slice(0, max) : undefined;
}

/** Validate a `_kiro/userInput` request; undefined if it has no question. */
export function mapUserInput(params: unknown): Question | undefined {
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const p = params as Record<string, unknown>;
  const question = text(p.question, MAX_QUESTION);
  if (!question) {
    return undefined;
  }
  const options: QuestionOption[] = [];
  for (const raw of Array.isArray(p.options) ? p.options.slice(0, MAX_OPTIONS) : []) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const title = text(o.title, MAX_TEXT);
    if (!title) {
      continue;
    }
    const subs = (Array.isArray(o.subOptions) ? o.subOptions.slice(0, MAX_SUB_OPTIONS) : []).flatMap((s) => {
      const sub = (s ?? {}) as Record<string, unknown>;
      const subTitle = text(sub.title, MAX_TEXT);
      return subTitle ? [{ title: subTitle, ...(text(sub.description, MAX_TEXT) ? { description: text(sub.description, MAX_TEXT) } : {}) }] : [];
    });
    options.push({
      title,
      ...(text(o.description, MAX_TEXT) ? { description: text(o.description, MAX_TEXT) } : {}),
      ...(o.recommended === true ? { recommended: true } : {}),
      ...(subs.length > 0 ? { subOptions: subs, ...(text(o.subOptionsLabel, MAX_TEXT) ? { subOptionsLabel: text(o.subOptionsLabel, MAX_TEXT) } : {}) } : {}),
    });
  }
  return { toolCallId: String(p.toolCallId ?? ""), question, options };
}

/** The answer for a chosen option: its title, plus the picked items if it has any. */
export function answerFor(option: QuestionOption, picked: string[] = []): string {
  return option.subOptions?.length ? `${option.title} [${picked.join(", ")}]` : option.title;
}

/** Index of the option the TUI would preselect (the first recommended one, else none). */
export function recommendedIndex(q: Question): number {
  return q.options.findIndex((o) => o.recommended);
}
