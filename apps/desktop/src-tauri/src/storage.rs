use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

pub const CURRENT_SCHEMA_VERSION: u32 = 1;
static DIAGNOSTIC_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn diagnostic_id() -> String {
    let sequence = DIAGNOSTIC_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("storage-{}-{sequence}", std::process::id())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreError {
    pub code: &'static str,
    pub message_key: &'static str,
    pub retryable: bool,
    pub safe_details: BTreeMap<String, String>,
    pub diagnostic_id: String,
}

impl StoreError {
    fn io(operation: &'static str, retryable: bool) -> Self {
        let mut safe_details = BTreeMap::new();
        safe_details.insert("operation".to_owned(), operation.to_owned());
        Self {
            code: "STORE_IO_ERROR",
            message_key: "storage.error.io",
            retryable,
            safe_details,
            diagnostic_id: diagnostic_id(),
        }
    }

    fn invalid_path(reason: &'static str) -> Self {
        let mut safe_details = BTreeMap::new();
        safe_details.insert("reason".to_owned(), reason.to_owned());
        Self {
            code: "STORE_PATH_INVALID",
            message_key: "storage.error.pathInvalid",
            retryable: false,
            safe_details,
            diagnostic_id: diagnostic_id(),
        }
    }

    fn schema_unsupported(actual: u64) -> Self {
        let mut safe_details = BTreeMap::new();
        safe_details.insert("actualSchemaVersion".to_owned(), actual.to_string());
        Self {
            code: "SCHEMA_UNSUPPORTED",
            message_key: "storage.error.schemaUnsupported",
            retryable: false,
            safe_details,
            diagnostic_id: diagnostic_id(),
        }
    }

    fn schema_invalid() -> Self {
        Self {
            code: "SCHEMA_INVALID",
            message_key: "storage.error.schemaInvalid",
            retryable: false,
            safe_details: BTreeMap::new(),
            diagnostic_id: diagnostic_id(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteInterruption {
    Never,
    AfterTempSync,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionProbe {
    schema_version: u64,
}

pub fn resolve_relative(root: &Path, relative: &Path) -> Result<PathBuf, StoreError> {
    if relative.as_os_str().is_empty() || relative.is_absolute() {
        return Err(StoreError::invalid_path("absolute_or_empty"));
    }

    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(StoreError::invalid_path("non_normal_component"));
        }
    }

    let canonical_root = root
        .canonicalize()
        .map_err(|_| StoreError::io("canonicalize_root", false))?;
    let mut candidate = canonical_root.clone();

    for component in relative.components() {
        if let Component::Normal(segment) = component {
            candidate.push(segment);
            if candidate.exists() {
                let metadata = fs::symlink_metadata(&candidate)
                    .map_err(|_| StoreError::io("inspect_path", false))?;
                if is_link_or_reparse(&metadata) {
                    return Err(StoreError::invalid_path("link_or_reparse_point"));
                }
                let canonical_candidate = candidate
                    .canonicalize()
                    .map_err(|_| StoreError::io("canonicalize_path", false))?;
                if !canonical_candidate.starts_with(&canonical_root) {
                    return Err(StoreError::invalid_path("escaped_root"));
                }
            }
        }
    }

    Ok(candidate)
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }

    #[cfg(not(windows))]
    {
        false
    }
}

pub fn read_versioned_json<T: DeserializeOwned>(path: &Path) -> Result<T, StoreError> {
    let mut file = File::open(path).map_err(|_| StoreError::io("open", true))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|_| StoreError::io("read", true))?;

    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| StoreError::schema_invalid())?;
    let probe: VersionProbe =
        serde_json::from_value(value.clone()).map_err(|_| StoreError::schema_invalid())?;

    if probe.schema_version != u64::from(CURRENT_SCHEMA_VERSION) {
        return Err(StoreError::schema_unsupported(probe.schema_version));
    }

    serde_json::from_value(value).map_err(|_| StoreError::schema_invalid())
}

pub fn write_versioned_json<T: Serialize>(path: &Path, value: &T) -> Result<(), StoreError> {
    write_versioned_json_with_interruption(path, value, WriteInterruption::Never)
}

pub fn write_versioned_json_with_interruption<T: Serialize>(
    path: &Path,
    value: &T,
    interruption: WriteInterruption,
) -> Result<(), StoreError> {
    let parent = path
        .parent()
        .ok_or_else(|| StoreError::invalid_path("missing_parent"))?;
    fs::create_dir_all(parent).map_err(|_| StoreError::io("create_parent", true))?;

    let bytes = serde_json::to_vec_pretty(value).map_err(|_| StoreError::schema_invalid())?;
    let temp_path = temp_path_for(path)?;
    let mut temp = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp_path)
        .map_err(|_| StoreError::io("create_temp", true))?;

    temp.write_all(&bytes)
        .and_then(|()| temp.write_all(b"\n"))
        .and_then(|()| temp.sync_all())
        .map_err(|_| StoreError::io("sync_temp", true))?;
    drop(temp);

    if interruption == WriteInterruption::AfterTempSync {
        return Err(StoreError::io("injected_after_temp_sync", true));
    }

    replace_file(&temp_path, path).map_err(|_| StoreError::io("atomic_replace", true))
}

pub fn discard_incomplete_write(path: &Path) -> Result<bool, StoreError> {
    let temp_path = temp_path_for(path)?;
    if !temp_path.exists() {
        return Ok(false);
    }
    fs::remove_file(temp_path).map_err(|_| StoreError::io("discard_temp", true))?;
    Ok(true)
}

fn temp_path_for(path: &Path) -> Result<PathBuf, StoreError> {
    let file_name = path
        .file_name()
        .ok_or_else(|| StoreError::invalid_path("missing_file_name"))?;
    let mut temp_name = file_name.to_os_string();
    temp_name.push(".tmp");
    Ok(path.with_file_name(temp_name))
}

#[cfg(windows)]
fn replace_file(temp_path: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !destination.exists() {
        return fs::rename(temp_path, destination);
    }

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    let destination_wide = wide(destination.as_os_str());
    let temp_wide = wide(temp_path.as_os_str());
    let result = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            temp_wide.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };

    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(temp_path: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(temp_path, destination)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    struct TestDocument {
        schema_version: u32,
        value: String,
    }

    fn test_root(label: &str) -> PathBuf {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "cybermuse-m1-{label}-{}-{sequence}",
            std::process::id()
        ))
    }

    fn prepare_root(label: &str) -> PathBuf {
        let root = test_root(label);
        fs::create_dir_all(&root).expect("test root should be created");
        root
    }

    fn cleanup(root: &Path) {
        let _ignored = fs::remove_dir_all(root);
    }

    #[test]
    fn tc_path_001_supports_unicode_spaces_and_long_paths() {
        let root = prepare_root("unicode");
        let long_segment = "很长的路径段".repeat(25);
        let relative = PathBuf::from("数据 目录")
            .join(long_segment)
            .join("设置 文件.json");
        let resolved = resolve_relative(&root, &relative).expect("path should remain under root");
        assert!(resolved.starts_with(root.canonicalize().expect("root should canonicalize")));
        assert!(resolved.to_string_lossy().chars().count() >= 180);
        cleanup(&root);
    }

    #[test]
    fn tc_path_001_rejects_parent_and_absolute_paths() {
        let root = prepare_root("escape");
        assert_eq!(
            resolve_relative(&root, Path::new("../escape.json"))
                .expect_err("parent traversal must fail")
                .code,
            "STORE_PATH_INVALID"
        );
        assert_eq!(
            resolve_relative(&root, Path::new(r"C:\outside.json"))
                .expect_err("absolute path must fail")
                .code,
            "STORE_PATH_INVALID"
        );
        cleanup(&root);
    }

    #[test]
    fn tc_sto_002_interruption_preserves_previous_document() {
        let root = prepare_root("atomic");
        let destination = root.join("settings.json");
        let original = TestDocument {
            schema_version: CURRENT_SCHEMA_VERSION,
            value: "previous".to_owned(),
        };
        let replacement = TestDocument {
            schema_version: CURRENT_SCHEMA_VERSION,
            value: "replacement".to_owned(),
        };

        write_versioned_json(&destination, &original).expect("first write should succeed");
        let error = write_versioned_json_with_interruption(
            &destination,
            &replacement,
            WriteInterruption::AfterTempSync,
        )
        .expect_err("injected interruption should fail");
        assert_eq!(error.code, "STORE_IO_ERROR");
        assert_eq!(
            read_versioned_json::<TestDocument>(&destination)
                .expect("previous document should remain"),
            original
        );
        assert!(discard_incomplete_write(&destination).expect("temp cleanup should succeed"));
        assert!(!discard_incomplete_write(&destination).expect("second cleanup should be empty"));
        cleanup(&root);
    }

    #[test]
    fn tc_sto_002_atomically_replaces_with_valid_json() {
        let root = prepare_root("replace");
        let destination = root.join("settings.json");
        let original = TestDocument {
            schema_version: CURRENT_SCHEMA_VERSION,
            value: "旧值".to_owned(),
        };
        let replacement = TestDocument {
            schema_version: CURRENT_SCHEMA_VERSION,
            value: "新值".to_owned(),
        };

        write_versioned_json(&destination, &original).expect("first write should succeed");
        write_versioned_json(&destination, &replacement).expect("replacement should succeed");
        assert_eq!(
            read_versioned_json::<TestDocument>(&destination).expect("new document should load"),
            replacement
        );
        assert!(!destination.with_file_name("settings.json.tmp").exists());
        cleanup(&root);
    }

    #[test]
    fn tc_con_001_rejects_unknown_schema_and_accepts_extra_fields() {
        let root = prepare_root("schema");
        let destination = root.join("document.json");
        fs::write(
            &destination,
            r#"{"schemaVersion":1,"value":"ok","futureField":true}"#,
        )
        .expect("fixture should write");
        assert_eq!(
            read_versioned_json::<TestDocument>(&destination)
                .expect("same-major extra fields should be ignored")
                .value,
            "ok"
        );

        fs::write(&destination, r#"{"schemaVersion":2,"value":"no"}"#)
            .expect("fixture should write");
        assert_eq!(
            read_versioned_json::<TestDocument>(&destination)
                .expect_err("unknown major must fail")
                .code,
            "SCHEMA_UNSUPPORTED"
        );
        cleanup(&root);
    }
}
