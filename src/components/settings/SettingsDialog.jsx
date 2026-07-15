import { useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  Database,
  Desktop,
  FolderOpen,
  Image,
  Palette,
  Power,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import { useModalFocus } from "../shared/useModalFocus.js";

const MAX_WALLPAPER_BYTES = 8 * 1024 * 1024;

const DEFAULT_COLORS = {
  accent: "#9d84f8",
  terminalBackground: "#061423",
  terminalForeground: "#c8cbd1",
};

const ACCENT_PRESETS = [
  { name: "紫罗兰", value: "#9d84f8" },
  { name: "天空蓝", value: "#60a5fa" },
  { name: "青绿色", value: "#2dd4bf" },
  { name: "翡翠绿", value: "#22c55e" },
  { name: "琥珀色", value: "#f59e0b" },
  { name: "珊瑚红", value: "#f43f5e" },
  { name: "玫红色", value: "#ec4899" },
  { name: "石墨黑", value: "#111827" },
  { name: "冰雪白", value: "#f8fafc" },
];

const TERMINAL_BACKGROUND_PRESETS = [
  { name: "午夜蓝", value: "#061423" },
  { name: "纯黑", value: "#000000" },
  { name: "炭黑", value: "#111827" },
  { name: "暖灰", value: "#1c1917" },
  { name: "纸白", value: "#f8fafc" },
  { name: "纯白", value: "#ffffff" },
];

const TERMINAL_FOREGROUND_PRESETS = [
  { name: "雾白", value: "#c8cbd1" },
  { name: "纯白", value: "#ffffff" },
  { name: "柔黑", value: "#111827" },
  { name: "纯黑", value: "#000000" },
  { name: "终端绿", value: "#86efac" },
  { name: "琥珀黄", value: "#facc15" },
];

const SETTINGS_PAGES = [
  { id: "appearance", label: "外观", description: "界面与终端", Icon: Palette },
  { id: "storage", label: "数据与存储", description: "目录与凭据", Icon: Database },
  { id: "application", label: "应用", description: "后台与更新", Icon: Desktop },
];

function normalizeComparablePath(value) {
  return String(value || "").trim().replace(/[\\/]+$/, "").toLowerCase();
}

export function SettingsDialog({
  open,
  theme,
  onThemeChange,
  onWallpaperChange,
  onRemoveWallpaper,
  dataDirectoryStatus,
  onChooseDataDirectory,
  onChangeDataDirectory,
  closeBehavior,
  closeBehaviorError,
  onCloseBehaviorChange,
  updateState,
  updateActionError,
  hasActiveTransfers = false,
  onCheckUpdate,
  onInstallUpdate,
  onClose,
}) {
  const [activePage, setActivePage] = useState("appearance");
  const [fileError, setFileError] = useState("");
  const [storageTarget, setStorageTarget] = useState("");
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [storageResult, setStorageResult] = useState(null);
  const panelRef = useRef(null);
  const closeButtonRef = useRef(null);
  const fileInputRef = useRef(null);
  const readerRef = useRef(null);
  const pageButtonRefs = useRef([]);

  useModalFocus({
    open,
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onClose,
  });

  useEffect(() => {
    if (!open) return undefined;
    setActivePage("appearance");
    setFileError("");
    setStorageTarget(dataDirectoryStatus?.pendingPath || dataDirectoryStatus?.currentPath || "");
    setStorageBusy(false);
    setStorageError("");
    setStorageResult(null);
    return () => {
      if (readerRef.current?.readyState === FileReader.LOADING) readerRef.current.abort();
      readerRef.current = null;
    };
  }, [dataDirectoryStatus?.currentPath, dataDirectoryStatus?.pendingPath, open]);

  if (!open) return null;

  const wallpaperVisibility = Math.round(Number(theme.wallpaperOpacity) * 100);
  const updatePhase = updateState?.phase || "disabled";
  const updateReady = updatePhase === "ready";
  const updateBusy = ["checking", "available", "downloading", "installing"].includes(updatePhase);
  const updatePercent = Math.round(Number(updateState?.progress?.percent) || 0);
  const updateButtonDisabled = updateBusy
    || updatePhase === "disabled"
    || (updateReady && hasActiveTransfers);
  const updateStatus = describeUpdateStatus(updateState, hasActiveTransfers, updateActionError);
  const normalizedStorageTarget = normalizeComparablePath(storageTarget);
  const storageTargetUnchanged = Boolean(normalizedStorageTarget)
    && [dataDirectoryStatus?.currentPath, dataDirectoryStatus?.pendingPath]
      .some((path) => normalizeComparablePath(path) === normalizedStorageTarget);

  function updateTheme(patch) {
    onThemeChange({ ...theme, ...patch });
  }

  function resetColors() {
    updateTheme(DEFAULT_COLORS);
  }

  function handleWallpaperFile(event) {
    const input = event.currentTarget;
    const [file] = Array.from(input.files || []);
    input.value = "";

    if (!file) return;
    if (readerRef.current?.readyState === FileReader.LOADING) readerRef.current.abort();
    readerRef.current = null;

    if (!file.type.toLowerCase().startsWith("image/")) {
      setFileError("请选择 PNG、JPG、WebP 等图片文件");
      return;
    }
    if (file.size > MAX_WALLPAPER_BYTES) {
      setFileError("图片大小不能超过 8 MB");
      return;
    }

    setFileError("");
    const reader = new FileReader();
    readerRef.current = reader;

    reader.onerror = () => {
      if (readerRef.current !== reader) return;
      readerRef.current = null;
      setFileError("无法读取该图片，请重新选择");
    };
    reader.onload = () => {
      if (readerRef.current !== reader) return;
      readerRef.current = null;
      if (typeof reader.result !== "string") {
        setFileError("无法读取该图片，请重新选择");
        return;
      }
      onWallpaperChange({ name: file.name, url: reader.result });
    };
    reader.readAsDataURL(file);
  }

  function removeWallpaper() {
    setFileError("");
    onRemoveWallpaper();
  }

  function selectPage(pageId) {
    setActivePage(pageId);
    setFileError("");
  }

  function handlePageKeyDown(event, currentIndex) {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? SETTINGS_PAGES.length - 1
        : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + SETTINGS_PAGES.length) % SETTINGS_PAGES.length;
    selectPage(SETTINGS_PAGES[nextIndex].id);
    pageButtonRefs.current[nextIndex]?.focus();
  }

  async function chooseDataDirectory() {
    setStorageError("");
    try {
      const selectedPath = await onChooseDataDirectory?.();
      if (selectedPath) setStorageTarget(selectedPath);
    } catch (error) {
      setStorageError(error?.message || "无法打开文件夹选择器。");
    }
  }

  async function applyDataDirectory() {
    setStorageBusy(true);
    setStorageError("");
    setStorageResult(null);
    try {
      const result = await onChangeDataDirectory?.(storageTarget);
      if (result) {
        setStorageResult(result);
        setStorageTarget(result.status?.pendingPath || result.status?.currentPath || storageTarget);
      }
    } catch (error) {
      setStorageError(error?.message || "无法迁移应用数据目录。");
    } finally {
      setStorageBusy(false);
    }
  }

  return (
    <div
      className="settings-dialog"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        aria-describedby={activePage === "appearance"
          ? "settings-dialog-description settings-session-note"
          : "settings-dialog-description"}
        tabIndex={-1}
      >
        <header className="settings-panel__header">
          <div className="settings-panel__heading">
            <span className="settings-panel__mark" aria-hidden="true">
              <Palette size={22} weight="duotone" />
            </span>
            <div>
              <h2 id="settings-dialog-title">设置</h2>
              <p id="settings-dialog-description">管理工作台外观、数据位置与应用行为。</p>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="settings-panel__close"
            aria-label="关闭设置"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>

        <div className="settings-panel__body">
          <nav className="settings-navigation" role="tablist" aria-label="设置页面" aria-orientation="vertical">
            {SETTINGS_PAGES.map(({ id, label, description, Icon }, index) => (
              <button
                ref={(element) => { pageButtonRefs.current[index] = element; }}
                id={`settings-tab-${id}`}
                key={id}
                type="button"
                role="tab"
                aria-controls="settings-page-content"
                aria-selected={activePage === id}
                tabIndex={activePage === id ? 0 : -1}
                onClick={() => selectPage(id)}
                onKeyDown={(event) => handlePageKeyDown(event, index)}
              >
                <Icon size={20} weight={activePage === id ? "duotone" : "regular"} />
                <span><strong>{label}</strong><small>{description}</small></span>
              </button>
            ))}
          </nav>

          <form
            id="settings-page-content"
            className="settings-form"
            role="tabpanel"
            aria-labelledby={`settings-tab-${activePage}`}
            onSubmit={(event) => event.preventDefault()}
          >
          {activePage === "appearance" && <>
          <div id="settings-session-note" className="settings-form__notice" role="note">
            <strong>仅当前页面会话</strong>
            <span>这些外观设置不会写入本地存储，刷新或关闭页面后将恢复默认值。</span>
          </div>

          <section className="settings-form__section" aria-labelledby="settings-color-title">
            <div className="settings-form__section-heading">
              <div>
                <h3 id="settings-color-title">界面与终端颜色</h3>
                <p>颜色修改会立即应用到当前工作台。</p>
              </div>
              <button type="button" className="settings-form__reset" onClick={resetColors}>
                <ArrowCounterClockwise size={16} />
                重置默认颜色
              </button>
            </div>

            <div className="settings-form__color-grid">
              <ColorSetting
                id="settings-accent"
                label="强调色"
                value={theme.accent}
                presets={ACCENT_PRESETS}
                onChange={(value) => updateTheme({ accent: value })}
              />
              <ColorSetting
                id="settings-terminal-background"
                label="终端背景色"
                value={theme.terminalBackground}
                presets={TERMINAL_BACKGROUND_PRESETS}
                onChange={(value) => updateTheme({ terminalBackground: value })}
              />
              <ColorSetting
                id="settings-terminal-foreground"
                label="终端文字色"
                value={theme.terminalForeground}
                presets={TERMINAL_FOREGROUND_PRESETS}
                onChange={(value) => updateTheme({ terminalForeground: value })}
              />
            </div>
          </section>

          <section className="settings-form__section" aria-labelledby="settings-wallpaper-title">
            <div className="settings-form__section-heading">
              <div>
                <h3 id="settings-wallpaper-title">终端背景图</h3>
                <p>支持 image/* 图片，单个文件不超过 8 MB。</p>
              </div>
            </div>

            <input
              ref={fileInputRef}
              className="settings-form__file-input"
              type="file"
              accept="image/*"
              hidden
              aria-describedby={fileError ? "settings-wallpaper-help settings-wallpaper-error" : "settings-wallpaper-help"}
              onChange={handleWallpaperFile}
            />

            <div className="settings-form__wallpaper-row">
              <button
                type="button"
                className="settings-form__upload"
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadSimple size={17} />
                选择背景图片
              </button>

              <div className="settings-form__wallpaper-file" aria-live="polite">
                <Image size={18} aria-hidden="true" />
                <span title={theme.wallpaperName || undefined}>
                  {theme.wallpaperName || "未选择背景图"}
                </span>
                {theme.wallpaperName && (
                  <button
                    type="button"
                    aria-label={`移除背景图 ${theme.wallpaperName}`}
                    onClick={removeWallpaper}
                  >
                    <Trash size={16} />
                    移除
                  </button>
                )}
              </div>
            </div>
            <small id="settings-wallpaper-help" className="settings-form__help">
              图片只保留在当前页面内存中，不会上传或写入本地存储。
            </small>
            {fileError && (
              <small id="settings-wallpaper-error" className="settings-form__error" role="alert">
                {fileError}
              </small>
            )}

            <label className="settings-form__range" htmlFor="settings-wallpaper-opacity">
              <span>
                背景暗度 / 可见度
                <output htmlFor="settings-wallpaper-opacity">{wallpaperVisibility}%</output>
              </span>
              <input
                id="settings-wallpaper-opacity"
                type="range"
                min="0"
                max="100"
                step="1"
                value={wallpaperVisibility}
                aria-valuetext={`${wallpaperVisibility}% 可见度`}
                onChange={(event) => updateTheme({ wallpaperOpacity: Number(event.target.value) / 100 })}
              />
              <small>0% 最暗，100% 最清晰。</small>
            </label>
          </section>

          </>}

          {activePage === "storage" && (
            <section className="settings-form__storage-page" aria-labelledby="settings-storage-title">
              <div className="settings-form__page-heading">
                <div>
                  <h3 id="settings-storage-title">数据与存储</h3>
                  <p>连接配置和主机指纹可以迁移；密码与 WebView2 缓存继续由 Windows 管理。</p>
                </div>
              </div>

              <section className="settings-form__section">
                <div className="settings-form__section-heading">
                  <div>
                    <h3>应用数据目录</h3>
                    <p>更改后会复制并校验数据，旧目录保留用于回滚；重启客户端后切换。</p>
                  </div>
                  {dataDirectoryStatus?.restartRequired && <span className="settings-storage__restart">等待重启</span>}
                </div>

                <dl className="settings-storage__paths">
                  <div><dt>当前使用</dt><dd title={dataDirectoryStatus?.currentPath}>{dataDirectoryStatus?.currentPath || "正在读取…"}</dd></div>
                  <div><dt>默认位置</dt><dd title={dataDirectoryStatus?.defaultPath}>{dataDirectoryStatus?.defaultPath || "正在读取…"}</dd></div>
                  {dataDirectoryStatus?.pendingPath && <div><dt>重启后使用</dt><dd title={dataDirectoryStatus.pendingPath}>{dataDirectoryStatus.pendingPath}</dd></div>}
                </dl>

                <label className="settings-storage__target" htmlFor="settings-storage-target">
                  <span>新数据目录</span>
                  <span>
                    <input
                      id="settings-storage-target"
                      value={storageTarget}
                      spellCheck="false"
                      disabled={storageBusy}
                      onChange={(event) => setStorageTarget(event.target.value)}
                    />
                    <button type="button" disabled={storageBusy} onClick={() => void chooseDataDirectory()}>
                      <FolderOpen size={17} />
                      选择文件夹
                    </button>
                  </span>
                </label>

                <div className="settings-storage__actions">
                  <small>不能选择磁盘根目录、网络共享或重解析点；活动 SSH/传输期间不能迁移。</small>
                  <button
                    type="button"
                    disabled={storageBusy || !storageTarget.trim() || storageTargetUnchanged}
                    onClick={() => void applyDataDirectory()}
                  >
                    {storageBusy ? "正在迁移…" : "迁移并在下次启动使用"}
                  </button>
                </div>
                {storageError && <small className="settings-form__error" role="alert">{storageError}</small>}
                {storageResult && (
                  <div className="settings-storage__success" role="status">
                    已校验并迁移 {storageResult.migratedFiles?.length || 0} 个数据文件。旧目录仍保留，重启客户端后生效。
                  </div>
                )}
              </section>

              <div className="settings-storage__cards">
                <section><strong>连接与主机指纹</strong><span>存放在上方应用数据目录，可安全迁移。</span></section>
                <section><strong>服务器密码</strong><span>保存在 Windows Credential Manager，不写入 JSON，也不随目录迁移。</span></section>
                <section><strong>WebView2 缓存</strong><span>由 Windows 放在本地应用缓存目录，不属于业务数据，不提供迁移。</span></section>
              </div>
            </section>
          )}

          {activePage === "application" && <>
          {closeBehavior && (
            <section className="settings-form__section" aria-labelledby="settings-close-title">
              <div className="settings-form__section-heading">
                <div>
                  <h3 id="settings-close-title">关闭与后台运行</h3>
                  <p>控制点击主窗口关闭按钮时的行为。</p>
                </div>
              </div>
              <fieldset className="settings-close-behavior">
                <legend>关闭主窗口时</legend>
                {[
                  ["ask", "每次询问", "关闭时选择后台运行或完全退出。"],
                  ["background", "后台运行", "隐藏到系统托盘，SSH 和传输继续运行。"],
                  ["exit", "直接退出", "关闭全部会话并结束客户端进程。"],
                ].map(([value, label, description]) => (
                  <label key={value} htmlFor={`settings-close-${value}`}>
                    <input
                      id={`settings-close-${value}`}
                      type="radio"
                      name="close-behavior"
                      value={value}
                      checked={closeBehavior === value}
                      onChange={() => void onCloseBehaviorChange?.(value)}
                    />
                    <span><strong>{label}</strong><small>{description}</small></span>
                  </label>
                ))}
              </fieldset>
              <small className="settings-form__help">托盘图标始终提供“显示主窗口”和“退出”。</small>
              {closeBehaviorError && <small className="settings-form__error" role="alert">{closeBehaviorError}</small>}
            </section>
          )}

          {updateState && (
            <section className="settings-form__section" aria-labelledby="settings-update-title">
              <div className="settings-form__section-heading">
                <div>
                  <h3 id="settings-update-title">客户端更新</h3>
                  <p>安装版会从官方 GitHub Releases 自动检查并下载新版本。</p>
                </div>
              </div>

              <div className="settings-update" aria-live="polite">
                <div className="settings-update__details">
                  <span className="settings-update__version">
                    当前版本 <strong>v{updateState.currentVersion || "—"}</strong>
                  </span>
                  <span className={`settings-update__status is-${updatePhase}`} role="status">
                    {updateStatus}
                  </span>
                  {updateState.lastCheckedAt && (
                    <small>上次检查：{formatCheckedAt(updateState.lastCheckedAt)}</small>
                  )}
                </div>

                <button
                  type="button"
                  className="settings-update__action"
                  disabled={updateButtonDisabled}
                  title={updateReady && hasActiveTransfers ? "文件传输完成后才能重启更新" : undefined}
                  onClick={() => {
                    if (updateReady) void onInstallUpdate?.();
                    else void onCheckUpdate?.();
                  }}
                >
                  {updateReady ? <Power size={17} /> : <ArrowClockwise size={17} />}
                  {updateActionLabel(updatePhase, updatePercent, hasActiveTransfers)}
                </button>
              </div>

              {["downloading", "ready"].includes(updatePhase) && updateState.progress && (
                <div className="settings-update__progress" aria-label={`更新下载进度 ${updatePercent}%`}>
                  <span style={{ width: `${Math.min(100, Math.max(0, updatePercent))}%` }} />
                </div>
              )}
              <small className="settings-form__help">
                更新只会在你确认重启或退出客户端后安装；活动中的文件上传不会被强制中断。
              </small>
            </section>
          )}

          </>}

          <footer className="settings-form__footer">
            <span>{activePage === "appearance" ? "外观更改只应用到当前页面会话。" : activePage === "storage" ? "目录切换需要重启客户端。" : "应用设置会保存在本机。"}</span>
            <button type="button" className="settings-form__done" onClick={onClose}>
              完成
            </button>
          </footer>
          </form>
        </div>
      </section>
    </div>
  );
}

function describeUpdateStatus(state, hasActiveTransfers, actionError) {
  if (actionError) return actionError;
  if (!state || state.phase === "disabled") return "开发预览不检查更新，安装版中会自动启用。";
  if (state.phase === "checking") return "正在检查新版本…";
  if (state.phase === "available") return `发现 v${state.availableVersion || "新版本"}，准备下载…`;
  if (state.phase === "downloading") return `正在后台下载 v${state.availableVersion || "新版本"}…`;
  if (state.phase === "ready" && hasActiveTransfers) return "更新已就绪，等待当前文件传输完成。";
  if (state.phase === "ready") return `v${state.availableVersion || "新版本"} 已下载，可重启安装。`;
  if (state.phase === "installing") return "正在关闭会话并启动更新安装…";
  if (state.phase === "error") return state.error?.message || "更新服务暂时不可用。";
  return state.lastCheckedAt ? "当前已是最新版本。" : "启动后会自动检查，也可以立即检查。";
}

function updateActionLabel(phase, percent, hasActiveTransfers) {
  if (phase === "checking") return "正在检查";
  if (phase === "available") return "准备下载";
  if (phase === "downloading") return `下载 ${percent}%`;
  if (phase === "ready" && hasActiveTransfers) return "等待传输";
  if (phase === "ready") return "重启并安装";
  if (phase === "installing") return "正在重启";
  if (phase === "disabled") return "安装版可用";
  return "检查更新";
}

function formatCheckedAt(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : date.toLocaleString("zh-CN", { hour12: false });
}

function ColorField({ id, label, value, onChange }) {
  return (
    <label className="settings-form__color-field" htmlFor={id}>
      <span>{label}</span>
      <span className="settings-form__color-control">
        <input
          id={id}
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <code>{value.toUpperCase()}</code>
      </span>
    </label>
  );
}

function ColorSetting({ id, label, value, presets, onChange }) {
  return (
    <div className="settings-form__color-setting">
      <ColorField id={id} label={label} value={value} onChange={onChange} />
      <div className="settings-form__preset-list" role="group" aria-label={`${label}预设`}>
        {presets.map((preset) => (
          <button
            key={preset.value}
            type="button"
            className="settings-form__preset"
            aria-label={`${label}使用${preset.name}`}
            aria-pressed={value.toLowerCase() === preset.value.toLowerCase()}
            title={preset.name}
            onClick={() => onChange(preset.value)}
          >
            <span style={{ backgroundColor: preset.value }} aria-hidden="true" />
            <small>{preset.name}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
