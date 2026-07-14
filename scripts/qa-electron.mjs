import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDirectory = path.join(projectRoot, "artifacts", "qa");
await mkdir(screenshotDirectory, { recursive: true });
const production = process.argv.includes("--production");
const executableIndex = process.argv.indexOf("--executable");
const executablePath = executableIndex >= 0 ? path.resolve(process.argv[executableIndex + 1] || "") : null;
const mode = executablePath ? "packaged" : production ? "production" : "development";
const qaUserDataDirectory = path.join(screenshotDirectory, `${mode}-user-data-${process.pid}`);

const pageErrors = [];
const consoleErrors = [];
const electronApp = await electron.launch({
  ...(executablePath
    ? { executablePath, args: [`--user-data-dir=${qaUserDataDirectory}`] }
    : { args: [projectRoot, ...(production ? [] : ["--dev"]), `--user-data-dir=${qaUserDataDirectory}`] }),
  cwd: projectRoot,
  timeout: 30_000,
});

try {
  const page = await electronApp.firstWindow({ timeout: 30_000 });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => document.querySelector(".app-root, .native-startup-state, .native-runtime-error"));

  const runtime = await page.evaluate(() => window.remoteTerminal?.runtime);
  assert.deepEqual(runtime, { kind: "electron", version: 1 });
  assert.equal(await page.locator("body").getByText("演示模式", { exact: true }).count(), 0);

  const connectionTitle = page.getByRole("heading", { name: "新增 SSH 连接" });
  if (!await connectionTitle.count()) {
    await page.locator(".server-add-button").click();
    await connectionTitle.waitFor();
  }
  const nameInput = page.locator("#connection-name");
  await nameInput.fill("焦点稳定性检查");
  await page.waitForTimeout(mode === "packaged" ? 11_500 : 1_200);
  assert.equal(await nameInput.inputValue(), "焦点稳定性检查");
  assert.equal(await nameInput.evaluate((element) => document.activeElement === element), true);
  await page.getByRole("button", { name: "关闭连接管理" }).click();

  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
  await page.getByRole("heading", { name: "客户端更新" }).waitFor();
  await page.getByText("当前版本", { exact: false }).waitFor();
  await page.screenshot({
    path: path.join(screenshotDirectory, `native-electron-${mode}-settings.png`),
    fullPage: true,
  });
  await page.getByRole("button", { name: "完成" }).click();
  await page.locator(".server-add-button").click();
  await page.getByRole("heading", { name: "新增 SSH 连接" }).waitFor();

  await page.screenshot({
    path: path.join(screenshotDirectory, `native-electron-${mode}-smoke.png`),
    fullPage: true,
  });

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  console.log(JSON.stringify({
    mode,
    runtime,
    url: page.url(),
    title: await page.title(),
    focusStable: true,
    screenshot: path.join(screenshotDirectory, `native-electron-${mode}-smoke.png`),
  }, null, 2));
} finally {
  await electronApp.close();
}
