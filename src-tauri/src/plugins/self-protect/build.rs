// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

const COMMANDS: &[&str] = &[
    "self_protect_check_status",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
