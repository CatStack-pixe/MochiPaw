// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use super::{DeviceEvent, DeviceEventKind, DeviceInputStatus, IS_LISTENING};
use crate::{
    linux_input::{EvdevReader, InputEvent},
    linux_session::current_user_session_active,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::BTreeSet,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{ffi::OsStrExt, net::UnixStream},
    },
    path::{Path, PathBuf},
    sync::{Mutex, atomic::Ordering, mpsc},
    thread,
    time::{Duration, Instant},
};

const SESSION_INTERVAL: Duration = Duration::from_secs(1);
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const MAX_MESSAGE_BYTES: usize = 4096;
const SERVICE_RETRY_DELAY: Duration = Duration::from_secs(5);
static STATUS: Mutex<Option<DeviceInputStatus>> = Mutex::new(None);

fn input_status(backend: &str, error: Option<String>) -> DeviceInputStatus {
    DeviceInputStatus {
        backend: backend.into(),
        available: error.is_none(),
        authorized: error.is_none(),
        hover_supported: false,
        error,
    }
}

fn publish(backend: &str, error: Option<String>) {
    if let Ok(mut status) = STATUS.lock() {
        *status = Some(input_status(backend, error));
    }
}

pub(super) fn mark_starting() {
    publish(
        "wayland-evdev",
        Some("Starting Wayland input listener.".into()),
    );
}

pub(super) fn status() -> DeviceInputStatus {
    if IS_LISTENING.load(Ordering::SeqCst) {
        return STATUS
            .lock()
            .ok()
            .and_then(|status| status.clone())
            .unwrap_or_else(|| {
                input_status("wayland-evdev", Some("Starting input listener.".into()))
            });
    }
    match session_ready().and_then(|()| open_connection(false, &mut ServiceRetry::default())) {
        Ok(connection) => input_status(connection.backend(), None),
        Err(error) => input_status("wayland-evdev", Some(error)),
    }
}

fn session_ready() -> Result<(), String> {
    if current_user_session_active()? {
        Ok(())
    } else {
        Err(
            "Input is paused until this user's local graphical session is active and unlocked."
                .into(),
        )
    }
}

enum Connection {
    Service(ServiceConnection),
    Evdev(EvdevReader),
}

impl Connection {
    fn backend(&self) -> &'static str {
        match self {
            Self::Service(_) => "wayland-service",
            Self::Evdev(_) => "wayland-evdev",
        }
    }

    fn poll(&mut self) -> Result<Vec<InputEvent>, String> {
        match self {
            Self::Service(service) => service.poll(),
            Self::Evdev(reader) => reader.poll_events(),
        }
    }

    fn error(&self) -> Option<String> {
        match self {
            Self::Service(_) => None,
            Self::Evdev(reader) if reader.available() => None,
            Self::Evdev(reader) => reader
                .status_error()
                .or_else(|| Some("No readable input devices.".into())),
        }
    }
}

fn service_or_evdev<T>(
    service: impl FnOnce() -> Result<T, String>,
    evdev: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    service().or_else(|service_error| {
        evdev().map_err(|error| format!("{error} (Input service: {service_error})"))
    })
}

#[derive(Default)]
struct ServiceRetry {
    failure: Option<(Instant, String)>,
}

impl ServiceRetry {
    fn failed(&mut self, error: String) {
        self.failure = Some((Instant::now(), error));
    }

    fn deferred_error(&self, now: Instant) -> Option<&str> {
        self.failure.as_ref().and_then(|(at, error)| {
            (now.saturating_duration_since(*at) < SERVICE_RETRY_DELAY).then_some(error.as_str())
        })
    }
}

fn open_connection(subscribe: bool, retry: &mut ServiceRetry) -> Result<Connection, String> {
    // Package format does not determine input access. AppImage can use either
    // an already installed relay or evdev permissions granted to this user.
    service_or_evdev(
        || {
            if let Some(error) = retry.deferred_error(Instant::now()) {
                return Err(error.to_owned());
            }
            let result: Result<Connection, String> = (|| {
                let mut service = ServiceConnection::connect()?;
                if subscribe {
                    service.subscribe()?;
                }
                Ok(Connection::Service(service))
            })();
            if let Err(error) = &result {
                retry.failed(error.clone());
            }
            result
        },
        || EvdevReader::open().map(Connection::Evdev),
    )
}

pub(super) fn listen(
    sender: mpsc::SyncSender<DeviceEvent>,
    startup: mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let mut connection: Option<Connection> = None;
    let mut pressed = PressedInputs::default();
    let mut next_session_check = Instant::now();
    let mut session_error = None;
    let mut startup = Some(startup);
    let mut retry = ServiceRetry::default();

    loop {
        if Instant::now() >= next_session_check {
            session_error = session_ready().err();
            next_session_check = Instant::now() + SESSION_INTERVAL;
        }
        if let Some(error) = &session_error {
            connection = None; // Close evdev fds and discard buffered input.
            if !pressed.release_all(&sender) {
                return Ok(());
            }
            publish("wayland-evdev", Some(error.clone()));
            if let Some(startup) = startup.take() {
                let _ = startup.send(Err(error.clone()));
            }
            thread::sleep(POLL_INTERVAL);
            continue;
        }
        if connection.is_none() {
            match open_connection(true, &mut retry) {
                Ok(next) => {
                    publish(next.backend(), None);
                    connection = Some(next);
                    if let Some(startup) = startup.take() {
                        let _ = startup.send(Ok(()));
                    }
                }
                Err(error) => {
                    publish("wayland-evdev", Some(error.clone()));
                    if let Some(startup) = startup.take() {
                        let _ = startup.send(Err(error));
                    }
                    thread::sleep(SESSION_INTERVAL);
                    continue;
                }
            }
        }

        let active = connection.as_mut().expect("input connection established");
        match active.poll() {
            Ok(events) => {
                // A timed read may cross the session-check deadline. Check again
                // before forwarding that batch, not after exposing its events.
                if Instant::now() >= next_session_check {
                    session_error = session_ready().err();
                    next_session_check = Instant::now() + SESSION_INTERVAL;
                    if session_error.is_some() {
                        continue;
                    }
                }
                publish(active.backend(), active.error());
                for event in events {
                    if !pressed.forward(event, &sender) {
                        return Ok(());
                    }
                }
            }
            Err(error) => {
                // Older or busy daemons can send Ready then close after Subscribe.
                // Cool down the service after EOF too, allowing direct evdev on
                // the next attempt instead of repeatedly choosing the bad socket.
                if matches!(active, Connection::Service(_)) {
                    retry.failed(error.clone());
                }
                publish(active.backend(), Some(error));
                connection = None;
                if !pressed.release_all(&sender) {
                    return Ok(());
                }
                thread::sleep(POLL_INTERVAL);
            }
        }
    }
}

#[derive(Default)]
struct PressedInputs {
    keys: BTreeSet<String>,
    buttons: BTreeSet<String>,
}

impl PressedInputs {
    fn forward(&mut self, event: InputEvent, sender: &mpsc::SyncSender<DeviceEvent>) -> bool {
        let (kind, value) = match event {
            InputEvent::KeyboardPress(key) => {
                self.keys.insert(key.clone());
                (DeviceEventKind::KeyboardPress, json!(key))
            }
            InputEvent::KeyboardRelease(key) => {
                self.keys.remove(&key);
                (DeviceEventKind::KeyboardRelease, json!(key))
            }
            InputEvent::MousePress(button) => {
                self.buttons.insert(button.clone());
                (DeviceEventKind::MousePress, json!(button))
            }
            InputEvent::MouseRelease(button) => {
                self.buttons.remove(&button);
                (DeviceEventKind::MouseRelease, json!(button))
            }
            InputEvent::MouseRelativeMove { dx, dy } => (
                DeviceEventKind::MouseRelativeMove,
                json!({ "dx": dx, "dy": dy }),
            ),
        };
        // The bounded emitter drains independently of the WebView. Preserve
        // press/release ordering rather than dropping a key-up on a full queue.
        sender.send(DeviceEvent { kind, value }).is_ok()
    }

    fn release_all(&mut self, sender: &mpsc::SyncSender<DeviceEvent>) -> bool {
        for key in std::mem::take(&mut self.keys) {
            if !self.forward(InputEvent::KeyboardRelease(key), sender) {
                return false;
            }
        }
        for button in std::mem::take(&mut self.buttons) {
            if !self.forward(InputEvent::MouseRelease(button), sender) {
                return false;
            }
        }
        true
    }
}

struct ServiceConnection {
    stream: UnixStream,
    decoder: MessageDecoder,
}

fn connect_service_socket(path: &Path) -> io::Result<UnixStream> {
    let bytes = path.as_os_str().as_bytes();
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.is_empty() || bytes.len() >= address.sun_path.len() || bytes.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid input service socket path",
        ));
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (target, source) in address.sun_path.iter_mut().zip(bytes) {
        *target = *source as libc::c_char;
    }
    let raw = unsafe {
        libc::socket(
            libc::AF_UNIX,
            libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
            0,
        )
    };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    // OwnedFd closes every failed connection. A full AF_UNIX accept queue returns
    // EAGAIN here instead of holding up evdev fallback or session checks.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let length = std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1;
    if unsafe {
        libc::connect(
            fd.as_raw_fd(),
            (&address as *const libc::sockaddr_un).cast(),
            length as libc::socklen_t,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let stream = UnixStream::from(fd);
    stream.set_nonblocking(false)?;
    Ok(stream)
}

impl ServiceConnection {
    fn connect() -> Result<Self, String> {
        let runtime = std::env::var_os("XDG_RUNTIME_DIR").ok_or("XDG_RUNTIME_DIR is not set")?;
        let path = PathBuf::from(runtime).join("mochi-paw-inputd.sock");
        let stream = connect_service_socket(&path).map_err(|error| error.to_string())?;
        stream
            .set_read_timeout(Some(POLL_INTERVAL))
            .map_err(|error| error.to_string())?;
        stream
            .set_write_timeout(Some(POLL_INTERVAL))
            .map_err(|error| error.to_string())?;
        let mut connection = Self {
            stream,
            decoder: MessageDecoder::default(),
        };
        let deadline = Instant::now() + Duration::from_secs(1);
        while !connection.decoder.ready {
            if Instant::now() >= deadline {
                return Err("Input service handshake timed out.".into());
            }
            if !connection.poll()?.is_empty() {
                return Err("Input service sent events before subscription.".into());
            }
        }
        Ok(connection)
    }

    fn subscribe(&mut self) -> Result<(), String> {
        self.stream
            .write_all(b"{\"kind\":\"Subscribe\"}\n")
            .map_err(|error| error.to_string())
    }

    fn poll(&mut self) -> Result<Vec<InputEvent>, String> {
        let mut bytes = [0u8; 2048];
        match self.stream.read(&mut bytes) {
            Ok(0) => Err("Input service disconnected.".into()),
            Ok(count) => self.decoder.push(&bytes[..count]),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) =>
            {
                Ok(Vec::new())
            }
            Err(error) => Err(format!("Input service read failed: {error}")),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind")]
enum ControlMessage {
    Ready,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireMessage {
    Input(InputEvent),
    Control(ControlMessage),
}

#[derive(Default)]
struct MessageDecoder {
    pending: Vec<u8>,
    ready: bool,
}

impl MessageDecoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<InputEvent>, String> {
        let mut events = Vec::new();
        for byte in bytes {
            if *byte == b'\n' {
                let message: WireMessage = serde_json::from_slice(&self.pending)
                    .map_err(|_| "Invalid input service message.".to_owned())?;
                self.pending.clear();
                match message {
                    WireMessage::Control(ControlMessage::Ready) => self.ready = true,
                    WireMessage::Input(event) => events.push(event),
                }
            } else {
                if self.pending.len() >= MAX_MESSAGE_BYTES {
                    return Err("Input service message exceeds 4096 bytes.".into());
                }
                self.pending.push(*byte);
            }
        }
        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_service_accept_queue_does_not_block_evdev_fallback() {
        use std::{os::unix::net::UnixListener, time::SystemTime};
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("mp-input-{}-{unique}.sock", std::process::id()));
        let listener = UnixListener::bind(&path).unwrap();
        assert_eq!(unsafe { libc::listen(listener.as_raw_fd(), 0) }, 0);
        let first = connect_service_socket(&path).unwrap();
        let (sender, receiver) = mpsc::channel();
        let worker_path = path.clone();
        let worker = thread::spawn(move || {
            let _ = sender.send(connect_service_socket(&worker_path).map(|_| ()));
        });
        let result = receiver.recv_timeout(Duration::from_secs(2));
        let _ = std::fs::remove_file(path);
        drop(first);
        drop(listener);
        assert_eq!(
            result.unwrap().unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        worker.join().unwrap();
    }

    #[test]
    fn service_is_preferred_and_evdev_is_used_after_service_failure() {
        assert_eq!(
            service_or_evdev(|| Ok("service"), || panic!("unneeded device access")).unwrap(),
            "service"
        );
        assert_eq!(
            service_or_evdev(|| Err("not installed".into()), || Ok("evdev")).unwrap(),
            "evdev"
        );
        let error = service_or_evdev::<()>(
            || Err("not installed".into()),
            || Err("permission denied".into()),
        )
        .unwrap_err();
        assert!(error.contains("permission denied"));
        assert!(error.contains("not installed"));
    }

    #[test]
    fn split_service_messages_preserve_relative_motion_and_ignore_ready() {
        let mut decoder = MessageDecoder::default();
        assert!(decoder.push(b"{\"kind\":\"Re").unwrap().is_empty());
        assert!(!decoder.ready);
        assert!(
            decoder
                .push(b"ady\"}\n{\"kind\":\"MouseRelativeMove\",\"value\":{")
                .unwrap()
                .is_empty()
        );
        assert!(decoder.ready);
        let events = decoder.push(b"\"dx\":4,\"dy\":-2}}\n").unwrap();
        assert!(matches!(
            events.as_slice(),
            [InputEvent::MouseRelativeMove { dx: 4, dy: -2 }]
        ));
    }

    #[test]
    fn malformed_and_oversized_messages_are_rejected() {
        assert!(
            MessageDecoder::default()
                .push(b"{\"kind\":\"unsupported\"}\n")
                .is_err()
        );
        let mut decoder = MessageDecoder::default();
        assert!(decoder.push(&vec![b'a'; MAX_MESSAGE_BYTES]).is_ok());
        assert!(decoder.push(b"b").is_err());
    }

    #[test]
    fn disconnected_service_is_cooled_down_before_retrying() {
        let mut retry = ServiceRetry::default();
        assert_eq!(retry.deferred_error(Instant::now()), None);
        retry.failed("service closed after subscription".into());
        let at = retry.failure.as_ref().unwrap().0;
        assert_eq!(
            retry.deferred_error(at),
            Some("service closed after subscription")
        );
        assert_eq!(retry.deferred_error(at + SERVICE_RETRY_DELAY), None);
    }

    #[test]
    fn session_pause_releases_held_inputs_once() {
        let (sender, receiver) = mpsc::sync_channel(16);
        let mut pressed = PressedInputs::default();
        pressed.forward(InputEvent::KeyboardPress("KeyA".into()), &sender);
        pressed.forward(InputEvent::KeyboardPress("KeyA".into()), &sender);
        pressed.forward(InputEvent::MousePress("Left".into()), &sender);
        assert!(pressed.release_all(&sender));
        assert!(pressed.release_all(&sender));
        let events = receiver.try_iter().collect::<Vec<_>>();
        assert_eq!(events.len(), 5);
        assert_eq!(events[3].kind, DeviceEventKind::KeyboardRelease);
        assert_eq!(events[4].kind, DeviceEventKind::MouseRelease);
    }

    #[test]
    fn closed_emitter_stops_forwarding() {
        let (sender, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        assert!(
            !PressedInputs::default().forward(InputEvent::KeyboardPress("KeyA".into()), &sender)
        );
    }
}
