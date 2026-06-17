//! §B13 PEB Loader 三链交叉 + 内存映像差集校验。
//!
//! 攻击者注入器为隐藏自身常做两件事:
//!   1. 从 `PEB->Ldr->InLoadOrder/InMemoryOrder/InInitializationOrder` 链表中
//!      unlink 自己;
//!   2. 走 `NtMapViewOfSection` + 手动重定位实现 manual map,完全不走 Loader。
//!
//! 三条链应当含完全相同 `LDR_DATA_TABLE_ENTRY` 集合;再用 `VirtualQuery`
//! 枚举地址空间所有 `MEM_IMAGE` 区,与三链取并集做差集即可识别。
//!
//! 周期 19±5s。

#![cfg(target_os = "windows")]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use core::ffi::c_void;
use core::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use rand::{Rng, thread_rng};

use crate::event::{ViolationEvent, ViolationKind, emit_violation, kill_self};
use crate::policy::{PolicyConfig, exit_code};

type DWORD = u32;
type HMODULE = *mut c_void;
type HANDLE = *mut c_void;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> HANDLE;
    fn VirtualQuery(
        lpAddress: *const c_void,
        lpBuffer: *mut MEMORY_BASIC_INFORMATION,
        dwLength: usize,
    ) -> usize;
}

#[repr(C)]
struct LIST_ENTRY {
    Flink: *mut LIST_ENTRY,
    Blink: *mut LIST_ENTRY,
}

#[repr(C)]
struct UNICODE_STRING {
    Length: u16,
    MaximumLength: u16,
    Buffer: *mut u16,
}

#[repr(C)]
struct LDR_DATA_TABLE_ENTRY_PARTIAL {
    InLoadOrderLinks: LIST_ENTRY,
    InMemoryOrderLinks: LIST_ENTRY,
    InInitializationOrderLinks: LIST_ENTRY,
    DllBase: *mut c_void,
    EntryPoint: *mut c_void,
    SizeOfImage: u32,
    FullDllName: UNICODE_STRING,
    BaseDllName: UNICODE_STRING,
    // 后续字段忽略
}

#[repr(C)]
struct PEB_LDR_DATA_PARTIAL {
    Length: u32,
    Initialized: u8,
    _pad1: [u8; 3],
    SsHandle: *mut c_void,
    InLoadOrderModuleList: LIST_ENTRY,
    InMemoryOrderModuleList: LIST_ENTRY,
    InInitializationOrderModuleList: LIST_ENTRY,
}

#[repr(C)]
struct PEB_PARTIAL {
    InheritedAddressSpace: u8,
    ReadImageFileExecOptions: u8,
    BeingDebugged: u8,
    BitField: u8,
    _padding0: [u8; 4],
    Mutant: *mut c_void,
    ImageBaseAddress: *mut c_void,
    Ldr: *mut PEB_LDR_DATA_PARTIAL,
    // ...
}

#[repr(C)]
struct MEMORY_BASIC_INFORMATION {
    BaseAddress: *mut c_void,
    AllocationBase: *mut c_void,
    AllocationProtect: u32,
    PartitionId: u16,
    _pad: u16,
    RegionSize: usize,
    State: u32,
    Protect: u32,
    Type: u32,
}

const MEM_COMMIT: u32 = 0x00001000;
const MEM_IMAGE: u32 = 0x01000000;

#[inline]
unsafe fn get_peb() -> *mut PEB_PARTIAL {
    #[cfg(target_arch = "x86_64")]
    unsafe {
        let p: *mut PEB_PARTIAL;
        core::arch::asm!(
            "mov {0}, gs:[0x60]",
            out(reg) p,
            options(nostack, preserves_flags, readonly),
        );
        p
    }
    #[cfg(not(target_arch = "x86_64"))]
    unsafe { core::ptr::null_mut() }
}

#[derive(Default)]
struct Snapshot {
    last_check_ms: AtomicU64,
    anomalies: AtomicU32,
}

static SNAPSHOT: once_cell::sync::Lazy<Arc<Snapshot>> =
    once_cell::sync::Lazy::new(|| Arc::new(Snapshot::default()));

#[inline]
pub fn anomalies() -> u32 {
    SNAPSHOT.anomalies.load(Ordering::Relaxed)
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

/// 走单条链(从 head.Flink 开始,以 head 为终止哨兵),收集 DllBase。
unsafe fn walk_one(
    head: *mut LIST_ENTRY,
    field_offset: usize, // 链 head 在 LDR_DATA_TABLE_ENTRY 中的字节偏移(决定 CONTAINING_RECORD)
) -> HashSet<usize> {
    let mut set = HashSet::new();
    if head.is_null() {
        return set;
    }
    let mut cur = unsafe { (*head).Flink };
    let mut count = 0usize;
    while !cur.is_null() && cur != head && count < 4096 {
        // CONTAINING_RECORD: entry = cur - field_offset
        let entry =
            (cur as usize).wrapping_sub(field_offset) as *const LDR_DATA_TABLE_ENTRY_PARTIAL;
        if !entry.is_null() {
            let base = unsafe { (*entry).DllBase } as usize;
            if base != 0 {
                set.insert(base);
            }
        }
        cur = unsafe { (*cur).Flink };
        count += 1;
    }
    set
}

unsafe fn walk_loader_chains() -> (HashSet<usize>, HashSet<usize>, HashSet<usize>) {
    let peb = unsafe { get_peb() };
    if peb.is_null() {
        return Default::default();
    }
    let ldr = unsafe { (*peb).Ldr };
    if ldr.is_null() {
        return Default::default();
    }
    // LDR_DATA_TABLE_ENTRY_PARTIAL 中三条链的偏移:0, 16, 32(LIST_ENTRY 16 字节 on x64)
    let in_load = unsafe { walk_one(&mut (*ldr).InLoadOrderModuleList, 0) };
    let in_mem = unsafe { walk_one(&mut (*ldr).InMemoryOrderModuleList, 16) };
    let in_init = unsafe { walk_one(&mut (*ldr).InInitializationOrderModuleList, 32) };
    (in_load, in_mem, in_init)
}

unsafe fn enumerate_image_bases() -> HashSet<usize> {
    let mut set = HashSet::new();
    let mut addr: usize = 0;
    let mut steps = 0usize;
    while steps < 0x10_000 {
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
        if info.State == MEM_COMMIT && info.Type == MEM_IMAGE {
            set.insert(info.AllocationBase as usize);
        }
        let next = (info.BaseAddress as usize).saturating_add(info.RegionSize);
        if next <= addr {
            break;
        }
        addr = next;
        steps += 1;
        // 上限:用户态 0x7fff_ffff_ffff
        if addr > 0x0000_7FFF_FFFF_FFFF {
            break;
        }
    }
    set
}

fn run_one_round() {
    unsafe {
        let (a, b, c) = walk_loader_chains();
        if a.is_empty() && b.is_empty() && c.is_empty() {
            return;
        }
        // unlink 检测:三链取交集 vs 任一链
        let union3: HashSet<usize> = a.union(&b).copied().collect::<HashSet<_>>()
            .union(&c)
            .copied()
            .collect();

        // 缺一即认为某链被 unlink(允许极少量并发更新窗口,要求 ≥ 2 条链同名才视为正常)
        for base in &union3 {
            let in_a = a.contains(base);
            let in_b = b.contains(base);
            let in_c = c.contains(base);
            let presence = in_a as u32 + in_b as u32 + in_c as u32;
            if presence < 2 {
                SNAPSHOT.anomalies.fetch_add(1, Ordering::Relaxed);
                emit_violation(ViolationEvent::new(
                    ViolationKind::UnlinkedModule,
                    format!("base=0x{:x} loadOrder={} memOrder={} initOrder={}",
                        *base, in_a, in_b, in_c),
                ));
            }
        }

        // manual map 检测:地址空间 MEM_IMAGE 区差集
        let images = enumerate_image_bases();
        for base in &images {
            if !union3.contains(base) {
                SNAPSHOT.anomalies.fetch_add(1, Ordering::Relaxed);
                emit_violation(ViolationEvent::new(
                    ViolationKind::ManualMappedModule,
                    format!("base=0x{:x}", *base),
                ));
            }
        }
    }
}

pub fn start(cfg: &PolicyConfig) {
    if !cfg.module_audit {
        return;
    }
    let kill = cfg.kill_on_violation;
    std::thread::Builder::new()
        .name("self-protect/module-audit".into())
        .spawn(move || {
            // 启动后稍延 4s,避开主程序模块加载完毕前的并发窗口
            std::thread::sleep(Duration::from_secs(4));
            let mut rng = thread_rng();
            let mut prev_anomalies = 0u32;
            loop {
                run_one_round();
                SNAPSHOT.last_check_ms.store(now_ms(), Ordering::Relaxed);
                let cur = SNAPSHOT.anomalies.load(Ordering::Relaxed);
                if cur > prev_anomalies {
                    kill_self(exit_code::MANUAL_MAP, kill);
                    return;
                }
                let jitter = rng.gen_range(0..10_000);
                std::thread::sleep(Duration::from_millis(17_000 + jitter));
            }
        })
        .ok();
}
