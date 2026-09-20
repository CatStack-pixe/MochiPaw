// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

//! Windows application-owned data lives beside the executable, never the CWD.
//! Existing profile data is deliberately neither read nor migrated.

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};

const FORMAT: &str = "mochipaw-data";
const VERSION: u32 = 1;
const MANIFEST: &str = "layout.json";
static NEXT_PROBE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub struct DataPaths {
    root: PathBuf,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Layout {
    format: String,
    version: u32,
}

impl DataPaths {
    pub fn for_executable(executable: &Path) -> io::Result<Self> {
        if !executable.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "The executable path must be absolute",
            ));
        }
        let parent = executable.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Missing executable directory")
        })?;
        Ok(Self {
            root: parent.join("data"),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn pinia(&self) -> PathBuf {
        self.root.join("pinia")
    }

    pub fn logs(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn webview(&self) -> PathBuf {
        self.root.join("webview")
    }

    /// Validate an existing layout before opening any stores or webviews. There
    /// is no profile-directory or temporary-directory fallback on Windows.
    pub fn prepare(&self) -> io::Result<()> {
        let manifest = self.root.join(MANIFEST);
        match fs::read(&manifest) {
            Ok(bytes) => validate_layout(&bytes)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }

        for path in [
            self.root.clone(),
            self.pinia(),
            self.root.join("custom-models"),
            self.root.join("model-imports"),
            self.logs(),
            self.webview(),
        ] {
            probe_writable_directory(&path)?;
        }

        // Publish a complete manifest without truncating an existing version.
        // Another launch may win the race; validate its manifest in that case.
        if !manifest.exists() {
            let temporary = unique_file(&self.root, "layout");
            let bytes = serde_json::to_vec_pretty(&Layout {
                format: FORMAT.to_string(),
                version: VERSION,
            })?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            let result = (|| {
                file.write_all(&bytes)?;
                file.sync_all()?;
                drop(file);
                // On Windows rename never replaces an existing destination.
                // Unlike hard links this also works on portable FAT/exFAT drives.
                match fs::rename(&temporary, &manifest) {
                    Ok(()) => Ok(()),
                    Err(_) if manifest.exists() => validate_layout(&fs::read(&manifest)?),
                    Err(error) => Err(error),
                }
            })();
            let _ = fs::remove_file(&temporary);
            result?;
        }
        Ok(())
    }
}

fn validate_layout(bytes: &[u8]) -> io::Result<()> {
    let layout: Layout = serde_json::from_slice(bytes)?;
    if layout.format != FORMAT || layout.version != VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "This application does not support the data/layout.json format or version",
        ));
    }
    Ok(())
}

fn unique_file(directory: &Path, purpose: &str) -> PathBuf {
    directory.join(format!(
        ".{purpose}-{}-{}",
        std::process::id(),
        NEXT_PROBE.fetch_add(1, Ordering::Relaxed)
    ))
}

fn probe_writable_directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    let probe = unique_file(path, "write-test");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)?;
    let result = (|| {
        file.write_all(b"MochiPaw data directory write check")?;
        file.sync_all()
    })();
    drop(file);
    let cleanup = fs::remove_file(&probe);
    result?;
    cleanup
}

#[cfg(target_os = "windows")]
pub fn windows_data_paths() -> Result<&'static DataPaths, String> {
    use std::sync::OnceLock;
    static PATHS: OnceLock<Result<DataPaths, String>> = OnceLock::new();
    PATHS
        .get_or_init(|| {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let paths = DataPaths::for_executable(&executable).map_err(|error| error.to_string())?;
            paths.prepare().map_err(|error| {
                format!(
                    "The application data directory is not usable:\n{}\n\n{error}\n\nFor an installed copy, close MochiPaw and repair it with the latest installer from your Windows account. For a portable copy, use a directory writable by your account. Existing data has not been moved or deleted.",
                    paths.root().display()
                )
            })?;
            Ok(paths)
        })
        .as_ref()
        .map_err(Clone::clone)
}

#[tauri::command]
pub fn get_app_data_directory(app: tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        Ok(windows_data_paths()?.root().to_path_buf())
    }
    #[cfg(not(target_os = "windows"))]
    {
        use tauri::Manager;
        app.path().app_data_dir().map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = unique_file(&std::env::temp_dir(), "mochipaw-data-test");
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn paths(&self) -> DataPaths {
            DataPaths::for_executable(&self.0.join("portable folder").join("MochiPaw.exe")).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn starts_fresh_beside_executable_and_preserves_existing_local_data() {
        let fixture = Fixture::new();
        let old_profile = fixture.0.join("Roaming");
        fs::create_dir_all(&old_profile).unwrap();
        fs::write(old_profile.join("model.json"), "old model selection").unwrap();
        let paths = fixture.paths();
        paths.prepare().unwrap();
        assert!(!paths.pinia().join("model.json").exists());
        assert_eq!(
            fs::read_to_string(old_profile.join("model.json")).unwrap(),
            "old model selection"
        );
        fs::write(paths.pinia().join("model.json"), "new model selection").unwrap();
        paths.prepare().unwrap();
        assert_eq!(
            fs::read_to_string(paths.pinia().join("model.json")).unwrap(),
            "new model selection"
        );
        validate_layout(&fs::read(paths.root().join(MANIFEST)).unwrap()).unwrap();
    }

    #[test]
    fn rejects_future_or_malformed_layout_without_overwriting_it() {
        let fixture = Fixture::new();
        let paths = fixture.paths();
        fs::create_dir_all(paths.root()).unwrap();
        for bytes in [
            br#"{"format":"mochipaw-data","version":2}"#.as_slice(),
            b"broken",
        ] {
            fs::write(paths.root().join(MANIFEST), bytes).unwrap();
            assert!(paths.prepare().is_err());
            assert_eq!(fs::read(paths.root().join(MANIFEST)).unwrap(), bytes);
            assert!(!paths.pinia().exists());
        }
    }

    #[test]
    fn rejects_blocked_storage_without_selecting_another_root() {
        let fixture = Fixture::new();
        let paths = fixture.paths();
        fs::create_dir_all(paths.root().parent().unwrap()).unwrap();
        fs::write(paths.root(), "a file occupies data").unwrap();
        assert!(paths.prepare().is_err());
        assert_eq!(
            fs::read_to_string(paths.root()).unwrap(),
            "a file occupies data"
        );
    }

    #[test]
    fn layout_survives_moving_the_complete_portable_directory() {
        let fixture = Fixture::new();
        let paths = fixture.paths();
        paths.prepare().unwrap();
        fs::write(paths.pinia().join("cat.json"), "preserved").unwrap();
        let moved = fixture.0.join("moved portable folder");
        fs::rename(paths.root().parent().unwrap(), &moved).unwrap();
        let next = DataPaths::for_executable(&moved.join("MochiPaw.exe")).unwrap();
        next.prepare().unwrap();
        assert_eq!(
            fs::read_to_string(next.pinia().join("cat.json")).unwrap(),
            "preserved"
        );
        assert!(!paths.root().exists());
    }

    #[test]
    fn relative_executable_paths_are_rejected() {
        assert!(DataPaths::for_executable(Path::new("MochiPaw.exe")).is_err());
    }
}
