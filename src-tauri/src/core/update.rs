// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

use serde::Serialize;
use std::path::{Path, PathBuf};

const PORTABLE_MARKER_FILE: &str = ".mochipaw-portable";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum UpdateDistribution {
    #[serde(rename = "windows-installer")]
    WindowsInstaller,
    #[serde(rename = "windows-portable")]
    WindowsPortable,
    #[serde(rename = "macos")]
    MacOs,
    #[serde(rename = "appimage")]
    AppImage,
    #[serde(rename = "deb")]
    Deb,
    #[serde(rename = "rpm")]
    Rpm,
    #[serde(rename = "unknown")]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateInstallStrategy {
    Native,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCapability {
    pub distribution: UpdateDistribution,
    pub install_strategy: UpdateInstallStrategy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OperatingSystem {
    Windows,
    MacOs,
    Linux,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinuxPackage {
    Deb,
    Rpm,
}

#[derive(Debug)]
struct RuntimeEnvironment {
    operating_system: OperatingSystem,
    executable_path: Option<PathBuf>,
    app_image: bool,
    linux_package: Option<LinuxPackage>,
}

impl RuntimeEnvironment {
    fn current() -> Self {
        let operating_system = current_operating_system();
        let executable_path = std::env::current_exe().ok();
        let app_image =
            operating_system == OperatingSystem::Linux && std::env::var_os("APPIMAGE").is_some();
        let linux_package = if operating_system == OperatingSystem::Linux && !app_image {
            executable_path.as_deref().and_then(detect_linux_package)
        } else {
            None
        };

        Self {
            operating_system,
            executable_path,
            app_image,
            linux_package,
        }
    }
}

#[tauri::command]
pub fn get_update_capability() -> UpdateCapability {
    classify_update_capability(&RuntimeEnvironment::current())
}

fn classify_update_capability(environment: &RuntimeEnvironment) -> UpdateCapability {
    let distribution = match environment.operating_system {
        OperatingSystem::Windows if is_windows_portable(environment.executable_path.as_deref()) => {
            UpdateDistribution::WindowsPortable
        }
        OperatingSystem::Windows => UpdateDistribution::WindowsInstaller,
        OperatingSystem::MacOs => UpdateDistribution::MacOs,
        OperatingSystem::Linux if environment.app_image => UpdateDistribution::AppImage,
        OperatingSystem::Linux if environment.linux_package == Some(LinuxPackage::Deb) => {
            UpdateDistribution::Deb
        }
        OperatingSystem::Linux if environment.linux_package == Some(LinuxPackage::Rpm) => {
            UpdateDistribution::Rpm
        }
        OperatingSystem::Linux | OperatingSystem::Other => UpdateDistribution::Unknown,
    };

    let install_strategy = match distribution {
        UpdateDistribution::WindowsInstaller
        | UpdateDistribution::MacOs
        | UpdateDistribution::AppImage => UpdateInstallStrategy::Native,
        UpdateDistribution::WindowsPortable
        | UpdateDistribution::Deb
        | UpdateDistribution::Rpm
        | UpdateDistribution::Unknown => UpdateInstallStrategy::Manual,
    };

    UpdateCapability {
        distribution,
        install_strategy,
    }
}

fn is_windows_portable(executable_path: Option<&Path>) -> bool {
    executable_path
        .and_then(Path::parent)
        .is_some_and(|directory| directory.join(PORTABLE_MARKER_FILE).is_file())
}

fn detect_linux_package(executable_path: &Path) -> Option<LinuxPackage> {
    if package_owns_executable("dpkg-query", &["--search"], executable_path) {
        return Some(LinuxPackage::Deb);
    }

    if package_owns_executable("rpm", &["-qf"], executable_path) {
        return Some(LinuxPackage::Rpm);
    }

    None
}

fn package_owns_executable(command: &str, arguments: &[&str], executable_path: &Path) -> bool {
    std::process::Command::new(command)
        .args(arguments)
        .arg(executable_path)
        .output()
        .is_ok_and(|output| output.status.success())
}

fn current_operating_system() -> OperatingSystem {
    match std::env::consts::OS {
        "windows" => OperatingSystem::Windows,
        "macos" => OperatingSystem::MacOs,
        "linux" => OperatingSystem::Linux,
        _ => OperatingSystem::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEMP_DIRECTORY_ID: AtomicU64 = AtomicU64::new(0);

    fn environment(operating_system: OperatingSystem) -> RuntimeEnvironment {
        RuntimeEnvironment {
            operating_system,
            executable_path: None,
            app_image: false,
            linux_package: None,
        }
    }

    fn temporary_directory(test_name: &str) -> PathBuf {
        let id = TEMP_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "mochipaw-update-capability-{test_name}-{}-{id}",
            std::process::id()
        ))
    }

    #[test]
    fn windows_installer_supports_native_updates_without_marker() {
        let directory = temporary_directory("windows-installer");
        fs::create_dir_all(&directory).unwrap();
        let mut environment = environment(OperatingSystem::Windows);
        environment.executable_path = Some(directory.join("MochiPaw.exe"));

        let capability = classify_update_capability(&environment);

        assert_eq!(
            capability.distribution,
            UpdateDistribution::WindowsInstaller
        );
        assert_eq!(capability.install_strategy, UpdateInstallStrategy::Native);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn windows_portable_marker_requires_manual_updates() {
        let directory = temporary_directory("windows-portable");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(PORTABLE_MARKER_FILE), []).unwrap();
        let mut environment = environment(OperatingSystem::Windows);
        environment.executable_path = Some(directory.join("MochiPaw.exe"));

        let capability = classify_update_capability(&environment);

        assert_eq!(capability.distribution, UpdateDistribution::WindowsPortable);
        assert_eq!(capability.install_strategy, UpdateInstallStrategy::Manual);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn marker_directory_does_not_make_windows_build_portable() {
        let directory = temporary_directory("windows-marker-directory");
        fs::create_dir_all(directory.join(PORTABLE_MARKER_FILE)).unwrap();
        let mut environment = environment(OperatingSystem::Windows);
        environment.executable_path = Some(directory.join("MochiPaw.exe"));

        assert_eq!(
            classify_update_capability(&environment).distribution,
            UpdateDistribution::WindowsInstaller
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn macos_supports_native_updates() {
        let capability = classify_update_capability(&environment(OperatingSystem::MacOs));

        assert_eq!(capability.distribution, UpdateDistribution::MacOs);
        assert_eq!(capability.install_strategy, UpdateInstallStrategy::Native);
    }

    #[test]
    fn linux_appimage_supports_native_updates() {
        let mut environment = environment(OperatingSystem::Linux);
        environment.app_image = true;

        let capability = classify_update_capability(&environment);

        assert_eq!(capability.distribution, UpdateDistribution::AppImage);
        assert_eq!(capability.install_strategy, UpdateInstallStrategy::Native);
    }

    #[test]
    fn linux_deb_requires_manual_updates() {
        let mut environment = environment(OperatingSystem::Linux);
        environment.linux_package = Some(LinuxPackage::Deb);

        let capability = classify_update_capability(&environment);

        assert_eq!(capability.distribution, UpdateDistribution::Deb);
        assert_eq!(capability.install_strategy, UpdateInstallStrategy::Manual);
    }

    #[test]
    fn linux_rpm_requires_manual_updates() {
        let mut environment = environment(OperatingSystem::Linux);
        environment.linux_package = Some(LinuxPackage::Rpm);

        let capability = classify_update_capability(&environment);

        assert_eq!(capability.distribution, UpdateDistribution::Rpm);
        assert_eq!(capability.install_strategy, UpdateInstallStrategy::Manual);
    }

    #[test]
    fn unknown_linux_environment_requires_manual_updates() {
        let capability = classify_update_capability(&environment(OperatingSystem::Linux));

        assert_eq!(capability.distribution, UpdateDistribution::Unknown);
        assert_eq!(capability.install_strategy, UpdateInstallStrategy::Manual);
    }

    #[test]
    fn unsupported_operating_system_requires_manual_updates() {
        let capability = classify_update_capability(&environment(OperatingSystem::Other));

        assert_eq!(capability.distribution, UpdateDistribution::Unknown);
        assert_eq!(capability.install_strategy, UpdateInstallStrategy::Manual);
    }

    #[test]
    fn serializes_frontend_contract_in_camel_case() {
        let capability = UpdateCapability {
            distribution: UpdateDistribution::WindowsPortable,
            install_strategy: UpdateInstallStrategy::Manual,
        };

        assert_eq!(
            serde_json::to_value(capability).unwrap(),
            json!({
                "distribution": "windows-portable",
                "installStrategy": "manual"
            })
        );
    }
}
