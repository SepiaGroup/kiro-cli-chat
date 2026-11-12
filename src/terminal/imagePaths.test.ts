import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "os";
import * as path from "path";
import { findImagePaths } from "./imagePaths";

test("finds quoted, escaped, home, relative and file:// image paths", () => {
  const text =
    "what is in '/Users/me/Desktop/Screenshot 1.png' and /tmp/a\\ b.JPG " +
    "and ~/pics/c.webp, ./d.gif plus file:///tmp/e.jpeg?";
  assert.deepEqual(findImagePaths(text, "/work"), [
    "/Users/me/Desktop/Screenshot 1.png",
    "/tmp/a b.JPG",
    path.join(os.homedir(), "pics/c.webp"),
    "/work/d.gif",
    "/tmp/e.jpeg",
  ]);
});

test("ignores non-image paths, plain words and duplicates", () => {
  assert.deepEqual(findImagePaths("edit /src/a.ts and say png", "/w"), []);
  assert.deepEqual(findImagePaths("/x/y.png /x/y.png", "/w"), ["/x/y.png"]);
});

test("bare file name in the working folder counts", () => {
  assert.deepEqual(findImagePaths("look at logo.png please", "/w"), ["/w/logo.png"]);
});
