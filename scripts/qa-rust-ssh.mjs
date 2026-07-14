import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startSshServer } from "../test-support/ssh-fixture.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cargoHome = process.env.CARGO_HOME
  ?? (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".cargo") : null);
const cargo = process.platform === "win32" && cargoHome
  ? path.join(cargoHome, "bin", "cargo.exe")
  : "cargo";
const fixture = await startSshServer({ enableSftp: true });

function runCargoSmoke() {
  return new Promise((resolve, reject) => {
    const child = spawn(cargo, [
      "test",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--test",
      "ssh_protocol_smoke",
      "real_ssh_sftp_protocol_smoke",
      "--",
      "--ignored",
      "--exact",
      "--nocapture",
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        REMOTE_TERMINAL_SSH_FIXTURE_PORT: String(fixture.port),
      },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(signal
        ? `Rust SSH protocol smoke was interrupted by ${signal}`
        : `Rust SSH protocol smoke exited with code ${code}`));
    });
  });
}

try {
  await runCargoSmoke();
  console.log(JSON.stringify({
    status: "passed",
    protocol: "real-ssh2-russh",
    terminal: true,
    completion: true,
    monitor: true,
    sftpAtomicUpload: true,
    overwriteBlocked: true,
  }));
} finally {
  await fixture.close();
}
