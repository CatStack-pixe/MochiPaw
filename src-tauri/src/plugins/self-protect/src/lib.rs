//! tauri-plugin-self-protect v0.4 ENDGAME:21 层用户态纵深的进程自我保护。
//!
//! 仅 Windows 启用 hardening 模块;macOS / Linux 维持 v0.1 行为。

mod checks;
pub mod event;
pub mod policy;

#[cfg(target_os = "windows")] mod acl;
#[cfg(target_os = "windows")] mod anti_debug;
#[cfg(target_os = "windows")] mod critical;
#[cfg(target_os = "windows")] mod guarded_value;
#[cfg(target_os = "windows")] mod handle_scan;
#[cfg(target_os = "windows")] mod honeypot;
#[cfg(target_os = "windows")] mod hook_detect;
#[cfg(target_os = "windows")] mod integrity;
#[cfg(target_os = "windows")] mod ldr_notify;
#[cfg(target_os = "windows")] mod mitigations;
#[cfg(target_os = "windows")] mod module_audit;
#[cfg(target_os = "windows")] mod obf;
#[cfg(target_os = "windows")] mod parent_check;
#[cfg(target_os = "windows")] mod proc_scan;
#[cfg(target_os = "windows")] mod rwx_scan;
#[cfg(target_os = "windows")] mod syscall;
#[cfg(all(target_os = "windows", target_arch = "x86_64"))] mod tls_callback;
#[cfg(target_os = "windows")] mod watchdog;

use tauri::{
    Runtime, generate_handler,
    plugin::{Builder, TauriPlugin},
};

use crate::policy::PolicyConfig;

/// 进程入口最早期(`fn main()` 第一行)调用,
/// 在 Tauri / WebView2 / 任意 DLL 加载之前完成 Win32 缓解策略与 DACL 收紧。
pub fn apply_early_mitigations() {
    #[cfg(target_os = "windows")]
    {
        let cfg = PolicyConfig::from_build();
        // §B18 父进程白名单(最先,异常即立刻规划自杀)
        parent_check::verify(&cfg);
        // §A1 process mitigation policy
        mitigations::apply(&cfg);
        // §A2 主进程 DACL 收紧
        acl::harden(&cfg);
        // §B10 Nt* SSN 表健康度自检(非阻塞;只 emit)
        if cfg.direct_syscall {
            syscall::resolve_ssn_table();
        }
        // §B9 TLS 回调自检:DLL_PROCESS_ATTACH 必然先于 main,
        // 若标志没置上,要么 TLS 段被裁,要么编译丢了 _tls_used。
        #[cfg(target_arch = "x86_64")]
        if cfg.tls_callback {
            use core::sync::atomic::Ordering;
            if !tls_callback::TLS_DONE.load(Ordering::Acquire) {
                event::emit_violation(event::ViolationEvent::new(
                    event::ViolationKind::TlsEarlyDebugger,
                    "TLS callback never fired",
                ));
                event::kill_self(policy::exit_code::DEBUGGER, cfg.kill_on_violation);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // 占位,保证 main.rs 在所有平台同样调用。
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("self-protect")
        .invoke_handler(generate_handler![
            commands::self_protect_check_status,
            commands::self_protect_status,
            commands::self_protect_force_recheck,
        ])
        .setup(|app, _api| {
            // emit/last_violation 需要 AppHandle
            event::install_app_handle(app.clone());

            #[cfg(target_os = "windows")]
            {
                let cfg = PolicyConfig::from_build();
                // §B12 LdrRegisterDllNotification 越早越好
                if cfg.ldr_notify {
                    ldr_notify::install(&cfg);
                }
                // §B11 + §B17 + §C20 hook 检测
                if cfg.hook_detect {
                    hook_detect::start(&cfg);
                }
                // §B13 PEB 三链审计
                if cfg.module_audit {
                    module_audit::start(&cfg);
                }
                // §B15 PAGE_GUARD 蜜罐
                if cfg.honeypot {
                    honeypot::start(&cfg);
                }
                if cfg.anti_debug {
                    anti_debug::install_hide_from_debugger_all();
                }
                // §A4 + §C21 .text/.rdata/.pdata 完整性
                if cfg.integrity_check {
                    integrity::start(&cfg);
                }
                if cfg.guarded_values {
                    guarded_value::start_periodic_relocate(&cfg);
                }
                if cfg.handle_scan {
                    handle_scan::start(&cfg);
                }
                if cfg.proc_scan {
                    proc_scan::start(&cfg);
                }
                // §C19 RWX 扫描
                if cfg.rwx_scan {
                    rwx_scan::start(&cfg);
                }
                if cfg.watchdog {
                    watchdog::start(&cfg);
                }
                // §B14 critical process 设为最末(成功后让强制退出转为蓝屏威慑)
                critical::enable_if_configured(&cfg);
            }
            Ok(())
        })
        .build()
}

/// 兼容 v0.1 公共 API:供主程序 `setup` 中的 5s 轮询继续使用。
pub fn is_debugged() -> bool {
    checks::check_all()
}

mod commands {
    use crate::event::{ViolationEvent, last_violation};
    use crate::policy::PolicyConfig;
    use serde::Serialize;

    #[derive(Serialize)]
    pub struct StatusReport {
        pub policy: PolicyConfig,
        pub last_violation: Option<ViolationEvent>,
        // §B / §C 扩展状态(非 Windows 平台返回零值占位)
        pub syscall_table_resolved: bool,
        pub syscall_hook_score: u32,
        pub hook_detect_alerts: u32,
        pub module_audit_anomalies: u32,
        pub honeypot_hits: u32,
        pub rwx_hits: u32,
        pub rwx_last_heartbeat_ms: u64,
        pub parent_image: Option<String>,
        pub parent_verified: bool,
    }

    #[tauri::command]
    pub fn self_protect_check_status() -> Result<bool, String> {
        Ok(super::checks::check_all())
    }

    #[tauri::command]
    pub fn self_protect_status() -> Result<StatusReport, String> {
        #[cfg(target_os = "windows")]
        {
            Ok(StatusReport {
                policy: PolicyConfig::from_build(),
                last_violation: last_violation(),
                syscall_table_resolved: super::syscall::is_resolved(),
                syscall_hook_score: super::syscall::hook_score(),
                hook_detect_alerts: super::hook_detect::alerts(),
                module_audit_anomalies: super::module_audit::anomalies(),
                honeypot_hits: super::honeypot::hits(),
                rwx_hits: super::rwx_scan::hits(),
                rwx_last_heartbeat_ms: super::rwx_scan::last_heartbeat_ms(),
                parent_image: super::parent_check::parent_image(),
                parent_verified: super::parent_check::verified(),
            })
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(StatusReport {
                policy: PolicyConfig::from_build(),
                last_violation: last_violation(),
                syscall_table_resolved: false,
                syscall_hook_score: 0,
                hook_detect_alerts: 0,
                module_audit_anomalies: 0,
                honeypot_hits: 0,
                rwx_hits: 0,
                rwx_last_heartbeat_ms: 0,
                parent_image: None,
                parent_verified: false,
            })
        }
    }

    #[tauri::command]
    pub fn self_protect_force_recheck() -> Result<u32, String> {
        #[cfg(target_os = "windows")]
        {
            let cfg = PolicyConfig::from_build();
            let mut total: u32 = 0;
            if cfg.hook_detect {
                total += super::hook_detect::force_recheck(
                    cfg.etw_check,
                    cfg.kernelbase_hook_detect,
                ) as u32;
            }
            Ok(total)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(0)
        }
    }
}
