use crate::{
    credentials::{CredentialRemoval, CredentialStatus, CredentialStore},
    error::{AppError, AppResult},
    monitor::{
        calculate_cpu_usage, calculate_network_rates, parse_counters, parse_snapshot,
        MonitorSnapshot, COUNTER_COMMAND, MONITOR_SNAPSHOT_COMMAND,
    },
    ssh::{
        CompletionItem, ConnectResult, DirectoryListing, DisconnectResult, SshConnection,
        SshManager, TerminalAttachResult, TerminalDimensions, TransferSummary, UploadFile,
    },
    storage::{
        migrate_legacy_electron_data, validate_id, Connection, ConnectionDraft, ConnectionRemoval,
        ConnectionStore, KnownHostDraft, KnownHostsStore,
    },
};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tokio::sync::RwLock as AsyncRwLock;
use uuid::Uuid;

const CONNECTIONS_FILE: &str = "connections.json";
const KNOWN_HOSTS_FILE: &str = "known-hosts.json";
const HOST_KEY_CHALLENGE_LIFETIME: Duration = Duration::from_secs(2 * 60);
const MONITOR_SAMPLE_DELAY: Duration = Duration::from_millis(600);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    pub adapters: Vec<NativeAdapterStatus>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAdapterStatus {
    pub name: String,
    pub ready: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    #[serde(flatten)]
    pub connection: Connection,
    pub has_saved_password: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum HostKeyProbeResult {
    Trusted {
        fingerprint: String,
        algorithm: String,
    },
    Unknown {
        challenge_id: String,
        host: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
        expires_at: String,
    },
    Mismatch {
        host: String,
        port: u16,
        algorithm: String,
        expected_fingerprint: String,
        received_fingerprint: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyAcceptResult {
    pub connection_id: String,
    pub fingerprint: String,
    pub algorithm: String,
}

#[derive(Clone, Debug)]
pub enum CredentialRequest {
    Saved,
    Provided {
        password: String,
        save_after_connect: bool,
    },
}

impl<'de> Deserialize<'de> for CredentialRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct CredentialRequestWire {
            source: String,
            password: Option<String>,
            save_after_connect: Option<bool>,
        }

        let wire = CredentialRequestWire::deserialize(deserializer)?;
        match (wire.source.as_str(), wire.password, wire.save_after_connect) {
            ("saved", None, None) => Ok(Self::Saved),
            ("provided", Some(password), Some(save_after_connect)) => Ok(Self::Provided {
                password,
                save_after_connect,
            }),
            ("saved", _, _) => Err(serde::de::Error::custom(
                "saved credential request cannot contain password fields",
            )),
            ("provided", _, _) => Err(serde::de::Error::custom(
                "provided credential request requires password and saveAfterConnect",
            )),
            _ => Err(serde::de::Error::custom(
                "credential source must be saved or provided",
            )),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshConnectPayload {
    pub connection_id: String,
    pub credential: CredentialRequest,
    pub dimensions: TerminalDimensions,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum CredentialPersistence {
    NotRequested,
    Saved,
    Failed { error: AppError },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectResponse {
    #[serde(flatten)]
    pub connection: ConnectResult,
    pub credential_persistence: CredentialPersistence,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSample {
    #[serde(flatten)]
    pub snapshot: MonitorSnapshot,
    pub sampled_at: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExitPreparation {
    Ready,
    NeedsConfirmation { active_transfer_count: usize },
}

#[derive(Clone, Debug)]
struct HostKeyChallenge {
    connection_id: String,
    host: String,
    port: u16,
    algorithm: String,
    fingerprint: String,
    expires_at: Instant,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
enum OperationBlock {
    Open = 0,
    UpdateInstall = 1,
    Shutdown = 2,
}

/// Single owner for all durable native data and live SSH state.
///
/// The operation gate is the invariant that prevents a new upload or retry
/// from being queued between an updater/exit transfer check and session
/// shutdown. Once shutdown preparation succeeds, new transfers stay blocked.
pub struct BackendState {
    connections: ConnectionStore,
    known_hosts: KnownHostsStore,
    credentials: CredentialStore,
    ssh: SshManager,
    host_key_challenges: Mutex<HashMap<String, HostKeyChallenge>>,
    monitor_sampling: Arc<Mutex<HashSet<String>>>,
    operation_gate: AsyncRwLock<()>,
    operation_block: AtomicU8,
}

impl BackendState {
    /// Runs the one-time v0.1 import before constructing stores that can be
    /// exposed through Tauri state. Electron safeStorage credentials are never
    /// read or copied by the migration layer.
    pub fn initialize(
        app: AppHandle,
        legacy_data_directory: &Path,
        data_directory: PathBuf,
    ) -> AppResult<Self> {
        migrate_legacy_electron_data(legacy_data_directory, &data_directory)?;
        let credentials = CredentialStore::windows()?;
        Ok(Self {
            connections: ConnectionStore::new(data_directory.join(CONNECTIONS_FILE)),
            known_hosts: KnownHostsStore::new(data_directory.join(KNOWN_HOSTS_FILE)),
            credentials,
            ssh: SshManager::new(app),
            host_key_challenges: Mutex::new(HashMap::new()),
            monitor_sampling: Arc::new(Mutex::new(HashSet::new())),
            operation_gate: AsyncRwLock::new(()),
            operation_block: AtomicU8::new(OperationBlock::Open as u8),
        })
    }

    pub fn snapshot(&self) -> BackendStatus {
        BackendStatus {
            adapters: [
                "storage",
                "credentials",
                "ssh",
                "sftp",
                "monitor",
                "updater",
            ]
            .into_iter()
            .map(|name| NativeAdapterStatus {
                name: name.to_string(),
                ready: true,
            })
            .collect(),
        }
    }

    pub fn list_connections(&self) -> AppResult<Vec<ConnectionView>> {
        let connections = self.connections.list()?;
        if let [connection] = connections.as_slice() {
            return Ok(vec![ConnectionView {
                has_saved_password: self.credentials.has_saved_password(&connection.id)?,
                connection: connection.clone(),
            }]);
        }
        let ids = connections
            .iter()
            .map(|connection| connection.id.clone())
            .collect::<Vec<_>>();
        let saved_ids = self
            .credentials
            .saved_ids(&ids)?
            .into_iter()
            .collect::<HashSet<_>>();
        Ok(connections
            .into_iter()
            .map(|connection| ConnectionView {
                has_saved_password: saved_ids.contains(&connection.id),
                connection,
            })
            .collect())
    }

    pub fn save_connection(&self, connection: ConnectionDraft) -> AppResult<Connection> {
        self.connections.save(connection)
    }

    pub fn remove_connection(&self, connection_id: &str) -> AppResult<ConnectionRemoval> {
        let connection = self.connections.get(connection_id)?;
        self.credentials.remove(&connection.id)?;
        self.connections.remove(&connection.id)
    }

    pub fn credential_status(&self) -> CredentialStatus {
        self.credentials.status()
    }

    pub fn remove_credential(&self, connection_id: &str) -> AppResult<CredentialRemoval> {
        let connection = self.connections.get(connection_id)?;
        self.credentials.remove(&connection.id)
    }

    pub async fn probe_host_key(&self, connection_id: &str) -> AppResult<HostKeyProbeResult> {
        let connection = self.connections.get(connection_id)?;
        let observed = self
            .ssh
            .inspect_host(&to_ssh_connection(&connection))
            .await?;
        let known = self.known_hosts.get(&connection.host, connection.port)?;
        if let Some(known) = known {
            if known.fingerprint == observed.fingerprint {
                return Ok(HostKeyProbeResult::Trusted {
                    fingerprint: observed.fingerprint,
                    algorithm: observed.algorithm,
                });
            }
            return Ok(HostKeyProbeResult::Mismatch {
                host: connection.host,
                port: connection.port,
                algorithm: observed.algorithm,
                expected_fingerprint: known.fingerprint,
                received_fingerprint: observed.fingerprint,
            });
        }

        let challenge_id = Uuid::new_v4().to_string();
        let expires_at = Instant::now() + HOST_KEY_CHALLENGE_LIFETIME;
        let expires_at_text = (Utc::now()
            + chrono::Duration::from_std(HOST_KEY_CHALLENGE_LIFETIME)
                .map_err(|_| AppError::new("NATIVE_STATE_FAILED", "无法创建主机指纹确认时限。"))?)
        .to_rfc3339_opts(SecondsFormat::Millis, true);
        let challenge = HostKeyChallenge {
            connection_id: connection.id,
            host: connection.host.clone(),
            port: connection.port,
            algorithm: observed.algorithm.clone(),
            fingerprint: observed.fingerprint.clone(),
            expires_at,
        };
        let mut challenges = self
            .host_key_challenges
            .lock()
            .map_err(|_| AppError::new("NATIVE_STATE_FAILED", "主机指纹确认状态暂时不可用。"))?;
        challenges.retain(|_, candidate| candidate.expires_at > Instant::now());
        challenges.insert(challenge_id.clone(), challenge);
        Ok(HostKeyProbeResult::Unknown {
            challenge_id,
            host: connection.host,
            port: connection.port,
            algorithm: observed.algorithm,
            fingerprint: observed.fingerprint,
            expires_at: expires_at_text,
        })
    }

    pub fn accept_host_key(&self, challenge_id: &str) -> AppResult<HostKeyAcceptResult> {
        let id = validate_id(challenge_id, "指纹确认标识")?;
        let now = Instant::now();
        let challenge = {
            let mut challenges = self.host_key_challenges.lock().map_err(|_| {
                AppError::new("NATIVE_STATE_FAILED", "主机指纹确认状态暂时不可用。")
            })?;
            challenges.retain(|_, candidate| candidate.expires_at > now);
            challenges.remove(&id).ok_or_else(|| {
                AppError::new(
                    "HOST_KEY_CHALLENGE_EXPIRED",
                    "主机指纹确认已过期，请重新连接并再次核对。",
                )
            })?
        };
        let connection = self.connections.get(&challenge.connection_id)?;
        if connection.host != challenge.host || connection.port != challenge.port {
            return Err(AppError::new(
                "HOST_KEY_CHALLENGE_INVALID",
                "连接配置已变化，不能接受旧的主机指纹。",
            ));
        }
        let trusted = self.known_hosts.trust(KnownHostDraft {
            host: challenge.host,
            port: challenge.port,
            algorithm: challenge.algorithm,
            fingerprint: challenge.fingerprint,
        })?;
        Ok(HostKeyAcceptResult {
            connection_id: connection.id,
            fingerprint: trusted.fingerprint,
            algorithm: trusted.algorithm,
        })
    }

    pub async fn connect(&self, payload: SshConnectPayload) -> AppResult<SshConnectResponse> {
        let _guard = self.operation_gate.read().await;
        self.ensure_operations_open()?;
        let connection = self.connections.get(&payload.connection_id)?;
        let trusted = self
            .known_hosts
            .get(&connection.host, connection.port)?
            .ok_or_else(|| {
                AppError::new(
                    "HOST_KEY_UNTRUSTED",
                    "服务器主机指纹尚未确认，请先核对并信任该指纹。",
                )
            })?;
        let (password, requested_persistence) = match payload.credential {
            CredentialRequest::Saved => (self.credentials.get(&connection.id)?, None),
            CredentialRequest::Provided {
                password,
                save_after_connect,
            } => {
                let persist = save_after_connect.then(|| password.clone());
                (password, persist)
            }
        };

        // The live authentication handshake verifies the fingerprint again;
        // neither a previous probe nor a frontend status can bypass this check.
        let result = self
            .ssh
            .connect(
                to_ssh_connection(&connection),
                trusted.fingerprint,
                password,
                payload.dimensions,
            )
            .await?;
        let credential_persistence = match requested_persistence {
            None => CredentialPersistence::NotRequested,
            Some(password) => match self.credentials.save(&connection.id, &password) {
                Ok(_) => CredentialPersistence::Saved,
                Err(error) => CredentialPersistence::Failed { error },
            },
        };
        Ok(SshConnectResponse {
            connection: result,
            credential_persistence,
        })
    }

    pub async fn disconnect(&self, session_id: &str) -> AppResult<DisconnectResult> {
        self.ssh.disconnect(session_id).await
    }

    pub async fn attach_terminal(&self, session_id: &str) -> AppResult<TerminalAttachResult> {
        self.ssh.attach_terminal(session_id).await
    }

    pub async fn write_terminal(&self, session_id: &str, data: &str) -> AppResult<()> {
        self.ssh.write_terminal(session_id, data).await
    }

    pub async fn resize_terminal(
        &self,
        session_id: &str,
        dimensions: TerminalDimensions,
    ) -> AppResult<TerminalDimensions> {
        self.ssh.resize_terminal(session_id, dimensions).await
    }

    pub async fn completion_catalog(&self, session_id: &str) -> AppResult<Vec<CompletionItem>> {
        self.ssh.completion_catalog(session_id).await
    }

    pub async fn list_directory(
        &self,
        session_id: &str,
        path: &str,
    ) -> AppResult<DirectoryListing> {
        self.ssh.list_directory(session_id, path).await
    }

    pub async fn upload_files(
        &self,
        session_id: &str,
        remote_directory: &str,
        files: Vec<UploadFile>,
    ) -> AppResult<Vec<TransferSummary>> {
        let _guard = self.operation_gate.read().await;
        self.ensure_operations_open()?;
        self.ssh
            .upload_files(session_id, remote_directory, files)
            .await
    }

    pub async fn cancel_transfer(&self, transfer_id: &str) -> AppResult<TransferSummary> {
        self.ssh.cancel_transfer(transfer_id).await
    }

    pub async fn retry_transfer(&self, transfer_id: &str) -> AppResult<TransferSummary> {
        let _guard = self.operation_gate.read().await;
        self.ensure_operations_open()?;
        self.ssh.retry_transfer(transfer_id).await
    }

    pub async fn sample_monitor(&self, session_id: &str) -> AppResult<MonitorSample> {
        let id = validate_id(session_id, "会话标识")?;
        let _sampling = MonitorSamplingGuard::start(self.monitor_sampling.clone(), &id)?;
        let first_result = self.ssh.exec(&id, COUNTER_COMMAND).await?;
        let previous = parse_counters(&first_result.stdout).map_err(map_monitor_error)?;
        let started_at = Instant::now();
        let snapshot_future = self.ssh.exec(&id, MONITOR_SNAPSHOT_COMMAND);
        let counter_future = async {
            tokio::time::sleep(MONITOR_SAMPLE_DELAY).await;
            let result = self.ssh.exec(&id, COUNTER_COMMAND).await?;
            AppResult::Ok((result, started_at.elapsed()))
        };
        let (snapshot_result, (second_result, elapsed)) =
            tokio::try_join!(snapshot_future, counter_future)?;
        let current = parse_counters(&second_result.stdout).map_err(map_monitor_error)?;
        let cpu = calculate_cpu_usage(&previous.cpu, &current.cpu).map_err(map_monitor_error)?;
        let network = calculate_network_rates(
            &previous.network,
            &current.network,
            elapsed.as_secs_f64() * 1000.0,
        )
        .map_err(map_monitor_error)?;
        let snapshot =
            parse_snapshot(&snapshot_result.stdout, cpu, &network).map_err(map_monitor_error)?;
        Ok(MonitorSample {
            snapshot,
            sampled_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        })
    }

    pub async fn active_transfer_count(&self) -> usize {
        self.ssh.active_transfers().await.len()
    }

    pub async fn prepare_exit(&self, force: bool) -> ExitPreparation {
        let _guard = self.operation_gate.write().await;
        if !force {
            let active_transfer_count = self.ssh.transfer_activity().await.active_count;
            if active_transfer_count > 0 {
                return ExitPreparation::NeedsConfirmation {
                    active_transfer_count,
                };
            }
        }
        self.operation_block
            .store(OperationBlock::Shutdown as u8, Ordering::SeqCst);
        for error in self.ssh.disconnect_all().await {
            eprintln!("[remote-terminal] disconnect during exit: {}", error.code);
        }
        ExitPreparation::Ready
    }

    pub async fn prepare_update_install(&self) -> AppResult<()> {
        let _guard = self.operation_gate.write().await;
        if self.operation_block.load(Ordering::SeqCst) != OperationBlock::Open as u8 {
            return Err(AppError::new(
                "NATIVE_SHUTDOWN_IN_PROGRESS",
                "客户端正在关闭或准备安装更新，不能重复执行该操作。",
            ));
        }
        let activity = self.ssh.transfer_activity().await;
        if activity.active {
            return Err(AppError::new(
                "UPDATE_BLOCKED_ACTIVE_TRANSFERS",
                format!(
                    "仍有 {} 个文件传输任务未结束，请完成或取消后再安装更新。",
                    activity.active_count
                ),
            ));
        }
        self.operation_block
            .store(OperationBlock::UpdateInstall as u8, Ordering::SeqCst);
        let errors = self.ssh.disconnect_all().await;
        if !errors.is_empty() {
            release_update_block(&self.operation_block);
            return Err(AppError::new(
                "UPDATE_PREPARE_FAILED",
                "无法安全关闭全部 SSH 会话，本次更新安装已取消。",
            ));
        }
        Ok(())
    }

    /// Releases only an update-owned block. A concurrent explicit exit may
    /// replace it with `Shutdown`; in that case an updater failure must never
    /// reopen remote operations while the application is exiting.
    pub async fn release_update_install(&self) {
        let _guard = self.operation_gate.write().await;
        release_update_block(&self.operation_block);
    }

    fn ensure_operations_open(&self) -> AppResult<()> {
        if self.operation_block.load(Ordering::SeqCst) != OperationBlock::Open as u8 {
            Err(AppError::new(
                "NATIVE_SHUTDOWN_IN_PROGRESS",
                "客户端正在关闭或准备安装更新，不能开始新的远程操作。",
            ))
        } else {
            Ok(())
        }
    }
}

fn release_update_block(operation_block: &AtomicU8) -> bool {
    operation_block
        .compare_exchange(
            OperationBlock::UpdateInstall as u8,
            OperationBlock::Open as u8,
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .is_ok()
}

struct MonitorSamplingGuard {
    sampling: Arc<Mutex<HashSet<String>>>,
    session_id: String,
}

impl MonitorSamplingGuard {
    fn start(sampling: Arc<Mutex<HashSet<String>>>, session_id: &str) -> AppResult<Self> {
        let mut current = sampling
            .lock()
            .map_err(|_| AppError::new("NATIVE_STATE_FAILED", "性能采样状态暂时不可用。"))?;
        if !current.insert(session_id.to_string()) {
            return Err(AppError::new("MONITOR_BUSY", "上一轮性能采样尚未完成。"));
        }
        drop(current);
        Ok(Self {
            sampling,
            session_id: session_id.to_string(),
        })
    }
}

impl Drop for MonitorSamplingGuard {
    fn drop(&mut self) {
        if let Ok(mut sampling) = self.sampling.lock() {
            sampling.remove(&self.session_id);
        }
    }
}

fn to_ssh_connection(connection: &Connection) -> SshConnection {
    SshConnection {
        id: connection.id.clone(),
        host: connection.host.clone(),
        port: connection.port,
        username: connection.username.clone(),
    }
}

fn map_monitor_error(_: crate::monitor::MonitorError) -> AppError {
    AppError::new(
        "MONITOR_PARSE_FAILED",
        "Linux 性能采样格式无法识别，本轮数据未更新。",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_request_is_strict_and_uses_stable_wire_values() {
        let provided = serde_json::from_value::<CredentialRequest>(serde_json::json!({
            "source": "provided",
            "password": "test-password",
            "saveAfterConnect": false,
        }))
        .unwrap();
        assert!(matches!(
            provided,
            CredentialRequest::Provided {
                save_after_connect: false,
                ..
            }
        ));
        assert!(
            serde_json::from_value::<CredentialRequest>(serde_json::json!({
                "source": "saved",
                "password": "unexpected",
            }))
            .is_err()
        );
    }

    #[test]
    fn host_key_probe_response_matches_frontend_contract() {
        let response = HostKeyProbeResult::Mismatch {
            host: "example.test".to_string(),
            port: 22,
            algorithm: "ssh-ed25519".to_string(),
            expected_fingerprint: "SHA256:expected".to_string(),
            received_fingerprint: "SHA256:received".to_string(),
        };
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({
                "status": "mismatch",
                "host": "example.test",
                "port": 22,
                "algorithm": "ssh-ed25519",
                "expectedFingerprint": "SHA256:expected",
                "receivedFingerprint": "SHA256:received",
            })
        );
    }

    #[test]
    fn updater_failure_releases_only_its_own_operation_block() {
        let block = AtomicU8::new(OperationBlock::UpdateInstall as u8);
        assert!(release_update_block(&block));
        assert_eq!(block.load(Ordering::SeqCst), OperationBlock::Open as u8);

        block.store(OperationBlock::Shutdown as u8, Ordering::SeqCst);
        assert!(!release_update_block(&block));
        assert_eq!(block.load(Ordering::SeqCst), OperationBlock::Shutdown as u8);
    }
}
