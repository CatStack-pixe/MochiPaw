// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

use gilrs::{EventType, Gilrs};
use serde::Serialize;
use std::{
    collections::HashSet,
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Runtime, command};
use tauri_plugin_log::log::{debug, error, info, warn};

static IS_LISTENING: AtomicBool = AtomicBool::new(false);
static LISTENING_SESSION: AtomicU64 = AtomicU64::new(0);
static LISTENER_DEMANDS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(8);

#[derive(Debug, Clone, Serialize)]
pub enum GamepadEventKind {
    ButtonChanged,
    AxisChanged,
}

#[derive(Debug, Clone, Serialize)]
pub struct GamepadEvent {
    kind: GamepadEventKind,
    name: String,
    value: f32,
}

#[command]
pub async fn start_gamepad_listing<R: Runtime>(app_handle: AppHandle<R>) -> Result<(), String> {
    info!(target: "mochi_paw::gamepad", "gamepad listener start requested");
    if IS_LISTENING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        debug!(target: "mochi_paw::gamepad", "gamepad listener already running");
        return Ok(());
    }

    let session = LISTENING_SESSION.fetch_add(1, Ordering::SeqCst) + 1;

    let gilrs = Gilrs::new().map_err(|err| {
        finish_session(session);
        error!(target: "mochi_paw::gamepad", "failed to initialize gamepad backend session={session}: {err}");

        err.to_string()
    })?;

    if !is_session_active(session) {
        return Ok(());
    }

    thread::Builder::new()
        .name("gamepad-listener".into())
        .spawn(move || listen_for_gamepad_events(app_handle, gilrs, session))
        .map_err(|err| {
            finish_session(session);
            error!(target: "mochi_paw::gamepad", "failed to spawn gamepad listener session={session}: {err}");

            format!("Failed to spawn gamepad listener: {err}")
        })?;

    Ok(())
}

fn listen_for_gamepad_events<R: Runtime>(app_handle: AppHandle<R>, mut gilrs: Gilrs, session: u64) {
    info!(target: "mochi_paw::gamepad", "gamepad listener thread started session={session}");
    while is_session_active(session) {
        let mut received_event = false;

        while let Some(event) = gilrs.next_event() {
            received_event = true;

            let gamepad_event = match event.event {
                EventType::ButtonChanged(button, value, ..) => GamepadEvent {
                    kind: GamepadEventKind::ButtonChanged,
                    name: format!("{:?}", button),
                    value,
                },
                EventType::AxisChanged(axis, value, ..) => GamepadEvent {
                    kind: GamepadEventKind::AxisChanged,
                    name: format!("{:?}", axis),
                    value,
                },
                _ => continue,
            };

            if let Err(error) = app_handle.emit_to("main", "gamepad-changed", &gamepad_event) {
                warn!(target: "mochi_paw::gamepad", "failed to emit gamepad event kind={:?}: {error}", gamepad_event.kind);
            }
        }

        if !received_event {
            thread::sleep(IDLE_POLL_INTERVAL);
        }
    }

    finish_session(session);
    info!(target: "mochi_paw::gamepad", "gamepad listener thread stopped session={session}");
}

#[command]
pub async fn stop_gamepad_listing() {
    info!(target: "mochi_paw::gamepad", "gamepad listener stop requested");
    LISTENING_SESSION.fetch_add(1, Ordering::SeqCst);
    IS_LISTENING.store(false, Ordering::SeqCst);
}

#[command]
pub async fn set_gamepad_listener_enabled<R: Runtime>(
    app_handle: AppHandle<R>,
    window_label: String,
    enabled: bool,
) -> Result<(), String> {
    debug!(target: "mochi_paw::gamepad", "gamepad listener demand changed window={} enabled={enabled}", window_label);
    let should_start = {
        let mut demands = LISTENER_DEMANDS.lock().map_err(|_| {
            error!(target: "mochi_paw::gamepad", "failed to lock gamepad listener demands");
            "Failed to lock gamepad listener demands".to_string()
        })?;
        let was_empty = demands.is_empty();

        if enabled {
            demands.insert(window_label);
        } else {
            demands.remove(&window_label);
        }

        was_empty && !demands.is_empty()
    };

    let should_stop = {
        let demands = LISTENER_DEMANDS.lock().map_err(|_| {
            error!(target: "mochi_paw::gamepad", "failed to lock gamepad listener demands");
            "Failed to lock gamepad listener demands".to_string()
        })?;

        demands.is_empty()
    };

    if should_start {
        info!(target: "mochi_paw::gamepad", "starting shared gamepad listener");
        start_gamepad_listing(app_handle).await?;
    } else if should_stop {
        info!(target: "mochi_paw::gamepad", "stopping shared gamepad listener");
        stop_gamepad_listing().await;
    }

    Ok(())
}

fn is_session_active(session: u64) -> bool {
    should_continue(
        IS_LISTENING.load(Ordering::SeqCst),
        LISTENING_SESSION.load(Ordering::SeqCst),
        session,
    )
}

fn finish_session(session: u64) {
    if LISTENING_SESSION.load(Ordering::SeqCst) == session {
        IS_LISTENING.store(false, Ordering::SeqCst);
    }
}

fn should_continue(is_listening: bool, active_session: u64, session: u64) -> bool {
    is_listening && active_session == session
}

#[cfg(test)]
mod tests {
    use super::{IDLE_POLL_INTERVAL, should_continue};

    #[test]
    fn listener_stops_when_the_session_changes() {
        assert!(!should_continue(true, 2, 1));
    }

    #[test]
    fn listener_runs_only_for_the_active_session() {
        assert!(should_continue(true, 2, 2));
        assert!(!should_continue(false, 2, 2));
    }

    #[test]
    fn idle_polling_uses_the_configured_interval() {
        assert_eq!(IDLE_POLL_INTERVAL, std::time::Duration::from_millis(8));
    }
}
