//! Optional Linux OCR is installed by zhai-ocr, independently of the main DEB.
//! Resolve relative to the application so relocated/extracted packages work,
//! without silently finding a developer's copy when the component is absent.
use std::path::{Path, PathBuf};

pub(super) fn locate(executable: &Path, development_manifest: Option<&Path>) -> Option<PathBuf> {
    let directory = executable.parent()?;
    let installed = directory.join("../lib/zhai/ocr/material-workshop-rapid-ocr");
    if installed.is_file() {
        return Some(installed);
    }
    if let Some(manifest) = development_manifest.filter(|path| directory.starts_with(path.join("target"))) {
        let development = manifest.join("../src-tauri/binaries/material-workshop-rapid-ocr-aarch64-unknown-linux-gnu");
        return development.is_file().then_some(development);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_install_and_removal_never_fall_back_to_source_for_packaged_app() {
        let root = std::env::temp_dir().join(format!("zhai-optional-ocr-{}", uuid::Uuid::new_v4()));
        let manifest = root.join("source/src-tauri-kylin");
        let dev = root.join("source/src-tauri/binaries/material-workshop-rapid-ocr-aarch64-unknown-linux-gnu");
        let exe = root.join("package/usr/bin/zhai");
        let component = root.join("package/usr/lib/zhai/ocr/material-workshop-rapid-ocr");
        for path in [&manifest, dev.parent().unwrap(), exe.parent().unwrap(), component.parent().unwrap()] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(&dev, b"developer copy").unwrap();
        assert!(locate(&exe, Some(&manifest)).is_none());
        std::fs::write(&component, b"optional installed component").unwrap();
        assert_eq!(std::fs::canonicalize(locate(&exe, None).unwrap()).unwrap(), std::fs::canonicalize(&component).unwrap());
        std::fs::remove_file(&component).unwrap();
        assert!(locate(&exe, Some(&manifest)).is_none());
        let dev_exe = manifest.join("target/release/zhai");
        assert!(locate(&dev_exe, None).is_none());
        assert_eq!(locate(&dev_exe, Some(&manifest)), Some(manifest.join("../src-tauri/binaries/material-workshop-rapid-ocr-aarch64-unknown-linux-gnu")));
        std::fs::remove_dir_all(root).unwrap();
    }
}
