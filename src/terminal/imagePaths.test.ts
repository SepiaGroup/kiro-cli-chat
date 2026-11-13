import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "os";
import * as path from "path";
import { findImagePaths, sniffImageMime } from "./imagePaths";

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

test("sniffImageMime checks the file's first bytes", () => {
  assert.equal(sniffImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  assert.equal(sniffImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageMime(Buffer.from("GIF89a")), "image/gif");
  assert.equal(sniffImageMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffImageMime(Buffer.from("#!/bin/sh\n")), undefined);
});
