import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFolder, folderOffer, folderResource, normalizePath, shellPattern, truncate } from "./approvalRules";

test("shellPattern", () => {
  assert.equal(shellPattern("cat src/a.ts"), "cat *");
  assert.equal(shellPattern("head"), "head *");
  assert.equal(shellPattern("sudo rm -rf x"), undefined);
  assert.equal(shellPattern("FOO=1 make"), undefined);
  assert.equal(shellPattern("env X=1 ls"), undefined);
});

test("normalizePath", () => {
  assert.equal(normalizePath("src//a/./b/"), "src/a/b");
  assert.equal(normalizePath("./"), ".");
  assert.equal(normalizePath("/"), "/");
  assert.equal(normalizePath("src\\a"), "src/a");
  assert.equal(normalizePath("src/../x"), undefined);
});

test("folderOffer", () => {
  assert.deepEqual(folderOffer({ capability: "fs_write", resource: "src/a.ts", workspaceRoot: "/ws" }), {
    prefill: "src",
    target: "src/a.ts",
    inWorkspace: true,
  });
  assert.deepEqual(folderOffer({ capability: "fs_write", resource: "/tmp/x/y.txt" }), {
    prefill: "/tmp/x",
    target: "/tmp/x/y.txt",
    inWorkspace: false,
  });
  assert.equal(folderOffer({ capability: "fs_read", resource: "src/a.ts" }), undefined);
  assert.equal(folderOffer({ capability: "fs_write", resource: "src/a.ts", askType: "explicit" }), undefined);
  assert.equal(folderOffer({ capability: "fs_write", resource: "src/*.ts", workspaceRoot: "/ws" }), undefined);
  // Absolute path while in a workspace: no offer (as in the TUI).
  assert.equal(folderOffer({ capability: "fs_write", resource: "/ws/src/a.ts", workspaceRoot: "/ws" }), undefined);
});

test("checkFolder follows the TUI's rules", () => {
  const ws = { prefill: "src/a", target: "src/a/b.ts", inWorkspace: true };
  assert.deepEqual(checkFolder(ws, "src/"), { ok: true, path: "src" });
  assert.deepEqual(checkFolder(ws, " src/a "), { ok: true, path: "src/a" });
  const reason = (input: string, offer = ws) => {
    const r = checkFolder(offer, input);
    return r.ok ? "ok" : r.reason;
  };
  assert.equal(reason(""), "Type a folder path.");
  assert.equal(reason("src/../.."), 'The folder cannot step up with "..".');
  assert.equal(reason("~/x"), "Spell out the folder instead of using ~.");
  assert.equal(reason("src/*"), "Type one folder, not a pattern; everything under it is included.");
  assert.equal(reason("."), "Type a folder inside the workspace, like src/MyPackage.");
  assert.equal(reason("/ws/src"), "Type a folder inside the workspace, like src/MyPackage.");
  assert.equal(reason("lib"), "The folder must contain src/a/b.ts.");
  const out = { prefill: "/tmp/x", target: "/tmp/x/y.txt", inWorkspace: false };
  assert.equal(reason("/tmp", out), "ok");
  assert.equal(reason("/", out), "ok");
  assert.equal(reason("/var", out), "The folder must contain /tmp/x/y.txt.");
});

test("folderResource and truncate", () => {
  assert.equal(folderResource("src"), "src/**");
  assert.equal(folderResource("/"), "/**");
  assert.equal(truncate("x".repeat(60)), "x".repeat(47) + "…");
  assert.equal(truncate("short"), "short");
});
