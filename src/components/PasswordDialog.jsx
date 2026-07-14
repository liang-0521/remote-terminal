import { useEffect, useRef, useState } from "react";
import { Eye, EyeSlash, Key, LockKey, X } from "@phosphor-icons/react";
import { useModalFocus } from "./useModalFocus.js";

export function PasswordDialog({ open, server, credentialStorage = { available: false }, onSubmit, onClose }) {
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [savePassword, setSavePassword] = useState(false);
  const inputRef = useRef(null);
  const dialogRef = useRef(null);

  useModalFocus({
    open: open && Boolean(server),
    containerRef: dialogRef,
    initialFocusRef: inputRef,
    canClose: !pending,
    onClose,
  });

  useEffect(() => {
    if (!open) {
      setPassword("");
      setVisible(false);
      setPending(false);
      setError("");
      setSavePassword(false);
      return undefined;
    }
    setPassword("");
    setVisible(false);
    setPending(false);
    setError("");
    setSavePassword(false);
    return undefined;
  }, [open, server?.id]);

  if (!open || !server) return null;

  async function submit(event) {
    event.preventDefault();
    if (!password) {
      setError("请输入本次 SSH 连接密码");
      inputRef.current?.focus();
      return;
    }
    const secret = password;
    setPassword("");
    setPending(true);
    setError("");
    try {
      await onSubmit(secret, { savePassword });
    } catch (submitError) {
      setError(submitError?.message || "SSH 连接失败。" );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="native-dialog-backdrop" role="presentation">
      <form ref={dialogRef} className="native-dialog native-password-dialog" role="dialog" aria-modal="true" aria-labelledby="password-dialog-title" onSubmit={submit}>
        <header>
          <span><LockKey size={22} weight="duotone" /></span>
          <div><h2 id="password-dialog-title">连接 {server.name}</h2><p>{server.endpoint}</p></div>
          <button type="button" aria-label="关闭密码输入" disabled={pending} onClick={onClose}><X size={19} /></button>
        </header>
        <div className="native-dialog__body">
          <div className="native-security-note"><Key size={18} /><span>默认只用于本次连接；保存时由当前 Windows 用户凭据加密，连接配置中不含密码。</span></div>
          <label htmlFor="native-password-input">SSH 密码</label>
          <div className="native-password-field">
            <input
              ref={inputRef}
              id="native-password-input"
              type={visible ? "text" : "password"}
              value={password}
              disabled={pending}
              autoComplete="off"
              onChange={(event) => { setPassword(event.target.value); setError(""); }}
            />
            <button type="button" aria-label={visible ? "隐藏密码" : "显示密码"} onClick={() => setVisible((value) => !value)}>
              {visible ? <EyeSlash size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <label className="native-credential-option" htmlFor="native-save-password">
            <input
              id="native-save-password"
              type="checkbox"
              checked={savePassword}
              disabled={pending || !credentialStorage.available}
              onChange={(event) => setSavePassword(event.target.checked)}
            />
            <span>{server.hasSavedPassword ? "用新密码替换已保存密码" : "保存此密码"}</span>
          </label>
          <small className="native-credential-help">
            {credentialStorage.available
              ? server.hasSavedPassword
                ? "不勾选时保留原密码；勾选后仅在认证成功时替换，可在连接管理中清除。"
                : "默认不保存；勾选后仅在本次 SSH 认证成功时保存。"
              : "Windows 密码加密服务不可用，当前密码不会保存。"}
          </small>
          {error && <div className="native-dialog__error" role="alert">{error}</div>}
        </div>
        <footer>
          <button type="button" className="secondary-button" disabled={pending} onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={pending}>{pending ? "正在连接…" : "连接"}</button>
        </footer>
      </form>
    </div>
  );
}
