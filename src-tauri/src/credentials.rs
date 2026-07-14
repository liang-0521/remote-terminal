use crate::{
    error::{AppError, AppResult},
    storage::{validate_id, validate_password},
};
use keyring_core::{api::CredentialStoreApi, Entry};
use serde::Serialize;
use std::{collections::HashMap, sync::Arc, sync::Mutex};
use windows_native_keyring_store::Store as WindowsStore;

const SERVICE_NAME: &str = "com.liang.remote-terminal";
const TARGET_PREFIX: &str = "com.liang.remote-terminal:ssh-password:";
const WINDOWS_PERSISTENCE: &str = "Local";
const MAX_SAVED_ID_QUERY: usize = 10_000;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub available: bool,
    pub protection: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSaveResult {
    pub connection_id: String,
    pub saved: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRemoval {
    pub connection_id: String,
    pub saved: bool,
    pub removed: bool,
}

/// Small boundary used by unit tests and by the Windows implementation.
/// Implementations must never include secret values in returned error messages.
pub trait CredentialBackend: Send + Sync {
    fn is_available(&self) -> bool;
    fn save_password(&self, connection_id: &str, password: &str) -> AppResult<()>;
    fn load_password(&self, connection_id: &str) -> AppResult<Option<String>>;
    fn contains_password(&self, connection_id: &str) -> AppResult<bool>;
    fn delete_password(&self, connection_id: &str) -> AppResult<bool>;
}

/// Serializes operations because Windows Credential Manager does not guarantee
/// operation ordering when the same entry is accessed concurrently.
pub struct CredentialStore {
    backend: Arc<dyn CredentialBackend>,
    gate: Mutex<()>,
}

impl CredentialStore {
    pub fn windows() -> AppResult<Self> {
        Ok(Self::new(Arc::new(WindowsCredentialBackend::new()?)))
    }

    pub fn new(backend: Arc<dyn CredentialBackend>) -> Self {
        Self {
            backend,
            gate: Mutex::new(()),
        }
    }

    pub fn status(&self) -> CredentialStatus {
        CredentialStatus {
            available: self.backend.is_available(),
            protection: "windows-credential-manager".to_string(),
        }
    }

    pub fn save(&self, connection_id: &str, password: &str) -> AppResult<CredentialSaveResult> {
        let id = validate_id(connection_id, "连接标识")?;
        validate_password(password)?;
        self.assert_available()?;
        let _guard = self.lock()?;
        self.backend.save_password(&id, password)?;
        Ok(CredentialSaveResult {
            connection_id: id,
            saved: true,
        })
    }

    pub fn get(&self, connection_id: &str) -> AppResult<String> {
        let id = validate_id(connection_id, "连接标识")?;
        self.assert_available()?;
        let _guard = self.lock()?;
        let secret = self.backend.load_password(&id)?.ok_or_else(|| {
            AppError::new(
                "SAVED_PASSWORD_NOT_FOUND",
                "该连接没有已保存的密码，请重新输入。",
            )
        })?;
        validate_password(&secret).map_err(|_| {
            AppError::new(
                "CREDENTIAL_DECRYPT_FAILED",
                "Windows 返回了无效的已保存密码，请重新输入并保存。",
            )
        })?;
        Ok(secret)
    }

    pub fn has_saved_password(&self, connection_id: &str) -> AppResult<bool> {
        let id = validate_id(connection_id, "连接标识")?;
        if !self.backend.is_available() {
            return Ok(false);
        }
        let _guard = self.lock()?;
        self.backend.contains_password(&id)
    }

    pub fn saved_ids(&self, connection_ids: &[String]) -> AppResult<Vec<String>> {
        if connection_ids.len() > MAX_SAVED_ID_QUERY {
            return Err(AppError::new(
                "INVALID_INPUT",
                "连接标识列表不能超过 10,000 项。",
            ));
        }
        let ids = connection_ids
            .iter()
            .map(|id| validate_id(id, "连接标识"))
            .collect::<AppResult<Vec<_>>>()?;
        if !self.backend.is_available() {
            return Ok(Vec::new());
        }
        let _guard = self.lock()?;
        let mut saved = Vec::new();
        for id in ids {
            if self.backend.contains_password(&id)? {
                saved.push(id);
            }
        }
        Ok(saved)
    }

    pub fn remove(&self, connection_id: &str) -> AppResult<CredentialRemoval> {
        let id = validate_id(connection_id, "连接标识")?;
        self.assert_available()?;
        let _guard = self.lock()?;
        let removed = self.backend.delete_password(&id)?;
        Ok(CredentialRemoval {
            connection_id: id,
            saved: false,
            removed,
        })
    }

    fn assert_available(&self) -> AppResult<()> {
        if self.backend.is_available() {
            Ok(())
        } else {
            Err(AppError::new(
                "CREDENTIAL_STORAGE_UNAVAILABLE",
                "Windows 凭据管理器暂时不可用。",
            ))
        }
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, ()>> {
        self.gate.lock().map_err(|_| {
            AppError::new(
                "CREDENTIAL_STORAGE_UNAVAILABLE",
                "Windows 凭据管理器操作锁不可用。",
            )
        })
    }
}

struct WindowsCredentialBackend {
    store: Arc<WindowsStore>,
}

impl WindowsCredentialBackend {
    fn new() -> AppResult<Self> {
        let store = WindowsStore::new().map_err(|_| {
            AppError::new(
                "CREDENTIAL_STORAGE_UNAVAILABLE",
                "无法初始化 Windows 凭据管理器。",
            )
        })?;
        Ok(Self { store })
    }

    fn entry(&self, connection_id: &str) -> AppResult<Entry> {
        let target = format!("{TARGET_PREFIX}{connection_id}");
        let modifiers = HashMap::from([
            ("target", target.as_str()),
            ("persistence", WINDOWS_PERSISTENCE),
        ]);
        self.store
            .build(SERVICE_NAME, connection_id, Some(&modifiers))
            .map_err(|_| {
                AppError::new(
                    "CREDENTIAL_STORAGE_UNAVAILABLE",
                    "无法访问 Windows 凭据管理器条目。",
                )
            })
    }
}

impl CredentialBackend for WindowsCredentialBackend {
    fn is_available(&self) -> bool {
        true
    }

    fn save_password(&self, connection_id: &str, password: &str) -> AppResult<()> {
        self.entry(connection_id)?
            .set_password(password)
            .map_err(map_save_error)
    }

    fn load_password(&self, connection_id: &str) -> AppResult<Option<String>> {
        match self.entry(connection_id)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(error) => Err(map_read_error(error)),
        }
    }

    fn contains_password(&self, connection_id: &str) -> AppResult<bool> {
        match self.entry(connection_id)?.get_credential() {
            Ok(_) => Ok(true),
            Err(keyring_core::Error::NoEntry) => Ok(false),
            Err(error) => Err(map_access_error(error)),
        }
    }

    fn delete_password(&self, connection_id: &str) -> AppResult<bool> {
        match self.entry(connection_id)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring_core::Error::NoEntry) => Ok(false),
            Err(error) => Err(map_delete_error(error)),
        }
    }
}

fn map_save_error(error: keyring_core::Error) -> AppError {
    if is_storage_unavailable(&error) {
        return storage_unavailable();
    }
    AppError::new(
        "CREDENTIAL_ENCRYPT_FAILED",
        "Windows 无法安全保存该密码，密码未保存。",
    )
}

fn map_read_error(error: keyring_core::Error) -> AppError {
    if is_storage_unavailable(&error) {
        return storage_unavailable();
    }
    AppError::new(
        "CREDENTIAL_DECRYPT_FAILED",
        "Windows 无法读取已保存密码，请重新输入并保存。",
    )
}

fn map_access_error(error: keyring_core::Error) -> AppError {
    if is_storage_unavailable(&error) {
        return storage_unavailable();
    }
    AppError::new("CREDENTIAL_READ_FAILED", "Windows 无法检查已保存密码。")
}

fn map_delete_error(error: keyring_core::Error) -> AppError {
    if is_storage_unavailable(&error) {
        return storage_unavailable();
    }
    AppError::new("CREDENTIAL_DELETE_FAILED", "Windows 无法删除已保存密码。")
}

fn is_storage_unavailable(error: &keyring_core::Error) -> bool {
    matches!(
        error,
        keyring_core::Error::NoStorageAccess(_)
            | keyring_core::Error::PlatformFailure(_)
            | keyring_core::Error::NoDefaultStore
    )
}

fn storage_unavailable() -> AppError {
    AppError::new(
        "CREDENTIAL_STORAGE_UNAVAILABLE",
        "Windows 凭据管理器暂时不可用。",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const CONNECTION_ID: &str = "11111111-1111-4111-8111-111111111111";
    const SECOND_CONNECTION_ID: &str = "22222222-2222-4222-8222-222222222222";

    #[derive(Default)]
    struct FakeCredentialBackend {
        available: bool,
        entries: Mutex<BTreeMap<String, String>>,
    }

    impl FakeCredentialBackend {
        fn available() -> Self {
            Self {
                available: true,
                entries: Mutex::new(BTreeMap::new()),
            }
        }
    }

    impl CredentialBackend for FakeCredentialBackend {
        fn is_available(&self) -> bool {
            self.available
        }

        fn save_password(&self, connection_id: &str, password: &str) -> AppResult<()> {
            self.entries
                .lock()
                .unwrap()
                .insert(connection_id.to_string(), password.to_string());
            Ok(())
        }

        fn load_password(&self, connection_id: &str) -> AppResult<Option<String>> {
            Ok(self.entries.lock().unwrap().get(connection_id).cloned())
        }

        fn contains_password(&self, connection_id: &str) -> AppResult<bool> {
            Ok(self.entries.lock().unwrap().contains_key(connection_id))
        }

        fn delete_password(&self, connection_id: &str) -> AppResult<bool> {
            Ok(self.entries.lock().unwrap().remove(connection_id).is_some())
        }
    }

    #[test]
    fn fake_backend_covers_save_get_query_and_idempotent_remove() {
        let store = CredentialStore::new(Arc::new(FakeCredentialBackend::available()));
        let password = "unique-test-password-密码";
        assert_eq!(
            store.status(),
            CredentialStatus {
                available: true,
                protection: "windows-credential-manager".to_string(),
            }
        );
        assert!(store.save(CONNECTION_ID, password).unwrap().saved);
        assert_eq!(store.get(CONNECTION_ID).unwrap(), password);
        assert_eq!(
            store
                .saved_ids(&[CONNECTION_ID.to_string(), SECOND_CONNECTION_ID.to_string()])
                .unwrap(),
            vec![CONNECTION_ID.to_string()]
        );
        assert!(store.remove(CONNECTION_ID).unwrap().removed);
        assert!(!store.remove(CONNECTION_ID).unwrap().removed);
        assert_eq!(
            store.get(CONNECTION_ID).unwrap_err().code,
            "SAVED_PASSWORD_NOT_FOUND"
        );
    }

    #[test]
    fn invalid_inputs_and_unavailable_backend_fail_explicitly() {
        let unavailable = CredentialStore::new(Arc::new(FakeCredentialBackend::default()));
        assert_eq!(
            unavailable
                .save(CONNECTION_ID, "password")
                .unwrap_err()
                .code,
            "CREDENTIAL_STORAGE_UNAVAILABLE"
        );
        assert_eq!(
            unavailable.save("not-an-id", "password").unwrap_err().code,
            "INVALID_INPUT"
        );
        assert_eq!(
            unavailable.save(CONNECTION_ID, "").unwrap_err().code,
            "INVALID_INPUT"
        );
        assert!(!unavailable.has_saved_password(CONNECTION_ID).unwrap());
    }
}
