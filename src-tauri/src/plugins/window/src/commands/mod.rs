// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, async_runtime::spawn};
#[cfg(not(target_os = "windows"))]
use tauri::{Emitter, Runtime, command};

pub static MAIN_WINDOW_LABEL: &str = "main";
pub static PREFERENCE_WINDOW_LABEL: &str = "preference";
pub static GAME_MODE_CHANGED_EVENT: &str = "game-mode-changed";
pub static OVERLAY_STATE_CHANGED_EVENT: &str = "overlay-state-changed";

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

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverlayWindowState {
    pub enabled: bool,
    pub active: bool,
    pub backend: OverlayBackend,
    pub backend_active: bool,
    pub process_name: Option<String>,
    pub process_id: Option<u32>,
    pub window_handle: Option<u64>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub dpi_scale: f64,
    pub minimized: bool,
    pub target_fps: u16,
    pub model_id: Option<String>,
    pub gamebar_active: bool,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OverlayBackend {
    #[default]
    Desktop,
    Gamebar,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlaySessionConfig {
    pub enabled: bool,
    #[serde(default)]
    pub processes: Vec<String>,
    #[serde(default = "default_overlay_target_fps")]
    pub target_fps: u16,
    #[serde(default)]
    pub pass_through: bool,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub backend: OverlayBackend,
}

fn default_overlay_target_fps() -> u16 {
    60
}

pub fn normalize_overlay_target_fps(value: u16) -> u16 {
    match value {
        90 => 90,
        120 => 120,
        _ => 60,
    }
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
pub async fn set_overlay_session<R: Runtime>(
    _app_handle: AppHandle<R>,
    _config: OverlaySessionConfig,
) -> Result<OverlayWindowState, String> {
    Ok(OverlayWindowState::default())
}

#[cfg(not(target_os = "windows"))]
#[command]
pub async fn get_overlay_window_state<R: Runtime>(
    _app_handle: AppHandle<R>,
) -> Result<OverlayWindowState, String> {
    Ok(OverlayWindowState::default())
}

#[cfg(test)]
mod tests {
    use super::normalize_overlay_target_fps;

    #[test]
    fn normalizes_overlay_target_fps_to_supported_values() {
        assert_eq!(normalize_overlay_target_fps(30), 60);
        assert_eq!(normalize_overlay_target_fps(60), 60);
        assert_eq!(normalize_overlay_target_fps(90), 90);
        assert_eq!(normalize_overlay_target_fps(120), 120);
        assert_eq!(normalize_overlay_target_fps(144), 60);
    }
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
