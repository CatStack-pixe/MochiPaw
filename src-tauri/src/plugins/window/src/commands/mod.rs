// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use serde::Deserialize;
use tauri::{AppHandle, Manager, async_runtime::spawn};
#[cfg(not(target_os = "windows"))]
use tauri::{Emitter, Runtime, command};

pub static MAIN_WINDOW_LABEL: &str = "main";
pub static PREFERENCE_WINDOW_LABEL: &str = "preference";
pub static GAME_MODE_CHANGED_EVENT: &str = "game-mode-changed";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameModeConfig {
    pub enabled: bool,
    #[serde(default)]
    pub processes: Vec<String>,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default)]
    pub pass_through: bool,
}

#[cfg(not(target_os = "windows"))]
#[command]
pub async fn set_game_mode<R: Runtime>(
    app_handle: AppHandle<R>,
    _enabled: bool,
    _processes: Vec<String>,
    _always_on_top: bool,
    _pass_through: bool,
) -> Result<bool, String> {
    for window in app_handle.webview_windows().into_values() {
        if window.label() == MAIN_WINDOW_LABEL {
            let _ = window.emit(GAME_MODE_CHANGED_EVENT, false);
        }
    }

    Ok(false)
}

#[cfg(not(target_os = "windows"))]
#[command]
pub async fn set_pass_through<R: Runtime>(
    _app_handle: AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    pass_through: bool,
) -> Result<(), String> {
    window
        .set_ignore_cursor_events(pass_through)
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn apply_current_game_mode<R: Runtime>(_window: &tauri::WebviewWindow<R>) {}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WebviewMemoryTarget {
    Normal,
    Low,
}

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "windows")]
pub use windows::*;

#[cfg(target_os = "linux")]
pub use linux::*;

pub fn show_main_window(app_handle: &AppHandle) {
    show_window_by_label(app_handle, MAIN_WINDOW_LABEL);
}

pub fn show_preference_window(app_handle: &AppHandle) {
    show_window_by_label(app_handle, PREFERENCE_WINDOW_LABEL);
}

fn show_window_by_label(app_handle: &AppHandle, label: &str) {
    let Some(window) = app_handle.get_webview_window(label) else {
        return;
    };

    let app_handle = app_handle.clone();

    spawn(async move {
        let _ = show_window(app_handle, window).await;
    });
}
