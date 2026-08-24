// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

use rdev::{Event, EventType, listen};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Runtime, command};
use tauri_plugin_log::log::{debug, error, info, warn};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DeviceEventKind {
    MousePress,
    MouseRelease,
    MouseMove,
    MouseRelativeMove,
    KeyboardPress,
    KeyboardRelease,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceEvent {
    kind: DeviceEventKind,
    value: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInputStatus {
    pub backend: String,
    pub available: bool,
    pub authorized: bool,
    pub hover_supported: bool,
    pub error: Option<String>,
}

static IS_LISTENING: AtomicBool = AtomicBool::new(false);
static DROPPED_EVENTS: AtomicU64 = AtomicU64::new(0);

#[command]
pub fn get_device_input_status() -> DeviceInputStatus {
    let backend = select_backend();
    let status = match backend {
        InputBackend::Rdev => DeviceInputStatus {
            backend: "rdev".into(),
            available: true,
            authorized: true,
            hover_supported: true,
            error: None,
        },
        #[cfg(target_os = "linux")]
        InputBackend::WaylandService if IS_LISTENING.load(Ordering::SeqCst) => DeviceInputStatus {
            backend: "wayland-service".into(),
            available: true,
            authorized: true,
            hover_supported: false,
            error: None,
        },
        #[cfg(target_os = "linux")]
        InputBackend::WaylandService => match probe_wayland_service() {
            Ok(_) => DeviceInputStatus {
                backend: "wayland-service".into(),
                available: true,
                authorized: true,
                hover_supported: false,
                error: None,
            },
            Err(error) => DeviceInputStatus {
                backend: "wayland-service".into(),
                available: false,
                authorized: false,
                hover_supported: false,
                error: Some(error),
            },
        },
        #[cfg(target_os = "linux")]
        InputBackend::WaylandAppImage => DeviceInputStatus {
            backend: "wayland-appimage".into(),
            available: false,
            authorized: false,
            hover_supported: false,
            error: Some("AppImage packages do not install the Wayland input service.".into()),
        },
    };
    debug!(
        target: "mochi_paw::device",
        "device input status backend={:?} available={} authorized={} hover_supported={} listening={}",
        backend_name(&backend), status.available, status.authorized, status.hover_supported,
        IS_LISTENING.load(Ordering::SeqCst)
    );
    if !status.available || !status.authorized {
        warn!(target: "mochi_paw::device", "device input backend unavailable backend={} reason={}", backend_name(&backend), status.error.as_deref().unwrap_or("unknown"));
    }
    status
}

#[command]
pub async fn start_device_listening<R: Runtime>(app_handle: AppHandle<R>) -> Result<(), String> {
    let backend = select_backend();
    info!(target: "mochi_paw::device", "device listener start requested backend={}", backend_name(&backend));
    if IS_LISTENING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        debug!(target: "mochi_paw::device", "device listener already running");
        return Ok(());
    }

    let (event_sender, event_receiver) = mpsc::sync_channel::<DeviceEvent>(1024);
    let (startup_sender, startup_receiver) = mpsc::channel::<Result<(), String>>();

    thread::Builder::new()
        .name("device-event-emitter".into())
        .spawn(move || {
            while let Ok(device_event) = event_receiver.recv() {
                if let Err(error) = app_handle.emit_to("main", "device-changed", &device_event) {
                    warn!(target: "mochi_paw::device", "failed to emit device event kind={:?}: {error}", device_event.kind);
                }
            }
        })
        .map_err(|error| {
            IS_LISTENING.store(false, Ordering::SeqCst);
            error!(target: "mochi_paw::device", "failed to spawn device event emitter: {error}");
            format!("Failed to spawn device event emitter: {error}")
        })?;

    thread::Builder::new()
        .name("device-listener".into())
        .spawn(move || {
            let result = match select_backend() {
                InputBackend::Rdev => listen_rdev(event_sender),
                #[cfg(target_os = "linux")]
                InputBackend::WaylandService => listen_wayland_service(event_sender),
                #[cfg(target_os = "linux")]
                InputBackend::WaylandAppImage => {
                    Err("Global input is unavailable for AppImage on Wayland.".into())
                }
            };

            IS_LISTENING.store(false, Ordering::SeqCst);
            if let Err(error) = &result {
                error!(target: "mochi_paw::device", "device listener stopped with error backend={} error={error}", backend_name(&select_backend()));
            } else {
                info!(target: "mochi_paw::device", "device listener stopped backend={}", backend_name(&select_backend()));
            }
            let _ = startup_sender.send(result);
        })
        .map_err(|error| {
            IS_LISTENING.store(false, Ordering::SeqCst);
            error!(target: "mochi_paw::device", "failed to spawn device listener: {error}");
            format!("Failed to spawn device listener: {error}")
        })?;

    if let Ok(result) = startup_receiver.recv_timeout(Duration::from_millis(300)) {
        result?;
    } else {
        debug!(target: "mochi_paw::device", "device listener startup did not complete within 300ms");
    }

    info!(target: "mochi_paw::device", "device listener start accepted backend={}", backend_name(&backend));
    Ok(())
}

fn listen_rdev(event_sender: mpsc::SyncSender<DeviceEvent>) -> Result<(), String> {
    let callback = move |event: Event| {
        let device_event = match event.event_type {
            EventType::ButtonPress(button) => DeviceEvent {
                kind: DeviceEventKind::MousePress,
                value: json!(format!("{button:?}")),
            },
            EventType::ButtonRelease(button) => DeviceEvent {
                kind: DeviceEventKind::MouseRelease,
                value: json!(format!("{button:?}")),
            },
            EventType::MouseMove { x, y } => DeviceEvent {
                kind: DeviceEventKind::MouseMove,
                value: json!({ "x": x, "y": y }),
            },
            EventType::KeyPress(key) => DeviceEvent {
                kind: DeviceEventKind::KeyboardPress,
                value: json!(format!("{key:?}")),
            },
            EventType::KeyRelease(key) => DeviceEvent {
                kind: DeviceEventKind::KeyboardRelease,
                value: json!(format!("{key:?}")),
            },
            _ => return,
        };
        if event_sender.try_send(device_event).is_err() {
            let dropped = DROPPED_EVENTS.fetch_add(1, Ordering::Relaxed) + 1;
            if dropped == 1 || dropped % 100 == 0 {
                warn!(target: "mochi_paw::device", "device event queue full dropped_events={dropped}");
            }
        }
    };

    listen(callback).map_err(|error| format!("Failed to listen device: {error:?}"))
}

#[derive(Debug, Clone, Copy)]
enum InputBackend {
    Rdev,
    #[cfg(target_os = "linux")]
    WaylandService,
    #[cfg(target_os = "linux")]
    WaylandAppImage,
}

fn select_backend() -> InputBackend {
    #[cfg(target_os = "linux")]
    if is_wayland_session() {
        return if std::env::var_os("APPIMAGE").is_some() {
            InputBackend::WaylandAppImage
        } else {
            InputBackend::WaylandService
        };
    }

    InputBackend::Rdev
}

fn backend_name(backend: &InputBackend) -> &'static str {
    match backend {
        InputBackend::Rdev => "rdev",
        #[cfg(target_os = "linux")]
        InputBackend::WaylandService => "wayland-service",
        #[cfg(target_os = "linux")]
        InputBackend::WaylandAppImage => "wayland-appimage",
    }
}

#[cfg(target_os = "linux")]
fn is_wayland_session() -> bool {
    if std::env::var_os("MOCHI_PAW_FORCE_X11").is_some() {
        return false;
    }

    matches!(std::env::var("XDG_SESSION_TYPE").as_deref(), Ok("wayland"))
        || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

#[cfg(target_os = "linux")]
fn daemon_socket_path() -> Result<std::path::PathBuf, String> {
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR").ok_or_else(|| {
        "XDG_RUNTIME_DIR is unavailable for the active Wayland session.".to_string()
    })?;
    Ok(std::path::PathBuf::from(runtime_dir).join("mochi-paw-inputd.sock"))
}

#[cfg(target_os = "linux")]
fn connect_wayland_service() -> Result<std::os::unix::net::UnixStream, String> {
    let socket_path = daemon_socket_path()?;
    std::os::unix::net::UnixStream::connect(&socket_path).map_err(|error| {
        warn!(target: "mochi_paw::device", "Wayland input service connection failed socket={} error={error}", socket_path.display());
        format!(
            "Wayland input service is unavailable at {}: {error}",
            socket_path.display()
        )
    })
}

#[cfg(target_os = "linux")]
fn probe_wayland_service() -> Result<(), String> {
    use std::io::{BufRead, BufReader};

    let stream = connect_wayland_service()?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| format!("failed to validate Wayland input service: {error}"))?;
    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|error| format!("Wayland input service did not confirm this session: {error}"))?;

    if line.trim() == r#"{"kind":"Ready"}"# {
        debug!(target: "mochi_paw::device", "Wayland input service probe succeeded");
        Ok(())
    } else {
        warn!(target: "mochi_paw::device", "Wayland input service returned unexpected probe response length={}", line.len());
        Err("Wayland input service rejected the active session.".into())
    }
}

#[cfg(target_os = "linux")]
fn listen_wayland_service(event_sender: mpsc::SyncSender<DeviceEvent>) -> Result<(), String> {
    use std::io::{BufRead, BufReader, Write};

    let mut stream = connect_wayland_service()?;
    stream
        .write_all(b"{\"kind\":\"Subscribe\"}\n")
        .map_err(|error| {
            error!(target: "mochi_paw::device", "failed to subscribe to Wayland input service: {error}");
            format!("failed to subscribe to Wayland input service: {error}")
        })?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();

    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|error| format!("Wayland input service disconnected: {error}"))?;
        if bytes == 0 {
            warn!(target: "mochi_paw::device", "Wayland input service disconnected");
            return Err("Wayland input service disconnected.".into());
        }
        if line.len() > 4096 {
            warn!(target: "mochi_paw::device", "Wayland input service sent oversized message bytes={bytes}");
            return Err("Wayland input service sent an oversized message.".into());
        }

        let event: DaemonMessage = serde_json::from_str(&line)
            .map_err(|error| {
                warn!(target: "mochi_paw::device", "Wayland input service sent invalid message bytes={bytes} error={error}");
                format!("Wayland input service sent an invalid message: {error}")
            })?;
        if let Some(event) = event.into_device_event() {
            if event_sender.try_send(event).is_err() {
                let dropped = DROPPED_EVENTS.fetch_add(1, Ordering::Relaxed) + 1;
                if dropped == 1 || dropped % 100 == 0 {
                    warn!(target: "mochi_paw::device", "Wayland device event queue full dropped_events={dropped}");
                }
            }
        }
    }
}

#[cfg(target_os = "linux")]
#[derive(Deserialize)]
#[serde(tag = "kind", content = "value")]
enum DaemonMessage {
    Ready,
    KeyboardPress(String),
    KeyboardRelease(String),
    MousePress(String),
    MouseRelease(String),
    MouseRelativeMove { dx: i32, dy: i32 },
}

#[cfg(target_os = "linux")]
impl DaemonMessage {
    fn into_device_event(self) -> Option<DeviceEvent> {
        match self {
            Self::Ready => None,
            Self::KeyboardPress(value) => Some(DeviceEvent {
                kind: DeviceEventKind::KeyboardPress,
                value: json!(value),
            }),
            Self::KeyboardRelease(value) => Some(DeviceEvent {
                kind: DeviceEventKind::KeyboardRelease,
                value: json!(value),
            }),
            Self::MousePress(value) => Some(DeviceEvent {
                kind: DeviceEventKind::MousePress,
                value: json!(value),
            }),
            Self::MouseRelease(value) => Some(DeviceEvent {
                kind: DeviceEventKind::MouseRelease,
                value: json!(value),
            }),
            Self::MouseRelativeMove { dx, dy } => Some(DeviceEvent {
                kind: DeviceEventKind::MouseRelativeMove,
                value: json!({ "dx": dx, "dy": dy }),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_linux_uses_rdev() {
        #[cfg(not(target_os = "linux"))]
        assert!(matches!(select_backend(), InputBackend::Rdev));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn daemon_ready_message_is_not_emitted() {
        assert!(DaemonMessage::Ready.into_device_event().is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn relative_message_is_normalized() {
        let event = DaemonMessage::MouseRelativeMove { dx: 4, dy: -2 }
            .into_device_event()
            .unwrap();
        assert_eq!(event.kind, DeviceEventKind::MouseRelativeMove);
        assert_eq!(event.value, json!({ "dx": 4, "dy": -2 }));
    }
}
