use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseBehavior {
    #[default]
    Ask,
    Background,
    Exit,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSettings {
    #[serde(default)]
    close_behavior: CloseBehavior,
}

pub struct AppState {
    settings_path: PathBuf,
    settings: Mutex<PersistedSettings>,
    pending_close_request: Mutex<Option<String>>,
    // This flag is monotonic: only an explicit quit action may change false to true.
    is_quitting: AtomicBool,
}

impl AppState {
    pub fn load(settings_path: PathBuf) -> Result<Self, String> {
        let settings = match fs::read(&settings_path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
                format!(
                    "failed to parse persisted settings at {}: {error}",
                    settings_path.display()
                )
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                PersistedSettings::default()
            }
            Err(error) => {
                return Err(format!(
                    "failed to read persisted settings at {}: {error}",
                    settings_path.display()
                ));
            }
        };

        Ok(Self {
            settings_path,
            settings: Mutex::new(settings),
            pending_close_request: Mutex::new(None),
            is_quitting: AtomicBool::new(false),
        })
    }

    pub fn close_behavior(&self) -> Result<CloseBehavior, String> {
        self.settings
            .lock()
            .map(|settings| settings.close_behavior)
            .map_err(|_| "application settings lock is poisoned".to_string())
    }

    pub fn set_close_behavior(&self, behavior: CloseBehavior) -> Result<(), String> {
        let mut settings = self
            .settings
            .lock()
            .map_err(|_| "application settings lock is poisoned".to_string())?;
        let next = PersistedSettings {
            close_behavior: behavior,
        };
        persist_settings(&self.settings_path, &next)?;
        *settings = next;
        Ok(())
    }

    pub fn is_quitting(&self) -> bool {
        self.is_quitting.load(Ordering::SeqCst)
    }

    /// Starts the one-way quit transition. There is intentionally no reset API.
    pub fn begin_quit(&self) -> bool {
        !self.is_quitting.swap(true, Ordering::SeqCst)
    }

    /// Returns the current one-time close request, or creates one when no
    /// close dialog is pending. Repeated native close events share the token
    /// so an older asynchronous event cannot invalidate a visible dialog.
    pub fn begin_close_request(&self) -> Result<String, String> {
        let mut pending = self
            .pending_close_request
            .lock()
            .map_err(|_| "pending close request lock is poisoned".to_string())?;
        Ok(pending
            .get_or_insert_with(|| Uuid::new_v4().to_string())
            .clone())
    }

    /// Runs an operation only while `request_id` is still the native pending
    /// request. The lock remains held for the synchronous event emission, so
    /// resolving a request cannot race with a stale event for the same token.
    pub fn with_pending_close_request<T>(
        &self,
        request_id: &str,
        operation: impl FnOnce() -> T,
    ) -> Result<Option<T>, String> {
        let pending = self
            .pending_close_request
            .lock()
            .map_err(|_| "pending close request lock is poisoned".to_string())?;
        if pending.as_deref() != Some(request_id) {
            return Ok(None);
        }
        Ok(Some(operation()))
    }

    /// Consumes a genuine native close token exactly once. Invalid or stale
    /// values never clear the currently pending request.
    pub fn consume_close_request(&self, request_id: &str) -> Result<bool, String> {
        if !is_canonical_uuid(request_id) {
            return Ok(false);
        }
        let mut pending = self
            .pending_close_request
            .lock()
            .map_err(|_| "pending close request lock is poisoned".to_string())?;
        if pending.as_deref() != Some(request_id) {
            return Ok(false);
        }
        *pending = None;
        Ok(true)
    }

    pub fn clear_close_request(&self) -> Result<(), String> {
        *self
            .pending_close_request
            .lock()
            .map_err(|_| "pending close request lock is poisoned".to_string())? = None;
        Ok(())
    }
}

fn is_canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value)
        .map(|uuid| uuid.hyphenated().to_string() == value)
        .unwrap_or(false)
}

fn persist_settings(path: &Path, settings: &PersistedSettings) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("settings path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "failed to create settings directory {}: {error}",
            parent.display()
        )
    })?;

    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("failed to serialize application settings: {error}"))?;
    let mut file = AtomicWriteFile::open(path)
        .map_err(|error| format!("failed to open settings file {}: {error}", path.display()))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("failed to persist settings at {}: {error}", path.display()))?;
    file.commit()
        .map_err(|error| format!("failed to commit settings at {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::{AppState, CloseBehavior};
    use tempfile::tempdir;

    #[test]
    fn close_behavior_uses_stable_wire_values() {
        assert_eq!(
            serde_json::to_string(&CloseBehavior::Background).unwrap(),
            "\"background\""
        );
        assert_eq!(
            serde_json::from_str::<CloseBehavior>("\"exit\"").unwrap(),
            CloseBehavior::Exit
        );
    }

    #[test]
    fn close_request_token_is_native_one_time_state() {
        let directory = tempdir().unwrap();
        let state = AppState::load(directory.path().join("settings.json")).unwrap();
        let request_id = state.begin_close_request().unwrap();

        assert_eq!(state.begin_close_request().unwrap(), request_id);
        assert!(!state.consume_close_request("not-a-native-token").unwrap());
        assert!(state.consume_close_request(&request_id).unwrap());
        assert!(!state.consume_close_request(&request_id).unwrap());
    }

    #[test]
    fn clearing_close_request_invalidates_previous_token() {
        let directory = tempdir().unwrap();
        let state = AppState::load(directory.path().join("settings.json")).unwrap();
        let first = state.begin_close_request().unwrap();
        state.clear_close_request().unwrap();
        let second = state.begin_close_request().unwrap();

        assert_ne!(first, second);
        assert!(!state.consume_close_request(&first).unwrap());
        assert!(state.consume_close_request(&second).unwrap());
    }
}
