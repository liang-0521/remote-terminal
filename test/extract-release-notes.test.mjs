import assert from "node:assert/strict";
import test from "node:test";

import { extractReleaseNotes } from "../scripts/extract-release-notes.mjs";

test("extracts only the requested CHANGELOG body and preserves Markdown", () => {
  const changelog = `# 更新记录

## 0.2.0 - 2026-07-14

Windows-only Tauri 2 版本。

- 支持签名更新。
- 保留 **Markdown**。

## 0.1.0 - 2026-07-14

旧版本。
`;

  assert.equal(
    extractReleaseNotes(changelog, "0.2.0"),
    "Windows-only Tauri 2 版本。\n\n- 支持签名更新。\n- 保留 **Markdown**。",
  );
});

test("accepts a bracketed v-prefixed heading and CRLF input", () => {
  const changelog = "# Changelog\r\n\r\n## [v0.2.0] - 2026-07-14\r\n\r\nRelease body.\r\n";
  assert.equal(extractReleaseNotes(changelog, "v0.2.0"), "Release body.");
});

test("rejects missing, duplicate, and empty version sections", () => {
  assert.throws(
    () => extractReleaseNotes("## 0.1.0\n\nOld release.\n", "0.2.0"),
    /no section for version 0\.2\.0/,
  );
  assert.throws(
    () => extractReleaseNotes("## 0.2.0\n\nFirst.\n\n## 0.2.0\n\nSecond.\n", "0.2.0"),
    /multiple sections for version 0\.2\.0/,
  );
  assert.throws(
    () => extractReleaseNotes("## 0.2.0\n\n## 0.1.0\n\nOld release.\n", "0.2.0"),
    /section for version 0\.2\.0 is empty/,
  );
});

test("rejects invalid release versions", () => {
  assert.throws(() => extractReleaseNotes("## 0.2.0\n\nRelease.\n", "latest"), /Invalid release version/);
});
