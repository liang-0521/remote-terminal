import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import "./build-preload.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteEntry = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
const vite = spawn(process.execPath, [viteEntry, "--host", "127.0.0.1", "--port", "4173", "--strictPort"], {
  cwd: projectRoot,
  stdio: "inherit",
  windowsHide: true,
});

let electron = null;
let stopping = false;

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  electron?.kill();
  vite.kill();
  process.exitCode = exitCode;
}

async function waitForVite() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error(`Vite 提前退出，退出码 ${vite.exitCode}`);
    try {
      const response = await fetch("http://127.0.0.1:4173/", { signal: AbortSignal.timeout(800) });
      if (response.ok) return;
    } catch {
      // 开发服务器尚未就绪，继续在截止时间内探测。
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("等待 Vite 开发服务器超时");
}

try {
  await waitForVite();
  electron = spawn(electronPath, [projectRoot, "--dev"], {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: false,
  });
  electron.on("exit", (code) => stop(code ?? 0));
  electron.on("error", () => stop(1));
} catch (error) {
  console.error(error.message);
  stop(1);
}

process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
