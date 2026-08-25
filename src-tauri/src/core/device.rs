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
#[cfg(target_os = "windows")]
static RAW_INPUT_AVAILABLE: AtomicBool = AtomicBool::new(true);
#[cfg(target_os = "windows")]
static RAW_INPUT_PARSE_FAILURES: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "windows")]
static RAW_INPUT_SENDER: std::sync::OnceLock<
    std::sync::Mutex<Option<mpsc::SyncSender<DeviceEvent>>>,
> = std::sync::OnceLock::new();
#[cfg(target_os = "windows")]
static CURSOR_VISIBLE: AtomicBool = AtomicBool::new(true);
#[cfg(target_os = "windows")]
static CURSOR_VISIBILITY_CHECKED_AT: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "windows")]
static CURSOR_VISIBILITY_FAILURES: AtomicU64 = AtomicU64::new(0);

#[command]
pub fn get_device_input_status() -> DeviceInputStatus {
    let backend = select_backend();
    let status = match backend {
        #[cfg(not(target_os = "windows"))]
        InputBackend::Rdev => DeviceInputStatus {
            backend: "rdev".into(),
            available: true,
            authorized: true,
            hover_supported: true,
            error: None,
        },
        #[cfg(target_os = "windows")]
        InputBackend::WindowsRawInput => {
            let available = RAW_INPUT_AVAILABLE.load(Ordering::SeqCst);
            DeviceInputStatus {
                backend: "windows-raw-input".into(),
                available,
                authorized: available,
                hover_supported: true,
                error: (!available)
                    .then(|| "Windows Raw Input registration is unavailable.".into()),
            }
        }
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
                #[cfg(not(target_os = "windows"))]
                InputBackend::Rdev => listen_rdev(event_sender),
                #[cfg(target_os = "windows")]
                InputBackend::WindowsRawInput => listen_windows(event_sender),
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
            #[cfg(not(target_os = "windows"))]
            EventType::MouseMove { x, y } => DeviceEvent {
                kind: DeviceEventKind::MouseMove,
                value: json!({ "x": x, "y": y }),
            },
            #[cfg(target_os = "windows")]
            EventType::MouseMove { x, y } if windows_cursor_visible() => DeviceEvent {
                kind: DeviceEventKind::MouseMove,
                value: json!({ "x": x, "y": y }),
            },
            #[cfg(target_os = "windows")]
            EventType::MouseMove { .. } => return,
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

#[cfg(target_os = "windows")]
fn listen_windows(event_sender: mpsc::SyncSender<DeviceEvent>) -> Result<(), String> {
    use std::sync::{Arc, atomic::AtomicU32};
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        PM_NOREMOVE, PeekMessageW, PostThreadMessageW, WM_QUIT,
    };

    let raw_sender = event_sender.clone();
    let raw_thread_id = Arc::new(AtomicU32::new(unsafe { GetCurrentThreadId() }));
    let mut raw_message = windows::Win32::UI::WindowsAndMessaging::MSG::default();
    unsafe {
        let _ = PeekMessageW(&mut raw_message, None, 0, 0, PM_NOREMOVE);
    }
    let rdev_raw_thread_id = Arc::clone(&raw_thread_id);
    let (rdev_ready_sender, rdev_ready_receiver) = mpsc::channel();
    let rdev_thread = thread::Builder::new()
        .name("windows-rdev-input".into())
        .spawn(move || {
            let thread_id = unsafe { GetCurrentThreadId() };
            let mut message = windows::Win32::UI::WindowsAndMessaging::MSG::default();
            unsafe {
                let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
            }
            let _ = rdev_ready_sender.send(thread_id);
            let result = listen_rdev(event_sender);
            for _ in 0..30 {
                let raw_thread_id = rdev_raw_thread_id.load(Ordering::SeqCst);
                if raw_thread_id != 0 {
                    unsafe {
                        let _ = PostThreadMessageW(raw_thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
                    }
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
            result
        })
        .map_err(|error| format!("Failed to spawn Windows rdev thread: {error}"))?;
    let rdev_thread_id = rdev_ready_receiver
        .recv_timeout(Duration::from_millis(300))
        .map_err(|_| "Windows rdev thread did not start within 300ms.".to_string())?;

    let sender_store = RAW_INPUT_SENDER.get_or_init(|| std::sync::Mutex::new(None));
    match sender_store.lock() {
        Ok(mut sender) => *sender = Some(raw_sender),
        Err(_) => {
            unsafe {
                let _ = PostThreadMessageW(rdev_thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
            let _ = rdev_thread.join();
            return Err("Windows Raw Input sender lock is poisoned.".into());
        }
    }
    let raw_result = listen_windows_raw_input();
    if let Ok(mut sender) = sender_store.lock() {
        *sender = None;
    }
    unsafe {
        let _ = PostThreadMessageW(rdev_thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
    }
    let rdev_result = rdev_thread
        .join()
        .map_err(|_| "Windows rdev thread panicked.".to_string())?;

    let result = raw_result.and(rdev_result);
    if result.is_err() {
        RAW_INPUT_AVAILABLE.store(false, Ordering::SeqCst);
    }
    result
}

#[cfg(target_os = "windows")]
fn listen_windows_raw_input() -> Result<(), String> {
    use std::mem::size_of;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::{
        RAWINPUTDEVICE, RIDEV_INPUTSINK, RIDEV_REMOVE, RegisterRawInputDevices,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, DispatchMessageW, GetMessageW, HWND_MESSAGE,
        RegisterClassW, UnregisterClassW, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        WS_OVERLAPPED,
    };
    use windows::core::PCWSTR;

    let class_name: Vec<u16> = "MochiPawRawInputWindow\0".encode_utf16().collect();
    let hmodule = unsafe { GetModuleHandleW(None) }
        .map_err(|error| format!("Failed to get Windows module handle: {error}"))?;
    let hinstance = hmodule.into();
    let class = WNDCLASSW {
        lpfnWndProc: Some(raw_input_window_proc),
        hInstance: hinstance,
        lpszClassName: PCWSTR(class_name.as_ptr()),
        ..unsafe { std::mem::zeroed() }
    };
    if unsafe { RegisterClassW(&class) } == 0 {
        RAW_INPUT_AVAILABLE.store(false, Ordering::SeqCst);
        let error = format!(
            "Windows Raw Input window class registration failed: {}",
            windows::core::Error::from_win32()
        );
        return Err(error);
    }

    let hwnd = match unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(hinstance),
            None,
        )
    } {
        Ok(hwnd) => hwnd,
        Err(error) => {
            RAW_INPUT_AVAILABLE.store(false, Ordering::SeqCst);
            unsafe {
                let _ = UnregisterClassW(PCWSTR(class_name.as_ptr()), Some(hinstance));
            }
            return Err(format!(
                "Failed to create Windows Raw Input window: {error}"
            ));
        }
    };

    let sender_store = RAW_INPUT_SENDER.get_or_init(|| std::sync::Mutex::new(None));
    let device = RAWINPUTDEVICE {
        usUsagePage: 0x01,
        usUsage: 0x02,
        dwFlags: RIDEV_INPUTSINK,
        hwndTarget: hwnd,
    };
    if let Err(error) =
        unsafe { RegisterRawInputDevices(&[device], size_of::<RAWINPUTDEVICE>() as u32) }
    {
        RAW_INPUT_AVAILABLE.store(false, Ordering::SeqCst);
        if let Ok(mut sender) = sender_store.lock() {
            *sender = None;
        }
        unsafe {
            let _ = DestroyWindow(hwnd);
            let _ = UnregisterClassW(PCWSTR(class_name.as_ptr()), Some(hinstance));
        }
        let message = format!("Windows Raw Input registration failed: {error}");
        return Err(message);
    }

    RAW_INPUT_AVAILABLE.store(true, Ordering::SeqCst);
    info!(target: "mochi_paw::device", "Windows Raw Input registered");

    let mut message = windows::Win32::UI::WindowsAndMessaging::MSG::default();
    let message_result = loop {
        let status = unsafe { GetMessageW(&mut message, None, 0, 0) };
        if status.0 == -1 {
            break Err(format!(
                "Windows Raw Input message loop failed: {}",
                windows::core::Error::from_win32()
            ));
        }
        if status.0 == 0 {
            break Ok(());
        }
        unsafe {
            DispatchMessageW(&message);
        }
    };

    let remove = RAWINPUTDEVICE {
        usUsagePage: 0x01,
        usUsage: 0x02,
        dwFlags: RIDEV_REMOVE,
        hwndTarget: HWND::default(),
    };
    if let Err(error) =
        unsafe { RegisterRawInputDevices(&[remove], size_of::<RAWINPUTDEVICE>() as u32) }
    {
        warn!(target: "mochi_paw::device", "Windows Raw Input unregister failed: {error}");
    } else {
        info!(target: "mochi_paw::device", "Windows Raw Input unregistered");
    }
    if let Ok(mut sender) = sender_store.lock() {
        *sender = None;
    }
    unsafe {
        let _ = DestroyWindow(hwnd);
        let _ = UnregisterClassW(PCWSTR(class_name.as_ptr()), Some(hinstance));
    }
    info!(target: "mochi_paw::device", "Windows Raw Input thread exited");
    if message_result.is_err() {
        RAW_INPUT_AVAILABLE.store(false, Ordering::SeqCst);
    }
    message_result
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn raw_input_window_proc(
    hwnd: windows::Win32::Foundation::HWND,
    message: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::Win32::UI::Input::{GetRawInputData, HRAWINPUT, RAWINPUTHEADER, RID_INPUT};
    use windows::Win32::UI::WindowsAndMessaging::{DefWindowProcW, WM_INPUT};

    if message == WM_INPUT {
        let handle = HRAWINPUT(lparam.0 as *mut c_void);
        let mut size = 0u32;
        let header_size = size_of::<RAWINPUTHEADER>() as u32;
        let status = unsafe { GetRawInputData(handle, RID_INPUT, None, &mut size, header_size) };
        if status == u32::MAX || size == 0 || size > 64 * 1024 {
            record_raw_input_parse_failure("invalid raw input size");
        } else {
            let mut buffer = vec![0u8; size as usize];
            let read = unsafe {
                GetRawInputData(
                    handle,
                    RID_INPUT,
                    Some(buffer.as_mut_ptr() as *mut c_void),
                    &mut size,
                    header_size,
                )
            };
            if read == u32::MAX || read == 0 || read as usize > buffer.len() {
                record_raw_input_parse_failure("raw input read failed");
            } else {
                match parse_raw_input_bytes(&buffer[..read as usize]) {
                    Ok(Some((dx, dy))) if !windows_cursor_visible() => {
                        if let Some(store) = RAW_INPUT_SENDER.get() {
                            if let Ok(sender) = store.lock() {
                                if let Some(sender) = sender.as_ref() {
                                    if sender.try_send(relative_mouse_event(dx, dy)).is_err() {
                                        let dropped =
                                            DROPPED_EVENTS.fetch_add(1, Ordering::Relaxed) + 1;
                                        if dropped == 1 || dropped % 100 == 0 {
                                            warn!(target: "mochi_paw::device", "Windows Raw Input queue full dropped_events={dropped}");
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(()) => record_raw_input_parse_failure("malformed or non-mouse raw input"),
                }
            }
        }
    }
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

#[cfg(target_os = "windows")]
fn record_raw_input_parse_failure(reason: &str) {
    let failures = RAW_INPUT_PARSE_FAILURES.fetch_add(1, Ordering::Relaxed) + 1;
    if failures == 1 || failures % 100 == 0 {
        warn!(target: "mochi_paw::device", "Windows Raw Input parse failure count={failures} reason={reason}");
    }
}

#[cfg(target_os = "windows")]
fn parse_raw_input_bytes(bytes: &[u8]) -> Result<Option<(i32, i32)>, ()> {
    use std::mem::{offset_of, size_of};
    use windows::Win32::UI::Input::{MOUSE_MOVE_ABSOLUTE, RAWINPUTHEADER, RAWMOUSE, RIM_TYPEMOUSE};

    let mouse_offset = size_of::<RAWINPUTHEADER>();
    let flags_offset = mouse_offset + offset_of!(RAWMOUSE, usFlags);
    let dx_offset = mouse_offset + offset_of!(RAWMOUSE, lLastX);
    let required = dx_offset + size_of::<i32>() * 2;
    if bytes.len() < required {
        return Err(());
    }
    let kind = u32::from_ne_bytes(bytes[0..4].try_into().map_err(|_| ())?);
    if kind != RIM_TYPEMOUSE.0 {
        return Err(());
    }
    let flags = u16::from_ne_bytes(
        bytes[flags_offset..flags_offset + 2]
            .try_into()
            .map_err(|_| ())?,
    );
    if flags & MOUSE_MOVE_ABSOLUTE.0 != 0 {
        return Ok(None);
    }
    let dx = i32::from_ne_bytes(bytes[dx_offset..dx_offset + 4].try_into().map_err(|_| ())?);
    let dy = i32::from_ne_bytes(
        bytes[dx_offset + 4..dx_offset + 8]
            .try_into()
            .map_err(|_| ())?,
    );
    Ok(Some((dx, dy)))
}

fn relative_mouse_event(dx: i32, dy: i32) -> DeviceEvent {
    DeviceEvent {
        kind: DeviceEventKind::MouseRelativeMove,
        value: json!({ "dx": dx, "dy": dy }),
    }
}

#[cfg(target_os = "windows")]
fn windows_cursor_visible() -> bool {
    use windows::Win32::System::SystemInformation::GetTickCount64;
    use windows::Win32::UI::WindowsAndMessaging::{CURSOR_SHOWING, CURSORINFO, GetCursorInfo};

    let now = unsafe { GetTickCount64() };
    let checked_at = CURSOR_VISIBILITY_CHECKED_AT.load(Ordering::Relaxed);
    if now.saturating_sub(checked_at) < 50 {
        return CURSOR_VISIBLE.load(Ordering::Relaxed);
    }

    let mut info = CURSORINFO {
        cbSize: std::mem::size_of::<CURSORINFO>() as u32,
        ..Default::default()
    };
    let visible = unsafe { GetCursorInfo(&mut info) }
        .map(|()| info.flags.0 & CURSOR_SHOWING.0 != 0)
        .unwrap_or_else(|error| {
            let failures = CURSOR_VISIBILITY_FAILURES.fetch_add(1, Ordering::Relaxed) + 1;
            if failures == 1 || failures % 100 == 0 {
                warn!(target: "mochi_paw::device", "Windows cursor visibility probe failed count={failures} error={error}");
            }
            CURSOR_VISIBLE.load(Ordering::Relaxed)
        });
    CURSOR_VISIBLE.store(visible, Ordering::Relaxed);
    CURSOR_VISIBILITY_CHECKED_AT.store(now, Ordering::Relaxed);
    visible
}

#[derive(Debug, Clone, Copy)]
enum InputBackend {
    #[cfg(not(target_os = "windows"))]
    Rdev,
    #[cfg(target_os = "windows")]
    WindowsRawInput,
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

    #[cfg(target_os = "windows")]
    {
        InputBackend::WindowsRawInput
    }
    #[cfg(not(target_os = "windows"))]
    {
        InputBackend::Rdev
    }
}

fn backend_name(backend: &InputBackend) -> &'static str {
    match backend {
        #[cfg(not(target_os = "windows"))]
        InputBackend::Rdev => "rdev",
        #[cfg(target_os = "windows")]
        InputBackend::WindowsRawInput => "windows-raw-input",
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

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    #[test]
    fn non_linux_uses_rdev() {
        assert!(matches!(select_backend(), InputBackend::Rdev));
    }

    #[test]
    fn relative_mouse_movement_is_normalized() {
        let event = relative_mouse_event(4, -2);
        assert_eq!(event.kind, DeviceEventKind::MouseRelativeMove);
        assert_eq!(event.value, json!({ "dx": 4, "dy": -2 }));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_uses_raw_input_backend() {
        assert!(matches!(select_backend(), InputBackend::WindowsRawInput));
        assert_eq!(backend_name(&select_backend()), "windows-raw-input");
        let status = get_device_input_status();
        assert_eq!(status.backend, "windows-raw-input");
        assert!(status.available);
        assert!(status.authorized);
        assert!(status.hover_supported);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn raw_mouse_bytes_preserve_signed_and_zero_movement() {
        use std::mem::{offset_of, size_of};
        use windows::Win32::UI::Input::{RAWINPUTHEADER, RAWMOUSE, RIM_TYPEMOUSE};

        let mouse_offset = size_of::<RAWINPUTHEADER>();
        let dx_offset = mouse_offset + offset_of!(RAWMOUSE, lLastX);
        let mut bytes = vec![0u8; dx_offset + size_of::<i32>() * 2];
        bytes[0..4].copy_from_slice(&RIM_TYPEMOUSE.0.to_ne_bytes());
        bytes[dx_offset..dx_offset + 4].copy_from_slice(&12i32.to_ne_bytes());
        bytes[dx_offset + 4..dx_offset + 8].copy_from_slice(&(-7i32).to_ne_bytes());
        assert_eq!(parse_raw_input_bytes(&bytes), Ok(Some((12, -7))));

        bytes[dx_offset..dx_offset + 8].fill(0);
        assert_eq!(parse_raw_input_bytes(&bytes), Ok(Some((0, 0))));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn incomplete_or_non_mouse_raw_input_is_rejected() {
        use std::mem::{offset_of, size_of};
        use windows::Win32::UI::Input::{RAWINPUTHEADER, RAWMOUSE, RIM_TYPEKEYBOARD};

        assert_eq!(parse_raw_input_bytes(&[]), Err(()));

        let dx_offset = size_of::<RAWINPUTHEADER>() + offset_of!(RAWMOUSE, lLastX);
        let mut bytes = vec![0u8; dx_offset + size_of::<i32>() * 2];
        bytes[0..4].copy_from_slice(&RIM_TYPEKEYBOARD.0.to_ne_bytes());
        assert_eq!(parse_raw_input_bytes(&bytes), Err(()));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn absolute_raw_mouse_coordinates_are_ignored() {
        use std::mem::{offset_of, size_of};
        use windows::Win32::UI::Input::{
            MOUSE_MOVE_ABSOLUTE, RAWINPUTHEADER, RAWMOUSE, RIM_TYPEMOUSE,
        };

        let mouse_offset = size_of::<RAWINPUTHEADER>();
        let flags_offset = mouse_offset + offset_of!(RAWMOUSE, usFlags);
        let dx_offset = mouse_offset + offset_of!(RAWMOUSE, lLastX);
        let mut bytes = vec![0u8; dx_offset + size_of::<i32>() * 2];
        bytes[0..4].copy_from_slice(&RIM_TYPEMOUSE.0.to_ne_bytes());
        bytes[flags_offset..flags_offset + 2].copy_from_slice(&MOUSE_MOVE_ABSOLUTE.0.to_ne_bytes());
        assert_eq!(parse_raw_input_bytes(&bytes), Ok(None));
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
