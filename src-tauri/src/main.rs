#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 必须在任何 Tauri / WebView2 / 第三方 DLL 触达之前启用进程缓解策略与 DACL 收紧。
    tauri_plugin_self_protect::apply_early_mitigations();

    bongo_cat_lib::run()
}
