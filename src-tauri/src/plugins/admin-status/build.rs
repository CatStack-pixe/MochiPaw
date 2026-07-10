// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

const COMMANDS: &[&str] = &[
    "is_running_as_administrator",
    "relaunch_as_administrator",
    "get_process_metrics",
    "compact_process_memory",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
