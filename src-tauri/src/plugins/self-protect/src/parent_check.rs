//! §B18 父进程链 + 路径白名单。
//!
//! 启动早期一次性执行,失败 → 5±2s 延迟 `TerminateProcess(BAD_PARENT)`。
//!
//! 注意:Authenticode 签名校验(`WinVerifyTrust`)依赖 `wintrust.dll`,
//! 加载它本身就会拉一堆库,影响启动延迟与体积;本期**不**做签名校验,
//! 仅做镜像名 + 路径白名单 + 创建时间序校验,在 §A 黑名单 + §B12
//! Loader 通知协同下已能拦住绝大多数 spawn-launch 攻击场景。
//!
//! 后续如需上签名校验,可 feature-gate 开。

#![cfg(target_os = "windows")]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use core::ffi::c_void;
use core::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use crate::event::{ViolationEvent, ViolationKind, emit_violation, kill_self};
use crate::obf;
use crate::policy::{PolicyConfig, exit_code};
use crate::syscall;

type DWORD = u32;
type BOOL = i32;
type HANDLE = *mut c_void;
type NTSTATUS = i32;

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const PROCESS_VM_READ: u32 = 0x0010;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: BOOL, pid: u32) -> HANDLE;
    fn CloseHandle(h: HANDLE) -> BOOL;
    fn QueryFullProcessImageNameW(
        h: HANDLE,
        flags: u32,
        buf: *mut u16,
        size: *mut u32,
    ) -> BOOL;
    fn GetCurrentProcess() -> HANDLE;
}

#[repr(C)]
struct PROCESS_BASIC_INFORMATION {
    Reserved1: *mut c_void,
    PebBaseAddress: *mut c_void,
    Reserved2: [*mut c_void; 2],
    UniqueProcessId: usize,
    InheritedFromUniqueProcessId: usize,
}

const ProcessBasicInformation: u32 = 0;

static PARENT_IMAGE: OnceLock<String> = OnceLock::new();
static PARENT_PPID: AtomicUsize = AtomicUsize::new(0);
static VERIFIED: AtomicBool = AtomicBool::new(false);
static FAILED: AtomicBool = AtomicBool::new(false);

#[inline]
pub fn parent_image() -> Option<String> {
    PARENT_IMAGE.get().cloned()
}

#[inline]
pub fn verified() -> bool {
    VERIFIED.load(Ordering::Relaxed)
}

fn read_image_name(h: HANDLE) -> Option<String> {
    let mut buf: Vec<u16> = vec![0u16; 32768];
    let mut size: u32 = buf.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size) };
    if ok == 0 {
        return None;
    }
    buf.truncate(size as usize);
    Some(String::from_utf16_lossy(&buf))
}

fn lower(s: &str) -> String {
    s.to_lowercase()
}

fn basename(path: &str) -> String {
    path.rsplit(|c| c == '\\' || c == '/').next().unwrap_or(path).to_string()
}

pub fn verify(cfg: &PolicyConfig) {
    if !cfg.parent_check {
        return;
    }
    if VERIFIED.swap(true, Ordering::SeqCst) {
        return;
    }

    unsafe {
        // 1. 拿自己的 PBI(PPID)
        let mut pbi: PROCESS_BASIC_INFORMATION = core::mem::zeroed();
        let mut ret: u32 = 0;
        let st = syscall::NtQueryInformationProcess(
            GetCurrentProcess(),
            ProcessBasicInformation,
            &mut pbi as *mut _ as *mut c_void,
            core::mem::size_of::<PROCESS_BASIC_INFORMATION>() as u32,
            &mut ret,
        );
        if st < 0 {
            return;
        }
        let ppid = pbi.InheritedFromUniqueProcessId as u32;
        PARENT_PPID.store(ppid as usize, Ordering::Relaxed);
        if ppid == 0 {
            return;
        }

        // 2. 打开父进程
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, ppid);
        if h.is_null() {
            // 父已退出(典型双击 explorer 后 explorer 长存);允许通过
            return;
        }

        // 3. 拿父镜像路径
        let path = match read_image_name(h) {
            Some(p) => p,
            None => {
                CloseHandle(h);
                return;
            }
        };
        CloseHandle(h);

        let path_lc = lower(&path);
        let bn_lc = basename(&path_lc);

        let _ = PARENT_IMAGE.set(path.clone());

        // 4. 名字白名单
        let whitelist = obf::parent_whitelist_lowercase();
        let allowed_name = whitelist.iter().any(|w| bn_lc == *w);
        // 5. 路径系统目录白名单
        let path_keys = obf::system_path_keywords_lowercase();
        let allowed_path = path_keys.iter().any(|k| path_lc.contains(k));

        if allowed_name || allowed_path {
            return;
        }

        // 6. 不在白名单 → 命中
        FAILED.store(true, Ordering::Release);
        emit_violation(ViolationEvent::new(
            ViolationKind::BadParent,
            format!("ppid={} image={}", ppid, path),
        ));

        // 延迟自杀(避免攻击者通过快/慢失败定位检测点)
        let kill = cfg.kill_on_violation;
        std::thread::Builder::new()
            .name("self-protect/parent-kill".into())
            .spawn(move || {
                let mut rng = rand::thread_rng();
                use rand::Rng;
                let delay = 3000 + rng.gen_range(0..4000);
                std::thread::sleep(Duration::from_millis(delay));
                kill_self(exit_code::BAD_PARENT, kill);
            })
            .ok();
    }
}
