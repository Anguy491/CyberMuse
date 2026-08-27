use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use time::OffsetDateTime;

static DIAGNOSTIC_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageCategoryId {
    Songs,
    Models,
    Diagnostics,
    Temporary,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCategoryUsage {
    pub id: StorageCategoryId,
    pub bytes: u64,
    pub item_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageOverview {
    pub schema_version: u32,
    pub calculated_at_ms: i128,
    pub total_bytes: u64,
    pub categories: Vec<StorageCategoryUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageOverviewError {
    pub code: &'static str,
    pub message_key: &'static str,
    pub retryable: bool,
    pub safe_details: BTreeMap<String, String>,
    pub diagnostic_id: String,
}

impl StorageOverviewError {
    fn io(category: StorageCategoryId) -> Self {
        let mut safe_details = BTreeMap::new();
        safe_details.insert("category".to_owned(), category_name(category).to_owned());
        Self {
            code: "STORAGE_OVERVIEW_UNAVAILABLE",
            message_key: "storage.error.overviewUnavailable",
            retryable: true,
            safe_details,
            diagnostic_id: format!(
                "storage-overview-{}-{}",
                std::process::id(),
                DIAGNOSTIC_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ),
        }
    }

    fn overflow(category: StorageCategoryId) -> Self {
        let mut error = Self::io(category);
        error.code = "STORAGE_OVERVIEW_INVALID";
        error.message_key = "storage.error.overviewInvalid";
        error.retryable = false;
        error
    }
}

pub fn collect_storage_overview(app_root: &Path) -> Result<StorageOverview, StorageOverviewError> {
    let definitions = [
        (
            StorageCategoryId::Songs,
            app_root.join("data").join("songs"),
        ),
        (StorageCategoryId::Models, app_root.join("models")),
        (StorageCategoryId::Diagnostics, app_root.join("logs")),
        (StorageCategoryId::Temporary, app_root.join("tmp")),
        (
            StorageCategoryId::Other,
            app_root.join("data").join("settings.json"),
        ),
    ];
    let mut total_bytes = 0_u64;
    let mut categories = Vec::with_capacity(definitions.len());
    for (id, path) in definitions {
        let usage = collect_category(id, &path)?;
        total_bytes = total_bytes
            .checked_add(usage.bytes)
            .ok_or_else(|| StorageOverviewError::overflow(id))?;
        categories.push(usage);
    }
    Ok(StorageOverview {
        schema_version: 1,
        calculated_at_ms: OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000,
        total_bytes,
        categories,
    })
}

fn collect_category(
    id: StorageCategoryId,
    path: &Path,
) -> Result<StorageCategoryUsage, StorageOverviewError> {
    if !path.exists() {
        return Ok(StorageCategoryUsage {
            id,
            bytes: 0,
            item_count: 0,
        });
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| StorageOverviewError::io(id))?;
    if is_link_or_reparse(&metadata) {
        return Ok(StorageCategoryUsage {
            id,
            bytes: 0,
            item_count: 0,
        });
    }
    if metadata.is_file() {
        return Ok(StorageCategoryUsage {
            id,
            bytes: metadata.len(),
            item_count: 1,
        });
    }
    if !metadata.is_dir() {
        return Ok(StorageCategoryUsage {
            id,
            bytes: 0,
            item_count: 0,
        });
    }
    let mut bytes = 0_u64;
    let mut item_count = 0_u64;
    for entry in fs::read_dir(path).map_err(|_| StorageOverviewError::io(id))? {
        let entry = entry.map_err(|_| StorageOverviewError::io(id))?;
        let entry_metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| StorageOverviewError::io(id))?;
        if is_link_or_reparse(&entry_metadata) {
            continue;
        }
        item_count = item_count
            .checked_add(1)
            .ok_or_else(|| StorageOverviewError::overflow(id))?;
        bytes = bytes
            .checked_add(path_bytes(id, &entry.path(), &entry_metadata)?)
            .ok_or_else(|| StorageOverviewError::overflow(id))?;
    }
    Ok(StorageCategoryUsage {
        id,
        bytes,
        item_count,
    })
}

fn path_bytes(
    id: StorageCategoryId,
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<u64, StorageOverviewError> {
    if is_link_or_reparse(metadata) {
        return Ok(0);
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Ok(0);
    }
    let mut bytes = 0_u64;
    for entry in fs::read_dir(path).map_err(|_| StorageOverviewError::io(id))? {
        let entry = entry.map_err(|_| StorageOverviewError::io(id))?;
        let entry_metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| StorageOverviewError::io(id))?;
        bytes = bytes
            .checked_add(path_bytes(id, &entry.path(), &entry_metadata)?)
            .ok_or_else(|| StorageOverviewError::overflow(id))?;
    }
    Ok(bytes)
}

fn category_name(id: StorageCategoryId) -> &'static str {
    match id {
        StorageCategoryId::Songs => "songs",
        StorageCategoryId::Models => "models",
        StorageCategoryId::Diagnostics => "diagnostics",
        StorageCategoryId::Temporary => "temporary",
        StorageCategoryId::Other => "other",
    }
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn root(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "cybermuse-storage-overview-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn tc_sto_003_counts_fixed_unicode_categories_without_paths() {
        let app_root = root("Unicode 空格");
        fs::create_dir_all(app_root.join("data/songs/song-a/analyses")).expect("song directories");
        fs::create_dir_all(app_root.join("models/model-a/1")).expect("model directories");
        fs::create_dir_all(app_root.join("logs")).expect("logs");
        fs::create_dir_all(app_root.join("tmp/jobs")).expect("temporary");
        fs::write(app_root.join("data/songs/song-a/source.wav"), b"12345").expect("song asset");
        fs::write(
            app_root.join("data/songs/song-a/analyses/result.json"),
            b"123",
        )
        .expect("analysis asset");
        fs::write(app_root.join("models/model-a/1/model.bin"), b"1234567").expect("model asset");
        fs::write(app_root.join("logs/events.json"), b"12").expect("log");
        fs::write(app_root.join("tmp/jobs/work.bin"), b"1234").expect("temp");
        fs::write(app_root.join("data/settings.json"), b"123456").expect("settings");

        let overview = collect_storage_overview(&app_root).expect("overview");
        assert_eq!(overview.total_bytes, 27);
        assert_eq!(overview.categories.len(), 5);
        assert_eq!(overview.categories[0].bytes, 8);
        assert_eq!(overview.categories[0].item_count, 1);
        assert_eq!(overview.categories[1].bytes, 7);
        assert_eq!(overview.categories[4].bytes, 6);
        let serialized = serde_json::to_string(&overview).expect("serialize");
        assert!(!serialized.contains(&app_root.to_string_lossy().to_string()));
        let _ignored = fs::remove_dir_all(app_root);
    }

    #[test]
    fn tc_sto_003_missing_categories_are_zero() {
        let app_root = root("missing");
        fs::create_dir_all(&app_root).expect("root");
        let overview = collect_storage_overview(&app_root).expect("overview");
        assert_eq!(overview.total_bytes, 0);
        assert!(
            overview
                .categories
                .iter()
                .all(|category| category.bytes == 0 && category.item_count == 0)
        );
        let _ignored = fs::remove_dir_all(app_root);
    }

    #[test]
    fn tc_sto_003_skips_symbolic_links_and_reparse_points() {
        let app_root = root("reparse");
        let external_root = root("external");
        let songs_root = app_root.join("data/songs");
        fs::create_dir_all(&songs_root).expect("songs root");
        fs::create_dir_all(&external_root).expect("external root");
        let external_file = external_root.join("outside.bin");
        fs::write(&external_file, b"must-not-be-counted").expect("external fixture");
        let linked_file = songs_root.join("linked.bin");
        #[cfg(windows)]
        let link_created = std::os::windows::fs::symlink_file(&external_file, &linked_file).is_ok();
        #[cfg(unix)]
        let link_created = std::os::unix::fs::symlink(&external_file, &linked_file).is_ok();
        #[cfg(not(any(windows, unix)))]
        let link_created = false;

        if link_created {
            let overview = collect_storage_overview(&app_root).expect("overview");
            assert_eq!(overview.categories[0].bytes, 0);
            assert_eq!(overview.categories[0].item_count, 0);
        }
        let _ignored = fs::remove_dir_all(app_root);
        let _ignored = fs::remove_dir_all(external_root);
    }
}
