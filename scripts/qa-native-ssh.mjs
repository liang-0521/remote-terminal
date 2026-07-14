import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { startSshServer } from "../test-support/ssh-fixture.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDirectory = path.join(projectRoot, "artifacts", "qa");
const isolatedAppData = path.join(artifactDirectory, `native-ssh-appdata-${process.pid}`);
await mkdir(isolatedAppData, { recursive: true });

const fixture = await startSshServer();
const electronApp = await electron.launch({
  args: [projectRoot],
  cwd: projectRoot,
  env: {
    ...process.env,
    REMOTE_TERMINAL_TEST_USER_DATA: isolatedAppData,
  },
  timeout: 30_000,
});

try {
  const page = await electronApp.firstWindow({ timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("heading", { name: "新增 SSH 连接" }).waitFor();
  await page.locator("#connection-name").fill("本地 SSH 验收");
  await page.locator("#connection-host").fill("127.0.0.1");
  await page.locator("#connection-port").fill(String(fixture.port));
  await page.locator("#connection-password").fill("test-password");
  const savePassword = page.locator("#connection-savePassword");
  await savePassword.waitFor();
  assert.equal(await savePassword.isChecked(), false, "保存密码必须默认关闭");
  await savePassword.check();
  await page.getByRole("button", { name: "保存并连接" }).click();

  await page.getByRole("heading", { name: "确认服务器主机指纹" }).waitFor();
  await page.getByRole("button", { name: "指纹一致，继续连接" }).click();
  await page.locator(".native-xterm").waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector(".native-xterm")?.textContent?.includes("integration-ready$"));

  await page.locator(".native-xterm .xterm-helper-textarea").focus();
  await page.keyboard.press("Control+Shift+P");
  const search = page.getByRole("combobox", { name: "搜索命令模板" });
  await search.fill("内存");
  await page.getByRole("option", { name: /free -h/ }).waitFor();
  assert.equal(await search.evaluate((element) => document.activeElement === element), true);
  await page.screenshot({
    path: path.join(artifactDirectory, "native-ssh-command-template-smoke.png"),
    fullPage: true,
  });
  await search.press("Tab");
  await page.waitForFunction(() => document.querySelector(".native-xterm")?.textContent?.includes("free -h"));
  assert.equal(await page.locator(".native-command-palette").count(), 0);

  const connectionFile = path.join(isolatedAppData, "data", "connections.json");
  const credentialFile = path.join(isolatedAppData, "data", "credentials.json");
  const storedConnection = await readFile(connectionFile, "utf8");
  const storedCredential = await readFile(credentialFile, "utf8");
  assert.equal(storedConnection.includes("test-password"), false, "密码不得写入连接配置");
  assert.equal(storedCredential.includes("test-password"), false, "加密凭据文件不得出现密码明文");

  const savedCredentialRoundTrip = await page.evaluate(async () => {
    const status = await window.remoteTerminal.credentials.status();
    const listed = await window.remoteTerminal.connections.list();
    if (!status.ok || !status.data.available || !listed.ok || !listed.data[0]?.hasSavedPassword) {
      return { status, listed, connected: null };
    }
    const connectionId = listed.data[0].id;
    const hostKey = await window.remoteTerminal.hostKeys.probe(connectionId);
    const connected = await window.remoteTerminal.ssh.connect({
      connectionId,
      credential: { source: "saved" },
      dimensions: { cols: 100, rows: 28 },
    });
    if (connected.ok) await window.remoteTerminal.ssh.disconnect(connected.data.sessionId);
    return { status, listed, hostKey, connected };
  });
  assert.equal(savedCredentialRoundTrip.status.ok, true);
  assert.equal(savedCredentialRoundTrip.status.data.available, true);
  assert.equal(savedCredentialRoundTrip.listed.data[0].hasSavedPassword, true);
  assert.equal(savedCredentialRoundTrip.hostKey.data.status, "trusted");
  assert.equal(savedCredentialRoundTrip.connected.ok, true, "保存密码应能通过 Windows safeStorage 解密并重新连接");

  await page.getByRole("button", { name: "服务器连接" }).click();
  await page.getByRole("button", { name: "管理连接与密码" }).click();
  await page.getByRole("heading", { name: "连接管理" }).waitFor();
  await page.getByText("密码已由 Windows 加密保存", { exact: true }).waitFor();
  await page.getByRole("button", { name: "清除已保存密码" }).waitFor();
  await page.getByRole("button", { name: "删除连接" }).waitFor();
  await page.screenshot({
    path: path.join(artifactDirectory, "native-connection-manager-smoke.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "删除连接" }).click();
  await page.getByRole("button", { name: "再次点击确认删除" }).waitFor();
  assert.equal(await page.locator(".connection-manager").getByText("本地 SSH 验收", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "关闭连接管理" }).click();

  const clipboardRoundTrip = await page.evaluate(async () => {
    const original = await window.remoteTerminal.clipboard.readText();
    if (!original.ok) return { preserved: false, reason: original.error?.code };
    let written = null;
    let read = null;
    let restored = null;
    try {
      written = await window.remoteTerminal.clipboard.writeText("remote-terminal-clipboard-check");
      read = await window.remoteTerminal.clipboard.readText();
    } finally {
      restored = await window.remoteTerminal.clipboard.writeText(original.data);
    }
    return { preserved: restored.ok, written: written?.ok, valueMatches: read?.data === "remote-terminal-clipboard-check" };
  });
  assert.deepEqual(clipboardRoundTrip, { preserved: true, written: true, valueMatches: true });

  console.log(JSON.stringify({
    status: "passed",
    terminal: "real-ssh2",
    hostKeyConfirmed: true,
    commandTemplateInsertedWithoutExecute: true,
    passwordPersistedEncrypted: true,
    safeStorageRoundTrip: true,
    clipboardRoundTrip: true,
    screenshot: path.join(artifactDirectory, "native-ssh-command-template-smoke.png"),
    connectionManagerScreenshot: path.join(artifactDirectory, "native-connection-manager-smoke.png"),
  }, null, 2));
} finally {
  await electronApp.close();
  await fixture.close();
}
