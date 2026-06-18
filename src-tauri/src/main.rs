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
        .and_then(|value| value.to_string_lossy().parse::<u32>().ok())
        .unwrap_or(0);

    if args.next().as_deref() != Some(std::ffi::OsStr::new("--")) {
        std::process::exit(1);
    }

    let original_args = args.collect::<Vec<_>>();

    wait_for_process_exit(parent_process_id);

    if relaunch_current_exe(&original_args).is_err() {
        std::process::exit(1);
    }

    true
}

#[cfg(target_os = "windows")]
fn wait_for_process_exit(process_id: u32) {
    if process_id == 0 {
        return;
    }

    use windows::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, WaitForSingleObject},
    };

    const SYNCHRONIZE: windows::Win32::System::Threading::PROCESS_ACCESS_RIGHTS =
        windows::Win32::System::Threading::PROCESS_ACCESS_RIGHTS(0x0010_0000);

    if let Ok(process) = unsafe { OpenProcess(SYNCHRONIZE, false, process_id) } {
        unsafe {
            let _ = WaitForSingleObject(process, 10_000);
            let _ = CloseHandle(process);
        }
    }
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
