import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { makeNonce, webviewHtml } from "./webviewHtml";

const html = webviewHtml({ scriptUri: "vscode-resource:/w.js", styleUri: "vscode-resource:/w.css", cspSource: "vscode-resource:", nonce: "N0nce" });

test("CSP allows only the extension's script (by nonce), styles and images", () => {
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
  assert.equal(csp, "default-src 'none'; img-src vscode-resource: data:; style-src vscode-resource:; script-src 'nonce-N0nce'");
  assert.match(html, /<script nonce="N0nce" src="vscode-resource:\/w\.js"><\/script>/);
  assert.match(html, /<link href="vscode-resource:\/w\.css" rel="stylesheet" \/>/);
  assert.doesNotMatch(html, /style="/);
});

test("every element the webview script looks up by id is in the page", () => {
  const dir = join(__dirname, "..", "src", "webview");
  const ids = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
    for (const m of readFileSync(join(dir, f), "utf8").matchAll(/byId\("([^"]+)"\)/g)) {
      ids.add(m[1]);
    }
  }
  assert.ok(ids.size > 10);
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test("nonces are random and safe in an attribute", () => {
  const a = makeNonce();
  assert.notEqual(a, makeNonce());
  assert.match(a, /^[A-Za-z0-9_-]{24}$/);
});
