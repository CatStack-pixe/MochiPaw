// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use tauri::{AppHandle, Runtime, command};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMetrics {
    pid: u32,
    cpu_usage: Option<f64>,
    memory_bytes: u64,
    virtual_memory_bytes: u64,
    thread_count: u32,
    uptime_seconds: u64,
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
pub fn relaunch_as_administrator<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if is_running_as_administrator()? {
            return Ok(());
        }

        schedule_windows_administrator_relaunch()?;

        // Give the elevated helper time to receive the UAC approval before
        // asking Tauri to release the current instance and its plugins.
        let app_handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            app_handle.exit(0);
        });

        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(())
    }
}

#[command]
pub fn get_process_metrics() -> Result<ProcessMetrics, String> {
    #[cfg(target_os = "windows")]
    {
        windows_process_metrics()
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(ProcessMetrics {
            pid: std::process::id(),
            cpu_usage: None,
            memory_bytes: 0,
            virtual_memory_bytes: 0,
            thread_count: 0,
            uptime_seconds: 0,
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
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_HIDE},
        core::PCWSTR,
    };

    const SE_ERR_ACCESSDENIED: isize = 5;
    const ADMIN_RELAUNCH_HELPER_ARG: &str = "--mochi-paw-admin-relaunch-helper";

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
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR(parameters.as_ptr()),
            PCWSTR(directory.as_ptr()),
            SW_HIDE,
        )
    };
    let result_code = result.0 as isize;

    if result_code > 32 {
        return Ok(());
    }

    if result_code == SE_ERR_ACCESSDENIED {
        return Err("administrator relaunch was cancelled".to_string());
    }

    Err(format!(
        "ShellExecuteW runas failed with code {result_code}"
    ))
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
    use std::mem::size_of;
    use windows::Win32::{
        Foundation::{FILETIME, GetLastError},
        System::{
            ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            SystemInformation::GetSystemInfo,
            Threading::{GetCurrentProcess, GetCurrentProcessId, GetProcessTimes},
        },
    };

    let process = unsafe { GetCurrentProcess() };
    let mut memory_counters = PROCESS_MEMORY_COUNTERS {
        cb: size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        ..Default::default()
    };

    unsafe {
        GetProcessMemoryInfo(
            process,
            &mut memory_counters,
            size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
        .map_err(|error| error.to_string())?;
    }

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

    Ok(ProcessMetrics {
        pid: unsafe { GetCurrentProcessId() },
        cpu_usage: process_cpu_usage(
            filetime_to_u64(kernel_time) + filetime_to_u64(user_time),
            system_info.dwNumberOfProcessors.max(1),
        ),
        memory_bytes: memory_counters.WorkingSetSize as u64,
        virtual_memory_bytes: memory_counters.PagefileUsage as u64,
        thread_count: current_process_thread_count().map_err(|_| unsafe {
            format!(
                "GetCurrentProcess thread snapshot failed: {:?}",
                GetLastError()
            )
        })?,
        uptime_seconds,
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
    use super::{join_windows_arguments, quote_windows_argument};
    use std::{
        ffi::{OsStr, OsString},
        os::windows::ffi::{OsStrExt, OsStringExt},
    };

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
