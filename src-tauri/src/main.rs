// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "windows")]
    if run_admin_relaunch_helper() {
        return;
    }

    mochi_paw_lib::run()
}

#[cfg(target_os = "windows")]
fn run_admin_relaunch_helper() -> bool {
    const ADMIN_RELAUNCH_HELPER_ARG: &str = "--mochi-paw-admin-relaunch-helper";

    let mut args = std::env::args_os().skip(1);

    if args.next().as_deref() != Some(std::ffi::OsStr::new(ADMIN_RELAUNCH_HELPER_ARG)) {
        return false;
    }

    let parent_process_id = args
        .next()
        .and_then(|value| value.into_string().ok())
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);

    if args.next().as_deref() != Some(std::ffi::OsStr::new("--")) {
        std::process::exit(1);
    }

    let original_args = args.collect::<Vec<_>>();

    let result =
        wait_for_process_exit(parent_process_id).and_then(|_| relaunch_current_exe(&original_args));

    if let Err(error) = result {
        show_admin_relaunch_error(&error);
        std::process::exit(1);
    }

    true
}

#[cfg(target_os = "windows")]
fn wait_for_process_exit(process_id: u32) -> Result<(), String> {
    if process_id == 0 {
        return Ok(());
    }

    use windows::{
        Win32::{
            Foundation::{CloseHandle, ERROR_INVALID_PARAMETER},
            System::Threading::{OpenProcess, WaitForSingleObject},
        },
        core::HRESULT,
    };

    const SYNCHRONIZE: windows::Win32::System::Threading::PROCESS_ACCESS_RIGHTS =
        windows::Win32::System::Threading::PROCESS_ACCESS_RIGHTS(0x0010_0000);

    let process = match unsafe { OpenProcess(SYNCHRONIZE, false, process_id) } {
        Ok(process) => process,
        // The original process can exit before the elevated helper opens it.
        Err(error) if error.code() == HRESULT::from_win32(ERROR_INVALID_PARAMETER.0) => {
            return Ok(());
        }
        Err(error) => {
            return Err(format!(
                "Opening the existing MochiPaw process failed: {error}"
            ));
        }
    };
    let wait_result = unsafe { WaitForSingleObject(process, 10_000) };
    unsafe {
        let _ = CloseHandle(process);
    }

    parse_process_wait_result(wait_result)
}

#[cfg(target_os = "windows")]
fn parse_process_wait_result(
    wait_result: windows::Win32::Foundation::WAIT_EVENT,
) -> Result<(), String> {
    use windows::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};

    match wait_result {
        WAIT_OBJECT_0 => Ok(()),
        WAIT_TIMEOUT => Err("The existing MochiPaw process did not exit in time.".to_string()),
        result => Err(format!(
            "Waiting for the existing MochiPaw process failed with code {}.",
            result.0
        )),
    }
}

#[cfg(target_os = "windows")]
fn show_admin_relaunch_error(error: &str) {
    use windows::{
        Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW},
        core::PCWSTR,
    };

    let title = to_wide_str("MochiPaw administrator relaunch failed");
    let message = to_wide_str(&format!(
        "{error}\n\nClose every MochiPaw process in Task Manager, then try again."
    ));

    unsafe {
        let _ = MessageBoxW(
            None,
            PCWSTR(message.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONERROR,
        );
    }
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
fn relaunch_current_exe(args: &[std::ffi::OsString]) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let exe_path = std::env::current_exe().map_err(|error| error.to_string())?;
    let working_directory = exe_path
        .parent()
        .ok_or_else(|| "current executable has no parent directory".to_string())?;

    Command::new(&exe_path)
        .args(args)
        .current_dir(working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::parse_process_wait_result;
    use windows::Win32::Foundation::{WAIT_EVENT, WAIT_OBJECT_0, WAIT_TIMEOUT};

    #[test]
    fn accepts_parent_process_exit() {
        assert!(parse_process_wait_result(WAIT_OBJECT_0).is_ok());
    }

    #[test]
    fn rejects_parent_process_timeout() {
        assert!(
            parse_process_wait_result(WAIT_TIMEOUT)
                .unwrap_err()
                .contains("did not exit in time")
        );
    }

    #[test]
    fn rejects_unexpected_wait_result() {
        assert!(
            parse_process_wait_result(WAIT_EVENT(1))
                .unwrap_err()
                .contains("code 1")
        );
    }
}
