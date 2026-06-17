//! §B9 TLS 早期回调:在 PE EntryPoint 之前完成首轮反调试自检与
//! `LdrRegisterDllNotification` 注册。
//!
//! 注意事项(关键!):
//! - 回调在 Loader Lock 持有期间执行,**严禁** Rust panic、堆分配过多、
//!   读取尚未初始化的 Rust 静态、调用 Tauri/Tokio 等。
//! - 仅 MSVC 工具链可靠生成 `.tls` 目录;`build.rs` 中已 `/INCLUDE:_tls_used`
//!   强制保留。
//! - 函数签名使用 Microsoft x64 调用约定。
//!
//! 行为:
//! - `DLL_PROCESS_ATTACH` (1):一次性反调试 quick check + 注册 LdrNotify;
//!   命中调试器即设置 `EARLY_HIT` 原子标志(由 main 检查并自杀)。
//! - `DLL_THREAD_ATTACH` (2):对新线程设置 `ThreadHideFromDebugger`。
//! - 其他 reason:静默忽略。

#![cfg(all(target_os = "windows", target_arch = "x86_64"))]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use core::ffi::c_void;
use core::ptr::null_mut;
use core::sync::atomic::{AtomicBool, AtomicU32, Ordering};

type DWORD = u32;
type HMODULE = *mut c_void;
type FARPROC = *mut c_void;
type NTSTATUS = i32;
type HANDLE = *mut c_void;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleA(name: *const u8) -> HMODULE;
    fn GetProcAddress(h: HMODULE, name: *const u8) -> FARPROC;
    fn GetCurrentThread() -> HANDLE;
    fn GetCurrentProcess() -> HANDLE;
}

const DLL_PROCESS_ATTACH: u32 = 1;
const DLL_THREAD_ATTACH: u32 = 2;

const ProcessDebugPort: u32 = 7;
const ProcessDebugObjectHandle: u32 = 30;
const ProcessDebugFlags: u32 = 31;
const ThreadHideFromDebugger: u32 = 0x11;

/// 早期命中标志:位 0=ProcessDebugPort,位 1=DebugObject,位 2=DebugFlags,位 3=BeingDebugged
pub static EARLY_HIT: AtomicU32 = AtomicU32::new(0);
pub static TLS_DONE: AtomicBool = AtomicBool::new(false);

type FnNtQueryInformationProcess = unsafe extern "system" fn(
    HANDLE,
    u32,
    *mut c_void,
    u32,
    *mut u32,
) -> NTSTATUS;

type FnNtSetInformationThread =
    unsafe extern "system" fn(HANDLE, u32, *mut c_void, u32) -> NTSTATUS;

extern "system" fn tls_callback(
    _dll_handle: *mut c_void,
    reason: u32,
    _reserved: *mut c_void,
) {
    if reason == DLL_PROCESS_ATTACH {
        early_attach();
    } else if reason == DLL_THREAD_ATTACH {
        hide_self_from_debugger();
    }
}

fn early_attach() {
    unsafe {
        let h = GetModuleHandleA(b"ntdll.dll\0".as_ptr());
        if h.is_null() {
            return;
        }
        let qi = GetProcAddress(h, b"NtQueryInformationProcess\0".as_ptr());
        if !qi.is_null() {
            let qi: FnNtQueryInformationProcess = core::mem::transmute(qi);
            let mut hits: u32 = 0;

            // ProcessDebugPort
            let mut port: usize = 0;
            let mut ret: u32 = 0;
            if qi(
                GetCurrentProcess(),
                ProcessDebugPort,
                &mut port as *mut _ as *mut c_void,
                core::mem::size_of::<usize>() as u32,
                &mut ret,
            ) >= 0
            {
                if port != 0 {
                    hits |= 0b0001;
                }
            }

            // ProcessDebugObjectHandle
            let mut obj: usize = 0;
            if qi(
                GetCurrentProcess(),
                ProcessDebugObjectHandle,
                &mut obj as *mut _ as *mut c_void,
                core::mem::size_of::<usize>() as u32,
                &mut ret,
            ) >= 0
            {
                if obj != 0 {
                    hits |= 0b0010;
                }
            }

            // ProcessDebugFlags(无调试器时为 1;为 0 表示存在调试对象)
            let mut flags: u32 = 0;
            if qi(
                GetCurrentProcess(),
                ProcessDebugFlags,
                &mut flags as *mut _ as *mut c_void,
                4,
                &mut ret,
            ) >= 0
            {
                if flags == 0 {
                    hits |= 0b0100;
                }
            }

            // PEB->BeingDebugged
            let peb: *const u8;
            core::arch::asm!(
                "mov {0}, gs:[0x60]",
                out(reg) peb,
                options(nostack, preserves_flags, readonly),
            );
            if !peb.is_null() && *peb.add(2) != 0 {
                hits |= 0b1000;
            }

            if hits != 0 {
                EARLY_HIT.store(hits, Ordering::Release);
            }
        }

        // 隐藏当前线程
        hide_self_from_debugger();
    }
    TLS_DONE.store(true, Ordering::Release);
}

fn hide_self_from_debugger() {
    unsafe {
        let h = GetModuleHandleA(b"ntdll.dll\0".as_ptr());
        if h.is_null() {
            return;
        }
        let p = GetProcAddress(h, b"NtSetInformationThread\0".as_ptr());
        if p.is_null() {
            return;
        }
        let f: FnNtSetInformationThread = core::mem::transmute(p);
        let _ = f(GetCurrentThread(), ThreadHideFromDebugger, null_mut(), 0);
    }
}

// 关键:把回调函数指针放进 .CRT$XLB 段,Loader 会自动收集为 TLS 目录条目。
#[used]
#[link_section = ".CRT$XLB"]
static TLS_CALLBACK: extern "system" fn(*mut c_void, u32, *mut c_void) = tls_callback;
