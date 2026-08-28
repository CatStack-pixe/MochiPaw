// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use futures_channel::oneshot;
use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Manager, Runtime, WebviewWindow, command, webview::PlatformWebview,
};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL, ICoreWebView2_19,
};
use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, GetLastError, HWND, SetLastError};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetWindowLongPtrW, HWND_NOTOPMOST, HWND_TOPMOST, SW_SHOWNOACTIVATE,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowLongPtrW, SetWindowPos,
    ShowWindow, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
};
use windows::core::Interface;

use super::{GAME_MODE_CHANGED_EVENT, GameModeConfig, WebviewMemoryTarget};

const GAME_MODE_POLL_INTERVAL: Duration = Duration::from_secs(2);
const GAME_MODE_STYLE_BITS: isize = WS_EX_NOACTIVATE.0 as isize;
const MANAGED_EX_STYLE_BITS: isize = GAME_MODE_STYLE_BITS | WS_EX_TRANSPARENT.0 as isize;

#[derive(Clone, Debug, PartialEq, Eq)]
struct GameModeSettings {
    enabled: bool,
    processes: HashSet<String>,
    always_on_top: bool,
    pass_through: bool,
}

impl GameModeSettings {
    fn from_config(config: GameModeConfig) -> Self {
        Self {
            enabled: config.enabled,
            processes: normalize_processes(config.processes),
            always_on_top: config.always_on_top,
            pass_through: config.pass_through,
        }
    }
}

#[derive(Default)]
struct GameModeState {
    settings: Option<GameModeSettings>,
    active: bool,
    generation: u64,
}

static GAME_MODE_STATE: OnceLock<Arc<Mutex<GameModeState>>> = OnceLock::new();

fn game_mode_state() -> &'static Arc<Mutex<GameModeState>> {
    GAME_MODE_STATE.get_or_init(|| Arc::new(Mutex::new(GameModeState::default())))
}

#[command]
pub async fn show_window<R: Runtime>(
    app_handle: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    let _ = set_webview_memory_target(window.clone(), WebviewMemoryTarget::Normal).await;

    if is_game_mode_window(&window)
        && let Ok(state) = game_mode_state().lock()
        && should_show_without_activation(state.active, true)
    {
        show_window_without_activation(&window)?;
        apply_window_game_mode(&window, true, state.settings.clone())?;
        return Ok(());
    }

    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;

    let _ = app_handle;
    Ok(())
}

#[command]
pub async fn hide_window<R: Runtime>(_app_handle: AppHandle<R>, window: WebviewWindow<R>) {
    let _ = set_webview_memory_target(window.clone(), WebviewMemoryTarget::Low).await;
    let _ = window.hide();
}

#[command]
pub async fn set_always_on_top<R: Runtime>(
    _app_handle: AppHandle<R>,
    window: WebviewWindow<R>,
    always_on_top: bool,
) -> Result<(), String> {
    if is_game_mode_window(&window) {
        let mut state = game_mode_state()
            .lock()
            .map_err(|_| "game mode state lock poisoned".to_owned())?;
        update_game_mode_always_on_top(&mut state, always_on_top);

        if state.active {
            return Ok(());
        }
    }

    set_window_topmost(&window, always_on_top)?;
    Ok(())
}

#[command]
pub async fn set_pass_through<R: Runtime>(
    _app_handle: AppHandle<R>,
    window: WebviewWindow<R>,
    pass_through: bool,
) -> Result<(), String> {
    if is_game_mode_window(&window) {
        let mut state = game_mode_state()
            .lock()
            .map_err(|_| "game mode state lock poisoned".to_owned())?;
        update_game_mode_pass_through(&mut state, pass_through);
        window
            .set_ignore_cursor_events(pass_through)
            .map_err(|error| error.to_string())?;
        update_managed_ex_style(
            window.hwnd().map_err(|error| error.to_string())?,
            managed_ex_style_bits(state.active, pass_through),
        )?;

        return Ok(());
    }

    window
        .set_ignore_cursor_events(pass_through)
        .map_err(|error| error.to_string())
}

#[command]
pub async fn set_game_mode<R: Runtime>(
    app_handle: AppHandle<R>,
    enabled: bool,
    processes: Vec<String>,
    always_on_top: bool,
    pass_through: bool,
) -> Result<bool, String> {
    let settings = GameModeSettings::from_config(GameModeConfig {
        enabled,
        processes,
        always_on_top,
        pass_through,
    });
    let should_start_worker;
    let active = settings.enabled
        && !settings.processes.is_empty()
        && configured_process_is_running(&settings.processes).unwrap_or(false);

    let mut state = game_mode_state()
        .lock()
        .map_err(|_| "game mode state lock poisoned".to_owned())?;
    should_start_worker = state.settings.is_none();
    state.generation = state.generation.wrapping_add(1);
    state.active = active;
    state.settings = Some(settings.clone());
    apply_game_mode(&app_handle, active, &settings)?;
    drop(state);

    if should_start_worker {
        spawn_game_mode_worker(app_handle)?;
    }

    Ok(active)
}

#[command]
pub async fn set_taskbar_visibility<R: Runtime>(window: WebviewWindow<R>, visible: bool) {
    let _ = window.set_skip_taskbar(!visible);
}

#[command]
pub async fn set_webview_memory_target<R: Runtime>(
    window: WebviewWindow<R>,
    target: WebviewMemoryTarget,
) -> bool {
    let (sender, receiver) = oneshot::channel();
    let scheduled = window.with_webview(move |webview| {
        let _ = sender.send(apply_webview_memory_target(webview, target));
    });

    if scheduled.is_err() {
        return false;
    }

    receiver.await.unwrap_or(false)
}

pub fn request_webview_memory_target<R: Runtime>(
    window: &WebviewWindow<R>,
    target: WebviewMemoryTarget,
) {
    let _ = window.with_webview(move |webview| {
        apply_webview_memory_target(webview, target);
    });
}

fn spawn_game_mode_worker<R: Runtime>(app_handle: AppHandle<R>) -> Result<(), String> {
    thread::Builder::new()
        .name("game-mode-detector".into())
        .spawn(move || {
            loop {
                thread::sleep(GAME_MODE_POLL_INTERVAL);

                let (settings, generation, was_active) = match game_mode_state().lock() {
                    Ok(state) => (state.settings.clone(), state.generation, state.active),
                    Err(_) => continue,
                };

                let Some(settings) = settings else {
                    continue;
                };
                let active = settings.enabled
                    && !settings.processes.is_empty()
                    && configured_process_is_running(&settings.processes).unwrap_or(false);

                if active == was_active {
                    continue;
                }

                if let Ok(mut state) = game_mode_state().lock()
                    && state.generation == generation
                {
                    state.active = active;
                    let _ = apply_game_mode(&app_handle, active, &settings);
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("failed to spawn game mode detector: {error}"))
}

pub fn apply_current_game_mode<R: Runtime>(window: &WebviewWindow<R>) {
    if !is_game_mode_window(window) {
        return;
    }

    let Ok(state) = game_mode_state().lock() else {
        return;
    };

    if state.active && apply_window_game_mode(window, true, state.settings.clone()).is_ok() {
        let _ = window.emit(GAME_MODE_CHANGED_EVENT, true);
    }
}

fn update_game_mode_always_on_top(state: &mut GameModeState, always_on_top: bool) {
    if let Some(settings) = state.settings.as_mut() {
        settings.always_on_top = always_on_top;
        state.generation = state.generation.wrapping_add(1);
    }
}

fn update_game_mode_pass_through(state: &mut GameModeState, pass_through: bool) {
    if let Some(settings) = state.settings.as_mut() {
        settings.pass_through = pass_through;
        state.generation = state.generation.wrapping_add(1);
    }
}

fn managed_ex_style_bits(game_mode_active: bool, pass_through: bool) -> isize {
    (if game_mode_active {
        GAME_MODE_STYLE_BITS
    } else {
        0
    }) | if pass_through {
        WS_EX_TRANSPARENT.0 as isize
    } else {
        0
    }
}

fn apply_game_mode<R: Runtime>(
    app_handle: &AppHandle<R>,
    active: bool,
    settings: &GameModeSettings,
) -> Result<(), String> {
    for window in app_handle.webview_windows().into_values() {
        if is_game_mode_window(&window) {
            apply_window_game_mode(&window, active, Some(settings.clone()))?;
            let _ = window.emit(GAME_MODE_CHANGED_EVENT, active);
        }
    }

    Ok(())
}

fn is_game_mode_window<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    window.label() == super::MAIN_WINDOW_LABEL
}

fn should_show_without_activation(game_mode_active: bool, is_game_mode_window: bool) -> bool {
    game_mode_active && is_game_mode_window
}

fn show_window_without_activation<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;

    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }

    Ok(())
}

fn apply_window_game_mode<R: Runtime>(
    window: &WebviewWindow<R>,
    active: bool,
    settings: Option<GameModeSettings>,
) -> Result<(), String> {
    let Some(settings) = settings else {
        return Ok(());
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    window
        .set_ignore_cursor_events(settings.pass_through)
        .map_err(|error| error.to_string())?;

    if active {
        update_managed_ex_style(hwnd, managed_ex_style_bits(true, settings.pass_through))?;
        set_hwnd_topmost(hwnd, false)?;
    } else {
        update_managed_ex_style(hwnd, managed_ex_style_bits(false, settings.pass_through))?;
        set_hwnd_topmost(hwnd, settings.always_on_top)?;
    }

    Ok(())
}

fn set_window_topmost<R: Runtime>(window: &WebviewWindow<R>, topmost: bool) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    set_hwnd_topmost(hwnd, topmost)
}

fn set_hwnd_topmost(hwnd: HWND, topmost: bool) -> Result<(), String> {
    unsafe {
        SetWindowPos(
            hwnd,
            Some(if topmost {
                HWND_TOPMOST
            } else {
                HWND_NOTOPMOST
            }),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
        .map_err(|error| error.to_string())
    }
}

fn update_managed_ex_style(hwnd: HWND, managed_bits: isize) -> Result<isize, String> {
    unsafe {
        SetLastError(ERROR_SUCCESS);
        let previous = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if previous == 0 && GetLastError() != ERROR_SUCCESS {
            return Err(windows::core::Error::from_win32().to_string());
        }
        let updated = (previous & !MANAGED_EX_STYLE_BITS) | managed_bits;

        if previous != updated {
            SetLastError(ERROR_SUCCESS);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, updated);
            if GetLastError() != ERROR_SUCCESS {
                return Err(windows::core::Error::from_win32().to_string());
            }
            SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            )
            .map_err(|error| error.to_string())?;
        }

        Ok(updated)
    }
}

fn normalize_processes(processes: Vec<String>) -> HashSet<String> {
    processes
        .into_iter()
        .map(|process| process.trim().to_ascii_lowercase())
        .filter(|process| !process.is_empty())
        .collect()
}

fn configured_process_is_running(processes: &HashSet<String>) -> Result<bool, String> {
    let snapshot = unsafe {
        CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|error| error.to_string())?
    };
    let result = unsafe { snapshot_contains_process(snapshot, processes) };
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    result
}

unsafe fn snapshot_contains_process(
    snapshot: windows::Win32::Foundation::HANDLE,
    processes: &HashSet<String>,
) -> Result<bool, String> {
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    unsafe {
        Process32FirstW(snapshot, &mut entry).map_err(|error| error.to_string())?;
    }

    loop {
        let executable = process_entry_name(&entry);
        if processes.contains(&executable) {
            return Ok(true);
        }
        unsafe {
            if Process32NextW(snapshot, &mut entry).is_err() {
                return Ok(false);
            }
        }
    }
}

fn process_entry_name(entry: &PROCESSENTRY32W) -> String {
    let length = entry
        .szExeFile
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(entry.szExeFile.len());
    String::from_utf16_lossy(&entry.szExeFile[..length]).to_ascii_lowercase()
}

fn apply_webview_memory_target(webview: PlatformWebview, target: WebviewMemoryTarget) -> bool {
    let level = match target {
        WebviewMemoryTarget::Normal => COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL(0),
        WebviewMemoryTarget::Low => COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL(1),
    };

    unsafe {
        webview
            .controller()
            .CoreWebView2()
            .and_then(|webview| webview.cast::<ICoreWebView2_19>())
            .and_then(|webview| webview.SetMemoryUsageTargetLevel(level))
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        GAME_MODE_STYLE_BITS, GameModeSettings, managed_ex_style_bits, normalize_processes,
        process_entry_name, should_show_without_activation,
    };
    use crate::commands::GameModeConfig;
    use windows::Win32::System::Diagnostics::ToolHelp::PROCESSENTRY32W;
    use windows::Win32::UI::WindowsAndMessaging::WS_EX_TRANSPARENT;

    #[test]
    fn normalizes_processes_case_insensitively_and_ignores_blanks() {
        let processes = normalize_processes(vec![
            " VALORANT-Win64-Shipping.exe ".into(),
            "valorant-win64-shipping.EXE".into(),
            " ".into(),
        ]);

        assert_eq!(processes.len(), 1);
        assert!(processes.contains("valorant-win64-shipping.exe"));
    }

    #[test]
    fn converts_process_entry_name_to_lowercase() {
        let mut entry = PROCESSENTRY32W::default();
        let name: Vec<u16> = "VALORANT.exe\0".encode_utf16().collect();
        entry.szExeFile[..name.len()].copy_from_slice(&name);

        assert_eq!(process_entry_name(&entry), "valorant.exe");
    }

    #[test]
    fn game_mode_settings_preserves_user_window_preferences() {
        let settings = GameModeSettings::from_config(GameModeConfig {
            enabled: true,
            processes: vec!["VALORANT.exe".into()],
            always_on_top: true,
            pass_through: true,
        });

        assert!(settings.enabled);
        assert!(settings.always_on_top);
        assert!(settings.pass_through);
    }

    #[test]
    fn only_the_active_main_window_uses_non_activating_show() {
        assert!(should_show_without_activation(true, true));
        assert!(!should_show_without_activation(false, true));
        assert!(!should_show_without_activation(true, false));
    }

    #[test]
    fn managed_styles_keep_game_mode_and_pass_through_bits_independent() {
        assert_eq!(managed_ex_style_bits(false, false), 0);
        assert_eq!(
            managed_ex_style_bits(false, true),
            WS_EX_TRANSPARENT.0 as isize
        );
        assert_eq!(managed_ex_style_bits(true, false), GAME_MODE_STYLE_BITS);
        assert_eq!(
            managed_ex_style_bits(true, true),
            GAME_MODE_STYLE_BITS | WS_EX_TRANSPARENT.0 as isize
        );
    }
}
