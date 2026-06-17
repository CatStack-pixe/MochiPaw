//! 句柄扫描:发现别的进程握着指向自己的高权限句柄(如 CE 的 PROCESS_VM_WRITE)。

#![cfg(target_os = "windows")]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use core::ffi::c_void;
use core::ptr::null_mut;
use std::time::Duration;

use rand::{Rng, thread_rng};

use crate::event::{ViolationEvent, ViolationKind, emit_violation, kill_self};
use crate::policy::{PolicyConfig, exit_code};

type BOOL = i32;
type DWORD = u32;
type HANDLE = *mut c_void;
type NTSTATUS = i32;

const STATUS_INFO_LENGTH_MISMATCH: NTSTATUS = 0xC000_0004u32 as NTSTATUS;
const SystemExtendedHandleInformation: u32 = 0x40;
const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;
const PROCESS_QUERY_INFORMATION: DWORD = 0x0400;

const PROCESS_VM_OPERATION: u32 = 0x0008;
const PROCESS_VM_READ: u32 = 0x0010;
const PROCESS_VM_WRITE: u32 = 0x0020;
const PROCESS_DUP_HANDLE: u32 = 0x0040;
const PROCESS_CREATE_THREAD: u32 = 0x0002;

const SUSPICIOUS_MASK: u32 = PROCESS_VM_OPERATION
    | PROCESS_VM_READ
    | PROCESS_VM_WRITE
    | PROCESS_DUP_HANDLE
    | PROCESS_CREATE_THREAD;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcessId() -> DWORD;
    fn OpenProcess(access: DWORD, inherit: BOOL, pid: DWORD) -> HANDLE;
    fn CloseHandle(h: HANDLE) -> BOOL;
    fn QueryFullProcessImageNameW(
        h: HANDLE,
        flags: DWORD,
        lpExeName: *mut u16,
        lpdwSize: *mut DWORD,
    ) -> BOOL;
}

// §B10 Nt* 走集中通道(syscall.rs)。运行期解析,便于将来切回 Hell's Gate 直接 syscall。
use crate::syscall::NtQuerySystemInformation;

#[inline]
fn nt_success(s: NTSTATUS) -> bool {
    s >= 0
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SystemHandleEntry {
    object: *mut c_void,
    unique_process_id: usize,
    handle_value: usize,
    granted_access: u32,
    creator_back_trace_index: u16,
    object_type_index: u16,
    handle_attributes: u32,
    reserved: u32,
}

unsafe fn query_handles() -> Option<Vec<u8>> {
    let mut size: u32 = 1024 * 1024;
    let cap_max: u32 = 256 * 1024 * 1024;
    loop {
        let mut buf = vec![0u8; size as usize];
        let mut ret_len: u32 = 0;
        let st = unsafe {
            NtQuerySystemInformation(
                SystemExtendedHandleInformation,
                buf.as_mut_ptr() as *mut c_void,
                size,
                &mut ret_len,
            )
        };
        if nt_success(st) {
            return Some(buf);
        }
        if st == STATUS_INFO_LENGTH_MISMATCH {
            let next = size.saturating_mul(2);
            if next > cap_max {
                return None;
            }
            size = next;
            continue;
        }
        return None;
    }
}

unsafe fn parse_handles(buf: &[u8]) -> Option<&[SystemHandleEntry]> {
    if buf.len() < core::mem::size_of::<usize>() * 2 {
        return None;
    }
    let count = unsafe { core::ptr::read_unaligned(buf.as_ptr() as *const usize) };
    let entry_size = core::mem::size_of::<SystemHandleEntry>();
    let total = core::mem::size_of::<usize>() * 2 + count * entry_size;
    if total > buf.len() {
        return None;
    }
    let head = unsafe { buf.as_ptr().add(core::mem::size_of::<usize>() * 2) };
    let entries = unsafe { core::slice::from_raw_parts(head as *const SystemHandleEntry, count) };
    Some(entries)
}

unsafe fn cache_self_object_and_type() -> Option<(usize, u16)> {
    let buf = unsafe { query_handles()? };
    let entries = unsafe { parse_handles(&buf)? };
    let pid = unsafe { GetCurrentProcessId() } as usize;
    // `GetCurrentProcess()` 返回 -1 伪句柄,不会稳定出现在系统句柄表中。
    // 这里打开一个真实本进程句柄,用其 handle value 反查 object/type。
    let real_handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_QUERY_INFORMATION,
            0,
            pid as DWORD,
        )
    };
    if real_handle.is_null() {
        return None;
    }
    let hv = real_handle as usize;
    let mut out = None;
    for e in entries {
        if e.unique_process_id == pid && e.handle_value == hv {
            out = Some((e.object as usize, e.object_type_index));
            break;
        }
    }
    unsafe { CloseHandle(real_handle) };
    out
}

fn process_image_name(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 1024];
        let mut size: u32 = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(h);
        if ok == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..size as usize]))
    }
}

pub fn start(cfg: &PolicyConfig) {
    if !cfg.handle_scan {
        return;
    }
    let kill = cfg.kill_on_violation;

    let Some((self_obj_addr, self_type_index)) = (unsafe { cache_self_object_and_type() }) else {
        return;
    };

    std::thread::Builder::new()
        .name("self-protect/handle-scan".into())
        .spawn(move || {
            let mut rng = thread_rng();
            let self_pid = unsafe { GetCurrentProcessId() } as usize;
            loop {
                if let Some(buf) = unsafe { query_handles() } {
                    if let Some(entries) = unsafe { parse_handles(&buf) } {
                        for e in entries {
                            if e.unique_process_id == self_pid {
                                continue;
                            }
                            if e.object_type_index != self_type_index {
                                continue;
                            }
                            if e.object as usize != self_obj_addr {
                                continue;
                            }
                            if e.granted_access & SUSPICIOUS_MASK == 0 {
                                continue;
                            }
                            let owner_pid = e.unique_process_id as u32;
                            let image = process_image_name(owner_pid)
                                .unwrap_or_else(|| "<unknown>".to_string());
                            emit_violation(ViolationEvent::new(
                                ViolationKind::ForeignHandle,
                                format!(
                                    "pid={} access=0x{:X} image={}",
                                    owner_pid, e.granted_access, image
                                ),
                            ));
                            kill_self(exit_code::FOREIGN_HANDLE, kill);
                            return;
                        }
                    }
                }
                let jitter = rng.gen_range(0..8_000);
                std::thread::sleep(Duration::from_millis(9_000 + jitter));
                let _ = null_mut::<u8>();
            }
        })
        .ok();
}
