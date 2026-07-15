import { useEffect, useRef, useState } from "react";
import { ArrowsOutCardinal, X } from "@phosphor-icons/react";
import { useModalFocus } from "../shared/useModalFocus.js";

function parentPath(remotePath) {
  const index = remotePath.lastIndexOf("/");
  return index <= 0 ? "/" : remotePath.slice(0, index);
}

function resolveTargetPath(sourcePath, value) {
  if (value.startsWith("/")) return value;
  const parent = parentPath(sourcePath);
  return parent === "/" ? `/${value}` : `${parent}/${value}`;
}

export function RemoteRenameDialog({ request, onCancel, onConfirm }) {
  const [value, setValue] = useState("");
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
    setValue(request.entry.name);
    setPending(false);
    setError("");
  }, [request]);

  if (!request) return null;

  async function submit(event) {
    event.preventDefault();
    if (pending) return;
    const next = value.trim();
    if (!next || next === "." || next === ".." || /[\u0000-\u001f\u007f]/.test(next)) {
      setError("请输入有效的新名称或远程绝对路径。");
      return;
    }
    const targetPath = resolveTargetPath(request.remotePath, next);
    if (targetPath === request.remotePath) {
      setError("新路径与当前路径相同。");
      return;
    }
    setPending(true);
    setError("");
    try {
      await onConfirm({ ...request, targetPath });
    } catch (renameError) {
      setError(renameError?.message || "无法重命名或移动远程条目。");
      setPending(false);
    }
  }

  return (
    <div className="native-dialog-backdrop" role="presentation">
      <form ref={dialogRef} className="native-dialog remote-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-rename-title" onSubmit={submit}>
        <header>
          <span><ArrowsOutCardinal size={23} weight="duotone" /></span>
          <div>
            <h2 id="remote-rename-title">重命名或移动远程条目</h2>
            <p>输入名称会在当前目录重命名；输入绝对路径可移动到其他远程目录。</p>
          </div>
          <button type="button" aria-label="取消重命名或移动" disabled={pending} onClick={onCancel}><X size={19} /></button>
        </header>
        <div className="native-dialog__body">
          <div className="remote-delete-dialog__target">
            <strong>{request.entry.name}</strong>
            <code>{request.remotePath}</code>
          </div>
          <label className="remote-rename-dialog__field">
            <span>新名称或远程绝对路径</span>
            <input ref={inputRef} value={value} disabled={pending} spellCheck="false" onChange={(event) => setValue(event.target.value)} />
          </label>
          {error && <div className="native-dialog__error" role="alert">{error}</div>}
        </div>
        <footer>
          <button type="button" className="secondary-button" disabled={pending} onClick={onCancel}>取消</button>
          <button type="submit" className="primary-button" disabled={pending}>{pending ? "正在处理…" : "确认"}</button>
        </footer>
      </form>
    </div>
  );
}
