import { test } from "node:test";
import assert from "node:assert/strict";
import { describeDrop, DropData, formatPath, imageMime, isImagePath, pathsFromDrop, uriToPath } from "./dropPaths";

function drop(data: Record<string, string>, files: DropData["files"] = []): DropData {
  return { getData: (f) => data[f] ?? "", types: Object.keys(data), files };
}

test("uriToPath keeps local paths only", () => {
  assert.equal(uriToPath("file:///Users/me/My%20File.ts"), "/Users/me/My File.ts");
  assert.equal(uriToPath("/tmp/a"), "/tmp/a");
  assert.equal(uriToPath("https://x.dev/a"), undefined);
  assert.equal(uriToPath("vscode-remote://ssh/x"), undefined);
  assert.equal(uriToPath("# comment"), undefined);
  assert.equal(uriToPath("file:///bad%E0"), "/bad%E0");
});

test("pathsFromDrop reads Explorer, uri-list and OS drops, without duplicates", () => {
  const dt = drop(
    { resourceurls: JSON.stringify(["file:///a/one.ts", "file:///a/two.png"]), "text/uri-list": "file:///a/one.ts\r\nfile:///a/three.md" },
    [{ name: "four", type: "", size: 1, path: "/a/four" }]
  );
  assert.deepEqual(pathsFromDrop(dt), ["/a/one.ts", "/a/two.png", "/a/three.md", "/a/four"]);
  assert.deepEqual(pathsFromDrop(drop({ resourceurls: "{not json", "text/plain": " /x/y " })), ["/x/y"]);
  assert.deepEqual(pathsFromDrop(drop({ "text/plain": "just words" })), []);
});

test("image helpers and path quoting", () => {
  assert.equal(imageMime("shot.PNG", ""), "image/png");
  assert.equal(imageMime("x", "image/webp"), "image/webp");
  assert.equal(imageMime("notes.txt", "text/plain"), undefined);
  assert.equal(isImagePath("/a/b.jpeg"), true);
  assert.equal(isImagePath("/a/b.svg"), false);
  assert.equal(formatPath("/a b/c"), '"/a b/c"');
  assert.equal(formatPath("/a/c"), "/a/c");
  assert.match(describeDrop(drop({ "text/uri-list": "file:///a" }, [{ name: "n", type: "", size: 2 }])), /types=\[text\/uri-list\] files=\[n\|\?\|2\]/);
});
