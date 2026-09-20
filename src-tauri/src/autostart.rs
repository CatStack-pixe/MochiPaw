// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

use std::sync::Mutex;

// The main window and preferences can request changes concurrently.
static AUTOSTART_LOCK: Mutex<()> = Mutex::new(());

#[tauri::command]
pub async fn get_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = AUTOSTART_LOCK.lock().map_err(|error| error.to_string())?;
        #[cfg(target_os = "windows")]
        {
            windows::with_registration(&app, |registration| registration.is_enabled())
        }
        #[cfg(not(target_os = "windows"))]
        {
            use tauri_plugin_autostart::ManagerExt;
            app.autolaunch()
                .is_enabled()
                .map_err(|error| error.to_string())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn set_autostart_enabled(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = AUTOSTART_LOCK.lock().map_err(|error| error.to_string())?;
        #[cfg(target_os = "windows")]
        {
            windows::with_registration(&app, |registration| registration.set_enabled(enabled))
        }
        #[cfg(not(target_os = "windows"))]
        {
            use tauri_plugin_autostart::ManagerExt;
            let manager = app.autolaunch();
            if enabled {
                manager.enable()
            } else {
                manager.disable()
            }
            .map_err(|error| error.to_string())?;
            let actual = manager.is_enabled().map_err(|error| error.to_string())?;
            if actual != enabled {
                return Err("Autostart verification failed after update".into());
            }
            Ok(actual)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Migrate an existing Windows entry after an update or a move. An absent entry
/// and Windows' separate startup approval are deliberately left untouched.
pub fn repair_existing_entry(app: &tauri::AppHandle) -> Result<(), String> {
    let _guard = AUTOSTART_LOCK.lock().map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    {
        windows::with_registration(app, |registration| registration.repair_existing())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::{
        io,
        path::{Path, PathBuf},
    };
    use winreg::{
        RegKey, RegValue,
        enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_BINARY},
    };

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVAL_KEY: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    const ENABLED_APPROVAL: [u8; 12] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    pub(super) fn with_registration<T>(
        app: &tauri::AppHandle,
        operation: impl FnOnce(&Registration<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let root = RegKey::predef(HKEY_CURRENT_USER);
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let registration = Registration::new(
            &root,
            RUN_KEY,
            APPROVAL_KEY,
            &app.package_info().name,
            &executable,
        );
        operation(&registration)
    }

    fn quoted_command(executable: &Path) -> Result<String, String> {
        let path = executable
            .to_str()
            .ok_or("The startup executable path is not valid Unicode")?;
        if !executable.is_absolute() || path.contains(['"', '\0', '\r', '\n']) {
            return Err("The startup executable path must be an absolute, valid path".into());
        }
        let command = format!("\"{path}\"");
        // Run command lines are limited to 260 characters, including our quotes.
        // https://learn.microsoft.com/windows/win32/setupapi/run-and-runonce-registry-keys
        if command.encode_utf16().count() > 260 {
            return Err("The startup command exceeds the Windows Run limit of 260 characters; move the application to a shorter path".into());
        }
        Ok(command)
    }

    fn optional<T>(result: io::Result<T>) -> Result<Option<T>, String> {
        match result {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    pub(super) struct Registration<'a> {
        root: &'a RegKey,
        run_key: &'a str,
        approval_key: &'a str,
        name: &'a str,
        executable: PathBuf,
    }

    impl<'a> Registration<'a> {
        fn new(
            root: &'a RegKey,
            run_key: &'a str,
            approval_key: &'a str,
            name: &'a str,
            executable: &Path,
        ) -> Self {
            Self {
                root,
                run_key,
                approval_key,
                name,
                executable: executable.to_path_buf(),
            }
        }

        fn registered_command(&self) -> Result<Option<String>, String> {
            let Some(run) = optional(self.root.open_subkey_with_flags(self.run_key, KEY_READ))?
            else {
                return Ok(None);
            };
            optional(run.get_value(self.name))
        }

        pub(super) fn is_enabled(&self) -> Result<bool, String> {
            let Some(registered) = self.registered_command()? else {
                return Ok(false);
            };
            // Report the actual OS registration even if this executable moved to
            // an unsupported path, so the user can still turn the old entry off.
            if registered.trim().is_empty() {
                return Ok(false);
            }
            let Some(approval) = optional(
                self.root
                    .open_subkey_with_flags(self.approval_key, KEY_READ),
            )?
            else {
                return Ok(true);
            };
            let Some(value) = optional(approval.get_raw_value(self.name))? else {
                return Ok(true);
            };
            // StartupApproved is an OS implementation detail. Recognize known
            // enabled states only; malformed/unknown records stay disabled.
            Ok(value.vtype == REG_BINARY
                && value.bytes.len() == 12
                && matches!(value.bytes[0], 2 | 6)
                && value.bytes[1..].iter().all(|byte| *byte == 0))
        }

        pub(super) fn set_enabled(&self, enabled: bool) -> Result<bool, String> {
            if enabled {
                let command = quoted_command(&self.executable)?;
                // Check approval-key permissions before modifying Run. Explicit
                // enable uses the same approval record as the autostart plugin.
                let approval = optional(
                    self.root
                        .open_subkey_with_flags(self.approval_key, KEY_READ | KEY_SET_VALUE),
                )?;
                let (run, _) = self
                    .root
                    .create_subkey_with_flags(self.run_key, KEY_READ | KEY_SET_VALUE)
                    .map_err(|error| error.to_string())?;
                run.set_value(self.name, &command)
                    .map_err(|error| error.to_string())?;
                if let Some(approval) = approval {
                    approval
                        .set_raw_value(
                            self.name,
                            &RegValue {
                                vtype: REG_BINARY,
                                bytes: ENABLED_APPROVAL.to_vec(),
                            },
                        )
                        .map_err(|error| error.to_string())?;
                }
                if self.registered_command()?.as_deref() != Some(&command) {
                    return Err("Autostart verification failed after updating the command".into());
                }
            } else if let Some(run) = optional(
                self.root
                    .open_subkey_with_flags(self.run_key, KEY_SET_VALUE),
            )? {
                optional(run.delete_value(self.name))?;
            }
            let actual = self.is_enabled()?;
            if actual != enabled {
                return Err("Autostart verification failed after update".into());
            }
            Ok(actual)
        }

        pub(super) fn repair_existing(&self) -> Result<(), String> {
            let Some(registered) = self.registered_command()? else {
                return Ok(());
            };
            let command = quoted_command(&self.executable)?;
            if registered == command {
                return Ok(());
            }
            let run = self
                .root
                .open_subkey_with_flags(self.run_key, KEY_SET_VALUE)
                .map_err(|error| error.to_string())?;
            run.set_value(self.name, &command)
                .map_err(|error| error.to_string())?;
            if self.registered_command()?.as_deref() != Some(&command) {
                return Err("Autostart verification failed after repairing the command".into());
            }
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicU64, Ordering};
        use windows::{
            Win32::{
                Foundation::{HLOCAL, LocalFree},
                UI::Shell::CommandLineToArgvW,
            },
            core::PCWSTR,
        };

        const TEST_NAME: &str = "test-app";
        const TEST_EXE: &str = r"C:\Users\测试 用户\Application Files\app.exe";
        static NEXT_TEST: AtomicU64 = AtomicU64::new(0);

        struct TestRegistry {
            root: RegKey,
            path: String,
        }

        impl TestRegistry {
            fn new() -> Self {
                // These tests never access the real Windows startup settings.
                let path = format!(
                    r"Software\MochiPawAutostartTests\{}-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos(),
                    NEXT_TEST.fetch_add(1, Ordering::Relaxed)
                );
                let (root, _) = RegKey::predef(HKEY_CURRENT_USER)
                    .create_subkey(&path)
                    .unwrap();
                Self { root, path }
            }

            fn registration(&self) -> Registration<'_> {
                Registration::new(
                    &self.root,
                    "Run",
                    "StartupApproved",
                    TEST_NAME,
                    Path::new(TEST_EXE),
                )
            }

            fn approval(&self, bytes: &[u8]) -> RegKey {
                let (key, _) = self.root.create_subkey("StartupApproved").unwrap();
                key.set_raw_value(
                    TEST_NAME,
                    &RegValue {
                        vtype: REG_BINARY,
                        bytes: bytes.to_vec(),
                    },
                )
                .unwrap();
                key
            }
        }

        impl Drop for TestRegistry {
            fn drop(&mut self) {
                let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.path);
            }
        }

        #[test]
        fn quoted_unicode_path_is_a_single_windows_argument() {
            let command = quoted_command(Path::new(TEST_EXE)).unwrap();
            let wide: Vec<u16> = command.encode_utf16().chain(Some(0)).collect();
            let mut argc = 0;
            unsafe {
                let argv = CommandLineToArgvW(PCWSTR(wide.as_ptr()), &mut argc);
                assert!(!argv.is_null());
                let parsed = (*argv).to_string().unwrap();
                let _ = LocalFree(Some(HLOCAL(argv.cast())));
                assert_eq!(argc, 1);
                assert_eq!(parsed, TEST_EXE);
            }
        }

        #[test]
        fn missing_key_and_repeated_enable_disable_are_supported() {
            let test = TestRegistry::new();
            let registration = test.registration();
            assert!(!registration.is_enabled().unwrap());
            registration.repair_existing().unwrap();
            assert!(optional(test.root.open_subkey("Run")).unwrap().is_none());
            assert!(!registration.set_enabled(false).unwrap());
            for _ in 0..2 {
                assert!(registration.set_enabled(true).unwrap());
                assert!(registration.set_enabled(true).unwrap());
                assert!(!registration.set_enabled(false).unwrap());
                assert!(!registration.set_enabled(false).unwrap());
            }
            registration.repair_existing().unwrap();
            assert_eq!(registration.registered_command().unwrap(), None);
        }

        #[test]
        fn repair_updates_old_command_without_changing_disabled_approval() {
            let test = TestRegistry::new();
            let registration = test.registration();
            let (run, _) = test.root.create_subkey("Run").unwrap();
            let disabled = [3, 0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0];
            let approval = test.approval(&disabled);
            for old in [TEST_EXE.to_owned(), r#""C:\Old Location\app.exe""#.into()] {
                run.set_value(TEST_NAME, &old).unwrap();
                registration.repair_existing().unwrap();
                assert_eq!(
                    registration.registered_command().unwrap(),
                    Some(format!("\"{TEST_EXE}\""))
                );
                assert!(!registration.is_enabled().unwrap());
                assert_eq!(approval.get_raw_value(TEST_NAME).unwrap().bytes, disabled);
            }
            assert!(registration.set_enabled(true).unwrap());
            assert_eq!(
                approval.get_raw_value(TEST_NAME).unwrap().bytes,
                ENABLED_APPROVAL
            );
        }

        #[test]
        fn disabled_unknown_and_malformed_approval_are_not_reported_enabled() {
            let test = TestRegistry::new();
            let registration = test.registration();
            registration.set_enabled(true).unwrap();
            for bytes in [vec![3; 12], vec![0; 12], vec![2], vec![9; 12]] {
                test.approval(&bytes);
                assert!(!registration.is_enabled().unwrap());
            }
            let mut disabled_without_timestamp = ENABLED_APPROVAL;
            disabled_without_timestamp[0] = 3;
            test.approval(&disabled_without_timestamp);
            assert!(!registration.is_enabled().unwrap());
            for state in [2, 6] {
                let mut enabled = ENABLED_APPROVAL;
                enabled[0] = state;
                test.approval(&enabled);
                assert!(registration.is_enabled().unwrap());
            }
        }

        #[test]
        fn invalid_and_overlong_paths_are_rejected_before_registration() {
            let test = TestRegistry::new();
            for path in [
                "relative.exe".to_owned(),
                "C:\\bad\"path\\app.exe".to_owned(),
                "C:\\bad\0path\\app.exe".to_owned(),
                format!(r"C:\{}\app.exe", "a".repeat(260)),
                format!(r"C:\{}\app.exe", "😀".repeat(130)),
            ] {
                assert!(
                    Registration::new(
                        &test.root,
                        "Run",
                        "StartupApproved",
                        TEST_NAME,
                        Path::new(&path),
                    )
                    .set_enabled(true)
                    .is_err()
                );
            }
            assert!(optional(test.root.open_subkey("Run")).unwrap().is_none());

            let at_limit = format!(r"C:\{}.exe", "a".repeat(251));
            assert_eq!(
                quoted_command(Path::new(&at_limit))
                    .unwrap()
                    .encode_utf16()
                    .count(),
                260
            );
            assert!(quoted_command(Path::new(&format!("{at_limit}a"))).is_err());

            let (run, _) = test.root.create_subkey("Run").unwrap();
            run.set_value(TEST_NAME, &"old command").unwrap();
            assert!(
                Registration::new(
                    &test.root,
                    "Run",
                    "StartupApproved",
                    TEST_NAME,
                    Path::new(&format!("{at_limit}a")),
                )
                .set_enabled(true)
                .is_err()
            );
            assert_eq!(
                run.get_value::<String, _>(TEST_NAME).unwrap(),
                "old command"
            );
        }

        #[test]
        fn moving_to_an_overlong_path_still_allows_disabling_an_old_entry() {
            let test = TestRegistry::new();
            test.registration().set_enabled(true).unwrap();
            let registration = Registration::new(
                &test.root,
                "Run",
                "StartupApproved",
                TEST_NAME,
                Path::new(&format!(r"C:\{}\app.exe", "a".repeat(260))),
            );
            assert!(registration.is_enabled().unwrap());
            assert!(registration.repair_existing().is_err());
            assert!(!registration.set_enabled(false).unwrap());
            assert_eq!(registration.registered_command().unwrap(), None);
        }

        #[test]
        fn registry_read_errors_are_not_treated_as_missing_entries() {
            let test = TestRegistry::new();
            let (run, _) = test.root.create_subkey("Run").unwrap();
            run.set_value(TEST_NAME, &1_u32).unwrap();
            assert!(test.registration().is_enabled().is_err());
        }
    }
}
