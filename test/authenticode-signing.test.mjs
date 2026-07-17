import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("v0.5.1 发布版本在 Web、Rust 与 Tauri 元数据中保持一致", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const cargoToml = readFileSync("src-tauri/Cargo.toml", "utf8");
  const cargoLock = readFileSync("src-tauri/Cargo.lock", "utf8");

  assert.equal(packageJson.version, "0.5.1");
  assert.equal(packageLock.version, "0.5.1");
  assert.equal(packageLock.packages[""].version, "0.5.1");
  assert.equal(tauriConfig.version, "0.5.1");
  assert.match(cargoToml, /^version = "0\.5\.1"$/m);
  assert.match(cargoLock, /\[\[package\]\]\r?\nname = "remote-terminal"\r?\nversion = "0\.5\.1"/);
});

test("Windows 发布配置不再要求 Authenticode 证书", () => {
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const windows = config.bundle.windows;

  assert.equal(Object.hasOwn(windows, "certificateThumbprint"), false);
  assert.equal(Object.hasOwn(windows, "digestAlgorithm"), false);
  assert.equal(Object.hasOwn(windows, "signCommand"), false);
});

test("发布工作流不预检或复验 Authenticode", () => {
  const workflow = readFileSync(".github/workflows/release-windows.yml", "utf8");

  assert.doesNotMatch(workflow, /Authenticode/i);
  assert.doesNotMatch(workflow, /windows-authenticode\.ps1/);
  assert.doesNotMatch(workflow, /WINDOWS_CODESIGN_/);
  assert.doesNotMatch(workflow, /REMOTE_TERMINAL_AUTHENTICODE_/);
});

test("发布仍强制 updater 签名和 SHA-256 校验", () => {
  const workflow = readFileSync(".github/workflows/release-windows.yml", "utf8");

  assert.match(workflow, /default: "v0\.5\.1"/);
  assert.match(workflow, /\$expectedVersion = "0\.5\.1"/);
  assert.doesNotMatch(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.doesNotMatch(workflow, /tauri-apps\/tauri-action/);
  assert.match(workflow, /Validate locally signed release assets and create checksums/);
  assert.match(workflow, /\.exe\.sig/);
  assert.match(workflow, /verify_external_update_signature/);
  assert.match(workflow, /Get-FileHash -LiteralPath \$assetPath -Algorithm SHA256/);
  assert.match(workflow, /SHA256SUMS\.txt/);
});

test("发布工作流复用单一 Rust 构建目录并优先使用 npm 缓存", () => {
  const workflow = readFileSync(".github/workflows/release-windows.yml", "utf8");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

  assert.match(workflow, /CARGO_BUILD_TARGET: x86_64-pc-windows-msvc/);
  assert.doesNotMatch(workflow, /cargo test[^\r\n]*--target/);
  assert.match(workflow, /npm ci --prefer-offline --no-audit --no-fund/);
  assert.match(workflow, /run: npm run test:rust/);
  assert.match(workflow, /run: npm run test:ssh/);
  assert.match(workflow, /verify_external_update_signature/);
  assert.equal(packageJson.scripts["test:rust"], "cargo test --locked --manifest-path src-tauri/Cargo.toml");
  assert.equal(packageJson.scripts["test:ssh"], "node scripts/qa-rust-ssh.mjs");
  assert.equal(packageJson.scripts["package:win"], "tauri build --bundles nsis");
});
