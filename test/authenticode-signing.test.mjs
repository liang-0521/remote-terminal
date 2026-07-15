import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const signingScript = "scripts/windows-authenticode.ps1";

test("Windows 发布配置强制通过 Authenticode 签名入口", () => {
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const windows = config.bundle.windows;

  assert.equal(windows.digestAlgorithm, "sha256");
  assert.deepEqual(windows.signCommand, {
    cmd: "powershell",
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "../scripts/windows-authenticode.ps1",
      "-Mode",
      "Sign",
      "-Path",
      "%1",
    ],
  });
});

test("Authenticode 脚本自检覆盖证书指纹和时间戳地址边界", (t) => {
  const result = spawnSync("pwsh.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    signingScript,
    "-Mode",
    "SelfTest",
  ], { encoding: "utf8" });

  if (result.error?.code === "EPERM") {
    t.skip("sandbox blocks child PowerShell; run Authenticode self-test separately");
    return;
  }
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    passed: true,
    digestAlgorithm: "sha256",
    rejectsInvalidThumbprints: true,
    rejectsUnsafeTimestampUrls: true,
  });
});

test("发布工作流在发布前预检身份并复验最终安装包", () => {
  const workflow = readFileSync(".github/workflows/release-windows.yml", "utf8");

  assert.match(workflow, /Verify Authenticode signing identity/);
  assert.match(workflow, /windows-authenticode\.ps1 -Mode Preflight/);
  assert.match(workflow, /windows-authenticode\.ps1 -Mode Verify -Path \$installerPath/);
  assert.match(workflow, /WINDOWS_CODESIGN_CERTIFICATE_THUMBPRINT/);
  assert.match(workflow, /WINDOWS_CODESIGN_TIMESTAMP_URL/);
  assert.match(workflow, /REMOTE_TERMINAL_AUTHENTICODE_CERTIFICATE_THUMBPRINT: \$\{\{ vars\.WINDOWS_CODESIGN_CERTIFICATE_THUMBPRINT \}\}/);
});

test("未签名发布必须由 v0.3.1 显式选择且不能伪装成已签名", () => {
  const workflow = readFileSync(".github/workflows/release-windows.yml", "utf8");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const unsignedConfig = JSON.parse(readFileSync("src-tauri/tauri.unsigned-0.3.1.conf.json", "utf8"));

  assert.equal(
    packageJson.scripts["package:win:unsigned"],
    "tauri build --bundles nsis --config src-tauri/tauri.unsigned-0.3.1.conf.json",
  );
  assert.equal(unsignedConfig.version, "0.3.1");
  assert.equal(unsignedConfig.bundle.windows.signCommand, null);
  assert.match(workflow, /allow_unsigned:/);
  assert.match(workflow, /unsigned release exception is limited to version 0\.3\.1/);
  assert.match(workflow, /Build explicitly unsigned Tauri release draft/);
  assert.match(workflow, /--ci --config src-tauri\/tauri\.unsigned-0\.3\.1\.conf\.json/);
  assert.doesNotMatch(workflow, /--no-sign/);
  assert.match(workflow, /SignatureStatus\]::NotSigned/);
});

test("最终验签必须绑定配置的发布者证书指纹", () => {
  const script = readFileSync(signingScript, "utf8");

  assert.match(script, /AUTHENTICODE_SIGNER_MISMATCH/);
  assert.match(script, /SignerCertificate\.Thumbprint/);
  assert.match(script, /-ExpectedThumbprint \$expectedThumbprint/);
});

test("Authenticode 验证拒绝非 EXE 输入且不回显文件内容", (t) => {
  const result = spawnSync("pwsh.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    signingScript,
    "-Mode",
    "Verify",
    "-Path",
    "package.json",
  ], { encoding: "utf8" });

  if (result.error?.code === "EPERM") {
    t.skip("sandbox blocks child PowerShell; run Authenticode verification separately");
    return;
  }
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /AUTHENTICODE_TARGET_INVALID/);
});
