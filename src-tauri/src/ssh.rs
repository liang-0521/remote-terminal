use crate::error::{AppError, AppResult};
use bytes::Bytes;
use chrono::{DateTime, SecondsFormat, Utc};
use russh::{
    client,
    keys::ssh_key::{HashAlg, PublicKey},
    ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Disconnect,
};
use russh_sftp::{
    client::{error::Error as SftpError, SftpSession},
    protocol::{FileAttributes, FileType, OpenFlags, StatusCode},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::SeekFrom,
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Emitter};
use tokio::{
    fs::{File, OpenOptions},
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::{Mutex, Notify, RwLock, Semaphore},
    time::timeout,
};
use uuid::Uuid;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const HOST_PROBE_TIMEOUT: Duration = Duration::from_secs(12);
const SHELL_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const SFTP_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const EXEC_TIMEOUT: Duration = Duration::from_secs(8);
const EXEC_OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
const TERMINAL_BUFFER_LIMIT: usize = 2 * 1024 * 1024;
const TERMINAL_WRITE_LIMIT: usize = 65_536;
const MAX_TRANSFER_CONCURRENCY: usize = 3;
const MAX_UPLOAD_FILES: usize = 100;
const MAX_REMOTE_PATH_LENGTH: usize = 4096;
const MAX_WINDOWS_FILE_NAME_UTF16: usize = 255;
const MAX_COMPLETION_COMMANDS: usize = 10_000;
const DOWNLOAD_BUFFER_SIZE: usize = 64 * 1024;
const REMOTE_TEXT_READ_LIMIT: u64 = 1024 * 1024;
const REMOTE_TEXT_WRITE_LIMIT: usize = 2 * 1024 * 1024;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);
const COMMANDS_MARKER: &str = "@@REMOTE_TERMINAL:COMMANDS@@";

const COMPLETION_CATALOG_COMMAND: &str = r#"export LC_ALL=C
printf '%s\n' '@@REMOTE_TERMINAL:COMMANDS@@'
if command -v bash >/dev/null 2>&1; then
  bash --noprofile --norc -c 'compgen -c'
else
  old_ifs=$IFS
  IFS=:
  for directory in $PATH; do
    [ -d "$directory" ] || continue
    for executable in "$directory"/*; do
      [ -f "$executable" ] && [ -x "$executable" ] && basename "$executable"
    done
  done
  IFS=$old_ifs
fi"#;

pub trait SshEventSink: Send + Sync {
    fn emit(&self, event: &str, payload: Value) -> AppResult<()>;
}

struct TauriEventSink {
    app: AppHandle,
}

impl SshEventSink for TauriEventSink {
    fn emit(&self, event: &str, payload: Value) -> AppResult<()> {
        self.app.emit(event, payload).map_err(|_| {
            AppError::new(
                "NATIVE_EVENT_EMIT_FAILED",
                format!("无法发送原生事件 {event}。"),
            )
        })
    }
}

#[derive(Clone)]
pub struct SshManager {
    inner: Arc<SshInner>,
}

struct SshInner {
    events: Arc<dyn SshEventSink>,
    sessions: RwLock<HashMap<String, Arc<SshSession>>>,
    transfers: RwLock<HashMap<String, Transfer>>,
    download_cache_directory: PathBuf,
    cached_downloads: RwLock<HashMap<String, CachedDownload>>,
}

struct SshSession {
    id: String,
    connection_id: String,
    client: Mutex<client::Handle<HostKeyVerifier>>,
    shell: Arc<ChannelWriteHalf<client::Msg>>,
    terminal: Mutex<TerminalBuffer>,
    sftp: Mutex<Option<Arc<SftpSession>>>,
    transfer_slots: Arc<Semaphore>,
    closing: AtomicBool,
}

#[derive(Default)]
struct TerminalBuffer {
    attached: bool,
    chunks: Vec<Vec<u8>>,
    bytes: usize,
}

#[derive(Clone, Debug)]
struct HostKeyVerifier {
    expected_fingerprint: Option<String>,
    observation: Arc<StdMutex<Option<HostKeyObservation>>>,
}

impl client::Handler for HostKeyVerifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let observed = host_key_observation(server_public_key);
        let accepted = self
            .expected_fingerprint
            .as_ref()
            .is_none_or(|expected| expected == &observed.fingerprint);
        *self
            .observation
            .lock()
            .map_err(|_| russh::Error::Inconsistent)? = Some(observed);
        Ok(accepted)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyObservation {
    pub algorithm: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnection {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDimensions {
    pub cols: u32,
    pub rows: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub session_id: String,
    pub connection_id: String,
    pub home: Option<String>,
    pub sftp_error: Option<AppError>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferState {
    Queued,
    Uploading,
    Cancelling,
    Finalizing,
    Success,
    Failed,
    Cancelled,
}

impl TransferState {
    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Uploading | Self::Cancelling | Self::Finalizing
        )
    }

    fn is_retryable(self) -> bool {
        matches!(self, Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone)]
struct Transfer {
    id: String,
    session_id: String,
    connection_id: String,
    local_path: Option<PathBuf>,
    file_name: String,
    target: String,
    overwrite: bool,
    temporary_path: Option<String>,
    size: u64,
    transferred: u64,
    speed: f64,
    state: TransferState,
    error: Option<AppError>,
    attempt_id: String,
    cancellation: Arc<Cancellation>,
}

#[derive(Default)]
struct Cancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

impl Cancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    async fn cancelled(&self) {
        loop {
            if self.is_cancelled() {
                return;
            }
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSummary {
    pub id: String,
    pub session_id: String,
    pub connection_id: String,
    pub file_name: String,
    pub target: String,
    pub size: u64,
    pub transferred: u64,
    pub speed: f64,
    pub progress: f64,
    pub state: TransferState,
    pub error: Option<AppError>,
}

impl From<&Transfer> for TransferSummary {
    fn from(transfer: &Transfer) -> Self {
        let progress = if transfer.size == 0 {
            if transfer.state == TransferState::Success {
                100.0
            } else {
                0.0
            }
        } else {
            ((transfer.transferred as f64 / transfer.size as f64) * 100.0).min(100.0)
        };
        Self {
            id: transfer.id.clone(),
            session_id: transfer.session_id.clone(),
            connection_id: transfer.connection_id.clone(),
            file_name: transfer.file_name.clone(),
            target: transfer.target.clone(),
            size: transfer.size,
            transferred: transfer.transferred,
            speed: transfer.speed,
            progress,
            state: transfer.state,
            error: transfer.error.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadFile {
    pub local_path: String,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedDownload {
    pub cache_id: String,
    pub session_id: String,
    pub remote_path: String,
    pub file_name: String,
    #[serde(skip_serializing)]
    pub local_path: String,
    pub size: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedDownloadRelease {
    pub released: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressEvent {
    pub id: String,
    pub session_id: String,
    pub connection_id: String,
    pub file_name: String,
    pub target: String,
    pub size: u64,
    pub transferred: u64,
    pub speed: f64,
    pub progress: f64,
}

#[derive(Clone, Debug)]
struct DownloadCachePaths {
    directory: PathBuf,
    partial: PathBuf,
    completed: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub entries: Vec<DirectoryEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub size: u64,
    pub modified_at: Option<String>,
    pub permissions: String,
    pub owner: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTextChunk {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub offset: u64,
    pub next_offset: u64,
    pub modified_at: Option<String>,
    pub truncated: bool,
    pub reset: bool,
    pub encoding_lossy: bool,
    pub editable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTextWriteResult {
    pub path: String,
    pub size: u64,
    pub modified_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntryRemoval {
    pub path: String,
    pub entry_type: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntryRename {
    pub source_path: String,
    pub target_path: String,
    pub entry_type: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntryCreation {
    pub path: String,
    pub entry_type: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionItem {
    pub command: String,
    pub source: String,
}

#[derive(Debug)]
struct RemoteCompletionSource {
    commands: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalDataEvent {
    session_id: String,
    data: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStateEvent {
    session_id: String,
    connection_id: String,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<AppError>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachResult {
    pub session_id: String,
    pub initial_data: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectResult {
    pub disconnected: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferActivity {
    pub active: bool,
    pub active_count: usize,
}

impl SshManager {
    pub fn new(app: AppHandle, download_cache_directory: PathBuf) -> AppResult<Self> {
        Self::with_event_sink(Arc::new(TauriEventSink { app }), download_cache_directory)
    }

    pub fn with_event_sink(
        events: Arc<dyn SshEventSink>,
        download_cache_directory: PathBuf,
    ) -> AppResult<Self> {
        prepare_download_cache_directory(&download_cache_directory)?;
        Ok(Self {
            inner: Arc::new(SshInner {
                events,
                sessions: RwLock::new(HashMap::new()),
                transfers: RwLock::new(HashMap::new()),
                download_cache_directory,
                cached_downloads: RwLock::new(HashMap::new()),
            }),
        })
    }

    pub async fn inspect_host(&self, connection: &SshConnection) -> AppResult<HostKeyObservation> {
        validate_connection(connection)?;
        let observation = Arc::new(StdMutex::new(None));
        let verifier = HostKeyVerifier {
            expected_fingerprint: None,
            observation: observation.clone(),
        };
        let connect = client::connect(
            client_config(),
            (connection.host.clone(), connection.port),
            verifier,
        );
        let handle = match timeout(HOST_PROBE_TIMEOUT, connect).await {
            Ok(Ok(handle)) => handle,
            Ok(Err(error)) => return Err(map_connection_error(error, None, None)),
            Err(_) => {
                return Err(AppError::new(
                    "HOST_PROBE_TIMEOUT",
                    "获取服务器主机指纹超时。",
                ))
            }
        };
        let observed = observation
            .lock()
            .map_err(|_| AppError::new("NATIVE_STATE_FAILED", "主机指纹状态锁不可用。"))?
            .clone()
            .ok_or_else(|| {
                AppError::new("HOST_PROBE_FAILED", "服务器在返回主机指纹前关闭了连接。")
            })?;
        handle
            .disconnect(Disconnect::ByApplication, "host key probe complete", "")
            .await
            .map_err(|_| {
                AppError::new(
                    "HOST_PROBE_CLOSE_FAILED",
                    "已取得主机指纹，但关闭探测连接失败。",
                )
            })?;
        Ok(observed)
    }

    pub async fn connect(
        &self,
        connection: SshConnection,
        expected_fingerprint: String,
        password: String,
        dimensions: TerminalDimensions,
    ) -> AppResult<ConnectResult> {
        validate_connection(&connection)?;
        validate_fingerprint(&expected_fingerprint)?;
        validate_password(&password)?;
        validate_dimensions(dimensions)?;

        let observation = Arc::new(StdMutex::new(None));
        let verifier = HostKeyVerifier {
            expected_fingerprint: Some(expected_fingerprint.clone()),
            observation: observation.clone(),
        };
        let connect = client::connect(
            client_config(),
            (connection.host.clone(), connection.port),
            verifier,
        );
        let mut handle = match timeout(CONNECT_TIMEOUT, connect).await {
            Ok(Ok(handle)) => handle,
            Ok(Err(error)) => {
                let observed = observation
                    .lock()
                    .map_err(|_| AppError::new("NATIVE_STATE_FAILED", "主机指纹状态锁不可用。"))?
                    .clone();
                return Err(map_connection_error(
                    error,
                    observed.as_ref(),
                    Some(&expected_fingerprint),
                ));
            }
            Err(_) => {
                return Err(AppError::new(
                    "NETWORK_FAILED",
                    "连接服务器超时，请检查地址、端口和网络。",
                ))
            }
        };

        let authentication = timeout(
            CONNECT_TIMEOUT,
            handle.authenticate_password(connection.username.clone(), password),
        )
        .await;
        match authentication {
            Ok(Ok(client::AuthResult::Success)) => {}
            Ok(Ok(client::AuthResult::Failure { .. })) => {
                if handle
                    .disconnect(Disconnect::ByApplication, "authentication rejected", "")
                    .await
                    .is_err()
                {
                    report_background_transport_error("关闭认证失败的 SSH 连接");
                }
                return Err(AppError::new("AUTH_FAILED", "用户名或密码验证失败。"));
            }
            Ok(Err(error)) => {
                let mapped = map_connection_error(
                    error,
                    observation
                        .lock()
                        .map_err(|_| {
                            AppError::new("NATIVE_STATE_FAILED", "主机指纹状态锁不可用。")
                        })?
                        .as_ref(),
                    Some(&expected_fingerprint),
                );
                if handle
                    .disconnect(Disconnect::ByApplication, "authentication failed", "")
                    .await
                    .is_err()
                {
                    report_background_transport_error("关闭认证异常的 SSH 连接");
                }
                return Err(mapped);
            }
            Err(_) => {
                if handle
                    .disconnect(Disconnect::ByApplication, "authentication timed out", "")
                    .await
                    .is_err()
                {
                    report_background_transport_error("关闭认证超时的 SSH 连接");
                }
                return Err(AppError::new("AUTH_TIMEOUT", "SSH 密码认证超时。"));
            }
        }

        let channel = timeout(SHELL_OPEN_TIMEOUT, handle.channel_open_session())
            .await
            .map_err(|_| AppError::new("SHELL_OPEN_TIMEOUT", "打开交互终端超时。"))?
            .map_err(|_| AppError::new("SHELL_OPEN_FAILED", "SSH 已连接，但无法打开交互终端。"))?;
        channel
            .request_pty(
                true,
                "xterm-256color",
                dimensions.cols,
                dimensions.rows,
                0,
                0,
                &[],
            )
            .await
            .map_err(|_| AppError::new("PTY_OPEN_FAILED", "SSH 已连接，但服务器拒绝分配 PTY。"))?;
        channel.request_shell(true).await.map_err(|_| {
            AppError::new(
                "SHELL_OPEN_FAILED",
                "SSH 已连接，但服务器拒绝打开交互 Shell。",
            )
        })?;

        let session_id = Uuid::new_v4().to_string();
        let (reader, writer) = channel.split();
        let session = Arc::new(SshSession {
            id: session_id.clone(),
            connection_id: connection.id.clone(),
            client: Mutex::new(handle),
            shell: Arc::new(writer),
            terminal: Mutex::new(TerminalBuffer::default()),
            sftp: Mutex::new(None),
            transfer_slots: Arc::new(Semaphore::new(MAX_TRANSFER_CONCURRENCY)),
            closing: AtomicBool::new(false),
        });
        self.inner
            .sessions
            .write()
            .await
            .insert(session_id.clone(), session.clone());

        let reader_manager = self.clone();
        let reader_session = session.clone();
        tokio::spawn(async move {
            reader_manager
                .drive_terminal_reader(reader_session, reader)
                .await;
        });

        let (home, sftp_error) = match self.get_sftp(&session).await {
            Ok(sftp) => match timeout(Duration::from_secs(8), sftp.canonicalize(".")).await {
                Ok(Ok(path)) => match normalize_remote_path(&path) {
                    Ok(path) => (Some(path), None),
                    Err(error) => (None, Some(error)),
                },
                Ok(Err(_)) => (
                    None,
                    Some(AppError::new(
                        "SFTP_HOME_FAILED",
                        "SFTP 已启用，但无法获取远程主目录。",
                    )),
                ),
                Err(_) => (
                    None,
                    Some(AppError::new("SFTP_HOME_TIMEOUT", "获取远程主目录超时。")),
                ),
            },
            Err(error) => (None, Some(error)),
        };

        if let Err(error) = self.emit(
            "session-state",
            &SessionStateEvent {
                session_id: session_id.clone(),
                connection_id: connection.id.clone(),
                state: "connected".to_string(),
                expected: None,
                error: None,
            },
        ) {
            report_background_error("发送 SSH 已连接状态", &error);
        }

        Ok(ConnectResult {
            session_id,
            connection_id: connection.id,
            home,
            sftp_error,
        })
    }

    pub async fn disconnect(&self, session_id: &str) -> AppResult<DisconnectResult> {
        let id = validate_id(session_id, "会话标识")?;
        let Some(session) = self.inner.sessions.read().await.get(&id).cloned() else {
            return Ok(DisconnectResult {
                disconnected: false,
            });
        };
        session.closing.store(true, Ordering::SeqCst);
        self.cancel_session_transfers(&id).await;
        session
            .shell
            .close()
            .await
            .map_err(|_| AppError::new("SESSION_CLOSE_FAILED", "无法关闭远程终端通道。"))?;
        session
            .client
            .lock()
            .await
            .disconnect(Disconnect::ByApplication, "user disconnected", "")
            .await
            .map_err(|_| AppError::new("SESSION_CLOSE_FAILED", "无法关闭 SSH 连接。"))?;
        Ok(DisconnectResult { disconnected: true })
    }

    pub async fn disconnect_all(&self) -> Vec<AppError> {
        let ids = self
            .inner
            .sessions
            .read()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut errors = Vec::new();
        for id in ids {
            if let Err(error) = self.disconnect(&id).await {
                errors.push(error);
            }
        }
        errors
    }

    pub async fn attach_terminal(&self, session_id: &str) -> AppResult<TerminalAttachResult> {
        let session = self.session(session_id).await?;
        let mut terminal = session.terminal.lock().await;
        let mut initial_data = Vec::with_capacity(terminal.bytes);
        for chunk in terminal.chunks.drain(..) {
            initial_data.extend_from_slice(&chunk);
        }
        terminal.bytes = 0;
        terminal.attached = true;
        Ok(TerminalAttachResult {
            session_id: session.id.clone(),
            initial_data,
        })
    }

    pub async fn write_terminal(&self, session_id: &str, data: &str) -> AppResult<()> {
        let session = self.session(session_id).await?;
        validate_terminal_data(data)?;
        session
            .shell
            .data_bytes(Bytes::copy_from_slice(data.as_bytes()))
            .await
            .map_err(|_| AppError::new("SESSION_CLOSED", "终端会话已经关闭，无法写入。"))
    }

    pub async fn resize_terminal(
        &self,
        session_id: &str,
        dimensions: TerminalDimensions,
    ) -> AppResult<TerminalDimensions> {
        validate_dimensions(dimensions)?;
        let session = self.session(session_id).await?;
        session
            .shell
            .window_change(dimensions.cols, dimensions.rows, 0, 0)
            .await
            .map_err(|_| AppError::new("SESSION_CLOSED", "终端会话已经关闭，无法调整尺寸。"))?;
        Ok(dimensions)
    }

    pub async fn exec(&self, session_id: &str, command: &str) -> AppResult<ExecResult> {
        let session = self.session(session_id).await?;
        validate_exec_command(command)?;
        let operation = async {
            let mut channel = {
                let client = session.client.lock().await;
                client
                    .channel_open_session()
                    .await
                    .map_err(|_| AppError::new("EXEC_OPEN_FAILED", "无法打开远程命令通道。"))?
            };
            channel
                .exec(true, command.as_bytes())
                .await
                .map_err(|_| AppError::new("EXEC_OPEN_FAILED", "服务器拒绝执行远程命令。"))?;

            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let mut code = None;
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        let existing = stdout.len() + stderr.len();
                        append_exec_output(&mut stdout, &data, existing)?;
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        let existing = stdout.len() + stderr.len();
                        append_exec_output(&mut stderr, &data, existing)?;
                    }
                    ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                    ChannelMsg::Eof => {}
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }

            let stdout = String::from_utf8(stdout).map_err(|_| {
                AppError::new(
                    "EXEC_OUTPUT_ENCODING",
                    "远程命令标准输出不是有效的 UTF-8 文本。",
                )
            })?;
            let stderr = String::from_utf8(stderr).map_err(|_| {
                AppError::new(
                    "EXEC_OUTPUT_ENCODING",
                    "远程命令错误输出不是有效的 UTF-8 文本。",
                )
            })?;
            let stderr = stderr.trim().to_string();
            if let Some(nonzero) = code.filter(|value| *value != 0) {
                let message = if stderr.is_empty() {
                    format!("远程命令退出码为 {nonzero}。")
                } else {
                    let excerpt = stderr.chars().take(300).collect::<String>();
                    format!("远程命令失败：{excerpt}")
                };
                return Err(AppError::new("EXEC_NONZERO", message));
            }
            Ok(ExecResult {
                stdout,
                stderr,
                code,
            })
        };

        timeout(EXEC_TIMEOUT, operation)
            .await
            .map_err(|_| AppError::new("EXEC_TIMEOUT", "远程命令执行超时。"))?
    }

    pub async fn list_directory(
        &self,
        session_id: &str,
        remote_path: &str,
    ) -> AppResult<DirectoryListing> {
        let session = self.session(session_id).await?;
        let directory = normalize_remote_path(remote_path)?;
        let sftp = self.get_sftp(&session).await?;
        let read_dir = sftp.read_dir(directory.clone()).await.map_err(|_| {
            AppError::new("SFTP_LIST_FAILED", "无法读取远程目录，请检查路径和权限。")
        })?;
        let mut entries = Vec::new();
        for entry in read_dir {
            let name = entry.file_name();
            if matches!(name.as_str(), "." | "..") {
                continue;
            }
            validate_remote_entry_name(&name)?;
            let metadata = entry.metadata();
            let entry_type = match entry.file_type() {
                FileType::Dir => "directory",
                FileType::File => "file",
                FileType::Symlink => "symlink",
                FileType::Other => "other",
            };
            entries.push(DirectoryEntry {
                name,
                entry_type: entry_type.to_string(),
                size: metadata.len(),
                modified_at: system_time_to_iso(metadata.modified().ok()),
                permissions: format_remote_permissions(&metadata),
                owner: format_remote_owner(&metadata),
            });
        }
        sort_directory_entries(&mut entries);
        Ok(DirectoryListing {
            path: directory,
            entries,
        })
    }

    /// Reads a bounded UTF-8 text window. Initial reads tail files larger than
    /// one MiB; follow-up reads start at the caller's last byte offset so a
    /// growing log never requires downloading the full file again.
    pub async fn read_remote_text(
        &self,
        session_id: &str,
        remote_path: &str,
        offset: Option<u64>,
    ) -> AppResult<RemoteTextChunk> {
        let session = self.session(session_id).await?;
        let path = normalize_remote_path(remote_path)?;
        let sftp = self.get_sftp(&session).await?;
        let metadata = sftp.symlink_metadata(path.clone()).await.map_err(|error| {
            if sftp_not_found(&error) {
                AppError::new("REMOTE_ENTRY_NOT_FOUND", "远程文件已经不存在，请刷新目录。")
            } else {
                AppError::new(
                    "SFTP_TEXT_STAT_FAILED",
                    "无法读取远程文本文件信息，请检查路径和权限。",
                )
            }
        })?;
        if metadata.file_type() != FileType::File {
            return Err(AppError::new(
                "SFTP_TEXT_NOT_FILE",
                "只能预览普通远程文件，目录、符号链接和设备文件暂不支持。",
            ));
        }
        let size = metadata.size.ok_or_else(|| {
            AppError::new(
                "SFTP_TEXT_SIZE_UNKNOWN",
                "服务器没有返回可靠的远程文件大小。",
            )
        })?;
        let reset = offset.is_some_and(|requested| requested > size);
        let start = match offset {
            Some(requested) if requested <= size => requested,
            _ => size.saturating_sub(REMOTE_TEXT_READ_LIMIT),
        };
        let read_limit = size.saturating_sub(start).min(REMOTE_TEXT_READ_LIMIT);
        let mut remote_file = sftp.open(path.clone()).await.map_err(|_| {
            AppError::new(
                "SFTP_TEXT_OPEN_FAILED",
                "无法打开远程文本文件，请检查路径和权限。",
            )
        })?;
        if start > 0 {
            remote_file
                .seek(SeekFrom::Start(start))
                .await
                .map_err(|_| {
                    AppError::new("SFTP_TEXT_SEEK_FAILED", "无法定位远程文本文件的读取位置。")
                })?;
        }
        let mut bytes = Vec::with_capacity(read_limit as usize);
        remote_file
            .take(read_limit)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| AppError::new("SFTP_TEXT_READ_FAILED", "读取远程文本文件失败。"))?;
        if bytes.contains(&0) {
            return Err(AppError::new(
                "REMOTE_FILE_NOT_TEXT",
                "该文件包含二进制内容，不能作为文本预览。",
            ));
        }
        let byte_count = bytes.len() as u64;
        let (content, encoding_lossy) = match String::from_utf8(bytes) {
            Ok(content) => (content, false),
            Err(error) => (String::from_utf8_lossy(error.as_bytes()).into_owned(), true),
        };
        let truncated = start > 0;
        Ok(RemoteTextChunk {
            path,
            content,
            size,
            offset: start,
            next_offset: start.saturating_add(byte_count),
            modified_at: system_time_to_iso(metadata.modified().ok()),
            truncated,
            reset,
            encoding_lossy,
            editable: !truncated && !encoding_lossy && size <= REMOTE_TEXT_WRITE_LIMIT as u64,
        })
    }

    /// Writes only a complete, bounded text document whose size and mtime still
    /// match the preview revision. Growing logs therefore fail closed instead
    /// of silently discarding bytes appended after the editor was opened.
    pub async fn write_remote_text(
        &self,
        session_id: &str,
        remote_path: &str,
        content: &str,
        expected_size: u64,
        expected_modified_at: Option<&str>,
    ) -> AppResult<RemoteTextWriteResult> {
        if content.len() > REMOTE_TEXT_WRITE_LIMIT || content.contains('\0') {
            return Err(AppError::new(
                "REMOTE_TEXT_WRITE_LIMIT",
                "文本内容必须小于 2 MiB，且不能包含空字节。",
            ));
        }
        let session = self.session(session_id).await?;
        let path = normalize_remote_path(remote_path)?;
        let sftp = self.get_sftp(&session).await?;
        let metadata = sftp.symlink_metadata(path.clone()).await.map_err(|error| {
            if sftp_not_found(&error) {
                AppError::new("REMOTE_ENTRY_NOT_FOUND", "远程文件已经不存在，不能保存。")
            } else {
                AppError::new("SFTP_TEXT_STAT_FAILED", "保存前无法校验远程文件状态。")
            }
        })?;
        if metadata.file_type() != FileType::File {
            return Err(AppError::new(
                "SFTP_TEXT_NOT_FILE",
                "远程条目已不再是普通文件，不能保存。",
            ));
        }
        let current_size = metadata.size.ok_or_else(|| {
            AppError::new(
                "SFTP_TEXT_SIZE_UNKNOWN",
                "服务器没有返回可靠的远程文件大小。",
            )
        })?;
        let current_modified_at = system_time_to_iso(metadata.modified().ok());
        if current_size != expected_size
            || expected_modified_at
                .is_some_and(|expected| current_modified_at.as_deref() != Some(expected))
        {
            return Err(AppError::new(
                "REMOTE_FILE_CHANGED",
                "远程文件已在编辑期间变化；为避免覆盖新增内容，本次保存已取消。",
            ));
        }

        let mut remote_file = sftp
            .open_with_flags(path.clone(), OpenFlags::WRITE | OpenFlags::TRUNCATE)
            .await
            .map_err(|_| {
                AppError::new("SFTP_TEXT_WRITE_FAILED", "无法以写入方式打开远程文本文件。")
            })?;
        remote_file
            .write_all(content.as_bytes())
            .await
            .map_err(|_| AppError::new("SFTP_TEXT_WRITE_FAILED", "写入远程文本文件失败。"))?;
        remote_file
            .flush()
            .await
            .map_err(|_| AppError::new("SFTP_TEXT_WRITE_FAILED", "刷新远程文本文件失败。"))?;
        remote_file
            .sync_all()
            .await
            .map_err(|_| AppError::new("SFTP_TEXT_WRITE_FAILED", "同步远程文本文件失败。"))?;
        remote_file
            .shutdown()
            .await
            .map_err(|_| AppError::new("SFTP_TEXT_WRITE_FAILED", "关闭远程文本文件失败。"))?;
        let saved = sftp.symlink_metadata(path.clone()).await.map_err(|_| {
            AppError::new(
                "SFTP_TEXT_VERIFY_FAILED",
                "文本已写入，但无法校验远程文件状态。",
            )
        })?;
        let saved_size = saved.size.unwrap_or(u64::MAX);
        if saved_size != content.len() as u64 {
            return Err(AppError::new(
                "SFTP_TEXT_VERIFY_FAILED",
                "远程文本文件写入后的大小校验失败。",
            ));
        }
        Ok(RemoteTextWriteResult {
            path,
            size: saved_size,
            modified_at: system_time_to_iso(saved.modified().ok()),
        })
    }

    /// Removes exactly one remote entry after re-reading its type through
    /// LSTAT. Directories must be empty; this path never performs recursion.
    pub async fn remove_remote_entry(
        &self,
        session_id: &str,
        remote_path: &str,
        expected_entry_type: &str,
    ) -> AppResult<RemoteEntryRemoval> {
        let session = self.session(session_id).await?;
        let path = normalize_remote_path(remote_path)?;
        if path == "/" {
            return Err(AppError::new(
                "SFTP_DELETE_ROOT_REJECTED",
                "不能删除远程根目录。",
            ));
        }
        let expected_entry_type = validate_removable_entry_type(expected_entry_type)?;
        let sftp = self.get_sftp(&session).await?;
        let metadata = sftp
            .symlink_metadata(path.clone())
            .await
            .map_err(|error| map_remote_delete_stat_error(&error))?;
        let actual_entry_type = removable_entry_type(&metadata)?;
        if actual_entry_type != expected_entry_type {
            return Err(AppError::new(
                "REMOTE_ENTRY_CHANGED",
                "远程条目类型已经变化，请刷新目录并重新确认。",
            ));
        }

        if actual_entry_type == "directory" {
            let mut entries = sftp.read_dir(path.clone()).await.map_err(|_| {
                AppError::new(
                    "SFTP_DELETE_CHECK_FAILED",
                    "无法确认远程目录是否为空，请检查权限后重试。",
                )
            })?;
            if entries.any(|entry| !matches!(entry.file_name().as_str(), "." | "..")) {
                return Err(AppError::new(
                    "REMOTE_DIRECTORY_NOT_EMPTY",
                    "远程目录不是空目录；为避免误删，客户端不会递归删除。",
                ));
            }
            sftp.remove_dir(path.clone()).await.map_err(|_| {
                AppError::new(
                    "SFTP_DELETE_FAILED",
                    "无法删除远程空目录，请检查权限或目录状态。",
                )
            })?;
        } else {
            sftp.remove_file(path.clone()).await.map_err(|error| {
                if sftp_not_found(&error) {
                    AppError::new("REMOTE_ENTRY_NOT_FOUND", "远程文件已经不存在，请刷新目录。")
                } else {
                    AppError::new("SFTP_DELETE_FAILED", "无法删除远程文件，请检查权限。")
                }
            })?;
        }

        Ok(RemoteEntryRemoval {
            path,
            entry_type: actual_entry_type.to_string(),
        })
    }

    /// Renames or moves exactly one remote entry without replacing an
    /// existing target. The source type is re-read through LSTAT before the
    /// operation, and directory moves into their own subtree are rejected.
    pub async fn rename_remote_entry(
        &self,
        session_id: &str,
        source_path: &str,
        target_path: &str,
        expected_entry_type: &str,
    ) -> AppResult<RemoteEntryRename> {
        let session = self.session(session_id).await?;
        let source = normalize_remote_path(source_path)?;
        let target = normalize_remote_path(target_path)?;
        validate_remote_rename_paths(&source, &target)?;
        let expected_entry_type = validate_renamable_entry_type(expected_entry_type)?;
        let sftp = self.get_sftp(&session).await?;

        let source_metadata = sftp
            .symlink_metadata(source.clone())
            .await
            .map_err(|error| map_remote_rename_source_stat_error(&error))?;
        let actual_entry_type = renamable_entry_type(&source_metadata)?;
        if actual_entry_type != expected_entry_type {
            return Err(AppError::new(
                "REMOTE_ENTRY_CHANGED",
                "远程条目类型已经变化，请刷新目录并重新确认。",
            ));
        }
        if actual_entry_type == "directory" && is_remote_descendant(&source, &target) {
            return Err(AppError::new(
                "REMOTE_DIRECTORY_SELF_MOVE",
                "不能把远程目录移动到它自己的子目录中。",
            ));
        }

        assert_remote_rename_target_missing(&sftp, &target).await?;
        assert_remote_rename_parent_directory(&sftp, &target).await?;
        sftp.rename(source.clone(), target.clone())
            .await
            .map_err(|error| {
                if sftp_not_found(&error) {
                    AppError::new(
                        "REMOTE_ENTRY_NOT_FOUND",
                        "远程源条目已经不存在，请刷新目录。",
                    )
                } else {
                    AppError::new(
                        "SFTP_RENAME_FAILED",
                        "无法重命名或移动远程条目，请检查权限和目标状态。",
                    )
                }
            })?;

        Ok(RemoteEntryRename {
            source_path: source,
            target_path: target,
            entry_type: actual_entry_type.to_string(),
        })
    }

    pub async fn create_remote_entry(
        &self,
        session_id: &str,
        directory: &str,
        name: &str,
        entry_type: &str,
    ) -> AppResult<RemoteEntryCreation> {
        let session = self.session(session_id).await?;
        let directory = normalize_remote_path(directory)?;
        validate_file_name(name)?;
        let path = join_remote_path(&directory, name);
        let sftp = self.get_sftp(&session).await?;
        assert_remote_rename_parent_directory(&sftp, &path).await?;
        assert_remote_rename_target_missing(&sftp, &path).await?;
        match entry_type {
            "file" => {
                let mut file = sftp
                    .open_with_flags_and_attributes(
                        path.clone(),
                        OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                        FileAttributes::empty(),
                    )
                    .await
                    .map_err(|_| {
                        AppError::new(
                            "SFTP_CREATE_FILE_FAILED",
                            "无法创建远程文件，请检查目录权限。",
                        )
                    })?;
                file.shutdown().await.map_err(|_| {
                    AppError::new(
                        "SFTP_CREATE_FILE_FAILED",
                        "远程文件已创建，但无法安全关闭文件句柄。",
                    )
                })?;
            }
            "directory" => sftp.create_dir(path.clone()).await.map_err(|_| {
                AppError::new(
                    "SFTP_CREATE_DIRECTORY_FAILED",
                    "无法创建远程文件夹，请检查目录权限。",
                )
            })?,
            _ => {
                return Err(AppError::new(
                    "INVALID_INPUT",
                    "新建类型只能是文件或文件夹。",
                ))
            }
        }
        Ok(RemoteEntryCreation {
            path,
            entry_type: entry_type.to_string(),
        })
    }

    /// Streams one regular remote file into an application-owned cache entry.
    /// The cache entry is registered only after exact-size validation, an
    /// on-disk sync, and a same-directory `.part` -> final atomic rename.
    pub async fn download_to_cache(
        &self,
        session_id: &str,
        remote_path: &str,
        transfer_id: &str,
    ) -> AppResult<CachedDownload> {
        let transfer_id = validate_id(transfer_id, "下载任务标识")?;
        let session = self.session(session_id).await?;
        let remote_path = normalize_remote_path(remote_path)?;
        let file_name = download_file_name(&remote_path)?;
        let _permit = session
            .transfer_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| AppError::new("TRANSFER_QUEUE_FAILED", "文件传输并发队列已经关闭。"))?;
        let sftp = self.get_sftp(&session).await?;
        let metadata = sftp
            .symlink_metadata(remote_path.clone())
            .await
            .map_err(|_| {
                AppError::new(
                    "SFTP_DOWNLOAD_STAT_FAILED",
                    "无法读取远程文件信息，请检查路径和权限。",
                )
            })?;
        let expected_size = validate_download_metadata(&metadata)?;
        let mut remote_file = sftp.open(remote_path.clone()).await.map_err(|_| {
            AppError::new(
                "SFTP_DOWNLOAD_OPEN_FAILED",
                "无法打开远程文件，请检查路径和权限。",
            )
        })?;
        let opened_metadata = remote_file.metadata().await.map_err(|_| {
            AppError::new(
                "SFTP_DOWNLOAD_STAT_FAILED",
                "远程文件已打开，但无法再次校验文件信息。",
            )
        })?;
        let opened_size = validate_download_metadata(&opened_metadata)?;
        if opened_size != expected_size {
            return Err(AppError::new(
                "REMOTE_FILE_CHANGED",
                "下载开始前远程文件大小发生变化，任务已停止。",
            ));
        }

        let (cache_id, cache_paths) =
            create_download_cache_paths(&self.inner.download_cache_directory, &file_name).await?;
        let started_at = Instant::now();
        let mut last_event = Instant::now();
        if let Err(error) = self.emit(
            "download-progress",
            &DownloadProgressEvent {
                id: transfer_id.clone(),
                session_id: session.id.clone(),
                connection_id: session.connection_id.clone(),
                file_name: file_name.clone(),
                target: remote_path.clone(),
                size: expected_size,
                transferred: 0,
                speed: 0.0,
                progress: 0.0,
            },
        ) {
            report_background_error("发送 SFTP 下载初始状态", &error);
        }
        let progress_manager = self.clone();
        let progress_transfer_id = transfer_id.clone();
        let progress_session_id = session.id.clone();
        let progress_connection_id = session.connection_id.clone();
        let progress_file_name = file_name.clone();
        let progress_target = remote_path.clone();
        let mut report_progress = move |transferred: u64| {
            if last_event.elapsed() < PROGRESS_INTERVAL || transferred >= expected_size {
                return;
            }
            let elapsed = started_at.elapsed().as_secs_f64();
            let speed = if elapsed > 0.0 {
                transferred as f64 / elapsed
            } else {
                0.0
            };
            if let Err(error) = progress_manager.emit(
                "download-progress",
                &DownloadProgressEvent {
                    id: progress_transfer_id.clone(),
                    session_id: progress_session_id.clone(),
                    connection_id: progress_connection_id.clone(),
                    file_name: progress_file_name.clone(),
                    target: progress_target.clone(),
                    size: expected_size,
                    transferred,
                    speed,
                    progress: download_progress_percent(transferred, expected_size),
                },
            ) {
                report_background_error("发送 SFTP 下载进度", &error);
            }
            last_event = Instant::now();
        };
        cache_download_reader(
            &mut remote_file,
            expected_size,
            &cache_paths,
            &mut report_progress,
        )
        .await?;
        let elapsed = started_at.elapsed().as_secs_f64();
        if let Err(error) = self.emit(
            "download-progress",
            &DownloadProgressEvent {
                id: transfer_id,
                session_id: session.id.clone(),
                connection_id: session.connection_id.clone(),
                file_name: file_name.clone(),
                target: remote_path.clone(),
                size: expected_size,
                transferred: expected_size,
                speed: if elapsed > 0.0 {
                    expected_size as f64 / elapsed
                } else {
                    0.0
                },
                progress: 100.0,
            },
        ) {
            report_background_error("发送 SFTP 下载完成进度", &error);
        }
        let local_path = windows_path_text(&cache_paths.completed)?;
        let cached = CachedDownload {
            cache_id: cache_id.clone(),
            session_id: session.id.clone(),
            remote_path,
            file_name,
            local_path,
            size: expected_size,
        };
        self.inner
            .cached_downloads
            .write()
            .await
            .insert(cache_id, cached.clone());
        Ok(cached)
    }

    pub async fn cached_download_path(&self, cache_id: &str) -> AppResult<PathBuf> {
        let id = validate_id(cache_id, "下载缓存标识")?;
        let cached = self
            .inner
            .cached_downloads
            .read()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| {
                AppError::new(
                    "DOWNLOAD_CACHE_NOT_FOUND",
                    "下载缓存不存在或已经释放，请重新准备远程文件。",
                )
            })?;
        validate_cached_download(&self.inner.download_cache_directory, &cached).await
    }

    /// Releases only a cache entry returned by this process. Unknown IDs are
    /// idempotent; no caller-provided filesystem path is ever deleted.
    pub async fn release_cached_download(
        &self,
        cache_id: &str,
    ) -> AppResult<CachedDownloadRelease> {
        let id = validate_id(cache_id, "下载缓存标识")?;
        let cached = self.inner.cached_downloads.write().await.remove(&id);
        let Some(cached) = cached else {
            return Ok(CachedDownloadRelease { released: false });
        };
        if let Err(error) =
            release_cached_download_file(&self.inner.download_cache_directory, &cached).await
        {
            self.inner.cached_downloads.write().await.insert(id, cached);
            return Err(error);
        }
        Ok(CachedDownloadRelease { released: true })
    }

    pub async fn upload_files(
        &self,
        session_id: &str,
        remote_directory: &str,
        files: Vec<UploadFile>,
    ) -> AppResult<Vec<TransferSummary>> {
        let session = self.session(session_id).await?;
        let directory = normalize_remote_path(remote_directory)?;
        if files.is_empty() || files.len() > MAX_UPLOAD_FILES {
            return Err(AppError::new(
                "INVALID_INPUT",
                "每次必须选择 1–100 个本地文件。",
            ));
        }
        let sftp = self.get_sftp(&session).await?;
        let mut targets = HashSet::new();
        let mut prepared = Vec::with_capacity(files.len());

        for item in files {
            let local_path = validate_local_path(&item.local_path)?;
            let metadata = tokio::fs::symlink_metadata(&local_path)
                .await
                .map_err(|_| AppError::new("INVALID_LOCAL_FILE", "无法读取本地文件。"))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(AppError::new(
                    "INVALID_LOCAL_FILE",
                    "只能上传普通文件，目录和符号链接暂不支持。",
                ));
            }
            let file_name = local_path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| {
                    AppError::new("INVALID_LOCAL_FILE", "本地文件名不是有效的 Unicode 文本。")
                })?
                .to_string();
            validate_file_name(&file_name)?;
            let target = join_remote_path(&directory, &file_name);
            if !targets.insert(target.clone()) {
                return Err(AppError::new(
                    "DUPLICATE_UPLOAD_TARGET",
                    format!("所选文件中存在同名远程目标：{file_name}"),
                ));
            }
            let id = Uuid::new_v4().to_string();
            let transfer = Transfer {
                id,
                session_id: session.id.clone(),
                connection_id: session.connection_id.clone(),
                local_path: Some(local_path),
                file_name,
                target,
                overwrite: item.overwrite,
                temporary_path: None,
                size: metadata.len(),
                transferred: 0,
                speed: 0.0,
                state: TransferState::Queued,
                error: None,
                attempt_id: Uuid::new_v4().to_string(),
                cancellation: Arc::new(Cancellation::default()),
            };
            prepared.push(transfer);
        }

        {
            let transfers = self.inner.transfers.write().await;
            for transfer in &prepared {
                if transfers.values().any(|existing| {
                    existing.session_id == transfer.session_id
                        && existing.target == transfer.target
                        && existing.state.is_active()
                }) {
                    return Err(AppError::new(
                        "DUPLICATE_UPLOAD_TARGET",
                        format!("该远程目标已有上传任务：{}", transfer.file_name),
                    ));
                }
            }
        }
        for transfer in &mut prepared {
            let availability = if transfer.overwrite {
                assert_remote_target_replaceable(&sftp, &transfer.target)
                    .await
                    .map(|_| ())
            } else {
                assert_remote_target_available(&sftp, &transfer.target).await
            };
            if let Err(error) = availability {
                transfer.state = TransferState::Failed;
                transfer.error = Some(error);
            }
        }
        let summaries = {
            let mut transfers = self.inner.transfers.write().await;
            for transfer in &prepared {
                transfers.insert(transfer.id.clone(), transfer.clone());
            }
            prepared
                .iter()
                .map(TransferSummary::from)
                .collect::<Vec<_>>()
        };
        for transfer in prepared {
            if let Err(error) = self.emit_transfer(&transfer) {
                report_background_error("发送 SFTP 排队状态", &error);
            }
            if transfer.state == TransferState::Queued {
                self.spawn_upload(transfer.id.clone(), transfer.attempt_id.clone());
            }
        }
        Ok(summaries)
    }

    pub async fn cancel_transfer(&self, transfer_id: &str) -> AppResult<TransferSummary> {
        let id = validate_id(transfer_id, "传输标识")?;
        let summary = {
            let mut transfers = self.inner.transfers.write().await;
            let transfer = transfers
                .get_mut(&id)
                .ok_or_else(|| AppError::new("TRANSFER_NOT_FOUND", "未找到该传输任务。"))?;
            match transfer.state {
                TransferState::Queued => {
                    transfer.state = TransferState::Cancelled;
                    transfer.cancellation.cancel();
                }
                TransferState::Uploading => {
                    transfer.state = TransferState::Cancelling;
                    transfer.cancellation.cancel();
                }
                TransferState::Cancelling => {}
                TransferState::Finalizing => {
                    return Err(AppError::new(
                        "TRANSFER_NOT_CANCELLABLE",
                        "传输正在完成远程原子重命名，当前不能取消。",
                    ))
                }
                TransferState::Success | TransferState::Failed | TransferState::Cancelled => {
                    return Err(AppError::new(
                        "TRANSFER_NOT_CANCELLABLE",
                        "该传输任务已经结束，不能取消。",
                    ))
                }
            }
            TransferSummary::from(&*transfer)
        };
        if let Err(error) = self.emit("transfer-progress", &summary) {
            report_background_error("发送 SFTP 取消状态", &error);
        }
        Ok(summary)
    }

    pub async fn retry_transfer(&self, transfer_id: &str) -> AppResult<TransferSummary> {
        let id = validate_id(transfer_id, "传输标识")?;
        let retry_candidate = {
            let transfers = self.inner.transfers.read().await;
            let transfer = transfers
                .get(&id)
                .ok_or_else(|| AppError::new("TRANSFER_NOT_FOUND", "未找到该传输任务。"))?;
            if !transfer.state.is_retryable() || transfer.local_path.is_none() {
                return Err(AppError::new(
                    "TRANSFER_NOT_RETRYABLE",
                    "该传输任务当前不能重试。",
                ));
            }
            transfer.clone()
        };
        let session = self.session(&retry_candidate.session_id).await?;
        let sftp = self.get_sftp(&session).await?;
        if retry_candidate.overwrite {
            assert_remote_target_replaceable(&sftp, &retry_candidate.target).await?;
        } else {
            assert_remote_target_available(&sftp, &retry_candidate.target).await?;
        }

        let (summary, attempt_id) = {
            let mut transfers = self.inner.transfers.write().await;
            if transfers.values().any(|existing| {
                existing.id != id
                    && existing.session_id == retry_candidate.session_id
                    && existing.target == retry_candidate.target
                    && existing.state.is_active()
            }) {
                return Err(AppError::new(
                    "DUPLICATE_UPLOAD_TARGET",
                    format!("该远程目标已有上传任务：{}", retry_candidate.file_name),
                ));
            }
            let transfer = transfers
                .get_mut(&id)
                .ok_or_else(|| AppError::new("TRANSFER_NOT_FOUND", "未找到该传输任务。"))?;
            if !transfer.state.is_retryable() || transfer.local_path.is_none() {
                return Err(AppError::new(
                    "TRANSFER_NOT_RETRYABLE",
                    "该传输任务当前不能重试。",
                ));
            }
            transfer.state = TransferState::Queued;
            transfer.transferred = 0;
            transfer.speed = 0.0;
            transfer.error = None;
            transfer.temporary_path = None;
            transfer.attempt_id = Uuid::new_v4().to_string();
            transfer.cancellation = Arc::new(Cancellation::default());
            (
                TransferSummary::from(&*transfer),
                transfer.attempt_id.clone(),
            )
        };
        if let Err(error) = self.emit("transfer-progress", &summary) {
            report_background_error("发送 SFTP 重试状态", &error);
        }
        self.spawn_upload(id, attempt_id);
        Ok(summary)
    }

    pub async fn transfer_activity(&self) -> TransferActivity {
        let active_count = self
            .inner
            .transfers
            .read()
            .await
            .values()
            .filter(|transfer| transfer.state.is_active())
            .count();
        TransferActivity {
            active: active_count > 0,
            active_count,
        }
    }

    pub async fn active_session_count(&self) -> usize {
        self.inner.sessions.read().await.len()
    }

    pub async fn completion_catalog(&self, session_id: &str) -> AppResult<Vec<CompletionItem>> {
        let output = self.exec(session_id, COMPLETION_CATALOG_COMMAND).await?;
        let source = parse_completion_output(&output.stdout)?;
        Ok(build_completion_items(source))
    }

    async fn session(&self, session_id: &str) -> AppResult<Arc<SshSession>> {
        let id = validate_id(session_id, "会话标识")?;
        self.inner
            .sessions
            .read()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::new("SESSION_CLOSED", "SSH 会话不存在或已经关闭。"))
    }

    async fn get_sftp(&self, session: &Arc<SshSession>) -> AppResult<Arc<SftpSession>> {
        let mut current = session.sftp.lock().await;
        if let Some(sftp) = current.as_ref() {
            return Ok(sftp.clone());
        }
        if session.closing.load(Ordering::SeqCst) {
            return Err(AppError::new("SESSION_CLOSED", "SSH 会话正在关闭。"));
        }
        let channel = {
            let client = session.client.lock().await;
            timeout(SFTP_OPEN_TIMEOUT, client.channel_open_session())
                .await
                .map_err(|_| AppError::new("SFTP_OPEN_TIMEOUT", "打开 SFTP 通道超时。"))?
                .map_err(|_| {
                    AppError::new(
                        "SFTP_OPEN_FAILED",
                        "服务器未启用 SFTP 或当前用户无权打开 SFTP。",
                    )
                })?
        };
        channel.request_subsystem(true, "sftp").await.map_err(|_| {
            AppError::new(
                "SFTP_OPEN_FAILED",
                "服务器未启用 SFTP 或当前用户无权打开 SFTP。",
            )
        })?;
        let sftp = timeout(SFTP_OPEN_TIMEOUT, SftpSession::new(channel.into_stream()))
            .await
            .map_err(|_| AppError::new("SFTP_OPEN_TIMEOUT", "初始化 SFTP 会话超时。"))?
            .map_err(|_| {
                AppError::new(
                    "SFTP_OPEN_FAILED",
                    "服务器未启用 SFTP 或当前用户无权打开 SFTP。",
                )
            })?;
        sftp.set_timeout(10);
        let sftp = Arc::new(sftp);
        *current = Some(sftp.clone());
        Ok(sftp)
    }

    async fn drive_terminal_reader(&self, session: Arc<SshSession>, mut reader: ChannelReadHalf) {
        let mut terminal_error = None;
        while let Some(message) = reader.wait().await {
            let bytes = match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => Some(data),
                ChannelMsg::Close | ChannelMsg::Eof => break,
                _ => None,
            };
            if let Some(bytes) = bytes {
                if let Err(error) = self.forward_terminal_data(&session, &bytes).await {
                    terminal_error = Some(error);
                    break;
                }
            }
        }

        if let Some(error) = terminal_error.clone() {
            if let Err(emit_error) = self.emit(
                "session-state",
                &SessionStateEvent {
                    session_id: session.id.clone(),
                    connection_id: session.connection_id.clone(),
                    state: "error".to_string(),
                    expected: None,
                    error: Some(error),
                },
            ) {
                report_background_error("发送终端错误状态", &emit_error);
            }
            if session
                .client
                .lock()
                .await
                .disconnect(Disconnect::ByApplication, "terminal reader failed", "")
                .await
                .is_err()
            {
                report_background_transport_error("关闭终端读取失败的 SSH 连接");
            }
        }

        let removed = self
            .inner
            .sessions
            .write()
            .await
            .remove(&session.id)
            .is_some();
        if !removed {
            return;
        }
        self.cancel_session_transfers(&session.id).await;
        if let Err(error) = self.emit(
            "session-state",
            &SessionStateEvent {
                session_id: session.id.clone(),
                connection_id: session.connection_id.clone(),
                state: "disconnected".to_string(),
                expected: Some(session.closing.load(Ordering::SeqCst)),
                error: terminal_error,
            },
        ) {
            report_background_error("发送 SSH 断开状态", &error);
        }
    }

    async fn forward_terminal_data(&self, session: &Arc<SshSession>, data: &[u8]) -> AppResult<()> {
        let attached = {
            let mut terminal = session.terminal.lock().await;
            if terminal.attached {
                true
            } else {
                let next_size = terminal.bytes.checked_add(data.len()).ok_or_else(|| {
                    AppError::new(
                        "TERMINAL_BUFFER_LIMIT",
                        "终端初始化输出超过安全上限，会话已关闭。",
                    )
                })?;
                if next_size > TERMINAL_BUFFER_LIMIT {
                    return Err(AppError::new(
                        "TERMINAL_BUFFER_LIMIT",
                        "终端初始化输出超过 2 MiB 安全上限，会话已关闭。",
                    ));
                }
                terminal.bytes = next_size;
                terminal.chunks.push(data.to_vec());
                false
            }
        };
        if attached {
            self.emit(
                "terminal-data",
                &TerminalDataEvent {
                    session_id: session.id.clone(),
                    data: data.to_vec(),
                },
            )?;
        }
        Ok(())
    }

    fn spawn_upload(&self, transfer_id: String, attempt_id: String) {
        let manager = self.clone();
        tokio::spawn(async move {
            if let Err(error) = manager.run_upload(transfer_id, attempt_id).await {
                report_background_error("运行 SFTP 上传任务", &error);
            }
        });
    }

    async fn run_upload(&self, transfer_id: String, attempt_id: String) -> AppResult<()> {
        let snapshot = match self.transfer_for_attempt(&transfer_id, &attempt_id).await {
            Ok(transfer) => transfer,
            Err(error) if error.code == "TRANSFER_SUPERSEDED" => return Ok(()),
            Err(error) => return Err(error),
        };
        if snapshot.cancellation.is_cancelled() {
            self.finish_cancelled(&transfer_id, &attempt_id, None)
                .await?;
            return Ok(());
        }
        let session = match self.session(&snapshot.session_id).await {
            Ok(session) => session,
            Err(error) => {
                self.fail_transfer(&transfer_id, &attempt_id, error, None)
                    .await?;
                return Ok(());
            }
        };

        let permit = tokio::select! {
            _ = snapshot.cancellation.cancelled() => {
                self.finish_cancelled(&transfer_id, &attempt_id, None).await?;
                return Ok(());
            }
            permit = session.transfer_slots.clone().acquire_owned() => match permit {
                Ok(permit) => permit,
                Err(_) => {
                    self.fail_transfer(
                        &transfer_id,
                        &attempt_id,
                        AppError::new("TRANSFER_QUEUE_FAILED", "上传并发队列已经关闭。"),
                        None,
                    ).await?;
                    return Ok(());
                }
            }
        };
        let _permit = permit;

        if snapshot.cancellation.is_cancelled() {
            self.finish_cancelled(&transfer_id, &attempt_id, None)
                .await?;
            return Ok(());
        }
        let result = self
            .perform_upload(&session, &transfer_id, &attempt_id)
            .await;
        if let Err((error, temporary_path)) = result {
            if error.code == "TRANSFER_CANCELLED" {
                self.finish_cancelled(&transfer_id, &attempt_id, temporary_path)
                    .await?;
            } else {
                self.fail_transfer(&transfer_id, &attempt_id, error, temporary_path)
                    .await?;
            }
        }
        Ok(())
    }

    async fn perform_upload(
        &self,
        session: &Arc<SshSession>,
        transfer_id: &str,
        attempt_id: &str,
    ) -> Result<(), (AppError, Option<String>)> {
        let transfer = self
            .transfer_for_attempt(transfer_id, attempt_id)
            .await
            .map_err(|error| (error, None))?;
        if transfer.cancellation.is_cancelled() {
            return Err((AppError::new("TRANSFER_CANCELLED", "传输已取消。"), None));
        }
        let local_path = transfer.local_path.clone().ok_or_else(|| {
            (
                AppError::new("INVALID_LOCAL_FILE", "本地文件路径已不可用。"),
                None,
            )
        })?;
        let sftp = self
            .get_sftp(session)
            .await
            .map_err(|error| (error, None))?;
        if transfer.overwrite {
            assert_remote_target_replaceable(&sftp, &transfer.target)
                .await
                .map_err(|error| (error, None))?;
        } else {
            assert_remote_target_available(&sftp, &transfer.target)
                .await
                .map_err(|error| (error, None))?;
        }

        let temporary_path = join_remote_path(
            remote_parent(&transfer.target),
            &format!(".remote-terminal-{}.part", Uuid::new_v4()),
        );
        let mut remote_file = sftp
            .open_with_flags_and_attributes(
                temporary_path.clone(),
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                FileAttributes::empty(),
            )
            .await
            .map_err(|_| {
                (
                    AppError::new("SFTP_UPLOAD_FAILED", "无法创建远程上传临时文件。"),
                    None,
                )
            })?;
        let mut local_file = File::open(&local_path).await.map_err(|_| {
            (
                AppError::new("INVALID_LOCAL_FILE", "无法打开本地文件。"),
                Some(temporary_path.clone()),
            )
        })?;
        self.update_transfer(transfer_id, attempt_id, |current| {
            current.state = TransferState::Uploading;
            current.temporary_path = Some(temporary_path.clone());
        })
        .await
        .map_err(|error| (error, Some(temporary_path.clone())))?;

        let started_at = Instant::now();
        let mut last_event = Instant::now();
        let mut transferred = 0_u64;
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            if transfer.cancellation.is_cancelled() {
                let close_result = remote_file.shutdown().await;
                if close_result.is_err() {
                    return Err((
                        AppError::new("SFTP_UPLOAD_FAILED", "取消上传时无法关闭远程临时文件。"),
                        Some(temporary_path),
                    ));
                }
                return Err((
                    AppError::new("TRANSFER_CANCELLED", "传输已取消。"),
                    Some(temporary_path),
                ));
            }
            let read = local_file.read(&mut buffer).await.map_err(|_| {
                (
                    AppError::new("LOCAL_FILE_READ_FAILED", "读取本地文件失败。"),
                    Some(temporary_path.clone()),
                )
            })?;
            if read == 0 {
                break;
            }
            tokio::select! {
                _ = transfer.cancellation.cancelled() => {
                    let close_result = remote_file.shutdown().await;
                    if close_result.is_err() {
                        return Err((
                            AppError::new(
                                "SFTP_UPLOAD_FAILED",
                                "取消上传时无法关闭远程临时文件。",
                            ),
                            Some(temporary_path),
                        ));
                    }
                    return Err((
                        AppError::new("TRANSFER_CANCELLED", "传输已取消。"),
                        Some(temporary_path),
                    ));
                }
                result = remote_file.write_all(&buffer[..read]) => {
                    result.map_err(|_| (
                        AppError::new("SFTP_UPLOAD_FAILED", "写入远程临时文件失败。"),
                        Some(temporary_path.clone()),
                    ))?;
                }
            }
            transferred = transferred.checked_add(read as u64).ok_or_else(|| {
                (
                    AppError::new("TRANSFER_SIZE_INVALID", "上传字节计数超出范围。"),
                    Some(temporary_path.clone()),
                )
            })?;
            if transferred > transfer.size {
                return Err((
                    AppError::new(
                        "LOCAL_FILE_CHANGED",
                        "上传期间本地文件大小发生变化，任务已停止。",
                    ),
                    Some(temporary_path),
                ));
            }
            if last_event.elapsed() >= PROGRESS_INTERVAL {
                let elapsed = started_at.elapsed().as_secs_f64().max(0.001);
                self.update_transfer(transfer_id, attempt_id, |current| {
                    current.transferred = transferred;
                    current.speed = transferred as f64 / elapsed;
                })
                .await
                .map_err(|error| (error, Some(temporary_path.clone())))?;
                if let Err(error) = self.emit_transfer_by_id(transfer_id, attempt_id).await {
                    report_background_error("发送 SFTP 上传进度", &error);
                }
                last_event = Instant::now();
            }
        }
        if transferred != transfer.size {
            return Err((
                AppError::new(
                    "LOCAL_FILE_CHANGED",
                    "上传期间本地文件大小发生变化，任务已停止。",
                ),
                Some(temporary_path),
            ));
        }
        remote_file.flush().await.map_err(|_| {
            (
                AppError::new("SFTP_UPLOAD_FAILED", "刷新远程临时文件失败。"),
                Some(temporary_path.clone()),
            )
        })?;
        remote_file.shutdown().await.map_err(|_| {
            (
                AppError::new("SFTP_UPLOAD_FAILED", "关闭远程临时文件失败。"),
                Some(temporary_path.clone()),
            )
        })?;
        if transfer.cancellation.is_cancelled() {
            return Err((
                AppError::new("TRANSFER_CANCELLED", "传输已取消。"),
                Some(temporary_path),
            ));
        }

        let speed = transferred as f64 / started_at.elapsed().as_secs_f64().max(0.001);
        let finalizing = self
            .begin_finalizing(transfer_id, attempt_id, transferred, speed)
            .await
            .map_err(|error| (error, Some(temporary_path.clone())))?;
        if !finalizing {
            return Err((
                AppError::new("TRANSFER_CANCELLED", "传输已取消。"),
                Some(temporary_path),
            ));
        }
        if let Err(error) = self.emit_transfer_by_id(transfer_id, attempt_id).await {
            report_background_error("发送 SFTP 收尾状态", &error);
        }
        let replace_existing = if transfer.overwrite {
            assert_remote_target_replaceable(&sftp, &transfer.target)
                .await
                .map_err(|error| (error, Some(temporary_path.clone())))?
        } else {
            assert_remote_target_available(&sftp, &transfer.target)
                .await
                .map_err(|error| (error, Some(temporary_path.clone())))?;
            false
        };
        if replace_existing {
            let backup_path = join_remote_path(
                remote_parent(&transfer.target),
                &format!(".remote-terminal-backup-{}", Uuid::new_v4()),
            );
            sftp.rename(transfer.target.clone(), backup_path.clone())
                .await
                .map_err(|_| {
                    (
                        AppError::new(
                            "SFTP_OVERWRITE_PREPARE_FAILED",
                            "无法安全备份远程同名文件，覆盖已取消。",
                        ),
                        Some(temporary_path.clone()),
                    )
                })?;
            if sftp
                .rename(temporary_path.clone(), transfer.target.clone())
                .await
                .is_err()
            {
                let restored = sftp
                    .rename(backup_path.clone(), transfer.target.clone())
                    .await
                    .is_ok();
                return Err((
                    AppError::new(
                        "SFTP_OVERWRITE_RENAME_FAILED",
                        if restored {
                            "替换远程文件失败，原文件已恢复。"
                        } else {
                            "替换远程文件失败，且原文件恢复失败，请立即检查远程目录。"
                        },
                    ),
                    Some(temporary_path.clone()),
                ));
            }
            if sftp.remove_file(backup_path).await.is_err() {
                report_background_transport_error("清理覆盖上传的远程备份文件失败");
            }
        } else {
            sftp.rename(temporary_path.clone(), transfer.target.clone())
                .await
                .map_err(|_| {
                    (
                        AppError::new(
                            "SFTP_RENAME_FAILED",
                            "文件已上传，但无法完成远程原子重命名。",
                        ),
                        Some(temporary_path.clone()),
                    )
                })?;
        }

        self.update_transfer(transfer_id, attempt_id, |current| {
            current.state = TransferState::Success;
            current.transferred = current.size;
            current.temporary_path = None;
            current.local_path = None;
            current.error = None;
        })
        .await
        .map_err(|error| (error, None))?;
        if let Err(error) = self.emit_transfer_by_id(transfer_id, attempt_id).await {
            report_background_error("发送 SFTP 完成状态", &error);
        }
        Ok(())
    }

    async fn transfer_for_attempt(
        &self,
        transfer_id: &str,
        attempt_id: &str,
    ) -> AppResult<Transfer> {
        let transfers = self.inner.transfers.read().await;
        let transfer = transfers
            .get(transfer_id)
            .ok_or_else(|| AppError::new("TRANSFER_NOT_FOUND", "未找到该传输任务。"))?;
        if transfer.attempt_id != attempt_id {
            return Err(AppError::new(
                "TRANSFER_SUPERSEDED",
                "传输任务已被新的重试替代。",
            ));
        }
        Ok(transfer.clone())
    }

    async fn update_transfer(
        &self,
        transfer_id: &str,
        attempt_id: &str,
        update: impl FnOnce(&mut Transfer),
    ) -> AppResult<()> {
        let mut transfers = self.inner.transfers.write().await;
        let transfer = transfers
            .get_mut(transfer_id)
            .ok_or_else(|| AppError::new("TRANSFER_NOT_FOUND", "未找到该传输任务。"))?;
        if transfer.attempt_id != attempt_id {
            return Err(AppError::new(
                "TRANSFER_SUPERSEDED",
                "传输任务已被新的重试替代。",
            ));
        }
        update(transfer);
        Ok(())
    }

    /// Atomically decides whether cancellation or remote finalization wins.
    /// `cancel_transfer` uses the same write lock, so an accepted cancellation
    /// can never be overwritten and followed by the remote rename.
    async fn begin_finalizing(
        &self,
        transfer_id: &str,
        attempt_id: &str,
        transferred: u64,
        speed: f64,
    ) -> AppResult<bool> {
        let mut transfers = self.inner.transfers.write().await;
        let transfer = transfers
            .get_mut(transfer_id)
            .ok_or_else(|| AppError::new("TRANSFER_NOT_FOUND", "未找到该传输任务。"))?;
        if transfer.attempt_id != attempt_id {
            return Err(AppError::new(
                "TRANSFER_SUPERSEDED",
                "传输任务已被新的重试替代。",
            ));
        }
        if transfer.cancellation.is_cancelled()
            || matches!(
                transfer.state,
                TransferState::Cancelling | TransferState::Cancelled
            )
        {
            return Ok(false);
        }
        if transfer.state != TransferState::Uploading {
            return Err(AppError::new(
                "TRANSFER_STATE_INVALID",
                "传输状态已变化，不能开始远程原子重命名。",
            ));
        }
        transfer.state = TransferState::Finalizing;
        transfer.transferred = transferred;
        transfer.speed = speed;
        Ok(true)
    }

    async fn emit_transfer_by_id(&self, transfer_id: &str, attempt_id: &str) -> AppResult<()> {
        let transfer = self.transfer_for_attempt(transfer_id, attempt_id).await?;
        self.emit_transfer(&transfer)
    }

    async fn finish_cancelled(
        &self,
        transfer_id: &str,
        attempt_id: &str,
        temporary_path: Option<String>,
    ) -> AppResult<()> {
        let cleanup_error = self
            .cleanup_temporary_file(transfer_id, temporary_path)
            .await;
        self.update_transfer(transfer_id, attempt_id, |transfer| {
            transfer.state = if cleanup_error.is_some() {
                TransferState::Failed
            } else {
                TransferState::Cancelled
            };
            transfer.error = cleanup_error.clone();
            transfer.temporary_path = None;
        })
        .await?;
        self.emit_transfer_by_id(transfer_id, attempt_id).await
    }

    async fn fail_transfer(
        &self,
        transfer_id: &str,
        attempt_id: &str,
        error: AppError,
        temporary_path: Option<String>,
    ) -> AppResult<()> {
        let cleanup_error = self
            .cleanup_temporary_file(transfer_id, temporary_path)
            .await;
        let failure = match cleanup_error {
            Some(cleanup) => AppError::new(
                "SFTP_CLEANUP_FAILED",
                format!("{}；{}", error.message, cleanup.message),
            ),
            None => error,
        };
        self.update_transfer(transfer_id, attempt_id, |transfer| {
            transfer.state = TransferState::Failed;
            transfer.error = Some(failure);
            transfer.temporary_path = None;
        })
        .await?;
        self.emit_transfer_by_id(transfer_id, attempt_id).await
    }

    async fn cleanup_temporary_file(
        &self,
        transfer_id: &str,
        temporary_path: Option<String>,
    ) -> Option<AppError> {
        let temporary_path = temporary_path?;
        let transfer = {
            let transfers = self.inner.transfers.read().await;
            match transfers.get(transfer_id).cloned() {
                Some(transfer) => transfer,
                None => {
                    return Some(AppError::new(
                        "SFTP_CLEANUP_FAILED",
                        "上传未完成，且传输状态已丢失，无法清理远程临时文件。",
                    ))
                }
            }
        };
        let session = match self.session(&transfer.session_id).await {
            Ok(session) => session,
            Err(_) => {
                return Some(AppError::new(
                    "SFTP_CLEANUP_FAILED",
                    "上传未完成，且 SSH 会话已关闭，无法清理远程临时文件。",
                ))
            }
        };
        let sftp = match self.get_sftp(&session).await {
            Ok(sftp) => sftp,
            Err(_) => {
                return Some(AppError::new(
                    "SFTP_CLEANUP_FAILED",
                    "上传未完成，且无法重新打开 SFTP 清理远程临时文件。",
                ))
            }
        };
        match sftp.remove_file(temporary_path).await {
            Ok(()) => None,
            Err(error) if sftp_not_found(&error) => None,
            Err(_) => Some(AppError::new(
                "SFTP_CLEANUP_FAILED",
                "上传未完成，且远程临时文件清理失败。",
            )),
        }
    }

    async fn cancel_session_transfers(&self, session_id: &str) {
        let summaries = {
            let mut transfers = self.inner.transfers.write().await;
            let mut summaries = Vec::new();
            for transfer in transfers
                .values_mut()
                .filter(|item| item.session_id == session_id)
            {
                match transfer.state {
                    TransferState::Queued => {
                        transfer.state = TransferState::Cancelled;
                        transfer.cancellation.cancel();
                        summaries.push(TransferSummary::from(&*transfer));
                    }
                    TransferState::Uploading => {
                        transfer.state = TransferState::Cancelling;
                        transfer.cancellation.cancel();
                        summaries.push(TransferSummary::from(&*transfer));
                    }
                    _ => {}
                }
            }
            summaries
        };
        for summary in summaries {
            if let Err(error) = self.emit("transfer-progress", &summary) {
                report_background_error("发送会话关闭时的传输状态", &error);
            }
        }
    }

    fn emit_transfer(&self, transfer: &Transfer) -> AppResult<()> {
        self.emit("transfer-progress", &TransferSummary::from(transfer))
    }

    fn emit<T: Serialize>(&self, event: &str, payload: &T) -> AppResult<()> {
        let value = serde_json::to_value(payload).map_err(|_| {
            AppError::new(
                "NATIVE_EVENT_SERIALIZE_FAILED",
                format!("无法序列化原生事件 {event}。"),
            )
        })?;
        self.inner.events.emit(event, value)
    }
}

fn report_background_error(context: &str, error: &AppError) {
    eprintln!("[remote-terminal] {context}: {error}");
}

fn report_background_transport_error(context: &str) {
    eprintln!("[remote-terminal] {context}: SSH_TRANSPORT_FAILED");
}

fn client_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    })
}

fn host_key_observation(key: &PublicKey) -> HostKeyObservation {
    HostKeyObservation {
        algorithm: key.algorithm().to_string(),
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
    }
}

fn map_connection_error(
    error: russh::Error,
    observed: Option<&HostKeyObservation>,
    expected: Option<&str>,
) -> AppError {
    if let (Some(observed), Some(expected)) = (observed, expected) {
        if observed.fingerprint != expected {
            return AppError::new(
                "HOST_KEY_MISMATCH",
                "服务器主机指纹与已信任记录不一致，连接已阻断。",
            );
        }
    }
    match error {
        russh::Error::IO(_)
        | russh::Error::ConnectionTimeout
        | russh::Error::HUP
        | russh::Error::KeepaliveTimeout => {
            AppError::new("NETWORK_FAILED", "无法连接服务器，请检查地址、端口和网络。")
        }
        russh::Error::NoCommonAlgo { .. }
        | russh::Error::Kex
        | russh::Error::KexInit
        | russh::Error::WrongServerSig => AppError::new(
            "HANDSHAKE_FAILED",
            "SSH 握手失败，服务器可能不支持当前协商算法。",
        ),
        _ => AppError::new("HANDSHAKE_FAILED", "SSH 握手失败。"),
    }
}

fn validate_connection(connection: &SshConnection) -> AppResult<()> {
    validate_id(&connection.id, "连接标识")?;
    validate_required_string(&connection.host, "主机地址", 253, false)?;
    validate_required_string(&connection.username, "用户名", 128, false)?;
    if connection.port == 0 {
        return Err(AppError::new(
            "INVALID_INPUT",
            "端口必须是 1–65535 的整数。",
        ));
    }
    Ok(())
}

fn validate_required_string(
    value: &str,
    label: &str,
    max_chars: usize,
    allow_whitespace: bool,
) -> AppResult<()> {
    let normalized = value.trim();
    let length = normalized.chars().count();
    if normalized != value || length == 0 || length > max_chars {
        return Err(AppError::new(
            "INVALID_INPUT",
            format!("{label}不能包含首尾空白，长度必须在 1–{max_chars} 个字符之间。"),
        ));
    }
    if contains_control(normalized) {
        return Err(AppError::new(
            "INVALID_INPUT",
            format!("{label}不能包含控制字符。"),
        ));
    }
    if !allow_whitespace && normalized.chars().any(char::is_whitespace) {
        return Err(AppError::new(
            "INVALID_INPUT",
            format!("{label}不能包含空白字符。"),
        ));
    }
    Ok(())
}

fn validate_id(value: &str, label: &str) -> AppResult<String> {
    if value.len() != 36 || Uuid::parse_str(value).is_err() {
        return Err(AppError::new(
            "INVALID_INPUT",
            format!("{label}格式不正确。"),
        ));
    }
    Ok(value.to_ascii_lowercase())
}

fn validate_password(password: &str) -> AppResult<()> {
    if password.is_empty() || password.len() > 4096 {
        return Err(AppError::new(
            "INVALID_INPUT",
            "密码不能为空且不能超过 4096 字节。",
        ));
    }
    Ok(())
}

fn validate_fingerprint(fingerprint: &str) -> AppResult<()> {
    let Some(encoded) = fingerprint.strip_prefix("SHA256:") else {
        return Err(AppError::new(
            "INVALID_INPUT",
            "已信任主机指纹必须使用 SHA256 格式。",
        ));
    };
    if encoded.len() != 43
        || !encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
    {
        return Err(AppError::new("INVALID_INPUT", "已信任主机指纹格式不正确。"));
    }
    Ok(())
}

fn validate_dimensions(dimensions: TerminalDimensions) -> AppResult<()> {
    if !(2..=1000).contains(&dimensions.cols) {
        return Err(AppError::new(
            "INVALID_INPUT",
            "终端列数必须是 2–1000 的整数。",
        ));
    }
    if !(1..=500).contains(&dimensions.rows) {
        return Err(AppError::new(
            "INVALID_INPUT",
            "终端行数必须是 1–500 的整数。",
        ));
    }
    Ok(())
}

fn validate_terminal_data(data: &str) -> AppResult<()> {
    if data.len() > TERMINAL_WRITE_LIMIT {
        return Err(AppError::new(
            "INVALID_INPUT",
            "终端单次输入超过 65,536 字节安全上限。",
        ));
    }
    Ok(())
}

fn validate_exec_command(command: &str) -> AppResult<()> {
    if command.is_empty() || command.len() > 32_768 || command.contains('\0') {
        return Err(AppError::new(
            "INVALID_INPUT",
            "远程命令格式不正确或长度超过 32,768 字节。",
        ));
    }
    Ok(())
}

fn normalize_remote_path(value: &str) -> AppResult<String> {
    if value.is_empty()
        || value.len() > MAX_REMOTE_PATH_LENGTH
        || contains_control(value)
        || !value.starts_with('/')
    {
        return Err(AppError::new(
            "INVALID_REMOTE_PATH",
            "远程路径必须是无控制字符的绝对路径，且不能超过 4096 字节。",
        ));
    }
    let mut components = Vec::new();
    for component in value.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                if components.pop().is_none() {
                    return Err(AppError::new(
                        "INVALID_REMOTE_PATH",
                        "远程路径不能越过根目录。",
                    ));
                }
            }
            component => components.push(component),
        }
    }
    if components.is_empty() {
        Ok("/".to_string())
    } else {
        Ok(format!("/{}", components.join("/")))
    }
}

fn validate_local_path(value: &str) -> AppResult<PathBuf> {
    if value.trim() != value
        || value.is_empty()
        || value.encode_utf16().count() > 32_767
        || contains_control(value)
    {
        return Err(AppError::new(
            "INVALID_LOCAL_FILE",
            "本地文件路径格式不正确。",
        ));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(AppError::new(
            "INVALID_LOCAL_FILE",
            "本地文件路径必须是 Windows 绝对路径。",
        ));
    }
    Ok(path)
}

fn validate_file_name(value: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 255
        || contains_control(value)
        || value.contains('/')
        || value.contains('\\')
        || matches!(value, "." | "..")
    {
        return Err(AppError::new(
            "INVALID_LOCAL_FILE",
            "本地文件名不能作为远程上传目标。",
        ));
    }
    Ok(())
}

fn validate_remote_entry_name(value: &str) -> AppResult<()> {
    if value.is_empty() || value.len() > 255 || contains_control(value) || value.contains('/') {
        return Err(AppError::new(
            "SFTP_LIST_INVALID",
            "远程目录包含无法安全展示的文件名。",
        ));
    }
    Ok(())
}

fn validate_removable_entry_type(value: &str) -> AppResult<&str> {
    if matches!(value, "file" | "directory" | "symlink") {
        Ok(value)
    } else {
        Err(AppError::new(
            "INVALID_INPUT",
            "只能删除普通文件、符号链接或空目录。",
        ))
    }
}

fn validate_renamable_entry_type(value: &str) -> AppResult<&str> {
    if matches!(value, "file" | "directory" | "symlink") {
        Ok(value)
    } else {
        Err(AppError::new(
            "INVALID_INPUT",
            "只能重命名或移动普通文件、符号链接或目录。",
        ))
    }
}

fn removable_entry_type(metadata: &FileAttributes) -> AppResult<&'static str> {
    match metadata.file_type() {
        FileType::Dir => Ok("directory"),
        FileType::File => Ok("file"),
        FileType::Symlink => Ok("symlink"),
        FileType::Other => Err(AppError::new(
            "SFTP_DELETE_UNSUPPORTED_TYPE",
            "该远程条目类型不支持删除。",
        )),
    }
}

fn renamable_entry_type(metadata: &FileAttributes) -> AppResult<&'static str> {
    match metadata.file_type() {
        FileType::Dir => Ok("directory"),
        FileType::File => Ok("file"),
        FileType::Symlink => Ok("symlink"),
        FileType::Other => Err(AppError::new(
            "SFTP_RENAME_UNSUPPORTED_TYPE",
            "该远程条目类型不支持重命名或移动。",
        )),
    }
}

fn map_remote_delete_stat_error(error: &SftpError) -> AppError {
    if sftp_not_found(error) {
        AppError::new("REMOTE_ENTRY_NOT_FOUND", "远程条目已经不存在，请刷新目录。")
    } else {
        AppError::new(
            "SFTP_DELETE_STAT_FAILED",
            "无法读取远程条目状态，请检查路径和权限。",
        )
    }
}

fn validate_remote_rename_paths(source: &str, target: &str) -> AppResult<()> {
    if source == "/" || target == "/" {
        return Err(AppError::new(
            "SFTP_RENAME_ROOT_REJECTED",
            "不能重命名或移动远程根目录。",
        ));
    }
    if source == target {
        return Err(AppError::new(
            "SFTP_RENAME_SAME_PATH",
            "远程源路径和目标路径不能相同。",
        ));
    }
    Ok(())
}

fn is_remote_descendant(source: &str, target: &str) -> bool {
    target
        .strip_prefix(source)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

fn map_remote_rename_source_stat_error(error: &SftpError) -> AppError {
    if sftp_not_found(error) {
        AppError::new(
            "REMOTE_ENTRY_NOT_FOUND",
            "远程源条目已经不存在，请刷新目录。",
        )
    } else {
        AppError::new(
            "SFTP_RENAME_SOURCE_STAT_FAILED",
            "无法读取远程源条目状态，请检查路径和权限。",
        )
    }
}

fn contains_control(value: &str) -> bool {
    value.chars().any(|character| character.is_control())
}

fn join_remote_path(directory: &str, name: &str) -> String {
    if directory == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", directory.trim_end_matches('/'))
    }
}

fn remote_parent(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .unwrap_or("/")
}

fn prepare_download_cache_directory(directory: &Path) -> AppResult<()> {
    if !directory.is_absolute() {
        return Err(AppError::new(
            "DOWNLOAD_CACHE_INVALID",
            "下载缓存目录不是有效的 Windows 绝对路径。",
        ));
    }
    fs::create_dir_all(directory).map_err(|_| {
        AppError::new(
            "DOWNLOAD_CACHE_CREATE_FAILED",
            "无法创建应用专用下载缓存目录。",
        )
    })?;
    validate_download_cache_directory(directory)?;
    if cleanup_stale_download_cache(directory).is_err() {
        eprintln!("[remote-terminal] cleanup stale download cache: DOWNLOAD_CACHE_CLEANUP_FAILED");
    }
    Ok(())
}

fn validate_download_cache_directory(directory: &Path) -> AppResult<()> {
    let metadata = fs::symlink_metadata(directory).map_err(|_| {
        AppError::new(
            "DOWNLOAD_CACHE_UNAVAILABLE",
            "应用专用下载缓存目录当前不可用。",
        )
    })?;
    if !metadata.is_dir() || is_local_reparse_point(&metadata) {
        return Err(AppError::new(
            "DOWNLOAD_CACHE_INVALID",
            "应用专用下载缓存目录不是普通本地目录。",
        ));
    }
    Ok(())
}

/// Removes only UUID-named directories previously owned by this cache. Every
/// child is checked as a regular non-reparse file and deleted individually;
/// no recursive or caller-controlled deletion is used.
fn cleanup_stale_download_cache(directory: &Path) -> AppResult<()> {
    let entries = fs::read_dir(directory).map_err(|_| {
        AppError::new(
            "DOWNLOAD_CACHE_CLEANUP_FAILED",
            "无法检查上次运行遗留的下载缓存。",
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|_| {
            AppError::new(
                "DOWNLOAD_CACHE_CLEANUP_FAILED",
                "无法检查上次运行遗留的下载缓存。",
            )
        })?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if Uuid::parse_str(name)
            .ok()
            .is_none_or(|id| id.to_string() != name.to_ascii_lowercase())
        {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| {
            AppError::new(
                "DOWNLOAD_CACHE_CLEANUP_FAILED",
                "无法检查上次运行遗留的下载缓存。",
            )
        })?;
        if !metadata.is_dir() || is_local_reparse_point(&metadata) {
            continue;
        }
        let children = fs::read_dir(&path).map_err(|_| {
            AppError::new(
                "DOWNLOAD_CACHE_CLEANUP_FAILED",
                "无法检查上次运行遗留的下载缓存。",
            )
        })?;
        let mut removable = true;
        for child in children {
            let child = child.map_err(|_| {
                AppError::new(
                    "DOWNLOAD_CACHE_CLEANUP_FAILED",
                    "无法检查上次运行遗留的下载缓存。",
                )
            })?;
            let child_metadata = fs::symlink_metadata(child.path()).map_err(|_| {
                AppError::new(
                    "DOWNLOAD_CACHE_CLEANUP_FAILED",
                    "无法检查上次运行遗留的下载缓存。",
                )
            })?;
            if !child_metadata.is_file() || is_local_reparse_point(&child_metadata) {
                removable = false;
                continue;
            }
            fs::remove_file(child.path()).map_err(|_| {
                AppError::new(
                    "DOWNLOAD_CACHE_CLEANUP_FAILED",
                    "无法清理上次运行遗留的下载缓存文件。",
                )
            })?;
        }
        if removable {
            fs::remove_dir(&path).map_err(|_| {
                AppError::new(
                    "DOWNLOAD_CACHE_CLEANUP_FAILED",
                    "无法清理上次运行遗留的下载缓存目录。",
                )
            })?;
        }
    }
    Ok(())
}

pub(crate) fn download_file_name_for_dialog(remote_path: &str) -> AppResult<String> {
    let normalized = normalize_remote_path(remote_path)?;
    download_file_name(&normalized)
}

fn download_file_name(remote_path: &str) -> AppResult<String> {
    let name = remote_path
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| {
            AppError::new(
                "SFTP_DOWNLOAD_INVALID",
                "只能下载普通远程文件，不能下载根目录。",
            )
        })?;
    validate_windows_download_file_name(name)?;
    Ok(name.to_string())
}

fn validate_windows_download_file_name(value: &str) -> AppResult<()> {
    let invalid_character = value.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
    });
    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let stem_bytes = stem.as_bytes();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem_bytes.len() == 4
            && matches!(&stem_bytes[..3], b"COM" | b"LPT")
            && matches!(stem_bytes[3], b'1'..=b'9'));
    if value.is_empty()
        || value.encode_utf16().count() > MAX_WINDOWS_FILE_NAME_UTF16
        || value.ends_with([' ', '.'])
        || matches!(value, "." | "..")
        || invalid_character
        || reserved
    {
        return Err(AppError::new(
            "SFTP_DOWNLOAD_UNSUPPORTED_NAME",
            "远程文件名不能安全映射为 Windows 本地文件名。",
        ));
    }
    Ok(())
}

fn validate_download_metadata(metadata: &FileAttributes) -> AppResult<u64> {
    if metadata.file_type() != FileType::File {
        return Err(AppError::new(
            "SFTP_DOWNLOAD_NOT_FILE",
            "只能下载普通远程文件，目录、符号链接和设备文件暂不支持。",
        ));
    }
    metadata.size.ok_or_else(|| {
        AppError::new(
            "SFTP_DOWNLOAD_SIZE_UNKNOWN",
            "服务器没有返回可靠的远程文件大小，已拒绝下载。",
        )
    })
}

async fn create_download_cache_paths(
    root: &Path,
    file_name: &str,
) -> AppResult<(String, DownloadCachePaths)> {
    validate_download_cache_directory(root)?;
    for _ in 0..8 {
        let cache_id = Uuid::new_v4().to_string();
        let directory = root.join(&cache_id);
        let partial_name = format!(".remote-terminal-{cache_id}.part");
        let partial = directory.join(partial_name);
        let completed = directory.join(file_name);
        windows_path_text(&partial)?;
        windows_path_text(&completed)?;
        match tokio::fs::create_dir(&directory).await {
            Ok(()) => {
                let metadata = tokio::fs::symlink_metadata(&directory).await.map_err(|_| {
                    AppError::new("DOWNLOAD_CACHE_CREATE_FAILED", "无法验证本次下载缓存目录。")
                })?;
                if !metadata.is_dir() || is_local_reparse_point(&metadata) {
                    return Err(AppError::new(
                        "DOWNLOAD_CACHE_INVALID",
                        "本次下载缓存目录不是普通本地目录。",
                    ));
                }
                return Ok((
                    cache_id,
                    DownloadCachePaths {
                        directory,
                        partial,
                        completed,
                    },
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => {
                return Err(AppError::new(
                    "DOWNLOAD_CACHE_CREATE_FAILED",
                    "无法创建本次下载缓存目录。",
                ))
            }
        }
    }
    Err(AppError::new(
        "DOWNLOAD_CACHE_CREATE_FAILED",
        "无法分配唯一的下载缓存标识。",
    ))
}

async fn cache_download_reader<R>(
    reader: &mut R,
    expected_size: u64,
    paths: &DownloadCachePaths,
    on_progress: &mut impl FnMut(u64),
) -> AppResult<()>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let result = write_download_cache(reader, expected_size, paths, on_progress).await;
    let Err(error) = result else {
        return Ok(());
    };
    match cleanup_download_cache_paths(paths).await {
        Ok(()) => Err(error),
        Err(_) => Err(AppError::new(
            "DOWNLOAD_CACHE_CLEANUP_FAILED",
            format!("{}；本地下载临时缓存清理失败。", error.message),
        )),
    }
}

async fn write_download_cache<R>(
    reader: &mut R,
    expected_size: u64,
    paths: &DownloadCachePaths,
    on_progress: &mut impl FnMut(u64),
) -> AppResult<()>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut local_file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&paths.partial)
        .await
        .map_err(|_| AppError::new("DOWNLOAD_CACHE_WRITE_FAILED", "无法创建本地下载临时文件。"))?;
    let mut buffer = vec![0_u8; DOWNLOAD_BUFFER_SIZE];
    let mut transferred = 0_u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|_| AppError::new("SFTP_DOWNLOAD_READ_FAILED", "读取远程文件失败。"))?;
        if read == 0 {
            break;
        }
        transferred = transferred
            .checked_add(read as u64)
            .ok_or_else(|| AppError::new("SFTP_DOWNLOAD_SIZE_INVALID", "下载字节计数超出范围。"))?;
        if transferred > expected_size {
            return Err(AppError::new(
                "REMOTE_FILE_CHANGED",
                "下载期间远程文件大小发生变化，任务已停止。",
            ));
        }
        local_file.write_all(&buffer[..read]).await.map_err(|_| {
            AppError::new("DOWNLOAD_CACHE_WRITE_FAILED", "写入本地下载临时文件失败。")
        })?;
        on_progress(transferred);
    }
    if transferred != expected_size {
        return Err(AppError::new(
            "REMOTE_FILE_CHANGED",
            "下载期间远程文件大小发生变化，任务已停止。",
        ));
    }
    local_file
        .flush()
        .await
        .map_err(|_| AppError::new("DOWNLOAD_CACHE_WRITE_FAILED", "刷新本地下载临时文件失败。"))?;
    local_file
        .sync_all()
        .await
        .map_err(|_| AppError::new("DOWNLOAD_CACHE_WRITE_FAILED", "同步本地下载临时文件失败。"))?;
    drop(local_file);
    validate_local_cached_file(&paths.partial, expected_size).await?;
    tokio::fs::rename(&paths.partial, &paths.completed)
        .await
        .map_err(|_| {
            AppError::new(
                "DOWNLOAD_CACHE_RENAME_FAILED",
                "远程文件已下载，但无法完成本地原子重命名。",
            )
        })?;
    validate_local_cached_file(&paths.completed, expected_size).await
}

fn download_progress_percent(transferred: u64, expected_size: u64) -> f64 {
    if expected_size == 0 {
        0.0
    } else {
        ((transferred as f64 / expected_size as f64) * 100.0).min(100.0)
    }
}

async fn validate_local_cached_file(path: &Path, expected_size: u64) -> AppResult<()> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| AppError::new("DOWNLOAD_CACHE_VERIFY_FAILED", "无法校验本地下载缓存文件。"))?;
    if !metadata.is_file() || is_local_reparse_point(&metadata) || metadata.len() != expected_size {
        return Err(AppError::new(
            "DOWNLOAD_CACHE_VERIFY_FAILED",
            "本地下载缓存文件校验失败。",
        ));
    }
    Ok(())
}

async fn cleanup_download_cache_paths(paths: &DownloadCachePaths) -> AppResult<()> {
    remove_managed_cache_file(&paths.partial).await?;
    remove_managed_cache_file(&paths.completed).await?;
    match tokio::fs::remove_dir(&paths.directory).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(AppError::new(
            "DOWNLOAD_CACHE_CLEANUP_FAILED",
            "无法清理本次下载缓存目录。",
        )),
    }
}

async fn validate_cached_download(root: &Path, cached: &CachedDownload) -> AppResult<PathBuf> {
    validate_download_cache_directory(root)?;
    let (directory, completed) = cached_download_paths(root, cached)?;
    let directory_metadata = tokio::fs::symlink_metadata(&directory).await.map_err(|_| {
        AppError::new(
            "DOWNLOAD_CACHE_NOT_FOUND",
            "下载缓存不存在或已经释放，请重新准备远程文件。",
        )
    })?;
    if !directory_metadata.is_dir() || is_local_reparse_point(&directory_metadata) {
        return Err(AppError::new(
            "DOWNLOAD_CACHE_STATE_INVALID",
            "下载缓存目录已被替换，已拒绝继续保存。",
        ));
    }
    validate_local_cached_file(&completed, cached.size).await?;

    let canonical_root = tokio::fs::canonicalize(root)
        .await
        .map_err(|_| invalid_cached_download_state())?;
    let canonical_directory = tokio::fs::canonicalize(&directory)
        .await
        .map_err(|_| invalid_cached_download_state())?;
    let canonical_completed = tokio::fs::canonicalize(&completed)
        .await
        .map_err(|_| invalid_cached_download_state())?;
    if canonical_directory.parent() != Some(canonical_root.as_path())
        || canonical_completed.parent() != Some(canonical_directory.as_path())
        || !canonical_completed.starts_with(&canonical_root)
    {
        return Err(invalid_cached_download_state());
    }
    Ok(canonical_completed)
}

fn cached_download_paths(root: &Path, cached: &CachedDownload) -> AppResult<(PathBuf, PathBuf)> {
    let id = Uuid::parse_str(&cached.cache_id).map_err(|_| invalid_cached_download_state())?;
    if id.to_string() != cached.cache_id.to_ascii_lowercase() {
        return Err(invalid_cached_download_state());
    }
    validate_windows_download_file_name(&cached.file_name)
        .map_err(|_| invalid_cached_download_state())?;
    let directory = root.join(&cached.cache_id);
    let completed = directory.join(&cached.file_name);
    if Path::new(&cached.local_path) != completed {
        return Err(invalid_cached_download_state());
    }
    Ok((directory, completed))
}

fn invalid_cached_download_state() -> AppError {
    AppError::new(
        "DOWNLOAD_CACHE_STATE_INVALID",
        "下载缓存状态与应用专用目录不一致，已拒绝操作。",
    )
}

async fn release_cached_download_file(root: &Path, cached: &CachedDownload) -> AppResult<()> {
    validate_download_cache_directory(root)?;
    let (directory, completed) = cached_download_paths(root, cached)?;
    match tokio::fs::symlink_metadata(&directory).await {
        Ok(metadata) if metadata.is_dir() && !is_local_reparse_point(&metadata) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        _ => {
            return Err(AppError::new(
                "DOWNLOAD_CACHE_CLEANUP_FAILED",
                "下载缓存目录已被替换，已拒绝清理。",
            ))
        }
    }
    remove_managed_cache_file(&completed).await?;
    tokio::fs::remove_dir(&directory).await.map_err(|_| {
        AppError::new(
            "DOWNLOAD_CACHE_CLEANUP_FAILED",
            "无法释放已完成的下载缓存目录。",
        )
    })
}

async fn remove_managed_cache_file(path: &Path) -> AppResult<()> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.is_file() && !is_local_reparse_point(&metadata) => {
            tokio::fs::remove_file(path).await.map_err(|_| {
                AppError::new(
                    "DOWNLOAD_CACHE_CLEANUP_FAILED",
                    "无法删除应用专用下载缓存文件。",
                )
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(AppError::new(
            "DOWNLOAD_CACHE_CLEANUP_FAILED",
            "下载缓存文件已被替换，已拒绝清理。",
        )),
    }
}

fn windows_path_text(path: &Path) -> AppResult<String> {
    let value = path.to_str().ok_or_else(|| {
        AppError::new(
            "DOWNLOAD_CACHE_INVALID",
            "下载缓存路径不是有效的 Unicode Windows 路径。",
        )
    })?;
    if !path.is_absolute() || value.encode_utf16().count() > 32_767 {
        return Err(AppError::new(
            "DOWNLOAD_CACHE_INVALID",
            "下载缓存路径超过 Windows 安全长度限制。",
        ));
    }
    Ok(value.to_string())
}

fn is_local_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

async fn assert_remote_target_available(sftp: &SftpSession, target: &str) -> AppResult<()> {
    match sftp.try_exists(target.to_string()).await {
        Ok(false) => Ok(()),
        Ok(true) => Err(AppError::new(
            "REMOTE_FILE_EXISTS",
            format!(
                "远程目标已存在：{}",
                target.rsplit('/').next().unwrap_or(target)
            ),
        )),
        Err(_) => Err(AppError::new(
            "SFTP_STAT_FAILED",
            "无法检查远程目标是否已存在。",
        )),
    }
}

async fn assert_remote_target_replaceable(sftp: &SftpSession, target: &str) -> AppResult<bool> {
    match sftp.symlink_metadata(target.to_string()).await {
        Ok(metadata) if metadata.file_type() == FileType::File => Ok(true),
        Ok(_) => Err(AppError::new(
            "REMOTE_TARGET_NOT_REPLACEABLE",
            "远程同名目标不是普通文件，不能覆盖。",
        )),
        Err(error) if sftp_not_found(&error) => Ok(false),
        Err(_) => Err(AppError::new(
            "SFTP_STAT_FAILED",
            "无法检查远程同名文件是否可安全覆盖。",
        )),
    }
}

async fn assert_remote_rename_target_missing(sftp: &SftpSession, target: &str) -> AppResult<()> {
    match sftp.symlink_metadata(target.to_string()).await {
        Ok(_) => Err(AppError::new(
            "REMOTE_TARGET_EXISTS",
            "远程目标已经存在；为避免覆盖，操作已取消。",
        )),
        Err(error) if sftp_not_found(&error) => Ok(()),
        Err(_) => Err(AppError::new(
            "SFTP_RENAME_TARGET_STAT_FAILED",
            "无法确认远程目标是否存在，请检查路径和权限。",
        )),
    }
}

async fn assert_remote_rename_parent_directory(sftp: &SftpSession, target: &str) -> AppResult<()> {
    let parent = remote_parent(target);
    let metadata = sftp
        .symlink_metadata(parent.to_string())
        .await
        .map_err(|error| {
            if sftp_not_found(&error) {
                AppError::new(
                    "REMOTE_TARGET_PARENT_NOT_FOUND",
                    "远程目标的上级目录不存在，请刷新后重试。",
                )
            } else {
                AppError::new(
                    "SFTP_RENAME_PARENT_STAT_FAILED",
                    "无法读取远程目标上级目录状态，请检查路径和权限。",
                )
            }
        })?;
    if metadata.file_type() != FileType::Dir {
        return Err(AppError::new(
            "REMOTE_TARGET_PARENT_NOT_DIRECTORY",
            "远程目标的上级路径不是目录。",
        ));
    }
    Ok(())
}

fn sftp_not_found(error: &SftpError) -> bool {
    matches!(error, SftpError::Status(status) if status.status_code == StatusCode::NoSuchFile)
}

fn system_time_to_iso(value: Option<SystemTime>) -> Option<String> {
    value.map(|time| DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn format_remote_permissions(metadata: &FileAttributes) -> String {
    let mode = metadata.permissions.unwrap_or_default();
    let file_type = match metadata.file_type() {
        FileType::Dir => 'd',
        FileType::Symlink => 'l',
        FileType::File => '-',
        FileType::Other => '?',
    };
    let mut value = String::with_capacity(10);
    value.push(file_type);
    for (mask, symbol) in [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ] {
        value.push(if mode & mask != 0 { symbol } else { '-' });
    }
    value
}

fn format_remote_owner(metadata: &FileAttributes) -> String {
    let user = metadata
        .user
        .clone()
        .or_else(|| metadata.uid.map(|value| value.to_string()));
    let group = metadata
        .group
        .clone()
        .or_else(|| metadata.gid.map(|value| value.to_string()));
    match (user, group) {
        (Some(user), Some(group)) => format!("{user}/{group}"),
        (Some(user), None) => user,
        (None, Some(group)) => group,
        (None, None) => "—".to_string(),
    }
}

fn sort_directory_entries(entries: &mut [DirectoryEntry]) {
    entries.sort_by(|left, right| {
        let left_directory = left.entry_type != "directory";
        let right_directory = right.entry_type != "directory";
        left_directory
            .cmp(&right_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
}

fn append_exec_output(target: &mut Vec<u8>, data: &[u8], existing: usize) -> AppResult<()> {
    let next_size = existing
        .checked_add(data.len())
        .ok_or_else(|| AppError::new("EXEC_OUTPUT_LIMIT", "远程命令输出超过安全上限。"))?;
    if next_size > EXEC_OUTPUT_LIMIT {
        return Err(AppError::new(
            "EXEC_OUTPUT_LIMIT",
            "远程命令输出超过 2 MiB 安全上限。",
        ));
    }
    target.extend_from_slice(data);
    Ok(())
}

fn parse_completion_output(text: &str) -> AppResult<RemoteCompletionSource> {
    if text.len() > EXEC_OUTPUT_LIMIT {
        return Err(AppError::new(
            "COMPLETION_OUTPUT_LIMIT",
            "远程补全目录输出超过 2 MiB 安全上限。",
        ));
    }
    enum Section {
        Before,
        Commands,
    }
    let mut section = Section::Before;
    let mut saw_commands = false;
    let mut command_names = HashSet::new();
    let mut commands = Vec::new();

    for raw_line in text.lines() {
        let line = raw_line.trim_end_matches('\r');
        match line {
            COMMANDS_MARKER if !saw_commands => {
                saw_commands = true;
                section = Section::Commands;
            }
            COMMANDS_MARKER => {
                return Err(AppError::new(
                    "COMPLETION_CATALOG_INVALID",
                    "远程补全目录包含重复的分区标记。",
                ))
            }
            _ => match section {
                Section::Before => {
                    if !line.trim().is_empty() {
                        return Err(AppError::new(
                            "COMPLETION_CATALOG_INVALID",
                            "远程补全目录在首个分区标记前包含意外输出。",
                        ));
                    }
                }
                Section::Commands => {
                    if is_command_name(line) && command_names.insert(line.to_string()) {
                        if commands.len() >= MAX_COMPLETION_COMMANDS {
                            return Err(AppError::new(
                                "COMPLETION_CATALOG_LIMIT",
                                "远程可执行命令数量超过 10000 条安全上限。",
                            ));
                        }
                        commands.push(line.to_string());
                    }
                }
            },
        }
    }
    if !saw_commands {
        return Err(AppError::new(
            "COMPLETION_CATALOG_INVALID",
            "远程补全目录缺少命令分区标记。",
        ));
    }
    Ok(RemoteCompletionSource { commands })
}

fn is_command_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !contains_control(value)
        && !value.chars().any(char::is_whitespace)
        && !value.contains('/')
        && !value.contains('\\')
}

fn build_completion_items(source: RemoteCompletionSource) -> Vec<CompletionItem> {
    source
        .commands
        .into_iter()
        .map(|command| CompletionItem {
            command,
            source: "remote-command".to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoopEventSink;

    impl SshEventSink for NoopEventSink {
        fn emit(&self, _event: &str, _payload: Value) -> AppResult<()> {
            Ok(())
        }
    }

    fn test_manager() -> (tempfile::TempDir, SshManager) {
        let directory = tempfile::tempdir().unwrap();
        let manager = SshManager::with_event_sink(
            Arc::new(NoopEventSink),
            directory.path().join("download-cache"),
        )
        .unwrap();
        (directory, manager)
    }

    fn test_transfer(state: TransferState) -> Transfer {
        Transfer {
            id: Uuid::new_v4().to_string(),
            session_id: Uuid::new_v4().to_string(),
            connection_id: Uuid::new_v4().to_string(),
            local_path: Some(PathBuf::from(r"C:\test\upload.bin")),
            file_name: "upload.bin".to_string(),
            target: "/tmp/upload.bin".to_string(),
            overwrite: false,
            temporary_path: Some("/tmp/.upload.part".to_string()),
            size: 100,
            transferred: 100,
            speed: 0.0,
            state,
            error: None,
            attempt_id: Uuid::new_v4().to_string(),
            cancellation: Arc::new(Cancellation::default()),
        }
    }

    #[test]
    fn validates_and_normalizes_remote_paths_without_root_escape() {
        assert_eq!(
            normalize_remote_path("/var//www/./app").unwrap(),
            "/var/www/app"
        );
        assert_eq!(
            normalize_remote_path("/var/www/../log").unwrap(),
            "/var/log"
        );
        assert_eq!(normalize_remote_path("/").unwrap(), "/");
        assert_eq!(normalize_remote_path("/var/log ").unwrap(), "/var/log ");
        assert_eq!(
            normalize_remote_path("relative").unwrap_err().code,
            "INVALID_REMOTE_PATH"
        );
        assert_eq!(
            normalize_remote_path("/../../etc").unwrap_err().code,
            "INVALID_REMOTE_PATH"
        );
        assert_eq!(
            normalize_remote_path("/var/\nlog").unwrap_err().code,
            "INVALID_REMOTE_PATH"
        );
    }

    #[test]
    fn rejects_ambiguous_connection_text_and_unsafe_remote_entry_names() {
        assert_eq!(
            validate_required_string(" root", "用户名", 128, false)
                .unwrap_err()
                .code,
            "INVALID_INPUT"
        );
        assert!(validate_remote_entry_name("release 0.2.0.tar.gz").is_ok());
        assert_eq!(
            validate_remote_entry_name("unsafe\nname").unwrap_err().code,
            "SFTP_LIST_INVALID"
        );
    }

    #[test]
    fn remote_delete_accepts_only_explicit_safe_entry_types() {
        assert_eq!(validate_removable_entry_type("file").unwrap(), "file");
        assert_eq!(
            validate_removable_entry_type("directory").unwrap(),
            "directory"
        );
        assert_eq!(
            validate_removable_entry_type("other").unwrap_err().code,
            "INVALID_INPUT"
        );

        let mut directory = FileAttributes::empty();
        directory.set_dir(true);
        assert_eq!(removable_entry_type(&directory).unwrap(), "directory");
        let mut symlink = FileAttributes::empty();
        symlink.set_symlink(true);
        assert_eq!(removable_entry_type(&symlink).unwrap(), "symlink");
    }

    #[test]
    fn remote_rename_rejects_root_same_path_and_directory_self_moves() {
        assert_eq!(
            validate_remote_rename_paths("/", "/home/root")
                .unwrap_err()
                .code,
            "SFTP_RENAME_ROOT_REJECTED"
        );
        assert_eq!(
            validate_remote_rename_paths("/home/root/file", "/home/root/file")
                .unwrap_err()
                .code,
            "SFTP_RENAME_SAME_PATH"
        );
        assert!(is_remote_descendant(
            "/home/root/releases",
            "/home/root/releases/archive"
        ));
        assert!(!is_remote_descendant(
            "/home/root/releases",
            "/home/root/releases-old"
        ));
        assert_eq!(validate_renamable_entry_type("file").unwrap(), "file");
        assert_eq!(
            validate_renamable_entry_type("other").unwrap_err().code,
            "INVALID_INPUT"
        );
    }

    #[test]
    fn download_cache_requires_windows_safe_file_names_and_reliable_metadata() {
        assert_eq!(download_file_name("/var/log/app.log").unwrap(), "app.log");
        assert_eq!(
            download_file_name_for_dialog("/var//log/./app.log").unwrap(),
            "app.log"
        );
        assert_eq!(download_file_name("/var/log/abé").unwrap(), "abé");
        for path in [
            "/var/log/CON",
            "/var/log/com1.txt",
            "/var/log/trailing.",
            "/var/log/unsafe?.txt",
        ] {
            assert_eq!(
                download_file_name(path).unwrap_err().code,
                "SFTP_DOWNLOAD_UNSUPPORTED_NAME"
            );
        }
        assert_eq!(
            download_file_name("/").unwrap_err().code,
            "SFTP_DOWNLOAD_INVALID"
        );

        let mut regular = FileAttributes::empty();
        regular.set_regular(true);
        regular.size = Some(42);
        assert_eq!(validate_download_metadata(&regular).unwrap(), 42);
        regular.size = None;
        assert_eq!(
            validate_download_metadata(&regular).unwrap_err().code,
            "SFTP_DOWNLOAD_SIZE_UNKNOWN"
        );
        let mut symlink = FileAttributes::empty();
        symlink.set_symlink(true);
        symlink.size = Some(42);
        assert_eq!(
            validate_download_metadata(&symlink).unwrap_err().code,
            "SFTP_DOWNLOAD_NOT_FILE"
        );
    }

    #[tokio::test]
    async fn download_cache_commits_exact_bytes_then_releases_only_its_entry() {
        let root = tempfile::tempdir().unwrap();
        let cache_root = root.path().join("download-cache");
        prepare_download_cache_directory(&cache_root).unwrap();
        let bytes = b"streamed remote bytes";
        let (cache_id, paths) = create_download_cache_paths(&cache_root, "app.log")
            .await
            .unwrap();
        let mut reader = bytes.as_slice();
        let mut progress = Vec::new();

        cache_download_reader(
            &mut reader,
            bytes.len() as u64,
            &paths,
            &mut |transferred| progress.push(transferred),
        )
        .await
        .unwrap();

        assert!(!paths.partial.exists());
        assert_eq!(fs::read(&paths.completed).unwrap(), bytes);
        assert_eq!(progress.last().copied(), Some(bytes.len() as u64));
        let cached = CachedDownload {
            cache_id,
            session_id: Uuid::new_v4().to_string(),
            remote_path: "/var/log/app.log".to_string(),
            file_name: "app.log".to_string(),
            local_path: windows_path_text(&paths.completed).unwrap(),
            size: bytes.len() as u64,
        };
        assert!(
            serde_json::to_value(&cached)
                .unwrap()
                .get("localPath")
                .is_none(),
            "WebView must not receive the Rust-owned cache path"
        );
        assert_eq!(
            validate_cached_download(&cache_root, &cached)
                .await
                .unwrap(),
            tokio::fs::canonicalize(&paths.completed).await.unwrap()
        );
        let mut tampered = cached.clone();
        tampered.local_path = root.path().join("outside.log").display().to_string();
        assert_eq!(
            validate_cached_download(&cache_root, &tampered)
                .await
                .unwrap_err()
                .code,
            "DOWNLOAD_CACHE_STATE_INVALID"
        );
        release_cached_download_file(&cache_root, &cached)
            .await
            .unwrap();
        assert!(!paths.directory.exists());
    }

    #[tokio::test]
    async fn download_cache_size_mismatch_removes_part_and_job_directory() {
        let root = tempfile::tempdir().unwrap();
        let cache_root = root.path().join("download-cache");
        prepare_download_cache_directory(&cache_root).unwrap();
        let (_cache_id, paths) = create_download_cache_paths(&cache_root, "changed.bin")
            .await
            .unwrap();
        let mut reader = b"too many bytes".as_slice();

        let error = cache_download_reader(&mut reader, 3, &paths, &mut |_| {})
            .await
            .unwrap_err();

        assert_eq!(error.code, "REMOTE_FILE_CHANGED");
        assert!(!paths.partial.exists());
        assert!(!paths.completed.exists());
        assert!(!paths.directory.exists());
    }

    #[test]
    fn validates_sha256_fingerprint_and_terminal_dimensions() {
        let valid = format!("SHA256:{}", "A".repeat(43));
        assert!(validate_fingerprint(&valid).is_ok());
        assert_eq!(
            validate_fingerprint("MD5:00:11").unwrap_err().code,
            "INVALID_INPUT"
        );
        assert!(validate_dimensions(TerminalDimensions { cols: 80, rows: 24 }).is_ok());
        assert_eq!(
            validate_dimensions(TerminalDimensions { cols: 1, rows: 24 })
                .unwrap_err()
                .code,
            "INVALID_INPUT"
        );
    }

    #[test]
    fn sorts_directories_before_files_with_stable_name_order() {
        let mut entries = vec![
            DirectoryEntry {
                name: "z.log".to_string(),
                entry_type: "file".to_string(),
                size: 1,
                modified_at: None,
                permissions: "-rw-r--r--".to_string(),
                owner: "root/root".to_string(),
            },
            DirectoryEntry {
                name: "Beta".to_string(),
                entry_type: "directory".to_string(),
                size: 0,
                modified_at: None,
                permissions: "drwxr-xr-x".to_string(),
                owner: "root/root".to_string(),
            },
            DirectoryEntry {
                name: "alpha".to_string(),
                entry_type: "directory".to_string(),
                size: 0,
                modified_at: None,
                permissions: "drwxr-xr-x".to_string(),
                owner: "root/root".to_string(),
            },
            DirectoryEntry {
                name: "A.txt".to_string(),
                entry_type: "file".to_string(),
                size: 1,
                modified_at: None,
                permissions: "-rw-r--r--".to_string(),
                owner: "root/root".to_string(),
            },
        ];
        sort_directory_entries(&mut entries);
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "Beta", "A.txt", "z.log"]
        );
    }

    #[test]
    fn transfer_states_define_active_and_retryable_invariants() {
        assert!(TransferState::Queued.is_active());
        assert!(TransferState::Uploading.is_active());
        assert!(TransferState::Cancelling.is_active());
        assert!(TransferState::Finalizing.is_active());
        assert!(!TransferState::Success.is_active());
        assert!(TransferState::Failed.is_retryable());
        assert!(TransferState::Cancelled.is_retryable());
        assert!(!TransferState::Finalizing.is_retryable());
    }

    #[tokio::test]
    async fn accepted_cancellation_cannot_transition_to_finalizing() {
        let (_directory, manager) = test_manager();
        let transfer = test_transfer(TransferState::Uploading);
        let transfer_id = transfer.id.clone();
        let attempt_id = transfer.attempt_id.clone();
        manager
            .inner
            .transfers
            .write()
            .await
            .insert(transfer_id.clone(), transfer);

        let cancelled = manager.cancel_transfer(&transfer_id).await.unwrap();
        assert_eq!(cancelled.state, TransferState::Cancelling);
        assert!(!manager
            .begin_finalizing(&transfer_id, &attempt_id, 100, 10.0)
            .await
            .unwrap());
        assert_eq!(
            manager
                .transfer_for_attempt(&transfer_id, &attempt_id)
                .await
                .unwrap()
                .state,
            TransferState::Cancelling
        );
    }

    #[tokio::test]
    async fn finalizing_transition_makes_later_cancellation_explicitly_fail() {
        let (_directory, manager) = test_manager();
        let transfer = test_transfer(TransferState::Uploading);
        let transfer_id = transfer.id.clone();
        let attempt_id = transfer.attempt_id.clone();
        manager
            .inner
            .transfers
            .write()
            .await
            .insert(transfer_id.clone(), transfer);

        assert!(manager
            .begin_finalizing(&transfer_id, &attempt_id, 100, 10.0)
            .await
            .unwrap());
        assert_eq!(
            manager
                .cancel_transfer(&transfer_id)
                .await
                .unwrap_err()
                .code,
            "TRANSFER_NOT_CANCELLABLE"
        );
        assert_eq!(
            manager
                .transfer_for_attempt(&transfer_id, &attempt_id)
                .await
                .unwrap()
                .state,
            TransferState::Finalizing
        );
    }

    #[test]
    fn completion_script_never_reads_remote_shell_history() {
        let command = COMPLETION_CATALOG_COMMAND.to_ascii_lowercase();
        assert!(command.contains("compgen -c"));
        assert!(command.contains(&COMMANDS_MARKER.to_ascii_lowercase()));
        assert!(!command.contains("history"));
        assert!(!command.contains(".bash_history"));
        assert!(!command.contains(".zsh_history"));
    }

    #[test]
    fn completion_parser_preserves_only_valid_remote_commands() {
        let source = parse_completion_output(&format!(
            "{COMMANDS_MARKER}\nls\ndf\nls\ncat\ninvalid command\nls -lah /var/log\n"
        ))
        .unwrap();
        assert_eq!(source.commands, vec!["ls", "df", "cat"]);

        let items = build_completion_items(source);
        assert_eq!(
            items,
            vec![
                CompletionItem {
                    command: "ls".to_string(),
                    source: "remote-command".to_string(),
                },
                CompletionItem {
                    command: "df".to_string(),
                    source: "remote-command".to_string(),
                },
                CompletionItem {
                    command: "cat".to_string(),
                    source: "remote-command".to_string(),
                },
            ]
        );
        assert!(items.iter().all(|item| item.source == "remote-command"));
    }

    #[test]
    fn completion_parser_rejects_missing_preamble_or_duplicate_marker() {
        assert_eq!(
            parse_completion_output("ls\n").unwrap_err().code,
            "COMPLETION_CATALOG_INVALID"
        );
        assert_eq!(
            parse_completion_output(&format!("unexpected\n{COMMANDS_MARKER}\nls\n"))
                .unwrap_err()
                .code,
            "COMPLETION_CATALOG_INVALID"
        );
        assert_eq!(
            parse_completion_output(&format!("{COMMANDS_MARKER}\nls\n{COMMANDS_MARKER}\ndf\n"))
                .unwrap_err()
                .code,
            "COMPLETION_CATALOG_INVALID"
        );
    }

    #[test]
    fn completion_parser_enforces_catalog_item_limits() {
        let mut output = format!("{COMMANDS_MARKER}\n");
        for index in 0..=MAX_COMPLETION_COMMANDS {
            output.push_str(&format!("command{index}\n"));
        }
        assert_eq!(
            parse_completion_output(&output).unwrap_err().code,
            "COMPLETION_CATALOG_LIMIT"
        );
    }
}
