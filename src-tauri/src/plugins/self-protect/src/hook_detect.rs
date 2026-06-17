//! §B11 + §B17 ntdll / ETW 写入侧 hook 检测。
//!
//! 思路:从 `\KnownDlls\ntdll.dll` 取磁盘干净映射,与运行时 `ntdll.dll`
//! 关心导出的首 16 字节比对;不一致即视为内联 hook。
//!
//! 命中即上报 + `TerminateProcess`(默认 release 开;debug 关)。
//!
//! 周期 17±5s。watchdog 监督本模块心跳;若心跳超过 30s 视为本模块自身被
//! patch,直接以 `SYSCALL_HOOK` 退出码自杀。

#![cfg(target_os = "windows")]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use core::ffi::c_void;
use core::ptr::null_mut;
use core::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rand::{Rng, thread_rng};

use crate::event::{ViolationEvent, ViolationKind, emit_violation, kill_self};
use crate::obf;
use crate::policy::{PolicyConfig, exit_code};

type DWORD = u32;
type HMODULE = *mut c_void;
type FARPROC = *mut c_void;
type NTSTATUS = i32;
type HANDLE = *mut c_void;

const SECTION_MAP_READ: u32 = 0x0004;
const VIEW_SHARE: u32 = 0;
const PAGE_READONLY: u32 = 0x02;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleA(name: *const u8) -> HMODULE;
    fn GetProcAddress(h: HMODULE, name: *const u8) -> FARPROC;
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtOpenSection(
        section_handle: *mut HANDLE,
        desired_access: u32,
        object_attributes: *const OBJECT_ATTRIBUTES,
    ) -> NTSTATUS;
    fn NtMapViewOfSection(
        section: HANDLE,
        process: HANDLE,
        base: *mut *mut c_void,
        zero_bits: usize,
        commit_size: usize,
        section_offset: *mut i64,
        view_size: *mut usize,
        inherit_disposition: u32,
        allocation_type: u32,
        win32_protect: u32,
    ) -> NTSTATUS;
    fn NtUnmapViewOfSection(process: HANDLE, base: *mut c_void) -> NTSTATUS;
    fn NtClose(h: HANDLE) -> NTSTATUS;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> HANDLE;
}

#[repr(C)]
struct UNICODE_STRING {
    Length: u16,
    MaximumLength: u16,
    Buffer: *mut u16,
}

#[repr(C)]
struct OBJECT_ATTRIBUTES {
    Length: u32,
    RootDirectory: HANDLE,
    ObjectName: *const UNICODE_STRING,
    Attributes: u32,
    SecurityDescriptor: *const c_void,
    SecurityQualityOfService: *const c_void,
}

const OBJ_CASE_INSENSITIVE: u32 = 0x40;

#[inline]
fn nt_success(s: NTSTATUS) -> bool {
    s >= 0
}

/// 通过 KnownDlls 获取磁盘干净映射(只读、共享)。返回基地址与视图大小。
unsafe fn map_known_dll(mut name: Vec<u16>) -> Option<(*mut c_void, usize)> {
    let us_len = ((name.len() - 1) * 2) as u16; // 不含末尾 0
    let us = UNICODE_STRING {
        Length: us_len,
        MaximumLength: us_len + 2,
        Buffer: name.as_mut_ptr(),
    };
    let oa = OBJECT_ATTRIBUTES {
        Length: core::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: null_mut(),
        ObjectName: &us,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: core::ptr::null(),
        SecurityQualityOfService: core::ptr::null(),
    };

    let mut sec: HANDLE = null_mut();
    let st = unsafe { NtOpenSection(&mut sec, SECTION_MAP_READ, &oa) };
    if !nt_success(st) || sec.is_null() {
        return None;
    }

    let mut base: *mut c_void = null_mut();
    let mut view_size: usize = 0;
    let st = unsafe {
        NtMapViewOfSection(
            sec,
            GetCurrentProcess(),
            &mut base,
            0,
            0,
            core::ptr::null_mut(),
            &mut view_size,
            VIEW_SHARE,
            0,
            PAGE_READONLY,
        )
    };
    unsafe { NtClose(sec) };
    if !nt_success(st) || base.is_null() {
        return None;
    }
    Some((base, view_size))
}

#[inline]
unsafe fn map_clean_ntdll() -> Option<(*mut c_void, usize)> {
    unsafe { map_known_dll(obf::known_dll_ntdll_utf16()) }
}

#[inline]
unsafe fn map_clean_kernelbase() -> Option<(*mut c_void, usize)> {
    unsafe { map_known_dll(obf::known_dll_kernelbase_utf16()) }
}

#[inline]
unsafe fn map_clean_kernel32() -> Option<(*mut c_void, usize)> {
    unsafe { map_known_dll(obf::known_dll_kernel32_utf16()) }
}

/// 解析 PE 的导出表,返回 ASCII name → RVA 的 hashmap。
unsafe fn parse_export_table(image_base: *const u8) -> Option<std::collections::HashMap<Vec<u8>, u32>> {
    use std::collections::HashMap;
    unsafe {
        let e_lfanew = core::ptr::read_unaligned(image_base.add(0x3C) as *const u32) as usize;
        let nt = image_base.add(e_lfanew);
        // IMAGE_NT_HEADERS64: Signature(4) + FileHeader(20) + OptionalHeader(...)
        // OptionalHeader.DataDirectory[0] = Export, 偏移 += 24 + 112 = 136(对 PE32+)。
        // OptionalHeader.Magic at +24 决定 32/64;只支持 64 位。
        let magic = core::ptr::read_unaligned(nt.add(24) as *const u16);
        if magic != 0x20B {
            return None;
        }
        let export_dir_rva =
            core::ptr::read_unaligned(nt.add(24 + 112) as *const u32) as usize;
        let export_dir_size =
            core::ptr::read_unaligned(nt.add(24 + 112 + 4) as *const u32) as usize;
        if export_dir_rva == 0 || export_dir_size == 0 {
            return None;
        }
        let exp = image_base.add(export_dir_rva);
        let num_names = core::ptr::read_unaligned(exp.add(24) as *const u32) as usize;
        let funcs_rva = core::ptr::read_unaligned(exp.add(28) as *const u32) as usize;
        let names_rva = core::ptr::read_unaligned(exp.add(32) as *const u32) as usize;
        let ords_rva = core::ptr::read_unaligned(exp.add(36) as *const u32) as usize;
        let names_table = image_base.add(names_rva) as *const u32;
        let ords_table = image_base.add(ords_rva) as *const u16;
        let funcs_table = image_base.add(funcs_rva) as *const u32;

        let mut map = HashMap::with_capacity(num_names);
        for i in 0..num_names {
            let name_rva = core::ptr::read_unaligned(names_table.add(i)) as usize;
            let name_ptr = image_base.add(name_rva);
            let mut len = 0usize;
            while *name_ptr.add(len) != 0 && len < 256 {
                len += 1;
            }
            let name_bytes = core::slice::from_raw_parts(name_ptr, len).to_vec();
            let ord = core::ptr::read_unaligned(ords_table.add(i)) as usize;
            let func_rva = core::ptr::read_unaligned(funcs_table.add(ord));
            map.insert(name_bytes, func_rva);
        }
        Some(map)
    }
}

#[derive(Default)]
struct Snapshot {
    last_check_ms: AtomicU64,
    alerts: AtomicU32,
}

#[inline]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

static SNAPSHOT: once_cell::sync::Lazy<Arc<Snapshot>> =
    once_cell::sync::Lazy::new(|| Arc::new(Snapshot::default()));

#[inline]
pub fn alerts() -> u32 {
    SNAPSHOT.alerts.load(Ordering::Relaxed)
}

#[inline]
pub fn last_heartbeat_ms() -> u64 {
    SNAPSHOT.last_check_ms.load(Ordering::Relaxed)
}

/// 一个待检测目标:活体模块 + 干净 KnownDlls 镜像 + 关心导出列表 + 命中归类。
struct Target {
    live_name: &'static [u8],         // ASCII zero-terminated
    clean_loader: unsafe fn() -> Option<(*mut c_void, usize)>,
    exports: Vec<Vec<u8>>,
    kind_default: ViolationKind,      // ntdll → SyscallHooked; kernelbase → KernelbaseHooked; kernel32 → Kernel32Hooked
}

/// IFH(Import Forwarding Hint)合法跳板识别:`48 ff 25 ?? ?? ?? ??`
/// 即 `jmp qword ptr [rip+disp32]`,常被 Windows 自身用于跨 dll 转发。
/// 只要 live 端首字节匹配 `48 ff 25` 视为合法 forwarding,放过。
fn is_legit_forwarder(live_bytes: &[u8]) -> bool {
    live_bytes.len() >= 7 && live_bytes[0] == 0x48 && live_bytes[1] == 0xFF && live_bytes[2] == 0x25
}

fn run_target(t: &Target) -> usize {
    // 准备活体模块
    let live = unsafe { GetModuleHandleA(t.live_name.as_ptr()) };
    if live.is_null() {
        return 0;
    }
    // 准备干净副本
    let Some((clean_base, _view_size)) = (unsafe { (t.clean_loader)() }) else {
        return 0;
    };

    let live_exports = unsafe { parse_export_table(live as *const u8) }.unwrap_or_default();
    let clean_exports = unsafe { parse_export_table(clean_base as *const u8) }.unwrap_or_default();

    let mut hits = 0usize;
    for name in &t.exports {
        let live_rva = match live_exports.get(name) {
            Some(v) => *v as usize,
            None => continue,
        };
        let clean_rva = match clean_exports.get(name) {
            Some(v) => *v as usize,
            None => continue,
        };
        let live_ptr = unsafe { (live as *const u8).add(live_rva) };
        let clean_ptr = unsafe { (clean_base as *const u8).add(clean_rva) };
        let n = 16;
        let live_bytes = unsafe { core::slice::from_raw_parts(live_ptr, n) };
        let clean_bytes = unsafe { core::slice::from_raw_parts(clean_ptr, n) };
        if live_bytes != clean_bytes {
            // 合法跳板放过(kernel32 → kernelbase / kernelbase → ntdll 的转发)
            if is_legit_forwarder(live_bytes) {
                continue;
            }
            hits += 1;
            // ntdll 目标:进一步区分 ETW patch 与一般 syscall hook
            let kind = if t.kind_default == ViolationKind::SyscallHooked {
                if obf::etw_exports_ascii().iter().any(|e| e == name) {
                    ViolationKind::EtwPatched
                } else {
                    ViolationKind::SyscallHooked
                }
            } else {
                t.kind_default
            };
            let detail = format!(
                "module={} export={} live=[{:02X?}] clean=[{:02X?}]",
                String::from_utf8_lossy(&t.live_name[..t.live_name.len().saturating_sub(1)]),
                String::from_utf8_lossy(name),
                &live_bytes[..8],
                &clean_bytes[..8]
            );
            emit_violation(ViolationEvent::new(kind, detail));
        }
    }

    let _ = unsafe { NtUnmapViewOfSection(GetCurrentProcess(), clean_base) };
    hits
}

fn run_one_round(check_etw: bool) -> usize {
    run_one_round_full(check_etw, false)
}

fn run_one_round_full(check_etw: bool, check_kernelbase: bool) -> usize {
    // ntdll(始终):合并 ETW 名单
    let mut ntdll_exports = obf::ntdll_exports_ascii();
    if check_etw {
        ntdll_exports.extend(obf::etw_exports_ascii());
    }
    let mut targets: Vec<Target> = vec![Target {
        live_name: b"ntdll.dll\0",
        clean_loader: map_clean_ntdll,
        exports: ntdll_exports,
        kind_default: ViolationKind::SyscallHooked,
    }];

    if check_kernelbase {
        targets.push(Target {
            live_name: b"kernelbase.dll\0",
            clean_loader: map_clean_kernelbase,
            exports: obf::kernelbase_exports_ascii(),
            kind_default: ViolationKind::KernelbaseHooked,
        });
        targets.push(Target {
            live_name: b"kernel32.dll\0",
            clean_loader: map_clean_kernel32,
            exports: obf::kernel32_exports_ascii(),
            kind_default: ViolationKind::Kernel32Hooked,
        });
    }

    let mut hits = 0usize;
    for t in &targets {
        hits += run_target(t);
    }
    hits
}

pub fn start(cfg: &PolicyConfig) {
    if !cfg.hook_detect {
        return;
    }
    let kill = cfg.kill_on_violation;
    let check_etw = cfg.etw_check;
    let check_kernelbase = cfg.kernelbase_hook_detect;
    std::thread::Builder::new()
        .name("self-protect/hook-detect".into())
        .spawn(move || {
            let mut rng = thread_rng();
            loop {
                let hits = run_one_round_full(check_etw, check_kernelbase);
                SNAPSHOT.last_check_ms.store(now_ms(), Ordering::Relaxed);
                if hits > 0 {
                    SNAPSHOT.alerts.fetch_add(hits as u32, Ordering::Relaxed);
                    kill_self(exit_code::SYSCALL_HOOK, kill);
                    return;
                }
                let jitter = rng.gen_range(0..10_000);
                std::thread::sleep(Duration::from_millis(15_000 + jitter));
                let _ = null_mut::<u8>();
            }
        })
        .ok();
}

/// QA 命令调用,立即重扫一次。
pub fn force_recheck(check_etw: bool, check_kernelbase: bool) -> usize {
    run_one_round_full(check_etw, check_kernelbase)
}
