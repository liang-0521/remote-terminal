import { useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  Image,
  Palette,
  Power,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";

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
  { name: "琥珀色", value: "#f59e0b" },
  { name: "玫红色", value: "#ec4899" },
];

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=\"hidden\"]):not([hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

export function SettingsDialog({
  open,
  theme,
  onThemeChange,
  onWallpaperChange,
  onRemoveWallpaper,
  updateState,
  updateActionError,
  hasActiveTransfers = false,
  onCheckUpdate,
  onInstallUpdate,
  onClose,
}) {
  const [fileError, setFileError] = useState("");
  const panelRef = useRef(null);
  const closeButtonRef = useRef(null);
  const fileInputRef = useRef(null);
  const readerRef = useRef(null);
  const previousFocusRef = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;

    previousFocusRef.current = document.activeElement;
    setFileError("");
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = Array.from(panelRef.current?.querySelectorAll(FOCUSABLE_SELECTOR) || [])
        .filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1);
      const activeElement = document.activeElement;

      if (!panelRef.current?.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
      if (readerRef.current?.readyState === FileReader.LOADING) readerRef.current.abort();
      readerRef.current = null;
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
  }, [open]);

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
        aria-describedby="settings-dialog-description settings-session-note"
        tabIndex={-1}
      >
        <header className="settings-panel__header">
          <div className="settings-panel__heading">
            <span className="settings-panel__mark" aria-hidden="true">
              <Palette size={22} weight="duotone" />
            </span>
            <div>
              <h2 id="settings-dialog-title">设置</h2>
              <p id="settings-dialog-description">调整工作台外观并管理客户端更新。</p>
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

        <form className="settings-form" onSubmit={(event) => event.preventDefault()}>
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
              <ColorField
                id="settings-accent"
                label="强调色"
                value={theme.accent}
                onChange={(value) => updateTheme({ accent: value })}
              />
              <ColorField
                id="settings-terminal-background"
                label="终端背景色"
                value={theme.terminalBackground}
                onChange={(value) => updateTheme({ terminalBackground: value })}
              />
              <ColorField
                id="settings-terminal-foreground"
                label="终端文字色"
                value={theme.terminalForeground}
                onChange={(value) => updateTheme({ terminalForeground: value })}
              />
            </div>

            <div className="settings-form__presets" role="group" aria-label="强调色预设">
              <span>强调色预设</span>
              <div className="settings-form__preset-list">
                {ACCENT_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    className="settings-form__preset"
                    aria-label={`使用${preset.name}强调色`}
                    aria-pressed={theme.accent.toLowerCase() === preset.value.toLowerCase()}
                    title={preset.name}
                    onClick={() => updateTheme({ accent: preset.value })}
                  >
                    <span style={{ backgroundColor: preset.value }} aria-hidden="true" />
                    <small>{preset.name}</small>
                  </button>
                ))}
              </div>
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

          <footer className="settings-form__footer">
            <span>更改已应用到当前页面。</span>
            <button type="button" className="settings-form__done" onClick={onClose}>
              完成
            </button>
          </footer>
        </form>
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
