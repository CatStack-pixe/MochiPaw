//! §B14 RtlSetProcessIsCritical:强杀进程时触发蓝屏威慑。
//!
//! 双刃剑——任何异常退出(panic / WebView2 crash)都会蓝屏。默认 feature
//! `hardening_critical_process` 关。开启时:
//!   - `enable()`:`RtlAdjustPrivilege(SeDebugPrivilege)` → `RtlSetProcessIsCritical(TRUE)`
//!   - `install_normal_exit_hook()`:正常退出路径(Ctrl+C / atexit)前先 disable。

#![cfg(target_os = "windows")]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use core::ffi::c_void;
use core::sync::atomic::{AtomicBool, Ordering};

use crate::event::{ViolationEvent, ViolationKind, emit_violation};
use crate::policy::PolicyConfig;

type DWORD = u32;
type BOOL = i32;
type NTSTATUS = i32;
type HMODULE = *mut c_void;
type FARPROC = *mut c_void;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleA(name: *const u8) -> HMODULE;
    fn GetProcAddress(h: HMODULE, name: *const u8) -> FARPROC;
    fn SetConsoleCtrlHandler(h: extern "system" fn(u32) -> BOOL, add: BOOL) -> BOOL;
}

const SE_DEBUG_PRIVILEGE: u32 = 20;

type FnRtlAdjustPrivilege = unsafe extern "system" fn(
    Privilege: u32,
    Enable: u8,
    CurrentThread: u8,
    Enabled: *mut u8,
) -> NTSTATUS;

type FnRtlSetProcessIsCritical = unsafe extern "system" fn(
    NewValue: u8,
    OldValue: *mut u8,
    NeedSeDebug: u8,
) -> NTSTATUS;

static ENABLED: AtomicBool = AtomicBool::new(false);

#[inline]
fn nt_success(s: NTSTATUS) -> bool {
    s >= 0
}

pub fn enable_if_configured(cfg: &PolicyConfig) {
    if !cfg.critical_process {
        return;
    }
    if ENABLED.load(Ordering::Relaxed) {
        return;
    }
    unsafe {
        let h = GetModuleHandleA(b"ntdll.dll\0".as_ptr());
        if h.is_null() {
            emit_violation(ViolationEvent::new(
                ViolationKind::CriticalProcessUnavailable,
                "ntdll missing",
            ));
            return;
        }
        let adj = GetProcAddress(h, b"RtlAdjustPrivilege\0".as_ptr());
        let set = GetProcAddress(h, b"RtlSetProcessIsCritical\0".as_ptr());
        if adj.is_null() || set.is_null() {
            emit_violation(ViolationEvent::new(
                ViolationKind::CriticalProcessUnavailable,
                "rtl exports missing",
            ));
            return;
        }
        let adj: FnRtlAdjustPrivilege = core::mem::transmute(adj);
        let set: FnRtlSetProcessIsCritical = core::mem::transmute(set);
        let mut old: u8 = 0;
        let st1 = adj(SE_DEBUG_PRIVILEGE, 1, 0, &mut old);
        // 普通用户帐户没有 SeDebugPrivilege 是常态,失败也尝试 set。
        let mut prev: u8 = 0;
        let st2 = set(1, &mut prev, 0);
        if !nt_success(st2) {
            emit_violation(ViolationEvent::new(
                ViolationKind::CriticalProcessUnavailable,
                format!("RtlSetProcessIsCritical failed: 0x{:x} (priv={:x})", st2, st1),
            ));
            return;
        }
        ENABLED.store(true, Ordering::Release);

        // 注册正常退出 hook
        let _ = SetConsoleCtrlHandler(ctrl_handler, 1);
        // atexit 在 Tauri 主循环结束后由 CRT 调用
        libc_atexit(disable_on_exit);
    }
}

extern "system" fn ctrl_handler(_t: u32) -> BOOL {
    disable_on_exit();
    0
}

extern "C" fn disable_on_exit() {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    unsafe {
        let h = GetModuleHandleA(b"ntdll.dll\0".as_ptr());
        if h.is_null() {
            return;
        }
        let set = GetProcAddress(h, b"RtlSetProcessIsCritical\0".as_ptr());
        if set.is_null() {
            return;
        }
        let set: FnRtlSetProcessIsCritical = core::mem::transmute(set);
        let mut prev: u8 = 0;
        let _ = set(0, &mut prev, 0);
    }
    ENABLED.store(false, Ordering::Release);
}

// 不引入完整 libc:仅用 atexit。Windows MSVC C runtime 暴露 `atexit` C 符号。
unsafe extern "C" {
    fn atexit(cb: extern "C" fn()) -> i32;
}

fn libc_atexit(cb: extern "C" fn()) {
    unsafe {
        let _ = atexit(cb);
    }
}
