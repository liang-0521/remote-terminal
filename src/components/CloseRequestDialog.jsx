import { useEffect, useRef, useState } from "react";
import { ArrowLineDown, Power, WarningCircle, X } from "@phosphor-icons/react";
import { useModalFocus } from "./useModalFocus.js";

export function CloseRequestDialog({ open, hasActiveTransfers = false, onResolve }) {
  const [remember, setRemember] = useState(false);
  const [pending, setPending] = useState(false);
  const [exitArmed, setExitArmed] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef(null);
  const backgroundButtonRef = useRef(null);

  useModalFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: backgroundButtonRef,
    canClose: !pending,
    onClose: () => resolve("cancel"),
  });

  useEffect(() => {
    if (!open) return;
    setRemember(false);
    setPending(false);
    setExitArmed(false);
    setError("");
  }, [open]);

  if (!open) return null;

  async function resolve(action) {
    if (pending) return;
    if (action === "exit" && hasActiveTransfers && !exitArmed) {
      setExitArmed(true);
      setError("仍有文件正在传输。再次点击确认后会中断这些任务并退出客户端。");
      return;
    }

    setPending(true);
    setError("");
    try {
      await onResolve(action, { remember: action !== "cancel" && remember });
    } catch (resolveError) {
      setError(resolveError?.message || "无法处理关闭请求。");
      setPending(false);
    }
  }

  return (
    <div className="native-dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="native-dialog close-request-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="close-request-title"
        aria-describedby="close-request-description"
      >
        <header>
          <span><ArrowLineDown size={23} weight="duotone" /></span>
          <div>
            <h2 id="close-request-title">关闭主窗口</h2>
            <p id="close-request-description">选择继续在后台运行，或完全退出客户端。</p>
          </div>
          <button type="button" aria-label="取消关闭" disabled={pending} onClick={() => resolve("cancel")}>
            <X size={19} />
          </button>
        </header>
        <div className="native-dialog__body">
          <div className="close-request-dialog__choices">
            <button
              ref={backgroundButtonRef}
              type="button"
              className="close-request-dialog__choice"
              disabled={pending}
              onClick={() => resolve("background")}
            >
              <ArrowLineDown size={22} weight="duotone" />
              <span><strong>后台运行</strong><small>隐藏到系统托盘，SSH 会话和文件传输继续运行。</small></span>
            </button>
            <button
              type="button"
              className={`close-request-dialog__choice is-danger ${exitArmed ? "is-armed" : ""}`}
              disabled={pending}
              onClick={() => resolve("exit")}
            >
              <Power size={22} weight="duotone" />
              <span>
                <strong>{exitArmed ? "再次点击确认退出" : "直接退出"}</strong>
                <small>关闭全部 SSH 会话并结束客户端进程。</small>
              </span>
            </button>
          </div>
          {hasActiveTransfers && (
            <div className="close-request-dialog__warning" role="note">
              <WarningCircle size={18} weight="duotone" />
              <span>检测到活动文件传输。后台运行不会中断；直接退出需要再次确认。</span>
            </div>
          )}
          <label className="native-credential-option" htmlFor="remember-close-behavior">
            <input
              id="remember-close-behavior"
              type="checkbox"
              checked={remember}
              disabled={pending}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>记住本次选择，可稍后在设置中修改</span>
          </label>
          {error && <div className="native-dialog__error" role="alert">{error}</div>}
        </div>
        <footer>
          <button type="button" className="secondary-button" disabled={pending} onClick={() => resolve("cancel")}>取消</button>
        </footer>
      </section>
    </div>
  );
}
