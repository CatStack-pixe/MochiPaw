// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use tauri::{AppHandle, Runtime, command};

#[cfg(any(target_os = "windows", test))]
mod process_group;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMetrics {
    pid: u32,
    cpu_usage: Option<f64>,
    memory_bytes: Option<u64>,
    virtual_memory_bytes: Option<u64>,
    thread_count: Option<u32>,
    uptime_seconds: Option<u64>,
    group_working_set_bytes: Option<u64>,
    group_private_bytes: Option<u64>,
    group_process_count: Option<u32>,
}

#[command]
pub fn is_running_as_administrator() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        use std::mem::size_of;
        use windows::Win32::{
            Foundation::{CloseHandle, HANDLE},
            Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation},
            System::Threading::{GetCurrentProcess, OpenProcessToken},
        };

        unsafe {
            let mut token = HANDLE::default();

            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
                .map_err(|error| error.to_string())?;

            let mut elevation = TOKEN_ELEVATION::default();
            let mut returned_size = 0;
            let result = GetTokenInformation(
                token,
                TokenElevation,
                Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned_size,
            );

            let _ = CloseHandle(token);

            result.map_err(|error| error.to_string())?;

            return Ok(elevation.TokenIsElevated != 0);
        }
    }

    #[cfg(not(target_os = "windows"))]
    Ok(true)
}

#[command]
pub async fn relaunch_as_administrator<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::sync::atomic::AtomicBool;

        static RELAUNCH_PENDING: AtomicBool = AtomicBool::new(false);

        if is_running_as_administrator()? {
            return Ok(());
        }

        let mut request = RelaunchRequest::begin(&RELAUNCH_PENDING)?;
        run_elevation_worker(schedule_windows_administrator_relaunch).await?;

        // Only exit after UAC approval and helper creation. The helper waits for
        // this process to release its windows and plugins before opening the app.
        request.scheduled = true;
        app.exit(0);

        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
struct RelaunchRequest<'a> {
    pending: &'a std::sync::atomic::AtomicBool,
    scheduled: bool,
}

#[cfg(target_os = "windows")]
impl<'a> RelaunchRequest<'a> {
    fn begin(pending: &'a std::sync::atomic::AtomicBool) -> Result<Self, String> {
        use std::sync::atomic::Ordering;

        pending
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "administrator relaunch is already in progress".to_string())?;

        Ok(Self {
            pending,
            scheduled: false,
        })
    }
}

#[cfg(target_os = "windows")]
impl Drop for RelaunchRequest<'_> {
    fn drop(&mut self) {
        if !self.scheduled {
            self.pending
                .store(false, std::sync::atomic::Ordering::Release);
        }
    }
}

#[cfg(target_os = "windows")]
async fn run_elevation_worker(
    action: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);

    // Shell elevation can wait for UAC or shell extensions. Keep both the UI
    // event loop and async executor available while it runs. A fresh thread
    // also guarantees that no other task has initialized it as an MTA.
    std::thread::Builder::new()
        .name("administrator-relaunch".to_string())
        .spawn(move || {
            let _ = sender.blocking_send(action());
        })
        .map_err(|error| format!("starting administrator relaunch worker failed: {error}"))?;

    receiver
        .recv()
        .await
        .ok_or_else(|| "administrator relaunch worker stopped unexpectedly".to_string())?
}

#[command]
pub async fn get_process_metrics() -> Result<ProcessMetrics, String> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(windows_process_metrics)
            .await
            .map_err(|error| error.to_string())?
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(ProcessMetrics {
            pid: std::process::id(),
            cpu_usage: None,
            memory_bytes: None,
            virtual_memory_bytes: None,
            thread_count: None,
            uptime_seconds: None,
            group_working_set_bytes: None,
            group_private_bytes: None,
            group_process_count: None,
        })
    }
}

#[command]
pub fn compact_process_memory() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::{
            ProcessStatus::EmptyWorkingSet, Threading::GetCurrentProcess,
        };

        unsafe {
            EmptyWorkingSet(GetCurrentProcess()).map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn schedule_windows_administrator_relaunch() -> Result<(), String> {
    use std::ffi::OsString;
    use windows::{
        Win32::{
            System::Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx},
            UI::{
                Shell::{
                    SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW, ShellExecuteExW,
                },
                WindowsAndMessaging::SW_HIDE,
            },
        },
        core::PCWSTR,
    };

    const ADMIN_RELAUNCH_HELPER_ARG: &str = "--mochi-paw-admin-relaunch-helper";

    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }
        .ok()
        .map_err(|error| {
            format!("initializing administrator relaunch COM apartment failed: {error}")
        })?;
    let _com = ComApartment;

    let current_process_id = std::process::id();
    let exe_path = std::env::current_exe().map_err(|error| error.to_string())?;
    let working_directory = exe_path
        .parent()
        .ok_or_else(|| "current executable has no parent directory".to_string())?;
    let parameters = [
        OsString::from(ADMIN_RELAUNCH_HELPER_ARG),
        OsString::from(current_process_id.to_string()),
        OsString::from("--"),
    ]
    .into_iter()
    .chain(std::env::args_os().skip(1))
    .map(|argument| quote_windows_argument(&argument))
    .collect::<Vec<_>>();
    let operation = to_wide_str("runas");
    let file = to_wide_os_str(exe_path.as_os_str());
    let parameters = join_windows_arguments(&parameters);
    let directory = to_wide_os_str(working_directory.as_os_str());
    let mut execute_info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        // This short-lived worker has no message loop. Finish shell launch
        // before returning; security prompts remain enabled by FLAG_NO_UI.
        fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpVerb: PCWSTR(operation.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(parameters.as_ptr()),
        lpDirectory: PCWSTR(directory.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };

    unsafe { ShellExecuteExW(&mut execute_info) }.map_err(elevation_error_message)
}

#[cfg(target_os = "windows")]
struct ComApartment;

#[cfg(target_os = "windows")]
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { windows::Win32::System::Com::CoUninitialize() };
    }
}

#[cfg(target_os = "windows")]
fn elevation_error_message(error: windows::core::Error) -> String {
    use windows::{Win32::Foundation::ERROR_CANCELLED, core::HRESULT};

    if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
        return "administrator relaunch was cancelled".to_string();
    }

    format!("ShellExecuteExW runas failed: {error}")
}

#[cfg(target_os = "windows")]
fn quote_windows_argument(argument: &std::ffi::OsStr) -> std::ffi::OsString {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    let argument = argument.encode_wide().collect::<Vec<_>>();

    if argument.is_empty() {
        return std::ffi::OsString::from("\"\"");
    }

    let needs_quotes = argument
        .iter()
        .any(|character| matches!(character, 9..=13 | 32 | 34));

    if !needs_quotes {
        return std::ffi::OsString::from_wide(&argument);
    }

    let mut quoted = vec![u16::from(b'"')];
    let mut backslashes = 0;

    for character in argument {
        match character {
            value if value == u16::from(b'\\') => backslashes += 1,
            value if value == u16::from(b'"') => {
                quoted.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes * 2 + 1));
                quoted.push(value);
                backslashes = 0;
            }
            _ => {
                quoted.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes));
                backslashes = 0;
                quoted.push(character);
            }
        }
    }

    quoted.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes * 2));
    quoted.push(u16::from(b'"'));
    std::ffi::OsString::from_wide(&quoted)
}

#[cfg(target_os = "windows")]
fn join_windows_arguments(arguments: &[std::ffi::OsString]) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    let mut joined = Vec::new();

    for (index, argument) in arguments.iter().enumerate() {
        if index > 0 {
            joined.push(u16::from(b' '));
        }
        joined.extend(argument.encode_wide());
    }

    joined.push(0);
    joined
}

#[cfg(target_os = "windows")]
fn to_wide_str(value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(target_os = "windows")]
fn to_wide_os_str(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn windows_process_metrics() -> Result<ProcessMetrics, String> {
    use windows::Win32::{
        Foundation::{FILETIME, GetLastError},
        System::{
            SystemInformation::GetSystemInfo,
            Threading::{GetCurrentProcess, GetCurrentProcessId, GetProcessTimes},
        },
    };

    let process = unsafe { GetCurrentProcess() };
    let memory_counters = process_group::read_memory_counters(process)?;

    let mut creation_time = FILETIME::default();
    let mut exit_time = FILETIME::default();
    let mut kernel_time = FILETIME::default();
    let mut user_time = FILETIME::default();

    unsafe {
        GetProcessTimes(
            process,
            &mut creation_time,
            &mut exit_time,
            &mut kernel_time,
            &mut user_time,
        )
        .map_err(|error| error.to_string())?;
    }

    let mut system_info = unsafe { std::mem::zeroed() };
    unsafe {
        GetSystemInfo(&mut system_info);
    }

    let uptime_seconds = process_uptime_seconds(filetime_to_u64(creation_time))?;
    let pid = unsafe { GetCurrentProcessId() };
    // A process can exit during sampling. Keep the main-process metrics useful,
    // but never display a partial WebView group as a complete measurement.
    let group = process_group::windows_webview_group(
        pid,
        process_group::ProcessSample {
            creation_time: filetime_to_u64(creation_time),
            working_set_bytes: memory_counters.WorkingSetSize as u64,
            private_bytes: memory_counters.PrivateUsage as u64,
        },
    )
    .ok();

    Ok(ProcessMetrics {
        pid,
        cpu_usage: process_cpu_usage(
            filetime_to_u64(kernel_time) + filetime_to_u64(user_time),
            system_info.dwNumberOfProcessors.max(1),
        ),
        memory_bytes: Some(memory_counters.WorkingSetSize as u64),
        // Preserve the IPC field name; this has always represented private
        // commit, not the size of the process's virtual address space.
        virtual_memory_bytes: Some(memory_counters.PrivateUsage as u64),
        thread_count: Some(current_process_thread_count().map_err(|_| unsafe {
            format!(
                "GetCurrentProcess thread snapshot failed: {:?}",
                GetLastError()
            )
        })?),
        uptime_seconds: Some(uptime_seconds),
        group_working_set_bytes: group.as_ref().map(|value| value.working_set_bytes),
        group_private_bytes: group.as_ref().map(|value| value.private_bytes),
        group_process_count: group.as_ref().map(|value| value.process_count),
    })
}

#[cfg(target_os = "windows")]
fn process_uptime_seconds(creation_time: u64) -> Result<u64, String> {
    const WINDOWS_TICKS_PER_SECOND: u64 = 10_000_000;
    const WINDOWS_TO_UNIX_EPOCH_SECONDS: u64 = 11_644_473_600;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?;
    let now_filetime = (now.as_secs() + WINDOWS_TO_UNIX_EPOCH_SECONDS) * WINDOWS_TICKS_PER_SECOND
        + u64::from(now.subsec_nanos() / 100);

    Ok(now_filetime.saturating_sub(creation_time) / WINDOWS_TICKS_PER_SECOND)
}

#[cfg(target_os = "windows")]
fn process_cpu_usage(process_time: u64, logical_processors: u32) -> Option<f64> {
    use std::{
        sync::{Mutex, OnceLock},
        time::Instant,
    };

    static LAST_SAMPLE: OnceLock<Mutex<Option<(Instant, u64)>>> = OnceLock::new();

    let now = Instant::now();
    let sample = LAST_SAMPLE.get_or_init(|| Mutex::new(None));
    let mut last_sample = sample.lock().ok()?;
    let usage = last_sample.and_then(|(last_instant, last_process_time)| {
        let elapsed_seconds = now.duration_since(last_instant).as_secs_f64();

        if elapsed_seconds <= 0.0 || process_time < last_process_time {
            return None;
        }

        let process_seconds = (process_time - last_process_time) as f64 / 10_000_000.0;
        let usage = process_seconds / elapsed_seconds / f64::from(logical_processors) * 100.0;

        Some(usage.clamp(0.0, 100.0))
    });

    *last_sample = Some((now, process_time));

    usage
}

#[cfg(target_os = "windows")]
fn filetime_to_u64(filetime: windows::Win32::Foundation::FILETIME) -> u64 {
    (u64::from(filetime.dwHighDateTime) << 32) | u64::from(filetime.dwLowDateTime)
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{
        RelaunchRequest, elevation_error_message, join_windows_arguments, quote_windows_argument,
        run_elevation_worker,
    };
    use std::{
        ffi::{OsStr, OsString},
        os::windows::ffi::{OsStrExt, OsStringExt},
    };

    #[test]
    fn elevation_wait_does_not_block_the_command_future() {
        use std::{
            future::Future,
            pin::pin,
            sync::mpsc,
            task::{Context, Poll, Waker},
            time::Duration,
        };

        let caller_thread = std::thread::current().id();
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let mut result = pin!(run_elevation_worker(move || {
            started_sender.send(std::thread::current().id()).unwrap();
            release_receiver
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            Ok(())
        }));

        assert!(matches!(
            result
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        assert_ne!(
            started_receiver
                .recv_timeout(Duration::from_secs(5))
                .unwrap(),
            caller_thread
        );
        release_sender.send(()).unwrap();
        assert!(tauri::async_runtime::block_on(result).is_ok());
    }

    #[test]
    fn elevation_failure_reaches_the_caller() {
        assert_eq!(
            tauri::async_runtime::block_on(run_elevation_worker(|| Err("cancelled".to_string()))),
            Err("cancelled".to_string())
        );
    }

    #[test]
    fn duplicate_relaunch_is_rejected_and_failure_allows_retry() {
        let pending = std::sync::atomic::AtomicBool::new(false);
        let first = RelaunchRequest::begin(&pending).unwrap();
        assert!(RelaunchRequest::begin(&pending).is_err());

        drop(first);
        assert!(RelaunchRequest::begin(&pending).is_ok());
    }

    #[test]
    fn successful_relaunch_remains_pending_until_process_exit() {
        let pending = std::sync::atomic::AtomicBool::new(false);
        let mut first = RelaunchRequest::begin(&pending).unwrap();
        first.scheduled = true;
        drop(first);

        assert!(RelaunchRequest::begin(&pending).is_err());
    }

    #[test]
    fn distinguishes_uac_cancellation_from_launch_failure() {
        use windows::{
            Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_CANCELLED},
            core::{Error, HRESULT},
        };

        assert_eq!(
            elevation_error_message(Error::from_hresult(HRESULT::from_win32(ERROR_CANCELLED.0))),
            "administrator relaunch was cancelled"
        );
        assert!(
            elevation_error_message(Error::from_hresult(HRESULT::from_win32(
                ERROR_ACCESS_DENIED.0
            )))
            .starts_with("ShellExecuteExW runas failed:")
        );
    }

    #[test]
    fn quotes_unicode_paths_and_shell_metacharacters_as_native_windows_text() {
        let path = OsStr::new("C:\\中文 目录#100%\\模型🐾\\");

        assert_eq!(
            quote_windows_argument(path),
            OsString::from("\"C:\\中文 目录#100%\\模型🐾\\\\\"")
        );
    }

    #[test]
    fn quotes_embedded_double_quotes_and_backslashes() {
        assert_eq!(
            quote_windows_argument(OsStr::new("模型 \\\"测试\"")),
            OsString::from("\"模型 \\\\\\\"测试\\\"\"")
        );
    }

    #[test]
    fn preserves_unpaired_utf16_units_without_lossy_conversion() {
        let argument = OsString::from_wide(&[u16::from(b'a'), 0xd800, u16::from(b'b')]);
        let quoted = quote_windows_argument(&argument);

        assert_eq!(
            quoted.encode_wide().collect::<Vec<_>>(),
            vec![u16::from(b'a'), 0xd800, u16::from(b'b')]
        );
        assert_eq!(
            join_windows_arguments(&[quoted]),
            vec![u16::from(b'a'), 0xd800, u16::from(b'b'), 0]
        );
    }
}

#[cfg(target_os = "windows")]
fn current_process_thread_count() -> Result<u32, windows::core::Error> {
    use windows::Win32::{
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
        },
        System::Threading::GetCurrentProcessId,
    };

    let current_process_id = unsafe { GetCurrentProcessId() };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)? };
    let snapshot_guard = HandleGuard(snapshot);
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut count = 0;

    if unsafe { Thread32First(snapshot_guard.0, &mut entry) }.is_ok() {
        loop {
            if entry.th32OwnerProcessID == current_process_id {
                count += 1;
            }

            if unsafe { Thread32Next(snapshot_guard.0, &mut entry) }.is_err() {
                break;
            }
        }
    }

    Ok(count)
}

#[cfg(target_os = "windows")]
struct HandleGuard(windows::Win32::Foundation::HANDLE);

#[cfg(target_os = "windows")]
impl Drop for HandleGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
