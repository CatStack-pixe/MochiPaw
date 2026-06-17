//! Win32 进程缓解策略(Process Mitigation Policy)启用。
//!
//! 通过 `GetProcAddress` 动态解析 `SetProcessMitigationPolicy`,
//! 不被支持的策略静默忽略,确保 Win10 旧版本仍可启动。

#![cfg(target_os = "windows")]
#![allow(non_snake_case, non_camel_case_types)]

use core::ffi::c_void;

use crate::event::{ViolationEvent, ViolationKind, emit_violation};
use crate::policy::PolicyConfig;

type BOOL = i32;
type HMODULE = *mut c_void;
type FARPROC = *const c_void;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleA(name: *const u8) -> HMODULE;
    fn GetProcAddress(module: HMODULE, name: *const u8) -> FARPROC;
}

#[repr(i32)]
#[derive(Copy, Clone)]
#[allow(dead_code)]
enum ProcessMitigationPolicy {
    Aslr = 1,
    DynamicCode = 2,
    StrictHandleCheck = 3,
    SystemCallDisable = 4,
    ExtensionPointDisable = 6,
    Signature = 8,
    ImageLoad = 10,
    UserShadowStack = 15,
    RedirectionTrust = 16,
}

#[repr(C)]
#[derive(Copy, Clone)]
struct MitigationFlags(u32);

type SetProcessMitigationPolicyFn =
    unsafe extern "system" fn(policy: i32, buffer: *const c_void, size: usize) -> BOOL;

unsafe fn resolve() -> Option<SetProcessMitigationPolicyFn> {
    let kernel32 = unsafe { GetModuleHandleA(b"kernel32.dll\0".as_ptr()) };
    if kernel32.is_null() {
        return None;
    }
    let p = unsafe { GetProcAddress(kernel32, b"SetProcessMitigationPolicy\0".as_ptr()) };
    if p.is_null() {
        return None;
    }
    Some(unsafe { core::mem::transmute::<FARPROC, SetProcessMitigationPolicyFn>(p) })
}

unsafe fn apply_one(
    set: SetProcessMitigationPolicyFn,
    kind: ProcessMitigationPolicy,
    value: &MitigationFlags,
) {
    let _ = unsafe {
        set(
            kind as i32,
            value as *const MitigationFlags as *const c_void,
            core::mem::size_of::<MitigationFlags>(),
        )
    };
}

pub fn apply(cfg: &PolicyConfig) {
    if !cfg.apply_mitigations {
        return;
    }
    let Some(set) = (unsafe { resolve() }) else {
        emit_violation(ViolationEvent::new(
            ViolationKind::MitigationDowngrade,
            "SetProcessMitigationPolicy unavailable",
        ));
        return;
    };

    unsafe {
        // ASLR:bit0 BottomUp / bit1 ForceRelocateImages / bit2 HighEntropy / bit3 DisallowStrippedImages
        apply_one(set, ProcessMitigationPolicy::Aslr, &MitigationFlags(0b1111));
        // ExtensionPointDisable
        apply_one(set, ProcessMitigationPolicy::ExtensionPointDisable, &MitigationFlags(0b1));
        // ImageLoad:NoRemoteImages | NoLowMandatoryLabelImages | PreferSystem32Images
        apply_one(set, ProcessMitigationPolicy::ImageLoad, &MitigationFlags(0b111));
        // StrictHandleCheck:RaiseExceptionOnInvalidHandleReference | HandleExceptionsPermanentlyEnabled
        apply_one(set, ProcessMitigationPolicy::StrictHandleCheck, &MitigationFlags(0b11));
        // RedirectionTrust:Enforce | Audit
        apply_one(set, ProcessMitigationPolicy::RedirectionTrust, &MitigationFlags(0b11));
        // CET shadow stack:Enable | Audit
        apply_one(set, ProcessMitigationPolicy::UserShadowStack, &MitigationFlags(0b11));
        // Signature:audit-only by default,signature_enforce 才转 enforce
        let sig = if cfg.signature_enforce { 0b0001 } else { 0b1000 };
        apply_one(set, ProcessMitigationPolicy::Signature, &MitigationFlags(sig));
        // DynamicCode(ACG):ProhibitDynamicCode | AllowThreadOptOut
        apply_one(set, ProcessMitigationPolicy::DynamicCode, &MitigationFlags(0b11));
        // SystemCallDisable:DisallowWin32kSystemCalls(默认关)
        if cfg.disallow_win32k {
            apply_one(set, ProcessMitigationPolicy::SystemCallDisable, &MitigationFlags(0b1));
        }
    }
}
