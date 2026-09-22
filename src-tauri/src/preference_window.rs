// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_custom_window::PREFERENCE_WINDOW_LABEL;

pub const CLOSE_PREFERENCE_EVENT: &str = "close-preference-window";
const UPDATE_PREFERENCE_EVENT: &str = "preference-update-requested";

static WINDOW_LOCK: OnceLock<tauri::async_runtime::Mutex<()>> = OnceLock::new();
static OPEN_REVISION: AtomicU64 = AtomicU64::new(0);
static WINDOW_READY: AtomicBool = AtomicBool::new(false);
static UPDATE_PENDING: AtomicU8 = AtomicU8::new(0);

pub fn request_preference_window(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = show_preference_window(app).await {
            crate::diagnostics::record_error("preference-window", &error);
        }
    });
}

/// Keep creation in Rust so every Windows webview uses the same local data root.
#[tauri::command]
pub async fn show_preference_window(app: AppHandle) -> Result<(), String> {
    let _guard = WINDOW_LOCK
        .get_or_init(|| tauri::async_runtime::Mutex::new(()))
        .lock()
        .await;
    OPEN_REVISION.fetch_add(1, Ordering::SeqCst);

    if let Some(window) = app.get_webview_window(PREFERENCE_WINDOW_LABEL) {
        if WINDOW_READY.load(Ordering::SeqCst) {
            show(&window)?;
        }
        return Ok(());
    }

    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == PREFERENCE_WINDOW_LABEL)
        .ok_or("Preferences window configuration is missing")?;
    WINDOW_READY.store(false, Ordering::SeqCst);
    let builder = WebviewWindowBuilder::from_config(&app, config)
        .map_err(|error| error.to_string())?
        .visible(false);
    #[cfg(target_os = "windows")]
    let builder = builder.data_directory(crate::data_paths::windows_data_paths()?.webview());
    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

fn show(window: &WebviewWindow) -> Result<(), String> {
    tauri_plugin_custom_window::request_webview_memory_target(
        window,
        tauri_plugin_custom_window::WebviewMemoryTarget::Normal,
    );
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn preference_window_ready(window: WebviewWindow) -> Result<(), String> {
    if window.label() != PREFERENCE_WINDOW_LABEL {
        return Err("Only the preferences window can mark itself ready".into());
    }
    WINDOW_READY.store(true, Ordering::SeqCst);
    show(&window)
}

#[tauri::command]
pub async fn request_preference_update(app: AppHandle, visible_message: bool) -> Result<(), String> {
    UPDATE_PENDING.fetch_max(if visible_message { 2 } else { 1 }, Ordering::SeqCst);
    show_preference_window(app.clone()).await?;
    app.emit_to(PREFERENCE_WINDOW_LABEL, UPDATE_PREFERENCE_EVENT, ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn take_pending_preference_update(window: WebviewWindow) -> Option<bool> {
    if window.label() != PREFERENCE_WINDOW_LABEL {
        return None;
    }
    match UPDATE_PENDING.swap(0, Ordering::SeqCst) {
        0 => None,
        kind => Some(kind == 2),
    }
}

#[tauri::command]
pub fn begin_preference_close(window: WebviewWindow) -> Result<u64, String> {
    if window.label() != PREFERENCE_WINDOW_LABEL {
        return Err("Only the preferences window can close itself".into());
    }
    Ok(OPEN_REVISION.load(Ordering::SeqCst))
}

/// A new open request while persistence is flushing cancels that pending close.
#[tauri::command]
pub async fn complete_preference_close(window: WebviewWindow, revision: u64) -> Result<bool, String> {
    if window.label() != PREFERENCE_WINDOW_LABEL {
        return Err("Only the preferences window can close itself".into());
    }
    let _guard = WINDOW_LOCK
        .get_or_init(|| tauri::async_runtime::Mutex::new(()))
        .lock()
        .await;
    if revision != OPEN_REVISION.load(Ordering::SeqCst) {
        show(&window)?;
        return Ok(false);
    }

    // Wait for native teardown before another request can reuse this label.
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let _ = sender.try_send(());
        }
    });
    window.destroy().map_err(|error| error.to_string())?;
    let _ = receiver.recv().await;
    WINDOW_READY.store(false, Ordering::SeqCst);
    Ok(true)
}
