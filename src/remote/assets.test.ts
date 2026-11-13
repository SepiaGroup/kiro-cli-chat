import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSET_NAMES, assetType } from "./assets";
import { REMOTE_ASSETS } from "./remotePage";

test("every file the remote page loads is servable, with a content type", () => {
  for (const path of Object.values(REMOTE_ASSETS)) {
    const name = path.replace("/static/", "");
    assert.ok(ASSET_NAMES.has(name), name);
    assert.ok(assetType(name), name);
  }
});

test("only listed files have a type", () => {
  assert.match(assetType("webview.js") ?? "", /javascript/);
  assert.match(assetType("manifest.webmanifest") ?? "", /manifest\+json/);
  assert.equal(assetType("webview.js.map"), undefined);
  assert.equal(assetType("../package.json"), undefined);
  assert.equal(assetType("secrets.txt"), undefined);
});
