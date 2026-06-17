//! Toolhelp32 进程黑名单扫描。

#![cfg(target_os = "windows")]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use core::ffi::c_void;
use std::time::Duration;

use rand::{Rng, thread_rng};

use crate::event::{ViolationEvent, ViolationKind, emit_violation, kill_self};
use crate::obf;
use crate::policy::{PolicyConfig, exit_code};

type BOOL = i32;
type DWORD = u32;
type HANDLE = *mut c_void;

const TH32CS_SNAPPROCESS: DWORD = 0x0000_0002;
const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;
const INVALID_HANDLE_VALUE: isize = -1;

#[repr(C)]
#[derive(Clone, Copy)]
struct PROCESSENTRY32W {
    dwSize: DWORD,
    cntUsage: DWORD,
    th32ProcessID: DWORD,
    th32DefaultHeapID: usize,
    th32ModuleID: DWORD,
    cntThreads: DWORD,
    th32ParentProcessID: DWORD,
    pcPriClassBase: i32,
    dwFlags: DWORD,
    szExeFile: [u16; 260],
}

impl Default for PROCESSENTRY32W {
    fn default() -> Self {
        Self {
            dwSize: 0,
            cntUsage: 0,
            th32ProcessID: 0,
            th32DefaultHeapID: 0,
            th32ModuleID: 0,
            cntThreads: 0,
            th32ParentProcessID: 0,
            pcPriClassBase: 0,
            dwFlags: 0,
            szExeFile: [0; 260],
        }
    }
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateToolhelp32Snapshot(flags: DWORD, pid: DWORD) -> HANDLE;
    fn Process32FirstW(h: HANDLE, lppe: *mut PROCESSENTRY32W) -> BOOL;
    fn Process32NextW(h: HANDLE, lppe: *mut PROCESSENTRY32W) -> BOOL;
    fn CloseHandle(h: HANDLE) -> BOOL;
    fn GetCurrentProcessId() -> DWORD;
    fn OpenProcess(access: DWORD, inherit: BOOL, pid: DWORD) -> HANDLE;
    fn QueryFullProcessImageNameW(
        h: HANDLE,
        flags: DWORD,
        lpExeName: *mut u16,
        lpdwSize: *mut DWORD,
    ) -> BOOL;
}

const BLACKLIST_PLACEHOLDER: () = (); // §B16 黑名单运行期由 obf 解码,见 `start()`。

fn utf16_to_lower_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len]).to_lowercase()
}

fn process_full_image(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(h);
        if ok == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..size as usize]).to_lowercase())
    }
}

fn is_system_image(path: &str, sys_keywords: &[String]) -> bool {
    let p = path.to_ascii_lowercase();
    sys_keywords.iter().any(|k| p.contains(k.as_str()))
}

pub fn start(cfg: &PolicyConfig) {
    if !cfg.proc_scan {
        return;
    }
    let kill = cfg.kill_on_violation;
    std::thread::Builder::new()
        .name("self-protect/proc-scan".into())
        .spawn(move || {
            let self_pid = unsafe { GetCurrentProcessId() };
            let mut rng = thread_rng();
            // §B16 黑名单 / 系统目录关键字解码到栈,只在本闭包活
            let blacklist: Vec<String> = obf::proc_blacklist_lowercase();
            let sys_keywords: Vec<String> = obf::system_path_keywords_lowercase();
            loop {
                unsafe {
                    let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
                    if !snap.is_null() && (snap as isize) != INVALID_HANDLE_VALUE {
                        let mut entry = PROCESSENTRY32W {
                            dwSize: core::mem::size_of::<PROCESSENTRY32W>() as u32,
                            ..Default::default()
                        };
                        if Process32FirstW(snap, &mut entry) != 0 {
                            loop {
                                if entry.th32ProcessID != self_pid {
                                    let lname = utf16_to_lower_string(&entry.szExeFile);
                                    if blacklist.iter().any(|n| lname.contains(n.as_str())) {
                                        let path = process_full_image(entry.th32ProcessID)
                                            .unwrap_or_default();
                                        if !is_system_image(&path, &sys_keywords) {
                                            emit_violation(ViolationEvent::new(
                                                ViolationKind::SuspiciousProcess,
                                                format!(
                                                    "pid={} image={} (matched={})",
                                                    entry.th32ProcessID, path, lname
                                                ),
                                            ));
                                            CloseHandle(snap);
                                            kill_self(exit_code::SUSPICIOUS_PROCESS, kill);
                                            return;
                                        }
                                    }
                                }
                                if Process32NextW(snap, &mut entry) == 0 {
                                    break;
                                }
                            }
                        }
                        CloseHandle(snap);
                    }
                }
                let jitter = rng.gen_range(0..10_000);
                std::thread::sleep(Duration::from_millis(12_000 + jitter));
            }
        })
        .ok();
}
