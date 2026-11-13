import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { executableProblem, resolveCliPath } from "./cli";

test("a configured kiro-cli path must be an executable file", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiro-cli-"));
  try {
    const exe = join(dir, "kiro-cli");
    writeFileSync(exe, "#!/bin/sh\n");
    chmodSync(exe, 0o644);
    assert.equal(executableProblem(exe), "isn't executable");
    chmodSync(exe, 0o755);
    assert.equal(executableProblem(exe), undefined);
    assert.equal(resolveCliPath(` ${exe} `), exe);
    assert.equal(executableProblem(dir), "isn't a file");
    assert.throws(() => resolveCliPath(join(dir, "nope")), /kiroCliPath is set to ".*nope", which doesn't exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
