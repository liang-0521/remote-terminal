import { useEffect, useRef, useState } from "react";
import { Trash, WarningCircle, X } from "@phosphor-icons/react";
import { useModalFocus } from "../shared/useModalFocus.js";

export function RemoteDeleteDialog({ request, onCancel, onConfirm }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef(null);
  const cancelButtonRef = useRef(null);
  const open = Boolean(request);

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
  }, [open, request?.remotePath]);

  if (!request) return null;

  async function confirm() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await onConfirm(request);
    } catch (deleteError) {
      setError(deleteError?.message || "无法删除远程条目。");
      setPending(false);
    }
  }

  const isDirectory = request.entry.type === "directory";
  return (
    <div className="native-dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="native-dialog remote-delete-dialog is-mismatch"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remote-delete-title"
        aria-describedby="remote-delete-description"
      >
        <header>
          <span><Trash size={23} weight="duotone" /></span>
          <div>
            <h2 id="remote-delete-title">删除远程{isDirectory ? "空目录" : "文件"}</h2>
            <p id="remote-delete-description">该操作会立即修改服务器上的真实文件，无法撤销。</p>
          </div>
          <button type="button" aria-label="取消删除" disabled={pending} onClick={onCancel}>
            <X size={19} />
          </button>
        </header>
        <div className="native-dialog__body">
          <div className="remote-delete-dialog__target">
            <strong>{request.entry.name}</strong>
            <code>{request.remotePath}</code>
          </div>
          <div className="remote-delete-dialog__warning" role="note">
            <WarningCircle size={18} weight="duotone" />
            <span>{isDirectory ? "只删除空目录；目录内有内容时会拒绝操作，不会递归删除。" : "请确认这是要从远程服务器永久删除的文件。"}</span>
          </div>
          {error && <div className="native-dialog__error" role="alert">{error}</div>}
        </div>
        <footer>
          <button ref={cancelButtonRef} type="button" className="secondary-button" disabled={pending} onClick={onCancel}>取消</button>
          <button type="button" className="danger-button" disabled={pending} onClick={() => void confirm()}>{pending ? "正在删除…" : "确认删除"}</button>
        </footer>
      </section>
    </div>
  );
}
