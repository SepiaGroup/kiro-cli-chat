import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanAnswer, MAX_ANSWER, MAX_IMAGE_BYTES, MAX_IMAGES, sanitizeImages } from "./webviewInput";

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

test("cleanAnswer trims, caps and treats nothing as a skipped question", () => {
  assert.equal(cleanAnswer("  blue "), "blue");
  assert.equal(cleanAnswer("x".repeat(MAX_ANSWER + 5))?.length, MAX_ANSWER);
  for (const v of [undefined, null, "", "   ", 5, {}]) {
    assert.equal(cleanAnswer(v), undefined);
  }
});
