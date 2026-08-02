// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

//! Privileged Linux input relay for MochiPaw Wayland sessions.
//! It deliberately exposes only normalized key, button, and relative motion events.

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("mochi-paw-inputd is only available on Linux");
}

#[cfg(target_os = "linux")]
mod linux {
    use evdev::{Device, EventType};
    use serde::{Deserialize, Serialize};
    use std::{
        fs,
        io::{self, BufRead, Write},
        os::{
            fd::AsRawFd,
            unix::{
                fs::PermissionsExt,
                net::{UnixListener, UnixStream},
            },
        },
        path::{Path, PathBuf},
        process::Command,
        sync::mpsc,
        thread,
        time::Duration,
    };

    const SOCKET_NAME: &str = "mochi-paw-inputd.sock";

    #[derive(Serialize)]
    #[serde(tag = "kind", content = "value")]
    enum Message {
        Ready,
        KeyboardPress(String),
        KeyboardRelease(String),
        MousePress(String),
        MouseRelease(String),
        MouseRelativeMove { dx: i32, dy: i32 },
    }

    #[derive(Deserialize)]
    #[serde(tag = "kind")]
    enum ClientMessage {
        Subscribe,
    }

    struct Session {
        uid: u32,
        runtime_dir: PathBuf,
    }

    pub fn run() -> Result<(), String> {
        loop {
            let session = active_graphical_session()?;
            let socket_path = session.runtime_dir.join(SOCKET_NAME);
            let listener = bind_socket(&socket_path, session.uid)?;
            listener
                .set_nonblocking(true)
                .map_err(|error| format!("failed to configure input service socket: {error}"))?;

            loop {
                match listener.accept() {
                    Ok((stream, _)) if peer_uid(&stream) == Ok(session.uid) => {
                        let _ = serve_connection(stream);
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(250));
                    }
                    Err(error) => return Err(format!("input service socket error: {error}")),
                }

                // A session switch changes the authorized UID and socket location.
                if active_graphical_session()
                    .map(|next| next.uid != session.uid)
                    .unwrap_or(true)
                {
                    break;
                }
            }

            let _ = fs::remove_file(socket_path);
        }
    }

    fn active_graphical_session() -> Result<Session, String> {
        let sessions = Command::new("loginctl")
            .args(["list-sessions", "--no-legend"])
            .output()
            .map_err(|error| {
                format!("loginctl is required to validate the graphical session: {error}")
            })?;

        for line in String::from_utf8_lossy(&sessions.stdout).lines() {
            let Some(id) = line.split_whitespace().next() else {
                continue;
            };
            let output = Command::new("loginctl")
                .args([
                    "show-session",
                    id,
                    "--property=Active",
                    "--property=Type",
                    "--property=User",
                    "--value",
                ])
                .output()
                .map_err(|error| format!("failed to inspect login session: {error}"))?;
            let fields = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::to_owned)
                .collect::<Vec<_>>();

            if fields.len() < 3
                || fields[0] != "yes"
                || !matches!(fields[1].as_str(), "wayland" | "x11")
            {
                continue;
            }

            let uid = fields[2]
                .parse::<u32>()
                .map_err(|_| "loginctl returned an invalid session user".to_string())?;
            let runtime_dir = PathBuf::from(format!("/run/user/{uid}"));
            if runtime_dir.is_dir() {
                return Ok(Session { uid, runtime_dir });
            }
        }

        Err("no active graphical login session is available".into())
    }

    fn bind_socket(path: &Path, uid: u32) -> Result<UnixListener, String> {
        let _ = fs::remove_file(path);
        let listener = UnixListener::bind(path)
            .map_err(|error| format!("failed to bind input service socket: {error}"))?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to secure input service socket: {error}"))?;

        let path_bytes = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
            .map_err(|_| "input service socket path contains a null byte".to_string())?;
        if unsafe { libc::chown(path_bytes.as_ptr(), uid, u32::MAX) } != 0 {
            return Err(format!(
                "failed to assign input service socket to session user: {}",
                io::Error::last_os_error()
            ));
        }

        Ok(listener)
    }

    fn peer_uid(stream: &UnixStream) -> Result<u32, String> {
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let result = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut length,
            )
        };
        if result == 0 {
            Ok(credentials.uid)
        } else {
            Err(io::Error::last_os_error().to_string())
        }
    }

    fn write_message(stream: &mut UnixStream, message: &Message) -> Result<(), String> {
        serde_json::to_writer(&mut *stream, message)
            .map_err(|error| format!("failed to encode input event: {error}"))?;
        stream
            .write_all(b"\n")
            .map_err(|error| format!("failed to deliver input event: {error}"))?;
        stream
            .flush()
            .map_err(|error| format!("failed to flush input event: {error}"))
    }

    fn serve_connection(mut stream: UnixStream) -> Result<(), String> {
        write_message(&mut stream, &Message::Ready)?;
        let mut subscription = String::new();
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .map_err(|error| format!("failed to configure input service client: {error}"))?;
        std::io::BufReader::new(
            stream
                .try_clone()
                .map_err(|error| format!("failed to read input service client request: {error}"))?,
        )
        .read_line(&mut subscription)
        .map_err(|error| format!("input service client did not subscribe: {error}"))?;
        if subscription.len() > 4096
            || !matches!(
                serde_json::from_str(&subscription),
                Ok(ClientMessage::Subscribe)
            )
        {
            return Ok(());
        }
        stream
            .set_read_timeout(None)
            .map_err(|error| format!("failed to configure input service client: {error}"))?;

        let (sender, receiver) = mpsc::sync_channel(512);

        for path in input_devices()? {
            let sender = sender.clone();
            thread::spawn(move || read_device(path, sender));
        }
        drop(sender);

        while let Ok(message) = receiver.recv() {
            if write_message(&mut stream, &message).is_err() {
                return Ok(());
            }
        }

        Ok(())
    }

    fn input_devices() -> Result<Vec<PathBuf>, String> {
        let entries = fs::read_dir("/dev/input")
            .map_err(|error| format!("cannot read /dev/input: {error}"))?;
        Ok(entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("event"))
            })
            .collect())
    }

    fn read_device(path: PathBuf, sender: mpsc::SyncSender<Message>) {
        let Ok(mut device) = Device::open(path) else {
            return;
        };
        loop {
            match device.fetch_events() {
                Ok(events) => {
                    for event in events {
                        if let Some(message) =
                            normalize_event(event.event_type(), event.code(), event.value())
                        {
                            if sender.send(message).is_err() {
                                return;
                            }
                        }
                    }
                }
                Err(_) => thread::sleep(Duration::from_millis(25)),
            }
        }
    }

    fn normalize_event(kind: EventType, code: u16, value: i32) -> Option<Message> {
        match kind {
            EventType::KEY if code == 272 => button_event("Left", value),
            EventType::KEY if code == 273 => button_event("Right", value),
            EventType::KEY => key_event(key_name(code)?, value),
            EventType::RELATIVE if code == 0 && value != 0 => {
                Some(Message::MouseRelativeMove { dx: value, dy: 0 })
            }
            EventType::RELATIVE if code == 1 && value != 0 => {
                Some(Message::MouseRelativeMove { dx: 0, dy: value })
            }
            _ => None,
        }
    }

    fn button_event(button: &str, value: i32) -> Option<Message> {
        match value {
            1 => Some(Message::MousePress(button.into())),
            0 => Some(Message::MouseRelease(button.into())),
            _ => None,
        }
    }

    fn key_event(key: &str, value: i32) -> Option<Message> {
        match value {
            1 => Some(Message::KeyboardPress(key.into())),
            0 => Some(Message::KeyboardRelease(key.into())),
            _ => None,
        }
    }

    // Names deliberately match rdev's debug representation used by existing models.
    fn key_name(code: u16) -> Option<&'static str> {
        const LETTERS: [&str; 26] = [
            "KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP", "KeyA",
            "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "KeyZ", "KeyX", "KeyC",
            "KeyV", "KeyB", "KeyN", "KeyM",
        ];
        match code {
            2..=11 => Some(
                [
                    "Num1", "Num2", "Num3", "Num4", "Num5", "Num6", "Num7", "Num8", "Num9", "Num0",
                ][(code - 2) as usize],
            ),
            16..=25 => Some(LETTERS[(code - 16) as usize]),
            30..=38 => Some(LETTERS[(code - 30 + 10) as usize]),
            44..=50 => Some(LETTERS[(code - 44 + 19) as usize]),
            1 => Some("Escape"),
            14 => Some("Backspace"),
            15 => Some("Tab"),
            28 => Some("Return"),
            29 => Some("ControlLeft"),
            42 => Some("ShiftLeft"),
            54 => Some("ShiftRight"),
            56 => Some("Alt"),
            57 => Some("Space"),
            58 => Some("CapsLock"),
            69 => Some("NumLock"),
            97 => Some("ControlRight"),
            100 => Some("AltGr"),
            102 => Some("Home"),
            103 => Some("UpArrow"),
            104 => Some("PageUp"),
            105 => Some("LeftArrow"),
            106 => Some("RightArrow"),
            107 => Some("End"),
            108 => Some("DownArrow"),
            109 => Some("PageDown"),
            111 => Some("Delete"),
            125 => Some("MetaLeft"),
            126 => Some("MetaRight"),
            59..=68 => Some(
                ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"][(code - 59) as usize],
            ),
            87 => Some("F11"),
            88 => Some("F12"),
            _ => None,
        }
    }
}

#[cfg(target_os = "linux")]
fn main() {
    if let Err(error) = linux::run() {
        eprintln!("mochi-paw-inputd: {error}");
        std::process::exit(1);
    }
}
