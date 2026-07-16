import { useEffect, useRef, useState } from "react";
import { Files, WarningCircle, X } from "@phosphor-icons/react";
import { useModalFocus } from "../shared/useModalFocus.js";

export function UploadConflictDialog({ request, onCancel, onConfirm }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef(null);
  const cancelButtonRef = useRef(null);
  const open = Boolean(request);
  const blocked = request?.mode === "blocked";

  useModalFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: cancelButtonRef,
    canClose: !pending,
    onClose: onCancel,
  });

  useEffect(() => {
    if (!open) return;
    setPending(false);
    setError("");
  }, [open, request]);

  if (!request) return null;

  async function confirm() {
    if (pending || blocked) return;
    setPending(true);
    setError("");
    try {
      await onConfirm(request);
    } catch (uploadError) {
      setError(uploadError?.message || "无法开始上传。");
      setPending(false);
    }
  }

  return (
    <div className="native-dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="native-dialog remote-delete-dialog is-mismatch"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="upload-conflict-title"
        aria-describedby="upload-conflict-description"
      >
        <header>
          <span><Files size={23} weight="duotone" /></span>
          <div>
            <h2 id="upload-conflict-title">{blocked ? "无法覆盖同名条目" : "覆盖远程文件？"}</h2>
            <p id="upload-conflict-description">
              {blocked ? "远程目录中存在同名文件夹或特殊条目。" : "以下文件已存在，必须明确确认后才会替换。"}
            </p>
          </div>
          <button type="button" aria-label="关闭上传确认" disabled={pending} onClick={onCancel}><X size={19} /></button>
        </header>
        <div className="native-dialog__body">
          <div className="remote-delete-dialog__target">
            <strong>{request.directory}</strong>
            {request.names.map((name) => <code key={name}>{name}</code>)}
          </div>
          <div className="remote-delete-dialog__warning" role="note">
            <WarningCircle size={18} weight="duotone" />
            <span>
              {blocked
                ? "文件夹和特殊条目不会被文件上传覆盖，本次上传尚未开始。"
                : "覆盖时会先保留远程备份；只有替换成功后才清理备份。点取消不会上传，也不会覆盖。"}
            </span>
          </div>
          {error && <div className="native-dialog__error" role="alert">{error}</div>}
        </div>
        <footer>
          <button ref={cancelButtonRef} type="button" className="secondary-button" disabled={pending} onClick={onCancel}>{blocked ? "关闭" : "取消"}</button>
          {!blocked && <button type="button" className="danger-button" disabled={pending} onClick={() => void confirm()}>{pending ? "正在上传…" : "覆盖并上传"}</button>}
        </footer>
      </section>
    </div>
  );
}
