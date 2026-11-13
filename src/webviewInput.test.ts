import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_IMAGE_BYTES, MAX_IMAGES, sanitizeImages } from "./webviewInput";

test("sanitizeImages keeps only well-formed images within limits", () => {
  const ok = { mimeType: "image/png", data: "iVBORw0KGgo=", name: "a.png" };
  assert.deepEqual(sanitizeImages([ok]), [ok]);
  assert.deepEqual(sanitizeImages("x"), []);
  assert.deepEqual(
    sanitizeImages([
      null,
      { mimeType: "image/svg+xml", data: "PHN2Zz4=" },
      { mimeType: "image/png", data: "not base64!" },
      { mimeType: "image/png", data: "A".repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) },
    ]),
    []
  );
  assert.equal(sanitizeImages(Array(MAX_IMAGES + 3).fill(ok)).length, MAX_IMAGES);
  assert.equal(sanitizeImages([{ ...ok, name: "n".repeat(500) }])[0].name?.length, 200);
});
