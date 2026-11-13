// Line-delimited JSON parser. Buffers partial chunks and yields complete
// JSON objects, tolerating non-JSON lines (e.g. log output interleaved on the
// same stream, as the `chat --output-format stream-json` path does).
//
// This module has no VSCode or Node dependencies so it is unit-testable.

export class JsonLineParser {
  private buffer = "";

  /**
   * Feed a chunk of text. Returns an array of results, one per complete line.
   * Each result is either a parsed JSON value or a raw non-JSON line.
   */
  push(chunk: string): Array<ParsedLine> {
    this.buffer += chunk;
    const out: ParsedLine[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      out.push(parseLine(trimmed));
    }
    return out;
  }

  /** Flush any trailing buffered content (call on stream end). */
  flush(): ParsedLine | undefined {
    const trimmed = this.buffer.trim();
    this.buffer = "";
    if (trimmed.length === 0) {
      return undefined;
    }
    return parseLine(trimmed);
  }
}

export type ParsedLine =
  | { type: "json"; value: unknown }
  | { type: "raw"; text: string };

function parseLine(line: string): ParsedLine {
  // Fast path: only attempt JSON.parse when the line looks like JSON.
  const first = line[0];
  if (first === "{" || first === "[") {
    try {
      return { type: "json", value: JSON.parse(line) };
    } catch {
      return { type: "raw", text: line };
    }
  }
  return { type: "raw", text: line };
}

/** Splits a stream into lines, keeping a partial last line for the next chunk. */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let rest = "";
  return {
    push(chunk: string) {
      const parts = (rest + chunk).split("\n");
      rest = parts.pop() ?? "";
      for (const line of parts) {
        onLine(line.replace(/\r$/, ""));
      }
    },
    flush() {
      if (rest) {
        onLine(rest);
        rest = "";
      }
    },
  };
}

/**
 * Minimal ACP client. Emits:
 *  - "event"  (ChatEvent) for normalized chat events
 *  - "log"    (string)    for stderr lines
 *  - "exit"   (code)      when the process exits
 *  - "notification" (method, params) for unmapped JSON-RPC notifications
 */
