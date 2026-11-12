import { test } from "node:test";
import assert from "node:assert/strict";
import { MarkdownStream, newMdState, renderInline, renderMarkdownLine } from "./ansiMarkdown";
import { fitAnsi, sanitize, stripAnsi, rowsBelowStart, wrapAnsi } from "./ansi";

test("inline: bold, italic, code, strike, links", () => {
  assert.equal(renderInline("a **b** c"), "a \x1b[1mb\x1b[22m c");
  assert.equal(renderInline("an *it* x"), "an \x1b[3mit\x1b[23m x");
  assert.equal(renderInline("run `npm **x**`"), "run \x1b[36mnpm **x**\x1b[39m");
  assert.equal(renderInline("~~old~~"), "\x1b[9mold\x1b[29m");
  assert.equal(
    stripAnsi(renderInline("see [docs](https://x.dev/a)")),
    "see docs (https://x.dev/a)"
  );
});

test("inline: snake_case and lone asterisks are left alone", () => {
  assert.equal(renderInline("my_var_name"), "my_var_name");
  assert.equal(renderInline("2 * 3 * 4"), "2 * 3 * 4");
});

test("block lines: headings, bullets, ordered, quote, hr", () => {
  const st = newMdState();
  assert.equal(stripAnsi(renderMarkdownLine("## Title", st)), "Title");
  assert.equal(stripAnsi(renderMarkdownLine("- item **x**", st)), "• item x");
  assert.equal(stripAnsi(renderMarkdownLine("  * nested", st)), "  • nested");
  assert.equal(stripAnsi(renderMarkdownLine("3. third", st)), "3. third");
  assert.equal(stripAnsi(renderMarkdownLine("> quoted", st)), "│ quoted");
  assert.equal(stripAnsi(renderMarkdownLine("- [x] done", st)), "☑ done");
  assert.match(stripAnsi(renderMarkdownLine("---", st, 20)), /^─+$/);
});

test("code fences: framed, contents not formatted, diff colored", () => {
  const st = newMdState();
  assert.equal(stripAnsi(renderMarkdownLine("```diff", st)), "╭─ diff");
  assert.equal(st.inCode, true);
  assert.equal(renderMarkdownLine("+added", st), "\x1b[90m│ \x1b[39m\x1b[32m+added\x1b[39m");
  assert.equal(stripAnsi(renderMarkdownLine("**not bold**", st)), "│ **not bold**");
  assert.equal(stripAnsi(renderMarkdownLine("```", st)), "╰─");
  assert.equal(st.inCode, false);
});

test("stream: partial line shown raw, then rewritten formatted on newline", () => {
  const md = new MarkdownStream(() => 80);
  assert.equal(md.feed("Hello **wor"), "Hello **wor");
  assert.equal(md.atLineStart, false);
  const out = md.feed("ld**\nnext");
  // Erase the raw preview (\r + clear), draw formatted, newline, then raw "next".
  assert.equal(out, "\r\x1b[JHello \x1b[1mworld\x1b[22m\r\nnext");
  assert.equal(md.flush(), "\r\x1b[Jnext\r\n");
  assert.equal(md.atLineStart, true);
});

test("stream: rewrite moves up over wrapped rows", () => {
  const md = new MarkdownStream(() => 10);
  md.feed("x".repeat(25)); // 3 rows → cursor 2 rows below start
  assert.equal(md.feed("\n").startsWith("\r\x1b[2A\x1b[J"), true);
});

test("stream: unterminated code block is closed on flush", () => {
  const md = new MarkdownStream(() => 80);
  md.feed("```ts\nconst a = 1;\n");
  assert.equal(stripAnsi(md.flush()), "╰─\r\n");
});

test("sanitize strips escape sequences and control chars", () => {
  assert.equal(sanitize("a\x1b[2Jb\x1b]0;title\x07c\x07d\r\ne\tf"), "abcd\ne    f");
});

test("rowsBelowStart accounts for pending wrap", () => {
  assert.equal(rowsBelowStart(0, 10), 0);
  assert.equal(rowsBelowStart(9, 10), 0);
  assert.equal(rowsBelowStart(10, 10), 0);
  assert.equal(rowsBelowStart(11, 10), 1);
});

test("wrapAnsi breaks at word boundaries, ignores escapes, hard-breaks long words", () => {
  assert.equal(wrapAnsi("aaa bbb ccc", 8), "aaa bbb\r\nccc");
  assert.equal(wrapAnsi("\x1b[1maaa\x1b[22m bbb ccc", 8), "\x1b[1maaa\x1b[22m bbb\r\nccc");
  assert.equal(wrapAnsi("abcdefghijkl", 8), "abcdefgh\r\nijkl");
  assert.equal(wrapAnsi("short", 80), "short");
});

test("stream: wrapped list items get a hanging indent", () => {
  const md = new MarkdownStream(() => 12);
  const out = stripAnsi(md.feed("- one two three four\n"));
  assert.equal(out, "• one two\r\n  three four\r\n");
});

test("fitAnsi truncates visible text and keeps styling", () => {
  assert.equal(fitAnsi("hello", 10), "hello");
  assert.equal(fitAnsi("\x1b[36mhello world\x1b[39m", 6), "\x1b[36mhello…\x1b[0m");
});
