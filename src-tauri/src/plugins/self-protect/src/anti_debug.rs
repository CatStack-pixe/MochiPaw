//! 多手段反调试。所有失败均尽量静默,以避免日常运行干扰;
//! 命中任一项即记录违例并(release 模式下)`TerminateProcess`。
//!
//! 检测项:
//! - `IsDebuggerPresent` / `CheckRemoteDebuggerPresent`
//! - `NtQueryInformationProcess`:`ProcessDebugPort` / `ProcessDebugObjectHandle` / `ProcessDebugFlags`
//! - PEB `BeingDebugged` 与 `NtGlobalFlag & 0x70`
//! - Process Heap `Flags` / `ForceFlags`
//! - `NtSetInformationThread(ThreadHideFromDebugger)` 安装到所有线程
//!
//! 硬件断点扫描与 VEH int3 trap 在初版未启用,以避免 windows-rs `CONTEXT`
//! 绑定不稳定带来的兼容性风险;后续可单独补回。

#![cfg(target_os = "windows")]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use core::ffi::c_void;
use core::ptr::null_mut;

use crate::event::ViolationKind;

// ─── Raw Win32 FFI(stable since Win2000)─────────────────────────────────

type BOOL = i32;
type DWORD = u32;
type HANDLE = *mut c_void;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn IsDebuggerPresent() -> BOOL;
    fn CheckRemoteDebuggerPresent(h: HANDLE, present: *mut BOOL) -> BOOL;
    fn GetCurrentProcess() -> HANDLE;
    fn GetCurrentThread() -> HANDLE;
    fn CreateToolhelp32Snapshot(flags: DWORD, pid: DWORD) -> HANDLE;
    fn CloseHandle(h: HANDLE) -> BOOL;
    fn OpenThread(access: DWORD, inherit: BOOL, tid: DWORD) -> HANDLE;
    fn GetCurrentProcessId() -> DWORD;
}

const TH32CS_SNAPTHREAD: DWORD = 0x0000_0004;
const THREAD_SET_INFORMATION: DWORD = 0x0020;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct THREADENTRY32 {
    dwSize: DWORD,
    cntUsage: DWORD,
    th32ThreadID: DWORD,
    th32OwnerProcessID: DWORD,
    tpBasePri: i32,
    tpDeltaPri: i32,
    dwFlags: DWORD,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn Thread32First(h: HANDLE, te: *mut THREADENTRY32) -> BOOL;
    fn Thread32Next(h: HANDLE, te: *mut THREADENTRY32) -> BOOL;
}

// ─── ntapi raw entries(全部经 syscall:: 通道,§B10 集中)─────────────────

const ProcessBasicInformation: u32 = 0;
const ProcessDebugPort: u32 = 7;
const ProcessDebugObjectHandle: u32 = 30;
const ProcessDebugFlags: u32 = 31;
const ThreadHideFromDebugger: u32 = 17;

type NTSTATUS = i32;

#[repr(C)]
struct PROCESS_BASIC_INFORMATION {
    ExitStatus: NTSTATUS,
    PebBaseAddress: *mut c_void,
    AffinityMask: usize,
    BasePriority: i32,
    UniqueProcessId: usize,
    InheritedFromUniqueProcessId: usize,
}

use crate::syscall::{NtQueryInformationProcess, NtSetInformationThread};

#[inline]
fn nt_success(s: NTSTATUS) -> bool {
    s >= 0
}

// ─── 公开 API ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub struct DebugIndicator {
    pub kind: ViolationKind,
}

pub fn quick_check() -> Option<DebugIndicator> {
    // 优先检查 §B9 TLS 早期命中标志,无任何 syscall 开销
    #[cfg(target_arch = "x86_64")]
    {
        let v = crate::tls_callback::EARLY_HIT.load(core::sync::atomic::Ordering::Acquire);
        if v != 0 {
            return Some(DebugIndicator { kind: ViolationKind::TlsEarlyDebugger });
        }
    }
    unsafe {
        if IsDebuggerPresent() != 0 {
            return Some(DebugIndicator { kind: ViolationKind::Debugger });
        }
        let mut present: BOOL = 0;
        let _ = CheckRemoteDebuggerPresent(GetCurrentProcess(), &mut present);
        if present != 0 {
            return Some(DebugIndicator { kind: ViolationKind::Debugger });
        }
        // ProcessDebugPort
        let mut port: usize = 0;
        let mut ret: u32 = 0;
        let st = NtQueryInformationProcess(
            GetCurrentProcess(),
            ProcessDebugPort,
            &mut port as *mut _ as *mut c_void,
            core::mem::size_of::<usize>() as u32,
            &mut ret,
        );
        if nt_success(st) && port != 0 {
            return Some(DebugIndicator { kind: ViolationKind::Debugger });
        }
    }
    None
}

pub fn deep_check() -> Option<DebugIndicator> {
    if let Some(ind) = quick_check() {
        return Some(ind);
    }
    unsafe {
        // ProcessDebugObjectHandle
        let mut handle: HANDLE = null_mut();
        let mut ret: u32 = 0;
        let st = NtQueryInformationProcess(
            GetCurrentProcess(),
            ProcessDebugObjectHandle,
            &mut handle as *mut _ as *mut c_void,
            core::mem::size_of::<HANDLE>() as u32,
            &mut ret,
        );
        if nt_success(st) && !handle.is_null() {
            CloseHandle(handle);
            return Some(DebugIndicator { kind: ViolationKind::Debugger });
        }
        // ProcessDebugFlags == 0 → 调试中
        let mut flags: u32 = 0;
        let st = NtQueryInformationProcess(
            GetCurrentProcess(),
            ProcessDebugFlags,
            &mut flags as *mut _ as *mut c_void,
            core::mem::size_of::<u32>() as u32,
            &mut ret,
        );
        if nt_success(st) && flags == 0 {
            return Some(DebugIndicator { kind: ViolationKind::Debugger });
        }
    }
    if let Some(ind) = check_peb_flags() {
        return Some(ind);
    }
    None
}

unsafe fn read_peb_addr() -> Option<usize> {
    let mut pbi = core::mem::MaybeUninit::<PROCESS_BASIC_INFORMATION>::zeroed();
    let mut ret: u32 = 0;
    let st = unsafe {
        NtQueryInformationProcess(
            GetCurrentProcess(),
            ProcessBasicInformation,
            pbi.as_mut_ptr() as *mut c_void,
            core::mem::size_of::<PROCESS_BASIC_INFORMATION>() as u32,
            &mut ret,
        )
    };
    if !nt_success(st) {
        return None;
    }
    let pbi = unsafe { pbi.assume_init() };
    Some(pbi.PebBaseAddress as usize)
}

fn check_peb_flags() -> Option<DebugIndicator> {
    unsafe {
        let peb = read_peb_addr()?;
        if peb == 0 {
            return None;
        }
        // BeingDebugged @ PEB+0x02
        let being = core::ptr::read_volatile((peb + 0x02) as *const u8);
        if being != 0 {
            return Some(DebugIndicator { kind: ViolationKind::PebFlag });
        }
        // NtGlobalFlag @ PEB+0xBC (x64)
        let ngf = core::ptr::read_volatile((peb + 0xBC) as *const u32);
        if (ngf & 0x70) != 0 {
            return Some(DebugIndicator { kind: ViolationKind::PebFlag });
        }
        // ProcessHeap @ PEB+0x30 (x64); Heap.Flags @ +0x70, ForceFlags @ +0x74
        let heap = core::ptr::read_volatile((peb + 0x30) as *const usize);
        if heap != 0 {
            let f = core::ptr::read_volatile((heap + 0x70) as *const u32);
            let ff = core::ptr::read_volatile((heap + 0x74) as *const u32);
            if (f & !2) != 0 || ff != 0 {
                return Some(DebugIndicator { kind: ViolationKind::HeapFlag });
            }
        }
    }
    None
}

/// 对当前进程内的所有线程设置 `ThreadHideFromDebugger`。
pub fn install_hide_from_debugger_all() {
    unsafe {
        let pid = GetCurrentProcessId();
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snap.is_null() || snap as isize == -1 {
            return;
        }
        let mut entry = THREADENTRY32 {
            dwSize: core::mem::size_of::<THREADENTRY32>() as DWORD,
            ..Default::default()
        };
        if Thread32First(snap, &mut entry) != 0 {
            loop {
                if entry.th32OwnerProcessID == pid {
                    let h = OpenThread(THREAD_SET_INFORMATION, 0, entry.th32ThreadID);
                    if !h.is_null() && (h as isize) != -1 {
                        let _ = NtSetInformationThread(h, ThreadHideFromDebugger, null_mut(), 0);
                        CloseHandle(h);
                    }
                }
                if Thread32Next(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        let _ = GetCurrentThread();
    }
}
