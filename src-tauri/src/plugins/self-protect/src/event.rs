//! 违例事件:被各保护模块发现的"敌情"通过这里汇总,对外
//! 1) 保留最近一次记录用于 `self_protect_status` 查询;
//! 2) 通过 Tauri 事件 `self-protect:violation` 实时推送给前端;
//! 3) 提供统一的 `kill_self` 让违例响应可在 release/debug 切换。

use std::sync::OnceLock;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ViolationKind {
    // §A v0.2 基础层
    Debugger,
    HwBreakpoint,
    PebFlag,
    HeapFlag,
    HideFromDebugger,
    VehTrap,
    TextTampered,
    GuardedValueTampered,
    GuardedCanaryTripped,
    ForeignHandle,
    SuspiciousProcess,
    WatchdogHeartbeat,
    ThreadSuspended,
    MitigationDowngrade,

    // §B v0.3 ULTIMATE 增量层
    /// §B11 ntdll 关键导出首字节被 hook。
    SyscallHooked,
    /// §B17 ETW 写入侧函数被 patch。
    EtwPatched,
    /// §B12 LdrRegisterDllNotification 命中黑名单 DLL。
    LdrBlacklist,
    /// §B13 PEB Loader 链中存在 unlink 模块。
    UnlinkedModule,
    /// §B13 地址空间含未在 Loader 链中的 manual map 模块。
    ManualMappedModule,
    /// §B15 PAGE_GUARD 蜜罐被外部读/写访问。
    HoneypotAccessed,
    /// §B18 父进程链/签名/路径白名单失败。
    BadParent,
    /// §B9 TLS 早期回调发现调试器。
    TlsEarlyDebugger,
    /// §B14 critical process 设置失败(非致命,仅日志)。
    CriticalProcessUnavailable,

    // §C v0.4 ENDGAME 增量层
    /// §C19 RWX/可疑可执行私有内存区(反射 DLL/shellcode 注入)。
    SuspiciousRwx,
    /// §C20 kernelbase 关键导出首字节被 hook。
    KernelbaseHooked,
    /// §C20 kernel32 关键导出首字节被 hook。
    Kernel32Hooked,
    /// §C21 `.rdata` 段哈希被改。
    RdataTampered,
    /// §C21 `.pdata` 段哈希被改。
    PdataTampered,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViolationEvent {
    pub kind: ViolationKind,
    pub detail: String,
    pub ts_ms: u64,
}

impl ViolationEvent {
    pub fn new(kind: ViolationKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
            ts_ms: now_ms(),
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// 类型擦除的 emitter,使非泛型模块也能广播事件。
type Emit = Box<dyn Fn(&ViolationEvent) + Send + Sync + 'static>;

static EMITTER: OnceLock<Emit> = OnceLock::new();
static LAST: OnceLock<Mutex<Option<ViolationEvent>>> = OnceLock::new();

fn last_slot() -> &'static Mutex<Option<ViolationEvent>> {
    LAST.get_or_init(|| Mutex::new(None))
}

/// 由 plugin setup 在拥有到 AppHandle 之后调用一次。
pub fn install_app_handle<R: Runtime>(app: AppHandle<R>) {
    let _ = EMITTER.set(Box::new(move |ev: &ViolationEvent| {
        // 忽略 emit 失败:即便前端不在监听也不应影响后续防护逻辑。
        let _ = app.emit("self-protect:violation", ev.clone());
    }));
}

pub fn emit_violation(ev: ViolationEvent) {
    {
        let mut slot = last_slot().lock();
        *slot = Some(ev.clone());
    }
    if let Some(emit) = EMITTER.get() {
        emit(&ev);
    }
    // 兜底:总是写一条 log,无 logger 时 println。
    eprintln!(
        "[self-protect] violation kind={:?} detail={} ts_ms={}",
        ev.kind, ev.detail, ev.ts_ms
    );
}

pub fn last_violation() -> Option<ViolationEvent> {
    last_slot().lock().clone()
}

/// 触发自杀。`kill_on_violation == false` 时仅 emit 不退出。
#[allow(unused_variables)]
pub fn kill_self(code: u32, kill_on_violation: bool) {
    if !kill_on_violation {
        return;
    }

    #[cfg(target_os = "windows")]
    unsafe {
        use core::ffi::c_void;
        type HANDLE = *mut c_void;
        type BOOL = i32;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetCurrentProcess() -> HANDLE;
            fn TerminateProcess(h: HANDLE, code: u32) -> BOOL;
        }
        let _ = TerminateProcess(GetCurrentProcess(), code);
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::process::exit(code as i32);
    }
}
