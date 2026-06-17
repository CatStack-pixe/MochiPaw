//! §C19 RWX/可疑可执行私有内存区周期扫描。
//!
//! 反射 DLL 注入 / shellcode 注入的共同特征:在目标进程中分配 `MEM_PRIVATE`
//! 提交且包含 `EXECUTE` 权限的页(典型 `PAGE_EXECUTE_READWRITE`)。本模块通过
//! `VirtualQuery` 整地址空间扫描这种区域,排除自身镜像(BongoCat 主进程不应
//! 当有 V8/JIT 等合法 RWX 用户),命中即报警 + 自杀。
//!
//! 周期 23±7s,与 §B11 / §B13 错峰。

#![cfg(target_os = "windows")]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use core::ffi::c_void;
use core::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rand::{Rng, thread_rng};

use crate::event::{ViolationEvent, ViolationKind, emit_violation, kill_self};
use crate::policy::{PolicyConfig, exit_code};

type HMODULE = *mut c_void;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleA(name: *const u8) -> HMODULE;
    fn VirtualQuery(
        lpAddress: *const c_void,
        lpBuffer: *mut MEMORY_BASIC_INFORMATION,
        dwLength: usize,
    ) -> usize;
}

#[repr(C)]
struct MEMORY_BASIC_INFORMATION {
    BaseAddress: *mut c_void,
    AllocationBase: *mut c_void,
    AllocationProtect: u32,
    PartitionId: u16,
    RegionSize: usize,
    State: u32,
    Protect: u32,
    Type: u32,
}

const MEM_COMMIT: u32 = 0x00001000;
const MEM_PRIVATE: u32 = 0x00020000;

// 任何包含 EXECUTE 位的 protect 都视为可疑(在 PRIVATE 区)
const PAGE_EXEC_MASK: u32 = 0xF0; // EXECUTE | EXECUTE_READ | EXECUTE_READWRITE | EXECUTE_WRITECOPY

const MIN_REGION: usize = 4 * 1024;        // < 4 KiB 跳过(可能是 CRT 内部 trampoline 缓存)
const MAX_REGION: usize = 64 * 1024 * 1024; // > 64 MiB 跳过(留给将来 V8/CEF;主进程不应有)

#[derive(Default)]
struct Snapshot {
    last_check_ms: AtomicU64,
    hits: AtomicU32,
}

static SNAPSHOT: once_cell::sync::Lazy<Arc<Snapshot>> =
    once_cell::sync::Lazy::new(|| Arc::new(Snapshot::default()));

#[inline]
pub fn hits() -> u32 {
    SNAPSHOT.hits.load(Ordering::Relaxed)
}

#[inline]
pub fn last_heartbeat_ms() -> u64 {
    SNAPSHOT.last_check_ms.load(Ordering::Relaxed)
}

#[inline]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// 取自身可执行映像的 `[base, base + SizeOfImage)` 范围。
unsafe fn self_image_range() -> Option<(usize, usize)> {
    unsafe {
        let h = GetModuleHandleA(core::ptr::null());
        if h.is_null() {
            return None;
        }
        let base = h as *const u8;
        let e_lfanew = core::ptr::read_unaligned(base.add(0x3C) as *const u32) as usize;
        let nt = base.add(e_lfanew);
        // OptionalHeader.SizeOfImage 在 PE32+ 偏移 24 + 56 = 80。
        let size = core::ptr::read_unaligned(nt.add(24 + 56) as *const u32) as usize;
        Some((h as usize, h as usize + size))
    }
}

fn run_one_round(self_range: Option<(usize, usize)>) -> usize {
    let mut hits = 0usize;
    let mut addr: usize = 0;
    let upper: usize = 0x7fff_ffff_ffff;
    while addr < upper {
        let mut info: MEMORY_BASIC_INFORMATION = unsafe { core::mem::zeroed() };
        let n = unsafe {
            VirtualQuery(
                addr as *const c_void,
                &mut info,
                core::mem::size_of::<MEMORY_BASIC_INFORMATION>(),
            )
        };
        if n == 0 {
            break;
        }
        let region_size = info.RegionSize;
        let region_end = addr.saturating_add(region_size);

        // 命中条件:已提交 + 私有 + 含 EXECUTE 位
        let suspicious = info.State == MEM_COMMIT
            && info.Type == MEM_PRIVATE
            && (info.Protect & PAGE_EXEC_MASK) != 0;
        if suspicious {
            // 自身镜像区跳过
            let in_self = match self_range {
                Some((lo, hi)) => addr >= lo && addr < hi,
                None => false,
            };
            // 大小过滤
            if !in_self && region_size >= MIN_REGION && region_size <= MAX_REGION {
                hits += 1;
                let detail = format!(
                    "base=0x{:X} size=0x{:X} protect=0x{:X}",
                    info.BaseAddress as usize, region_size, info.Protect
                );
                emit_violation(ViolationEvent::new(ViolationKind::SuspiciousRwx, detail));
                // 命中即返回,由调用方决定是否 kill_self
                return hits;
            }
        }
        if region_end <= addr {
            break;
        }
        addr = region_end;
    }
    hits
}

pub fn start(cfg: &PolicyConfig) {
    if !cfg.rwx_scan {
        return;
    }
    let kill = cfg.kill_on_violation;
    let self_range = unsafe { self_image_range() };
    std::thread::Builder::new()
        .name("self-protect/rwx-scan".into())
        .spawn(move || {
            let mut rng = thread_rng();
            loop {
                let hits = run_one_round(self_range);
                SNAPSHOT.last_check_ms.store(now_ms(), Ordering::Relaxed);
                if hits > 0 {
                    SNAPSHOT.hits.fetch_add(hits as u32, Ordering::Relaxed);
                    kill_self(exit_code::RWX_SHELLCODE, kill);
                    return;
                }
                let jitter = rng.gen_range(0..14_000);
                std::thread::sleep(Duration::from_millis(16_000 + jitter));
            }
        })
        .ok();
}
