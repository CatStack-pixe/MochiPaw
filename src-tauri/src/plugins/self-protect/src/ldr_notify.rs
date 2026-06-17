//! §B12 LdrRegisterDllNotification 实时模块加载拦截。
//!
//! 在 Loader 完成 DLL 映射但 DllMain 未执行前回调,UTF-16 lower-case 与
//! 加密黑名单比对;命中即设原子标志,由 watchdog 异步处置。
//!
//! 回调内严禁堆分配 / panic / println;只读原子。

#![cfg(target_os = "windows")]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use core::ffi::c_void;
use core::ptr::null_mut;
use core::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

use parking_lot::RwLock;

use crate::event::{ViolationEvent, ViolationKind, emit_violation, kill_self};
use crate::obf;
use crate::policy::{PolicyConfig, exit_code};

type DWORD = u32;
type HMODULE = *mut c_void;
type FARPROC = *mut c_void;
type NTSTATUS = i32;
type HANDLE = *mut c_void;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleA(name: *const u8) -> HMODULE;
    fn GetProcAddress(h: HMODULE, name: *const u8) -> FARPROC;
}

#[repr(C)]
struct UNICODE_STRING {
    Length: u16,
    MaximumLength: u16,
    Buffer: *mut u16,
}

#[repr(C)]
struct LDR_DLL_LOADED_NOTIFICATION_DATA {
    Flags: u32,
    FullDllName: *const UNICODE_STRING,
    BaseDllName: *const UNICODE_STRING,
    DllBase: *mut c_void,
    SizeOfImage: u32,
}

const LDR_DLL_NOTIFICATION_REASON_LOADED: u32 = 1;

type LdrDllNotification = unsafe extern "system" fn(
    NotificationReason: u32,
    NotificationData: *const LDR_DLL_LOADED_NOTIFICATION_DATA,
    Context: *mut c_void,
);

type FnLdrRegisterDllNotification = unsafe extern "system" fn(
    Flags: u32,
    NotificationFunction: LdrDllNotification,
    Context: *mut c_void,
    Cookie: *mut *mut c_void,
) -> NTSTATUS;

static HIT: AtomicU32 = AtomicU32::new(0); // 1 + index 命中索引
static COOKIE: AtomicUsize = AtomicUsize::new(0);

/// 黑名单只在第一次注册时加载并保留;查表是只读 utf-16 lower-case
/// 字节流,无堆分配。
static BLACKLIST_U16: once_cell::sync::Lazy<RwLock<Vec<Vec<u16>>>> =
    once_cell::sync::Lazy::new(|| RwLock::new(Vec::new()));

fn build_blacklist() {
    let mut g = BLACKLIST_U16.write();
    if !g.is_empty() {
        return;
    }
    for s in obf::dll_blacklist_lowercase() {
        let v: Vec<u16> = s.encode_utf16().collect();
        g.push(v);
    }
}

extern "system" fn callback(
    reason: u32,
    data: *const LDR_DLL_LOADED_NOTIFICATION_DATA,
    _ctx: *mut c_void,
) {
    if reason != LDR_DLL_NOTIFICATION_REASON_LOADED || data.is_null() {
        return;
    }
    unsafe {
        let d = &*data;
        if d.BaseDllName.is_null() {
            return;
        }
        let bn = &*d.BaseDllName;
        if bn.Buffer.is_null() || bn.Length == 0 {
            return;
        }
        let n = (bn.Length / 2) as usize;
        let buf = core::slice::from_raw_parts(bn.Buffer, n);

        // 原地 lower-case 比对,无堆分配
        let bl = BLACKLIST_U16.read();
        'outer: for (idx, needle) in bl.iter().enumerate() {
            if needle.len() != n {
                continue;
            }
            for i in 0..n {
                let mut c = buf[i];
                if c >= b'A' as u16 && c <= b'Z' as u16 {
                    c += 32;
                }
                if c != needle[i] {
                    continue 'outer;
                }
            }
            // 命中
            HIT.store((idx as u32).wrapping_add(1), Ordering::Release);
            return;
        }
    }
}

pub fn install(cfg: &PolicyConfig) {
    if !cfg.ldr_notify {
        return;
    }
    build_blacklist();
    unsafe {
        let h = GetModuleHandleA(b"ntdll.dll\0".as_ptr());
        if h.is_null() {
            return;
        }
        let p = GetProcAddress(h, b"LdrRegisterDllNotification\0".as_ptr());
        if p.is_null() {
            return;
        }
        let f: FnLdrRegisterDllNotification = core::mem::transmute(p);
        let mut cookie: *mut c_void = null_mut();
        let _ = f(0, callback, null_mut(), &mut cookie);
        COOKIE.store(cookie as usize, Ordering::Relaxed);
    }
}

/// 由 watchdog 周期调用;命中黑名单后异步上报并自杀。
pub fn poll_and_handle(kill: bool) {
    let h = HIT.swap(0, Ordering::AcqRel);
    if h == 0 {
        return;
    }
    let idx = (h - 1) as usize;
    let names = obf::dll_blacklist_lowercase();
    let name = names.get(idx).cloned().unwrap_or_else(|| "<unknown>".into());
    emit_violation(ViolationEvent::new(
        ViolationKind::LdrBlacklist,
        format!("blacklist_dll_loaded={}", name),
    ));
    kill_self(exit_code::SUSPICIOUS_PROCESS, kill);
}
