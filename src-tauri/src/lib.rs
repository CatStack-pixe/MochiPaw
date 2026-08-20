// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

mod core;
mod utils;

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
use tauri::{Manager, WindowEvent, generate_handler};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_custom_window::{
    MAIN_WINDOW_LABEL, PREFERENCE_WINDOW_LABEL, WebviewMemoryTarget, request_webview_memory_target,
    show_preference_window,
};
use utils::fs_extra::{copy_dir, extract_zip};
use utils::persistence_recovery::{
    PersistenceRecoveryState, init as persistence_recovery_init, take_persistence_recovery_report,
};

const MODEL_STORE_SCHEMA_VERSION: u64 = 2;

#[cfg(target_os = "windows")]
const WEBVIEW2_RENDERING_ARGS: &str = "--disable-features=CalculateNativeWinOcclusion,msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    {
        // Apply the same no-throttling policy to dynamically-created WebView2
        // windows, which cannot inherit `additionalBrowserArgs` from config.
        unsafe {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                WEBVIEW2_RENDERING_ARGS,
            );
        }
    }

    let app = tauri::Builder::default()
        // This must run before other plugins can open shared resources. It is
        // especially important when a second instance has a different integrity level.
        .plugin(tauri_plugin_single_instance::init(
            |app_handle, _argv, _cwd| {
                show_preference_window(app_handle);
            },
        ))
        .setup(|app| {
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

            let preference_window = app.get_webview_window(PREFERENCE_WINDOW_LABEL).unwrap();

            request_webview_memory_target(&preference_window, WebviewMemoryTarget::Low);

            setup::default(&app_handle, main_window.clone(), preference_window.clone());

            if app.state::<PersistenceRecoveryState>().requires_attention() {
                show_preference_window(app_handle);
            }

            Ok(())
        })
        .invoke_handler(generate_handler![
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
            take_persistence_recovery_report
        ])
        .plugin(tauri_plugin_admin_status::init())
        .plugin(tauri_plugin_custom_window::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_pinia::Builder::default()
                .migration(
                    "model",
                    tauri_plugin_pinia::Migration::new("2.0.0", migrate_model_store_state),
                )
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(prevent_default::init())
        .plugin(
            tauri_plugin_log::Builder::new()
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
                if let Some(webview_window) = window.app_handle().get_webview_window(window.label())
                {
                    request_webview_memory_target(&webview_window, WebviewMemoryTarget::Low);
                }

                let _ = window.hide();

                api.prevent_close();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            show_preference_window(app_handle);
        }
        _ => {
            let _ = app_handle;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{MODEL_STORE_SCHEMA_VERSION, migrate_model_store_state};
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
}
