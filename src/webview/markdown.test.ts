import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "./markdown";

const stripTags = (h: string): string => h.replace(/<[^>]+>/g, "");

test("escapes HTML to prevent injection", () => {
  const html = renderMarkdown("<script>alert(1)</script>");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("renders bold and italic", () => {
  assert.ok(renderMarkdown("**bold**").includes("<strong>bold</strong>"));
  assert.ok(renderMarkdown("*italic*").includes("<em>italic</em>"));
});

test("renders inline code", () => {
  assert.ok(renderMarkdown("use `npm run build`").includes("<code>npm run build</code>"));
});

test("renders fenced code block with language and copy button", () => {
  const html = renderMarkdown("```ts\nconst x = 1;\n```");
  assert.ok(html.includes('class="language-ts"'));
  assert.ok(stripTags(html).includes("const x = 1;"));
  assert.ok(html.includes("code-copy"));
});

test("renders headings and lists", () => {
  assert.ok(renderMarkdown("# Title").includes("<h1>Title</h1>"));
  const list = renderMarkdown("- a\n- b");
  assert.ok(list.includes("<ul>"));
  assert.ok(list.includes("<li>a</li>"));
});

test("renders safe links and drops unsafe schemes", () => {
  const safe = renderMarkdown("[site](https://example.com)");
  assert.ok(safe.includes('href="https://example.com"'));
  assert.ok(safe.includes('target="_blank"'));
  const unsafe = renderMarkdown("[x](javascript:alert(1))");
  assert.ok(!unsafe.includes("javascript:"));
});

test("tolerates unterminated code fence (streaming)", () => {
  const html = renderMarkdown("```js\nconst y = 2;");
  assert.ok(stripTags(html).includes("const y = 2;"));
  assert.ok(html.includes("<pre>"));
});

test("highlights keywords, strings, numbers and comments", () => {
  const html = renderMarkdown('```ts\nconst s = "hi"; // note\nlet n = 42;\n```');
  assert.ok(html.includes('<span class="tok-keyword">const</span>'));
  assert.ok(html.includes('<span class="tok-string">&quot;hi&quot;</span>'));
  assert.ok(html.includes('<span class="tok-comment">// note</span>'));
  assert.ok(html.includes('<span class="tok-number">42</span>'));
});

test("colors diff additions and deletions", () => {
  const html = renderMarkdown("```diff\n-old\n+new\n@@ -1 +1 @@\n```");
  assert.ok(html.includes('<span class="diff-add">+new</span>'));
  assert.ok(html.includes('<span class="diff-del">-old</span>'));
  assert.ok(html.includes("diff-hunk"));
});

test("highlighting never lets code inject HTML", () => {
  const html = renderMarkdown('```js\nconst x = "<img src=x onerror=alert(1)>";\n```');
  assert.ok(!html.includes("<img"));
});
