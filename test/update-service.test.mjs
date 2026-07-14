import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { UpdateService } from "../electron/services/update-service.mjs";

class FakeUpdater extends EventEmitter {
  checkCount = 0;
  installCalls = [];

  async checkForUpdates() {
    this.checkCount += 1;
  }

  quitAndInstall(...args) {
    this.installCalls.push(args);
  }
}

function createService({ packaged = true, activeTransfers = false } = {}) {
  const updater = new FakeUpdater();
  const events = [];
  let disconnected = 0;
  const service = new UpdateService({
    app: { isPackaged: packaged, getVersion: () => "0.1.0" },
    updater,
    emit: (type, payload) => events.push({ type, payload }),
    hasActiveTransfers: () => activeTransfers,
    disconnectAll: () => { disconnected += 1; },
  });
  return { service, updater, events, disconnected: () => disconnected };
}

test("开发模式禁用更新且不会绑定 updater 事件", async () => {
  const { service, updater } = createService({ packaged: false });
  assert.deepEqual(service.initialize({ schedule: false }), {
    enabled: false,
    currentVersion: "0.1.0",
    phase: "disabled",
    availableVersion: null,
    progress: null,
    lastCheckedAt: null,
    error: null,
  });
  assert.equal(updater.eventNames().length, 0);
  assert.equal((await service.check()).phase, "disabled");
});

test("检查更新去重并映射下载状态", async () => {
  const { service, updater, events } = createService();
  service.initialize({ schedule: false });

  let finishCheck;
  updater.checkForUpdates = () => {
    updater.checkCount += 1;
    return new Promise((resolve) => { finishCheck = resolve; });
  };

  const first = service.check();
  const second = service.check();
  await Promise.resolve();
  assert.equal(updater.checkCount, 1);
  assert.equal((await second).phase, "checking");

  updater.emit("update-available", { version: "0.1.1", releaseNotes: "<script>bad</script>" });
  updater.emit("download-progress", {
    percent: 42.4,
    transferred: 424,
    total: 1000,
    bytesPerSecond: 128,
  });
  assert.deepEqual(service.getState().progress, {
    percent: 42.4,
    transferred: 424,
    total: 1000,
    bytesPerSecond: 128,
  });

  updater.emit("update-downloaded", { version: "0.1.1", downloadedFile: "C:\\secret\\update.exe" });
  finishCheck();
  await first;
  const state = service.getState();
  assert.equal(state.phase, "ready");
  assert.equal(state.availableVersion, "0.1.1");
  assert.equal(JSON.stringify(state).includes("secret"), false);
  assert.equal(events.every((event) => event.type === "update-status"), true);
});

test("更新错误只向渲染层返回固定脱敏消息", async () => {
  const { service, updater } = createService();
  service.initialize({ schedule: false });
  updater.checkForUpdates = async () => {
    throw new Error("https://example.invalid/update?token=private-value");
  };

  await assert.rejects(service.check(), (error) => error.code === "UPDATE_CHECK_FAILED");
  const state = service.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.error.message, "检查更新失败，请稍后重试。");
  assert.equal(JSON.stringify(state).includes("private-value"), false);
});

test("活动上传阻止安装，空闲时先断开 SSH 再启动静默更新", () => {
  const blocked = createService({ activeTransfers: true });
  blocked.service.initialize({ schedule: false });
  blocked.updater.emit("update-downloaded", { version: "0.1.1" });
  assert.throws(
    () => blocked.service.install(),
    (error) => error.code === "UPDATE_INSTALL_BLOCKED",
  );
  assert.equal(blocked.disconnected(), 0);
  assert.equal(blocked.updater.installCalls.length, 0);

  const allowed = createService();
  allowed.service.initialize({ schedule: false });
  allowed.updater.emit("update-downloaded", { version: "0.1.1" });
  assert.deepEqual(allowed.service.install(), { installing: true });
  assert.equal(allowed.disconnected(), 1);
  assert.deepEqual(allowed.updater.installCalls, [[true, true]]);
  assert.equal(allowed.service.getState().phase, "installing");
});
