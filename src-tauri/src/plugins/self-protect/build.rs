use std::env;

const COMMANDS: &[&str] = &[
    "self_protect_check_status",
    "self_protect_status",
    "self_protect_force_recheck",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();

    // Tell rustc that custom cfgs are known (rustc 1.80+).
    println!("cargo:rustc-check-cfg=cfg(hardening)");

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let profile = env::var("PROFILE").unwrap_or_default();
    let feature_on = env::var("CARGO_FEATURE_HARDENING").is_ok();

    // Auto-enable on Windows release builds, or whenever the feature is on.
    if feature_on || (target_os == "windows" && profile == "release") {
        println!("cargo:rustc-cfg=hardening");
    }

    // §B9 强制保留 TLS 目录:即使我们没用 thread_local!,也要让链接器把
    // `.CRT$XLB` 段中的 TLS 回调函数指针保留下来,这样 PE Loader 才会触发回调。
    // 在 MSVC 链接器下,需要 `_tls_used` 符号被引用;在 lld-link/MSVC 上一致。
    if target_os == "windows" {
        let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
        let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
        if target_env == "msvc" && target_arch == "x86_64" {
            // x64 上 _tls_used 实为下划线被吃,在符号表里就是 _tls_used。
            println!("cargo:rustc-link-arg=/INCLUDE:_tls_used");
        }
    }
}
