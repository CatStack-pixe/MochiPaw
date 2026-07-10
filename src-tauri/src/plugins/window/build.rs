// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

const COMMANDS: &[&str] = &[
    "show_window",
    "hide_window",
    "set_always_on_top",
    "set_taskbar_visibility",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
