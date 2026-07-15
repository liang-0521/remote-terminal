import { constants as FS_CONSTANTS } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ssh2 from "ssh2";

const require = createRequire(import.meta.url);
const { OPEN_MODE, Stats, STATUS_CODE } = require("ssh2/lib/protocol/SFTP.js");
const { Server, utils } = ssh2;

const HOME = "/home/root";
const UPLOAD_DIRECTORY = `${HOME}/releases`;
const ARCHIVE_DIRECTORY = `${UPLOAD_DIRECTORY}/archive`;
const NETWORK_MARKER = "@@REMOTE_TERMINAL:NETWORK_DEV@@";
const COMMANDS_MARKER = "@@REMOTE_TERMINAL:COMMANDS@@";
const SFTP_AUDIT_COMMAND = "__REMOTE_TERMINAL_FIXTURE_SFTP_AUDIT__";
const MONITOR_SECTION_MARKERS = Object.freeze({
  os: "@@REMOTE_TERMINAL:OS@@",
  uptime: "@@REMOTE_TERMINAL:UPTIME@@",
  load: "@@REMOTE_TERMINAL:LOAD@@",
  cpuCores: "@@REMOTE_TERMINAL:CPU_CORES@@",
  memory: "@@REMOTE_TERMINAL:MEMORY@@",
  processes: "@@REMOTE_TERMINAL:PROCESSES@@",
  mounts: "@@REMOTE_TERMINAL:MOUNTS@@",
});

function createMonitorCounters(sampleIndex) {
  const user = 100 + sampleIndex * 50;
  const system = 100 + sampleIndex * 50;
  const idle = 800 + sampleIndex * 100;
  const received = 1_000 + sampleIndex * 102_400;
  const transmitted = 2_000 + sampleIndex * 51_200;
  return [
    `cpu ${user} 0 ${system} ${idle} 0 0 0 0 0 0`,
    NETWORK_MARKER,
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    "    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0",
    `  eth0: ${received} 10 0 0 0 0 0 0 ${transmitted} 10 0 0 0 0 0 0`,
  ].join("\n");
}

function createMonitorSnapshot() {
  return [
    MONITOR_SECTION_MARKERS.os,
    "Ubuntu 24.04.1 LTS",
    MONITOR_SECTION_MARKERS.uptime,
    "176580.50 1234.00",
    MONITOR_SECTION_MARKERS.load,
    "0.76 0.90 0.83 2/901 2210",
    MONITOR_SECTION_MARKERS.cpuCores,
    "8",
    MONITOR_SECTION_MARKERS.memory,
    "MemTotal:        8388608 kB",
    "MemAvailable:    6291456 kB",
    "SwapTotal:       4194304 kB",
    "SwapFree:        3145728 kB",
    MONITOR_SECTION_MARKERS.processes,
    " 2481 root 4.3 2097152 java -jar app.jar",
    " 1836 mysql 2.8 1331200 mysqld",
    MONITOR_SECTION_MARKERS.mounts,
    "/\t104857600\t52428800\t52428800\t50%",
    "/boot\t1048576\t314572\t734004\t30%",
    "/run/lock\t5120\t512\t3584\t13%",
  ].join("\n");
}

function createCompletionCatalog() {
  return [
    COMMANDS_MARKER,
    "ls",
    "ll",
    "cat",
    "journalctl",
  ].join("\n");
}

function fileStats(size) {
  return new Stats({
    mode: FS_CONSTANTS.S_IFREG | 0o644,
    size,
    uid: 0,
    gid: 0,
    atime: 1_720_000_000,
    mtime: 1_720_000_000,
  });
}

function directoryStats() {
  return new Stats({
    mode: FS_CONSTANTS.S_IFDIR | 0o755,
    size: 4096,
    uid: 0,
    gid: 0,
    atime: 1_720_000_000,
    mtime: 1_720_000_000,
  });
}

function createMemorySftp() {
  const directories = new Set([
    "/",
    "/home",
    HOME,
    UPLOAD_DIRECTORY,
    ARCHIVE_DIRECTORY,
    `${UPLOAD_DIRECTORY}/logs`,
  ]);
  const files = new Map([[`${UPLOAD_DIRECTORY}/readme.txt`, Buffer.from("fixture\n")]]);
  const handles = new Map();
  const audit = [];
  let nextHandle = 1;

  function normalize(remotePath) {
    if (remotePath === "." || remotePath === "") return HOME;
    const absolute = remotePath.startsWith("/")
      ? remotePath
      : path.posix.join(HOME, remotePath);
    return path.posix.normalize(absolute);
  }

  function exists(remotePath) {
    return directories.has(remotePath) || files.has(remotePath);
  }

  function attrs(remotePath) {
    if (directories.has(remotePath)) return directoryStats();
    const content = files.get(remotePath);
    return content ? fileStats(content.length) : null;
  }

  function allocateHandle(value) {
    const handle = Buffer.from(`fixture-${nextHandle}`);
    nextHandle += 1;
    handles.set(handle.toString("hex"), value);
    return handle;
  }

  function lookupHandle(handle) {
    return handles.get(handle.toString("hex"));
  }

  function reject(sftp, id, status = STATUS_CODE.FAILURE) {
    sftp.status(id, status);
  }

  function listChildren(directory) {
    const entries = [];
    for (const item of [...directories, ...files.keys()]) {
      if (item === directory || path.posix.dirname(item) !== directory) continue;
      const itemAttrs = attrs(item);
      entries.push({
        filename: path.posix.basename(item),
        longname: path.posix.basename(item),
        attrs: itemAttrs,
      });
    }
    return entries.sort((left, right) => left.filename.localeCompare(right.filename));
  }

  function moveEntry(oldPath, newPath) {
    const content = files.get(oldPath);
    if (content) {
      files.delete(oldPath);
      files.set(newPath, content);
      return "file";
    }

    const prefix = `${oldPath}/`;
    const directoryMoves = [...directories]
      .filter((item) => item === oldPath || item.startsWith(prefix))
      .map((item) => [item, `${newPath}${item.slice(oldPath.length)}`]);
    const fileMoves = [...files.entries()]
      .filter(([item]) => item.startsWith(prefix))
      .map(([item, value]) => [item, `${newPath}${item.slice(oldPath.length)}`, value]);
    for (const [source] of directoryMoves) directories.delete(source);
    for (const [source] of fileMoves) files.delete(source);
    for (const [, target] of directoryMoves) directories.add(target);
    for (const [, target, value] of fileMoves) files.set(target, value);
    return "directory";
  }

  function attach(sftp) {
    sftp.on("REALPATH", (id, rawPath) => {
      const remotePath = normalize(rawPath);
      if (!exists(remotePath)) {
        reject(sftp, id, STATUS_CODE.NO_SUCH_FILE);
        return;
      }
      audit.push({ op: "canonicalize" });
      sftp.name(id, [{ filename: remotePath, longname: remotePath, attrs: attrs(remotePath) }]);
    });

    for (const event of ["STAT", "LSTAT"]) {
      sftp.on(event, (id, rawPath) => {
        const remotePath = normalize(rawPath);
        const metadata = attrs(remotePath);
        audit.push({ op: "stat", exists: Boolean(metadata), name: path.posix.basename(remotePath) });
        if (!metadata) {
          reject(sftp, id, STATUS_CODE.NO_SUCH_FILE);
          return;
        }
        sftp.attrs(id, metadata);
      });
    }

    sftp.on("OPENDIR", (id, rawPath) => {
      const remotePath = normalize(rawPath);
      if (!directories.has(remotePath)) {
        reject(sftp, id, STATUS_CODE.NO_SUCH_FILE);
        return;
      }
      audit.push({ op: "list", name: path.posix.basename(remotePath) });
      sftp.handle(id, allocateHandle({ type: "directory", path: remotePath, read: false }));
    });

    sftp.on("READDIR", (id, handle) => {
      const opened = lookupHandle(handle);
      if (!opened || opened.type !== "directory") {
        reject(sftp, id, STATUS_CODE.FAILURE);
        return;
      }
      if (opened.read) {
        reject(sftp, id, STATUS_CODE.EOF);
        return;
      }
      opened.read = true;
      sftp.name(id, listChildren(opened.path));
    });

    sftp.on("OPEN", (id, rawPath, flags) => {
      const remotePath = normalize(rawPath);
      const requiredFlags = OPEN_MODE.WRITE | OPEN_MODE.CREAT | OPEN_MODE.EXCL;
      const isTemporaryUpload = path.posix.dirname(remotePath) === UPLOAD_DIRECTORY
        && /^\.remote-terminal-[0-9a-f-]{36}\.part$/.test(path.posix.basename(remotePath));
      if ((flags & requiredFlags) !== requiredFlags || !isTemporaryUpload) {
        reject(sftp, id, STATUS_CODE.PERMISSION_DENIED);
        return;
      }
      if (exists(remotePath)) {
        reject(sftp, id, STATUS_CODE.FAILURE);
        return;
      }
      files.set(remotePath, Buffer.alloc(0));
      audit.push({ op: "openTemporary" });
      sftp.handle(id, allocateHandle({ type: "file", path: remotePath }));
    });

    sftp.on("WRITE", (id, handle, offset, data) => {
      const opened = lookupHandle(handle);
      if (!opened || opened.type !== "file" || !Number.isSafeInteger(offset) || offset < 0) {
        reject(sftp, id, STATUS_CODE.FAILURE);
        return;
      }
      const current = files.get(opened.path);
      const end = offset + data.length;
      if (!current || !Number.isSafeInteger(end)) {
        reject(sftp, id, STATUS_CODE.FAILURE);
        return;
      }
      const next = end > current.length ? Buffer.alloc(end) : Buffer.from(current);
      current.copy(next);
      data.copy(next, offset);
      files.set(opened.path, next);
      audit.push({ op: "write", bytes: data.length });
      sftp.status(id, STATUS_CODE.OK);
    });

    sftp.on("FSTAT", (id, handle) => {
      const opened = lookupHandle(handle);
      const metadata = opened?.type === "file" ? attrs(opened.path) : null;
      if (!metadata) {
        reject(sftp, id, STATUS_CODE.FAILURE);
        return;
      }
      sftp.attrs(id, metadata);
    });

    sftp.on("CLOSE", (id, handle) => {
      const key = handle.toString("hex");
      const opened = handles.get(key);
      if (!opened) {
        reject(sftp, id, STATUS_CODE.FAILURE);
        return;
      }
      handles.delete(key);
      audit.push({ op: "close", type: opened.type });
      sftp.status(id, STATUS_CODE.OK);
    });

    sftp.on("RENAME", (id, rawOldPath, rawNewPath) => {
      const oldPath = normalize(rawOldPath);
      const newPath = normalize(rawNewPath);
      const isAtomicUpload = files.has(oldPath)
        && path.posix.dirname(oldPath) === UPLOAD_DIRECTORY
        && path.posix.basename(oldPath).endsWith(".part")
        && path.posix.dirname(newPath) === UPLOAD_DIRECTORY;
      const protectedDirectory = ["/", "/home", HOME, UPLOAD_DIRECTORY].includes(oldPath);
      const movesIntoSelf = directories.has(oldPath) && newPath.startsWith(`${oldPath}/`);
      if (!exists(oldPath)
        || protectedDirectory
        || movesIntoSelf
        || !directories.has(path.posix.dirname(newPath))) {
        reject(sftp, id, STATUS_CODE.PERMISSION_DENIED);
        return;
      }
      if (exists(newPath)) {
        audit.push({ op: "overwriteRejected", name: path.posix.basename(newPath) });
        reject(sftp, id, STATUS_CODE.FAILURE);
        return;
      }
      const entryType = moveEntry(oldPath, newPath);
      if (isAtomicUpload) {
        audit.push({
          op: "atomicRename",
          name: path.posix.basename(newPath),
          bytes: files.get(newPath).length,
        });
      } else {
        audit.push({
          op: "rename",
          type: entryType,
          source: oldPath,
          target: newPath,
        });
      }
      sftp.status(id, STATUS_CODE.OK);
    });

    sftp.on("REMOVE", (id, rawPath) => {
      const remotePath = normalize(rawPath);
      const temporary = path.posix.basename(remotePath).endsWith(".part");
      if (!files.delete(remotePath)) {
        reject(sftp, id, STATUS_CODE.NO_SUCH_FILE);
        return;
      }
      audit.push({ op: temporary ? "removeTemporary" : "removeFile", name: path.posix.basename(remotePath) });
      sftp.status(id, STATUS_CODE.OK);
    });

    sftp.on("RMDIR", (id, rawPath) => {
      const remotePath = normalize(rawPath);
      const hasChildren = [...directories, ...files.keys()]
        .some((item) => item !== remotePath && path.posix.dirname(item) === remotePath);
      if (remotePath === "/" || remotePath === HOME || remotePath === UPLOAD_DIRECTORY
        || !directories.has(remotePath) || hasChildren) {
        reject(sftp, id, STATUS_CODE.FAILURE);
        return;
      }
      directories.delete(remotePath);
      audit.push({ op: "removeDirectory", name: path.posix.basename(remotePath) });
      sftp.status(id, STATUS_CODE.OK);
    });
  }

  function snapshot() {
    const uploaded = [...files.entries()]
      .filter(([remotePath]) => path.posix.dirname(remotePath) === UPLOAD_DIRECTORY)
      .map(([remotePath, content]) => ({ name: path.posix.basename(remotePath), bytes: content.length }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      operations: audit.slice(),
      uploaded,
      temporaryFiles: uploaded.filter((item) => item.name.endsWith(".part")).length,
    };
  }

  return { attach, snapshot };
}

export function startSshServer({ enableSftp = false } = {}) {
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const clients = new Set();
  const memorySftp = createMemorySftp();
  let monitorCounterSample = 0;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("error", () => undefined);
    client.on("close", () => clients.delete(client));
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "root" && context.password === "test-password") {
        context.accept();
      } else {
        context.reject();
      }
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => acceptPty?.());
        session.on("window-change", (acceptWindowChange) => acceptWindowChange?.());
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          stream.write("integration-ready$ ");
          stream.on("data", (data) => stream.write(data));
        });
        session.on("exec", (acceptExec, _rejectExec, info) => {
          const stream = acceptExec();
          let output;
          if (info.command === SFTP_AUDIT_COMMAND) {
            output = JSON.stringify(memorySftp.snapshot());
          } else if (info.command.includes(NETWORK_MARKER)) {
            output = createMonitorCounters(monitorCounterSample);
            monitorCounterSample += 1;
          } else if (info.command.includes(MONITOR_SECTION_MARKERS.mounts)) {
            output = createMonitorSnapshot();
          } else if (info.command.includes(COMMANDS_MARKER)) {
            output = createCompletionCatalog();
          } else {
            stream.stderr.write("unsupported fixture command\n");
            stream.exit(127);
            stream.end();
            return;
          }
          stream.write(`${output}\n`);
          stream.exit(0);
          stream.end();
        });
        session.on("sftp", (acceptSftp, rejectSftp) => {
          if (!enableSftp) {
            rejectSftp?.();
            return;
          }
          memorySftp.attach(acceptSftp());
        });
      });
    });
  });
  server.on("error", () => undefined);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        port: server.address().port,
        async close() {
          for (const client of clients) client.end();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}
