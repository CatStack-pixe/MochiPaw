use rdev::{Event, EventType, listen};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Runtime, command};

#[derive(Debug, Clone, Serialize)]
pub enum DeviceEventKind {
    MousePress,
    MouseRelease,
    MouseMove,
    KeyboardPress,
    KeyboardRelease,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceEvent {
    kind: DeviceEventKind,
    value: Value,
}

static IS_LISTENING: AtomicBool = AtomicBool::new(false);

#[command]
pub async fn start_device_listening<R: Runtime>(app_handle: AppHandle<R>) -> Result<(), String> {
    if IS_LISTENING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(());
    }

    let (event_sender, event_receiver) = mpsc::sync_channel::<DeviceEvent>(1024);
    let (startup_sender, startup_receiver) = mpsc::channel::<Result<(), String>>();

    thread::Builder::new()
        .name("device-event-emitter".into())
        .spawn(move || {
            while let Ok(device_event) = event_receiver.recv() {
                let _ = app_handle.emit("device-changed", device_event);
            }
        })
        .map_err(|err| {
            IS_LISTENING.store(false, Ordering::SeqCst);

            format!("Failed to spawn device event emitter: {err}")
        })?;

    let callback = move |event: Event| {
        let device_event = match event.event_type {
            EventType::ButtonPress(button) => DeviceEvent {
                kind: DeviceEventKind::MousePress,
                value: json!(format!("{:?}", button)),
            },
            EventType::ButtonRelease(button) => DeviceEvent {
                kind: DeviceEventKind::MouseRelease,
                value: json!(format!("{:?}", button)),
            },
            EventType::MouseMove { x, y } => DeviceEvent {
                kind: DeviceEventKind::MouseMove,
                value: json!({ "x": x, "y": y }),
            },
            EventType::KeyPress(key) => DeviceEvent {
                kind: DeviceEventKind::KeyboardPress,
                value: json!(format!("{:?}", key)),
            },
            EventType::KeyRelease(key) => DeviceEvent {
                kind: DeviceEventKind::KeyboardRelease,
                value: json!(format!("{:?}", key)),
            },
            _ => return,
        };

        let _ = event_sender.try_send(device_event);
    };

    thread::Builder::new()
        .name("device-listener".into())
        .spawn(move || {
            let listen_result =
                listen(callback).map_err(|err| format!("Failed to listen device: {:?}", err));

            IS_LISTENING.store(false, Ordering::SeqCst);

            let _ = startup_sender.send(listen_result);
        })
        .map_err(|err| {
            IS_LISTENING.store(false, Ordering::SeqCst);

            format!("Failed to spawn device listener: {err}")
        })?;

    if let Ok(result) = startup_receiver.recv_timeout(Duration::from_millis(300)) {
        result?;
    }

    Ok(())
}
