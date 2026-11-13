// ANSI escape helpers for the terminal chat. Pure (no vscode import).

export const ESC = "\x1b";
export const CSI = "\x1b[";

// Colors use the 16 standard ANSI slots so they follow the user's VS Code
// terminal theme (the same --vscode-terminal-ansi* colors the webview uses).
export const style = {
  reset: "\x1b[0m",
  bold: (s: string): string => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string): string => `\x1b[2m${s}\x1b[22m`,
  italic: (s: string): string => `\x1b[3m${s}\x1b[23m`,
  underline: (s: string): string => `\x1b[4m${s}\x1b[24m`,
  strike: (s: string): string => `\x1b[9m${s}\x1b[29m`,
  red: (s: string): string => `\x1b[31m${s}\x1b[39m`,
  green: (s: string): string => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string): string => `\x1b[33m${s}\x1b[39m`,
  blue: (s: string): string => `\x1b[34m${s}\x1b[39m`,
  magenta: (s: string): string => `\x1b[35m${s}\x1b[39m`,
  cyan: (s: string): string => `\x1b[36m${s}\x1b[39m`,
  gray: (s: string): string => `\x1b[90m${s}\x1b[39m`,
};

export const term = {
  clearLine: "\r\x1b[2K",
  clearToEnd: "\x1b[J",
  clearScreen: "\x1b[2J\x1b[3J\x1b[H",
  up: (n: number): string => (n > 0 ? `\x1b[${n}A` : ""),
  right: (n: number): string => (n > 0 ? `\x1b[${n}C` : ""),
  bracketedPasteOn: "\x1b[?2004h",
  bracketedPasteOff: "\x1b[?2004l",
};

// Matching escape sequences is the point here, so control characters are expected.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Display width in terminal columns (1 per code point; good enough here). */
export function visibleWidth(s: string): number {
  return Array.from(stripAnsi(s)).length;
}

/**
 * Make untrusted text (model output, tool titles, file content) safe to write
 * to the terminal: drop escape sequences and control characters (which could
 * otherwise move the cursor, retitle the terminal, etc.). Keeps \n; tabs
 * become spaces.
 */
export function sanitize(s: string): string {
  return s
    .replace(ANSI_RE, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f\x9b]/g, "");
}

/** Convert "\n" to the "\r\n" a pseudoterminal needs. */
export function crlf(s: string): string {
  return s.replace(/\r?\n/g, "\r\n");
}

/**
 * Truncate styled text to `width` visible columns (escape sequences are kept
 * and don't count), adding "…" when cut. Used for one-row menu lines.
 */
export function fitAnsi(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (visibleWidth(text) <= width) {
    return text;
  }
  // eslint-disable-next-line no-control-regex
  const tokens = text.match(/\x1b\[[0-9;]*m|[^\x1b]+|\x1b/g) ?? [];
  let out = "";
  let w = 0;
  for (const tok of tokens) {
    if (tok.startsWith("\x1b")) {
      out += tok;
      continue;
    }
    for (const ch of Array.from(tok)) {
      if (w >= width - 1) {
        return out + "…" + "\x1b[0m";
      }
      out += ch;
      w++;
    }
  }
  return out;
}

/**
 * Word-wrap one styled line to `cols` columns (escape sequences don't count).
 * Continuation rows start with `indent` (hanging indent for list items).
 * Words longer than a row are hard-broken. Rows are joined with "\r\n".
 */
export function wrapAnsi(text: string, cols: number, indent = ""): string {
  if (cols < 8 || visibleWidth(text) <= cols) {
    return text;
  }
  const ind = visibleWidth(indent) < cols / 2 ? indent : "";
  const indW = visibleWidth(ind);
  // eslint-disable-next-line no-control-regex
  const tokens = text.match(/\x1b\[[0-9;]*m|\s+|[^\s\x1b]+|\x1b/g) ?? [];
  let out = "";
  let lineW = 0;
  let pendingSpace = "";
  for (const tok of tokens) {
    if (tok.startsWith("\x1b")) {
      out += tok;
      continue;
    }
    if (/^\s+$/.test(tok)) {
      pendingSpace += tok;
      continue;
    }
    let word = Array.from(tok);
    const spaceW = pendingSpace.length;
    if (lineW > indW && lineW + spaceW + word.length > cols) {
      out += "\r\n" + ind;
      lineW = indW;
    } else {
      out += pendingSpace;
      lineW += spaceW;
    }
    pendingSpace = "";
    while (lineW + word.length > cols) {
      const take = Math.max(1, cols - lineW);
      out += word.slice(0, take).join("") + "\r\n" + ind;
      word = word.slice(take);
      lineW = indW;
    }
    out += word.join("");
    lineW += word.length;
  }
  return out;
}

/**
 * Rows the cursor has moved down after writing `width` columns starting at
 * column 0 (xterm keeps the cursor on the last column — "pending wrap" — when a
 * row is exactly filled).
 */
export function rowsBelowStart(width: number, cols: number): number {
  if (width <= 0 || cols <= 0) {
    return 0;
  }
  return width % cols === 0 ? width / cols - 1 : Math.floor(width / cols);
}

/** Shorten to `max` visible characters (drops styling if it has to cut). */
export function truncate(s: string, max: number): string {
  const plain = stripAnsi(s);
  return plain.length > max ? plain.slice(0, Math.max(1, max - 1)) + "…" : s;
}
