//! §B10 Hell's Gate 风格的 Nt* 调用集中化通道。
//!
//! ## 设计权衡
//!
//! 真正的"绕过 ntdll inline hook"需要 x86_64 上手写带 8 参数的 syscall 跳板,
//! 这要求 `naked_functions` / `global_asm!` 加 Windows x64 调用约定的精细处理,
//! 一旦寄存器/栈参数对不齐就是悄悄写错内存。本插件无法在 sandbox 中真机
//! 验证,因此采取**保守策略**:
//!
//! 1. 启动期 [`resolve_ssn_table()`]:从 `ntdll!Nt*` 导出读取首字节,提取 SSN
//!    并搜寻 `0F 05 C3` gadget;**仅作健康度指标**(`is_resolved`、`hook_score`)。
//! 2. 各 [`NtQueryInformationProcess`] 等高层包装:统一通过 `GetProcAddress`
//!    取函数指针调用,**不**做内联 syscall。
//! 3. 真正抵御 hook 的是 §B11 `hook_detect`:发现首字节被改即自杀。
//!
//! 这样 §B10 提供"集中调用入口 + hook 早期信号",§B11 提供"硬响应",
//! 二者协作覆盖 plan 中"直接 syscall"目标的实战意图(让 hook 无法静默化
//! 我方反制),同时不引入未在真机验证的内联汇编。
//!
//! 后续若需要真正绕过 hook,在 `do_syscall` 处接入经真机验证的 naked
//! 跳板即可,**对外接口零变更**。

#![cfg(target_os = "windows")]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use core::ffi::c_void;
use core::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};

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

const SSN_TABLE_SIZE: usize = SyscallId::__COUNT__ as usize;
static SSN: [AtomicU32; SSN_TABLE_SIZE] = [const { AtomicU32::new(u32::MAX) }; SSN_TABLE_SIZE];
static HOOK_SCORE: AtomicU32 = AtomicU32::new(0);
static SYSCALL_GADGET: AtomicUsize = AtomicUsize::new(0);
static RESOLVED: AtomicBool = AtomicBool::new(false);

#[repr(usize)]
#[derive(Clone, Copy, Debug)]
pub enum SyscallId {
    NtQueryInformationProcess = 0,
    NtSetInformationThread = 1,
    NtQuerySystemInformation = 2,
    NtQueryInformationThread = 3,
    NtSetInformationProcess = 4,
    __COUNT__ = 5,
}

#[inline]
fn ascii_for(id: SyscallId) -> &'static [u8] {
    match id {
        SyscallId::NtQueryInformationProcess => b"NtQueryInformationProcess\0",
        SyscallId::NtSetInformationThread => b"NtSetInformationThread\0",
        SyscallId::NtQuerySystemInformation => b"NtQuerySystemInformation\0",
        SyscallId::NtQueryInformationThread => b"NtQueryInformationThread\0",
        SyscallId::NtSetInformationProcess => b"NtSetInformationProcess\0",
        SyscallId::__COUNT__ => &[],
    }
}

/// 启动早期一次性解析 SSN 表并搜寻 syscall gadget。
///
/// 全部失败均静默忽略;调用方亦无需关心,高层包装内会回落标准导出。
pub fn resolve_ssn_table() {
    if RESOLVED.swap(true, Ordering::SeqCst) {
        return;
    }

    let ntdll = unsafe { GetModuleHandleA(b"ntdll.dll\0".as_ptr()) };
    if ntdll.is_null() {
        return;
    }

    let mut hook_score: u32 = 0;
    for id in [
        SyscallId::NtQueryInformationProcess,
        SyscallId::NtSetInformationThread,
        SyscallId::NtQuerySystemInformation,
        SyscallId::NtQueryInformationThread,
        SyscallId::NtSetInformationProcess,
    ] {
        let name = ascii_for(id);
        let proc = unsafe { GetProcAddress(ntdll, name.as_ptr()) };
        if proc.is_null() {
            continue;
        }
        let bytes = unsafe { core::slice::from_raw_parts(proc as *const u8, 16) };
        // 经典未被 hook 的 stub 前 4 字节: 4C 8B D1 B8(mov r10,rcx; mov eax,imm32)
        if bytes.len() >= 8
            && bytes[0] == 0x4C
            && bytes[1] == 0x8B
            && bytes[2] == 0xD1
            && bytes[3] == 0xB8
        {
            let ssn = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
            SSN[id as usize].store(ssn, Ordering::Relaxed);
        } else {
            // 首字节非典型 stub:强烈提示用户态 inline hook 存在(EDR 或作弊器)。
            hook_score = hook_score.saturating_add(1);
        }
    }
    HOOK_SCORE.store(hook_score, Ordering::Relaxed);

    if let Some(gadget) = find_syscall_gadget(ntdll) {
        SYSCALL_GADGET.store(gadget, Ordering::Relaxed);
    }
}

fn find_syscall_gadget(ntdll: HMODULE) -> Option<usize> {
    unsafe {
        let dos = ntdll as *const u8;
        let e_lfanew = core::ptr::read_unaligned(dos.add(0x3C) as *const u32) as usize;
        let opt = dos.add(e_lfanew + 24);
        let size_of_image = core::ptr::read_unaligned(opt.add(56) as *const u32) as usize;
        if size_of_image == 0 || size_of_image > 0x40_000_000 {
            return None;
        }
        let end = (ntdll as usize).saturating_add(size_of_image.saturating_sub(3));
        let mut p = ntdll as usize;
        while p < end {
            let b = p as *const u8;
            if *b == 0x0F && *b.add(1) == 0x05 && *b.add(2) == 0xC3 {
                return Some(p);
            }
            p += 1;
        }
        None
    }
}

#[inline]
pub fn is_resolved() -> bool {
    RESOLVED.load(Ordering::Relaxed)
}

#[inline]
pub fn hook_score() -> u32 {
    HOOK_SCORE.load(Ordering::Relaxed)
}

#[inline]
pub fn ssn(id: SyscallId) -> Option<u32> {
    let v = SSN[id as usize].load(Ordering::Relaxed);
    if v == u32::MAX { None } else { Some(v) }
}

#[inline]
pub fn syscall_gadget() -> usize {
    SYSCALL_GADGET.load(Ordering::Relaxed)
}

fn ntdll_export(name: &[u8]) -> FARPROC {
    unsafe {
        let h = GetModuleHandleA(b"ntdll.dll\0".as_ptr());
        if h.is_null() {
            return core::ptr::null_mut();
        }
        GetProcAddress(h, name.as_ptr())
    }
}

// === 高层包装(集中入口,所有自我保护模块统一从这里调用 Nt*) ===

pub unsafe fn NtQueryInformationProcess(
    ProcessHandle: HANDLE,
    ProcessInformationClass: u32,
    ProcessInformation: *mut c_void,
    ProcessInformationLength: u32,
    ReturnLength: *mut u32,
) -> NTSTATUS {
    type Fn = unsafe extern "system" fn(
        HANDLE,
        u32,
        *mut c_void,
        u32,
        *mut u32,
    ) -> NTSTATUS;
    let f = ntdll_export(b"NtQueryInformationProcess\0");
    if f.is_null() {
        return -1;
    }
    let f: Fn = unsafe { core::mem::transmute(f) };
    unsafe {
        f(
            ProcessHandle,
            ProcessInformationClass,
            ProcessInformation,
            ProcessInformationLength,
            ReturnLength,
        )
    }
}

pub unsafe fn NtSetInformationThread(
    ThreadHandle: HANDLE,
    ThreadInformationClass: u32,
    ThreadInformation: *mut c_void,
    ThreadInformationLength: u32,
) -> NTSTATUS {
    type Fn =
        unsafe extern "system" fn(HANDLE, u32, *mut c_void, u32) -> NTSTATUS;
    let f = ntdll_export(b"NtSetInformationThread\0");
    if f.is_null() {
        return -1;
    }
    let f: Fn = unsafe { core::mem::transmute(f) };
    unsafe {
        f(
            ThreadHandle,
            ThreadInformationClass,
            ThreadInformation,
            ThreadInformationLength,
        )
    }
}

pub unsafe fn NtQuerySystemInformation(
    SystemInformationClass: u32,
    SystemInformation: *mut c_void,
    SystemInformationLength: u32,
    ReturnLength: *mut u32,
) -> NTSTATUS {
    type Fn =
        unsafe extern "system" fn(u32, *mut c_void, u32, *mut u32) -> NTSTATUS;
    let f = ntdll_export(b"NtQuerySystemInformation\0");
    if f.is_null() {
        return -1;
    }
    let f: Fn = unsafe { core::mem::transmute(f) };
    unsafe {
        f(
            SystemInformationClass,
            SystemInformation,
            SystemInformationLength,
            ReturnLength,
        )
    }
}

pub unsafe fn NtQueryInformationThread(
    ThreadHandle: HANDLE,
    ThreadInformationClass: u32,
    ThreadInformation: *mut c_void,
    ThreadInformationLength: u32,
    ReturnLength: *mut u32,
) -> NTSTATUS {
    type Fn = unsafe extern "system" fn(
        HANDLE,
        u32,
        *mut c_void,
        u32,
        *mut u32,
    ) -> NTSTATUS;
    let f = ntdll_export(b"NtQueryInformationThread\0");
    if f.is_null() {
        return -1;
    }
    let f: Fn = unsafe { core::mem::transmute(f) };
    unsafe {
        f(
            ThreadHandle,
            ThreadInformationClass,
            ThreadInformation,
            ThreadInformationLength,
            ReturnLength,
        )
    }
}

pub unsafe fn NtSetInformationProcess(
    ProcessHandle: HANDLE,
    ProcessInformationClass: u32,
    ProcessInformation: *mut c_void,
    ProcessInformationLength: u32,
) -> NTSTATUS {
    type Fn =
        unsafe extern "system" fn(HANDLE, u32, *mut c_void, u32) -> NTSTATUS;
    let f = ntdll_export(b"NtSetInformationProcess\0");
    if f.is_null() {
        return -1;
    }
    let f: Fn = unsafe { core::mem::transmute(f) };
    unsafe {
        f(
            ProcessHandle,
            ProcessInformationClass,
            ProcessInformation,
            ProcessInformationLength,
        )
    }
}
