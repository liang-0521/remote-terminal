import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeSlash,
  HardDrives,
  Key,
  PencilSimple,
  Plus,
  ShieldCheck,
  Trash,
  User,
  X,
} from "@phosphor-icons/react";
import { useModalFocus } from "../shared/useModalFocus.js";

const EMPTY_FORM = {
  name: "",
  host: "",
  port: "22",
  username: "root",
  authMethod: "password",
  password: "",
  savePassword: false,
};

const NATIVE_STATE_LABELS = {
  connected: "已连接",
  disconnected: "未连接",
  connecting: "连接中",
  error: "连接失败",
};

function normalizeView(view) {
  return view === "new" ? "new" : "list";
}

function validateConnection(form, editing = false) {
  const errors = {};
  const port = Number(form.port);

  if (!form.name.trim()) errors.name = "请输入连接名称";
  if (!form.host.trim()) errors.host = "请输入主机地址";
  else if (/\s/.test(form.host)) errors.host = "主机地址不能包含空格";
  if (!form.username.trim()) errors.username = "请输入用户名";
  else if (/\s/.test(form.username)) errors.username = "用户名不能包含空格";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.port = "端口必须是 1–65535 的整数";
  }
  if (!editing && form.authMethod === "password" && !form.password) {
    errors.password = "请输入密码";
  }

  return errors;
}

export function ConnectionDialog({
  open,
  initialView = "list",
  servers = [],
  activeServerId,
  onClose,
  onSelectServer,
  onCreateServer,
  onUpdateServer,
  onForgetPassword,
  onDeleteServer,
  credentialStorage = { available: false },
}) {
  const [view, setView] = useState(() => normalizeView(initialView));
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [errors, setErrors] = useState({});
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [actionError, setActionError] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const dialogRef = useRef(null);
  const firstActionRef = useRef(null);

  useModalFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: firstActionRef,
    canClose: !submitting,
    onClose,
  });

  useEffect(() => {
    setEditingId(null);
    if (!open) {
      setForm(EMPTY_FORM);
      setErrors({});
      setPasswordVisible(false);
      setSubmitting(false);
      setSubmitError("");
      setActionError("");
      setDeleteConfirmId(null);
      setDeletingId(null);
      return undefined;
    }
    setView(normalizeView(initialView));
    setForm(EMPTY_FORM);
    setErrors({});
    setPasswordVisible(false);
    setSubmitting(false);
    setSubmitError("");
    setActionError("");
    setDeleteConfirmId(null);
    setDeletingId(null);
    return undefined;
  }, [initialView, open]);

  if (!open) return null;

  function showView(nextView) {
    setView(nextView);
    setEditingId(null);
    setErrors({});
    setSubmitError("");
    setForm(EMPTY_FORM);
    setPasswordVisible(false);
    setDeleteConfirmId(null);
    window.requestAnimationFrame(() => firstActionRef.current?.focus());
  }

  function editServer(server) {
    setEditingId(server.id);
    setForm({
      ...EMPTY_FORM,
      name: server.name,
      host: server.host,
      port: String(server.port),
      username: server.username,
      authMethod: server.authMethod,
    });
    setErrors({});
    setSubmitError("");
    setPasswordVisible(false);
    setDeleteConfirmId(null);
    setView("edit");
    window.requestAnimationFrame(() => firstActionRef.current?.focus());
  }

  function updateField(event) {
    const { name, type, value, checked } = event.target;
    const nextValue = type === "checkbox" ? checked : value;
    setForm((current) => ({
      ...current,
      [name]: nextValue,
      ...(name === "authMethod" && value !== "password" ? { password: "" } : {}),
    }));
    if (name === "authMethod" && value !== "password") setPasswordVisible(false);
    setErrors((current) => {
      if (!current[name] && !(name === "authMethod" && current.password)) return current;
      const next = { ...current };
      delete next[name];
      if (name === "authMethod" && value !== "password") delete next.password;
      return next;
    });
  }

  async function submitConnection(event) {
    event.preventDefault();
    if (submitting) return;
    const nextErrors = validateConnection(form, Boolean(editingId));

    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      const firstInvalidField = Object.keys(nextErrors)[0];
      event.currentTarget.elements.namedItem(firstInvalidField)?.focus();
      return;
    }

    const connection = {
      name: form.name.trim(),
      host: form.host.trim(),
      port: Number(form.port),
      username: form.username.trim(),
      authMethod: form.authMethod,
    };
    const password = form.password;
    setForm((current) => ({ ...current, password: "" }));
    setPasswordVisible(false);
    setSubmitting(true);
    setSubmitError("");
    try {
      const credential = { password, savePassword: form.savePassword };
      if (editingId) {
        await onUpdateServer(editingId, connection, credential);
        showView("list");
      } else {
        await onCreateServer(connection, credential);
      }
    } catch (error) {
      setSubmitError(error?.message || "无法保存或连接该服务器。请重试。" );
    } finally {
      setSubmitting(false);
    }
  }

  function openWorkspace(serverId) {
    onSelectServer(serverId);
    onClose();
  }

  async function forgetPassword(serverId) {
    setActionError("");
    try {
      await onForgetPassword?.(serverId);
    } catch (error) {
      setActionError(error?.message || "无法清除已保存密码。" );
    }
  }

  async function deleteServer(serverId) {
    if (deleteConfirmId !== serverId) {
      setDeleteConfirmId(serverId);
      setActionError("");
      return;
    }
    setDeletingId(serverId);
    setActionError("");
    try {
      await onDeleteServer?.(serverId);
      setDeleteConfirmId(null);
    } catch (error) {
      setActionError(error?.message || "无法删除该服务器连接。");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div
      className="connection-dialog"
      onMouseDown={(event) => {
        if (!submitting && event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <section
        ref={dialogRef}
        className="connection-manager"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-manager-title"
        aria-describedby="connection-manager-description"
      >
        <header className="connection-manager__header">
          <div className="connection-manager__heading">
            <span className="connection-manager__mark" aria-hidden="true">
              <HardDrives size={22} weight="duotone" />
            </span>
            <div>
              <h2 id="connection-manager-title">
                {view === "list" ? "连接管理" : editingId ? "编辑 SSH 连接" : "新增 SSH 连接"}
              </h2>
              <p id="connection-manager-description">
                {view === "list"
                  ? "选择已保存服务器，打开独立工作区"
                  : editingId ? "修改已有连接；不填写密码时只保存配置" : "连接配置会保存到本机；密码默认仅用于本次连接"}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="connection-manager__close"
            disabled={submitting}
            onClick={onClose}
            aria-label="关闭连接管理"
          >
            <X size={19} />
          </button>
        </header>

        {view === "list" ? (
          <div className="connection-manager__body">
            <div className="connection-manager__toolbar">
              <div>
                <strong>已保存服务器</strong>
                <span>{servers.length} 个连接</span>
              </div>
              <button
                ref={firstActionRef}
                type="button"
                className="connection-manager__primary"
                onClick={() => showView("new")}
              >
                <Plus size={17} weight="bold" />
                新增 SSH 连接
              </button>
            </div>

            <div className="connection-manager__list" role="list">
              {actionError && <div className="connection-form__submit-error" role="alert">{actionError}</div>}
              {servers.length ? servers.map((server) => {
                const isActive = server.id === activeServerId;
                const stateLabel = NATIVE_STATE_LABELS[server.state] || "状态未知";

                return (
                  <article
                    key={server.id}
                    className={`connection-manager__server ${isActive ? "is-active" : ""}`}
                    role="listitem"
                  >
                    <div className="connection-manager__server-icon" aria-hidden="true">
                      <HardDrives size={24} weight="duotone" />
                    </div>
                    <div className="connection-manager__server-copy">
                      <div className="connection-manager__server-title">
                        <strong>{server.name}</strong>
                        {isActive && <span className="connection-manager__current">当前工作区</span>}
                      </div>
                      <span className="connection-manager__endpoint">{server.endpoint}</span>
                      <span className={`connection-manager__credential ${server.hasSavedPassword ? "is-saved" : ""}`}>
                        <Key size={14} />
                        {server.hasSavedPassword ? "密码已由 Windows 加密保存" : "每次连接询问密码"}
                      </span>
                    </div>
                    <div className="connection-manager__server-actions">
                      <span className={`connection-manager__state connection-manager__state--${server.state}`}>
                        <i aria-hidden="true" />
                        {stateLabel}
                      </span>
                      <button type="button" disabled={deletingId === server.id} onClick={() => openWorkspace(server.id)}>
                        打开工作区
                        <ArrowRight size={16} />
                      </button>
                      {onUpdateServer && (
                        <button type="button" disabled={deletingId === server.id} onClick={() => editServer(server)}>
                          <PencilSimple size={16} />
                          编辑连接
                        </button>
                      )}
                      {server.hasSavedPassword && (
                        <button
                          type="button"
                          className="connection-manager__forget"
                          onClick={() => void forgetPassword(server.id)}
                        >
                          清除已保存密码
                        </button>
                      )}
                      {onDeleteServer && (
                        <button
                          type="button"
                          className={`connection-manager__delete ${deleteConfirmId === server.id ? "is-confirming" : ""}`}
                          disabled={deletingId === server.id}
                          onClick={() => void deleteServer(server.id)}
                          onBlur={() => {
                            if (deletingId !== server.id) setDeleteConfirmId((current) => current === server.id ? null : current);
                          }}
                        >
                          <Trash size={14} />
                          {deletingId === server.id ? "正在删除…" : deleteConfirmId === server.id ? "再次点击确认删除" : "删除连接"}
                        </button>
                      )}
                    </div>
                  </article>
                );
              }) : (
                <div className="connection-manager__empty">
                  <HardDrives size={32} weight="duotone" />
                  <strong>还没有保存的服务器</strong>
                  <span>新增一个 SSH 连接开始使用。</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <form className="connection-form" onSubmit={submitConnection} noValidate>
            <div className="connection-form__notice" role="note">
              <ShieldCheck size={20} weight="duotone" />
              <div>
                <strong>{editingId ? "编辑已保存连接" : "原生安全连接"}</strong>
                <span>{editingId
                  ? "名称可直接修改。修改地址、端口、用户名或使用新密码连接前，请先关闭该服务器工作区。连接目标变化会清除旧保存密码。"
                  : "默认只用于本次连接；选择保存后，由当前 Windows 用户凭据加密，连接配置仍不含密码。"}</span>
              </div>
            </div>

            <fieldset className="connection-form__grid" disabled={submitting} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <Field label="连接名称" name="name" error={errors.name} required>
                <input
                  ref={firstActionRef}
                  id="connection-name"
                  name="name"
                  value={form.name}
                  onChange={updateField}
                  placeholder="例如：生产环境 Web 01"
                  autoComplete="off"
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? "connection-name-error" : undefined}
                />
              </Field>

              <Field label="主机地址" name="host" error={errors.host} required>
                <input
                  id="connection-host"
                  name="host"
                  value={form.host}
                  onChange={updateField}
                  placeholder="服务器域名或 IP 地址"
                  autoComplete="off"
                  spellCheck="false"
                  aria-invalid={Boolean(errors.host)}
                  aria-describedby={errors.host ? "connection-host-error" : undefined}
                />
              </Field>

              <Field label="端口" name="port" error={errors.port} required>
                <input
                  id="connection-port"
                  name="port"
                  type="number"
                  min="1"
                  max="65535"
                  step="1"
                  value={form.port}
                  onChange={updateField}
                  inputMode="numeric"
                  aria-invalid={Boolean(errors.port)}
                  aria-describedby={errors.port ? "connection-port-error" : undefined}
                />
              </Field>

              <Field label="用户名" name="username" error={errors.username} required>
                <div className="connection-form__input-icon">
                  <User size={17} aria-hidden="true" />
                  <input
                    id="connection-username"
                    name="username"
                    value={form.username}
                    onChange={updateField}
                    placeholder="例如：root"
                    autoComplete="off"
                    aria-invalid={Boolean(errors.username)}
                    aria-describedby={errors.username ? "connection-username-error" : undefined}
                  />
                </div>
              </Field>

              <Field label="认证方式" name="authMethod" wide>
                <div className="connection-form__input-icon">
                  <Key size={17} aria-hidden="true" />
                  <select
                    id="connection-authMethod"
                    name="authMethod"
                    value={form.authMethod}
                    onChange={updateField}
                  >
                    <option value="password">密码</option>
                  </select>
                </div>
              </Field>

              {form.authMethod === "password" && (
                <Field label={editingId ? "新密码（可选）" : "密码"} name="password" error={errors.password} required={!editingId} wide>
                  <div className="connection-form__input-icon">
                    <Key size={17} aria-hidden="true" />
                    <input
                      id="connection-password"
                      name="password"
                      type={passwordVisible ? "text" : "password"}
                      value={form.password}
                      onChange={updateField}
                      placeholder={editingId ? "留空不修改；填写后保存配置并连接" : "输入本次 SSH 连接密码"}
                      autoComplete="off"
                      aria-invalid={Boolean(errors.password)}
                      aria-describedby={errors.password ? "connection-password-error" : undefined}
                      style={{ paddingRight: 46 }}
                    />
                    <button
                      type="button"
                      className="icon-button connection-form__password-toggle"
                      onClick={() => setPasswordVisible((visible) => !visible)}
                      aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
                      aria-pressed={passwordVisible}
                      style={{ position: "absolute", top: 1, right: 1 }}
                    >
                      {passwordVisible ? <EyeSlash size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </Field>
              )}

              {form.authMethod === "password" && (
                <div className="credential-save-option connection-form__field--wide">
                  <label htmlFor="connection-savePassword">
                    <input
                      id="connection-savePassword"
                      name="savePassword"
                      type="checkbox"
                      checked={form.savePassword}
                      disabled={!credentialStorage.available || (Boolean(editingId) && !form.password)}
                      onChange={updateField}
                    />
                    <span>使用 Windows 安全保存密码</span>
                  </label>
                  <small>
                    {credentialStorage.available
                      ? "默认关闭；仅在 SSH 认证成功后保存，可在连接列表中清除。"
                      : "当前 Windows 密码加密服务不可用，只能使用一次性密码。"}
                  </small>
                </div>
              )}
            </fieldset>

            {submitError && <div className="connection-form__submit-error" role="alert">{submitError}</div>}

            <footer className="connection-form__footer">
              <button type="button" className="connection-form__secondary" disabled={submitting} onClick={() => showView("list")}>
                <ArrowLeft size={16} />
                返回连接列表
              </button>
              <button type="submit" className="connection-form__submit" disabled={submitting}>
                {editingId ? <PencilSimple size={17} weight="bold" /> : <Plus size={17} weight="bold" />}
                {submitting ? "正在保存…" : editingId && !form.password ? "保存修改" : "保存并连接"}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}

function Field({ label, name, error, required, wide, children }) {
  return (
    <label className={`connection-form__field ${wide ? "connection-form__field--wide" : ""}`} htmlFor={`connection-${name}`}>
      <span>
        {label}
        {required && <i aria-hidden="true">*</i>}
      </span>
      {children}
      {error && <small id={`connection-${name}-error`} role="alert">{error}</small>}
    </label>
  );
}
