// `@file:path` in a prompt: like the kiro-cli TUI, the file's text is put into
// the prompt inside <attached_file path="…"> tags. Unlike the TUI, a file must
// be small, plain text. Pure apart from reading files (injectable for tests).

import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, resolve } from "path";

/** Largest file attached, and the most attached in one prompt. */
export const MAX_MENTION_BYTES = 256 * 1024;
export const MAX_MENTION_TOTAL_BYTES = 1024 * 1024;

export interface FileIo {
  /** Size of a regular file, or undefined if it isn't one. */
  fileSize(path: string): number | undefined;
  read(path: string): Buffer;
}

const realIo: FileIo = {
  fileSize: (p) => {
    try {
      const st = statSync(p);
      return st.isFile() ? st.size : undefined;
    } catch {
      return undefined;
    }
  },
  read: (p) => readFileSync(p),
};

export interface Mentions {
  /** The prompt to send (files inlined). */
  text: string;
  /** Paths that were attached, as typed. */
  attached: string[];
  /** Mentions left as typed, with the reason (for the log). */
  skipped: Array<{ path: string; reason: string }>;
}

/** One line telling the user what `@file:` did, or undefined when the prompt had no mentions. */
export function mentionNotice(m: { attached: string[]; skipped: Array<{ path: string; reason: string }> }): string | undefined {
  const parts: string[] = [];
  if (m.attached.length) {
    parts.push(`Attached: ${m.attached.join(", ")}.`);
  }
  if (m.skipped.length) {
    parts.push(`Not attached: ${m.skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}.`);
  }
  return parts.join(" ") || undefined;
}

export function expandFileMentions(prompt: string, cwd: string, io: FileIo = realIo): Mentions {
  const attached: string[] = [];
  const skipped: Mentions["skipped"] = [];
  let total = 0;
  const locate = (typed: string): string =>
    typed.startsWith("~/") ? resolve(homedir(), typed.slice(2)) : isAbsolute(typed) ? typed : resolve(cwd, typed);
  const text = prompt.replace(/@file:(\S+)/g, (whole, token: string) => {
    // "@file:a.ts," or "@file:a.ts?" in a sentence: the punctuation isn't part of the name.
    const trimmed = token.replace(/[.,;:!?)\]}>"']+$/, "");
    const typed = trimmed && trimmed !== token && io.fileSize(locate(token)) === undefined ? trimmed : token;
    const tail = token.slice(typed.length);
    const full = locate(typed);
    const skip = (reason: string): string => {
      skipped.push({ path: typed, reason });
      return whole;
    };
    const size = io.fileSize(full);
    if (size === undefined) {
      return skip("not a file");
    }
    if (size > MAX_MENTION_BYTES) {
      return skip(`larger than ${MAX_MENTION_BYTES / 1024} KB`);
    }
    if (total + size > MAX_MENTION_TOTAL_BYTES) {
      return skip("too much attached already");
    }
    let bytes: Buffer;
    try {
      bytes = io.read(full);
    } catch {
      return skip("can't be read");
    }
    if (bytes.includes(0)) {
      return skip("not text");
    }
    total += bytes.length;
    attached.push(typed);
    return `<attached_file path="${typed}"> ${bytes.toString("utf8")} </attached_file>${tail}`;
  });
  return { text, attached, skipped };
}
