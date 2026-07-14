import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = path.join(rootDirectory, "release", "publish");
const manifest = JSON.parse(await readFile(path.join(rootDirectory, "package.json"), "utf8"));
const setupName = `RemoteTerminal-Setup-${manifest.version}-x64.exe`;
const setupPath = path.join(releaseDirectory, setupName);
const blockmapPath = `${setupPath}.blockmap`;
const metadataPath = path.join(releaseDirectory, "latest.yml");
const unpackedExecutablePath = path.join(releaseDirectory, "win-unpacked", "RemoteTerminal.exe");
const appUpdatePath = path.join(releaseDirectory, "win-unpacked", "resources", "app-update.yml");

for (const requiredPath of [setupPath, blockmapPath, metadataPath, unpackedExecutablePath, appUpdatePath]) {
  await access(requiredPath);
}

const metadata = await readFile(metadataPath, "utf8");
const escapedVersion = manifest.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
if (!new RegExp(`^version:\\s*${escapedVersion}\\s*$`, "m").test(metadata)) {
  throw new Error("latest.yml 的版本与 package.json 不一致。");
}
if (!new RegExp(`^path:\\s*${setupName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(metadata)) {
  throw new Error("latest.yml 未指向本次生成的 Windows 安装包。");
}
if (!/^sha512:\s*[A-Za-z0-9+/=]{80,}\s*$/m.test(metadata)) {
  throw new Error("latest.yml 缺少有效的 SHA-512 完整性信息。");
}

const appUpdate = await readFile(appUpdatePath, "utf8");
for (const expected of ["provider: github", "owner: liang-0521", "repo: remote-terminal"]) {
  if (!appUpdate.includes(expected)) throw new Error(`app-update.yml 缺少配置：${expected}`);
}
if (/(?:token|authorization|password)\s*:/i.test(appUpdate)) {
  throw new Error("app-update.yml 不得包含访问凭证。");
}

const hash = createHash("sha256");
for await (const chunk of createReadStream(setupPath)) hash.update(chunk);
const digest = hash.digest("hex");
await writeFile(path.join(releaseDirectory, "SHA256SUMS.txt"), `${digest} *${setupName}\r\n`, "utf8");

const setupSize = (await stat(setupPath)).size;
console.log(`Windows 安装包已验证：${setupPath}`);
console.log(`安装包大小：${(setupSize / 1024 / 1024).toFixed(2)} MiB`);
console.log(`SHA-256：${digest}`);
