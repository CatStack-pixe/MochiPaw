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
    if IS_LISTENING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(());
    }

    let session = LISTENING_SESSION.fetch_add(1, Ordering::SeqCst) + 1;

    let gilrs = Gilrs::new().map_err(|err| {
        finish_session(session);

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

            format!("Failed to spawn gamepad listener: {err}")
        })?;

    Ok(())
}

fn listen_for_gamepad_events<R: Runtime>(app_handle: AppHandle<R>, mut gilrs: Gilrs, session: u64) {
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

            let _ = app_handle.emit_to("main", "gamepad-changed", gamepad_event);
        }

        if !received_event {
            thread::sleep(IDLE_POLL_INTERVAL);
        }
    }

    finish_session(session);
}

#[command]
pub async fn stop_gamepad_listing() {
    LISTENING_SESSION.fetch_add(1, Ordering::SeqCst);
    IS_LISTENING.store(false, Ordering::SeqCst);
}

#[command]
pub async fn set_gamepad_listener_enabled<R: Runtime>(
    app_handle: AppHandle<R>,
    window_label: String,
    enabled: bool,
) -> Result<(), String> {
    let should_start = {
        let mut demands = LISTENER_DEMANDS
            .lock()
            .map_err(|_| "Failed to lock gamepad listener demands".to_string())?;
        let was_empty = demands.is_empty();

        if enabled {
            demands.insert(window_label);
        } else {
            demands.remove(&window_label);
        }

        was_empty && !demands.is_empty()
    };

    let should_stop = {
        let demands = LISTENER_DEMANDS
            .lock()
            .map_err(|_| "Failed to lock gamepad listener demands".to_string())?;

        demands.is_empty()
    };

    if should_start {
        start_gamepad_listing(app_handle).await?;
    } else if should_stop {
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
