use crate::error::{AppError, AppResult};
use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Write,
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

pub(crate) const COMMAND_HISTORY_FILE: &str = "command-history.json";
const STORE_VERSION: u32 = 1;
const MAX_CONNECTIONS: usize = 512;
const MAX_COMMANDS_PER_CONNECTION: usize = 200;
const MAX_COMMAND_UTF16: usize = 2_048;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CommandHistoryDocument {
    version: u32,
    connections: BTreeMap<String, Vec<String>>,
}

impl Default for CommandHistoryDocument {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            connections: BTreeMap::new(),
        }
    }
}

/// Stores only command text keyed by the local connection UUID. Hostnames,
/// usernames, passwords and credential-manager material are not part of this
/// schema. Entries are ordered newest-first and bounded per connection.
pub struct CommandHistoryStore {
    path: PathBuf,
    gate: Mutex<()>,
}

impl CommandHistoryStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            gate: Mutex::new(()),
        }
    }

    pub fn list(&self, connection_id: &str) -> AppResult<Vec<String>> {
        let id = validate_connection_id(connection_id)?;
        let _guard = self.lock()?;
        let document = read_document(&self.path)?;
        Ok(document.connections.get(&id).cloned().unwrap_or_default())
    }

    pub fn record(&self, connection_id: &str, command: &str) -> AppResult<Vec<String>> {
        let id = validate_connection_id(connection_id)?;
        let command = validate_command(command)?;
        let _guard = self.lock()?;
        let mut document = read_document(&self.path)?;
        if !document.connections.contains_key(&id) && document.connections.len() >= MAX_CONNECTIONS
        {
            return Err(AppError::new(
                "COMMAND_HISTORY_LIMIT",
                "本机命令历史中的服务器数量已达到安全上限。",
            ));
        }
        let commands = document.connections.entry(id).or_default();
        if commands.first() == Some(&command) {
            return Ok(commands.clone());
        }
        commands.retain(|candidate| candidate != &command);
        commands.insert(0, command);
        commands.truncate(MAX_COMMANDS_PER_CONNECTION);
        let result = commands.clone();
        validate_document(&document)?;
        write_document(&self.path, &document)?;
        Ok(result)
    }

    pub fn remove(&self, connection_id: &str, command: &str) -> AppResult<Vec<String>> {
        let id = validate_connection_id(connection_id)?;
        let command = validate_command(command)?;
        let _guard = self.lock()?;
        let mut document = read_document(&self.path)?;
        let Some(commands) = document.connections.get_mut(&id) else {
            return Ok(Vec::new());
        };
        let original_len = commands.len();
        commands.retain(|candidate| candidate != &command);
        if commands.len() == original_len {
            return Ok(commands.clone());
        }
        let result = commands.clone();
        if commands.is_empty() {
            document.connections.remove(&id);
        }
        validate_document(&document)?;
        write_document(&self.path, &document)?;
        Ok(result)
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, ()>> {
        self.gate
            .lock()
            .map_err(|_| AppError::new("STORE_LOCK_FAILED", "本机命令历史正在被另一个操作占用。"))
    }
}

pub(crate) fn validate_command_history_file(path: &Path) -> AppResult<()> {
    read_document(path).map(|_| ())
}

fn read_document(path: &Path) -> AppResult<CommandHistoryDocument> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CommandHistoryDocument::default());
        }
        Err(_) => {
            return Err(AppError::new("STORE_READ_FAILED", "无法读取本机命令历史。"));
        }
    };
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(AppError::new(
            "STORE_READ_FAILED",
            "本机命令历史路径不是普通本地文件。",
        ));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(store_corrupt("本机命令历史文件超过安全大小上限。"));
    }
    let bytes =
        fs::read(path).map_err(|_| AppError::new("STORE_READ_FAILED", "无法读取本机命令历史。"))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(store_corrupt("本机命令历史文件超过安全大小上限。"));
    }
    let document: CommandHistoryDocument =
        serde_json::from_slice(&bytes).map_err(|_| store_corrupt("本机命令历史文件结构损坏。"))?;
    validate_document(&document)?;
    Ok(document)
}

fn write_document(path: &Path, document: &CommandHistoryDocument) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("STORE_WRITE_FAILED", "本机命令历史路径无效。"))?;
    fs::create_dir_all(parent)
        .map_err(|_| AppError::new("STORE_WRITE_FAILED", "无法创建本机命令历史目录。"))?;
    let mut bytes = serde_json::to_vec_pretty(document)
        .map_err(|_| AppError::new("STORE_WRITE_FAILED", "无法序列化本机命令历史。"))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(AppError::new(
            "COMMAND_HISTORY_LIMIT",
            "本机命令历史文件已达到安全大小上限。",
        ));
    }
    let mut file = AtomicWriteFile::open(path)
        .map_err(|_| AppError::new("STORE_WRITE_FAILED", "无法写入本机命令历史。"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| AppError::new("STORE_WRITE_FAILED", "无法写入本机命令历史。"))?;
    file.commit()
        .map_err(|_| AppError::new("STORE_WRITE_FAILED", "无法提交本机命令历史。"))
}

fn validate_document(document: &CommandHistoryDocument) -> AppResult<()> {
    if document.version != STORE_VERSION {
        return Err(store_corrupt(
            "本机命令历史结构版本不受支持。请先备份该文件再处理。",
        ));
    }
    if document.connections.len() > MAX_CONNECTIONS {
        return Err(store_corrupt("本机命令历史中的服务器数量超过安全上限。"));
    }
    for (connection_id, commands) in &document.connections {
        let normalized_id = validate_connection_id(connection_id)
            .map_err(|_| store_corrupt("本机命令历史中存在无效服务器标识。"))?;
        if normalized_id != *connection_id {
            return Err(store_corrupt("本机命令历史中存在未规范化服务器标识。"));
        }
        if commands.is_empty() || commands.len() > MAX_COMMANDS_PER_CONNECTION {
            return Err(store_corrupt("本机命令历史条目数量无效。"));
        }
        let mut unique = HashSet::with_capacity(commands.len());
        for command in commands {
            let normalized = validate_command(command)
                .map_err(|_| store_corrupt("本机命令历史中存在无效命令。"))?;
            if normalized != *command || !unique.insert(command) {
                return Err(store_corrupt("本机命令历史中存在重复或未规范化命令。"));
            }
        }
    }
    Ok(())
}

fn validate_connection_id(value: &str) -> AppResult<String> {
    let uuid = Uuid::parse_str(value)
        .map_err(|_| AppError::new("INVALID_INPUT", "服务器连接标识格式不正确。"))?;
    let normalized = uuid.hyphenated().to_string();
    if value.len() != 36 || !normalized.eq_ignore_ascii_case(value) {
        return Err(AppError::new("INVALID_INPUT", "服务器连接标识格式不正确。"));
    }
    Ok(normalized)
}

fn validate_command(value: &str) -> AppResult<String> {
    if value.chars().any(char::is_control) {
        return Err(AppError::new(
            "INVALID_INPUT",
            "命令历史只能保存 1–2048 个字符且不能包含控制字符。",
        ));
    }
    let normalized = value.trim();
    let length = normalized.encode_utf16().count();
    if length == 0 || length > MAX_COMMAND_UTF16 {
        return Err(AppError::new(
            "INVALID_INPUT",
            "命令历史只能保存 1–2048 个字符且不能包含控制字符。",
        ));
    }
    Ok(normalized.to_string())
}

fn store_corrupt(message: impl Into<String>) -> AppError {
    AppError::new("STORE_CORRUPT", message)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONNECTION_ID: &str = "11111111-1111-4111-8111-111111111111";
    const SECOND_CONNECTION_ID: &str = "22222222-2222-4222-8222-222222222222";

    #[test]
    fn history_is_isolated_recent_first_deduplicated_and_persistent() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(COMMAND_HISTORY_FILE);
        let store = CommandHistoryStore::new(path.clone());

        assert_eq!(store.list(CONNECTION_ID).unwrap(), Vec::<String>::new());
        assert_eq!(
            store.record(CONNECTION_ID, " ls -lah ").unwrap(),
            ["ls -lah"]
        );
        assert_eq!(
            store.record(CONNECTION_ID, "pwd").unwrap(),
            ["pwd", "ls -lah"]
        );
        assert_eq!(
            store.record(CONNECTION_ID, "ls -lah").unwrap(),
            ["ls -lah", "pwd"]
        );
        assert_eq!(
            store.record(SECOND_CONNECTION_ID, "whoami").unwrap(),
            ["whoami"]
        );

        let reopened = CommandHistoryStore::new(path);
        assert_eq!(reopened.list(CONNECTION_ID).unwrap(), ["ls -lah", "pwd"]);
        assert_eq!(reopened.list(SECOND_CONNECTION_ID).unwrap(), ["whoami"]);
        let serialized = fs::read_to_string(&reopened.path).unwrap();
        assert!(!serialized.contains("password"));
        assert!(!serialized.contains("username"));
        assert!(!serialized.contains("hostname"));
    }

    #[test]
    fn delete_is_durable_and_never_touches_another_connection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(COMMAND_HISTORY_FILE);
        let store = CommandHistoryStore::new(path.clone());
        store.record(CONNECTION_ID, "journalctl -xe").unwrap();
        store.record(CONNECTION_ID, "pwd").unwrap();
        store.record(SECOND_CONNECTION_ID, "whoami").unwrap();

        assert_eq!(
            store.remove(CONNECTION_ID, "journalctl -xe").unwrap(),
            ["pwd"]
        );

        let reopened = CommandHistoryStore::new(path);
        assert_eq!(reopened.list(CONNECTION_ID).unwrap(), ["pwd"]);
        assert_eq!(reopened.list(SECOND_CONNECTION_ID).unwrap(), ["whoami"]);
    }

    #[test]
    fn history_is_bounded_per_connection() {
        let directory = tempfile::tempdir().unwrap();
        let store = CommandHistoryStore::new(directory.path().join(COMMAND_HISTORY_FILE));
        for index in 0..(MAX_COMMANDS_PER_CONNECTION + 5) {
            store
                .record(CONNECTION_ID, &format!("history-command-{index}"))
                .unwrap();
        }

        let commands = store.list(CONNECTION_ID).unwrap();
        assert_eq!(commands.len(), MAX_COMMANDS_PER_CONNECTION);
        assert_eq!(commands.first().unwrap(), "history-command-204");
        assert_eq!(commands.last().unwrap(), "history-command-5");
    }

    #[test]
    fn malformed_or_credential_shaped_documents_are_rejected_without_overwrite() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(COMMAND_HISTORY_FILE);
        let original = format!(
            r#"{{"version":1,"connections":{{"{CONNECTION_ID}":["pwd"]}},"password":"must-not-exist"}}"#
        );
        fs::write(&path, &original).unwrap();
        let store = CommandHistoryStore::new(path.clone());

        assert_eq!(store.list(CONNECTION_ID).unwrap_err().code, "STORE_CORRUPT");
        assert_eq!(
            store.record(CONNECTION_ID, "whoami").unwrap_err().code,
            "STORE_CORRUPT"
        );
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn invalid_commands_never_enter_the_store() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(COMMAND_HISTORY_FILE);
        let store = CommandHistoryStore::new(path.clone());

        assert_eq!(
            store.record(CONNECTION_ID, "  ").unwrap_err().code,
            "INVALID_INPUT"
        );
        assert_eq!(
            store
                .record(CONNECTION_ID, "printf unsafe\n")
                .unwrap_err()
                .code,
            "INVALID_INPUT"
        );
        assert!(!path.exists());
    }
}
