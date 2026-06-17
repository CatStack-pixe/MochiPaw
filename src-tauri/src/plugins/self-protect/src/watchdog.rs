//! 三线程互监 + 裁判线程 watchdog。
//!
//! - A 线程:`anti_debug::deep_check` + `quick_check` 周期触发
//! - B / C 线程:心跳兜底
//! - 裁判线程:每 1±0.3 s 抽查心跳停顿:
//!     * §A wd-a/b/c 自身停顿 > 30 s 即 `WATCHDOG`
//!     * §B11 hook_detect / §B13 module_audit 心跳停顿 > 60 s 提示对应模块异常
//!     * §B12 ldr_notify 命中:每轮 `poll_and_handle()` 摄取
//!   并通过 `NtQueryInformationThread(ThreadSuspendCount=0x23)` 检测 SuspendThread。

#![cfg(target_os = "windows")]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use core::ffi::c_void;
use core::ptr::null_mut;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rand::{Rng, thread_rng};

use crate::anti_debug::{deep_check, quick_check};
use crate::event::{ViolationEvent, ViolationKind, emit_violation, kill_self};
use crate::policy::{PolicyConfig, exit_code};
// §B10 Nt* 走集中通道
use crate::syscall::NtQueryInformationThread;

type BOOL = i32;
type DWORD = u32;
type HANDLE = *mut c_void;
type NTSTATUS = i32;

const THREAD_QUERY_INFORMATION: DWORD = 0x0040;
const ThreadSuspendCount: u32 = 35; // 0x23

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentThreadId() -> DWORD;
    fn OpenThread(access: DWORD, inherit: BOOL, tid: DWORD) -> HANDLE;
    fn CloseHandle(h: HANDLE) -> BOOL;
}

#[inline]
fn nt_success(s: NTSTATUS) -> bool {
    s >= 0
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

struct Heart {
    last_beat_ms: AtomicU64,
    thread_id: AtomicU64,
}

impl Heart {
    fn new() -> Self {
        Self {
            last_beat_ms: AtomicU64::new(now_ms()),
            thread_id: AtomicU64::new(0),
        }
    }
}

pub fn start(cfg: &PolicyConfig) {
    if !cfg.watchdog {
        return;
    }
    let kill = cfg.kill_on_violation;
    let watch_hook_detect = cfg.hook_detect;
    let watch_module_audit = cfg.module_audit;
    let watch_ldr_notify = cfg.ldr_notify;
    let watch_rwx_scan = cfg.rwx_scan;

    let a = Arc::new(Heart::new());
    let b = Arc::new(Heart::new());
    let c = Arc::new(Heart::new());

    {
        let h = a.clone();
        std::thread::Builder::new()
            .name("self-protect/wd-a".into())
            .spawn(move || {
                let id = unsafe { GetCurrentThreadId() };
                h.thread_id.store(id as u64, Ordering::Relaxed);
                let mut rng = thread_rng();
                loop {
                    if let Some(ind) = deep_check() {
                        emit_violation(ViolationEvent::new(
                            ind.kind,
                            "watchdog A: deep_check tripped",
                        ));
                        kill_self(exit_code::DEBUGGER, kill);
                        return;
                    }
                    if let Some(ind) = quick_check() {
                        emit_violation(ViolationEvent::new(
                            ind.kind,
                            "watchdog A: quick_check tripped",
                        ));
                        kill_self(exit_code::DEBUGGER, kill);
                        return;
                    }
                    h.last_beat_ms.store(now_ms(), Ordering::Relaxed);
                    let jitter = rng.gen_range(0..2_000);
                    std::thread::sleep(Duration::from_millis(3_000 + jitter));
                }
            })
            .ok();
    }

    for (h, name) in [(b.clone(), "self-protect/wd-b"), (c.clone(), "self-protect/wd-c")] {
        std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                let id = unsafe { GetCurrentThreadId() };
                h.thread_id.store(id as u64, Ordering::Relaxed);
                let mut rng = thread_rng();
                loop {
                    h.last_beat_ms.store(now_ms(), Ordering::Relaxed);
                    let jitter = rng.gen_range(0..2_000);
                    std::thread::sleep(Duration::from_millis(3_000 + jitter));
                }
            })
            .ok();
    }

    let hearts = [a, b, c];
    std::thread::Builder::new()
        .name("self-protect/wd-judge".into())
        .spawn(move || {
            let mut rng = thread_rng();
            loop {
                let now = now_ms();

                // 1) §A 自身心跳 + 暂停检测
                for h in &hearts {
                    let last = h.last_beat_ms.load(Ordering::Relaxed);
                    if last != 0 && now.saturating_sub(last) > 30_000 {
                        emit_violation(ViolationEvent::new(
                            ViolationKind::WatchdogHeartbeat,
                            format!("stalled {}ms", now.saturating_sub(last)),
                        ));
                        kill_self(exit_code::WATCHDOG, true);
                        return;
                    }
                    let tid = h.thread_id.load(Ordering::Relaxed) as u32;
                    if tid != 0 {
                        unsafe {
                            let handle = OpenThread(THREAD_QUERY_INFORMATION, 0, tid);
                            if !handle.is_null() && (handle as isize) != -1 {
                                let mut count: u32 = 0;
                                let mut ret_len: u32 = 0;
                                let st = NtQueryInformationThread(
                                    handle,
                                    ThreadSuspendCount,
                                    &mut count as *mut _ as *mut c_void,
                                    core::mem::size_of::<u32>() as u32,
                                    &mut ret_len,
                                );
                                CloseHandle(handle);
                                if nt_success(st) && count != 0 {
                                    emit_violation(ViolationEvent::new(
                                        ViolationKind::ThreadSuspended,
                                        format!("tid={} count={}", tid, count),
                                    ));
                                    kill_self(exit_code::WATCHDOG, true);
                                    return;
                                }
                            }
                        }
                    }
                }

                // 2) §B11 hook_detect 心跳(60 s 阈值,因为周期 17±5 s,留出 3 倍冗余)
                if watch_hook_detect {
                    let last = crate::hook_detect::last_heartbeat_ms();
                    if last != 0 && now.saturating_sub(last) > 60_000 {
                        emit_violation(ViolationEvent::new(
                            ViolationKind::WatchdogHeartbeat,
                            format!(
                                "hook_detect stalled {}ms",
                                now.saturating_sub(last)
                            ),
                        ));
                        kill_self(exit_code::SYSCALL_HOOK, true);
                        return;
                    }
                }
                // 3) §B13 module_audit 心跳(60 s)
                if watch_module_audit {
                    let last = crate::module_audit::last_heartbeat_ms();
                    if last != 0 && now.saturating_sub(last) > 60_000 {
                        emit_violation(ViolationEvent::new(
                            ViolationKind::WatchdogHeartbeat,
                            format!(
                                "module_audit stalled {}ms",
                                now.saturating_sub(last)
                            ),
                        ));
                        kill_self(exit_code::WATCHDOG, true);
                        return;
                    }
                }
                // 4) §C19 rwx_scan 心跳(60 s)
                if watch_rwx_scan {
                    let last = crate::rwx_scan::last_heartbeat_ms();
                    if last != 0 && now.saturating_sub(last) > 60_000 {
                        emit_violation(ViolationEvent::new(
                            ViolationKind::WatchdogHeartbeat,
                            format!(
                                "rwx_scan stalled {}ms",
                                now.saturating_sub(last)
                            ),
                        ));
                        kill_self(exit_code::RWX_SHELLCODE, true);
                        return;
                    }
                }
                // 5) §B12 ldr_notify 命中摄取
                if watch_ldr_notify {
                    crate::ldr_notify::poll_and_handle(true);
                }

                let jitter = rng.gen_range(0..600);
                std::thread::sleep(Duration::from_millis(700 + jitter));
                let _ = null_mut::<u8>();
            }
        })
        .ok();
}
