mod checks;

use tauri::{
    Runtime, generate_handler,
    plugin::{Builder, TauriPlugin},
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("self-protect")
        .invoke_handler(generate_handler![commands::self_protect_check_status])
        .build()
}

pub fn is_debugged() -> bool {
    checks::check_all()
}

mod commands {
    #[tauri::command]
    pub fn self_protect_check_status() -> Result<bool, String> {
        Ok(super::checks::check_all())
    }
}
