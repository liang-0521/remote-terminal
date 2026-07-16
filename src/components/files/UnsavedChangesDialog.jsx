import { useRef } from "react";
import { FileText, WarningCircle, X } from "@phosphor-icons/react";
import { useModalFocus } from "../shared/useModalFocus.js";

export function UnsavedChangesDialog({ request, onCancel, onConfirm }) {
  const dialogRef = useRef(null);
  const cancelButtonRef = useRef(null);
  const open = Boolean(request);

  useModalFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: cancelButtonRef,
    onClose: onCancel,
  });

  if (!request) return null;

  return (
    <div className="native-dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="native-dialog remote-delete-dialog is-mismatch"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsaved-changes-title"
        aria-describedby="unsaved-changes-description"
      >
        <header>
          <span><FileText size={23} weight="duotone" /></span>
          <div>
            <h2 id="unsaved-changes-title">有未保存的修改</h2>
            <p id="unsaved-changes-description">{request.actionLabel}会丢失以下内容。</p>
          </div>
          <button type="button" aria-label="继续编辑" onClick={onCancel}><X size={19} /></button>
        </header>
        <div className="native-dialog__body">
          <div className="remote-delete-dialog__target">
            {request.documents.map((document) => (
              <div key={document.key} style={{ display: "grid", gap: 4 }}>
                <strong>{document.name}</strong>
                <code>{document.path}</code>
              </div>
            ))}
          </div>
          <div className="remote-delete-dialog__warning" role="note">
            <WarningCircle size={18} weight="duotone" />
            <span>这些修改还没有写回远程服务器。选择继续编辑会保留当前标签和编辑内容。</span>
          </div>
        </div>
        <footer>
          <button ref={cancelButtonRef} type="button" className="secondary-button" onClick={onCancel}>继续编辑</button>
          <button type="button" className="danger-button" onClick={onConfirm}>放弃修改并{request.actionLabel}</button>
        </footer>
      </section>
    </div>
  );
}
