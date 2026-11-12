// Minimal, self-contained, CSP-safe Markdown renderer for the chat webview.
//
// Design goals:
//  - No external dependencies (bundled small).
//  - Safe by construction: ALL text is HTML-escaped before any markup is
//    inserted, so model output can never inject executable HTML. We only emit
//    a fixed, known set of tags (strong, em, code, pre, a, ul/ol/li, h1-h6,
//    blockquote, p, br, hr). Links are forced to open externally and are
//    restricted to http(s)/mailto schemes.
//  - Tolerant of partial input (streaming): an unterminated fenced code block
//    is still rendered as a code block so far.
//
// This is intentionally a pragmatic subset of CommonMark, not a full parser.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Sanitize a URL for use in href: allow only safe schemes. */
function safeUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) {
    return trimmed;
  }
  // Relative or anchor links are not meaningful in the webview; drop them.
  return undefined;
}

/** Render inline markdown (within a single line/paragraph). Input is RAW. */
function renderInline(raw: string): string {
  // Escape the whole string, then apply inline rules to the escaped text
  // (inline code is swapped for placeholders first so it isn't reprocessed).
  let out = escapeHtml(raw);

  // Inline code: `code` (non-greedy, no newlines).
  out = out.replace(/`([^`\n]+?)`/g, (_m, code: string) => `<code>${code}</code>`);

  // Links: [text](url)
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, text: string, url: string) => {
      // url here is already HTML-escaped; unescape &amp; for scheme check.
      const decoded = url.replace(/&amp;/g, "&");
      const safe = safeUrl(decoded);
      if (!safe) {
        return text;
      }
      const href = escapeHtml(safe);
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
  );

  // Bold: **text** or __text__
  out = out.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+?)__/g, "<strong>$1</strong>");

  // Italic: *text* or _text_ (avoid matching inside words for underscores).
  out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_\w])_([^_\n]+?)_(?![_\w])/g, "$1<em>$2</em>");

  // Strikethrough: ~~text~~
  out = out.replace(/~~([^~]+?)~~/g, "<del>$1</del>");

  return out;
}

interface CodeBlock {
  lang: string;
  code: string;
}

/**
 * Render a full markdown document to a safe HTML string. The parsing walks the
 * text line-by-line, grouping fenced code blocks, lists, headings, etc.
 */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];

  let i = 0;
  let paragraph: string[] = [];
  let listType: "ul" | "ol" | undefined;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      const text = paragraph.join(" ");
      html.push(`<p>${renderInline(text)}</p>`);
      paragraph = [];
    }
  };
  const closeList = (): void => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = undefined;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: ``` or ```lang
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      flushParagraph();
      closeList();
      const lang = fence[1].trim().replace(/[^a-zA-Z0-9+#.-]/g, "");
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      // Skip the closing fence if present.
      if (i < lines.length) {
        i++;
      }
      const block: CodeBlock = { lang, code: codeLines.join("\n") };
      html.push(renderCodeBlock(block));
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      closeList();
      html.push("<hr />");
      i++;
      continue;
    }

    // Heading: # .. ######
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      i++;
      continue;
    }

    // Unordered list item: -, *, +
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      flushParagraph();
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push(`<li>${renderInline(ul[1])}</li>`);
      i++;
      continue;
    }

    // Ordered list item: 1. 2) etc.
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flushParagraph();
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${renderInline(ol[1])}</li>`);
      i++;
      continue;
    }

    // Blank line: paragraph / list break
    if (/^\s*$/.test(line)) {
      flushParagraph();
      closeList();
      i++;
      continue;
    }

    // Default: accumulate into current paragraph.
    closeList();
    paragraph.push(line.trim());
    i++;
  }

  flushParagraph();
  closeList();
  return html.join("\n");
}

function renderCodeBlock(block: CodeBlock): string {
  const langClass = block.lang ? ` class="language-${escapeHtml(block.lang)}"` : "";
  const langLabel = block.lang
    ? `<span class="code-lang">${escapeHtml(block.lang)}</span>`
    : "";
  const body = highlightCode(block.code, block.lang);
  return (
    `<div class="code-block">` +
    `<div class="code-head">${langLabel}` +
    `<button class="code-copy" title="Copy code">Copy</button></div>` +
    `<pre><code${langClass}>${body}</code></pre>` +
    `</div>`
  );
}

// --- syntax highlighting (lightweight, language-agnostic) ---

const KEYWORDS = new Set(
  (
    "abstract as async await break case catch class const continue def default defer del delete do " +
    "elif else enum except export extends false final finally fn for from func function go if impl " +
    "import in interface is lambda let loop match mod namespace new nil none null package pass pub " +
    "raise return self static struct super switch this throw trait true try type typeof use var " +
    "void while with yield select insert update create table where join on group order by limit " +
    "echo fi then done esac"
  ).split(" ")
);

const HASH_COMMENT_LANGS = new Set([
  "python", "py", "bash", "sh", "shell", "zsh", "yaml", "yml", "toml", "ruby", "rb", "dockerfile", "makefile", "ini",
]);

function span(cls: string, text: string): string {
  return `<span class="tok-${cls}">${escapeHtml(text)}</span>`;
}

/** Color a unified diff: additions green, deletions red, hunks/headers dim. */
function highlightDiff(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      let cls = "";
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
        cls = "diff-meta";
      } else if (line.startsWith("@@")) {
        cls = "diff-hunk";
      } else if (line.startsWith("+")) {
        cls = "diff-add";
      } else if (line.startsWith("-")) {
        cls = "diff-del";
      }
      const text = escapeHtml(line);
      return cls ? `<span class="${cls}">${text}</span>` : text;
    })
    .join("\n");
}

/**
 * Tokenize code into comments, strings, numbers and keywords. Everything is
 * HTML-escaped; only fixed <span class="tok-*"> wrappers are emitted.
 */
function highlightCode(code: string, langRaw: string): string {
  const lang = langRaw.toLowerCase();
  if (lang === "diff" || lang === "patch") {
    return highlightDiff(code);
  }
  if (!lang) {
    return escapeHtml(code);
  }
  const lineComment = HASH_COMMENT_LANGS.has(lang)
    ? "#[^\\n]*"
    : lang === "sql"
      ? "--[^\\n]*"
      : "\\/\\/[^\\n]*";
  const blockComment = HASH_COMMENT_LANGS.has(lang) ? "" : "|\\/\\*[\\s\\S]*?(?:\\*\\/|$)";
  const re = new RegExp(
    `(${lineComment}${blockComment})` + // 1 comment
      `|("(?:[^"\\\\\\n]|\\\\.)*"?|'(?:[^'\\\\\\n]|\\\\.)*'?|\`(?:[^\`\\\\]|\\\\.)*\`?)` + // 2 string
      `|(\\b\\d[\\d_.]*(?:[eE][+-]?\\d+)?\\b|\\b0x[0-9a-fA-F]+\\b)` + // 3 number
      `|([A-Za-z_$][\\w$]*)`, // 4 identifier
    "g"
  );
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out += escapeHtml(code.slice(last, m.index));
    if (m[1] !== undefined) {
      out += span("comment", m[0]);
    } else if (m[2] !== undefined) {
      out += span("string", m[0]);
    } else if (m[3] !== undefined) {
      out += span("number", m[0]);
    } else if (KEYWORDS.has(m[0].toLowerCase())) {
      out += span("keyword", m[0]);
    } else {
      out += escapeHtml(m[0]);
    }
    last = m.index + m[0].length;
  }
  out += escapeHtml(code.slice(last));
  return out;
}
