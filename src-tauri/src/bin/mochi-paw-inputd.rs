// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

//! Privileged Linux input relay for MochiPaw Wayland sessions.
//! It exposes only normalized key, button, and relative motion events.

#[cfg(target_os = "linux")]
#[path = "../linux_input.rs"]
mod linux_input;
#[cfg(target_os = "linux")]
#[path = "../linux_session.rs"]
mod linux_session;

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("mochi-paw-inputd is only available on Linux");
}

#[cfg(target_os = "linux")]
mod linux {
    use crate::{
        linux_input::EvdevReader,
        linux_session::{Session, active_graphical_session},
    };
    use serde::{Deserialize, Serialize};
    use std::{
        fs,
        io::{self, Read, Write},
        os::{
            fd::AsRawFd,
            unix::{
                fs::PermissionsExt,
                net::{UnixListener, UnixStream},
            },
        },
        path::Path,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
        thread,
        time::{Duration, Instant},
    };

    const SOCKET_NAME: &str = "mochi-paw-inputd.sock";
    const SESSION_CHECK_INTERVAL: Duration = Duration::from_millis(500);

    #[derive(Deserialize)]
    #[serde(tag = "kind")]
    enum ClientMessage {
        Subscribe,
    }

    /// Both short-lived probes and long-lived subscriptions are bounded.
    struct ConnectionSlot(Arc<AtomicUsize>);

    impl ConnectionSlot {
        fn acquire(counter: &Arc<AtomicUsize>, limit: usize) -> Option<Self> {
            counter
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                    (value < limit).then_some(value + 1)
                })
                .ok()
                .map(|_| Self(Arc::clone(counter)))
        }
    }

    impl Drop for ConnectionSlot {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }

    pub fn run() -> Result<(), String> {
        let connections = Arc::new(AtomicUsize::new(0));
        let subscribers = Arc::new(AtomicUsize::new(0));
        loop {
            let Ok(session) = active_graphical_session() else {
                // At boot and while locked there need not be an eligible session.
                thread::sleep(SESSION_CHECK_INTERVAL);
                continue;
            };
            serve_session(session, &connections, &subscribers)?;
        }
    }

    fn serve_session(
        session: Session,
        connections: &Arc<AtomicUsize>,
        subscribers: &Arc<AtomicUsize>,
    ) -> Result<(), String> {
        let socket_path = session.runtime_dir.join(SOCKET_NAME);
        let listener = bind_socket(&socket_path, session.uid)?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("failed to configure input service socket: {error}"))?;
        let active = Arc::new(AtomicBool::new(true));
        let mut checked_at = Instant::now();
        let result = (|| {
            loop {
                if checked_at.elapsed() >= SESSION_CHECK_INTERVAL {
                    if active_graphical_session().ok().as_ref() != Some(&session) {
                        return Ok(());
                    }
                    checked_at = Instant::now();
                }
                match listener.accept() {
                    Ok((stream, _)) if peer_uid(&stream) == Ok(session.uid) => {
                        if let Some(slot) = ConnectionSlot::acquire(connections, 4) {
                            let active = Arc::clone(&active);
                            let subscribers = Arc::clone(subscribers);
                            thread::Builder::new()
                                .name("inputd-client".into())
                                .spawn(move || {
                                    let _slot = slot;
                                    let _ = serve_connection(stream, &active, &subscribers);
                                })
                                .map_err(|error| {
                                    format!("failed to start input service client: {error}")
                                })?;
                        }
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                    Err(error) => return Err(format!("input service socket error: {error}")),
                }
                thread::sleep(Duration::from_millis(25));
            }
        })();
        // Worker polling and bounded socket I/O promptly drop every open evdev fd.
        active.store(false, Ordering::SeqCst);
        drop(listener);
        let _ = fs::remove_file(socket_path);
        result
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

    fn write_message(stream: &mut UnixStream, message: &impl Serialize) -> Result<(), String> {
        serde_json::to_writer(&mut *stream, message)
            .map_err(|error| format!("failed to encode input event: {error}"))?;
        stream
            .write_all(b"\n")
            .map_err(|error| format!("failed to deliver input event: {error}"))
    }

    fn prepare_connection<T>(
        stream: &mut UnixStream,
        active: &AtomicBool,
        open_reader: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        if !active.load(Ordering::SeqCst) {
            return Err("the graphical login session is inactive".into());
        }
        let reader = open_reader()?;
        if !active.load(Ordering::SeqCst) {
            return Err("the graphical login session became inactive".into());
        }
        write_message(stream, &serde_json::json!({"kind": "Ready"}))?;
        Ok(reader)
    }

    fn serve_connection(
        mut stream: UnixStream,
        active: &AtomicBool,
        subscribers: &Arc<AtomicUsize>,
    ) -> Result<(), String> {
        stream
            .set_write_timeout(Some(Duration::from_millis(250)))
            .map_err(|error| format!("failed to configure input service client: {error}"))?;
        let mut reader = prepare_connection(&mut stream, active, || {
            let reader = EvdevReader::open()?;
            if !reader.available() {
                return Err(reader
                    .status_error()
                    .unwrap_or_else(|| "no readable input devices".into()));
            }
            Ok(reader)
        })?;
        read_subscription(&mut stream, active, Instant::now() + Duration::from_secs(1))?;
        let Some(_subscription) = ConnectionSlot::acquire(subscribers, 1) else {
            return Err("an input service subscription is already active".into());
        };
        while active.load(Ordering::SeqCst) && !client_disconnected(&stream) {
            for event in reader.poll_events()? {
                if !active.load(Ordering::SeqCst) {
                    return Ok(());
                }
                write_message(&mut stream, &event)?;
            }
            if !reader.available() {
                return Err(reader
                    .status_error()
                    .unwrap_or_else(|| "no readable input devices remain".into()));
            }
        }
        Ok(())
    }

    fn read_subscription(
        stream: &mut UnixStream,
        active: &AtomicBool,
        deadline: Instant,
    ) -> Result<(), String> {
        let mut subscription = Vec::new();
        let mut buffer = [0_u8; 512];
        loop {
            if !active.load(Ordering::SeqCst) {
                return Err("the graphical login session became inactive".into());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("input service subscription timed out".into());
            }
            // A timeout on read_line alone resets for every partial read. Limit
            // the entire handshake and keep observing session cancellation.
            stream
                .set_read_timeout(Some(remaining.min(Duration::from_millis(100))))
                .map_err(|error| format!("failed to configure input service client: {error}"))?;
            let length = match stream.read(&mut buffer) {
                Ok(0) => return Err("input service client disconnected before subscribing".into()),
                Ok(length) => length,
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock
                            | io::ErrorKind::TimedOut
                            | io::ErrorKind::Interrupted
                    ) =>
                {
                    continue;
                }
                Err(error) => {
                    return Err(format!("input service client did not subscribe: {error}"));
                }
            };
            if subscription.len() + length > 4096 {
                return Err("input service subscription exceeds 4096 bytes".into());
            }
            subscription.extend_from_slice(&buffer[..length]);
            if subscription.contains(&b'\n') {
                if !active.load(Ordering::SeqCst) {
                    return Err("the graphical login session became inactive".into());
                }
                if Instant::now() >= deadline {
                    return Err("input service subscription timed out".into());
                }
                return match serde_json::from_slice(&subscription) {
                    Ok(ClientMessage::Subscribe) => Ok(()),
                    _ => Err("invalid input service subscription".into()),
                };
            }
        }
    }

    fn client_disconnected(stream: &UnixStream) -> bool {
        let mut byte = 0_u8;
        let result = unsafe {
            libc::recv(
                stream.as_raw_fd(),
                (&mut byte as *mut u8).cast(),
                1,
                libc::MSG_PEEK | libc::MSG_DONTWAIT,
            )
        };
        // No messages are valid after Subscribe. EOF also releases an idle slot.
        result >= 0
            || !matches!(
                io::Error::last_os_error().kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            )
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn ready_is_sent_only_after_a_reader_opens_in_an_active_session() {
            let (mut server, mut client) = UnixStream::pair().unwrap();
            let active = AtomicBool::new(true);
            client.set_nonblocking(true).unwrap();
            let mut buffer = [0; 128];
            let result =
                prepare_connection::<()>(&mut server, &active, || Err("permission denied".into()));
            assert!(result.is_err());
            assert_eq!(
                client.read(&mut buffer).unwrap_err().kind(),
                io::ErrorKind::WouldBlock
            );
            prepare_connection(&mut server, &active, || Ok(())).unwrap();
            let length = client.read(&mut buffer).unwrap();
            assert_eq!(&buffer[..length], b"{\"kind\":\"Ready\"}\n");
        }

        #[test]
        fn session_change_during_open_prevents_ready() {
            let (mut server, mut client) = UnixStream::pair().unwrap();
            let active = AtomicBool::new(true);
            client.set_nonblocking(true).unwrap();
            let result = prepare_connection(&mut server, &active, || {
                active.store(false, Ordering::SeqCst);
                Ok(())
            });
            assert!(result.is_err());
            assert_eq!(
                client.read(&mut [0; 128]).unwrap_err().kind(),
                io::ErrorKind::WouldBlock
            );
        }

        #[test]
        fn subscription_slot_is_bounded_and_released_on_drop() {
            let counter = Arc::new(AtomicUsize::new(0));
            let slot = ConnectionSlot::acquire(&counter, 1).unwrap();
            assert!(ConnectionSlot::acquire(&counter, 1).is_none());
            drop(slot);
            assert!(ConnectionSlot::acquire(&counter, 1).is_some());
        }

        #[test]
        fn disconnected_idle_clients_are_detected() {
            let (server, client) = UnixStream::pair().unwrap();
            assert!(!client_disconnected(&server));
            drop(client);
            assert!(client_disconnected(&server));
        }

        #[test]
        fn partial_subscription_reads_share_one_deadline() {
            let (mut server, mut client) = UnixStream::pair().unwrap();
            let writer = thread::spawn(move || {
                for byte in b"{\"kind\":\"Subscribe\"}\n" {
                    if client.write_all(&[*byte]).is_err() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
            });
            let result = read_subscription(
                &mut server,
                &AtomicBool::new(true),
                Instant::now() + Duration::from_millis(50),
            );
            drop(server);
            writer.join().unwrap();
            assert!(result.unwrap_err().contains("timed out"));
        }

        #[test]
        fn session_changes_cancel_incomplete_subscriptions() {
            let (mut server, mut client) = UnixStream::pair().unwrap();
            client.write_all(b"{").unwrap();
            let active = Arc::new(AtomicBool::new(true));
            let worker_active = Arc::clone(&active);
            let cancel = thread::spawn(move || {
                thread::sleep(Duration::from_millis(20));
                worker_active.store(false, Ordering::SeqCst);
            });
            let result = read_subscription(
                &mut server,
                &active,
                Instant::now() + Duration::from_secs(1),
            );
            cancel.join().unwrap();
            assert!(result.unwrap_err().contains("inactive"));
        }

        #[test]
        fn complete_subscription_is_accepted() {
            let (mut server, mut client) = UnixStream::pair().unwrap();
            client.write_all(b"{\"kind\":\"Subscribe\"}\n").unwrap();
            assert!(
                read_subscription(
                    &mut server,
                    &AtomicBool::new(true),
                    Instant::now() + Duration::from_secs(1),
                )
                .is_ok()
            );
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
