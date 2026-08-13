// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

const COMMANDS: &[&str] = &[
    "show_window",
    "hide_window",
    "set_always_on_top",
    "set_pass_through",
    "set_game_mode",
    "set_taskbar_visibility",
    "set_webview_memory_target",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
