//! 自我保护策略集中配置(v0.3 ULTIMATE)。
//!
//! 默认值随构建模式变化:Windows release(自动启用 `cfg(hardening)`)启用全部
//! 子模块;debug 与非 Windows 目标只保留与 v0.1 兼容的最小行为。

use serde::{Deserialize, Serialize};

/// `.text` 哈希资源在最终 PE 中的 RT_RCDATA 资源 ID。
///
/// 选用 `0xCA7B`(BongoCat 谐音)。脚本 `scripts/embed_text_hash.ts` 与
/// 运行期 `integrity` 模块共享该常量。
pub const TEXT_HASH_RESOURCE_ID: u16 = 0xCA7B;

/// 进程自杀时使用的退出码,语义化便于排查。
pub mod exit_code {
    // §A v0.2 基础层
    pub const TEXT_TAMPERED: u32 = 0xC0DE_BAD0;
    pub const WATCHDOG: u32 = 0xDEAD_BEEF;
    pub const DEBUGGER: u32 = 0xD3B0_4DEB;
    pub const FOREIGN_HANDLE: u32 = 0xF09E_1647;
    pub const SUSPICIOUS_PROCESS: u32 = 0xF0CC_E55D;
    pub const GUARDED_VALUE: u32 = 0xBADC_0DE5;

    // §B v0.3 ULTIMATE 增量层
    /// §B11/§B17 ntdll/ETW 写入侧 hook 命中。
    pub const SYSCALL_HOOK: u32 = 0x1100_C0DE;
    /// §B13 模块三链/内存映像差集发现 unlink 或 manual map。
    pub const MANUAL_MAP: u32 = 0x000D_F00D;
    /// §B18 父进程链/签名/路径白名单失败。
    pub const BAD_PARENT: u32 = 0xBADD_AD00;
    /// §B15 PAGE_GUARD 蜜罐被外部触发。
    pub const HONEYPOT_TRIGGER: u32 = 0xCA77_BA17;
    /// §B14 critical 模块仅在异常分支用作日志提示;不直接退出。
    pub const CRITICAL_BSOD_HINT: u32 = 0xC817_BAD0;

    // §C v0.4 ENDGAME 增量层
    /// §C19 RWX/可疑可执行私有内存区扫描命中(反射 DLL/shellcode 注入)。
    pub const RWX_SHELLCODE: u32 = 0x5A57_C0DE;
    /// §C21 `.rdata` 段哈希被改。
    pub const RDATA_TAMPERED: u32 = 0xC0DE_BAD1;
    /// §C21 `.pdata` 段哈希被改。
    pub const PDATA_TAMPERED: u32 = 0xC0DE_BAD2;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyConfig {
    // §A
    pub apply_mitigations: bool,
    pub apply_acl: bool,
    pub anti_debug: bool,
    pub integrity_check: bool,
    pub guarded_values: bool,
    pub handle_scan: bool,
    pub proc_scan: bool,
    pub watchdog: bool,
    pub display_affinity_exclude: bool,
    pub disallow_win32k: bool,
    pub signature_enforce: bool,
    pub kill_on_violation: bool,

    // §B v0.3 增量
    /// §B9 TLS 早期回调启用标志(纯标记,实际由 .CRT$XLB 段始终生效)。
    pub tls_callback: bool,
    /// §B10 Hell's Gate 直接 syscall。
    pub direct_syscall: bool,
    /// §B11 ntdll 内联 hook 检测。
    pub hook_detect: bool,
    /// §B12 LdrRegisterDllNotification 实时拦截。
    pub ldr_notify: bool,
    /// §B13 PEB Loader 三链交叉 + 内存映像差集。
    pub module_audit: bool,
    /// §B14 RtlSetProcessIsCritical(默认关)。
    pub critical_process: bool,
    /// §B15 PAGE_GUARD 蜜罐。
    pub honeypot: bool,
    /// §B17 ETW 写入侧 hook 检测。
    pub etw_check: bool,
    /// §B18 父进程链 + 签名 + 路径白名单。
    pub parent_check: bool,
    /// §B16 字符串编译期加密(纯标记;`obfstr!` 始终生效)。
    pub string_obfuscation: bool,

    // §C v0.4 ENDGAME 增量
    /// §C19 RWX/可疑可执行私有内存区扫描。
    pub rwx_scan: bool,
    /// §C20 kernelbase / kernel32 hook 检测(复用 §B11 框架)。
    pub kernelbase_hook_detect: bool,
    /// §C21 `.rdata` / `.pdata` 多段哈希校验(BCSEC v2 资源)。
    pub rdata_pdata_integrity: bool,
}

impl PolicyConfig {
    /// 从构建期 cfg 派生默认策略。
    pub const fn from_build() -> Self {
        let hardening = cfg!(hardening);
        let windows = cfg!(target_os = "windows");

        Self {
            // §A
            apply_mitigations: hardening && windows,
            apply_acl: hardening && windows,
            anti_debug: windows, // 反调试始终开,与 v0.1 行为一致
            integrity_check: hardening && windows,
            guarded_values: hardening && windows,
            handle_scan: hardening && windows,
            proc_scan: hardening && windows,
            watchdog: hardening && windows,
            display_affinity_exclude: false,
            disallow_win32k: cfg!(feature = "hardening_disable_win32k"),
            signature_enforce: cfg!(feature = "hardening_signature_enforce"),
            kill_on_violation: hardening && windows,

            // §B
            tls_callback: hardening && cfg!(all(target_os = "windows", target_arch = "x86_64")),
            direct_syscall: hardening && windows,
            hook_detect: hardening && windows,
            ldr_notify: hardening && windows,
            module_audit: hardening && windows,
            critical_process: cfg!(feature = "hardening_critical_process"),
            honeypot: hardening && windows,
            etw_check: hardening && windows,
            parent_check: hardening && windows,
            string_obfuscation: true,

            // §C
            rwx_scan: hardening && windows,
            kernelbase_hook_detect: hardening && windows,
            rdata_pdata_integrity: hardening && windows,
        }
    }

    /// 全部关闭(用于单测或紧急回滚)。
    pub const fn disabled() -> Self {
        Self {
            apply_mitigations: false,
            apply_acl: false,
            anti_debug: false,
            integrity_check: false,
            guarded_values: false,
            handle_scan: false,
            proc_scan: false,
            watchdog: false,
            display_affinity_exclude: false,
            disallow_win32k: false,
            signature_enforce: false,
            kill_on_violation: false,
            tls_callback: false,
            direct_syscall: false,
            hook_detect: false,
            ldr_notify: false,
            module_audit: false,
            critical_process: false,
            honeypot: false,
            etw_check: false,
            parent_check: false,
            string_obfuscation: false,
            rwx_scan: false,
            kernelbase_hook_detect: false,
            rdata_pdata_integrity: false,
        }
    }
}

impl Default for PolicyConfig {
    fn default() -> Self {
        Self::from_build()
    }
}
