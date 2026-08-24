// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

use serde::Serialize;
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, Runtime, plugin::TauriPlugin};
use tauri_plugin_custom_window::PREFERENCE_WINDOW_LABEL;
use tauri_plugin_pinia::ManagerExt as _;

const STORE_IDS: [&str; 7] = [
    "app",
    "cat",
    "general",
    "model",
    "pomodoro",
    "shortcut",
    "typingStats",
];

#[cfg(debug_assertions)]
const STORE_FILE_EXTENSION: &str = "dev.json";
#[cfg(not(debug_assertions))]
const STORE_FILE_EXTENSION: &str = "json";

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredPersistenceStore {
    pub store_id: String,
    pub backup_path: PathBuf,
    pub reason: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistenceRecoveryFailure {
    pub store_id: String,
    pub path: PathBuf,
    pub reason: String,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistenceRecoveryReport {
    pub recovered: Vec<RecoveredPersistenceStore>,
    pub failures: Vec<PersistenceRecoveryFailure>,
}

impl PersistenceRecoveryReport {
    fn is_empty(&self) -> bool {
        self.recovered.is_empty() && self.failures.is_empty()
    }
}

#[derive(Debug, Default)]
pub struct PersistenceRecoveryState {
    report: Mutex<Option<PersistenceRecoveryReport>>,
    requires_attention: bool,
}

impl PersistenceRecoveryState {
    pub fn new(report: Option<PersistenceRecoveryReport>) -> Self {
        Self {
            requires_attention: report.is_some(),
            report: Mutex::new(report),
        }
    }

    pub fn requires_attention(&self) -> bool {
        self.requires_attention
    }

    fn take_for_window(&self, window_label: &str) -> Option<PersistenceRecoveryReport> {
        if window_label != PREFERENCE_WINDOW_LABEL {
            return None;
        }

        self.report.lock().ok()?.take()
    }
}

#[tauri::command]
pub fn take_persistence_recovery_report(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PersistenceRecoveryState>,
) -> Option<PersistenceRecoveryReport> {
    state.take_for_window(window.label())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("persistence-recovery")
        .setup(|app, _api| {
            let store_directory = app.pinia().path();
            let recovery_report = recover_persistence_stores(&store_directory);

            if let Some(report) = &recovery_report {
                for recovered in &report.recovered {
                    tauri_plugin_log::log::warn!(
                        "recovered corrupted persistence store: store_id={}, backup_path={}, reason={}",
                        recovered.store_id,
                        recovered.backup_path.display(),
                        recovered.reason
                    );
                }
                for failure in &report.failures {
                    tauri_plugin_log::log::error!(
                        "failed to recover corrupted persistence store: store_id={}, path={}, reason={}",
                        failure.store_id,
                        failure.path.display(),
                        failure.reason
                    );
                }
            }

            app.manage(PersistenceRecoveryState::new(recovery_report));
            Ok(())
        })
        .build()
}

pub fn recover_persistence_stores(store_directory: &Path) -> Option<PersistenceRecoveryReport> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut rename = |from: &Path, to: &Path| fs::rename(from, to);
    let report = recover_persistence_stores_with(store_directory, timestamp, &mut rename);

    (!report.is_empty()).then_some(report)
}

fn recover_persistence_stores_with<F>(
    store_directory: &Path,
    timestamp: u128,
    rename: &mut F,
) -> PersistenceRecoveryReport
where
    F: FnMut(&Path, &Path) -> io::Result<()>,
{
    let mut report = PersistenceRecoveryReport::default();

    for store_id in STORE_IDS {
        let path = store_path(store_directory, store_id);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                report.failures.push(PersistenceRecoveryFailure {
                    store_id: store_id.to_string(),
                    path,
                    reason: format!("failed to read persisted store: {error}"),
                });
                continue;
            }
        };

        let reason = match serde_json::from_slice::<tauri_plugin_pinia::StoreState>(&bytes) {
            Ok(_) => continue,
            Err(error) => error.to_string(),
        };
        let backup_path = match unique_backup_path(store_directory, store_id, timestamp) {
            Ok(path) => path,
            Err(error) => {
                report.failures.push(PersistenceRecoveryFailure {
                    store_id: store_id.to_string(),
                    path,
                    reason: format!(
                        "persisted store is invalid ({reason}); failed to select a backup path: {error}"
                    ),
                });
                continue;
            }
        };

        match rename(&path, &backup_path) {
            Ok(()) => report.recovered.push(RecoveredPersistenceStore {
                store_id: store_id.to_string(),
                backup_path,
                reason,
            }),
            Err(error) => report.failures.push(PersistenceRecoveryFailure {
                store_id: store_id.to_string(),
                path,
                reason: format!(
                    "persisted store is invalid ({reason}); failed to create backup: {error}"
                ),
            }),
        }
    }

    report
}

fn store_path(store_directory: &Path, store_id: &str) -> PathBuf {
    store_directory.join(format!("{store_id}.{STORE_FILE_EXTENSION}"))
}

fn unique_backup_path(
    store_directory: &Path,
    store_id: &str,
    timestamp: u128,
) -> io::Result<PathBuf> {
    for collision_index in 0_u64.. {
        let collision_suffix = match collision_index {
            0 => String::new(),
            index => format!("-{index}"),
        };
        let candidate = store_directory.join(format!(
            "{store_id}.corrupt-{timestamp}{collision_suffix}.json"
        ));

        match fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(candidate),
            Err(error) => return Err(error),
        }
    }

    unreachable!("the backup collision counter is exhaustive")
}

#[cfg(test)]
mod tests {
    use super::{
        PersistenceRecoveryReport, PersistenceRecoveryState, recover_persistence_stores,
        recover_persistence_stores_with, store_path,
    };
    use std::{
        fs, io,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };
    use tauri_plugin_custom_window::PREFERENCE_WINDOW_LABEL;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should follow UNIX epoch")
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("mochi-paw-{name}-{}-{unique}", std::process::id()));
            fs::create_dir_all(&path).expect("test directory should be created");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn run_with_timestamp(store_directory: &Path, timestamp: u128) -> PersistenceRecoveryReport {
        recover_persistence_stores_with(store_directory, timestamp, &mut |from, to| {
            fs::rename(from, to)
        })
    }

    #[cfg(debug_assertions)]
    #[test]
    fn uses_the_active_debug_store_filename() {
        assert_eq!(
            store_path(Path::new("pinia"), "model"),
            Path::new("pinia").join("model.dev.json")
        );
    }

    #[test]
    fn ignores_missing_and_valid_store_files() {
        let root = TestDirectory::new("valid-stores");
        let valid_path = store_path(root.path(), "model");
        let valid_contents = br#"{"currentModelId":"preset-gamepad","models":[]}"#;
        fs::write(&valid_path, valid_contents).unwrap();

        let report = recover_persistence_stores(root.path());

        assert!(report.is_none());
        assert_eq!(fs::read(valid_path).unwrap(), valid_contents);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn recovers_a_malformed_pomodoro_store() {
        let root = TestDirectory::new("pomodoro-store");
        let path = store_path(root.path(), "pomodoro");
        fs::write(&path, b"{\"truncated\":").unwrap();

        let report = run_with_timestamp(root.path(), 123);

        assert_eq!(report.recovered.len(), 1);
        assert_eq!(report.recovered[0].store_id, "pomodoro");
        assert!(!path.exists());
        assert_eq!(
            fs::read(&report.recovered[0].backup_path).unwrap(),
            b"{\"truncated\":"
        );
    }

    #[test]
    fn recovers_empty_malformed_and_non_object_stores_without_changing_bytes() {
        let root = TestDirectory::new("\u{6301}\u{4e45}\u{5316} \u{7a7a}\u{683c}#100% \u{1f431}");
        let cases = [
            ("app", Vec::new()),
            ("cat", b"{\"truncated\":".to_vec()),
            ("general", b"[]".to_vec()),
        ];

        for (store_id, contents) in &cases {
            fs::write(store_path(root.path(), store_id), contents).unwrap();
        }

        let report = run_with_timestamp(root.path(), 1_234);

        assert_eq!(report.recovered.len(), cases.len());
        assert!(report.failures.is_empty());
        for (store_id, contents) in cases {
            assert!(!store_path(root.path(), store_id).exists());
            let recovered = report
                .recovered
                .iter()
                .find(|recovered| recovered.store_id == store_id)
                .unwrap();
            assert_eq!(fs::read(&recovered.backup_path).unwrap(), contents);
            assert!(recovered.backup_path.starts_with(root.path()));
            assert!(recovered.reason.contains("line 1 column"));
        }
    }

    #[test]
    fn uses_a_unique_backup_name_without_overwriting_a_collision() {
        let root = TestDirectory::new("backup-collision");
        let invalid_path = store_path(root.path(), "model");
        let existing_backup = root.path().join("model.corrupt-42.json");
        fs::write(&invalid_path, b"invalid").unwrap();
        fs::write(&existing_backup, b"existing backup").unwrap();

        let report = run_with_timestamp(root.path(), 42);

        assert_eq!(report.recovered.len(), 1);
        assert_eq!(
            report.recovered[0].backup_path,
            root.path().join("model.corrupt-42-1.json")
        );
        assert_eq!(fs::read(existing_backup).unwrap(), b"existing backup");
        assert_eq!(
            fs::read(&report.recovered[0].backup_path).unwrap(),
            b"invalid"
        );
    }

    #[test]
    fn reports_rename_failures_and_leaves_the_original_file_untouched() {
        let root = TestDirectory::new("rename-failure");
        let invalid_path = store_path(root.path(), "shortcut");
        let original_contents = b"not JSON";
        fs::write(&invalid_path, original_contents).unwrap();
        let mut failing_rename = |_from: &Path, _to: &Path| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "test denied rename",
            ))
        };

        let report = recover_persistence_stores_with(root.path(), 99, &mut failing_rename);

        assert!(report.recovered.is_empty());
        assert_eq!(report.failures.len(), 1);
        assert_eq!(report.failures[0].store_id, "shortcut");
        assert_eq!(report.failures[0].path, invalid_path);
        assert!(report.failures[0].reason.contains("test denied rename"));
        assert_eq!(fs::read(invalid_path).unwrap(), original_contents);
    }

    #[test]
    fn reports_store_read_failures() {
        let root = TestDirectory::new("read-failure");
        let unreadable_path = store_path(root.path(), "app");
        fs::create_dir(&unreadable_path).unwrap();

        let report = run_with_timestamp(root.path(), 100);

        assert!(report.recovered.is_empty());
        assert_eq!(report.failures.len(), 1);
        assert_eq!(report.failures[0].store_id, "app");
        assert_eq!(report.failures[0].path, unreadable_path);
        assert!(report.failures[0].reason.contains("failed to read"));
    }

    #[test]
    fn only_the_preference_window_consumes_a_recovery_report_once() {
        let state = PersistenceRecoveryState::new(Some(PersistenceRecoveryReport::default()));

        assert!(state.requires_attention());
        assert!(state.take_for_window("main").is_none());
        assert!(state.requires_attention());
        assert!(state.take_for_window(PREFERENCE_WINDOW_LABEL).is_some());
        assert!(state.requires_attention());
        assert!(state.take_for_window(PREFERENCE_WINDOW_LABEL).is_none());
        let empty_state = PersistenceRecoveryState::new(None);
        assert!(!empty_state.requires_attention());
        assert!(
            empty_state
                .take_for_window(PREFERENCE_WINDOW_LABEL)
                .is_none()
        );
    }

    #[test]
    fn serializes_the_recovery_report_with_camel_case_fields() {
        let root = TestDirectory::new("serialized-report");
        fs::write(store_path(root.path(), "cat"), b"invalid").unwrap();
        let report = run_with_timestamp(root.path(), 101);

        let value = serde_json::to_value(report).unwrap();

        assert_eq!(value["recovered"][0]["storeId"], "cat");
        assert!(value["recovered"][0].get("backupPath").is_some());
        assert!(value["recovered"][0].get("backup_path").is_none());
        assert!(value["failures"].is_array());
    }
}
