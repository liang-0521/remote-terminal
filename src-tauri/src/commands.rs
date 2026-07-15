use crate::{
    backend::{
        BackendState, BackendStatus, ConnectionView, DownloadedFile, HostKeyAcceptResult,
        HostKeyProbeResult, MonitorSample, SshConnectPayload, SshConnectResponse,
    },
    credentials::{CredentialRemoval, CredentialStatus},
    data_directory::{migrate_data_directory, paths_equivalent, validate_selected_data_directory},
    error::{AppError, AppResult},
    lifecycle,
    ssh::{
        download_file_name_for_dialog, CompletionItem, DirectoryListing, DisconnectResult,
        RemoteEntryRemoval, RemoteEntryRename, TerminalAttachResult, TerminalDimensions,
        TransferSummary, UploadFile,
    },
    state::{AppState, CloseBehavior, DataDirectoryStatus, UiPreferences},
    storage::{Connection, ConnectionDraft, ConnectionRemoval},
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseResolution {
    Background,
    Exit,
    Cancel,
}

#[tauri::command]
pub fn get_close_behavior(state: State<'_, AppState>) -> AppResult<CloseBehavior> {
    state
        .close_behavior()
        .map_err(|_| AppError::new("SETTINGS_READ_FAILED", "无法读取主窗口关闭行为设置。"))
}

#[tauri::command]
pub fn set_close_behavior(
    behavior: CloseBehavior,
    state: State<'_, AppState>,
) -> AppResult<CloseBehavior> {
    state
        .set_close_behavior(behavior)
        .map_err(|_| AppError::new("SETTINGS_WRITE_FAILED", "无法保存主窗口关闭行为设置。"))?;
    Ok(behavior)
}

#[tauri::command]
pub fn get_ui_preferences(state: State<'_, AppState>) -> AppResult<UiPreferences> {
    state
        .ui_preferences()
        .map_err(|_| AppError::new("SETTINGS_READ_FAILED", "无法读取界面与命令提示设置。"))
}

#[tauri::command]
pub fn set_ui_preferences(
    preferences: UiPreferences,
    state: State<'_, AppState>,
) -> AppResult<UiPreferences> {
    state
        .set_ui_preferences(preferences.clone())
        .map_err(|_| AppError::new("SETTINGS_WRITE_FAILED", "无法保存界面与命令提示设置。"))?;
    Ok(preferences)
}

#[tauri::command]
pub fn resolve_close_request<R: Runtime>(
    request_id: String,
    action: CloseResolution,
    app: AppHandle<R>,
) -> AppResult<()> {
    let is_pending = app
        .state::<AppState>()
        .consume_close_request(&request_id)
        .map_err(|_| AppError::new("NATIVE_STATE_FAILED", "关闭请求状态暂时不可用。"))?;
    if !is_pending {
        return Err(AppError::new(
            "CLOSE_REQUEST_INVALID",
            "关闭请求已失效，请重新关闭主窗口后再选择。",
        ));
    }
    match action {
        CloseResolution::Background => lifecycle::hide_main_window(&app),
        CloseResolution::Exit => {
            lifecycle::confirm_exit(&app);
            Ok(())
        }
        CloseResolution::Cancel => Ok(()),
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallResult {
    pub installing: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirectoryChangeResult {
    pub changed: bool,
    pub migrated_files: Vec<String>,
    pub source_retained: bool,
    pub credentials_migrated: bool,
    pub webview_cache_migrated: bool,
    pub restart_required: bool,
    pub status: DataDirectoryStatus,
}

#[tauri::command]
pub fn show_main_window<R: Runtime>(app: AppHandle<R>) -> AppResult<()> {
    lifecycle::restore_main_window(&app)
}

#[tauri::command]
pub fn quit_app<R: Runtime>(app: AppHandle<R>) -> AppResult<()> {
    lifecycle::request_exit_with_confirmation(&app, CloseBehavior::Exit);
    Ok(())
}

#[tauri::command]
pub fn get_backend_status(state: State<'_, BackendState>) -> BackendStatus {
    state.snapshot()
}

#[tauri::command]
pub fn data_directory_status(state: State<'_, AppState>) -> AppResult<DataDirectoryStatus> {
    state
        .data_directory_status()
        .map_err(|_| AppError::new("SETTINGS_READ_FAILED", "无法读取客户端数据目录设置。"))
}

#[tauri::command]
pub async fn data_directory_change(
    target_path: String,
    app_state: State<'_, AppState>,
    backend: State<'_, BackendState>,
) -> AppResult<DataDirectoryChangeResult> {
    let target = validate_selected_data_directory(&target_path)?;
    backend
        .with_data_directory_change(|| {
            let source = app_state.active_data_directory();
            let migration = migrate_data_directory(&source, &target)?;
            let status = app_state.set_data_directory(&target).map_err(|_| {
                AppError::new(
                    "SETTINGS_WRITE_FAILED",
                    "数据已安全复制，但无法保存下次启动的数据目录；当前目录保持不变。",
                )
            })?;
            let result = DataDirectoryChangeResult {
                changed: !paths_equivalent(&source, &target),
                migrated_files: migration.migrated_files,
                source_retained: true,
                credentials_migrated: false,
                webview_cache_migrated: false,
                restart_required: status.restart_required,
                status,
            };
            let restart_required = result.restart_required;
            Ok((result, restart_required))
        })
        .await
}

#[tauri::command]
pub fn connections_list(state: State<'_, BackendState>) -> AppResult<Vec<ConnectionView>> {
    state.list_connections()
}

#[tauri::command]
pub fn connections_save(
    connection: ConnectionDraft,
    state: State<'_, BackendState>,
) -> AppResult<Connection> {
    state.save_connection(connection)
}

#[tauri::command]
pub fn connections_remove(
    connection_id: String,
    state: State<'_, BackendState>,
) -> AppResult<ConnectionRemoval> {
    state.remove_connection(&connection_id)
}

#[tauri::command]
pub fn credentials_status(state: State<'_, BackendState>) -> CredentialStatus {
    state.credential_status()
}

#[tauri::command]
pub fn credentials_remove(
    connection_id: String,
    state: State<'_, BackendState>,
) -> AppResult<CredentialRemoval> {
    state.remove_credential(&connection_id)
}

#[tauri::command]
pub async fn host_keys_probe(
    connection_id: String,
    state: State<'_, BackendState>,
) -> AppResult<HostKeyProbeResult> {
    state.probe_host_key(&connection_id).await
}

#[tauri::command]
pub fn host_keys_accept(
    challenge_id: String,
    state: State<'_, BackendState>,
) -> AppResult<HostKeyAcceptResult> {
    state.accept_host_key(&challenge_id)
}

#[tauri::command]
pub async fn ssh_connect(
    payload: SshConnectPayload,
    state: State<'_, BackendState>,
) -> AppResult<SshConnectResponse> {
    state.connect(payload).await
}

#[tauri::command]
pub async fn ssh_disconnect(
    session_id: String,
    state: State<'_, BackendState>,
) -> AppResult<DisconnectResult> {
    state.disconnect(&session_id).await
}

#[tauri::command]
pub async fn terminal_attach(
    session_id: String,
    state: State<'_, BackendState>,
) -> AppResult<TerminalAttachResult> {
    state.attach_terminal(&session_id).await
}

#[tauri::command]
pub async fn terminal_write(
    session_id: String,
    data: String,
    state: State<'_, BackendState>,
) -> AppResult<()> {
    state.write_terminal(&session_id, &data).await
}

#[tauri::command]
pub async fn terminal_resize(
    session_id: String,
    dimensions: TerminalDimensions,
    state: State<'_, BackendState>,
) -> AppResult<TerminalDimensions> {
    state.resize_terminal(&session_id, dimensions).await
}

#[tauri::command]
pub async fn completion_catalog(
    session_id: String,
    state: State<'_, BackendState>,
) -> AppResult<Vec<CompletionItem>> {
    state.completion_catalog(&session_id).await
}

#[tauri::command]
pub fn command_history_list(
    connection_id: String,
    state: State<'_, BackendState>,
) -> AppResult<Vec<String>> {
    state.list_command_history(&connection_id)
}

#[tauri::command]
pub fn command_history_record(
    connection_id: String,
    command: String,
    state: State<'_, BackendState>,
) -> AppResult<Vec<String>> {
    state.record_command_history(&connection_id, &command)
}

#[tauri::command]
pub fn command_history_remove(
    connection_id: String,
    command: String,
    state: State<'_, BackendState>,
) -> AppResult<Vec<String>> {
    state.remove_command_history(&connection_id, &command)
}

#[tauri::command]
pub async fn sftp_list(
    session_id: String,
    path: String,
    state: State<'_, BackendState>,
) -> AppResult<DirectoryListing> {
    state.list_directory(&session_id, &path).await
}

#[tauri::command]
pub async fn sftp_remove(
    session_id: String,
    path: String,
    expected_entry_type: String,
    state: State<'_, BackendState>,
) -> AppResult<RemoteEntryRemoval> {
    state
        .remove_remote_entry(&session_id, &path, &expected_entry_type)
        .await
}

#[tauri::command]
pub async fn sftp_rename(
    session_id: String,
    source_path: String,
    target_path: String,
    expected_entry_type: String,
    state: State<'_, BackendState>,
) -> AppResult<RemoteEntryRename> {
    state
        .rename_remote_entry(
            &session_id,
            &source_path,
            &target_path,
            &expected_entry_type,
        )
        .await
}

#[tauri::command]
pub async fn sftp_upload(
    session_id: String,
    remote_directory: String,
    files: Vec<UploadFile>,
    state: State<'_, BackendState>,
) -> AppResult<Vec<TransferSummary>> {
    state
        .upload_files(&session_id, &remote_directory, files)
        .await
}

#[tauri::command]
pub async fn sftp_download_to_computer(
    session_id: String,
    remote_path: String,
    app: AppHandle,
    state: State<'_, BackendState>,
) -> AppResult<Option<DownloadedFile>> {
    let file_name = download_file_name_for_dialog(&remote_path)?;
    let mut dialog = app
        .dialog()
        .file()
        .set_title("下载到")
        .set_file_name(file_name);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let Some(target_path) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let target_path = target_path.into_path().map_err(|_| {
        AppError::new(
            "DOWNLOAD_TARGET_INVALID",
            "系统保存窗口返回了无法识别的本地文件路径。",
        )
    })?;
    state
        .download_file_to_path(&session_id, &remote_path, target_path)
        .await
        .map(Some)
}

#[tauri::command]
pub async fn sftp_cancel(
    transfer_id: String,
    state: State<'_, BackendState>,
) -> AppResult<TransferSummary> {
    state.cancel_transfer(&transfer_id).await
}

#[tauri::command]
pub async fn sftp_retry(
    transfer_id: String,
    state: State<'_, BackendState>,
) -> AppResult<TransferSummary> {
    state.retry_transfer(&transfer_id).await
}

#[tauri::command]
pub async fn monitor_sample(
    session_id: String,
    state: State<'_, BackendState>,
) -> AppResult<MonitorSample> {
    state.sample_monitor(&session_id).await
}

#[tauri::command]
pub async fn updates_install<R: Runtime>(
    expected_version: String,
    app: AppHandle<R>,
    state: State<'_, BackendState>,
) -> AppResult<UpdateInstallResult> {
    validate_expected_update_version(&expected_version)?;
    let updater = app.updater().map_err(|_| {
        AppError::new(
            "UPDATE_INITIALIZE_FAILED",
            "无法初始化更新服务，请重新打开客户端后再试。",
        )
    })?;
    let update = updater.check().await.map_err(|_| {
        AppError::new(
            "UPDATE_CHECK_FAILED",
            "安装前重新检查更新失败，请稍后重试。",
        )
    })?;
    let update = update.ok_or_else(|| {
        AppError::new(
            "UPDATE_NOT_AVAILABLE",
            "当前没有可安装的更新，请重新检查版本。",
        )
    })?;
    if update.version != expected_version {
        return Err(AppError::new(
            "UPDATE_VERSION_CHANGED",
            "可用更新版本已经变化，请重新检查并下载。",
        ));
    }

    // `download` verifies the signed package in Rust. Only verified bytes may
    // close SSH sessions and acquire the install/shutdown operation gate.
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|_| {
        AppError::new(
            "UPDATE_DOWNLOAD_FAILED",
            "安装包下载或签名校验失败，请重新检查更新。",
        )
    })?;
    state.prepare_update_install().await?;
    if update.install(&bytes).is_err() {
        // Windows install success exits the process. A returned error means
        // the installer did not start, so the update-owned block is released.
        state.release_update_install().await;
        return Err(AppError::new(
            "UPDATE_INSTALL_FAILED",
            "无法启动更新安装，远程操作已恢复，请稍后重试。",
        ));
    }
    Ok(UpdateInstallResult { installing: true })
}

fn validate_expected_update_version(value: &str) -> AppResult<()> {
    let length = value.chars().count();
    if value.trim() != value || length == 0 || length > 128 || value.chars().any(char::is_control) {
        return Err(AppError::new("INVALID_INPUT", "待安装更新版本格式不正确。"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_expected_update_version;

    #[test]
    fn expected_update_version_rejects_ambiguous_input() {
        assert!(validate_expected_update_version("0.2.1").is_ok());
        assert_eq!(
            validate_expected_update_version(" 0.2.1").unwrap_err().code,
            "INVALID_INPUT"
        );
        assert_eq!(
            validate_expected_update_version("0.2.1\n")
                .unwrap_err()
                .code,
            "INVALID_INPUT"
        );
    }
}
