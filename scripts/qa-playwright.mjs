import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = "http://127.0.0.1:4173/";
const outputDir = path.resolve("artifacts/qa");
const passwordProbe = "qa-password-probe-7f3a91";
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const chromePath = [
  process.env.CHROME_PATH,
  String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
].find((candidate) => candidate && existsSync(candidate));

if (!chromePath) throw new Error("未找到可用于本地 QA 的 Chrome，请设置 CHROME_PATH");

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1024 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
const interactions = [];

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.message));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertVisible(locator, label) {
  await locator.waitFor({ state: "visible", timeout: 5000 });
  interactions.push(label);
}

function nearlyEqual(actual, expected, tolerance = 2) {
  return Math.abs(actual - expected) <= tolerance;
}

async function readStorage(page) {
  return page.evaluate(() => {
    const read = (storage) => Object.fromEntries(Array.from(
      { length: storage.length },
      (_, index) => {
        const key = storage.key(index);
        return [key, storage.getItem(key)];
      },
    ));
    return { local: read(localStorage), session: read(sessionStorage) };
  });
}

async function assertPageAndStorageExclude(page, value, label) {
  assert(!(await page.locator("body").innerText()).includes(value), `${label}出现在页面文本中`);
  const storage = await readStorage(page);
  assert(!JSON.stringify(storage).includes(value), `${label}写入 localStorage/sessionStorage`);
}

async function assertCompactTopHealth(page) {
  const topBar = page.locator(".top-bar");
  const summary = topBar.getByRole("button", { name: "打开性能监控" });
  await summary.waitFor({ state: "visible" });
  assert(await summary.locator(".top-health__item").count() === 3, "顶部摘要不是 CPU、内存、Swap 三项");
  assert(await summary.getByText("CPU", { exact: true }).count() === 1, "顶部缺少 CPU 摘要");
  assert(await summary.getByText("内存", { exact: true }).count() === 1, "顶部缺少内存摘要");
  assert(await summary.getByText("Swap", { exact: true }).count() === 1, "顶部缺少 Swap 摘要");
  assert(await summary.locator("progress").count() === 3, "顶部三项摘要缺少进度条");
  assert(!/(磁盘|核|KB\/s|系统负载)/.test(await topBar.innerText()), "顶栏出现核数、磁盘、网络或负载详情");
}

async function readLayout(page) {
  return page.evaluate(() => {
    const readBox = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        right: box.right,
        bottom: box.bottom,
      };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      topBar: readBox(".top-bar"),
      activityRail: readBox(".activity-rail"),
      settingsButton: readBox(".activity-rail > .icon-button"),
      explorer: readBox(".explorer-panel"),
      fileTree: readBox(".file-tree-shell"),
      terminal: readBox(".terminal-pane"),
      terminalSurface: readBox(".terminal-surface"),
      completion: readBox(".completion-popover"),
      bottomPanel: readBox(".bottom-panel"),
      statusBar: readBox(".status-bar"),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      verticalOverflow: document.documentElement.scrollHeight > window.innerHeight,
    };
  });
}

function assertDefaultLayout(layout) {
  assert(nearlyEqual(layout.topBar.height, 56), `顶栏高度异常：${layout.topBar.height}`);
  assert(nearlyEqual(layout.activityRail.width, 60), `活动栏宽度异常：${layout.activityRail.width}`);
  assert(nearlyEqual(layout.explorer.width, 320), `资源管理器宽度异常：${layout.explorer.width}`);
  assert(nearlyEqual(layout.bottomPanel.height, 168), `底部面板默认高度异常：${layout.bottomPanel.height}`);
  assert(nearlyEqual(layout.statusBar.height, 44), `状态栏高度异常：${layout.statusBar.height}`);
  assert(nearlyEqual(layout.explorer.bottom, layout.bottomPanel.y), "资源管理器与底部面板未对齐");
  assert(layout.fileTree.bottom <= layout.explorer.bottom, "远程文件列表超出资源管理器边界");
  assert(nearlyEqual(layout.terminal.bottom, layout.bottomPanel.y), "终端与底部面板未对齐");
  assert(nearlyEqual(layout.bottomPanel.bottom, layout.statusBar.y), "底部面板与状态栏未对齐");
  assert(layout.viewport.height - layout.settingsButton.bottom <= 12, "设置按钮未固定在视口底部");
  assert(layout.completion.x >= layout.terminal.x && layout.completion.right <= layout.terminal.right, "补全面板超出终端横向边界");
  assert(layout.completion.y >= layout.terminalSurface.y && layout.completion.bottom <= layout.terminalSurface.bottom, "补全面板超出终端纵向边界");
  assert(!layout.horizontalOverflow && !layout.verticalOverflow, "默认视口出现页面级溢出");
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await assertVisible(page.getByRole("heading", { name: "资源管理器" }), "默认资源管理器可见");
  await assertVisible(page.getByRole("textbox", { name: "终端命令输入" }), "终端命令输入可用");
  await assertVisible(page.getByRole("listbox", { name: "本地命令模板" }), "默认命令模板面板可见");
  await assertVisible(page.getByRole("button", { name: /命令模板/ }), "命令模板入口可见");
  await assertVisible(page.getByText("release-2026.07.14.tar.gz", { exact: true }).last(), "默认传输任务可见");

  const layout = await readLayout(page);
  assertDefaultLayout(layout);
  await assertCompactTopHealth(page);
  assert(await page.locator(".upload-zone").count() === 0, "独立上传框仍然存在");
  assert(await page.getByText("8 核", { exact: true }).count() === 0, "监控未打开时 CPU 核数提前出现在页面");
  assert(await page.getByText("320 GB", { exact: true }).count() === 0, "监控未打开时磁盘总量提前出现在页面");
  await assertVisible(page.getByText("演示模式 · 未接入真实 SSH / SFTP", { exact: true }), "模拟边界常驻可见");

  await page.screenshot({ path: path.join(outputDir, "prototype-default-1440x1024.png"), fullPage: false });

  const commandInput = page.getByRole("textbox", { name: "终端命令输入" });
  await commandInput.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  assert((await commandInput.inputValue()) === "journalctl -u php-fpm -f", "Tab 未插入当前补全建议");
  interactions.push("方向键选择并用 Tab 插入建议，未自动执行");
  await page.keyboard.press("Enter");
  await assertVisible(page.getByText("-- Logs begin at Mon 2026-07-14 09:00:01 CST. Press Ctrl+C to stop. --"), "Enter 后执行模拟命令");

  await page.keyboard.press("Control+Space");
  await assertVisible(page.getByRole("listbox", { name: "本地命令模板" }), "Ctrl+Space 兼容打开命令模板");
  await page.keyboard.press("Escape");
  assert(await page.getByRole("listbox", { name: "本地命令模板" }).count() === 0, "Esc 未关闭命令模板");
  await page.keyboard.press("Control+Shift+P");
  await assertVisible(page.getByRole("listbox", { name: "本地命令模板" }), "Ctrl+Shift+P 打开命令模板");
  await commandInput.fill("journalxxx");
  await assertVisible(page.getByText("无匹配模板", { exact: true }), "无匹配模板状态");
  await page.keyboard.press("Escape");
  await commandInput.fill("journalc");
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.press("ArrowRight");
  assert((await commandInput.inputValue()) === "journalc", "右方向键被命令模板错误劫持");
  await page.keyboard.press("Enter");
  assert((await commandInput.inputValue()) === "journalctl -u nginx -f", "Enter 未插入当前命令模板");
  interactions.push("Ctrl+Shift+P、Ctrl+Space、Esc、无匹配、Enter/Tab 插入且右方向键不被劫持");

  const uploadInput = page.locator(".file-tree-shell input[type=file]");
  await uploadInput.setInputFiles([
    { name: "qa-package-a.zip", mimeType: "application/zip", buffer: Buffer.from("qa-a") },
    { name: "qa-package-b.zip", mimeType: "application/zip", buffer: Buffer.from("qa-b") },
  ]);
  await assertVisible(page.getByText("qa-package-a.zip", { exact: true }).last(), "多文件选择任务 A");
  await assertVisible(page.getByText("qa-package-b.zip", { exact: true }).last(), "多文件选择任务 B");
  await page.getByRole("button", { name: "取消 qa-package-a.zip", exact: true }).click();
  await assertVisible(page.getByText("已取消", { exact: true }), "取消指定传输");
  await page.getByRole("button", { name: "重试 qa-package-a.zip", exact: true }).click();
  await assertVisible(page.getByRole("button", { name: "取消 qa-package-a.zip", exact: true }), "重试指定传输");

  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["drag-qa"], "qa-drag.txt", { type: "text/plain", lastModified: 1 }));
    return transfer;
  });
  const fileTreeDropTarget = page.locator(".file-tree-shell");
  await fileTreeDropTarget.dispatchEvent("dragenter", { dataTransfer });
  await assertVisible(page.getByText("释放文件开始上传", { exact: true }), "拖入文件列表后显示上传提示");
  await fileTreeDropTarget.dispatchEvent("drop", { dataTransfer });
  await dataTransfer.dispose();
  await assertVisible(page.getByText("qa-drag.txt", { exact: true }).last(), "真实拖放事件创建传输任务");

  const resizeHandle = page.locator(".bottom-panel__resize-handle");
  const beforeResize = await readLayout(page);
  const handleBox = await resizeHandle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y - 72, { steps: 5 });
  await page.mouse.up();
  const afterResize = await readLayout(page);
  assert(afterResize.bottomPanel.height >= beforeResize.bottomPanel.height + 60, "拖拽未增大底部面板高度");
  assert(nearlyEqual(afterResize.settingsButton.y, beforeResize.settingsButton.y), "调整底板高度后设置按钮 y 坐标发生变化");
  assert(afterResize.viewport.height - afterResize.settingsButton.bottom <= 12, "调整底板高度后设置按钮未固定在视口底部");
  await resizeHandle.dblclick();
  const resetLayout = await readLayout(page);
  assert(nearlyEqual(resetLayout.bottomPanel.height, 168), "双击未恢复底部面板默认高度");
  assert(nearlyEqual(resetLayout.settingsButton.y, beforeResize.settingsButton.y), "双击复位底板后设置按钮 y 坐标发生变化");
  interactions.push("底部面板拖拽调高并双击复位");

  await page.getByRole("tab", { name: "问题", exact: true }).click();
  await assertVisible(page.getByText("监控采样曾短暂延迟"), "问题标签切换");
  await page.getByRole("tab", { name: "监控", exact: true }).click();
  const monitorLayout = await readLayout(page);
  assert(nearlyEqual(monitorLayout.bottomPanel.height, 344, 4), `监控面板未展开到约 344px：${monitorLayout.bottomPanel.height}`);
  assert(nearlyEqual(monitorLayout.settingsButton.y, layout.settingsButton.y), "监控面板展开后设置按钮 y 坐标发生变化");
  assert(monitorLayout.viewport.height - monitorLayout.settingsButton.bottom <= 12, "监控面板展开后设置按钮未固定在视口底部");

  const systemRegion = page.getByRole("region", { name: "系统信息" });
  const processRegion = page.getByRole("region", { name: "进程信息" });
  const networkRegion = page.getByRole("region", { name: "网络信息" });
  const diskRegion = page.getByRole("region", { name: "磁盘信息" });
  await assertVisible(systemRegion, "系统信息监控区可见");
  await assertVisible(processRegion, "进程信息监控区可见");
  await assertVisible(networkRegion, "网络信息监控区可见");
  await assertVisible(diskRegion, "磁盘信息监控区可见");
  await assertVisible(systemRegion.getByText("Ubuntu 24.04 LTS", { exact: true }), "生产服务器 Ubuntu 系统信息");
  await assertVisible(systemRegion.getByText("8 核", { exact: true }), "生产服务器 CPU 核数仅在监控区");
  await assertVisible(processRegion.getByText("java -jar app.jar", { exact: true }), "生产服务器 Java 进程信息");
  await assertVisible(networkRegion.getByText("ens160", { exact: true }), "生产服务器网络接口信息");
  await assertVisible(diskRegion.getByText("320 GB", { exact: true }), "生产服务器根分区总量仅在监控区");
  assert(await page.getByText("8 核", { exact: true }).count() === 1, "CPU 核数出现在监控区之外");
  assert(await page.getByText("320 GB", { exact: true }).count() === 1, "磁盘总量出现在监控区之外");
  await assertCompactTopHealth(page);
  await page.screenshot({ path: path.join(outputDir, "prototype-monitor-1440x1024.png"), fullPage: false });

  const collapseButton = page.getByRole("button", { name: "收起面板" });
  assert((await collapseButton.getAttribute("data-icon-direction")) === "down", "展开状态的收起按钮未使用向下箭头");
  await collapseButton.click();
  assert(await page.locator(".bottom-panel").evaluate((element) => element.classList.contains("is-collapsed")), "底部面板未收起");
  const expandButton = page.getByRole("button", { name: "展开面板" });
  assert((await expandButton.getAttribute("data-icon-direction")) === "up", "收起状态的展开按钮未使用向上箭头");
  await expandButton.click();
  const expandedMonitorLayout = await readLayout(page);
  assert(nearlyEqual(expandedMonitorLayout.bottomPanel.height, 344, 4), "监控面板展开后未恢复专用高度");
  assert(nearlyEqual(expandedMonitorLayout.settingsButton.y, layout.settingsButton.y), "监控面板收起再展开后设置按钮 y 坐标发生变化");
  await page.getByRole("button", { name: "关闭面板" }).click();
  assert(await page.locator(".bottom-panel").count() === 0, "关闭面板仍显示底部面板");
  await page.getByRole("button", { name: "打开性能监控" }).click();
  await assertVisible(systemRegion, "顶部三项摘要可直接打开监控面板");
  await page.getByRole("button", { name: "关闭面板" }).click();
  await page.getByRole("button", { name: "传输任务" }).click();
  await page.getByRole("button", { name: "打开底部面板" }).click();
  await assertVisible(page.locator(".bottom-panel"), "底部面板关闭后可重新打开");
  await page.getByRole("button", { name: "性能监控", exact: true }).click();
  await assertVisible(systemRegion, "活动栏重新打开监控面板");
  const reopenedMonitorLayout = await readLayout(page);
  assert(nearlyEqual(reopenedMonitorLayout.bottomPanel.height, 344, 4), "活动栏重开监控后高度异常");
  assert(nearlyEqual(reopenedMonitorLayout.settingsButton.y, layout.settingsButton.y), "活动栏重开监控后设置按钮 y 坐标发生变化");
  interactions.push("监控四区、专用高度以及底板收起、关闭和重新打开");

  await page.locator(".server-picker__trigger").click();
  await page.getByRole("menuitem").filter({ hasText: "staging-api-01" }).click();
  await assertVisible(page.getByRole("tab", { name: "staging-api-01", exact: true }), "服务器工作区标签创建");
  await assertVisible(page.getByText("deploy@staging-api-01:22", { exact: true }).first(), "服务器上下文切换");
  await assertVisible(page.getByText("/srv/staging/releases", { exact: true }).first(), "远程路径随服务器切换");
  await assertVisible(page.getByText("模拟离线", { exact: true }), "离线服务器状态正确");
  assert(!(await page.locator(".terminal-transcript").innerText()).includes("prod-web-01"), "staging 终端混入 prod 上下文");
  await assertVisible(systemRegion.getByText("Rocky Linux 9.4", { exact: true }), "预发布服务器 Rocky 系统信息");
  await assertVisible(systemRegion.getByText("4 核", { exact: true }), "预发布服务器 CPU 核数");
  await assertVisible(processRegion.getByText("node server.js", { exact: true }), "预发布服务器 Node 进程信息");
  assert(await processRegion.getByText("java -jar app.jar", { exact: true }).count() === 0, "切到 staging 后仍残留 prod 进程");
  await page.getByRole("tab", { name: "prod-web-01", exact: true }).click();
  assert((await commandInput.inputValue()) === "journalctl -u nginx -f", "切回 prod 后未保留命令输入");
  await assertVisible(page.getByText("-- Logs begin at Mon 2026-07-14 09:00:01 CST. Press Ctrl+C to stop. --"), "切回 prod 后保留终端历史");
  await page.getByRole("tab", { name: "staging-api-01", exact: true }).click();
  await page.getByRole("button", { name: "关闭 staging-api-01", exact: true }).click();
  assert(await page.getByRole("tab", { name: "staging-api-01", exact: true }).count() === 0, "服务器工作区标签未关闭");
  interactions.push("服务器工作区独立创建、切换、保留和关闭");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await assertVisible(page.getByRole("heading", { name: "设置", exact: true }), "设置对话框打开");
  await assertVisible(page.getByText("仅当前页面会话", { exact: true }), "设置会话级边界可见");
  const skyAccentButton = page.getByRole("button", { name: "使用天空蓝强调色", exact: true });
  await skyAccentButton.click();
  assert(await skyAccentButton.getAttribute("aria-pressed") === "true", "强调色预设未激活");
  assert(
    (await page.locator(".app-root").evaluate((element) => element.style.getPropertyValue("--accent").trim())) === "#60a5fa",
    "强调色预设未应用到工作台",
  );

  await page.locator("#settings-terminal-background").fill("#102030");
  await page.locator("#settings-terminal-foreground").fill("#dce7f3");
  const terminalTheme = await page.locator(".terminal-pane").evaluate((element) => ({
    background: element.style.getPropertyValue("--terminal-background").trim(),
    foreground: element.style.getPropertyValue("--terminal-foreground").trim(),
  }));
  assert(terminalTheme.background === "#102030", "终端背景色未应用");
  assert(terminalTheme.foreground === "#dce7f3", "终端文字色未应用");

  await page.locator(".settings-form__file-input").setInputFiles({
    name: "qa-wallpaper.png",
    mimeType: "image/png",
    buffer: onePixelPng,
  });
  await assertVisible(page.getByText("qa-wallpaper.png", { exact: true }), "有效 PNG 背景图已读取");
  const wallpaperVisibility = page.locator("#settings-wallpaper-opacity");
  await wallpaperVisibility.fill("64");
  assert((await wallpaperVisibility.inputValue()) === "64", "背景图可见度未调整到 64% ");
  await page.screenshot({ path: path.join(outputDir, "prototype-settings-1440x1024.png"), fullPage: false });
  await page.getByRole("button", { name: "完成", exact: true }).click();
  assert(await page.getByRole("heading", { name: "设置", exact: true }).count() === 0, "完成后设置对话框仍显示");

  const terminalWallpaper = page.locator(".terminal-wallpaper");
  await assertVisible(terminalWallpaper, "关闭设置后终端背景图仍存在");
  const wallpaperStyle = await terminalWallpaper.evaluate((element) => ({
    backgroundImage: element.style.backgroundImage,
    opacity: element.style.opacity,
  }));
  assert(wallpaperStyle.backgroundImage.includes("data:image/png;base64"), "终端背景图未使用页面内存 Data URL");
  assert(wallpaperStyle.opacity === "0.64", `终端背景图可见度异常：${wallpaperStyle.opacity}`);
  const appearanceStorage = await readStorage(page);
  assert(Object.keys(appearanceStorage.local).length === 0, "外观设置写入 localStorage");
  assert(Object.keys(appearanceStorage.session).length === 0, "外观设置写入 sessionStorage");
  interactions.push("强调色、终端配色、PNG 壁纸和可见度仅在页面会话生效");

  await page.locator(".server-add-button").click();
  await assertVisible(page.getByRole("heading", { name: "新增 SSH 连接" }), "新增服务器表单打开");
  const usernameInput = page.locator("#connection-username");
  const authMethodSelect = page.locator("#connection-authMethod");
  const passwordInput = page.locator("#connection-password");
  assert((await usernameInput.inputValue()) === "root", "新增连接用户名默认值不是 root");
  assert((await authMethodSelect.inputValue()) === "password", "新增连接认证方式默认值不是 password");
  assert((await passwordInput.getAttribute("type")) === "password", "密码输入框未使用 password 类型");
  assert((await passwordInput.inputValue()) === "", "新增连接密码初始值不为空");
  await page.screenshot({ path: path.join(outputDir, "prototype-new-connection-1440x1024.png"), fullPage: false });
  await page.getByLabel("端口").fill("70000");
  await page.getByRole("button", { name: "创建演示连接" }).click();
  await assertVisible(page.getByText("请输入连接名称", { exact: true }), "新增服务器必填校验");
  await assertVisible(page.getByText(/端口必须是/), "新增服务器端口范围校验");
  await assertVisible(page.getByText("请输入密码", { exact: true }), "密码认证空密码校验");
  const connectionNameInput = page.getByLabel("连接名称");
  await connectionNameInput.fill("qa");
  await page.waitForTimeout(2600);
  assert(
    await connectionNameInput.evaluate((element) => document.activeElement === element),
    "传输状态刷新后新增连接输入框丢失焦点",
  );
  await connectionNameInput.pressSequentially("-demo-01");
  assert((await connectionNameInput.inputValue()) === "qa-demo-01", "状态刷新期间无法连续输入连接名称");
  interactions.push("新增连接输入框跨两次传输状态刷新保持焦点并连续输入");
  await page.getByLabel("分组").fill("测试环境");
  await page.getByLabel("主机地址").fill("qa.example.test");
  await page.getByLabel("端口").fill("2222");
  await passwordInput.fill(passwordProbe);
  await page.getByRole("button", { name: "创建演示连接" }).click();
  await assertVisible(page.getByRole("tab", { name: "qa-demo-01", exact: true }), "新增服务器创建独立工作区");
  await assertVisible(page.getByText("root@qa.example.test:2222", { exact: true }).first(), "root 新增服务器端点可见");
  await assertVisible(page.getByText("/root", { exact: true }).first(), "root 新增服务器目录上下文可见");
  assert((await page.locator(".terminal-transcript").innerText()).includes("[root@qa-demo-01 root]$"), "root 新增服务器终端 prompt 未使用 root");
  await assertPageAndStorageExclude(page, passwordProbe, "密码测试串");
  assert(!JSON.stringify(interactions).includes(passwordProbe), "密码测试串进入 QA interactions 输出");

  await page.locator(".server-add-button").click();
  await assertVisible(page.getByRole("heading", { name: "新增 SSH 连接" }), "新增服务器表单重新打开");
  assert((await page.locator("#connection-username").inputValue()) === "root", "重开表单后用户名未恢复 root");
  assert((await page.locator("#connection-authMethod").inputValue()) === "password", "重开表单后认证方式未恢复 password");
  assert((await page.locator("#connection-password").inputValue()) === "", "重开表单后密码未清空");
  await page.getByRole("button", { name: "关闭连接管理" }).click();
  await assertPageAndStorageExclude(page, passwordProbe, "密码测试串");
  interactions.push("默认 root/password、空密码校验、敏感值不持久化并创建独立工作区");

  await page.getByRole("button", { name: "服务器连接" }).click();
  await assertVisible(page.getByRole("heading", { name: "服务器连接" }), "活动栏连接管理入口可见");
  await assertVisible(page.getByText("qa-demo-01", { exact: true }).last(), "连接列表包含新增服务器");
  await page.screenshot({ path: path.join(outputDir, "prototype-connections-1440x1024.png"), fullPage: false });
  await page.getByRole("button", { name: "管理连接与密码" }).click();
  await assertVisible(page.getByRole("heading", { name: "连接管理" }), "连接管理器列表打开");
  await page.screenshot({ path: path.join(outputDir, "prototype-connection-manager-1440x1024.png"), fullPage: false });
  await page.getByRole("button", { name: "关闭连接管理" }).click();
  await page.getByRole("button", { name: "资源管理器" }).click();

  await page.screenshot({ path: path.join(outputDir, "prototype-interactions-1440x1024.png"), fullPage: false });

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload({ waitUntil: "networkidle" });
  const responsiveLayout = await readLayout(page);
  const responsive = {
    horizontalOverflow: responsiveLayout.horizontalOverflow,
    verticalOverflow: responsiveLayout.verticalOverflow,
    statusVisible: Boolean(responsiveLayout.statusBar?.height),
    terminalVisible: Boolean(responsiveLayout.terminal?.width),
    regionsAligned: nearlyEqual(responsiveLayout.terminal.bottom, responsiveLayout.bottomPanel.y)
      && nearlyEqual(responsiveLayout.bottomPanel.bottom, responsiveLayout.statusBar.y),
    completionContained: responsiveLayout.completion.bottom <= responsiveLayout.terminalSurface.bottom,
    settingsFixedToViewport: responsiveLayout.viewport.height - responsiveLayout.settingsButton.bottom <= 12,
    fileTreeContained: responsiveLayout.fileTree.bottom <= responsiveLayout.explorer.bottom,
  };
  await assertCompactTopHealth(page);
  assert(!responsive.horizontalOverflow, "1280×720 出现页面级横向溢出");
  assert(!responsive.verticalOverflow, "1280×720 出现页面级纵向溢出");
  assert(responsive.statusVisible && responsive.terminalVisible, "1280×720 的关键区域不可见");
  assert(responsive.regionsAligned, "1280×720 的终端、面板和状态栏未对齐");
  assert(responsive.completionContained, "1280×720 的补全面板被裁切");
  assert(responsive.settingsFixedToViewport, "1280×720 的设置按钮未固定在视口底部");
  assert(responsive.fileTreeContained, "1280×720 的远程文件列表超出资源管理器");
  await page.screenshot({ path: path.join(outputDir, "prototype-responsive-1280x720.png"), fullPage: false });

  assert(consoleErrors.length === 0, `浏览器控制台错误：${consoleErrors.join(" | ")}`);
  assert(pageErrors.length === 0, `页面错误：${pageErrors.join(" | ")}`);

  await writeFile(path.join(outputDir, "qa-results.json"), JSON.stringify({
    status: "passed",
    baseUrl,
    layout,
    responsive,
    interactions,
    consoleErrors,
    pageErrors,
  }, null, 2));

  console.log(JSON.stringify({ status: "passed", layout, responsive, interactions }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(outputDir, "prototype-failure.png"), fullPage: false }).catch(() => {});
  await writeFile(path.join(outputDir, "qa-results.json"), JSON.stringify({
    status: "failed",
    message: error instanceof Error ? error.message : String(error),
    interactions,
    consoleErrors,
    pageErrors,
  }, null, 2));
  throw error;
} finally {
  await browser.close();
}
