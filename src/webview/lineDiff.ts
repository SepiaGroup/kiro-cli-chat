// Minimal line diff (LCS-based) for rendering tool edits terminal-style:
// "+ 12: added line" / "- 9: removed line", with a little surrounding context.
// Pure (no DOM) so it can be unit tested.

export type DiffLineKind = "add" | "del" | "ctx" | "gap";

export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based line number (new file for add/ctx, old file for del). */
  lineNo?: number;
  text: string;
}

/** Beyond this many old×new cells we skip LCS and show the new text as added. */
const MAX_CELLS = 4_000_000;

/**
 * Diff oldText → newText. `null`/empty oldText means a new file (all added).
 * `context` = unchanged lines kept around each change; the rest collapse to a gap.
 */
export function diffLines(oldText: string | null, newText: string, context = 2): DiffLine[] {
  const a = oldText ? splitLines(oldText) : [];
  const b = splitLines(newText);

  if (a.length === 0) {
    return b.map((text, i) => ({ kind: "add", lineNo: i + 1, text }));
  }
  if (a.length * b.length > MAX_CELLS) {
    return b.map((text, i) => ({ kind: "add", lineNo: i + 1, text }));
  }

  // LCS length table, computed from the end so we can walk forward.
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) {
    dp.push(new Uint32Array(m + 1));
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const full: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      full.push({ kind: "ctx", lineNo: j + 1, text: b[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      full.push({ kind: "del", lineNo: i + 1, text: a[i] });
      i++;
    } else {
      full.push({ kind: "add", lineNo: j + 1, text: b[j] });
      j++;
    }
  }
  while (i < n) {
    full.push({ kind: "del", lineNo: i + 1, text: a[i] });
    i++;
  }
  while (j < m) {
    full.push({ kind: "add", lineNo: j + 1, text: b[j] });
    j++;
  }

  return collapseContext(full, context);
}

function splitLines(s: string): string[] {
  const lines = s.replace(/\r\n/g, "\n").split("\n");
  // A trailing newline shouldn't produce a phantom empty last line.
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** Keep `context` unchanged lines around changes; replace other runs with a gap. */
function collapseContext(lines: DiffLine[], context: number): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.kind !== "ctx") {
      for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
        keep[k] = true;
      }
    }
  });
  const out: DiffLine[] = [];
  let skipping = false;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      out.push(l);
      skipping = false;
    } else if (!skipping) {
      out.push({ kind: "gap", text: "…" });
      skipping = true;
    }
  });
  return out;
}
