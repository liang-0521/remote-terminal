use crate::{
    command_history::{validate_command_history_file, COMMAND_HISTORY_FILE},
    error::{AppError, AppResult},
};
use atomic_write_file::AtomicWriteFile;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use uuid::Uuid;

const STORE_VERSION: u32 = 1;
const CONNECTIONS_FILE: &str = "connections.json";
const KNOWN_HOSTS_FILE: &str = "known-hosts.json";
const LEGACY_CREDENTIALS_FILE: &str = "credentials.json";
const LEGACY_MIGRATION_FILE: &str = "legacy-electron-v0.1-import.json";
pub(crate) const MANAGED_DATA_FILES: [&str; 4] = [
    CONNECTIONS_FILE,
    KNOWN_HOSTS_FILE,
    LEGACY_MIGRATION_FILE,
    COMMAND_HISTORY_FILE,
];
const LEGACY_MIGRATION_VERSION: u32 = 1;
const CONTROL_CHARACTER_PATTERN: fn(char) -> bool = |character| character.is_control();
static LEGACY_MIGRATION_GATE: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    Password,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionDraft {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    pub id: String,
    pub name: String,
    /// Accepted only while reading pre-0.4 stores. It is deliberately omitted
    /// from IPC responses and every subsequent atomic store rewrite.
    #[serde(default, rename = "group", skip_serializing)]
    legacy_group: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRemoval {
    pub connection_id: String,
    pub removed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnownHostDraft {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    pub trusted_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyConnection {
    #[serde(flatten)]
    pub connection: Connection,
    /// Electron safeStorage ciphertext cannot be opened by the Tauri process.
    pub has_saved_password: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyElectronSnapshot {
    pub detected: bool,
    pub connections_file_detected: bool,
    pub known_hosts_file_detected: bool,
    pub credentials_file_detected: bool,
    pub credential_migration_supported: bool,
    pub connections: Vec<LegacyConnection>,
    pub known_hosts: Vec<KnownHost>,
}

/// Stable result for the explicit Electron v0.1 -> Tauri v0.2 import.
///
/// Import counts describe the first completed transaction. A later invocation
/// returns the same receipt with `already_completed` set to `true`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyMigrationResult {
    pub detected: bool,
    pub completed: bool,
    pub already_completed: bool,
    pub imported_connections: usize,
    pub skipped_connections: usize,
    pub imported_known_hosts: usize,
    pub skipped_known_hosts: usize,
    pub credentials_detected: bool,
    pub credentials_migrated: bool,
    pub password_reentry_required: bool,
}

impl LegacyMigrationResult {
    fn not_detected() -> Self {
        Self {
            detected: false,
            completed: false,
            already_completed: false,
            imported_connections: 0,
            skipped_connections: 0,
            imported_known_hosts: 0,
            skipped_known_hosts: 0,
            credentials_detected: false,
            credentials_migrated: false,
            password_reentry_required: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyMigrationPlan {
    connections: Vec<Connection>,
    known_hosts: Vec<KnownHost>,
    source_connection_count: usize,
    source_known_host_count: usize,
    skipped_connections: usize,
    skipped_known_hosts: usize,
    credentials_detected: bool,
    password_reentry_required: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum LegacyMigrationJournal {
    Pending {
        version: u32,
        created_at: String,
        plan: LegacyMigrationPlan,
    },
    Completed {
        version: u32,
        completed_at: String,
        result: LegacyMigrationResult,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ConnectionDocument {
    version: u32,
    connections: Vec<Connection>,
}

impl Default for ConnectionDocument {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            connections: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct KnownHostsDocument {
    version: u32,
    hosts: BTreeMap<String, KnownHost>,
}

impl Default for KnownHostsDocument {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            hosts: BTreeMap::new(),
        }
    }
}

struct JsonFileStore {
    path: PathBuf,
    gate: Mutex<()>,
}

impl JsonFileStore {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            gate: Mutex::new(()),
        }
    }

    fn read<T>(&self) -> AppResult<T>
    where
        T: DeserializeOwned + Default,
    {
        let _guard = self.gate.lock().map_err(|_| {
            AppError::new("STORE_LOCK_FAILED", "客户端本地配置正在被另一个操作占用。")
        })?;
        self.read_unlocked()
    }

    fn update<T, R>(
        &self,
        validate: impl Fn(&T) -> AppResult<()>,
        mutate: impl FnOnce(&mut T) -> AppResult<R>,
    ) -> AppResult<R>
    where
        T: DeserializeOwned + Default + Serialize,
    {
        let _guard = self.gate.lock().map_err(|_| {
            AppError::new("STORE_LOCK_FAILED", "客户端本地配置正在被另一个操作占用。")
        })?;
        let mut value = self.read_unlocked()?;
        validate(&value)?;
        let result = mutate(&mut value)?;
        validate(&value)?;
        write_json_atomic(&self.path, &value)?;
        Ok(result)
    }

    fn read_unlocked<T>(&self) -> AppResult<T>
    where
        T: DeserializeOwned + Default,
    {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
            Err(_) => {
                return Err(AppError::new(
                    "STORE_READ_FAILED",
                    "无法读取客户端本地配置。",
                ))
            }
        };
        serde_json::from_slice(&bytes).map_err(|_| {
            AppError::new(
                "STORE_CORRUPT",
                format!("本地配置文件损坏：{}", file_label(&self.path)),
            )
        })
    }
}

pub struct ConnectionStore {
    store: JsonFileStore,
}

impl ConnectionStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            store: JsonFileStore::new(path),
        }
    }

    pub fn list(&self) -> AppResult<Vec<Connection>> {
        let document: ConnectionDocument = self.store.read()?;
        validate_connection_document(&document)?;
        Ok(document.connections)
    }

    pub fn get(&self, connection_id: &str) -> AppResult<Connection> {
        let id = validate_id(connection_id, "连接标识")?;
        self.list()?
            .into_iter()
            .find(|connection| connection.id.eq_ignore_ascii_case(&id))
            .ok_or_else(|| AppError::new("CONNECTION_NOT_FOUND", "未找到该服务器连接配置。"))
    }

    pub fn save(&self, draft: ConnectionDraft) -> AppResult<Connection> {
        let draft = validate_connection_draft(draft)?;
        let timestamp = now_timestamp();
        let connection = Connection {
            id: Uuid::new_v4().to_string(),
            name: draft.name,
            legacy_group: None,
            host: draft.host,
            port: draft.port,
            username: draft.username,
            auth_method: draft.auth_method,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        self.store.update(
            validate_connection_document,
            |document: &mut ConnectionDocument| {
                document.connections.push(connection.clone());
                Ok(connection)
            },
        )
    }

    pub fn remove(&self, connection_id: &str) -> AppResult<ConnectionRemoval> {
        let id = validate_id(connection_id, "连接标识")?;
        self.store.update(
            validate_connection_document,
            |document: &mut ConnectionDocument| {
                let original_len = document.connections.len();
                document
                    .connections
                    .retain(|connection| !connection.id.eq_ignore_ascii_case(&id));
                if document.connections.len() == original_len {
                    return Err(AppError::new(
                        "CONNECTION_NOT_FOUND",
                        "未找到该服务器连接配置。",
                    ));
                }
                Ok(ConnectionRemoval {
                    connection_id: id,
                    removed: true,
                })
            },
        )
    }

    fn import_missing(&self, connections: &[Connection]) -> AppResult<()> {
        if connections.is_empty() {
            return Ok(());
        }
        self.store.update(
            validate_connection_document,
            |document: &mut ConnectionDocument| {
                let mut ids = document
                    .connections
                    .iter()
                    .map(|connection| connection.id.to_lowercase())
                    .collect::<HashSet<_>>();
                for connection in connections {
                    if ids.insert(connection.id.to_lowercase()) {
                        document.connections.push(connection.clone());
                    }
                }
                Ok(())
            },
        )
    }
}

pub struct KnownHostsStore {
    store: JsonFileStore,
}

impl KnownHostsStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            store: JsonFileStore::new(path),
        }
    }

    pub fn list(&self) -> AppResult<Vec<KnownHost>> {
        let document: KnownHostsDocument = self.store.read()?;
        validate_known_hosts_document(&document)?;
        Ok(document.hosts.into_values().collect())
    }

    pub fn get(&self, host: &str, port: u16) -> AppResult<Option<KnownHost>> {
        let key = known_host_key(host, port)?;
        let document: KnownHostsDocument = self.store.read()?;
        validate_known_hosts_document(&document)?;
        Ok(document.hosts.get(&key).cloned())
    }

    pub fn trust(&self, draft: KnownHostDraft) -> AppResult<KnownHost> {
        let draft = validate_known_host_draft(draft)?;
        let key = known_host_key(&draft.host, draft.port)?;
        let entry = KnownHost {
            host: draft.host,
            port: draft.port,
            algorithm: draft.algorithm,
            fingerprint: draft.fingerprint,
            trusted_at: now_timestamp(),
        };
        self.store.update(
            validate_known_hosts_document,
            |document: &mut KnownHostsDocument| {
                document.hosts.insert(key, entry.clone());
                Ok(entry)
            },
        )
    }

    fn import_missing(&self, hosts: &[KnownHost]) -> AppResult<()> {
        if hosts.is_empty() {
            return Ok(());
        }
        self.store.update(
            validate_known_hosts_document,
            |document: &mut KnownHostsDocument| {
                for host in hosts {
                    let key = known_host_key(&host.host, host.port)?;
                    document.hosts.entry(key).or_insert_with(|| host.clone());
                }
                Ok(())
            },
        )
    }
}

/// Reads legacy Electron stores without modifying either the old or new files.
/// The old credentials file is presence-detected only: safeStorage ciphertext
/// is intentionally never parsed, copied, or reported as a saved password.
pub fn detect_legacy_electron_data(data_directory: &Path) -> AppResult<LegacyElectronSnapshot> {
    let connections_path = data_directory.join(CONNECTIONS_FILE);
    let known_hosts_path = data_directory.join(KNOWN_HOSTS_FILE);
    let credentials_path = data_directory.join(LEGACY_CREDENTIALS_FILE);

    let connections_file_detected = regular_file_exists(&connections_path)?;
    let known_hosts_file_detected = regular_file_exists(&known_hosts_path)?;
    let credentials_file_detected = regular_file_exists(&credentials_path)?;

    let connections = if connections_file_detected {
        ConnectionStore::new(connections_path)
            .list()?
            .into_iter()
            .map(|connection| LegacyConnection {
                connection,
                has_saved_password: false,
            })
            .collect()
    } else {
        Vec::new()
    };
    let known_hosts = if known_hosts_file_detected {
        KnownHostsStore::new(known_hosts_path).list()?
    } else {
        Vec::new()
    };

    Ok(LegacyElectronSnapshot {
        detected: connections_file_detected
            || known_hosts_file_detected
            || credentials_file_detected,
        connections_file_detected,
        known_hosts_file_detected,
        credentials_file_detected,
        credential_migration_supported: false,
        connections,
        known_hosts,
    })
}

/// Explicitly imports the Electron v0.1 connection and known-host stores into
/// the Tauri v0.2 data directory.
///
/// The transaction writes a pending journal before touching either target
/// store. Every target write uses atomic replacement, and a retry resumes the
/// journal while skipping entries already present. The completed journal is a
/// durable one-time receipt, so later calls cannot replay or overwrite data.
/// Electron `credentials.json` is presence-detected only; its safeStorage
/// ciphertext is never read, copied, or migrated.
/// Call this during startup before exposing the target stores to IPC commands.
pub fn migrate_legacy_electron_data(
    legacy_data_directory: &Path,
    target_data_directory: &Path,
) -> AppResult<LegacyMigrationResult> {
    reject_same_migration_directory(legacy_data_directory, target_data_directory)?;
    let _guard = LEGACY_MIGRATION_GATE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| AppError::new("STORE_LOCK_FAILED", "旧版数据导入正在被另一个操作占用。"))?;

    let journal_path = target_data_directory.join(LEGACY_MIGRATION_FILE);
    let journal = read_optional_json::<LegacyMigrationJournal>(&journal_path)?;
    let plan = match journal {
        Some(LegacyMigrationJournal::Completed {
            version,
            completed_at,
            mut result,
        }) => {
            validate_completed_migration(version, &completed_at, &result)?;
            result.already_completed = true;
            return Ok(result);
        }
        Some(LegacyMigrationJournal::Pending {
            version,
            created_at,
            plan,
        }) => {
            validate_pending_migration(version, &created_at, &plan)?;
            plan
        }
        None => {
            let snapshot = detect_legacy_electron_data(legacy_data_directory)?;
            if !snapshot.detected {
                return Ok(LegacyMigrationResult::not_detected());
            }
            let plan = build_legacy_migration_plan(snapshot, target_data_directory)?;
            let pending = LegacyMigrationJournal::Pending {
                version: LEGACY_MIGRATION_VERSION,
                created_at: now_timestamp(),
                plan: plan.clone(),
            };
            write_json_atomic(&journal_path, &pending)?;
            plan
        }
    };

    ConnectionStore::new(target_data_directory.join(CONNECTIONS_FILE))
        .import_missing(&plan.connections)?;
    KnownHostsStore::new(target_data_directory.join(KNOWN_HOSTS_FILE))
        .import_missing(&plan.known_hosts)?;

    let result = LegacyMigrationResult {
        detected: true,
        completed: true,
        already_completed: false,
        imported_connections: plan.connections.len(),
        skipped_connections: plan.skipped_connections,
        imported_known_hosts: plan.known_hosts.len(),
        skipped_known_hosts: plan.skipped_known_hosts,
        credentials_detected: plan.credentials_detected,
        credentials_migrated: false,
        password_reentry_required: plan.password_reentry_required,
    };
    let completed = LegacyMigrationJournal::Completed {
        version: LEGACY_MIGRATION_VERSION,
        completed_at: now_timestamp(),
        result: result.clone(),
    };
    write_json_atomic(&journal_path, &completed)?;
    Ok(result)
}

fn build_legacy_migration_plan(
    snapshot: LegacyElectronSnapshot,
    target_data_directory: &Path,
) -> AppResult<LegacyMigrationPlan> {
    let source_connection_count = snapshot.connections.len();
    let source_known_host_count = snapshot.known_hosts.len();
    let password_reentry_required =
        snapshot.credentials_file_detected || source_connection_count > 0;

    let mut target_connection_ids =
        ConnectionStore::new(target_data_directory.join(CONNECTIONS_FILE))
            .list()?
            .into_iter()
            .map(|connection| connection.id.to_lowercase())
            .collect::<HashSet<_>>();
    let mut connections = Vec::with_capacity(source_connection_count);
    let mut skipped_connections = 0;
    for legacy in snapshot.connections {
        let connection = legacy.connection;
        if target_connection_ids.insert(connection.id.to_lowercase()) {
            connections.push(connection);
        } else {
            skipped_connections += 1;
        }
    }

    let mut target_known_host_keys =
        KnownHostsStore::new(target_data_directory.join(KNOWN_HOSTS_FILE))
            .list()?
            .into_iter()
            .map(|host| known_host_key(&host.host, host.port))
            .collect::<AppResult<HashSet<_>>>()?;
    let mut known_hosts = Vec::with_capacity(source_known_host_count);
    let mut skipped_known_hosts = 0;
    for host in snapshot.known_hosts {
        let key = known_host_key(&host.host, host.port)?;
        if target_known_host_keys.insert(key) {
            known_hosts.push(host);
        } else {
            skipped_known_hosts += 1;
        }
    }

    Ok(LegacyMigrationPlan {
        connections,
        known_hosts,
        source_connection_count,
        source_known_host_count,
        skipped_connections,
        skipped_known_hosts,
        credentials_detected: snapshot.credentials_file_detected,
        password_reentry_required,
    })
}

fn validate_pending_migration(
    version: u32,
    created_at: &str,
    plan: &LegacyMigrationPlan,
) -> AppResult<()> {
    validate_migration_version(version)?;
    validate_timestamp(created_at)
        .map_err(|_| store_corrupt("旧版数据导入记录中存在无效时间。"))?;
    validate_legacy_migration_plan(plan)
}

fn validate_completed_migration(
    version: u32,
    completed_at: &str,
    result: &LegacyMigrationResult,
) -> AppResult<()> {
    validate_migration_version(version)?;
    validate_timestamp(completed_at)
        .map_err(|_| store_corrupt("旧版数据导入记录中存在无效时间。"))?;
    if !result.detected
        || !result.completed
        || result.already_completed
        || result.credentials_migrated
        || (result.credentials_detected && !result.password_reentry_required)
    {
        return Err(store_corrupt("旧版数据导入完成记录不正确。"));
    }
    Ok(())
}

fn validate_migration_version(version: u32) -> AppResult<()> {
    if version != LEGACY_MIGRATION_VERSION {
        return Err(store_corrupt(
            "旧版数据导入记录版本不受支持。请先备份该文件再处理。",
        ));
    }
    Ok(())
}

fn validate_legacy_migration_plan(plan: &LegacyMigrationPlan) -> AppResult<()> {
    let connection_count = plan
        .connections
        .len()
        .checked_add(plan.skipped_connections)
        .ok_or_else(|| store_corrupt("旧版连接导入计数无效。"))?;
    let known_host_count = plan
        .known_hosts
        .len()
        .checked_add(plan.skipped_known_hosts)
        .ok_or_else(|| store_corrupt("旧版已知主机导入计数无效。"))?;
    if connection_count != plan.source_connection_count
        || known_host_count != plan.source_known_host_count
        || plan.password_reentry_required
            != (plan.credentials_detected || plan.source_connection_count > 0)
    {
        return Err(store_corrupt("旧版数据导入计划不正确。"));
    }

    validate_connection_document(&ConnectionDocument {
        version: STORE_VERSION,
        connections: plan.connections.clone(),
    })?;
    let mut hosts = BTreeMap::new();
    for host in &plan.known_hosts {
        let key = known_host_key(&host.host, host.port)
            .map_err(|_| store_corrupt("旧版已知主机导入记录无效。"))?;
        if hosts.insert(key, host.clone()).is_some() {
            return Err(store_corrupt("旧版已知主机导入记录重复。"));
        }
    }
    validate_known_hosts_document(&KnownHostsDocument {
        version: STORE_VERSION,
        hosts,
    })
}

pub fn validate_id(value: &str, label: &str) -> AppResult<String> {
    let trimmed = validate_string(value, label, 1, 36, false)?;
    let uuid = Uuid::parse_str(&trimmed)
        .map_err(|_| AppError::new("INVALID_INPUT", format!("{label}格式不正确。")))?;
    if trimmed.len() != 36 || !uuid.to_string().eq_ignore_ascii_case(&trimmed) {
        return Err(AppError::new(
            "INVALID_INPUT",
            format!("{label}格式不正确。"),
        ));
    }
    Ok(uuid.to_string())
}

pub fn validate_password(value: &str) -> AppResult<()> {
    if value.is_empty() || value.encode_utf16().count() > 4096 {
        return Err(AppError::new(
            "INVALID_INPUT",
            "密码不能为空且不能超过 4096 个字符。",
        ));
    }
    Ok(())
}

/// Validates every durable JSON document owned by the configurable data
/// directory. Credentials and WebView2 profile/cache files are intentionally
/// outside this allowlist and are never read by this validator.
pub(crate) fn validate_data_directory(directory: &Path) -> AppResult<()> {
    let connections_path = directory.join(CONNECTIONS_FILE);
    if regular_file_exists(&connections_path)? {
        ConnectionStore::new(connections_path).list()?;
    }

    let known_hosts_path = directory.join(KNOWN_HOSTS_FILE);
    if regular_file_exists(&known_hosts_path)? {
        KnownHostsStore::new(known_hosts_path).list()?;
    }

    let journal_path = directory.join(LEGACY_MIGRATION_FILE);
    if let Some(journal) = read_optional_json::<LegacyMigrationJournal>(&journal_path)? {
        match journal {
            LegacyMigrationJournal::Pending {
                version,
                created_at,
                plan,
            } => validate_pending_migration(version, &created_at, &plan)?,
            LegacyMigrationJournal::Completed {
                version,
                completed_at,
                result,
            } => validate_completed_migration(version, &completed_at, &result)?,
        }
    }
    validate_command_history_file(&directory.join(COMMAND_HISTORY_FILE))?;
    Ok(())
}

pub fn known_host_key(host: &str, port: u16) -> AppResult<String> {
    let host = validate_string(host, "主机地址", 1, 253, false)?;
    validate_port(port)?;
    Ok(format!("{}:{port}", host.to_lowercase()))
}

fn validate_connection_draft(draft: ConnectionDraft) -> AppResult<ConnectionDraft> {
    Ok(ConnectionDraft {
        name: validate_string(&draft.name, "连接名称", 1, 80, true)?,
        host: validate_string(&draft.host, "主机地址", 1, 253, false)?,
        port: validate_port(draft.port)?,
        username: validate_string(&draft.username, "用户名", 1, 128, false)?,
        auth_method: draft.auth_method,
    })
}

fn validate_known_host_draft(draft: KnownHostDraft) -> AppResult<KnownHostDraft> {
    Ok(KnownHostDraft {
        host: validate_string(&draft.host, "主机地址", 1, 253, false)?,
        port: validate_port(draft.port)?,
        algorithm: validate_string(&draft.algorithm, "主机密钥算法", 1, 128, false)?,
        fingerprint: validate_string(&draft.fingerprint, "主机指纹", 1, 512, false)?,
    })
}

fn validate_connection_document(document: &ConnectionDocument) -> AppResult<()> {
    if document.version != STORE_VERSION {
        return Err(store_corrupt(
            "连接配置结构版本不受支持。请先备份该文件再处理。",
        ));
    }
    let mut ids = HashSet::with_capacity(document.connections.len());
    for connection in &document.connections {
        validate_persisted_connection(connection)?;
        if !ids.insert(connection.id.to_lowercase()) {
            return Err(store_corrupt("连接配置中存在重复标识。"));
        }
    }
    Ok(())
}

fn validate_persisted_connection(connection: &Connection) -> AppResult<()> {
    let id = validate_id(&connection.id, "连接标识")
        .map_err(|_| store_corrupt("连接配置中存在无效标识。"))?;
    if !id.eq_ignore_ascii_case(&connection.id) {
        return Err(store_corrupt("连接配置中存在无效标识。"));
    }
    let normalized = validate_connection_draft(ConnectionDraft {
        name: connection.name.clone(),
        host: connection.host.clone(),
        port: connection.port,
        username: connection.username.clone(),
        auth_method: connection.auth_method,
    })
    .map_err(|_| store_corrupt("连接配置中存在无效字段。"))?;
    if normalized.name != connection.name
        || normalized.host != connection.host
        || normalized.username != connection.username
    {
        return Err(store_corrupt("连接配置中存在未规范化字段。"));
    }
    if let Some(group) = &connection.legacy_group {
        let normalized_group = validate_string(group, "旧版分组", 1, 80, true)
            .map_err(|_| store_corrupt("连接配置中存在无效旧版分组。"))?;
        if normalized_group != *group {
            return Err(store_corrupt("连接配置中存在未规范化旧版分组。"));
        }
    }
    validate_timestamp(&connection.created_at)
        .and_then(|_| validate_timestamp(&connection.updated_at))
        .map_err(|_| store_corrupt("连接配置中存在无效时间。"))
}

fn validate_known_hosts_document(document: &KnownHostsDocument) -> AppResult<()> {
    if document.version != STORE_VERSION {
        return Err(store_corrupt(
            "已知主机配置结构版本不受支持。请先备份该文件再处理。",
        ));
    }
    for (key, host) in &document.hosts {
        let normalized = validate_known_host_draft(KnownHostDraft {
            host: host.host.clone(),
            port: host.port,
            algorithm: host.algorithm.clone(),
            fingerprint: host.fingerprint.clone(),
        })
        .map_err(|_| store_corrupt("已知主机配置中存在无效字段。"))?;
        if normalized.host != host.host
            || normalized.algorithm != host.algorithm
            || normalized.fingerprint != host.fingerprint
            || known_host_key(&host.host, host.port)
                .map_err(|_| store_corrupt("已知主机配置中存在无效地址。"))?
                != *key
        {
            return Err(store_corrupt("已知主机配置键与内容不一致。"));
        }
        validate_timestamp(&host.trusted_at)
            .map_err(|_| store_corrupt("已知主机配置中存在无效时间。"))?;
    }
    Ok(())
}

fn validate_string(
    value: &str,
    label: &str,
    min: usize,
    max: usize,
    allow_whitespace: bool,
) -> AppResult<String> {
    let normalized = value.trim();
    // Electron's String.length contract counts UTF-16 code units.
    let length = normalized.encode_utf16().count();
    if length < min || length > max {
        return Err(AppError::new(
            "INVALID_INPUT",
            format!("{label}长度必须在 {min}–{max} 个字符之间。"),
        ));
    }
    if normalized.chars().any(CONTROL_CHARACTER_PATTERN) {
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
    Ok(normalized.to_string())
}

fn validate_port(port: u16) -> AppResult<u16> {
    if port == 0 {
        return Err(AppError::new(
            "INVALID_INPUT",
            "端口必须是 1–65535 的整数。",
        ));
    }
    Ok(port)
}

fn validate_timestamp(value: &str) -> AppResult<()> {
    DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| AppError::new("INVALID_INPUT", "时间格式不正确。"))
}

fn now_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn reject_same_migration_directory(source: &Path, target: &Path) -> AppResult<()> {
    let same_path = source == target
        || match (fs::canonicalize(source), fs::canonicalize(target)) {
            (Ok(source), Ok(target)) => source == target,
            _ => false,
        };
    if same_path {
        return Err(AppError::new(
            "INVALID_INPUT",
            "旧版数据目录与新版数据目录不能相同。",
        ));
    }
    Ok(())
}

fn read_optional_json<T: DeserializeOwned>(path: &Path) -> AppResult<Option<T>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(AppError::new(
                "STORE_READ_FAILED",
                "无法读取客户端本地配置。",
            ))
        }
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| store_corrupt(format!("本地配置文件损坏：{}", file_label(path))))
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("STORE_WRITE_FAILED", "客户端本地配置路径无效。"))?;
    fs::create_dir_all(parent)
        .map_err(|_| AppError::new("STORE_WRITE_FAILED", "无法创建客户端本地配置目录。"))?;
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| AppError::new("STORE_WRITE_FAILED", "无法序列化客户端本地配置。"))?;
    bytes.push(b'\n');

    let mut file = AtomicWriteFile::open(path)
        .map_err(|_| AppError::new("STORE_WRITE_FAILED", "无法写入客户端本地配置。"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| AppError::new("STORE_WRITE_FAILED", "无法写入客户端本地配置。"))?;
    file.commit()
        .map_err(|_| AppError::new("STORE_WRITE_FAILED", "无法提交客户端本地配置。"))
}

fn regular_file_exists(path: &Path) -> AppResult<bool> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(AppError::new(
            "STORE_READ_FAILED",
            format!("本地配置路径不是文件：{}", file_label(path)),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(AppError::new(
            "STORE_READ_FAILED",
            "无法检查客户端旧版本地配置。",
        )),
    }
}

fn file_label(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown.json")
        .to_string()
}

fn store_corrupt(message: impl Into<String>) -> AppError {
    AppError::new("STORE_CORRUPT", message)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONNECTION_ID: &str = "11111111-1111-4111-8111-111111111111";
    const SECOND_CONNECTION_ID: &str = "22222222-2222-4222-8222-222222222222";
    const THIRD_CONNECTION_ID: &str = "33333333-3333-4333-8333-333333333333";
    const LEGACY_TIMESTAMP: &str = "2026-01-02T03:04:05.678Z";

    fn draft() -> ConnectionDraft {
        ConnectionDraft {
            name: "测试服务器".to_string(),
            host: "example.test".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_method: AuthMethod::Password,
        }
    }

    fn persisted_connection(id: &str, name: &str, host: &str) -> Connection {
        Connection {
            id: id.to_string(),
            name: name.to_string(),
            legacy_group: None,
            host: host.to_string(),
            port: 22,
            username: "root".to_string(),
            auth_method: AuthMethod::Password,
            created_at: LEGACY_TIMESTAMP.to_string(),
            updated_at: LEGACY_TIMESTAMP.to_string(),
        }
    }

    fn persisted_host(host: &str, fingerprint: &str) -> KnownHost {
        KnownHost {
            host: host.to_string(),
            port: 22,
            algorithm: "ssh-ed25519".to_string(),
            fingerprint: fingerprint.to_string(),
            trusted_at: LEGACY_TIMESTAMP.to_string(),
        }
    }

    fn write_connections(directory: &Path, connections: Vec<Connection>) {
        write_json_atomic(
            &directory.join(CONNECTIONS_FILE),
            &ConnectionDocument {
                version: STORE_VERSION,
                connections,
            },
        )
        .unwrap();
    }

    fn write_known_hosts(directory: &Path, hosts: Vec<KnownHost>) {
        let hosts = hosts
            .into_iter()
            .map(|host| (known_host_key(&host.host, host.port).unwrap(), host))
            .collect();
        write_json_atomic(
            &directory.join(KNOWN_HOSTS_FILE),
            &KnownHostsDocument {
                version: STORE_VERSION,
                hosts,
            },
        )
        .unwrap();
    }

    #[test]
    fn connection_store_round_trip_and_strict_username_validation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(CONNECTIONS_FILE);
        let store = ConnectionStore::new(path.clone());
        let saved = store.save(draft()).unwrap();
        assert_eq!(store.get(&saved.id).unwrap(), saved);
        let serialized = fs::read_to_string(path).unwrap();
        assert!(!serialized.contains("must-not-be-persisted"));
        assert!(
            serde_json::from_value::<ConnectionDraft>(serde_json::json!({
                "name": "测试服务器",
                "host": "example.test",
                "port": 22,
                "username": "root",
                "authMethod": "password",
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<ConnectionDraft>(serde_json::json!({
                "name": "测试服务器",
                "group": "测试",
                "host": "example.test",
                "port": 22,
                "username": "root",
                "authMethod": "password",
                "password": "must-not-be-persisted",
            }))
            .is_err()
        );

        let mut invalid = draft();
        invalid.username = "  ".to_string();
        let error = store.save(invalid).unwrap_err();
        assert_eq!(error.code, "INVALID_INPUT");
    }

    #[test]
    fn legacy_group_is_read_but_omitted_on_next_store_write() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(CONNECTIONS_FILE);
        let legacy = format!(
            r#"{{"version":1,"connections":[{{"id":"{CONNECTION_ID}","name":"旧连接","group":"旧版","host":"legacy.test","port":22,"username":"root","authMethod":"password","createdAt":"{LEGACY_TIMESTAMP}","updatedAt":"{LEGACY_TIMESTAMP}"}}]}}"#
        );
        fs::write(&path, legacy).unwrap();
        let store = ConnectionStore::new(path.clone());

        let loaded = store.list().unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(serde_json::to_value(&loaded[0])
            .unwrap()
            .get("group")
            .is_none());
        store.save(draft()).unwrap();

        let rewritten = fs::read_to_string(path).unwrap();
        assert!(!rewritten.contains("\"group\""));
        assert_eq!(store.list().unwrap().len(), 2);
    }

    #[test]
    fn corrupt_or_unknown_version_is_never_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(CONNECTIONS_FILE);
        let original = br#"{"version":2,"connections":[]}"#;
        fs::write(&path, original).unwrap();
        let store = ConnectionStore::new(path.clone());
        assert_eq!(store.save(draft()).unwrap_err().code, "STORE_CORRUPT");
        assert_eq!(fs::read(path).unwrap(), original);
    }

    #[test]
    fn known_hosts_use_normalized_key_and_atomic_document() {
        let directory = tempfile::tempdir().unwrap();
        let store = KnownHostsStore::new(directory.path().join(KNOWN_HOSTS_FILE));
        let trusted = store
            .trust(KnownHostDraft {
                host: "Example.TEST".to_string(),
                port: 22,
                algorithm: "ssh-ed25519".to_string(),
                fingerprint: "SHA256:test".to_string(),
            })
            .unwrap();
        assert_eq!(store.get("example.test", 22).unwrap(), Some(trusted));
    }

    #[test]
    fn legacy_detection_never_claims_electron_password_migration() {
        let directory = tempfile::tempdir().unwrap();
        let timestamp = now_timestamp();
        let document = ConnectionDocument {
            version: STORE_VERSION,
            connections: vec![Connection {
                id: CONNECTION_ID.to_string(),
                name: "旧连接".to_string(),
                legacy_group: None,
                host: "legacy.test".to_string(),
                port: 22,
                username: "legacy-user".to_string(),
                auth_method: AuthMethod::Password,
                created_at: timestamp.clone(),
                updated_at: timestamp,
            }],
        };
        write_json_atomic(&directory.path().join(CONNECTIONS_FILE), &document).unwrap();
        fs::write(
            directory.path().join(LEGACY_CREDENTIALS_FILE),
            b"electron-safe-storage-data",
        )
        .unwrap();

        let snapshot = detect_legacy_electron_data(directory.path()).unwrap();
        assert!(snapshot.detected);
        assert!(snapshot.credentials_file_detected);
        assert!(!snapshot.credential_migration_supported);
        assert_eq!(snapshot.connections.len(), 1);
        assert!(!snapshot.connections[0].has_saved_password);
    }

    #[test]
    fn legacy_migration_preserves_records_and_requires_password_reentry() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let connection = persisted_connection(CONNECTION_ID, "旧连接", "legacy.test");
        let known_host = persisted_host("legacy.test", "SHA256:legacy");
        write_connections(source.path(), vec![connection.clone()]);
        write_known_hosts(source.path(), vec![known_host.clone()]);
        fs::write(
            source.path().join(LEGACY_CREDENTIALS_FILE),
            b"electron-safe-storage-secret",
        )
        .unwrap();
        let source_connections_before = fs::read(source.path().join(CONNECTIONS_FILE)).unwrap();
        let source_hosts_before = fs::read(source.path().join(KNOWN_HOSTS_FILE)).unwrap();

        let result = migrate_legacy_electron_data(source.path(), target.path()).unwrap();

        assert_eq!(
            result,
            LegacyMigrationResult {
                detected: true,
                completed: true,
                already_completed: false,
                imported_connections: 1,
                skipped_connections: 0,
                imported_known_hosts: 1,
                skipped_known_hosts: 0,
                credentials_detected: true,
                credentials_migrated: false,
                password_reentry_required: true,
            }
        );
        assert_eq!(
            ConnectionStore::new(target.path().join(CONNECTIONS_FILE))
                .list()
                .unwrap(),
            vec![connection]
        );
        assert_eq!(
            KnownHostsStore::new(target.path().join(KNOWN_HOSTS_FILE))
                .list()
                .unwrap(),
            vec![known_host]
        );
        assert_eq!(
            fs::read(source.path().join(CONNECTIONS_FILE)).unwrap(),
            source_connections_before
        );
        assert_eq!(
            fs::read(source.path().join(KNOWN_HOSTS_FILE)).unwrap(),
            source_hosts_before
        );
        assert!(!target.path().join(LEGACY_CREDENTIALS_FILE).exists());
        let receipt = fs::read_to_string(target.path().join(LEGACY_MIGRATION_FILE)).unwrap();
        assert!(!receipt.contains("electron-safe-storage-secret"));
        assert!(!receipt.contains("legacy.test"));
    }

    #[test]
    fn legacy_migration_merges_only_missing_records_without_overwrite() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let source_conflict =
            persisted_connection(CONNECTION_ID, "旧版名称", "source-conflict.test");
        let source_new = persisted_connection(SECOND_CONNECTION_ID, "新增连接", "source-new.test");
        let target_conflict = persisted_connection(CONNECTION_ID, "新版名称", "target-wins.test");
        let source_host_conflict = persisted_host("shared.test", "SHA256:source");
        let source_host_new = persisted_host("new.test", "SHA256:new");
        let target_host_conflict = persisted_host("shared.test", "SHA256:target");
        write_connections(source.path(), vec![source_conflict, source_new.clone()]);
        write_known_hosts(
            source.path(),
            vec![source_host_conflict, source_host_new.clone()],
        );
        write_connections(target.path(), vec![target_conflict.clone()]);
        write_known_hosts(target.path(), vec![target_host_conflict.clone()]);

        let result = migrate_legacy_electron_data(source.path(), target.path()).unwrap();

        assert_eq!(result.imported_connections, 1);
        assert_eq!(result.skipped_connections, 1);
        assert_eq!(result.imported_known_hosts, 1);
        assert_eq!(result.skipped_known_hosts, 1);
        let connection_store = ConnectionStore::new(target.path().join(CONNECTIONS_FILE));
        assert_eq!(
            connection_store.get(CONNECTION_ID).unwrap(),
            target_conflict
        );
        assert_eq!(
            connection_store.get(SECOND_CONNECTION_ID).unwrap(),
            source_new
        );
        assert_eq!(connection_store.list().unwrap().len(), 2);
        let known_hosts_store = KnownHostsStore::new(target.path().join(KNOWN_HOSTS_FILE));
        assert_eq!(
            known_hosts_store.get("shared.test", 22).unwrap(),
            Some(target_host_conflict)
        );
        assert_eq!(
            known_hosts_store.get("new.test", 22).unwrap(),
            Some(source_host_new)
        );
        assert_eq!(known_hosts_store.list().unwrap().len(), 2);
    }

    #[test]
    fn completed_legacy_migration_is_one_time_and_idempotent() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        write_connections(
            source.path(),
            vec![persisted_connection(
                CONNECTION_ID,
                "初次导入",
                "first.test",
            )],
        );

        let first = migrate_legacy_electron_data(source.path(), target.path()).unwrap();
        write_connections(
            source.path(),
            vec![
                persisted_connection(CONNECTION_ID, "初次导入", "first.test"),
                persisted_connection(THIRD_CONNECTION_ID, "后来新增", "later.test"),
            ],
        );
        let second = migrate_legacy_electron_data(source.path(), target.path()).unwrap();

        assert!(!first.already_completed);
        assert!(second.already_completed);
        assert_eq!(second.imported_connections, first.imported_connections);
        let target_connections = ConnectionStore::new(target.path().join(CONNECTIONS_FILE))
            .list()
            .unwrap();
        assert_eq!(target_connections.len(), 1);
        assert_eq!(target_connections[0].id, CONNECTION_ID);
    }

    #[test]
    fn pending_legacy_migration_resumes_without_duplicate_records() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let connection = persisted_connection(CONNECTION_ID, "恢复连接", "resume.test");
        let host = persisted_host("resume.test", "SHA256:resume");
        write_connections(target.path(), vec![connection.clone()]);
        let plan = LegacyMigrationPlan {
            connections: vec![connection],
            known_hosts: vec![host.clone()],
            source_connection_count: 1,
            source_known_host_count: 1,
            skipped_connections: 0,
            skipped_known_hosts: 0,
            credentials_detected: false,
            password_reentry_required: true,
        };
        write_json_atomic(
            &target.path().join(LEGACY_MIGRATION_FILE),
            &LegacyMigrationJournal::Pending {
                version: LEGACY_MIGRATION_VERSION,
                created_at: LEGACY_TIMESTAMP.to_string(),
                plan,
            },
        )
        .unwrap();

        let result = migrate_legacy_electron_data(source.path(), target.path()).unwrap();

        assert!(result.completed);
        assert!(!result.already_completed);
        assert_eq!(
            ConnectionStore::new(target.path().join(CONNECTIONS_FILE))
                .list()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            KnownHostsStore::new(target.path().join(KNOWN_HOSTS_FILE))
                .get("resume.test", 22)
                .unwrap(),
            Some(host)
        );
    }

    #[test]
    fn missing_legacy_data_does_not_commit_a_migration_receipt() {
        let source = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();

        let result = migrate_legacy_electron_data(source.path(), target.path()).unwrap();

        assert_eq!(result, LegacyMigrationResult::not_detected());
        assert!(!target.path().join(LEGACY_MIGRATION_FILE).exists());
        assert!(!target.path().join(CONNECTIONS_FILE).exists());
        assert!(!target.path().join(KNOWN_HOSTS_FILE).exists());
    }
}
