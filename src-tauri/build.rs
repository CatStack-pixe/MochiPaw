// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

use std::{
    env,
    fs,
    io,
    path::{Path, PathBuf},
};

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;

    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let from_path = entry.path();
        let to_path = to.join(entry.file_name());

        if from_path.is_dir() {
            copy_dir(&from_path, &to_path)?;
        } else {
            fs::copy(&from_path, &to_path)?;
        }
    }

    Ok(())
}

fn profile_target_dir() -> PathBuf {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is not set"));

    out_dir
        .ancestors()
        .nth(3)
        .expect("failed to resolve target profile directory")
        .to_path_buf()
}

fn sync_dev_assets() {
    println!("cargo:rerun-if-changed=assets");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is not set"));
    let source = manifest_dir.join("assets");
    let target = profile_target_dir().join("assets");

    copy_dir(&source, &target).expect("failed to sync assets to target profile directory");
}

fn main() {
    sync_dev_assets();
    tauri_build::build()
}
