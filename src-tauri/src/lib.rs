// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

mod autostart;
mod core;
pub mod data_paths;
pub mod diagnostics;
#[cfg(target_os = "windows")]
pub mod installer_data;
#[cfg(target_os = "linux")]
pub mod linux_input;
#[cfg(target_os = "linux")]
pub mod linux_session;
mod preference_window;
mod utils;
mod webview_storage;

use data_paths::get_app_data_directory;
use webview_storage::create_sub_model_window;

use core::{
    device::{get_device_input_status, start_device_listening},
    gamepad::{set_gamepad_listener_enabled, start_gamepad_listing, stop_gamepad_listing},
    prevent_default,
    runtime_security::{
        prepare_dedicated_runtime, record_dedicated_runtime_event, runtime_installation_identity,
    },
    setup,
    update::get_update_capability,
};
use tauri::{Emitter, Manager, WindowEvent, generate_handler};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_custom_window::{
    MAIN_WINDOW_LABEL, PREFERENCE_WINDOW_LABEL, WebviewMemoryTarget, request_webview_memory_target,
};
use utils::fs_extra::{copy_dir, extract_zip};
use utils::persistence_recovery::{
    PersistenceRecoveryState, init as persistence_recovery_init, take_persistence_recovery_report,
};

const MODEL_STORE_SCHEMA_VERSION: u64 = 2;

#[tauri::command]
fn mark_startup_stage(stage: String) {
    diagnostics::mark_phase(&stage);
}

#[tauri::command]
fn get_diagnostics_directory() -> String {
    diagnostics::log_dir().to_string_lossy().into_owned()
}

fn migrate_model_store_state(
    state: &mut tauri_plugin_pinia::StoreState,
) -> tauri_plugin_pinia::Result<()> {
    let legacy_current_model = state.get("currentModel").cloned();
    let mut selection_migration_pending = false;

    if !state.has("currentModelId") {
        if let Some(model_id) = legacy_current_model
            .as_ref()
            .and_then(|model| model.get("id"))
            .and_then(serde_json::Value::as_str)
        {
            state.set("currentModelId", model_id);
            selection_migration_pending = true;
        }
    }

    if !state.has("currentModelFingerprint") {
        if let Some(fingerprint) = legacy_current_model
            .as_ref()
            .and_then(|model| model.get("fingerprint"))
            .and_then(serde_json::Value::as_str)
        {
            state.set("currentModelFingerprint", fingerprint);
        }
    }

    if selection_migration_pending {
        state.set("selectionMigrationPending", true);
    }

    if let Some(serde_json::Value::Array(models)) = state.get_mut("models") {
        for model in models {
            if let Some(model) = model.as_object_mut() {
                model.remove("runtimeLease");
            }
        }
    }

    state.retain(|key, _| {
        matches!(
            key.as_str(),
            "schemaVersion"
                | "currentModelId"
                | "currentModelFingerprint"
                | "selectionMigrationPending"
                | "models"
                | "shortcuts"
                | "behaviorNames"
                | "behaviorGroups"
                | "subModels"
        )
    });
    state.set("schemaVersion", MODEL_STORE_SCHEMA_VERSION);

    Ok(())
}

fn repair_model_store_state(
    state: &mut tauri_plugin_pinia::StoreState,
) -> tauri_plugin_pinia::Result<()> {
    // v1.2.0 could record the migration metadata before the frontend had
    // removed the legacy model object. Re-run the cleanup for those installs.
    if state.has("currentModelId") {
        state.remove("currentModel");
    }

    state.set("schemaVersion", MODEL_STORE_SCHEMA_VERSION);
    Ok(())
}

// macOS embeds a global Info.plist symbol, so tests and startup must share one
// generate_context! expansion within this crate.
fn application_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    if let Err(error) = data_paths::windows_data_paths() {
        diagnostics::show_startup_error("MochiPaw data directory error", &error);
        return;
    }

    let mut context = application_context();
    webview_storage::configure_context(&mut context);

    let pinia = tauri_plugin_pinia::Builder::default();
    #[cfg(target_os = "windows")]
    let pinia = pinia.path(
        data_paths::windows_data_paths()
            .expect("validated data root")
            .pinia(),
    );

    diagnostics::mark_phase("tauri-builder-started");
    diagnostics::record_webview_preflight();

    let app = tauri::Builder::default()
        // This must run before other plugins can open shared resources. It is
        // especially important when a second instance has a different integrity level.
        .plugin(tauri_plugin_single_instance::init(
            |app_handle, _argv, _cwd| {
                preference_window::request_preference_window(app_handle);
            },
        ))
        .setup(|app| {
            diagnostics::mark_phase("tauri-setup-started");

            if let Err(error) = autostart::repair_existing_entry(app.handle()) {
                diagnostics::record_error("autostart-repair", &error);
            }

            // Windows uses only the executable-relative root. Other platforms
            // retain their existing platform-specific data directory.
            match get_app_data_directory(app.handle().clone()) {
                Ok(path) => match std::fs::create_dir_all(&path) {
                    Ok(()) => diagnostics::initialize().record_app_data_directory(&path),
                    Err(error) => diagnostics::record_error(
                        "app-data-dir",
                        &format!("creating {} failed: {error}", path.display()),
                    ),
                },
                Err(error) => diagnostics::record_error("app-data-dir", &error.to_string()),
            }

            if let Err(error) = webview_storage::create_initial_windows(app) {
                diagnostics::record_error("webview-failed", &error);
                diagnostics::show_startup_error(
                    "MochiPaw WebView2 startup failed",
                    &format!("{error}\n\nCheck the data/webview directory and the WebView2 runtime."),
                );
                return Err(error.into());
            }
            diagnostics::mark_phase("webview-ready");

            let app_handle = app.handle();

            std::thread::spawn(|| {
                loop {
                    if tauri_plugin_self_protect::is_debugged() {
                        std::process::exit(0);
                    }

                    std::thread::sleep(std::time::Duration::from_secs(5));
                }
            });

            let main_window = app.get_webview_window(MAIN_WINDOW_LABEL).unwrap();

            setup::default(&app_handle, main_window.clone());

            if app.state::<PersistenceRecoveryState>().requires_attention() {
                preference_window::request_preference_window(app_handle);
            }

            Ok(())
        })
        .invoke_handler(generate_handler![
            autostart::get_autostart_enabled,
            autostart::set_autostart_enabled,
            copy_dir,
            extract_zip,
            start_device_listening,
            get_device_input_status,
            start_gamepad_listing,
            stop_gamepad_listing,
            set_gamepad_listener_enabled,
            get_update_capability,
            runtime_installation_identity,
            prepare_dedicated_runtime,
            record_dedicated_runtime_event,
            take_persistence_recovery_report,
            mark_startup_stage,
            get_diagnostics_directory,
            get_app_data_directory,
            create_sub_model_window,
            preference_window::show_preference_window,
            preference_window::preference_window_ready,
            preference_window::request_preference_update,
            preference_window::take_pending_preference_update,
            preference_window::begin_preference_close,
            preference_window::complete_preference_close
        ])
        .plugin(tauri_plugin_admin_status::init())
        .plugin(tauri_plugin_custom_window::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            pinia
                .migration(
                    "model",
                    tauri_plugin_pinia::Migration::new("2.0.0", migrate_model_store_state),
                )
                .migration(
                    "model",
                    tauri_plugin_pinia::Migration::new("2.1.0", repair_model_store_state),
                )
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(prevent_default::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Folder {
                        path: diagnostics::log_dir().to_path_buf(),
                        // The plugin adds the `.log` extension itself.
                        file_name: Some("mochi-paw".to_string()),
                    },
                )])
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .level(tauri_plugin_log::log::LevelFilter::Trace)
                .filter(|metadata| !metadata.target().contains("gilrs"))
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(persistence_recovery_init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_macos_permissions::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_locale::init())
        .plugin(tauri_plugin_self_protect::init())
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                if window.label() == PREFERENCE_WINDOW_LABEL {
                    api.prevent_close();
                    let _ = window.emit(preference_window::CLOSE_PREFERENCE_EVENT, ());
                    return;
                }

                if let Some(webview_window) = window.app_handle().get_webview_window(window.label())
                {
                    request_webview_memory_target(&webview_window, WebviewMemoryTarget::Low);
                }

                let _ = window.hide();

                api.prevent_close();
            }
            _ => {}
        })
        // Plugin setup occurs during build; initial Windows webviews are
        // created later in the event-loop setup hook with the local data root.
        .build(context)
        .unwrap_or_else(|error| {
            diagnostics::record_error("webview-failed", &error.to_string());
            let message = format!(
                "MochiPaw failed to create its WebView2 runtime.\n\n{error}\n\nRun the installer again to repair WebView2."
            );
            diagnostics::show_startup_error("MochiPaw WebView2 startup failed", &message);
            std::process::exit(1);
        });

    diagnostics::mark_phase("tauri-builder-complete");

    app.run(|app_handle, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            preference_window::request_preference_window(app_handle);
        }
        _ => {
            let _ = app_handle;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{MODEL_STORE_SCHEMA_VERSION, migrate_model_store_state, repair_model_store_state};
    use serde_json::json;
    use tauri_plugin_pinia::StoreState;

    #[test]
    fn migrates_legacy_model_selection_and_removes_runtime_state() {
        let mut state = StoreState::new();
        state.set(
            "currentModel",
            json!({
                "id": "中文-model",
                "path": "C:\\用户 目录\\模型#100%",
                "fingerprint": "v2:standard:abc"
            }),
        );
        state.set(
            "models",
            json!([{ "id": "中文-model", "runtimeLease": { "expiresAt": 1 } }]),
        );
        state.set("modelReady", false);
        state.set("currentMotions", json!([["Idle", []]]));

        migrate_model_store_state(&mut state).unwrap();

        assert_eq!(
            state.get("schemaVersion"),
            Some(&json!(MODEL_STORE_SCHEMA_VERSION))
        );
        assert_eq!(state.get("currentModelId"), Some(&json!("中文-model")));
        assert_eq!(
            state.get("currentModelFingerprint"),
            Some(&json!("v2:standard:abc"))
        );
        assert_eq!(state.get("selectionMigrationPending"), Some(&json!(true)));
        assert_eq!(state.get("models"), Some(&json!([{ "id": "中文-model" }])));
        assert!(!state.has("currentModel"));
        assert!(!state.has("modelReady"));
        assert!(!state.has("currentMotions"));
    }

    #[test]
    fn preserves_an_existing_stable_model_id() {
        let mut state = StoreState::new();
        state.set("currentModelId", "new-selection");
        state.set("currentModel", json!({ "id": "legacy-selection" }));

        migrate_model_store_state(&mut state).unwrap();

        assert_eq!(state.get("currentModelId"), Some(&json!("new-selection")));
        assert!(!state.has("currentModel"));
    }

    #[test]
    fn repairs_stale_legacy_model_after_a_previous_migration() {
        let mut state = StoreState::new();
        state.set("schemaVersion", MODEL_STORE_SCHEMA_VERSION);
        state.set("currentModelId", "removed-model");
        state.set("currentModelFingerprint", "old-fingerprint");
        state.set("selectionMigrationPending", true);
        state.set("currentModel", json!({ "id": "removed-model" }));
        state.set(
            "models",
            json!([{ "id": "preset-standard", "isPreset": true }]),
        );

        repair_model_store_state(&mut state).unwrap();

        assert!(!state.has("currentModel"));
        assert_eq!(state.get("currentModelId"), Some(&json!("removed-model")));
        assert_eq!(
            state.get("currentModelFingerprint"),
            Some(&json!("old-fingerprint"))
        );
        assert_eq!(state.get("selectionMigrationPending"), Some(&json!(true)));
        assert_eq!(
            state.get("schemaVersion"),
            Some(&json!(MODEL_STORE_SCHEMA_VERSION))
        );
    }

    #[test]
    fn keeps_selection_when_the_persisted_catalog_is_incomplete() {
        let mut state = StoreState::new();
        state.set("currentModelId", "custom-model");
        state.set("currentModel", json!({ "id": "custom-model" }));

        repair_model_store_state(&mut state).unwrap();

        assert!(!state.has("currentModel"));
        assert_eq!(state.get("currentModelId"), Some(&json!("custom-model")));
    }
}
