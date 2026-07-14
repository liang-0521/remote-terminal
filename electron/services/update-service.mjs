import { AppError } from "./app-error.mjs";

const INITIAL_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BUSY_PHASES = new Set(["checking", "available", "downloading", "ready", "installing"]);

function safeVersion(value) {
  if (typeof value !== "string") return null;
  const version = value.trim();
  return version.length > 0 && version.length <= 64 && /^[0-9A-Za-z.+-]+$/.test(version)
    ? version
    : null;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function publicProgress(progress) {
  return {
    percent: Math.min(100, safeNumber(progress?.percent)),
    transferred: safeNumber(progress?.transferred),
    total: safeNumber(progress?.total),
    bytesPerSecond: safeNumber(progress?.bytesPerSecond),
  };
}

export class UpdateService {
  #app;
  #updater;
  #emit;
  #hasActiveTransfers;
  #disconnectAll;
  #timers;
  #state;
  #initialized = false;
  #checkPromise = null;
  #initialTimer = null;
  #intervalTimer = null;
  #listeners = new Map();

  constructor({ app, updater, emit, hasActiveTransfers, disconnectAll, timers = globalThis }) {
    this.#app = app;
    this.#updater = updater;
    this.#emit = emit;
    this.#hasActiveTransfers = hasActiveTransfers;
    this.#disconnectAll = disconnectAll;
    this.#timers = timers;
    this.#state = {
      enabled: Boolean(app.isPackaged),
      currentVersion: String(app.getVersion()),
      phase: app.isPackaged ? "idle" : "disabled",
      availableVersion: null,
      progress: null,
      lastCheckedAt: null,
      error: null,
    };
  }

  initialize({ schedule = true } = {}) {
    if (this.#initialized) return this.getState();
    this.#initialized = true;
    if (!this.#state.enabled) return this.getState();

    this.#updater.autoDownload = true;
    this.#updater.autoInstallOnAppQuit = true;
    this.#updater.allowPrerelease = false;
    this.#updater.allowDowngrade = false;
    this.#updater.disableWebInstaller = true;

    this.#listen("checking-for-update", () => {
      this.#setState({ phase: "checking", progress: null, error: null });
    });
    this.#listen("update-available", (info) => {
      this.#setState({
        phase: "available",
        availableVersion: safeVersion(info?.version),
        progress: null,
        lastCheckedAt: new Date().toISOString(),
        error: null,
      });
    });
    this.#listen("update-not-available", () => {
      this.#setState({
        phase: "idle",
        availableVersion: null,
        progress: null,
        lastCheckedAt: new Date().toISOString(),
        error: null,
      });
    });
    this.#listen("download-progress", (progress) => {
      this.#setState({ phase: "downloading", progress: publicProgress(progress), error: null });
    });
    this.#listen("update-downloaded", (info) => {
      this.#setState({
        phase: "ready",
        availableVersion: safeVersion(info?.version) || this.#state.availableVersion,
        progress: { ...publicProgress({ ...this.#state.progress, percent: 100 }) },
        error: null,
      });
    });
    this.#listen("error", () => {
      this.#setState({
        phase: "error",
        progress: null,
        lastCheckedAt: new Date().toISOString(),
        error: { code: "UPDATE_FAILED", message: "更新服务暂时不可用，请稍后重试。" },
      });
    });

    if (schedule) {
      this.#initialTimer = this.#timers.setTimeout(() => {
        this.#initialTimer = null;
        void this.check().catch(() => undefined);
      }, INITIAL_CHECK_DELAY_MS);
      this.#intervalTimer = this.#timers.setInterval(() => {
        void this.check().catch(() => undefined);
      }, CHECK_INTERVAL_MS);
    }
    return this.getState();
  }

  getState() {
    return {
      ...this.#state,
      progress: this.#state.progress ? { ...this.#state.progress } : null,
      error: this.#state.error ? { ...this.#state.error } : null,
    };
  }

  async check() {
    if (!this.#state.enabled || BUSY_PHASES.has(this.#state.phase)) return this.getState();
    if (this.#checkPromise) return this.#checkPromise;

    this.#setState({ phase: "checking", progress: null, error: null });
    this.#checkPromise = Promise.resolve()
      .then(() => this.#updater.checkForUpdates())
      .then(() => this.getState())
      .catch(() => {
        if (this.#state.phase !== "error") {
          this.#setState({
            phase: "error",
            progress: null,
            lastCheckedAt: new Date().toISOString(),
            error: { code: "UPDATE_CHECK_FAILED", message: "检查更新失败，请稍后重试。" },
          });
        }
        throw new AppError("UPDATE_CHECK_FAILED", "检查更新失败，请稍后重试。" );
      })
      .finally(() => {
        this.#checkPromise = null;
      });
    return this.#checkPromise;
  }

  install() {
    if (!this.#state.enabled) {
      throw new AppError("UPDATE_DISABLED", "开发模式不执行客户端更新。" );
    }
    if (this.#state.phase !== "ready") {
      throw new AppError("UPDATE_NOT_READY", "更新尚未下载完成。" );
    }
    if (this.#hasActiveTransfers()) {
      throw new AppError("UPDATE_INSTALL_BLOCKED", "仍有文件正在传输，请等待传输完成或取消后再重启更新。" );
    }

    this.#setState({ phase: "installing", error: null });
    try {
      this.#disconnectAll();
      this.#updater.quitAndInstall(true, true);
      return { installing: true };
    } catch {
      this.#setState({
        phase: "error",
        error: { code: "UPDATE_INSTALL_FAILED", message: "无法启动更新安装，请重新打开客户端后再试。" },
      });
      throw new AppError("UPDATE_INSTALL_FAILED", "无法启动更新安装，请重新打开客户端后再试。" );
    }
  }

  dispose() {
    if (this.#initialTimer) this.#timers.clearTimeout(this.#initialTimer);
    if (this.#intervalTimer) this.#timers.clearInterval(this.#intervalTimer);
    this.#initialTimer = null;
    this.#intervalTimer = null;
    for (const [eventName, listener] of this.#listeners) {
      this.#updater.off(eventName, listener);
    }
    this.#listeners.clear();
  }

  #listen(eventName, listener) {
    this.#listeners.set(eventName, listener);
    this.#updater.on(eventName, listener);
  }

  #setState(patch) {
    this.#state = { ...this.#state, ...patch };
    this.#emit("update-status", this.getState());
  }
}
