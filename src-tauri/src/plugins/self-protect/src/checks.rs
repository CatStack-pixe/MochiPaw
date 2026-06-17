/// 兼容旧 API:`is_debugged()` 调本函数。Windows 上委托给 `anti_debug::quick_check`,
/// 其他平台保持原 macOS PT_DENY_ATTACH 行为。
pub fn check_all() -> bool {
    #[cfg(target_os = "windows")]
    {
        super::anti_debug::quick_check().is_some()
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

#[cfg(target_os = "macos")]
fn check_macos() -> bool {
    use libc::{c_int, getpid, ptrace};

    const PT_DENY_ATTACH: c_int = 31;
    unsafe {
        ptrace(PT_DENY_ATTACH, getpid(), 0, 0);
    }

    false
}
