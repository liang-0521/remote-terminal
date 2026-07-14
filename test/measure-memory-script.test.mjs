import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("Windows memory benchmark script passes its isolated self-test", { timeout: 30_000 }, (t) => {
  const scriptPath = resolve("scripts/measure-memory.ps1");
  const result = spawnSync(
    "pwsh.exe",
    ["-NoLogo", "-NoProfile", "-File", scriptPath, "-SelfTest"],
    {
      cwd: resolve("."),
      encoding: "utf8",
      timeout: 25_000,
      windowsHide: true,
    },
  );

  if (result.error?.code === "EPERM") {
    t.skip("sandbox blocks child PowerShell; run script self-test separately");
    return;
  }

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /measure-memory self-test passed\./);
});
