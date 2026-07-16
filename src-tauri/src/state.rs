use crate::data_directory::{
    migrate_data_directory, paths_equivalent, validate_configured_data_directory,
    validate_existing_data_directory,
};
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

const INSTALL_DATA_MIGRATION_VERSION: u32 = 1;
const DEFAULT_EXPLORER_WIDTH: f64 = 320.0;
const DEFAULT_BOTTOM_PANEL_HEIGHT: f64 = 344.0;
const DEFAULT_MONITOR_INTERVAL_SECONDS: u64 = 1;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseBehavior {
    #[default]
    Ask,
    Background,
    Exit,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InterfaceThemeMode {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandAssistanceMode {
    #[default]
    Auto,
    Shortcut,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExplorerPlacement {
    #[default]
    Left,
    Right,
    Bottom,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppearancePreferences {
    pub accent: String,
    pub terminal_background: String,
    pub terminal_foreground: String,
    pub wallpaper_opacity: f64,
}

impl Default for AppearancePreferences {
    fn default() -> Self {
        Self {
            accent: "#9d84f8".to_string(),
            terminal_background: "#061423".to_string(),
            terminal_foreground: "#c8cbd1".to_string(),
            wallpaper_opacity: 0.22,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiPreferences {
    #[serde(default)]
    pub interface_theme_mode: InterfaceThemeMode,
    #[serde(default)]
    pub appearance: AppearancePreferences,
    #[serde(default = "default_explorer_width")]
    pub explorer_width: f64,
    #[serde(default)]
    pub explorer_placement: ExplorerPlacement,
    #[serde(default)]
    pub explorer_collapsed: bool,
    #[serde(default)]
    pub rail_expanded: bool,
    #[serde(default = "default_true")]
    pub bottom_visible: bool,
    #[serde(default)]
    pub bottom_collapsed: bool,
    #[serde(default = "default_bottom_panel_height")]
    pub bottom_panel_height: f64,
    #[serde(default)]
    pub command_assistance_mode: CommandAssistanceMode,
    #[serde(default = "default_monitor_interval_seconds")]
    pub monitor_interval_seconds: u64,
}

impl Default for UiPreferences {
    fn default() -> Self {
        Self {
            interface_theme_mode: InterfaceThemeMode::System,
            appearance: AppearancePreferences::default(),
            explorer_width: DEFAULT_EXPLORER_WIDTH,
            explorer_placement: ExplorerPlacement::Left,
            explorer_collapsed: false,
            rail_expanded: false,
            bottom_visible: true,
            bottom_collapsed: false,
            bottom_panel_height: DEFAULT_BOTTOM_PANEL_HEIGHT,
            command_assistance_mode: CommandAssistanceMode::Auto,
            monitor_interval_seconds: DEFAULT_MONITOR_INTERVAL_SECONDS,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowPlacement {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSettings {
    #[serde(default)]
    close_behavior: CloseBehavior,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data_directory: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "is_zero")]
    install_data_migration_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    install_data_directory: Option<PathBuf>,
    #[serde(default)]
    ui_preferences: UiPreferences,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    window_placement: Option<WindowPlacement>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirectoryStatus {
    pub current_path: String,
    pub default_path: String,
    pub pending_path: Option<String>,
    pub restart_required: bool,
}

pub struct AppState {
    settings_path: PathBuf,
    default_data_directory: PathBuf,
    active_data_directory: PathBuf,
    settings: Mutex<PersistedSettings>,
    pending_close_request: Mutex<Option<String>>,
    // This flag is monotonic: only an explicit quit action may change false to true.
    is_quitting: AtomicBool,
}

impl AppState {
    pub fn load(
        settings_path: PathBuf,
        default_data_directory: PathBuf,
        previous_default_data_directory: PathBuf,
    ) -> Result<Self, String> {
        let mut settings = match fs::read(&settings_path) {
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
        validate_install_data_migration_settings(&settings)?;
        validate_ui_preferences(&settings.ui_preferences)?;
        if let Some(placement) = settings.window_placement.as_ref() {
            validate_window_placement(placement)?;
        }
        let active_data_directory = match settings.data_directory.as_deref() {
            Some(configured) => {
                validate_configured_data_directory(configured).map_err(|error| {
                    format!(
                        "configured data directory is unavailable ({}): {}",
                        error.code, error.message
                    )
                })?
            }
            None => initialize_install_data_directory(
                &settings_path,
                &mut settings,
                &default_data_directory,
                &previous_default_data_directory,
            )?,
        };

        Ok(Self {
            settings_path,
            default_data_directory,
            active_data_directory,
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
        let mut next = settings.clone();
        next.close_behavior = behavior;
        persist_settings(&self.settings_path, &next)?;
        *settings = next;
        Ok(())
    }

    pub fn ui_preferences(&self) -> Result<UiPreferences, String> {
        self.settings
            .lock()
            .map(|settings| settings.ui_preferences.clone())
            .map_err(|_| "application settings lock is poisoned".to_string())
    }

    pub fn set_ui_preferences(&self, preferences: UiPreferences) -> Result<(), String> {
        validate_ui_preferences(&preferences)?;
        let mut settings = self
            .settings
            .lock()
            .map_err(|_| "application settings lock is poisoned".to_string())?;
        let mut next = settings.clone();
        next.ui_preferences = preferences;
        persist_settings(&self.settings_path, &next)?;
        *settings = next;
        Ok(())
    }

    pub fn window_placement(&self) -> Result<Option<WindowPlacement>, String> {
        self.settings
            .lock()
            .map(|settings| settings.window_placement)
            .map_err(|_| "application settings lock is poisoned".to_string())
    }

    pub fn remember_window_placement(&self, placement: WindowPlacement) -> Result<(), String> {
        validate_window_placement(&placement)?;
        self.settings
            .lock()
            .map(|mut settings| settings.window_placement = Some(placement))
            .map_err(|_| "application settings lock is poisoned".to_string())
    }

    pub fn set_window_placement(&self, placement: WindowPlacement) -> Result<(), String> {
        validate_window_placement(&placement)?;
        let mut settings = self
            .settings
            .lock()
            .map_err(|_| "application settings lock is poisoned".to_string())?;
        let mut next = settings.clone();
        next.window_placement = Some(placement);
        persist_settings(&self.settings_path, &next)?;
        *settings = next;
        Ok(())
    }

    pub fn data_directory_status(&self) -> Result<DataDirectoryStatus, String> {
        let settings = self
            .settings
            .lock()
            .map_err(|_| "application settings lock is poisoned".to_string())?;
        let configured = settings
            .data_directory
            .as_deref()
            .unwrap_or(&self.default_data_directory);
        let pending = (!paths_equivalent(configured, &self.active_data_directory))
            .then(|| path_text(configured))
            .transpose()?;
        Ok(DataDirectoryStatus {
            current_path: path_text(&self.active_data_directory)?,
            default_path: path_text(&self.default_data_directory)?,
            restart_required: pending.is_some(),
            pending_path: pending,
        })
    }

    pub fn active_data_directory(&self) -> PathBuf {
        self.active_data_directory.clone()
    }

    /// Persists the next-start pointer only after the migration transaction
    /// has completed. The active stores remain unchanged until process restart.
    pub fn set_data_directory(&self, path: &Path) -> Result<DataDirectoryStatus, String> {
        let path = validate_configured_data_directory(path).map_err(|error| {
            format!(
                "selected data directory is unavailable ({}): {}",
                error.code, error.message
            )
        })?;
        let mut settings = self
            .settings
            .lock()
            .map_err(|_| "application settings lock is poisoned".to_string())?;
        let mut next = settings.clone();
        if paths_equivalent(&path, &self.default_data_directory) {
            next.data_directory = None;
            next.install_data_migration_version = INSTALL_DATA_MIGRATION_VERSION;
            next.install_data_directory = Some(self.default_data_directory.clone());
        } else {
            next.data_directory = Some(path);
        }
        persist_settings(&self.settings_path, &next)?;
        *settings = next;
        drop(settings);
        self.data_directory_status()
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

fn initialize_install_data_directory(
    settings_path: &Path,
    settings: &mut PersistedSettings,
    install_data_directory: &Path,
    previous_default_data_directory: &Path,
) -> Result<PathBuf, String> {
    if settings.install_data_migration_version == INSTALL_DATA_MIGRATION_VERSION {
        let initialized_directory = settings
            .install_data_directory
            .as_deref()
            .ok_or_else(|| "install data migration marker is missing its directory".to_string())?;
        if paths_equivalent(initialized_directory, install_data_directory) {
            return validate_configured_data_directory(install_data_directory).map_err(|error| {
                format!(
                    "install data directory is unavailable ({}): {}",
                    error.code, error.message
                )
            });
        }
        validate_existing_data_directory(initialized_directory).map_err(|error| {
            format!(
                "previous install data directory is unavailable ({}): {}",
                error.code, error.message
            )
        })?;
    }

    let source = settings
        .install_data_directory
        .as_deref()
        .unwrap_or(previous_default_data_directory);
    migrate_data_directory(source, install_data_directory).map_err(|error| {
        format!(
            "failed to migrate data into the install directory ({}): {}",
            error.code, error.message
        )
    })?;
    let active = validate_configured_data_directory(install_data_directory).map_err(|error| {
        format!(
            "install data directory is unavailable ({}): {}",
            error.code, error.message
        )
    })?;
    settings.install_data_migration_version = INSTALL_DATA_MIGRATION_VERSION;
    settings.install_data_directory = Some(active.clone());
    persist_settings(settings_path, settings)?;
    Ok(active)
}

fn validate_install_data_migration_settings(settings: &PersistedSettings) -> Result<(), String> {
    match (
        settings.install_data_migration_version,
        settings.install_data_directory.is_some(),
    ) {
        (0, false) | (INSTALL_DATA_MIGRATION_VERSION, true) => Ok(()),
        (0, true) => Err("install data directory exists without a migration version".to_string()),
        (INSTALL_DATA_MIGRATION_VERSION, false) => {
            Err("install data migration version exists without a directory".to_string())
        }
        _ => Err("install data migration version is not supported".to_string()),
    }
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

fn default_true() -> bool {
    true
}

fn default_explorer_width() -> f64 {
    DEFAULT_EXPLORER_WIDTH
}

fn default_bottom_panel_height() -> f64 {
    DEFAULT_BOTTOM_PANEL_HEIGHT
}

fn default_monitor_interval_seconds() -> u64 {
    DEFAULT_MONITOR_INTERVAL_SECONDS
}

fn validate_ui_preferences(preferences: &UiPreferences) -> Result<(), String> {
    for (label, color) in [
        ("accent", &preferences.appearance.accent),
        (
            "terminal background",
            &preferences.appearance.terminal_background,
        ),
        (
            "terminal foreground",
            &preferences.appearance.terminal_foreground,
        ),
    ] {
        if !is_hex_color(color) {
            return Err(format!("{label} color is invalid"));
        }
    }
    if !preferences.appearance.wallpaper_opacity.is_finite()
        || !(0.0..=1.0).contains(&preferences.appearance.wallpaper_opacity)
    {
        return Err("wallpaper opacity is invalid".to_string());
    }
    if !preferences.explorer_width.is_finite()
        || !(220.0..=520.0).contains(&preferences.explorer_width)
    {
        return Err("explorer width is invalid".to_string());
    }
    if !preferences.bottom_panel_height.is_finite()
        || !(120.0..=1_000.0).contains(&preferences.bottom_panel_height)
    {
        return Err("bottom panel height is invalid".to_string());
    }
    if ![1, 2, 5, 10, 30].contains(&preferences.monitor_interval_seconds) {
        return Err("monitor interval is invalid".to_string());
    }
    Ok(())
}

fn validate_window_placement(placement: &WindowPlacement) -> Result<(), String> {
    if placement.width < 1024
        || placement.height < 700
        || placement.width > 16_384
        || placement.height > 16_384
    {
        return Err("window placement size is invalid".to_string());
    }
    Ok(())
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}

fn path_text(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "data directory path is not valid Unicode".to_string())
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
    use super::{
        AppState, CloseBehavior, CommandAssistanceMode, ExplorerPlacement, InterfaceThemeMode,
        UiPreferences, WindowPlacement,
    };
    use std::fs;
    use tempfile::tempdir;

    fn load_state(directory: &tempfile::TempDir) -> AppState {
        AppState::load(
            directory.path().join("settings.json"),
            directory.path().join("default-data"),
            directory.path().join("previous-default-data"),
        )
        .unwrap()
    }

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
        let state = load_state(&directory);
        let request_id = state.begin_close_request().unwrap();

        assert_eq!(state.begin_close_request().unwrap(), request_id);
        assert!(!state.consume_close_request("not-a-native-token").unwrap());
        assert!(state.consume_close_request(&request_id).unwrap());
        assert!(!state.consume_close_request(&request_id).unwrap());
    }

    #[test]
    fn clearing_close_request_invalidates_previous_token() {
        let directory = tempdir().unwrap();
        let state = load_state(&directory);
        let first = state.begin_close_request().unwrap();
        state.clear_close_request().unwrap();
        let second = state.begin_close_request().unwrap();

        assert_ne!(first, second);
        assert!(!state.consume_close_request(&first).unwrap());
        assert!(state.consume_close_request(&second).unwrap());
    }

    #[test]
    fn data_directory_pointer_is_pending_until_restart_and_preserves_close_behavior() {
        let directory = tempdir().unwrap();
        let settings_path = directory.path().join("settings.json");
        let default_path = directory.path().join("default-data");
        let custom_path = directory.path().join("custom-data");
        fs::create_dir_all(&custom_path).unwrap();
        let previous_default = directory.path().join("previous-default-data");
        let state = AppState::load(
            settings_path.clone(),
            default_path.clone(),
            previous_default.clone(),
        )
        .unwrap();
        state.set_close_behavior(CloseBehavior::Background).unwrap();

        let pending = state.set_data_directory(&custom_path).unwrap();

        assert_eq!(pending.current_path, default_path.to_string_lossy());
        assert_eq!(pending.pending_path.as_deref(), custom_path.to_str());
        assert!(pending.restart_required);

        let restarted = AppState::load(settings_path, default_path, previous_default).unwrap();
        let active = restarted.data_directory_status().unwrap();
        assert_eq!(active.current_path, custom_path.to_string_lossy());
        assert_eq!(active.pending_path, None);
        assert!(!active.restart_required);
        assert_eq!(
            restarted.close_behavior().unwrap(),
            CloseBehavior::Background
        );
    }

    #[test]
    fn ui_preferences_and_window_placement_survive_restart() {
        let directory = tempdir().unwrap();
        let settings_path = directory.path().join("settings.json");
        let default_path = directory.path().join("default-data");
        let previous_default = directory.path().join("previous-default-data");
        let state = AppState::load(
            settings_path.clone(),
            default_path.clone(),
            previous_default.clone(),
        )
        .unwrap();
        let mut preferences = UiPreferences::default();
        preferences.interface_theme_mode = InterfaceThemeMode::Dark;
        preferences.appearance.accent = "#60a5fa".to_string();
        preferences.appearance.terminal_background = "#000000".to_string();
        preferences.explorer_width = 408.0;
        preferences.explorer_placement = ExplorerPlacement::Right;
        preferences.explorer_collapsed = true;
        preferences.bottom_panel_height = 292.0;
        preferences.command_assistance_mode = CommandAssistanceMode::Shortcut;
        preferences.monitor_interval_seconds = 10;
        let placement = WindowPlacement {
            x: 140,
            y: 90,
            width: 1280,
            height: 760,
            maximized: false,
        };

        state.set_ui_preferences(preferences.clone()).unwrap();
        state.set_window_placement(placement).unwrap();

        let restarted = AppState::load(settings_path, default_path, previous_default).unwrap();
        assert_eq!(restarted.ui_preferences().unwrap(), preferences);
        assert_eq!(restarted.window_placement().unwrap(), Some(placement));
    }

    #[test]
    fn invalid_ui_preferences_never_replace_persisted_settings() {
        let directory = tempdir().unwrap();
        let state = load_state(&directory);
        let original = state.ui_preferences().unwrap();
        let mut invalid = original.clone();
        invalid.monitor_interval_seconds = 3;

        assert!(state.set_ui_preferences(invalid).is_err());
        assert_eq!(state.ui_preferences().unwrap(), original);
    }

    #[test]
    fn default_directory_pointer_is_idempotent_after_startup_initialization() {
        let directory = tempdir().unwrap();
        let default_path = directory.path().join("default-data");
        let state = AppState::load(
            directory.path().join("settings.json"),
            default_path.clone(),
            directory.path().join("previous-default-data"),
        )
        .unwrap();

        let status = state.set_data_directory(&default_path).unwrap();

        assert_eq!(status.current_path, default_path.to_string_lossy());
        assert_eq!(status.pending_path, None);
        assert!(!status.restart_required);
        assert!(default_path.is_dir());
    }

    #[test]
    fn first_install_default_start_migrates_previous_tauri_data_once() {
        let directory = tempdir().unwrap();
        let settings_path = directory.path().join("settings.json");
        let install_data = directory.path().join("install").join("data");
        let previous_default = directory.path().join("roaming-app-data").join("data");
        fs::create_dir_all(&previous_default).unwrap();
        fs::write(
            previous_default.join("connections.json"),
            br#"{"version":1,"connections":[]}"#,
        )
        .unwrap();
        fs::write(
            previous_default.join("known-hosts.json"),
            br#"{"version":1,"hosts":{}}"#,
        )
        .unwrap();

        let state = AppState::load(
            settings_path.clone(),
            install_data.clone(),
            previous_default.clone(),
        )
        .unwrap();

        let status = state.data_directory_status().unwrap();
        assert_eq!(status.current_path, install_data.to_string_lossy());
        assert_eq!(status.default_path, install_data.to_string_lossy());
        assert_eq!(
            fs::read(install_data.join("connections.json")).unwrap(),
            fs::read(previous_default.join("connections.json")).unwrap()
        );
        assert!(previous_default.join("connections.json").is_file());
        let persisted: serde_json::Value =
            serde_json::from_slice(&fs::read(&settings_path).unwrap()).unwrap();
        assert_eq!(persisted["installDataMigrationVersion"], 1);
        assert_eq!(
            persisted["installDataDirectory"],
            install_data.to_string_lossy().as_ref()
        );

        fs::write(
            previous_default.join("connections.json"),
            br#"{"version":999,"connections":[]}"#,
        )
        .unwrap();
        let restarted = AppState::load(settings_path, install_data, previous_default).unwrap();
        assert!(!restarted.data_directory_status().unwrap().restart_required);
    }

    #[test]
    fn custom_directory_skips_install_default_migration() {
        let directory = tempdir().unwrap();
        let settings_path = directory.path().join("settings.json");
        let install_data = directory.path().join("install").join("data");
        let custom_data = directory.path().join("custom-data");
        let previous_default = directory.path().join("previous-default-data");
        fs::create_dir_all(&custom_data).unwrap();
        fs::create_dir_all(&previous_default).unwrap();
        fs::write(
            previous_default.join("connections.json"),
            br#"{"version":999,"connections":[]}"#,
        )
        .unwrap();
        fs::write(
            &settings_path,
            serde_json::to_vec(&serde_json::json!({
                "closeBehavior": "ask",
                "dataDirectory": custom_data,
            }))
            .unwrap(),
        )
        .unwrap();

        let state = AppState::load(settings_path, install_data.clone(), previous_default).unwrap();

        let status = state.data_directory_status().unwrap();
        assert_eq!(status.current_path, custom_data.to_string_lossy());
        assert_eq!(status.default_path, install_data.to_string_lossy());
        assert!(!install_data.exists());
    }
}
