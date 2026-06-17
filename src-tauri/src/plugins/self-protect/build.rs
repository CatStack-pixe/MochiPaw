const COMMANDS: &[&str] = &[
    "self_protect_check_status",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
