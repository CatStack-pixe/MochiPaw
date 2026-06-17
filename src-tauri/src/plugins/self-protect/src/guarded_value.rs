//! `Guarded<T>` 敏感运行时变量容器。
//!
//! 设计目标:Cheat Engine 即便能 `WriteProcessMemory`,改字节也无法通过校验。
//!
//! 内存布局(每个 slot):
//! ```
//! +---------- canary_pre[64] -----------+ 蜜罐字节,初始为随机
//! +---------- xored: [u8; sizeof T] ----+ 真正存储,与 nonce + key 异或
//! +---------- nonce[16] ----------------+ 每次 set 重新随机
//! +---------- mac[32] ------------------+ HMAC-SHA256(key, canary_pre || xored || nonce || canary_post)
//! +---------- canary_post[64] ----------+ 同 canary_pre
//! ```
//! 校验失败(canary 任一字节变化 / mac 不匹配)立即触发自杀。
//! 周期 11±3 秒 `relocate`:`VirtualAlloc` 一块新区,搬迁 slot 后释放旧块,
//! 让 CE 已锁定的"地址"立刻失效。

#![cfg(target_os = "windows")]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use core::ffi::c_void;
use core::ptr::null_mut;
use std::sync::Arc;
use std::time::Duration;

use hmac::{Hmac, Mac};
use parking_lot::Mutex;
use rand::{Rng, RngCore, thread_rng};
use sha2::Sha256;

use crate::event::{ViolationEvent, ViolationKind, emit_violation, kill_self};
use crate::policy::{PolicyConfig, exit_code};

type DWORD = u32;
type SIZE_T = usize;

const MEM_COMMIT: DWORD = 0x0000_1000;
const MEM_RESERVE: DWORD = 0x0000_2000;
const MEM_RELEASE: DWORD = 0x0000_8000;
const PAGE_READWRITE: DWORD = 0x04;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn VirtualAlloc(
        lpAddress: *mut c_void,
        dwSize: SIZE_T,
        flAllocationType: DWORD,
        flProtect: DWORD,
    ) -> *mut c_void;
    fn VirtualFree(lpAddress: *mut c_void, dwSize: SIZE_T, dwFreeType: DWORD) -> i32;
}

type HmacSha256 = Hmac<Sha256>;

const CANARY: usize = 64;
const NONCE: usize = 16;
const MAC: usize = 32;

/// `T: Copy` 才能逐字节存取,避免 Drop 语义。
pub struct Guarded<T: Copy + 'static> {
    inner: Arc<Mutex<Inner<T>>>,
    _kill: bool,
}

struct Inner<T: Copy + 'static> {
    key: [u8; 32],
    slot: *mut u8,
    slot_size: usize,
    payload_off: usize,
    nonce_off: usize,
    mac_off: usize,
    canary_post_off: usize,
    canary_a: [u8; CANARY],
    canary_b: [u8; CANARY],
    kill_on_violation: bool,
    _phantom: core::marker::PhantomData<T>,
}

unsafe impl<T: Copy + Send> Send for Inner<T> {}

fn alloc_slot(slot_size: usize) -> *mut u8 {
    unsafe {
        let p = VirtualAlloc(null_mut(), slot_size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        p as *mut u8
    }
}

fn free_slot(p: *mut u8) {
    if p.is_null() {
        return;
    }
    unsafe {
        VirtualFree(p as *mut c_void, 0, MEM_RELEASE);
    }
}

impl<T: Copy + 'static> Guarded<T> {
    pub fn new(initial: T, cfg: &PolicyConfig) -> Self {
        let mut rng = thread_rng();
        let mut key = [0u8; 32];
        rng.fill_bytes(&mut key);
        let mut canary_a = [0u8; CANARY];
        let mut canary_b = [0u8; CANARY];
        rng.fill_bytes(&mut canary_a);
        rng.fill_bytes(&mut canary_b);

        let payload_size = core::mem::size_of::<T>();
        let extra: usize = rng.gen_range(0..48 * 1024);
        let slot_size = CANARY + payload_size + NONCE + MAC + CANARY + extra;
        let slot = alloc_slot(slot_size);
        assert!(!slot.is_null(), "VirtualAlloc failed for Guarded slot");

        let payload_off = CANARY;
        let nonce_off = payload_off + payload_size;
        let mac_off = nonce_off + NONCE;
        let canary_post_off = mac_off + MAC;

        let inner = Inner::<T> {
            key,
            slot,
            slot_size,
            payload_off,
            nonce_off,
            mac_off,
            canary_post_off,
            canary_a,
            canary_b,
            kill_on_violation: cfg.kill_on_violation,
            _phantom: core::marker::PhantomData,
        };

        let mut guarded = Self {
            inner: Arc::new(Mutex::new(inner)),
            _kill: cfg.kill_on_violation,
        };
        guarded.set(initial);
        guarded
    }

    fn write_canaries(inner: &Inner<T>) {
        unsafe {
            std::ptr::copy_nonoverlapping(
                inner.canary_a.as_ptr(),
                inner.slot,
                CANARY,
            );
            std::ptr::copy_nonoverlapping(
                inner.canary_b.as_ptr(),
                inner.slot.add(inner.canary_post_off),
                CANARY,
            );
        }
    }

    fn check_canaries(inner: &Inner<T>) -> bool {
        unsafe {
            let pre = std::slice::from_raw_parts(inner.slot, CANARY);
            let post = std::slice::from_raw_parts(inner.slot.add(inner.canary_post_off), CANARY);
            pre == inner.canary_a && post == inner.canary_b
        }
    }

    fn compute_mac(inner: &Inner<T>, xored: &[u8], nonce: &[u8]) -> [u8; 32] {
        let mut mac = HmacSha256::new_from_slice(&inner.key).unwrap();
        mac.update(&inner.canary_a);
        mac.update(xored);
        mac.update(nonce);
        mac.update(&inner.canary_b);
        let result = mac.finalize().into_bytes();
        let mut out = [0u8; 32];
        out.copy_from_slice(&result);
        out
    }

    pub fn set(&mut self, value: T) {
        let inner = self.inner.lock();
        let payload_size = core::mem::size_of::<T>();
        let bytes: &[u8] = unsafe {
            std::slice::from_raw_parts(&value as *const T as *const u8, payload_size)
        };
        let mut nonce = [0u8; NONCE];
        thread_rng().fill_bytes(&mut nonce);

        let mut xored = vec![0u8; payload_size];
        for i in 0..payload_size {
            xored[i] = bytes[i] ^ nonce[i % NONCE] ^ inner.key[i % 32];
        }

        unsafe {
            // 重新写 canaries(可能首次写入)
            Self::write_canaries(&inner);
            std::ptr::copy_nonoverlapping(
                xored.as_ptr(),
                inner.slot.add(inner.payload_off),
                payload_size,
            );
            std::ptr::copy_nonoverlapping(
                nonce.as_ptr(),
                inner.slot.add(inner.nonce_off),
                NONCE,
            );
            let mac = Self::compute_mac(&inner, &xored, &nonce);
            std::ptr::copy_nonoverlapping(
                mac.as_ptr(),
                inner.slot.add(inner.mac_off),
                MAC,
            );
        }
    }

    pub fn get(&self) -> Option<T> {
        let inner = self.inner.lock();
        if !Self::check_canaries(&inner) {
            emit_violation(ViolationEvent::new(
                ViolationKind::GuardedCanaryTripped,
                "Guarded canary mismatch",
            ));
            kill_self(exit_code::GUARDED_VALUE, inner.kill_on_violation);
            return None;
        }
        let payload_size = core::mem::size_of::<T>();
        let xored = unsafe {
            std::slice::from_raw_parts(inner.slot.add(inner.payload_off), payload_size).to_vec()
        };
        let nonce = unsafe {
            std::slice::from_raw_parts(inner.slot.add(inner.nonce_off), NONCE).to_vec()
        };
        let stored_mac = unsafe {
            let mut m = [0u8; 32];
            std::ptr::copy_nonoverlapping(inner.slot.add(inner.mac_off), m.as_mut_ptr(), MAC);
            m
        };
        let computed = Self::compute_mac(&inner, &xored, &nonce);
        if computed != stored_mac {
            emit_violation(ViolationEvent::new(
                ViolationKind::GuardedValueTampered,
                "Guarded HMAC mismatch",
            ));
            kill_self(exit_code::GUARDED_VALUE, inner.kill_on_violation);
            return None;
        }
        let mut decoded = vec![0u8; payload_size];
        for i in 0..payload_size {
            decoded[i] = xored[i] ^ nonce[i % NONCE] ^ inner.key[i % 32];
        }
        let mut value = std::mem::MaybeUninit::<T>::uninit();
        unsafe {
            std::ptr::copy_nonoverlapping(
                decoded.as_ptr(),
                value.as_mut_ptr() as *mut u8,
                payload_size,
            );
            Some(value.assume_init())
        }
    }

    /// 把整个 slot 搬到一块新分配的 VirtualAlloc 区。
    pub fn relocate(&self) {
        let mut inner = self.inner.lock();
        let new_extra: usize = thread_rng().gen_range(0..48 * 1024);
        let new_size = CANARY
            + core::mem::size_of::<T>()
            + NONCE
            + MAC
            + CANARY
            + new_extra;
        let new = alloc_slot(new_size);
        if new.is_null() {
            return;
        }
        unsafe {
            // 复制核心区(不含尾部 padding)
            let core_len = inner.canary_post_off + CANARY;
            std::ptr::copy_nonoverlapping(inner.slot, new, core_len);
        }
        let old = inner.slot;
        let old_size = inner.slot_size;
        inner.slot = new;
        inner.slot_size = new_size;
        free_slot(old);
        let _ = old_size;
    }
}

/// 全局 demo 容器:示意 API。真实业务可在调用方按需 `Guarded::new` 自管。
static DEMO: once_cell::sync::OnceCell<Mutex<Option<Guarded<u64>>>> =
    once_cell::sync::OnceCell::new();

pub fn start_periodic_relocate(cfg: &PolicyConfig) {
    if !cfg.guarded_values {
        return;
    }
    DEMO.set(Mutex::new(Some(Guarded::<u64>::new(0, cfg)))).ok();

    let kill = cfg.kill_on_violation;
    std::thread::Builder::new()
        .name("self-protect/guarded".into())
        .spawn(move || {
            let mut rng = thread_rng();
            loop {
                if let Some(slot) = DEMO.get() {
                    if let Some(g) = slot.lock().as_ref() {
                        // 取一次值:顺便校验 canary + HMAC
                        let _ = g.get();
                        g.relocate();
                    }
                }
                let jitter = rng.gen_range(0..6_000);
                std::thread::sleep(Duration::from_millis(8_000 + jitter));
                let _ = null_mut::<u8>();
                let _ = kill; // 已通过 cfg 写入 inner
            }
        })
        .ok();
}
