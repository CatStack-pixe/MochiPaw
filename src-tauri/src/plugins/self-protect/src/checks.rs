// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/// 检查当前进程是否存在调试器附加迹象。
pub fn check_all() -> bool {
    #[cfg(target_os = "windows")]
    {
        check_windows()
    }

    #[cfg(target_os = "macos")]
    {
        check_macos()
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        false
    }
}

#[cfg(target_os = "windows")]
fn check_windows() -> bool {
    use windows::Win32::System::Diagnostics::Debug::{CheckRemoteDebuggerPresent, IsDebuggerPresent};
    use windows::Win32::System::Threading::GetCurrentProcess;

    unsafe {
        if IsDebuggerPresent().as_bool() {
            return true;
        }
    }

    unsafe {
        let mut debug_present = windows::core::BOOL::default();
        let _ = CheckRemoteDebuggerPresent(GetCurrentProcess(), &mut debug_present);
        if debug_present.as_bool() {
            return true;
        }
    }

    false
}

#[cfg(target_os = "macos")]
fn check_macos() -> bool {
    use libc::{c_int, getpid, ptrace};

    const PT_DENY_ATTACH: c_int = 31;
    unsafe {
        ptrace(PT_DENY_ATTACH, getpid(), 0, 0);
    }

    false
}
