import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const projectRoot = path.resolve(import.meta.dirname, "..");
const buildDirectory = path.join(projectRoot, "build");
const source = path.join(buildDirectory, "icon.svg");
const output = path.join(buildDirectory, "icon.png");
const chromePath = [
  process.env.CHROME_PATH,
  String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
].find((candidate) => candidate && existsSync(candidate));

if (!chromePath) throw new Error("未找到 Chrome，无法生成 Windows 应用图标。");
await mkdir(buildDirectory, { recursive: true });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(source).href, { waitUntil: "load" });
  await page.screenshot({ path: output, omitBackground: true });
  console.log(`应用图标已生成：${output}`);
} finally {
  await browser.close();
}
