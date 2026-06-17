const COMMANDS: &[&str] = &["is_running_as_administrator", "get_process_metrics"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
