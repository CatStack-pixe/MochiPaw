// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

use tauri::{
    Manager, Runtime, generate_handler,
    plugin::{Builder, TauriPlugin},
};

mod commands;

pub use commands::*;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("custom-window")
        .invoke_handler(generate_handler![
            commands::show_window,
            commands::hide_window,
            commands::set_always_on_top,
            commands::set_pass_through,
            commands::set_game_mode,
            commands::set_taskbar_visibility,
            commands::set_webview_memory_target,
        ])
        .on_webview_ready(|webview| {
            if let Some(window) = webview.app_handle().get_webview_window(webview.label()) {
                commands::apply_current_game_mode(&window);
            }
        })
        .build()
}
