// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

use fs_extra::dir::{CopyOptions, copy};
use std::{
    fs::{File, create_dir_all},
    path::{Component, Path, PathBuf},
};
use tauri::command;
use zip::ZipArchive;

#[command]
pub async fn copy_dir(from_path: String, to_path: String) -> Result<(), String> {
    copy_dir_paths(PathBuf::from(from_path), PathBuf::from(to_path))
}

fn copy_dir_paths(from_path: impl AsRef<Path>, to_path: impl AsRef<Path>) -> Result<(), String> {
    let from_path = from_path.as_ref();
    let to_path = to_path.as_ref();
    let mut options = CopyOptions::new();
    options.content_only = true;

    create_dir_all(to_path).map_err(|err| err.to_string())?;

    copy(from_path, to_path, &options).map_err(|err| err.to_string())?;

    Ok(())
}

#[command]
pub async fn extract_zip(from_path: String, to_path: String) -> Result<(), String> {
    extract_zip_paths(PathBuf::from(from_path), PathBuf::from(to_path))
}

fn extract_zip_paths(from_path: impl AsRef<Path>, to_path: impl AsRef<Path>) -> Result<(), String> {
    let archive_file = File::open(from_path.as_ref()).map_err(|err| err.to_string())?;
    let mut archive = ZipArchive::new(archive_file).map_err(|err| err.to_string())?;
    let destination = to_path.as_ref();

    create_dir_all(destination).map_err(|err| err.to_string())?;

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|err| err.to_string())?;
        validate_zip_entry_name(&file)?;
        let Some(safe_name) = file.enclosed_name() else {
            continue;
        };

        if safe_name
            .components()
            .any(|component| matches!(component, Component::Prefix(_)))
        {
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

fn validate_zip_entry_name<R: std::io::Read>(
    file: &zip::read::ZipFile<'_, R>,
) -> Result<(), String> {
    let raw_name = file.name_raw();
    let utf8_name =
        std::str::from_utf8(raw_name).map_err(|_| unsupported_zip_filename_encoding())?;

    if utf8_name.as_bytes() != file.name().as_bytes() {
        return Err(unsupported_zip_filename_encoding());
    }

    Ok(())
}

fn unsupported_zip_filename_encoding() -> String {
    "unsupported ZIP filename encoding (only UTF-8 is supported)".to_string()
}

#[cfg(test)]
mod tests {
    use super::{copy_dir_paths, extract_zip_paths};
    use std::{
        fs,
        io::Write,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };
    use zip::{ZipWriter, write::SimpleFileOptions};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should follow UNIX epoch")
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("mochi-paw-{name}-{}-{unique}", std::process::id()));
            fs::create_dir_all(&path).expect("test directory should be created");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).expect("ZIP file should be created");
        let mut writer = ZipWriter::new(file);

        for (name, contents) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .expect("ZIP entry should be created");
            writer
                .write_all(contents)
                .expect("ZIP entry should be written");
        }

        writer.finish().expect("ZIP should be finalized");
    }

    #[test]
    fn copies_files_in_unicode_directories_without_changing_bytes() {
        let root = TestDirectory::new("复制 中文 空格#%🐾");
        let source = root.path().join("源模型");
        let destination = root.path().join("目标 模型#100%");
        let contents = [0, 1, 2, 0x7f, 0x80, 0xff];
        let source_file = source.join("纹理").join("猫咪.png");

        fs::create_dir_all(source_file.parent().unwrap()).unwrap();
        fs::write(&source_file, contents).unwrap();

        copy_dir_paths(&source, &destination).unwrap();

        assert_eq!(
            fs::read(destination.join("纹理").join("猫咪.png")).unwrap(),
            contents
        );
    }

    #[test]
    fn extracts_utf8_unicode_entries_without_changing_bytes() {
        let root = TestDirectory::new("解压 中文 空格#%🐾");
        let archive = root.path().join("中文 模型#100%.zip");
        let destination = root.path().join("输出 目录");
        let contents = [0, 1, 2, 0x80, 0xff];

        write_zip(&archive, &[("中文 模型#%🐾/纹理/猫咪.png", &contents)]);
        extract_zip_paths(&archive, &destination).unwrap();

        assert_eq!(
            fs::read(
                destination
                    .join("中文 模型#%🐾")
                    .join("纹理")
                    .join("猫咪.png")
            )
            .unwrap(),
            contents
        );
    }

    #[test]
    fn rejects_legacy_non_utf8_entry_names() {
        let root = TestDirectory::new("legacy-encoding");
        let archive = root.path().join("legacy.zip");
        let destination = root.path().join("output");

        write_zip(&archive, &[("name", b"contents")]);
        let mut bytes = fs::read(&archive).unwrap();
        let replacement = [0xd6, 0xd0, 0xce, 0xc4];
        let mut replacements = 0;

        for index in 0..=bytes.len() - 4 {
            if &bytes[index..index + 4] == b"name" {
                bytes[index..index + 4].copy_from_slice(&replacement);
                replacements += 1;
            }
        }

        assert_eq!(
            replacements, 2,
            "local and central ZIP names should both be replaced"
        );
        fs::write(&archive, bytes).unwrap();

        let error = extract_zip_paths(&archive, &destination).unwrap_err();
        assert!(error.contains("unsupported ZIP filename encoding"));
    }

    #[test]
    fn ignores_zip_slip_entries() {
        let root = TestDirectory::new("zip-slip");
        let archive = root.path().join("unsafe.zip");
        let destination = root.path().join("output");
        let escaped = root.path().join("escaped.bin");

        write_zip(
            &archive,
            &[("../escaped.bin", b"unsafe"), ("safe/file.bin", b"safe")],
        );
        extract_zip_paths(&archive, &destination).unwrap();

        assert!(!escaped.exists());
        assert_eq!(
            fs::read(destination.join("safe").join("file.bin")).unwrap(),
            b"safe"
        );
    }
}
