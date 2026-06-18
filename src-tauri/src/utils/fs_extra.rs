use fs_extra::dir::{CopyOptions, copy};
use std::{
    fs::{File, create_dir_all},
    path::{Component, Path},
};
use tauri::command;
use zip::ZipArchive;

#[command]
pub async fn copy_dir(from_path: String, to_path: String) -> Result<(), String> {
    let mut options = CopyOptions::new();
    options.content_only = true;

    create_dir_all(&to_path).map_err(|err| err.to_string())?;

    copy(from_path, to_path, &options).map_err(|err| err.to_string())?;

    Ok(())
}

#[command]
pub async fn extract_zip(from_path: String, to_path: String) -> Result<(), String> {
    let archive_file = File::open(&from_path).map_err(|err| err.to_string())?;
    let mut archive = ZipArchive::new(archive_file).map_err(|err| err.to_string())?;
    let destination = Path::new(&to_path);

    create_dir_all(destination).map_err(|err| err.to_string())?;

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|err| err.to_string())?;
        let Some(safe_name) = file.enclosed_name() else {
            continue;
        };

        if safe_name.components().any(|component| matches!(component, Component::Prefix(_))) {
            continue;
        }

        let output_path = destination.join(safe_name);

        if file.is_dir() {
            create_dir_all(&output_path).map_err(|err| err.to_string())?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            create_dir_all(parent).map_err(|err| err.to_string())?;
        }

        let mut output_file = File::create(output_path).map_err(|err| err.to_string())?;

        std::io::copy(&mut file, &mut output_file).map_err(|err| err.to_string())?;
    }

    Ok(())
}
