// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

//! Local, pre-Tauri startup diagnostics.
//!
//! The diagnostics writer intentionally has no dependency on Tauri's runtime
//! or logging plugin. It can therefore record failures that happen while the
//! webview or the plugin stack is being initialized.

use std::{
    backtrace::Backtrace,
    env,
    fs::{self, OpenOptions},
    io::Write,
    panic::PanicHookInfo,
    path::{Path, PathBuf},
    sync::{Once, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(not(target_os = "windows"))]
const LOG_DIRECTORY_NAME: &str = "logs";
#[cfg(not(target_os = "windows"))]
const FALLBACK_DIRECTORY_NAME: &str = "MochiPaw";
const STATE_FILE_NAME: &str = "startup-state.json";
const EVENTS_FILE_NAME: &str = "startup-events.jsonl";
// WebView2's Evergreen runtime is forward-compatible: this is a floor, not
// an exact version or an upper bound. Newer runtimes such as 151.x remain
// valid as long as they meet this minimum.
const MINIMUM_WEBVIEW2_VERSION: &str = "110.0.1531.0";

static DIAGNOSTICS: OnceLock<Diagnostics> = OnceLock::new();
static PANIC_HOOK: Once = Once::new();

/// Return the process-wide diagnostics writer and install the panic/Windows
/// exception hooks. This function is deliberately infallible: if neither
/// location is writable, the application still starts and the failure is
/// visible in the returned path and stderr when available.
pub fn initialize() -> &'static Diagnostics {
    let diagnostics = DIAGNOSTICS.get_or_init(Diagnostics::new);

    PANIC_HOOK.call_once(|| {
        let diagnostics = diagnostics;
        std::panic::set_hook(Box::new(move |info| diagnostics.record_panic(info)));
        install_windows_exception_filter();
    });

    diagnostics
}

/// Access the selected log directory after [`initialize`] has run.
pub fn log_dir() -> &'static Path {
    initialize().log_dir()
}

/// Mark a startup phase in `startup-state.json` and append it to the event log.
pub fn mark_phase(phase: &str) {
    initialize().mark_phase(phase);
}

/// Record an initialization failure and mark the process as failed.
pub fn record_error(phase: &str, error: &str) {
    initialize().record_error(phase, error);
}

/// Record the information available before Tauri creates its WebView2
/// instances. This runs before the plugin stack and is therefore also useful
/// for portable builds where the installer did not get a chance to install
/// the Evergreen runtime.
pub fn record_webview_preflight() {
    initialize().record_webview_preflight();
}

/// Return a user-facing reason when the host OS cannot run the WebView2
/// runtime required by the current Windows build. This check intentionally
/// does not inspect or modify application data.
pub fn startup_block_reason() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let (major, minor, build) = windows_kernel_version()?;
        // Windows Server 2016 and later also report major version 10. Do not
        // reject those supported systems based on the build number alone.
        if major < 10 {
            return Some(format!(
                "Windows {major}.{minor}.{build} is not supported by the WebView2 runtime."
            ));
        }
    }

    None
}

/// Display a native message for failures that happen before a Tauri window
/// exists. On other platforms the diagnostics files remain the source of
/// truth and this is a no-op.
pub fn show_startup_error(title: &str, message: &str) {
    #[cfg(target_os = "windows")]
    {
        use windows::{
            Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW},
            core::PCWSTR,
        };

        let title = wide_string(title);
        let message = wide_string(message);
        unsafe {
            let _ = MessageBoxW(
                None,
                PCWSTR(message.as_ptr()),
                PCWSTR(title.as_ptr()),
                MB_OK | MB_ICONERROR,
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    let _ = (title, message);
}

#[derive(Debug)]
pub struct Diagnostics {
    log_dir: PathBuf,
    state_path: PathBuf,
    events_path: PathBuf,
}

impl Diagnostics {
    fn new() -> Self {
        let log_dir = choose_log_dir();
        let diagnostics = Self::from_log_dir(log_dir);

        let previous_phase = read_previous_phase(&diagnostics.state_path);
        diagnostics.write_state("process-started", None, previous_phase.as_deref());
        diagnostics.append_event(
            "process-started",
            serde_json::json!({
                "pid": std::process::id(),
                "version": env!("CARGO_PKG_VERSION"),
                "target": option_env!("TARGET").unwrap_or("unknown"),
                "architecture": env::consts::ARCH,
                "os": env::consts::OS,
                "os_version": os_version(),
                "os_name": env::var("OS").unwrap_or_else(|_| env::consts::OS.to_string()),
                "executable": executable_path(),
                "install_directory": installation_directory(),
                "arguments": env::args_os().map(|value| value.to_string_lossy().into_owned()).collect::<Vec<_>>(),
                "log_directory": diagnostics.log_dir.to_string_lossy(),
                "previous_phase": previous_phase,
            }),
        );

        diagnostics
    }

    fn from_log_dir(log_dir: PathBuf) -> Self {
        let state_path = log_dir.join(STATE_FILE_NAME);
        let events_path = log_dir.join(EVENTS_FILE_NAME);
        Self {
            log_dir,
            state_path,
            events_path,
        }
    }

    /// Constructor used by unit tests to exercise state/event persistence in
    /// an isolated temporary directory.
    #[cfg(test)]
    fn for_test(log_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&log_dir);
        Self::from_log_dir(log_dir)
    }

    pub fn log_dir(&self) -> &Path {
        &self.log_dir
    }

    pub fn state_path(&self) -> &Path {
        &self.state_path
    }

    pub fn events_path(&self) -> &Path {
        &self.events_path
    }

    pub fn mark_phase(&self, phase: &str) {
        self.write_state(phase, None, None);
        self.append_event(phase, serde_json::json!({}));
    }

    /// Record the resolved application data directory used by Pinia and
    /// persistence. The path is local-only and helps diagnose first-launch
    /// failures without guessing which Tauri resolver was active.
    pub fn record_app_data_directory(&self, path: &Path) {
        self.write_state("app-data-dir-ready", None, None);
        self.append_event(
            "app-data-dir-ready",
            serde_json::json!({ "path": path.to_string_lossy() }),
        );
    }

    pub fn record_webview_preflight(&self) {
        self.write_state("webview-preflight", None, None);
        self.append_event("webview-preflight", webview_preflight_details());
    }

    pub fn record_error(&self, phase: &str, error: &str) {
        let error = truncate(error, 8 * 1024);
        self.write_state("startup-failed", Some((&phase, &error)), None);
        self.append_event(
            "startup-failed",
            serde_json::json!({ "phase": phase, "error": error }),
        );
    }

    fn record_panic(&self, info: &PanicHookInfo<'_>) {
        let payload = panic_payload(info);
        let location = info.location().map(|location| {
            serde_json::json!({
                "file": location.file(),
                "line": location.line(),
                "column": location.column(),
            })
        });

        self.write_state("startup-failed", Some((&"panic", &payload)), None);
        self.append_event(
            "panic",
            serde_json::json!({
                "error": payload,
                "location": location.clone(),
                "backtrace": Backtrace::force_capture().to_string(),
            }),
        );
        self.write_crash_report(
            "panic",
            serde_json::json!({
                "error": panic_payload(info),
                "location": location,
            }),
        );
    }

    #[cfg(target_os = "windows")]
    fn record_unhandled_exception(&self, code: u32, address: usize) {
        self.write_state(
            "startup-failed",
            Some((
                &"windows-exception".to_string(),
                &format!("exception code 0x{code:08x} at 0x{address:016x}"),
            )),
            None,
        );
        let details = serde_json::json!({
            "exception_code": format!("0x{code:08x}"),
            "exception_address": format!("0x{address:016x}"),
        });
        self.append_event("windows-exception", details.clone());
        self.write_crash_report("windows-exception", details);
    }

    fn write_state(&self, phase: &str, error: Option<(&str, &str)>, previous_phase: Option<&str>) {
        let mut state = serde_json::json!({
            "schema_version": 1,
            "phase": phase,
            "timestamp_ms": timestamp_ms(),
            "pid": std::process::id(),
            "version": env!("CARGO_PKG_VERSION"),
            "target": option_env!("TARGET").unwrap_or("unknown"),
            "architecture": env::consts::ARCH,
            "os": env::consts::OS,
            "os_version": os_version(),
            "executable": executable_path(),
            "install_directory": installation_directory(),
            "log_directory": self.log_dir.to_string_lossy(),
        });

        if let Some((error_phase, message)) = error {
            state["error_phase"] = serde_json::Value::String(error_phase.to_string());
            state["error"] = serde_json::Value::String(truncate(message, 8 * 1024));
        }
        if let Some(previous_phase) = previous_phase {
            state["previous_phase"] = serde_json::Value::String(previous_phase.to_string());
        }

        let Ok(mut bytes) = serde_json::to_vec_pretty(&state) else {
            return;
        };
        bytes.push(b'\n');

        // Rename a same-directory temporary file so readers never observe a
        // partially written JSON document. Windows cannot replace an existing
        // file with rename, so remove only this known state file first.
        let temporary_path = self
            .state_path
            .with_file_name(format!("{STATE_FILE_NAME}.tmp-{}", std::process::id()));
        if fs::write(&temporary_path, &bytes).is_ok() {
            #[cfg(target_os = "windows")]
            let _ = fs::remove_file(&self.state_path);
            if fs::rename(&temporary_path, &self.state_path).is_ok() {
                return;
            }
            let _ = fs::remove_file(&temporary_path);
        }

        // A final direct-write fallback is useful on filesystems where rename
        // is blocked by an antivirus scanner or a read-only overlay.
        let _ = fs::write(&self.state_path, bytes);
    }

    fn append_event(&self, event: &str, details: serde_json::Value) {
        let record = serde_json::json!({
            "event": event,
            "timestamp_ms": timestamp_ms(),
            "pid": std::process::id(),
            "details": details,
        });
        let Ok(mut line) = serde_json::to_vec(&record) else {
            return;
        };
        line.push(b'\n');

        let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.events_path)
        else {
            return;
        };
        let _ = file.write_all(&line);
        let _ = file.flush();
    }

    fn write_crash_report(&self, kind: &str, details: serde_json::Value) {
        let report = serde_json::json!({
            "schema_version": 1,
            "kind": kind,
            "timestamp_ms": timestamp_ms(),
            "pid": std::process::id(),
            "version": env!("CARGO_PKG_VERSION"),
            "target": option_env!("TARGET").unwrap_or("unknown"),
            "architecture": env::consts::ARCH,
            "os": env::consts::OS,
            "os_version": os_version(),
            "executable": executable_path(),
            "install_directory": installation_directory(),
            "details": details,
        });
        let Ok(bytes) = serde_json::to_vec_pretty(&report) else {
            return;
        };

        let path = self.log_dir.join(format!(
            "crash-{}-{}.json",
            timestamp_ms(),
            std::process::id()
        ));
        let _ = fs::write(path, bytes);
    }
}

fn executable_path() -> Option<String> {
    env::current_exe()
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

fn installation_directory() -> Option<String> {
    env::current_exe().ok().and_then(|path| {
        path.parent()
            .map(|parent| parent.to_string_lossy().into_owned())
    })
}

fn os_version() -> String {
    #[cfg(target_os = "windows")]
    {
        if let Some((major, minor, build)) = windows_kernel_version() {
            return format!("{major}.{minor}.{build}");
        }

        return "unknown".to_string();
    }

    #[cfg(not(target_os = "windows"))]
    {
        env::consts::OS.to_string()
    }
}

#[cfg(target_os = "windows")]
fn windows_kernel_version() -> Option<(u32, u32, u32)> {
    use windows::{
        Wdk::System::SystemServices::RtlGetVersion,
        Win32::System::SystemInformation::OSVERSIONINFOW,
    };

    // GetVersion is compatibility-shimmed unless the executable carries a
    // supportedOS manifest. RtlGetVersion reports the kernel version directly.
    let mut version = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    let status = unsafe { RtlGetVersion(&mut version) };
    (status.0 == 0).then_some((
        version.dwMajorVersion,
        version.dwMinorVersion,
        version.dwBuildNumber,
    ))
}

#[cfg(target_os = "windows")]
fn wide_string(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn webview_preflight_details() -> serde_json::Value {
    #[cfg(target_os = "windows")]
    {
        let candidates = webview_runtime_candidates();
        let existing = candidates
            .iter()
            .filter(|path| path.is_dir())
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let runtime_versions = webview_runtime_versions(&candidates);
        let compatible_runtime_versions = runtime_versions
            .iter()
            .filter(|version| webview_runtime_version_is_compatible(version))
            .cloned()
            .collect::<Vec<_>>();

        return serde_json::json!({
            "runtime_directories": existing,
            "runtime_versions": runtime_versions,
            "compatible_runtime_versions": compatible_runtime_versions,
            "highest_runtime_version": runtime_versions.last(),
            "runtime_compatible": !compatible_runtime_versions.is_empty(),
            "local_app_data": env::var_os("LOCALAPPDATA")
                .map(|path| PathBuf::from(path).to_string_lossy().into_owned()),
            "roaming_app_data": env::var_os("APPDATA")
                .map(|path| PathBuf::from(path).to_string_lossy().into_owned()),
            "minimum_version": MINIMUM_WEBVIEW2_VERSION,
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        serde_json::json!({ "runtime_directories": [], "runtime_versions": [], "minimum_version": null })
    }
}

#[cfg(target_os = "windows")]
fn webview_runtime_candidates() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(root) = env::var_os(variable) {
            roots.push(PathBuf::from(root).join(r"Microsoft\EdgeWebView\Application"));
        }
    }

    roots
}

#[cfg(target_os = "windows")]
fn webview_runtime_versions(candidates: &[PathBuf]) -> Vec<String> {
    let mut versions = candidates
        .iter()
        .filter_map(|root| fs::read_dir(root).ok())
        .flat_map(|entries| entries.filter_map(Result::ok))
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            parse_webview_runtime_version(&name).map(|_| name)
        })
        .collect::<Vec<_>>();
    versions.sort_by_key(|version| parse_webview_runtime_version(version));
    versions.dedup();
    versions
}

#[cfg(target_os = "windows")]
fn parse_webview_runtime_version(value: &str) -> Option<[u32; 4]> {
    let mut parts = value.split('.').map(str::parse::<u32>);
    let parsed = [parts.next()?, parts.next()?, parts.next()?, parts.next()?];

    if parts.next().is_some() || parsed.iter().any(Result::is_err) {
        return None;
    }

    Some([
        parsed[0].as_ref().ok().copied()?,
        parsed[1].as_ref().ok().copied()?,
        parsed[2].as_ref().ok().copied()?,
        parsed[3].as_ref().ok().copied()?,
    ])
}

#[cfg(target_os = "windows")]
fn webview_runtime_version_is_compatible(value: &str) -> bool {
    let Some(version) = parse_webview_runtime_version(value) else {
        return false;
    };

    let Some(minimum) = parse_webview_runtime_version(MINIMUM_WEBVIEW2_VERSION) else {
        return false;
    };

    version >= minimum
}

#[cfg(target_os = "windows")]
fn choose_log_dir() -> PathBuf {
    // main/run validate the local layout before diagnostics are initialized.
    // Do not silently write to a profile or temp directory if it is unavailable.
    crate::data_paths::windows_data_paths()
        .expect("Windows data directory must be validated before diagnostics")
        .logs()
}

#[cfg(not(target_os = "windows"))]
fn choose_log_dir() -> PathBuf {
    let exe_candidate = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join(LOG_DIRECTORY_NAME)));

    if let Some(path) = exe_candidate {
        if ensure_writable_directory(&path) {
            return path;
        }
    }

    let fallback = env::temp_dir()
        .join(FALLBACK_DIRECTORY_NAME)
        .join(LOG_DIRECTORY_NAME);
    let _ = ensure_writable_directory(&fallback);
    fallback
}

#[cfg(not(target_os = "windows"))]
fn ensure_writable_directory(path: &Path) -> bool {
    if fs::create_dir_all(path).is_err() {
        return false;
    }

    // `create_dir_all` also succeeds for an existing directory that the
    // current user cannot write. Probe a private file so installed builds in
    // protected locations correctly use the temp fallback.
    let probe = path.join(format!(".write-test-{}", std::process::id()));
    let writable = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe)
        .is_ok();
    if writable {
        let _ = fs::remove_file(probe);
    }
    writable
}

fn read_previous_phase(path: &Path) -> Option<String> {
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&contents)
        .ok()?
        .get("phase")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
}

fn panic_payload(info: &PanicHookInfo<'_>) -> String {
    if let Some(message) = info.payload().downcast_ref::<&str>() {
        return truncate(message, 8 * 1024);
    }
    if let Some(message) = info.payload().downcast_ref::<String>() {
        return truncate(message, 8 * 1024);
    }
    "panic payload was not a string".to_string()
}

fn truncate(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }

    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &value[..end])
}

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn install_windows_exception_filter() {
    use windows::Win32::System::Diagnostics::Debug::SetUnhandledExceptionFilter;

    // Keep the process' normal Windows crash handling by returning
    // EXCEPTION_CONTINUE_SEARCH from the callback after recording a summary.
    unsafe {
        let _ = SetUnhandledExceptionFilter(Some(windows_exception_filter));
    }
}

#[cfg(not(target_os = "windows"))]
fn install_windows_exception_filter() {}

#[cfg(target_os = "windows")]
unsafe extern "system" fn windows_exception_filter(
    exception_info: *const windows::Win32::System::Diagnostics::Debug::EXCEPTION_POINTERS,
) -> i32 {
    use windows::Win32::System::Diagnostics::Debug::EXCEPTION_CONTINUE_SEARCH;

    let (code, address) = if exception_info.is_null() {
        (0, 0)
    } else {
        // The OS owns these pointers for the duration of this callback. Null
        // checks keep malformed exception records from causing a second fault.
        let pointers = unsafe { &*exception_info };
        if pointers.ExceptionRecord.is_null() {
            (0, 0)
        } else {
            let record = unsafe { &*pointers.ExceptionRecord };
            (
                record.ExceptionCode.0 as u32,
                record.ExceptionAddress as usize,
            )
        }
    };

    if let Some(diagnostics) = DIAGNOSTICS.get() {
        diagnostics.record_unhandled_exception(code, address);
    }

    EXCEPTION_CONTINUE_SEARCH
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn test_directory(name: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "mochi-paw-diagnostics-{name}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn writes_initial_state_and_phase_events() {
        let directory = test_directory("state");
        let _ = fs::remove_dir_all(&directory);
        let diagnostics = Diagnostics::for_test(directory.clone());

        diagnostics.write_state("process-started", None, None);
        diagnostics.mark_phase("tauri-builder-started");
        diagnostics.record_app_data_directory(Path::new("C:\\MochiPaw\\data"));

        let state: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(diagnostics.state_path()).unwrap()).unwrap();
        assert_eq!(state["phase"], "app-data-dir-ready");
        assert_eq!(state["schema_version"], 1);

        let events = fs::read_to_string(diagnostics.events_path()).unwrap();
        assert!(events.contains("tauri-builder-started"));
        assert!(events.contains("MochiPaw\\\\data"));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn records_webview_preflight_details() {
        let directory = test_directory("webview-preflight");
        let _ = fs::remove_dir_all(&directory);
        let diagnostics = Diagnostics::for_test(directory.clone());

        diagnostics.record_webview_preflight();

        let state: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(diagnostics.state_path()).unwrap()).unwrap();
        assert_eq!(state["phase"], "webview-preflight");

        let events = fs::read_to_string(diagnostics.events_path()).unwrap();
        assert!(events.contains("webview-preflight"));
        assert!(events.contains("minimum_version"));
        assert!(events.contains("runtime_versions"));
        let _ = fs::remove_dir_all(directory);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn accepts_newer_evergreen_runtime_versions() {
        assert!(webview_runtime_version_is_compatible("151.0.4129.107"));
        assert!(webview_runtime_version_is_compatible("110.0.1531.0"));
        assert!(!webview_runtime_version_is_compatible("109.0.0.0"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn sorts_runtime_versions_numerically() {
        let versions = vec![
            "151.0.4129.107".to_owned(),
            "99.0.0.0".to_owned(),
            "110.0.1531.0".to_owned(),
        ];
        let mut sorted = versions;
        sorted.sort_by_key(|version| parse_webview_runtime_version(version));

        assert_eq!(
            sorted,
            vec![
                "99.0.0.0".to_owned(),
                "110.0.1531.0".to_owned(),
                "151.0.4129.107".to_owned(),
            ]
        );
    }

    #[test]
    fn preserves_previous_phase_when_reading_state() {
        let directory = test_directory("previous");
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let state_path = directory.join(STATE_FILE_NAME);
        fs::write(&state_path, r#"{"phase":"tauri-setup-started"}"#).unwrap();

        assert_eq!(
            read_previous_phase(&state_path).as_deref(),
            Some("tauri-setup-started")
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn truncates_long_and_multibyte_error_messages_on_character_boundary() {
        let value = "中".repeat(20);
        let truncated = truncate(&value, 7);
        assert!(truncated.ends_with("..."));
        assert!(truncated.is_char_boundary(truncated.len() - 3));
    }

    #[test]
    fn records_initialization_errors_as_failed_state() {
        let directory = test_directory("error");
        let _ = fs::remove_dir_all(&directory);
        let diagnostics = Diagnostics::for_test(directory.clone());
        diagnostics.record_error("tauri-build", "builder failed");

        let state: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(diagnostics.state_path()).unwrap()).unwrap();
        assert_eq!(state["phase"], "startup-failed");
        assert_eq!(state["error_phase"], "tauri-build");
        assert_eq!(state["error"], "builder failed");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn writes_a_crash_report_artifact() {
        let directory = test_directory("crash");
        let _ = fs::remove_dir_all(&directory);
        let diagnostics = Diagnostics::for_test(directory.clone());
        diagnostics.write_crash_report("test", serde_json::json!({ "message": "boom" }));

        let reports = fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("crash-"))
            .collect::<Vec<_>>();
        assert_eq!(reports.len(), 1);
        let report: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(reports[0].path()).unwrap()).unwrap();
        assert_eq!(report["kind"], "test");
        assert_eq!(report["details"]["message"], "boom");
        let _ = fs::remove_dir_all(directory);
    }
}
