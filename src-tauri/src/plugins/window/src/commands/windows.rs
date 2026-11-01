// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use futures_channel::oneshot;
use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
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
    GWL_EXSTYLE, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId,
    HWND_NOTOPMOST, HWND_TOPMOST, IsIconic, IsWindowVisible, SW_HIDE, SW_SHOWNOACTIVATE,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowLongPtrW, SetWindowPos,
    ShowWindow, WS_EX_NOACTIVATE, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
};
use windows::core::Interface;

use super::{
    GAME_MODE_CHANGED_EVENT, GameModeConfig, OVERLAY_STATE_CHANGED_EVENT, OverlayBackend,
    OverlaySessionConfig, OverlayWindowState, WebviewMemoryTarget, normalize_overlay_target_fps,
};

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
static OVERLAY_SESSION_STATE: OnceLock<Arc<Mutex<Option<OverlaySession>>>> = OnceLock::new();
static GAMEBAR_SYNC_STATE: OnceLock<Mutex<GameBarSyncState>> = OnceLock::new();
const GAMEBAR_PIPE: &str = r"\\.\pipe\MochiPaw.GameBarOverlay";

#[derive(Clone)]
struct OverlayWindowFrame {
    rect: windows::Win32::Foundation::RECT,
    was_visible: bool,
    was_topmost: bool,
    original_managed_styles: isize,
}

#[derive(Clone)]
struct OverlaySession {
    config: OverlaySessionConfig,
    original_frame: Option<OverlayWindowFrame>,
    last_state: Option<OverlayWindowState>,
}

#[derive(Default)]
struct GameBarSyncState {
    session: Option<serde_json::Value>,
    state: Option<serde_json::Value>,
    last_verified_at: Option<Instant>,
}

fn game_mode_state() -> &'static Arc<Mutex<GameModeState>> {
    GAME_MODE_STATE.get_or_init(|| Arc::new(Mutex::new(GameModeState::default())))
}

fn overlay_session_state() -> &'static Arc<Mutex<Option<OverlaySession>>> {
    OVERLAY_SESSION_STATE.get_or_init(|| Arc::new(Mutex::new(None)))
}

fn gamebar_sync_state() -> &'static Mutex<GameBarSyncState> {
    GAMEBAR_SYNC_STATE.get_or_init(|| Mutex::new(GameBarSyncState::default()))
}
#[command]
pub async fn set_overlay_session<R: Runtime>(
    app_handle: AppHandle<R>,
    mut config: OverlaySessionConfig,
) -> Result<OverlayWindowState, String> {
    config.target_fps = normalize_overlay_target_fps(config.target_fps);
    let mut session = overlay_session_state()
        .lock()
        .map_err(|_| "overlay session state lock poisoned".to_owned())?;
    if !config.enabled {
        if let Some(previous) = session.take() {
            if previous.config.backend == OverlayBackend::Gamebar {
                let disabled_state = OverlayWindowState {
                    target_fps: previous.config.target_fps,
                    model_id: previous.config.model_id.clone(),
                    ..OverlayWindowState::default()
                };
                let _ = send_gamebar_state(&OverlaySessionConfig {
                    enabled: false,
                    ..previous.config.clone()
                }, &disabled_state);
            }
            restore_overlay_window(&app_handle, previous.original_frame.as_ref())?;
        }
        if let Ok(mut state) = gamebar_sync_state().lock() {
            *state = GameBarSyncState::default();
        }
        let snapshot = OverlayWindowState::default();
        let _ = app_handle.emit(OVERLAY_STATE_CHANGED_EVENT, snapshot.clone());
        return Ok(snapshot);
    }

    let previous = session.take();
    let original_frame = match previous.as_ref().and_then(|existing| existing.original_frame.clone()) {
        Some(frame) => Some(frame),
        None => Some(capture_overlay_window(&app_handle)?),
    };
    let frame_for_apply = original_frame.clone();
    if previous.as_ref().is_some_and(|previous| {
        previous.config.backend == OverlayBackend::Gamebar
            && previous.config.backend != config.backend
    }) {
        if let Some(previous) = previous.as_ref() {
            let disabled_state = OverlayWindowState {
                target_fps: previous.config.target_fps,
                model_id: previous.config.model_id.clone(),
                ..OverlayWindowState::default()
            };
            let _ = send_gamebar_state(
                &OverlaySessionConfig {
                    enabled: false,
                    ..previous.config.clone()
                },
                &disabled_state,
            );
        }
    }
    *session = Some(OverlaySession {
        config: config.clone(),
        original_frame,
        last_state: None,
    });
    drop(session);
    if let Ok(mut state) = gamebar_sync_state().lock() {
        *state = GameBarSyncState::default();
    }

    let mut snapshot = query_overlay_window_state(Some(&config))?;
    if config.backend == OverlayBackend::Gamebar {
        apply_gamebar_backend(&app_handle, &config, frame_for_apply.as_ref(), &mut snapshot)?;
    } else {
        apply_overlay_window(&app_handle, &snapshot, Some(&config), frame_for_apply.as_ref())?;
        snapshot.backend_active = snapshot.active && !snapshot.minimized;
    }
    if let Ok(mut session) = overlay_session_state().lock()
        && let Some(session) = session.as_mut()
    {
        session.last_state = Some(snapshot.clone());
    }
    let _ = app_handle.emit(OVERLAY_STATE_CHANGED_EVENT, snapshot.clone());
    Ok(snapshot)
}

#[command]
pub async fn get_overlay_window_state<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<OverlayWindowState, String> {
    let (config, frame, previous_state) = {
        let session = overlay_session_state()
            .lock()
            .map_err(|_| "overlay session state lock poisoned".to_owned())?;
        let Some(session) = session.as_ref() else {
            return Ok(OverlayWindowState::default());
        };
        (
            session.config.clone(),
            session.original_frame.clone(),
            session.last_state.clone(),
        )
    };
    if !config.enabled {
        return Ok(OverlayWindowState::default());
    }

    let mut snapshot = query_overlay_window_state(Some(&config))?;
    if config.backend == OverlayBackend::Gamebar {
        apply_gamebar_backend(&app_handle, &config, frame.as_ref(), &mut snapshot)?;
    } else if previous_state.as_ref().is_none_or(|previous| overlay_target_changed(previous, &snapshot)) {
        apply_overlay_window(&app_handle, &snapshot, Some(&config), frame.as_ref())?;
        snapshot.backend_active = snapshot.active && !snapshot.minimized;
    } else if let Some(previous_state) = previous_state {
        snapshot.backend_active = previous_state.backend_active;
    }
    if let Ok(mut session) = overlay_session_state().lock()
        && let Some(session) = session.as_mut()
    {
        session.last_state = Some(snapshot.clone());
    }
    Ok(snapshot)
}

fn overlay_target_changed(previous: &OverlayWindowState, current: &OverlayWindowState) -> bool {
    previous.enabled != current.enabled
        || previous.active != current.active
        || previous.process_name != current.process_name
        || previous.process_id != current.process_id
        || previous.window_handle != current.window_handle
        || previous.x != current.x
        || previous.y != current.y
        || previous.width != current.width
        || previous.height != current.height
        || previous.minimized != current.minimized
        || previous.target_fps != current.target_fps
        || previous.model_id != current.model_id
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

fn query_overlay_window_state(
    config: Option<&OverlaySessionConfig>,
) -> Result<OverlayWindowState, String> {
    let Some(config) = config else {
        return Ok(OverlayWindowState::default());
    };

    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Ok(OverlayWindowState {
            enabled: config.enabled,
            backend: config.backend,
            target_fps: config.target_fps,
            model_id: config.model_id.clone(),
            ..OverlayWindowState::default()
        });
    }

    let mut process_id = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    }
    let process_name = process_name_for_pid(process_id).unwrap_or_default();
    let matches = !config.processes.is_empty()
        && config
            .processes
            .iter()
            .map(|value| value.trim().to_ascii_lowercase())
            .any(|value| value == process_name);

    let mut rect = windows::Win32::Foundation::RECT::default();
    let has_rect = unsafe { GetWindowRect(hwnd, &mut rect).is_ok() };
    let width = if has_rect {
        rect.right.saturating_sub(rect.left).max(0) as u32
    } else {
        0
    };
    let height = if has_rect {
        rect.bottom.saturating_sub(rect.top).max(0) as u32
    } else {
        0
    };

    Ok(OverlayWindowState {
        enabled: config.enabled,
        active: config.enabled && matches && has_rect,
        backend: config.backend,
        backend_active: false,
        process_name: (!process_name.is_empty()).then_some(process_name),
        process_id: Some(process_id),
        window_handle: Some(hwnd.0 as usize as u64),
        x: rect.left,
        y: rect.top,
        width,
        height,
        dpi_scale: 1.0,
        minimized: unsafe { IsIconic(hwnd).as_bool() },
        target_fps: config.target_fps,
        model_id: config.model_id.clone(),
        gamebar_active: false,
        error: None,
    })
}

fn apply_gamebar_backend<R: Runtime>(
    app_handle: &AppHandle<R>,
    config: &OverlaySessionConfig,
    original_frame: Option<&OverlayWindowFrame>,
    state: &mut OverlayWindowState,
) -> Result<(), String> {
    match send_gamebar_state(config, state) {
        Ok(()) => {
            state.gamebar_active = true;
            state.backend_active = state.active && !state.minimized;
            state.error = None;
            hide_overlay_window(app_handle)?;
        }
        Err(error) => {
            state.gamebar_active = false;
            state.backend_active = false;
            state.error = Some(error);
            if state.active && !state.minimized {
                apply_overlay_window(app_handle, state, Some(config), original_frame)?;
                state.backend_active = true;
            } else {
                hide_overlay_window(app_handle)?;
            }
        }
    }

    Ok(())
}

fn send_gamebar_state(
    config: &OverlaySessionConfig,
    state: &OverlayWindowState,
) -> Result<(), String> {
    let session_message = serde_json::json!({
        "protocol_version": 1,
        "type": "set-overlay-session",
        "enabled": config.enabled,
        "target_fps": config.target_fps,
        "pass_through": config.pass_through,
        "model_id": config.model_id,
    });
    let state_message = serde_json::json!({
        "protocol_version": 1,
        "type": "set-overlay-state",
        "enabled": config.enabled,
        "target_fps": config.target_fps,
        "pass_through": config.pass_through,
        "model_id": config.model_id,
        "active": state.active && !state.minimized,
        "process_name": state.process_name,
        "process_id": state.process_id,
        "window_handle": state.window_handle,
        "x": state.x,
        "y": state.y,
        "width": state.width,
        "height": state.height,
        "dpi_scale": state.dpi_scale,
        "minimized": state.minimized,
    });

    let mut cache = gamebar_sync_state()
        .lock()
        .map_err(|_| "Game Bar synchronization lock poisoned".to_owned())?;
    if cache.session.as_ref() != Some(&session_message) {
        let response = send_gamebar_message_locked(session_message.clone())?;
        ensure_gamebar_request_accepted(&response)?;
        cache.session = Some(session_message);
        cache.state = None;
    }
    let should_verify = cache
        .last_verified_at
        .is_none_or(|last| last.elapsed() >= Duration::from_secs(2));
    if cache.state.as_ref() != Some(&state_message) || should_verify {
        let response = send_gamebar_message_locked(state_message.clone())?;
        ensure_gamebar_request_accepted(&response)?;
        cache.state = Some(state_message);
        cache.last_verified_at = Some(Instant::now());
    }
    Ok(())
}

fn ensure_gamebar_request_accepted(response: &serde_json::Value) -> Result<(), String> {
    if response
        .get("accepted")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(());
    }

    Err(response
        .get("error")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("Game Bar widget rejected the overlay request")
        .to_owned())
}

fn send_gamebar_message_locked(message: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .open(GAMEBAR_PIPE)
        .map_err(|error| format!("Game Bar companion pipe is unavailable: {error}"))?;
    let mut payload = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
    payload.push(b'\n');
    pipe.write_all(&payload).map_err(|error| error.to_string())?;
    pipe.flush().map_err(|error| error.to_string())?;

    let mut response = String::new();
    BufReader::new(pipe)
        .read_line(&mut response)
        .map_err(|error| error.to_string())?;
    serde_json::from_str(&response).map_err(|error| error.to_string())
}

fn capture_overlay_window<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<OverlayWindowFrame, String> {
    let window = app_handle
        .get_webview_window(super::MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main overlay window is unavailable".to_owned())?;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let mut rect = windows::Win32::Foundation::RECT::default();
    unsafe {
        GetWindowRect(hwnd, &mut rect).map_err(|error| error.to_string())?;
    }
    let original_ex_style = unsafe {
        SetLastError(ERROR_SUCCESS);
        let value = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if value == 0 && GetLastError() != ERROR_SUCCESS {
            return Err(windows::core::Error::from_win32().to_string());
        }
        value
    };
    Ok(OverlayWindowFrame {
        rect,
        was_visible: unsafe { IsWindowVisible(hwnd).as_bool() },
        was_topmost: original_ex_style & WS_EX_TOPMOST.0 as isize != 0,
        original_managed_styles: original_ex_style & MANAGED_EX_STYLE_BITS,
    })
}

fn apply_overlay_window<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &OverlayWindowState,
    config: Option<&OverlaySessionConfig>,
    original_frame: Option<&OverlayWindowFrame>,
) -> Result<(), String> {
    let window = app_handle
        .get_webview_window(super::MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main overlay window is unavailable".to_owned())?;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;

    if !state.active || state.minimized || state.width == 0 || state.height == 0 {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
        return Ok(());
    }

    update_managed_ex_style(
        hwnd,
        managed_ex_style_bits(true, config.map(|value| value.pass_through).unwrap_or(true)),
    )?;
    let original_frame = original_frame
        .ok_or_else(|| "original overlay window frame was not captured".to_owned())?;
    let target_rect = windows::Win32::Foundation::RECT {
        left: state.x,
        top: state.y,
        right: state.x.saturating_add(state.width.min(i32::MAX as u32) as i32),
        bottom: state.y.saturating_add(state.height.min(i32::MAX as u32) as i32),
    };
    let overlay_rect = overlay_rect_for_target(&target_rect, &original_frame.rect);
    unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            overlay_rect.left,
            overlay_rect.top,
            overlay_rect.right.saturating_sub(overlay_rect.left),
            overlay_rect.bottom.saturating_sub(overlay_rect.top),
            SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
        .map_err(|error| error.to_string())?;
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    Ok(())
}

fn overlay_rect_for_target(
    target: &windows::Win32::Foundation::RECT,
    original: &windows::Win32::Foundation::RECT,
) -> windows::Win32::Foundation::RECT {
    let target_width = target.right.saturating_sub(target.left).max(0);
    let target_height = target.bottom.saturating_sub(target.top).max(0);
    let width = original
        .right
        .saturating_sub(original.left)
        .max(0)
        .min(target_width);
    let height = original
        .bottom
        .saturating_sub(original.top)
        .max(0)
        .min(target_height);
    let inset = 16;
    let right = target.right;
    let left = right.saturating_sub(width).saturating_sub(inset).max(target.left);
    let bottom = target.bottom;
    let top = target.top.saturating_add(inset).min(bottom.saturating_sub(height));

    windows::Win32::Foundation::RECT {
        left,
        top,
        right: left.saturating_add(width),
        bottom: top.saturating_add(height),
    }
}

fn restore_overlay_window<R: Runtime>(
    app_handle: &AppHandle<R>,
    frame: Option<&OverlayWindowFrame>,
) -> Result<(), String> {
    let Some(frame) = frame else {
        return Ok(());
    };
    let Some(window) = app_handle.get_webview_window(super::MAIN_WINDOW_LABEL) else {
        return Ok(());
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let (game_mode_active, game_mode_settings) = game_mode_state()
        .lock()
        .map(|state| (state.active, state.settings.clone()))
        .unwrap_or((false, None));
    let managed_bits = game_mode_settings
        .as_ref()
        .map(|settings| managed_ex_style_bits(game_mode_active, settings.pass_through))
        .unwrap_or(frame.original_managed_styles);
    update_managed_ex_style(hwnd, managed_bits)?;
    if let Some(settings) = game_mode_settings {
        set_hwnd_topmost(hwnd, !game_mode_active && settings.always_on_top)?;
    } else {
        set_hwnd_topmost(hwnd, frame.was_topmost)?;
    }
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            frame.rect.left,
            frame.rect.top,
            frame.rect.right.saturating_sub(frame.rect.left),
            frame.rect.bottom.saturating_sub(frame.rect.top),
            SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
        .map_err(|error| error.to_string())?;
        let _ = ShowWindow(
            hwnd,
            if frame.was_visible { SW_SHOWNOACTIVATE } else { SW_HIDE },
        );
    }
    Ok(())
}

fn hide_overlay_window<R: Runtime>(app_handle: &AppHandle<R>) -> Result<(), String> {
    let Some(window) = app_handle.get_webview_window(super::MAIN_WINDOW_LABEL) else {
        return Ok(());
    };
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
    Ok(())
}

fn process_name_for_pid(process_id: u32) -> Option<String> {
    let snapshot = unsafe {
        CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?
    };
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let result = unsafe {
        if Process32FirstW(snapshot, &mut entry).is_err() {
            return None
        } else {
            loop {
                if entry.th32ProcessID == process_id {
                    break Some(process_entry_name(&entry));
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break None;
                }
            }
        }
    };
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    result
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
