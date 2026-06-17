//! §B15 PAGE_GUARD 蜜罐页 + VEH。
//!
//! 在两块 4 KiB 蜜罐页里放伪坐标/伪血量/装饰魔术数,加 `PAGE_GUARD`;
//! 安装 first-VEH 接 `STATUS_GUARD_PAGE_VIOLATION`。
//!
//! 命中策略:RIP 落在自身镜像 .text 范围 → 视为合法访问(如 DEP 优化器误读),
//! 重置 PAGE_GUARD 并继续;否则 → 上报并自杀。

#![cfg(target_os = "windows")]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use core::ffi::c_void;
use core::ptr::null_mut;
use core::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};

use rand::{Rng, RngCore, thread_rng};

use crate::event::{ViolationEvent, ViolationKind, emit_violation, kill_self};
use crate::policy::{PolicyConfig, exit_code};

type DWORD = u32;
type BOOL = i32;
type NTSTATUS = i32;
type HANDLE = *mut c_void;

const PAGE_READWRITE: u32 = 0x04;
const PAGE_GUARD: u32 = 0x100;
const MEM_COMMIT: u32 = 0x00001000;
const MEM_RESERVE: u32 = 0x00002000;
const MEM_RELEASE: u32 = 0x00008000;

const STATUS_GUARD_PAGE_VIOLATION: u32 = 0x80000001;
const EXCEPTION_CONTINUE_EXECUTION: i32 = -1;
const EXCEPTION_CONTINUE_SEARCH: i32 = 0;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn VirtualAlloc(
        lpAddress: *mut c_void,
        dwSize: usize,
        flAllocationType: u32,
        flProtect: u32,
    ) -> *mut c_void;
    fn VirtualFree(lpAddress: *mut c_void, dwSize: usize, dwFreeType: u32) -> BOOL;
    fn VirtualProtect(
        lpAddress: *mut c_void,
        dwSize: usize,
        flNewProtect: u32,
        lpflOldProtect: *mut u32,
    ) -> BOOL;
    fn GetModuleHandleW(name: *const u16) -> *mut c_void;
    fn AddVectoredExceptionHandler(
        First: u32,
        Handler: extern "system" fn(*mut EXCEPTION_POINTERS) -> i32,
    ) -> *mut c_void;
}

#[repr(C)]
struct EXCEPTION_POINTERS {
    ExceptionRecord: *mut EXCEPTION_RECORD,
    ContextRecord: *mut CONTEXT,
}

#[repr(C)]
struct EXCEPTION_RECORD {
    ExceptionCode: u32,
    ExceptionFlags: u32,
    ExceptionRecord: *mut EXCEPTION_RECORD,
    ExceptionAddress: *mut c_void,
    NumberParameters: u32,
    ExceptionInformation: [usize; 15],
}

// 我们只用到 Rip(x86_64);CONTEXT 是大结构,粗略以 [u8; 4096] 占位,
// 通过 Rip 偏移读出。AMD64 CONTEXT.Rip 偏移为 0xF8。
#[repr(C, align(16))]
struct CONTEXT {
    _opaque: [u8; 0x1000],
}

const CONTEXT_RIP_OFFSET: usize = 0xF8;

static HONEY_A: AtomicUsize = AtomicUsize::new(0);
static HONEY_B: AtomicUsize = AtomicUsize::new(0);
static HONEY_LEN: AtomicUsize = AtomicUsize::new(0);
static IMG_LOW: AtomicUsize = AtomicUsize::new(0);
static IMG_HIGH: AtomicUsize = AtomicUsize::new(0);
static HITS: AtomicU32 = AtomicU32::new(0);
static INSTALLED: AtomicBool = AtomicBool::new(false);
static KILL_ON_HIT: AtomicBool = AtomicBool::new(true);

extern "system" fn handler(ep: *mut EXCEPTION_POINTERS) -> i32 {
    if ep.is_null() {
        return EXCEPTION_CONTINUE_SEARCH;
    }
    unsafe {
        let er = (*ep).ExceptionRecord;
        if er.is_null() {
            return EXCEPTION_CONTINUE_SEARCH;
        }
        let code = (*er).ExceptionCode;
        if code != STATUS_GUARD_PAGE_VIOLATION {
            return EXCEPTION_CONTINUE_SEARCH;
        }
        // 命中地址
        if (*er).NumberParameters < 2 {
            return EXCEPTION_CONTINUE_SEARCH;
        }
        let op = (*er).ExceptionInformation[0]; // 0=read 1=write 8=DEP-execute
        let addr = (*er).ExceptionInformation[1];

        // 是否落在我们蜜罐页
        let len = HONEY_LEN.load(Ordering::Relaxed);
        let a = HONEY_A.load(Ordering::Relaxed);
        let b = HONEY_B.load(Ordering::Relaxed);
        let in_a = a != 0 && addr >= a && addr < a + len;
        let in_b = b != 0 && addr >= b && addr < b + len;
        if !in_a && !in_b {
            return EXCEPTION_CONTINUE_SEARCH;
        }

        let ctx = (*ep).ContextRecord as *const u8;
        let rip = if !ctx.is_null() {
            core::ptr::read_unaligned(ctx.add(CONTEXT_RIP_OFFSET) as *const usize)
        } else {
            0
        };

        let img_low = IMG_LOW.load(Ordering::Relaxed);
        let img_high = IMG_HIGH.load(Ordering::Relaxed);
        let from_self = rip != 0 && rip >= img_low && rip < img_high;

        // 重置 PAGE_GUARD,以便后续仍可触发
        let page_base = (addr & !0xFFF) as *mut c_void;
        let mut old: u32 = 0;
        let _ = VirtualProtect(page_base, 4096, PAGE_READWRITE | PAGE_GUARD, &mut old);

        if from_self {
            // 自身代码读到蜜罐(理论不会,因为业务不引用):放过
            return EXCEPTION_CONTINUE_EXECUTION;
        }

        // 外部访问 → 上报 + 自杀(在 handler 里直接 TerminateProcess)
        HITS.fetch_add(1, Ordering::Relaxed);
        emit_violation(ViolationEvent::new(
            ViolationKind::HoneypotAccessed,
            format!("rip=0x{:x} addr=0x{:x} op={}", rip, addr, op),
        ));
        kill_self(exit_code::HONEYPOT_TRIGGER, KILL_ON_HIT.load(Ordering::Relaxed));
        EXCEPTION_CONTINUE_EXECUTION
    }
}

fn discover_self_image_range() -> Option<(usize, usize)> {
    unsafe {
        let h = GetModuleHandleW(core::ptr::null()); // self
        if h.is_null() {
            return None;
        }
        let dos = h as *const u8;
        let e_lfanew = core::ptr::read_unaligned(dos.add(0x3C) as *const u32) as usize;
        let nt = dos.add(e_lfanew);
        let opt = nt.add(24);
        let size_of_image = core::ptr::read_unaligned(opt.add(56) as *const u32) as usize;
        Some((h as usize, h as usize + size_of_image))
    }
}

pub fn start(cfg: &PolicyConfig) {
    if !cfg.honeypot {
        return;
    }
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    KILL_ON_HIT.store(cfg.kill_on_violation, Ordering::Relaxed);

    if let Some((lo, hi)) = discover_self_image_range() {
        IMG_LOW.store(lo, Ordering::Relaxed);
        IMG_HIGH.store(hi, Ordering::Relaxed);
    }

    unsafe {
        let len = 4096usize;
        let a = VirtualAlloc(null_mut(), len, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        let b = VirtualAlloc(null_mut(), len, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if a.is_null() || b.is_null() {
            return;
        }
        // 装填诱饵:伪坐标/血量/魔术数
        let mut rng = thread_rng();
        let buf_a = core::slice::from_raw_parts_mut(a as *mut u8, len);
        let buf_b = core::slice::from_raw_parts_mut(b as *mut u8, len);
        rng.fill_bytes(buf_a);
        rng.fill_bytes(buf_b);
        // 撒一些"看上去像状态"的魔术值,提高 CE 命中率
        for chunk in buf_a.chunks_exact_mut(8) {
            if rng.gen_bool(0.05) {
                chunk.copy_from_slice(&0xFEEDFACE_DEADBEEFu64.to_le_bytes());
            }
        }
        for chunk in buf_b.chunks_exact_mut(8) {
            if rng.gen_bool(0.05) {
                chunk.copy_from_slice(&0x0BADC0DE_BAADF00Du64.to_le_bytes());
            }
        }

        HONEY_A.store(a as usize, Ordering::Relaxed);
        HONEY_B.store(b as usize, Ordering::Relaxed);
        HONEY_LEN.store(len, Ordering::Relaxed);

        let mut old: u32 = 0;
        let _ = VirtualProtect(a, len, PAGE_READWRITE | PAGE_GUARD, &mut old);
        let _ = VirtualProtect(b, len, PAGE_READWRITE | PAGE_GUARD, &mut old);

        // 注册 first-VEH
        let _ = AddVectoredExceptionHandler(1, handler);
    }
}

#[inline]
pub fn hits() -> u32 {
    HITS.load(Ordering::Relaxed)
}
