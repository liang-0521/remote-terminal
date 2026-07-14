import { useEffect, useRef, useState } from "react";
import { ShieldCheck, ShieldWarning, X } from "@phosphor-icons/react";
import { useModalFocus } from "./useModalFocus.js";

export function HostKeyDialog({ prompt, onAccept, onClose }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const closeRef = useRef(null);
  const dialogRef = useRef(null);

  useModalFocus({
    open: Boolean(prompt),
    containerRef: dialogRef,
    initialFocusRef: closeRef,
    canClose: !pending,
    onClose,
  });

  useEffect(() => {
    if (!prompt) {
      setPending(false);
      setError("");
      return undefined;
    }
    return undefined;
  }, [prompt]);

  if (!prompt) return null;
  const mismatch = prompt.status === "mismatch";

  async function accept() {
    setPending(true);
    setError("");
    try {
      await onAccept();
    } catch (acceptError) {
      setError(acceptError?.message || "无法保存主机指纹。" );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="native-dialog-backdrop" role="presentation">
      <section ref={dialogRef} className={`native-dialog host-key-dialog ${mismatch ? "is-mismatch" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="host-key-title">
        <header>
          <span>{mismatch ? <ShieldWarning size={23} weight="duotone" /> : <ShieldCheck size={23} weight="duotone" />}</span>
          <div>
            <h2 id="host-key-title">{mismatch ? "服务器主机指纹已变化" : "确认服务器主机指纹"}</h2>
            <p>{prompt.host ? `${prompt.host}:${prompt.port}` : "连接已安全阻断"}</p>
          </div>
          <button ref={closeRef} type="button" aria-label="关闭主机指纹确认" disabled={pending} onClick={onClose}><X size={19} /></button>
        </header>
        <div className="native-dialog__body">
          {mismatch ? (
            <>
              <p>当前服务器返回的指纹与本机已信任记录不同。可能是服务器重装，也可能存在中间人攻击；客户端不会自动覆盖。</p>
              <Fingerprint label="已信任指纹" value={prompt.expectedFingerprint} />
              <Fingerprint label="本次收到指纹" value={prompt.receivedFingerprint} />
            </>
          ) : (
            <>
              <p>这是首次连接该地址。请通过可信渠道与服务器管理员核对下列指纹，确认后才会继续发送密码。</p>
              <Fingerprint label={`主机密钥 · ${prompt.algorithm}`} value={prompt.fingerprint} />
            </>
          )}
          {error && <div className="native-dialog__error" role="alert">{error}</div>}
        </div>
        <footer>
          <button type="button" className="secondary-button" disabled={pending} onClick={onClose}>{mismatch ? "关闭" : "取消连接"}</button>
          {!mismatch && <button type="button" className="primary-button" disabled={pending} onClick={accept}>{pending ? "正在保存…" : "指纹一致，继续连接"}</button>}
        </footer>
      </section>
    </div>
  );
}

function Fingerprint({ label, value }) {
  return <div className="host-key-dialog__fingerprint"><span>{label}</span><code>{value}</code></div>;
}
