#![allow(dead_code)]

#[path = "../src/error.rs"]
mod error;
#[path = "../src/monitor.rs"]
mod monitor;
#[path = "../src/ssh.rs"]
mod ssh;

use error::AppResult;
use serde_json::Value;
use ssh::{SshConnection, SshEventSink, SshManager, TerminalDimensions, TransferState, UploadFile};
use std::{
    env, fs,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::{sleep, timeout};

const FIXTURE_PORT_ENV: &str = "REMOTE_TERMINAL_SSH_FIXTURE_PORT";
const FIXTURE_PASSWORD: &str = "test-password";
const SFTP_AUDIT_COMMAND: &str = "__REMOTE_TERMINAL_FIXTURE_SFTP_AUDIT__";

#[derive(Default)]
struct RecordingSink {
    events: Mutex<Vec<(String, Value)>>,
}

impl RecordingSink {
    fn count(&self) -> usize {
        self.events.lock().expect("event lock").len()
    }

    fn terminal_bytes_after(&self, start: usize, session_id: &str) -> Vec<u8> {
        self.events
            .lock()
            .expect("event lock")
            .iter()
            .skip(start)
            .filter(|(event, payload)| {
                event == "terminal-data"
                    && payload.get("sessionId").and_then(Value::as_str) == Some(session_id)
            })
            .flat_map(|(_, payload)| {
                payload
                    .get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|value| value.as_u64().and_then(|byte| u8::try_from(byte).ok()))
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    fn has_transfer_state(&self, transfer_id: &str, state: &str) -> bool {
        self.events
            .lock()
            .expect("event lock")
            .iter()
            .any(|(event, payload)| {
                event == "transfer-progress"
                    && payload.get("id").and_then(Value::as_str) == Some(transfer_id)
                    && payload.get("state").and_then(Value::as_str) == Some(state)
            })
    }
}

impl SshEventSink for RecordingSink {
    fn emit(&self, event: &str, payload: Value) -> AppResult<()> {
        self.events
            .lock()
            .expect("event lock")
            .push((event.to_string(), payload));
        Ok(())
    }
}

async fn wait_for_terminal_bytes(
    sink: &RecordingSink,
    start: usize,
    session_id: &str,
    expected: &[u8],
) {
    timeout(Duration::from_secs(3), async {
        loop {
            let bytes = sink.terminal_bytes_after(start, session_id);
            if bytes
                .windows(expected.len())
                .any(|window| window == expected)
            {
                return;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("terminal bytes were not observed before timeout");
}

async fn wait_for_transfer(sink: &RecordingSink, transfer_id: &str, state: &str) {
    timeout(Duration::from_secs(5), async {
        loop {
            if sink.has_transfer_state(transfer_id, state) {
                return;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("transfer did not reach the expected state before timeout");
}

fn fixture_connection(port: u16) -> SshConnection {
    SshConnection {
        id: "11111111-1111-4111-8111-111111111111".to_string(),
        host: "127.0.0.1".to_string(),
        port,
        username: "root".to_string(),
    }
}

fn operation_index(operations: &[Value], op: &str, kind: Option<&str>) -> usize {
    operations
        .iter()
        .position(|operation| {
            operation.get("op").and_then(Value::as_str) == Some(op)
                && kind.is_none_or(|expected| {
                    operation.get("type").and_then(Value::as_str) == Some(expected)
                })
        })
        .unwrap_or_else(|| panic!("missing fixture operation: {op}"))
}

#[test]
#[ignore = "requires scripts/qa-rust-ssh.mjs to provide the isolated ssh2 server"]
fn real_ssh_sftp_protocol_smoke() {
    let port = env::var(FIXTURE_PORT_ENV)
        .expect("fixture port environment variable")
        .parse::<u16>()
        .expect("fixture port");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Tokio runtime");

    runtime.block_on(async move {
        let sink = Arc::new(RecordingSink::default());
        let download_cache = tempfile::tempdir().expect("isolated download cache");
        let manager =
            SshManager::with_event_sink(sink.clone(), download_cache.path().join("download-cache"))
                .expect("download cache initialization");
        let connection = fixture_connection(port);
        let dimensions = TerminalDimensions {
            cols: 100,
            rows: 30,
        };

        let observed = manager
            .inspect_host(&connection)
            .await
            .expect("host fingerprint probe");
        assert_eq!(observed.algorithm, "ssh-ed25519");
        assert!(observed.fingerprint.starts_with("SHA256:"));

        let mismatched_fingerprint = format!("SHA256:{}", "A".repeat(43));
        let mismatch = manager
            .connect(
                connection.clone(),
                mismatched_fingerprint,
                FIXTURE_PASSWORD.to_string(),
                dimensions,
            )
            .await
            .expect_err("a mismatched host key must be blocked");
        assert_eq!(mismatch.code, "HOST_KEY_MISMATCH");

        let authentication = manager
            .connect(
                connection.clone(),
                observed.fingerprint.clone(),
                "wrong-password".to_string(),
                dimensions,
            )
            .await
            .expect_err("an invalid password must be rejected");
        assert_eq!(authentication.code, "AUTH_FAILED");

        let connected = manager
            .connect(
                connection,
                observed.fingerprint,
                FIXTURE_PASSWORD.to_string(),
                dimensions,
            )
            .await
            .expect("password-authenticated SSH connection");
        assert_eq!(connected.home.as_deref(), Some("/home/root"));
        assert!(connected.sftp_error.is_none());

        let attached = manager
            .attach_terminal(&connected.session_id)
            .await
            .expect("terminal attachment");
        if !attached
            .initial_data
            .windows(b"integration-ready$ ".len())
            .any(|window| window == b"integration-ready$ ")
        {
            wait_for_terminal_bytes(&sink, 0, &connected.session_id, b"integration-ready$ ").await;
        }
        let event_start = sink.count();
        manager
            .write_terminal(&connected.session_id, "protocol-terminal\r")
            .await
            .expect("PTY write");
        wait_for_terminal_bytes(
            &sink,
            event_start,
            &connected.session_id,
            b"protocol-terminal\r",
        )
        .await;

        let completion = manager
            .completion_catalog(&connected.session_id)
            .await
            .expect("remote completion catalog");
        assert!(completion
            .iter()
            .any(|item| { item.command == "ll" && item.source == "remote-command" }));
        assert!(completion
            .iter()
            .any(|item| { item.command == "ls" && item.source == "remote-command" }));
        assert!(completion
            .iter()
            .all(|item| item.source == "remote-command"));
        assert!(!completion
            .iter()
            .any(|item| item.command == "journalctl -u remote-terminal"));

        let previous = manager
            .exec(&connected.session_id, monitor::COUNTER_COMMAND)
            .await
            .expect("first monitor counter command");
        let current = manager
            .exec(&connected.session_id, monitor::COUNTER_COMMAND)
            .await
            .expect("second monitor counter command");
        let previous = monitor::parse_counters(&previous.stdout).expect("first counters");
        let current = monitor::parse_counters(&current.stdout).expect("second counters");
        let cpu = monitor::calculate_cpu_usage(&previous.cpu, &current.cpu).expect("CPU usage");
        let network =
            monitor::calculate_network_rates(&previous.network, &current.network, 1_000.0)
                .expect("network rates");
        let raw_snapshot = manager
            .exec(&connected.session_id, monitor::MONITOR_SNAPSHOT_COMMAND)
            .await
            .expect("monitor snapshot command");
        let snapshot = monitor::parse_snapshot(&raw_snapshot.stdout, cpu, &network)
            .expect("parsed monitor snapshot");
        assert_eq!(snapshot.cpu, 50.0);
        assert_eq!(snapshot.cpu_cores, 8);
        assert_eq!(snapshot.network_interface, "eth0");
        assert!(snapshot.mounts.iter().any(|mount| mount.path == "/run/lock"
            && mount.total_label == "5 MB"
            && mount.percent == 13));

        let initial_listing = manager
            .list_directory(&connected.session_id, "/home/root/releases")
            .await
            .expect("initial SFTP directory listing");
        assert!(initial_listing
            .entries
            .iter()
            .any(|entry| { entry.name == "logs" && entry.entry_type == "directory" }));
        assert!(initial_listing
            .entries
            .iter()
            .any(|entry| { entry.name == "readme.txt" && entry.entry_type == "file" }));

        let temporary_directory = tempfile::tempdir().expect("isolated local upload directory");
        let upload_path = temporary_directory.path().join("protocol-smoke.bin");
        let upload_bytes = (0..(130 * 1024 + 17))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        fs::write(&upload_path, &upload_bytes).expect("local upload fixture");
        let queued = manager
            .upload_files(
                &connected.session_id,
                "/home/root/releases",
                vec![UploadFile {
                    local_path: upload_path
                        .to_str()
                        .expect("Unicode local upload path")
                        .to_string(),
                }],
            )
            .await
            .expect("queued SFTP upload");
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].state, TransferState::Queued);
        wait_for_transfer(&sink, &queued[0].id, "success").await;

        let uploaded_listing = manager
            .list_directory(&connected.session_id, "/home/root/releases")
            .await
            .expect("uploaded SFTP directory listing");
        assert!(uploaded_listing.entries.iter().any(|entry| {
            entry.name == "protocol-smoke.bin"
                && entry.entry_type == "file"
                && entry.size == upload_bytes.len() as u64
        }));
        assert!(!uploaded_listing
            .entries
            .iter()
            .any(|entry| entry.name.ends_with(".part")));

        let overwrite = manager
            .upload_files(
                &connected.session_id,
                "/home/root/releases",
                vec![UploadFile {
                    local_path: upload_path
                        .to_str()
                        .expect("Unicode local upload path")
                        .to_string(),
                }],
            )
            .await
            .expect_err("an existing remote target must not be overwritten");
        assert_eq!(overwrite.code, "REMOTE_FILE_EXISTS");

        let renamed_file = manager
            .rename_remote_entry(
                &connected.session_id,
                "/home/root/releases/protocol-smoke.bin",
                "/home/root/releases/protocol-renamed.bin",
                "file",
            )
            .await
            .expect("rename one real remote file");
        assert_eq!(
            renamed_file.source_path,
            "/home/root/releases/protocol-smoke.bin"
        );
        assert_eq!(
            renamed_file.target_path,
            "/home/root/releases/protocol-renamed.bin"
        );
        assert_eq!(renamed_file.entry_type, "file");

        let overwrite_by_rename = manager
            .rename_remote_entry(
                &connected.session_id,
                "/home/root/releases/protocol-renamed.bin",
                "/home/root/releases/readme.txt",
                "file",
            )
            .await
            .expect_err("rename must not replace an existing remote target");
        assert_eq!(overwrite_by_rename.code, "REMOTE_TARGET_EXISTS");

        let moved_file = manager
            .rename_remote_entry(
                &connected.session_id,
                "/home/root/releases/protocol-renamed.bin",
                "/home/root/releases/archive/protocol-renamed.bin",
                "file",
            )
            .await
            .expect("move one real remote file across directories");
        assert_eq!(
            moved_file.target_path,
            "/home/root/releases/archive/protocol-renamed.bin"
        );

        let self_move = manager
            .rename_remote_entry(
                &connected.session_id,
                "/home/root/releases/archive",
                "/home/root/releases/archive/nested",
                "directory",
            )
            .await
            .expect_err("a directory must not move into its own subtree");
        assert_eq!(self_move.code, "REMOTE_DIRECTORY_SELF_MOVE");

        let non_empty = manager
            .remove_remote_entry(&connected.session_id, "/home/root/releases", "directory")
            .await
            .expect_err("non-empty directories must not be deleted recursively");
        assert_eq!(non_empty.code, "REMOTE_DIRECTORY_NOT_EMPTY");

        let removed_file = manager
            .remove_remote_entry(
                &connected.session_id,
                "/home/root/releases/archive/protocol-renamed.bin",
                "file",
            )
            .await
            .expect("delete one real remote file");
        assert_eq!(removed_file.entry_type, "file");
        let removed_directory = manager
            .remove_remote_entry(
                &connected.session_id,
                "/home/root/releases/logs",
                "directory",
            )
            .await
            .expect("delete one empty remote directory");
        assert_eq!(removed_directory.entry_type, "directory");

        let after_delete = manager
            .list_directory(&connected.session_id, "/home/root/releases")
            .await
            .expect("listing after real deletion");
        assert!(!after_delete
            .entries
            .iter()
            .any(|entry| entry.name == "protocol-smoke.bin" || entry.name == "logs"));

        let audit = manager
            .exec(&connected.session_id, SFTP_AUDIT_COMMAND)
            .await
            .expect("fixture SFTP audit");
        let audit: Value = serde_json::from_str(audit.stdout.trim()).expect("fixture audit JSON");
        let operations = audit
            .get("operations")
            .and_then(Value::as_array)
            .expect("fixture audit operations");
        let opened = operation_index(operations, "openTemporary", None);
        let written = operation_index(operations, "write", None);
        let closed = operation_index(operations, "close", Some("file"));
        let renamed = operation_index(operations, "atomicRename", None);
        assert!(opened < written && written < closed && closed < renamed);
        assert!(
            operations
                .iter()
                .filter(|operation| operation.get("op").and_then(Value::as_str) == Some("write"))
                .count()
                >= 3
        );
        assert_eq!(audit.get("temporaryFiles").and_then(Value::as_u64), Some(0));
        assert!(operations.iter().any(|operation| {
            operation.get("op").and_then(Value::as_str) == Some("stat")
                && operation.get("exists").and_then(Value::as_bool) == Some(true)
                && operation.get("name").and_then(Value::as_str) == Some("protocol-smoke.bin")
        }));
        assert!(audit
            .get("uploaded")
            .and_then(Value::as_array)
            .expect("fixture uploaded files")
            .iter()
            .any(|file| { file.get("name").and_then(Value::as_str) == Some("readme.txt") }));
        assert!(operations.iter().any(|operation| {
            operation.get("op").and_then(Value::as_str) == Some("removeFile")
                && operation.get("name").and_then(Value::as_str) == Some("protocol-renamed.bin")
        }));
        assert!(operations.iter().any(|operation| {
            operation.get("op").and_then(Value::as_str) == Some("rename")
                && operation.get("source").and_then(Value::as_str)
                    == Some("/home/root/releases/protocol-smoke.bin")
                && operation.get("target").and_then(Value::as_str)
                    == Some("/home/root/releases/protocol-renamed.bin")
        }));
        assert!(operations.iter().any(|operation| {
            operation.get("op").and_then(Value::as_str) == Some("rename")
                && operation.get("source").and_then(Value::as_str)
                    == Some("/home/root/releases/protocol-renamed.bin")
                && operation.get("target").and_then(Value::as_str)
                    == Some("/home/root/releases/archive/protocol-renamed.bin")
        }));
        assert!(operations.iter().any(|operation| {
            operation.get("op").and_then(Value::as_str) == Some("removeDirectory")
                && operation.get("name").and_then(Value::as_str) == Some("logs")
        }));

        manager
            .disconnect(&connected.session_id)
            .await
            .expect("SSH disconnect");
    });
}
