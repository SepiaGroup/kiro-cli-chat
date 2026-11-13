import { test } from "node:test";
import assert from "node:assert/strict";
import { errorMessage, formatElapsed } from "./format";

test("formatElapsed", () => {
  assert.equal(formatElapsed(4200), "4.2s");
  assert.equal(formatElapsed(125_000), "2m 5s");
});

test("errorMessage", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("plain"), "plain");
});
