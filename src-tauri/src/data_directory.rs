use crate::{
    error::{AppError, AppResult},
    storage::{validate_data_directory, MANAGED_DATA_FILES},
};
use std::{
    env, fs,
    fs::OpenOptions,
    io::Write,
    os::windows::fs::MetadataExt,
    path::{Component, Path, PathBuf, Prefix},
};
use uuid::Uuid;

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
const STAGING_DIRECTORY_PREFIX: &str = ".remote-terminal-data-stage-";
const WRITE_PROBE_PREFIX: &str = ".remote-terminal-write-probe-";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DataDirectoryMigration {
    pub migrated_files: Vec<String>,
}

pub fn current_install_data_directory() -> AppResult<PathBuf> {
    let executable = env::current_exe().map_err(|_| {
        AppError::new(
            "INSTALL_DIRECTORY_UNAVAILABLE",
            "无法确定客户端安装目录，不能初始化默认数据目录。",
        )
    })?;
    install_data_directory_for_executable(&executable)
}

pub fn install_data_directory_for_executable(executable: &Path) -> AppResult<PathBuf> {
    if !executable.is_absolute() || executable.file_name().is_none() {
        return Err(AppError::new(
            "INSTALL_DIRECTORY_UNAVAILABLE",
            "客户端可执行文件路径无效，不能初始化默认数据目录。",
        ));
    }
    let install_directory = executable.parent().ok_or_else(|| {
        AppError::new(
            "INSTALL_DIRECTORY_UNAVAILABLE",
            "客户端可执行文件缺少安装目录。",
        )
    })?;
    validate_path_shape(&install_directory.join("data"))
}

/// Validates a path received from the WebView. Only local Windows drive paths
/// are accepted; UNC, device namespaces, roots and lexical traversal are
/// rejected before any filesystem mutation occurs.
pub fn validate_selected_data_directory(value: &str) -> AppResult<PathBuf> {
    if value.is_empty()
        || value.trim() != value
        || value.encode_utf16().count() > 32_767
        || value.chars().any(char::is_control)
    {
        return Err(invalid_path("数据目录路径格式不正确。"));
    }
    validate_path_shape(Path::new(value))
}

/// A configured pointer is authoritative. If its target disappears, startup
/// fails explicitly instead of silently falling back to another data source.
pub fn validate_configured_data_directory(path: &Path) -> AppResult<PathBuf> {
    let normalized = validate_existing_data_directory(path)?;
    verify_directory_writable(&normalized)?;
    Ok(normalized)
}

pub fn validate_existing_data_directory(path: &Path) -> AppResult<PathBuf> {
    let normalized = validate_path_shape(path)?;
    let metadata = fs::symlink_metadata(&normalized).map_err(|_| {
        AppError::new(
            "DATA_DIRECTORY_UNAVAILABLE",
            "已配置的数据目录不存在或当前无法访问。",
        )
    })?;
    if !metadata.is_dir() || is_reparse_point(&metadata) {
        return Err(AppError::new(
            "DATA_DIRECTORY_UNAVAILABLE",
            "已配置的数据目录不是可用的普通本地目录。",
        ));
    }
    validate_existing_components(&normalized)?;
    validate_data_directory(&normalized)?;
    Ok(normalized)
}

pub fn paths_equivalent(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => comparable_path(&left) == comparable_path(&right),
        _ => comparable_path(left) == comparable_path(right),
    }
}

/// Copies only the durable JSON files owned by the native storage
/// layer. Windows Credential Manager data and the WebView2 profile/cache are
/// intentionally outside the allowlist and never enter the staging directory.
pub fn migrate_data_directory(
    source: &Path,
    selected_target: &Path,
) -> AppResult<DataDirectoryMigration> {
    let target = validate_path_shape(selected_target)?;
    if paths_equivalent(source, &target) {
        ensure_target_directory(&target)?;
        validate_data_directory(&target)?;
        verify_directory_writable(&target)?;
        return Ok(DataDirectoryMigration {
            migrated_files: Vec::new(),
        });
    }
    reject_overlapping_directories(source, &target)?;
    validate_migration_source(source)?;

    let parent = target
        .parent()
        .ok_or_else(|| invalid_path("数据目录缺少父目录。"))?;
    fs::create_dir_all(parent).map_err(|_| {
        AppError::new(
            "DATA_DIRECTORY_CREATE_FAILED",
            "无法创建所选数据目录的父目录。",
        )
    })?;
    validate_existing_components(parent)?;

    let staging_path = parent.join(format!("{STAGING_DIRECTORY_PREFIX}{}", Uuid::new_v4()));
    fs::create_dir(&staging_path).map_err(|_| {
        AppError::new(
            "DATA_DIRECTORY_MIGRATION_FAILED",
            "无法创建数据迁移临时目录。",
        )
    })?;
    let staging = StagingDirectory::new(staging_path);
    let mut migrated_files = Vec::new();

    for file_name in MANAGED_DATA_FILES {
        let source_file = source.join(file_name);
        let Some(metadata) = regular_file_metadata(&source_file, true)? else {
            continue;
        };
        let staged_file = staging.path().join(file_name);
        let copied = fs::copy(&source_file, &staged_file).map_err(|_| {
            AppError::new(
                "DATA_DIRECTORY_MIGRATION_FAILED",
                "无法把客户端数据复制到迁移临时目录。",
            )
        })?;
        if copied != metadata.len() {
            return Err(AppError::new(
                "DATA_DIRECTORY_MIGRATION_FAILED",
                "客户端数据复制不完整，目录切换已取消。",
            ));
        }
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(&staged_file)
            .and_then(|file| file.sync_all())
            .map_err(|_| {
                AppError::new(
                    "DATA_DIRECTORY_MIGRATION_FAILED",
                    "无法同步迁移临时文件，目录切换已取消。",
                )
            })?;
        migrated_files.push(file_name.to_string());
    }

    validate_data_directory(staging.path())?;
    ensure_target_directory(&target)?;
    verify_directory_writable(&target)?;
    validate_target_conflicts(staging.path(), &target)?;

    for file_name in &migrated_files {
        let staged_file = staging.path().join(file_name);
        let target_file = target.join(file_name);
        if target_file.exists() {
            continue;
        }
        fs::rename(&staged_file, &target_file).map_err(|_| {
            AppError::new(
                "DATA_DIRECTORY_MIGRATION_FAILED",
                "无法提交迁移后的客户端数据，目录切换已取消。",
            )
        })?;
    }

    validate_data_directory(&target)?;
    Ok(DataDirectoryMigration { migrated_files })
}

fn validate_path_shape(path: &Path) -> AppResult<PathBuf> {
    if !path.is_absolute() {
        return Err(invalid_path("数据目录必须是 Windows 绝对路径。"));
    }

    let mut normalized = PathBuf::new();
    let mut normal_component_count = 0;
    let mut accepted_prefix = false;
    let mut accepted_root = false;
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => match prefix.kind() {
                Prefix::Disk(_) | Prefix::VerbatimDisk(_) => {
                    accepted_prefix = true;
                    normalized.push(component.as_os_str());
                }
                _ => {
                    return Err(AppError::new(
                        "DATA_DIRECTORY_UNSUPPORTED",
                        "数据目录只支持本机磁盘，暂不支持 UNC 或设备路径。",
                    ));
                }
            },
            Component::RootDir => {
                accepted_root = true;
                normalized.push(component.as_os_str());
            }
            Component::Normal(_) => {
                normal_component_count += 1;
                normalized.push(component.as_os_str());
            }
            Component::CurDir | Component::ParentDir => {
                return Err(invalid_path("数据目录不能包含 . 或 .. 路径段。"));
            }
        }
    }
    if !accepted_prefix || !accepted_root || normal_component_count == 0 {
        return Err(invalid_path("不能把磁盘根目录用作客户端数据目录。"));
    }
    validate_existing_components(&normalized)?;
    if let Ok(metadata) = fs::symlink_metadata(&normalized) {
        if !metadata.is_dir() || is_reparse_point(&metadata) {
            return Err(AppError::new(
                "DATA_DIRECTORY_UNAVAILABLE",
                "所选数据目录不是可用的普通本地目录。",
            ));
        }
    }
    Ok(normalized)
}

fn validate_existing_components(path: &Path) -> AppResult<()> {
    let mut current = PathBuf::new();
    let mut reached_root = false;
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::RootDir) {
            reached_root = true;
        }
        if !reached_root {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if is_reparse_point(&metadata) => {
                return Err(AppError::new(
                    "DATA_DIRECTORY_REPARSE_POINT",
                    "数据目录不能位于符号链接、目录联接或其他重解析点中。",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => {
                return Err(AppError::new(
                    "DATA_DIRECTORY_UNAVAILABLE",
                    "无法验证所选数据目录。",
                ));
            }
        }
    }
    Ok(())
}

fn validate_migration_source(source: &Path) -> AppResult<()> {
    let source = validate_path_shape(source)?;
    match fs::symlink_metadata(&source) {
        Ok(metadata) if metadata.is_dir() && !is_reparse_point(&metadata) => {
            validate_data_directory(&source)
        }
        Ok(_) => Err(AppError::new(
            "DATA_DIRECTORY_SOURCE_INVALID",
            "原客户端数据路径不是普通本地目录，迁移已停止。",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(AppError::new(
            "DATA_DIRECTORY_UNAVAILABLE",
            "无法读取原客户端数据目录，迁移已停止。",
        )),
    }
}

fn ensure_target_directory(target: &Path) -> AppResult<()> {
    fs::create_dir_all(target).map_err(|_| {
        AppError::new(
            "DATA_DIRECTORY_CREATE_FAILED",
            "无法创建所选客户端数据目录。",
        )
    })?;
    validate_existing_components(target)?;
    let metadata = fs::symlink_metadata(target)
        .map_err(|_| AppError::new("DATA_DIRECTORY_UNAVAILABLE", "无法验证所选客户端数据目录。"))?;
    if !metadata.is_dir() || is_reparse_point(&metadata) {
        return Err(AppError::new(
            "DATA_DIRECTORY_UNAVAILABLE",
            "所选客户端数据目录不是普通本地目录。",
        ));
    }
    Ok(())
}

fn verify_directory_writable(directory: &Path) -> AppResult<()> {
    let probe_path = directory.join(format!("{WRITE_PROBE_PREFIX}{}.tmp", Uuid::new_v4()));
    let write_result = (|| -> std::io::Result<()> {
        let mut probe = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&probe_path)?;
        probe.write_all(b"remote-terminal-data-directory-write-probe")?;
        probe.sync_all()
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&probe_path);
        return Err(AppError::new(
            "DATA_DIRECTORY_NOT_WRITABLE",
            "客户端数据目录不可写，请选择有写入权限的安装位置或自定义数据目录。",
        ));
    }
    fs::remove_file(&probe_path).map_err(|_| {
        AppError::new(
            "DATA_DIRECTORY_NOT_WRITABLE",
            "客户端数据目录写入测试文件无法清理，启动已停止。",
        )
    })
}

fn validate_target_conflicts(staging: &Path, target: &Path) -> AppResult<()> {
    for file_name in MANAGED_DATA_FILES {
        let staged_file = staging.join(file_name);
        let target_file = target.join(file_name);
        let staged = regular_file_metadata(&staged_file, false)?;
        let existing = regular_file_metadata(&target_file, false)?;
        match (staged, existing) {
            (None, None) | (Some(_), None) => {}
            (None, Some(_)) => {
                return Err(AppError::new(
                    "DATA_DIRECTORY_CONFLICT",
                    format!("所选目录已包含不属于当前数据源的 {file_name}。"),
                ));
            }
            (Some(_), Some(_)) => {
                let staged_bytes = fs::read(&staged_file).map_err(|_| {
                    AppError::new("DATA_DIRECTORY_MIGRATION_FAILED", "无法校验迁移临时文件。")
                })?;
                let target_bytes = fs::read(&target_file).map_err(|_| {
                    AppError::new("DATA_DIRECTORY_MIGRATION_FAILED", "无法校验目标数据文件。")
                })?;
                if staged_bytes != target_bytes {
                    return Err(AppError::new(
                        "DATA_DIRECTORY_CONFLICT",
                        format!("所选目录中的 {file_name} 与当前客户端数据冲突。"),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn regular_file_metadata(path: &Path, source: bool) -> AppResult<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !is_reparse_point(&metadata) => Ok(Some(metadata)),
        Ok(_) => Err(AppError::new(
            if source {
                "DATA_DIRECTORY_SOURCE_INVALID"
            } else {
                "DATA_DIRECTORY_CONFLICT"
            },
            "客户端数据目录包含非普通文件或重解析点。",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(AppError::new(
            "DATA_DIRECTORY_UNAVAILABLE",
            "无法检查客户端数据目录中的文件。",
        )),
    }
}

fn reject_overlapping_directories(source: &Path, target: &Path) -> AppResult<()> {
    let source = comparable_path(source);
    let target = comparable_path(target);
    let source_prefix = format!("{source}\\");
    let target_prefix = format!("{target}\\");
    if target.starts_with(&source_prefix) || source.starts_with(&target_prefix) {
        return Err(AppError::new(
            "DATA_DIRECTORY_OVERLAP",
            "新旧数据目录不能互相包含。",
        ));
    }
    Ok(())
}

fn comparable_path(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('/', "\\");
    if let Some(stripped) = value.strip_prefix("\\\\?\\") {
        value = stripped.to_string();
    }
    while value.len() > 3 && value.ends_with('\\') {
        value.pop();
    }
    value.to_lowercase()
}

fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn invalid_path(message: impl Into<String>) -> AppError {
    AppError::new("INVALID_DATA_DIRECTORY", message)
}

struct StagingDirectory {
    path: PathBuf,
}

impl StagingDirectory {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        for file_name in MANAGED_DATA_FILES {
            let file = self.path.join(file_name);
            if file.is_file() {
                let _ = fs::remove_file(file);
            }
        }
        let _ = fs::remove_dir(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_valid_stores(directory: &Path) {
        fs::create_dir_all(directory).unwrap();
        fs::write(
            directory.join("connections.json"),
            br#"{"version":1,"connections":[]}"#,
        )
        .unwrap();
        fs::write(
            directory.join("known-hosts.json"),
            br#"{"version":1,"hosts":{}}"#,
        )
        .unwrap();
        fs::write(
            directory.join("command-history.json"),
            br#"{"version":1,"connections":{"11111111-1111-4111-8111-111111111111":["ls -lah"]}}"#,
        )
        .unwrap();
    }

    fn write_valid_legacy_marker(directory: &Path) {
        fs::write(
            directory.join("legacy-electron-v0.1-import.json"),
            br#"{"state":"completed","version":1,"completedAt":"2026-01-02T03:04:05.678Z","result":{"detected":true,"completed":true,"alreadyCompleted":false,"importedConnections":0,"skippedConnections":0,"importedKnownHosts":0,"skippedKnownHosts":0,"credentialsDetected":false,"credentialsMigrated":false,"passwordReentryRequired":false}}"#,
        )
        .unwrap();
    }

    #[test]
    fn install_default_is_the_data_folder_beside_the_executable() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("remote-terminal.exe");

        let data_directory = install_data_directory_for_executable(&executable).unwrap();

        assert_eq!(data_directory, root.path().join("data"));
        assert_eq!(
            install_data_directory_for_executable(Path::new("remote-terminal.exe"))
                .unwrap_err()
                .code,
            "INSTALL_DIRECTORY_UNAVAILABLE"
        );
    }

    #[test]
    fn selected_path_rejects_relative_root_and_unc_paths() {
        assert_eq!(
            validate_selected_data_directory("relative\\data")
                .unwrap_err()
                .code,
            "INVALID_DATA_DIRECTORY"
        );
        assert_eq!(
            validate_selected_data_directory("C:\\").unwrap_err().code,
            "INVALID_DATA_DIRECTORY"
        );
        assert_eq!(
            validate_selected_data_directory("\\\\server\\share\\data")
                .unwrap_err()
                .code,
            "DATA_DIRECTORY_UNSUPPORTED"
        );
        assert_eq!(
            validate_selected_data_directory("C:\\data\\..\\other")
                .unwrap_err()
                .code,
            "INVALID_DATA_DIRECTORY"
        );
    }

    #[test]
    fn configured_pointer_must_resolve_to_an_existing_directory() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing");
        assert_eq!(
            validate_configured_data_directory(&missing)
                .unwrap_err()
                .code,
            "DATA_DIRECTORY_UNAVAILABLE"
        );
    }

    #[test]
    fn migration_copies_only_owned_json_and_retains_source() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        write_valid_stores(&source);
        write_valid_legacy_marker(&source);
        fs::write(source.join("credentials.json"), b"must-stay-in-source").unwrap();
        fs::write(source.join("EBWebView.cache"), b"must-not-migrate").unwrap();
        let connections_before = fs::read(source.join("connections.json")).unwrap();

        let result = migrate_data_directory(&source, &target).unwrap();

        assert_eq!(
            result.migrated_files,
            vec![
                "connections.json",
                "known-hosts.json",
                "legacy-electron-v0.1-import.json",
                "command-history.json"
            ]
        );
        assert_eq!(
            fs::read(target.join("connections.json")).unwrap(),
            connections_before
        );
        assert!(source.join("connections.json").is_file());
        assert!(source.join("command-history.json").is_file());
        assert_eq!(
            fs::read(target.join("command-history.json")).unwrap(),
            fs::read(source.join("command-history.json")).unwrap()
        );
        assert!(source.join("credentials.json").is_file());
        assert!(!target.join("credentials.json").exists());
        assert!(!target.join("EBWebView.cache").exists());
        assert_eq!(
            fs::read(target.join("legacy-electron-v0.1-import.json")).unwrap(),
            fs::read(source.join("legacy-electron-v0.1-import.json")).unwrap()
        );
        assert!(fs::read_dir(&target).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(WRITE_PROBE_PREFIX)));
        assert!(fs::read_dir(root.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(STAGING_DIRECTORY_PREFIX)));
    }

    #[test]
    fn conflicting_target_is_never_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        write_valid_stores(&source);
        fs::create_dir_all(&target).unwrap();
        let conflict = br#"{"version":1,"connections":["conflict"]}"#;
        fs::write(target.join("connections.json"), conflict).unwrap();

        let error = migrate_data_directory(&source, &target).unwrap_err();

        assert_eq!(error.code, "DATA_DIRECTORY_CONFLICT");
        assert_eq!(fs::read(target.join("connections.json")).unwrap(), conflict);
        assert!(source.join("connections.json").is_file());
    }

    #[test]
    fn overlapping_directories_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        write_valid_stores(&source);
        let error = migrate_data_directory(&source, &source.join("nested")).unwrap_err();
        assert_eq!(error.code, "DATA_DIRECTORY_OVERLAP");
    }

    #[test]
    fn unavailable_install_directory_fails_without_fallback() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let blocked_parent = root.path().join("blocked");
        write_valid_stores(&source);
        fs::write(&blocked_parent, b"not-a-directory").unwrap();

        let error = migrate_data_directory(&source, &blocked_parent.join("data")).unwrap_err();

        assert_eq!(error.code, "DATA_DIRECTORY_CREATE_FAILED");
        assert!(source.join("connections.json").is_file());
        assert!(!blocked_parent.join("data").exists());
    }

    #[test]
    fn invalid_migration_source_is_not_treated_as_empty() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        fs::write(&source, b"not-a-directory").unwrap();

        let error = migrate_data_directory(&source, &target).unwrap_err();

        assert_eq!(error.code, "DATA_DIRECTORY_UNAVAILABLE");
        assert!(!target.exists());
    }

    #[test]
    fn reparse_attribute_detection_is_explicit() {
        assert_ne!(FILE_ATTRIBUTE_REPARSE_POINT, 0);
    }
}
