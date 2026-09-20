// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

//! Shared, bounded evdev reader for the app and the Linux input service.
//! Session authorization belongs to the caller, which drops this reader on lock.

use evdev::{Device, EventType};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs, io,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const RESCAN_INTERVAL: Duration = Duration::from_secs(1);
const POLL_TIMEOUT_MS: i32 = 100;
const MAX_DEVICES: usize = 64;
const READ_BATCH_SIZE: usize = 64;
const MAX_EVENTS_PER_POLL: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value")]
pub enum InputEvent {
    KeyboardPress(String),
    KeyboardRelease(String),
    MousePress(String),
    MouseRelease(String),
    MouseRelativeMove { dx: i32, dy: i32 },
}

#[derive(Default)]
struct InputOwners(BTreeMap<u16, usize>);

impl InputOwners {
    fn press(&mut self, code: u16) {
        *self.0.entry(code).or_default() += 1;
    }

    // The wire format has no device identity: release only the last owner.
    fn release(&mut self, code: u16) -> bool {
        let Some(owners) = self.0.get_mut(&code) else {
            return false;
        };
        *owners -= 1;
        if *owners == 0 {
            self.0.remove(&code);
            true
        } else {
            false
        }
    }
}

#[derive(Default)]
struct PressedState {
    keys: BTreeSet<u16>,
    dropped: bool,
}

impl PressedState {
    fn event(
        &mut self,
        kind: u16,
        code: u16,
        value: i32,
        owners: &mut InputOwners,
    ) -> Option<InputEvent> {
        let event = normalize_event(EventType(kind), code, value)?;
        if kind == EventType::KEY.0 {
            if value == 0 {
                if !self.keys.remove(&code) || !owners.release(code) {
                    return None;
                }
            } else if self.keys.insert(code) {
                // Repeats still emit presses, but each device owns a key once.
                owners.press(code);
            }
        }
        Some(event)
    }

    fn release_all(&mut self, owners: &mut InputOwners, events: &mut VecDeque<InputEvent>) {
        for code in std::mem::take(&mut self.keys) {
            if owners.release(code) {
                events.push_back(normalize_event(EventType::KEY, code, 0).unwrap());
            }
        }
        self.dropped = false;
    }

    fn reconcile(
        &mut self,
        held: impl Iterator<Item = u16>,
        owners: &mut InputOwners,
        events: &mut VecDeque<InputEvent>,
    ) {
        let held = held
            .filter(|code| normalize_event(EventType::KEY, *code, 1).is_some())
            .collect::<BTreeSet<_>>();
        for code in self.keys.difference(&held) {
            if owners.release(*code) {
                events.push_back(normalize_event(EventType::KEY, *code, 0).unwrap());
            }
        }
        for code in held.difference(&self.keys) {
            owners.press(*code);
            events.push_back(normalize_event(EventType::KEY, *code, 1).unwrap());
        }
        self.keys = held;
        self.dropped = false;
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct DeviceIdentity {
    device: u64,
    inode: u64,
    special_device: u64,
}

impl DeviceIdentity {
    fn read(path: &Path) -> io::Result<Self> {
        let metadata = fs::metadata(path)?;
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            special_device: metadata.rdev(),
        })
    }
}

struct MonitoredDevice {
    device: Device,
    identity: DeviceIdentity,
    pressed: PressedState,
}

pub struct EvdevReader {
    devices: BTreeMap<PathBuf, MonitoredDevice>,
    owners: InputOwners,
    pending: VecDeque<InputEvent>,
    last_scan: Instant,
    last_error: Option<String>,
    next_device: usize,
}

impl EvdevReader {
    pub fn open() -> Result<Self, String> {
        let mut reader = Self {
            devices: BTreeMap::new(),
            owners: InputOwners::default(),
            pending: VecDeque::new(),
            last_scan: Instant::now(),
            last_error: None,
            next_device: 0,
        };
        reader.rescan();
        match reader.status_error() {
            Some(error) => Err(error),
            None => Ok(reader),
        }
    }

    pub fn available(&self) -> bool {
        !self.devices.is_empty()
    }

    pub fn status_error(&self) -> Option<String> {
        if self.available() {
            None
        } else {
            Some(self.last_error.clone().unwrap_or_else(no_devices_error))
        }
    }

    /// Wait at most 100 ms for input and return a bounded batch. An empty device
    /// set is recoverable: keep calling this method to discover reconnected input.
    pub fn poll_events(&mut self) -> Result<Vec<InputEvent>, String> {
        if self.last_scan.elapsed() >= RESCAN_INTERVAL {
            self.rescan();
        }
        if !self.pending.is_empty() {
            return Ok(self.take_pending());
        }

        let paths = self.devices.keys().cloned().collect::<Vec<_>>();
        let mut descriptors = paths
            .iter()
            .map(|path| libc::pollfd {
                fd: self.devices[path].device.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            })
            .collect::<Vec<_>>();
        // All descriptors belong to live Device handles, including when poll
        // receives an empty slice while waiting for a hotplug rescan.
        let ready = unsafe {
            libc::poll(
                descriptors.as_mut_ptr(),
                descriptors.len() as libc::nfds_t,
                POLL_TIMEOUT_MS,
            )
        };
        if ready < 0 {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::Interrupted {
                Ok(Vec::new())
            } else {
                Err(format!("failed to poll Linux input devices: {error}"))
            };
        }

        // Rotate the first device so a busy pointer cannot starve a keyboard.
        let start = self.next_device;
        for offset in 0..paths.len() {
            let index = (start + offset) % paths.len();
            self.next_device = (index + 1) % paths.len();
            let path = &paths[index];
            let flags = descriptors[index].revents;
            if flags & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                self.remove_device(path);
            } else if flags & libc::POLLIN != 0 {
                let device = self.devices.get_mut(path).unwrap();
                if let Err(error) = read_events(device, &mut self.owners, &mut self.pending) {
                    self.last_error = Some(format!(
                        "Linux input device {} disconnected or became unreadable: {error}. \
                         Reconnect the device or check input permissions; retrying automatically.",
                        path.display()
                    ));
                    self.remove_device(path);
                }
            }
            if self.pending.len() >= MAX_EVENTS_PER_POLL {
                break;
            }
        }
        Ok(self.take_pending())
    }

    fn take_pending(&mut self) -> Vec<InputEvent> {
        self.pending
            .drain(..self.pending.len().min(MAX_EVENTS_PER_POLL))
            .collect()
    }

    fn remove_device(&mut self, path: &Path) {
        if let Some(mut device) = self.devices.remove(path) {
            device
                .pressed
                .release_all(&mut self.owners, &mut self.pending);
        }
    }

    fn rescan(&mut self) {
        self.last_scan = Instant::now();
        let candidates = match input_paths() {
            Ok(paths) => paths,
            Err(error) => {
                self.last_error = Some(format!(
                    "failed to enumerate /dev/input: {error}. \
                     Check that keyboard/mouse devices are connected and /dev/input is accessible."
                ));
                for path in self.devices.keys().cloned().collect::<Vec<_>>() {
                    self.remove_device(&path);
                }
                return;
            }
        };
        let stale = stale_device_paths(
            self.devices
                .iter()
                .map(|(path, device)| (path, device.identity)),
            &candidates,
        );
        for path in stale {
            self.remove_device(&path);
        }
        self.last_error = None;

        for (path, identity) in candidates {
            if self.devices.len() >= MAX_DEVICES {
                break;
            }
            if self.devices.contains_key(&path) {
                continue;
            }
            match open_device(&path, identity) {
                Ok(Some(device)) => {
                    self.devices.insert(path, device);
                }
                Ok(None) => {}
                Err(error) => {
                    self.last_error = Some(if error.kind() == io::ErrorKind::PermissionDenied {
                        "Permission denied reading /dev/input/event*. Enable the MochiPaw \
                         input service or grant this user read access to keyboard/mouse input \
                         devices, then retry. Group membership changes require logging in again."
                            .into()
                    } else {
                        format!(
                            "failed to open Linux input device {}: {error}",
                            path.display()
                        )
                    });
                }
            }
        }
    }
}

fn no_devices_error() -> String {
    "No readable keyboard or mouse devices in /dev/input/event*. Connect an input device \
     and enable the MochiPaw input service or check this user's device read permissions."
        .into()
}

fn input_paths() -> io::Result<BTreeMap<PathBuf, DeviceIdentity>> {
    let mut paths = BTreeMap::new();
    for entry in fs::read_dir("/dev/input")? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.strip_prefix("event").is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
        }) {
            let path = entry.path();
            if let Ok(identity) = DeviceIdentity::read(&path) {
                paths.insert(path, identity);
            }
        }
    }
    Ok(paths)
}

fn open_device(path: &Path, identity: DeviceIdentity) -> io::Result<Option<MonitoredDevice>> {
    // Read-only ACLs are sufficient; never ask the kernel for write access.
    let device = Device::try_from(fs::File::open(path)?)?;
    let keys = device
        .supported_keys()
        .into_iter()
        .flat_map(|keys| keys.iter().map(|key| key.code()));
    let axes = device
        .supported_relative_axes()
        .into_iter()
        .flat_map(|axes| axes.iter().map(|axis| axis.0));
    if !relevant_device(keys, axes) {
        return Ok(None);
    }
    device.set_nonblocking(true)?;
    Ok(Some(MonitoredDevice {
        device,
        identity,
        pressed: PressedState::default(),
    }))
}

fn stale_device_paths<'a>(
    current: impl Iterator<Item = (&'a PathBuf, DeviceIdentity)>,
    discovered: &BTreeMap<PathBuf, DeviceIdentity>,
) -> Vec<PathBuf> {
    current
        .filter(|(path, identity)| discovered.get(*path) != Some(identity))
        .map(|(path, _)| path.clone())
        .collect()
}

fn relevant_device(
    mut keys: impl Iterator<Item = u16>,
    mut axes: impl Iterator<Item = u16>,
) -> bool {
    keys.any(|code| key_name(code).is_some() || button_name(code).is_some())
        || axes.any(|code| matches!(code, 0 | 1))
}

fn read_events(
    device: &mut MonitoredDevice,
    owners: &mut InputOwners,
    events: &mut VecDeque<InputEvent>,
) -> io::Result<()> {
    // Reading a fixed buffer avoids draining an unbounded stream or cutting an
    // evdev::fetch_events() iterator mid-frame (which can discard key releases).
    // input_event contains only integer fields; zero is a valid initial value.
    let mut buffer: [libc::input_event; READ_BATCH_SIZE] = unsafe { std::mem::zeroed() };
    let bytes = unsafe {
        libc::read(
            device.device.as_raw_fd(),
            buffer.as_mut_ptr().cast(),
            std::mem::size_of_val(&buffer),
        )
    };
    if bytes < 0 {
        let error = io::Error::last_os_error();
        return if matches!(
            error.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
        ) {
            Ok(())
        } else {
            Err(error)
        };
    }
    if bytes == 0 {
        return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
    }
    let event_size = std::mem::size_of::<libc::input_event>();
    if bytes as usize % event_size != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "incomplete Linux input event",
        ));
    }
    for event in &buffer[..bytes as usize / event_size] {
        if event.type_ == EventType::SYNCHRONIZATION.0 && event.code == 3 {
            device.pressed.dropped = true;
        } else if device.pressed.dropped {
            if event.type_ == EventType::SYNCHRONIZATION.0 && event.code == 0 {
                // Linux requires ignoring the partial frame after SYN_DROPPED
                // and querying the current state at the next SYN_REPORT.
                let held = device.device.get_key_state()?;
                device
                    .pressed
                    .reconcile(held.iter().map(|key| key.code()), owners, events);
            }
        } else if let Some(event) =
            device
                .pressed
                .event(event.type_, event.code, event.value, owners)
        {
            events.push_back(event);
        }
    }
    Ok(())
}

fn normalize_event(kind: EventType, code: u16, value: i32) -> Option<InputEvent> {
    match kind {
        EventType::KEY => {
            if let Some(button) = button_name(code) {
                return match value {
                    1 => Some(InputEvent::MousePress(button.into())),
                    0 => Some(InputEvent::MouseRelease(button.into())),
                    _ => None,
                };
            }
            let key = key_name(code)?;
            match value {
                1 | 2 => Some(InputEvent::KeyboardPress(key.into())),
                0 => Some(InputEvent::KeyboardRelease(key.into())),
                _ => None,
            }
        }
        EventType::RELATIVE if code == 0 && value != 0 => {
            Some(InputEvent::MouseRelativeMove { dx: value, dy: 0 })
        }
        EventType::RELATIVE if code == 1 && value != 0 => {
            Some(InputEvent::MouseRelativeMove { dx: 0, dy: value })
        }
        _ => None,
    }
}

fn button_name(code: u16) -> Option<&'static str> {
    match code {
        272 => Some("Left"),
        273 => Some("Right"),
        274 => Some("Middle"),
        // rdev's Linux/X11 backend exposes back/forward as Unknown(8/9).
        275 => Some("Unknown(8)"),
        276 => Some("Unknown(9)"),
        277 => Some("Unknown(10)"),
        278 => Some("Unknown(11)"),
        279 => Some("Unknown(12)"),
        _ => None,
    }
}

// Physical evdev codes; names match rdev's Debug representation used by models.
fn key_name(code: u16) -> Option<&'static str> {
    match code {
        1 => Some("Escape"),
        2..=11 => Some(
            [
                "Num1", "Num2", "Num3", "Num4", "Num5", "Num6", "Num7", "Num8", "Num9", "Num0",
            ][(code - 2) as usize],
        ),
        12 => Some("Minus"),
        13 => Some("Equal"),
        14 => Some("Backspace"),
        15 => Some("Tab"),
        16..=25 => Some(
            [
                "KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP",
            ][(code - 16) as usize],
        ),
        26 => Some("LeftBracket"),
        27 => Some("RightBracket"),
        28 => Some("Return"),
        29 => Some("ControlLeft"),
        30..=38 => Some(
            [
                "KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL",
            ][(code - 30) as usize],
        ),
        39 => Some("SemiColon"),
        40 => Some("Quote"),
        41 => Some("BackQuote"),
        42 => Some("ShiftLeft"),
        43 => Some("BackSlash"),
        44..=50 => {
            Some(["KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM"][(code - 44) as usize])
        }
        51 => Some("Comma"),
        52 => Some("Dot"),
        53 => Some("Slash"),
        54 => Some("ShiftRight"),
        55 => Some("KpMultiply"),
        56 => Some("Alt"),
        57 => Some("Space"),
        58 => Some("CapsLock"),
        59..=68 => Some(
            ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10"][(code - 59) as usize],
        ),
        69 => Some("NumLock"),
        70 => Some("ScrollLock"),
        71 => Some("Kp7"),
        72 => Some("Kp8"),
        73 => Some("Kp9"),
        74 => Some("KpMinus"),
        75 => Some("Kp4"),
        76 => Some("Kp5"),
        77 => Some("Kp6"),
        78 => Some("KpPlus"),
        79 => Some("Kp1"),
        80 => Some("Kp2"),
        81 => Some("Kp3"),
        82 => Some("Kp0"),
        83 => Some("KpDecimal"),
        85 => Some("Lang5"),
        86 => Some("IntlBackslash"),
        87 => Some("F11"),
        88 => Some("F12"),
        89 => Some("IntlRo"),
        90 => Some("Lang3"),
        91 => Some("Lang4"),
        92 => Some("Lang2"),
        93 => Some("KanaMode"),
        94 => Some("Lang1"),
        96 => Some("KpReturn"),
        97 => Some("ControlRight"),
        98 => Some("KpDivide"),
        99 => Some("PrintScreen"),
        100 => Some("AltGr"),
        102 => Some("Home"),
        103 => Some("UpArrow"),
        104 => Some("PageUp"),
        105 => Some("LeftArrow"),
        106 => Some("RightArrow"),
        107 => Some("End"),
        108 => Some("DownArrow"),
        109 => Some("PageDown"),
        110 => Some("Insert"),
        111 => Some("Delete"),
        113 => Some("VolumeMute"),
        114 => Some("VolumeDown"),
        115 => Some("VolumeUp"),
        117 => Some("KpEqual"),
        119 => Some("Pause"),
        121 => Some("KpComma"),
        124 => Some("IntlYen"),
        125 => Some("MetaLeft"),
        126 => Some("MetaRight"),
        127 => Some("Apps"),
        183..=194 => Some(
            [
                "F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
            ][(code - 183) as usize],
        ),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_punctuation_keypad_and_navigation_to_rdev_names() {
        for (code, name) in [
            (12, "Minus"),
            (26, "LeftBracket"),
            (39, "SemiColon"),
            (43, "BackSlash"),
            (52, "Dot"),
            (55, "KpMultiply"),
            (71, "Kp7"),
            (78, "KpPlus"),
            (82, "Kp0"),
            (83, "KpDecimal"),
            (86, "IntlBackslash"),
            (96, "KpReturn"),
            (98, "KpDivide"),
            (110, "Insert"),
            (117, "KpEqual"),
            (121, "KpComma"),
            (194, "F24"),
        ] {
            assert_eq!(key_name(code), Some(name));
        }
        assert_eq!(key_name(304), None);
    }

    #[test]
    fn key_repeat_is_a_press_but_button_repeat_is_ignored() {
        assert_eq!(
            normalize_event(EventType::KEY, 30, 2),
            Some(InputEvent::KeyboardPress("KeyA".into()))
        );
        assert_eq!(normalize_event(EventType::KEY, 30, 3), None);
        assert_eq!(normalize_event(EventType::KEY, 272, 2), None);
    }

    #[test]
    fn maps_relative_motion_and_mouse_buttons_without_wheel_noise() {
        assert_eq!(
            normalize_event(EventType::RELATIVE, 0, -4),
            Some(InputEvent::MouseRelativeMove { dx: -4, dy: 0 })
        );
        assert_eq!(
            normalize_event(EventType::RELATIVE, 1, 6),
            Some(InputEvent::MouseRelativeMove { dx: 0, dy: 6 })
        );
        assert_eq!(normalize_event(EventType::RELATIVE, 0, 0), None);
        assert_eq!(normalize_event(EventType::RELATIVE, 8, 1), None);
        assert_eq!(
            normalize_event(EventType::KEY, 274, 1),
            Some(InputEvent::MousePress("Middle".into()))
        );
        assert_eq!(
            normalize_event(EventType::KEY, 275, 0),
            Some(InputEvent::MouseRelease("Unknown(8)".into()))
        );
        assert_eq!(
            normalize_event(EventType::KEY, 276, 1),
            Some(InputEvent::MousePress("Unknown(9)".into()))
        );
    }

    #[test]
    fn selects_keyboard_mouse_and_motion_devices_but_not_gamepad_or_switch() {
        assert!(relevant_device([30, 28].into_iter(), [].into_iter()));
        assert!(relevant_device([272].into_iter(), [].into_iter()));
        assert!(relevant_device([].into_iter(), [0, 1].into_iter()));
        assert!(!relevant_device(
            [304, 305, 310].into_iter(),
            [].into_iter()
        ));
        assert!(!relevant_device([116].into_iter(), [].into_iter()));
        assert!(!relevant_device([].into_iter(), [8].into_iter()));
    }

    #[test]
    fn unplug_releases_each_held_input_once_and_reconnect_starts_clean() {
        let mut state = PressedState::default();
        let mut owners = InputOwners::default();
        state.event(EventType::KEY.0, 30, 1, &mut owners);
        state.event(EventType::KEY.0, 30, 2, &mut owners);
        state.event(EventType::KEY.0, 272, 1, &mut owners);
        state.event(EventType::KEY.0, 31, 1, &mut owners);
        state.event(EventType::KEY.0, 31, 0, &mut owners);
        let mut events = VecDeque::new();
        state.release_all(&mut owners, &mut events);
        assert_eq!(
            events.into_iter().collect::<Vec<_>>(),
            vec![
                InputEvent::KeyboardRelease("KeyA".into()),
                InputEvent::MouseRelease("Left".into()),
            ]
        );
        let mut events = VecDeque::new();
        state.release_all(&mut owners, &mut events);
        assert!(events.is_empty());
        assert_eq!(
            state.event(EventType::KEY.0, 30, 1, &mut owners),
            Some(InputEvent::KeyboardPress("KeyA".into()))
        );
    }

    #[test]
    fn shared_keys_and_buttons_release_only_after_the_last_device() {
        for code in [30, 272] {
            let mut first = PressedState::default();
            let mut second = PressedState::default();
            let mut owners = InputOwners::default();
            let press = normalize_event(EventType::KEY, code, 1);
            let release = normalize_event(EventType::KEY, code, 0);
            assert_eq!(first.event(EventType::KEY.0, code, 1, &mut owners), press);
            assert_eq!(second.event(EventType::KEY.0, code, 1, &mut owners), press);
            if code == 30 {
                for _ in 0..3 {
                    assert_eq!(first.event(EventType::KEY.0, code, 2, &mut owners), press);
                }
            }
            assert_eq!(second.event(EventType::KEY.0, code, 0, &mut owners), None);
            // Duplicate or unobserved releases cannot release another device's key.
            assert_eq!(second.event(EventType::KEY.0, code, 0, &mut owners), None);
            assert_eq!(first.event(EventType::KEY.0, code, 0, &mut owners), release);
            assert_eq!(first.event(EventType::KEY.0, code, 0, &mut owners), None);
        }
    }

    #[test]
    fn unplugging_one_device_preserves_inputs_held_by_another() {
        let mut first = PressedState::default();
        let mut second = PressedState::default();
        let mut owners = InputOwners::default();
        for code in [30, 272] {
            first.event(EventType::KEY.0, code, 1, &mut owners);
            second.event(EventType::KEY.0, code, 1, &mut owners);
        }
        let mut events = VecDeque::new();
        first.release_all(&mut owners, &mut events);
        assert!(events.is_empty());
        assert_eq!(
            second.event(EventType::KEY.0, 30, 0, &mut owners),
            Some(InputEvent::KeyboardRelease("KeyA".into()))
        );
        second.release_all(&mut owners, &mut events);
        assert_eq!(
            events.into_iter().collect::<Vec<_>>(),
            vec![InputEvent::MouseRelease("Left".into())]
        );
        // A new connection owns only its own subsequent presses.
        let mut reconnected = PressedState::default();
        assert_eq!(
            reconnected.event(EventType::KEY.0, 30, 1, &mut owners),
            Some(InputEvent::KeyboardPress("KeyA".into()))
        );
        assert_eq!(
            reconnected.event(EventType::KEY.0, 30, 0, &mut owners),
            Some(InputEvent::KeyboardRelease("KeyA".into()))
        );
    }

    #[test]
    fn dropped_frame_reconciliation_preserves_other_device_ownership() {
        let mut first = PressedState::default();
        let mut second = PressedState::default();
        let mut owners = InputOwners::default();
        first.event(EventType::KEY.0, 30, 1, &mut owners);
        second.event(EventType::KEY.0, 30, 1, &mut owners);
        let mut events = VecDeque::new();
        first.reconcile([].into_iter(), &mut owners, &mut events);
        assert!(events.is_empty());
        // Resync can discover a press lost during overflow, but not own it twice.
        first.reconcile([30].into_iter(), &mut owners, &mut events);
        first.reconcile([30].into_iter(), &mut owners, &mut events);
        assert_eq!(
            events.pop_front(),
            Some(InputEvent::KeyboardPress("KeyA".into()))
        );
        assert!(events.is_empty());
        second.reconcile([].into_iter(), &mut owners, &mut events);
        assert!(events.is_empty());
        first.reconcile([].into_iter(), &mut owners, &mut events);
        assert_eq!(
            events.into_iter().collect::<Vec<_>>(),
            vec![InputEvent::KeyboardRelease("KeyA".into())]
        );
    }

    #[test]
    fn dropped_frame_recovers_releases_and_new_presses() {
        let mut state = PressedState::default();
        let mut owners = InputOwners::default();
        state.event(EventType::KEY.0, 30, 1, &mut owners);
        state.event(EventType::KEY.0, 272, 1, &mut owners);
        state.dropped = true;
        let mut events = VecDeque::new();
        state.reconcile([31, 272, 304].into_iter(), &mut owners, &mut events);
        assert!(!state.dropped);
        assert_eq!(
            events.into_iter().collect::<Vec<_>>(),
            vec![
                InputEvent::KeyboardRelease("KeyA".into()),
                InputEvent::KeyboardPress("KeyS".into()),
            ]
        );
        assert_eq!(state.keys, [31, 272].into_iter().collect());
    }

    #[test]
    fn pending_release_batches_are_bounded_and_preserve_order() {
        let expected = (0..600)
            .map(|i| InputEvent::KeyboardRelease(i.to_string()))
            .collect::<Vec<_>>();
        let mut reader = EvdevReader {
            devices: BTreeMap::new(),
            owners: InputOwners::default(),
            pending: expected.clone().into(),
            last_scan: Instant::now(),
            last_error: None,
            next_device: 0,
        };
        assert!(!reader.available());
        assert!(reader.status_error().unwrap().contains("/dev/input"));
        let mut actual = Vec::new();
        while !reader.pending.is_empty() {
            let batch = reader.poll_events().unwrap();
            assert!(batch.len() <= MAX_EVENTS_PER_POLL);
            actual.extend(batch);
        }
        assert_eq!(actual, expected);
    }

    #[test]
    fn rescan_removes_unplugged_devices_and_reused_paths_but_keeps_live_devices() {
        let original = DeviceIdentity {
            device: 1,
            inode: 2,
            special_device: 3,
        };
        let replacement = DeviceIdentity {
            inode: 4,
            ..original
        };
        let current = BTreeMap::from([
            (PathBuf::from("event0"), original),
            (PathBuf::from("event1"), original),
            (PathBuf::from("event2"), original),
        ]);
        let discovered = BTreeMap::from([
            (PathBuf::from("event1"), replacement),
            (PathBuf::from("event2"), original),
            (PathBuf::from("event3"), replacement),
        ]);
        assert_eq!(
            stale_device_paths(current.iter().map(|(path, id)| (path, *id)), &discovered),
            vec![PathBuf::from("event0"), PathBuf::from("event1")]
        );
    }

    #[test]
    fn events_keep_the_service_wire_format() {
        let event = InputEvent::MouseRelativeMove { dx: -3, dy: 9 };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"kind": "MouseRelativeMove", "value": {"dx": -3, "dy": 9}})
        );
        assert_eq!(serde_json::from_value::<InputEvent>(json).unwrap(), event);
    }
}
