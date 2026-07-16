import { useEffect, useRef, useState } from "react";
import { FilePlus, FolderPlus, X } from "@phosphor-icons/react";
import { useModalFocus } from "../shared/useModalFocus.js";

export function RemoteCreateDialog({ request, onCancel, onConfirm }) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const open = Boolean(request);

  useModalFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: inputRef,
    canClose: !pending,
    onClose: onCancel,
  });

  useEffect(() => {
    if (!request) return;
    setName("");
    setPending(false);
    setError("");
  }, [request]);

  if (!request) return null;
  const folder = request.entryType === "directory";
  const Icon = folder ? FolderPlus : FilePlus;

  async function submit(event) {
    event.preventDefault();
    if (pending) return;
    const nextName = name.trim();
    if (!nextName || nextName === "." || nextName === ".." || /[\\/\u0000-\u001f\u007f]/.test(nextName)) {
      setError("名称不能为空，也不能包含斜杠或控制字符。");
      return;
    }
    setPending(true);
    setError("");
    try {
      await onConfirm({ ...request, name: nextName });
    } catch (createError) {
      setError(createError?.message || `无法新建${folder ? "文件夹" : "文件"}。`);
      setPending(false);
    }
  }

  return (
    <div className="native-dialog-backdrop" role="presentation">
      <form ref={dialogRef} className="native-dialog remote-create-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-create-title" onSubmit={submit}>
        <header>
          <span><Icon size={23} weight="duotone" /></span>
          <div>
            <h2 id="remote-create-title">新建{folder ? "文件夹" : "文件"}</h2>
            <p>将在当前远程目录中创建，不会覆盖同名条目。</p>
          </div>
          <button type="button" aria-label="取消新建" disabled={pending} onClick={onCancel}><X size={19} /></button>
        </header>
        <div className="native-dialog__body">
          <div className="remote-delete-dialog__target"><code>{request.directory}</code></div>
          <label className="remote-rename-dialog__field">
            <span>{folder ? "文件夹名称" : "文件名称"}</span>
            <input ref={inputRef} value={name} disabled={pending} spellCheck="false" onChange={(event) => setName(event.target.value)} />
          </label>
          {error && <div className="native-dialog__error" role="alert">{error}</div>}
        </div>
        <footer>
          <button type="button" className="secondary-button" disabled={pending} onClick={onCancel}>取消</button>
          <button type="submit" className="primary-button" disabled={pending}>{pending ? "正在创建…" : "创建"}</button>
        </footer>
      </form>
    </div>
  );
}
