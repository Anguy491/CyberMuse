use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::storage::{read_versioned_json, resolve_relative, write_versioned_json};

const MAX_SONG_DURATION_MS: u64 = 1_200_000;
const IMPORT_SAFETY_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SongStatus {
    NeedsAnalysis,
    ModelRequired,
    Analyzing,
    Ready,
    AnalysisFailed,
    Damaged,
    Deleting,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub schema_version: u32,
    pub song_id: String,
    pub display_name: String,
    pub source_extension: String,
    pub original_relative_path: String,
    pub duration_ms: u64,
    pub imported_at: String,
    pub updated_at: String,
    pub status: SongStatus,
    pub active_analysis_id: Option<String>,
    pub last_practice_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongSummary {
    pub song_id: String,
    pub display_name: String,
    pub duration_ms: u64,
    pub status: SongStatus,
    pub imported_at: String,
    pub last_practice_at: Option<String>,
    pub local_size_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct ImportCandidate {
    pub token: String,
    pub source_path: PathBuf,
    pub file_name: String,
    pub display_name: String,
    pub source_extension: String,
    pub duration_ms: u64,
    pub source_size_bytes: u64,
    pub estimated_local_bytes: u64,
    pub required_free_bytes: u64,
    pub available_bytes: u64,
    pub modified: Option<SystemTime>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidateView {
    pub token: String,
    pub file_name: String,
    pub source_extension: String,
    pub duration_ms: u64,
    pub source_size_bytes: u64,
    pub estimated_local_bytes: u64,
    pub required_free_bytes: u64,
    pub available_bytes: u64,
}

impl From<&ImportCandidate> for ImportCandidateView {
    fn from(value: &ImportCandidate) -> Self {
        Self {
            token: value.token.clone(),
            file_name: value.file_name.clone(),
            source_extension: value.source_extension.clone(),
            duration_ms: value.duration_ms,
            source_size_bytes: value.source_size_bytes,
            estimated_local_bytes: value.estimated_local_bytes,
            required_free_bytes: value.required_free_bytes,
            available_bytes: value.available_bytes,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub song: Song,
    pub deduplicated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePlan {
    pub song_id: String,
    pub display_name: String,
    pub local_size_bytes: u64,
    pub asset_categories: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongStoreError {
    pub code: &'static str,
    pub message_key: &'static str,
    pub retryable: bool,
    pub safe_details: BTreeMap<String, String>,
    pub diagnostic_id: String,
}

impl SongStoreError {
    fn new(code: &'static str, message_key: &'static str, retryable: bool) -> Self {
        Self {
            code,
            message_key,
            retryable,
            safe_details: BTreeMap::new(),
            diagnostic_id: format!("song-store-{}", std::process::id()),
        }
    }

    fn invalid_audio(reason: &'static str) -> Self {
        let mut error = Self::new("AUDIO_UNSUPPORTED", "import.error.audioUnsupported", false);
        error
            .safe_details
            .insert("reason".to_owned(), reason.to_owned());
        error
    }

    fn source_unreadable(reason: &'static str) -> Self {
        let mut error = Self::new("SOURCE_UNREADABLE", "import.error.sourceUnreadable", true);
        error
            .safe_details
            .insert("reason".to_owned(), reason.to_owned());
        error
    }

    fn storage(operation: &'static str) -> Self {
        let mut error = Self::new("STORE_UNAVAILABLE", "storage.error.io", true);
        error
            .safe_details
            .insert("operation".to_owned(), operation.to_owned());
        error
    }

    fn disk(required: u64, available: u64) -> Self {
        let mut error = Self::new("DISK_SPACE_LOW", "import.error.diskSpaceLow", true);
        error
            .safe_details
            .insert("requiredBytes".to_owned(), required.to_string());
        error
            .safe_details
            .insert("availableBytes".to_owned(), available.to_string());
        error
    }

    fn damaged(reason: &'static str) -> Self {
        let mut error = Self::new("SONG_DAMAGED", "song.error.damaged", true);
        error
            .safe_details
            .insert("reason".to_owned(), reason.to_owned());
        error
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportInterruption {
    Never,
    AfterCopySync,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteInterruption {
    Never,
    AfterAnalyses,
}

#[derive(Debug, Deserialize)]
struct ProbeOutput {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    format: Option<ProbeFormat>,
}

#[derive(Debug, Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
}

pub fn inspect_import_candidate(
    token: String,
    source_path: PathBuf,
    ffmpeg_path: &Path,
    ffprobe_path: &Path,
    app_root: &Path,
) -> Result<ImportCandidate, SongStoreError> {
    let source_extension = source_extension(&source_path)?;
    let metadata = fs::symlink_metadata(&source_path)
        .map_err(|_| SongStoreError::source_unreadable("metadata"))?;
    if !metadata.is_file() || is_link_or_reparse(&metadata) || metadata.len() == 0 {
        return Err(SongStoreError::source_unreadable("file_type"));
    }

    let output = Command::new(ffprobe_path)
        .arg("-v")
        .arg("error")
        .arg("-select_streams")
        .arg("a:0")
        .arg("-show_entries")
        .arg("stream=codec_type:format=duration")
        .arg("-of")
        .arg("json")
        .arg(&source_path)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| SongStoreError::source_unreadable("probe_start"))?;
    if !output.status.success() || output.stdout.len() > 64 * 1024 {
        return Err(SongStoreError::invalid_audio("probe_failed"));
    }
    let probe: ProbeOutput = serde_json::from_slice(&output.stdout)
        .map_err(|_| SongStoreError::invalid_audio("probe_output"))?;
    if !probe
        .streams
        .iter()
        .any(|stream| stream.codec_type.as_deref() == Some("audio"))
    {
        return Err(SongStoreError::invalid_audio("audio_stream_missing"));
    }
    let duration_seconds = probe
        .format
        .and_then(|format| format.duration)
        .and_then(|duration| duration.parse::<f64>().ok())
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or_else(|| SongStoreError::invalid_audio("duration"))?;
    let duration_ms = (duration_seconds * 1000.0).round() as u64;
    if !(1..=MAX_SONG_DURATION_MS).contains(&duration_ms) {
        return Err(SongStoreError::invalid_audio("duration_limit"));
    }

    let decode = Command::new(ffmpeg_path)
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-xerror")
        .arg("-nostdin")
        .arg("-i")
        .arg(&source_path)
        .arg("-map")
        .arg("0:a:0")
        .arg("-f")
        .arg("null")
        .arg("-")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| SongStoreError::source_unreadable("decode_start"))?;
    if !decode.success() {
        return Err(SongStoreError::invalid_audio("decode_failed"));
    }

    let estimated_local_bytes = metadata
        .len()
        .saturating_add(duration_ms.saturating_mul(581_000) / 1000);
    let required_free_bytes = metadata
        .len()
        .saturating_mul(2)
        .saturating_add(duration_ms.saturating_mul(1_000_000) / 1000)
        .saturating_add(IMPORT_SAFETY_BYTES);
    let available_bytes = available_space(app_root)?;
    if available_bytes < required_free_bytes {
        return Err(SongStoreError::disk(required_free_bytes, available_bytes));
    }

    let file_name = source_path
        .file_name()
        .and_then(OsStr::to_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| SongStoreError::source_unreadable("file_name"))?
        .to_owned();
    let raw_display_name = source_path
        .file_stem()
        .and_then(OsStr::to_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("未命名歌曲");
    let display_name = raw_display_name.chars().take(200).collect::<String>();

    Ok(ImportCandidate {
        token,
        source_path,
        file_name,
        display_name,
        source_extension,
        duration_ms,
        source_size_bytes: metadata.len(),
        estimated_local_bytes,
        required_free_bytes,
        available_bytes,
        modified: metadata.modified().ok(),
    })
}

pub fn import_song(
    app_root: &Path,
    candidate: &ImportCandidate,
    initial_status: SongStatus,
    interruption: ImportInterruption,
) -> Result<ImportResult, SongStoreError> {
    let metadata = fs::symlink_metadata(&candidate.source_path)
        .map_err(|_| SongStoreError::source_unreadable("metadata_changed"))?;
    if !metadata.is_file()
        || metadata.len() != candidate.source_size_bytes
        || candidate.modified.is_some() && metadata.modified().ok() != candidate.modified
    {
        return Err(SongStoreError::source_unreadable("source_changed"));
    }
    let available = available_space(app_root)?;
    if available < candidate.required_free_bytes {
        return Err(SongStoreError::disk(
            candidate.required_free_bytes,
            available,
        ));
    }

    let imports_root = app_root.join("tmp").join("imports");
    fs::create_dir_all(&imports_root).map_err(|_| SongStoreError::storage("imports_root"))?;
    let staging = imports_root.join(&candidate.token);
    if staging.exists() {
        return Err(SongStoreError::storage("candidate_reused"));
    }
    fs::create_dir(&staging).map_err(|_| SongStoreError::storage("staging_create"))?;
    let staged_original = staging.join(format!("original.{}", candidate.source_extension));
    let copy_result = copy_and_hash(&candidate.source_path, &staged_original);
    let song_id = match copy_result {
        Ok(song_id) => song_id,
        Err(error) => {
            let _ignored = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    if interruption == ImportInterruption::AfterCopySync {
        let _ignored = fs::remove_dir_all(&staging);
        return Err(SongStoreError::storage("injected_after_copy"));
    }

    let songs_root = app_root.join("data").join("songs");
    fs::create_dir_all(&songs_root).map_err(|_| SongStoreError::storage("songs_root"))?;
    let song_root = songs_root.join(&song_id);
    let now = timestamp();
    if song_root.exists() {
        let metadata_path = song_root.join("song.json");
        let mut song = read_song_at(&metadata_path)?;
        validate_song_identity(&song, &song_id)?;
        let existing_original =
            resolve_relative(&song_root, Path::new(&song.original_relative_path))
                .map_err(|_| SongStoreError::damaged("original_path"))?;
        if !existing_original.is_file() {
            fs::rename(&staged_original, &existing_original)
                .map_err(|_| SongStoreError::storage("repair_original"))?;
            song.source_extension = candidate.source_extension.clone();
            song.original_relative_path = format!("original.{}", candidate.source_extension);
            song.duration_ms = candidate.duration_ms;
            song.status = if song.active_analysis_id.is_some() {
                SongStatus::Ready
            } else {
                initial_status
            };
        }
        song.updated_at = now;
        write_versioned_json(&metadata_path, &song)
            .map_err(|_| SongStoreError::storage("deduplicated_metadata"))?;
        let _ignored = fs::remove_dir_all(&staging);
        return Ok(ImportResult {
            song,
            deduplicated: true,
        });
    }

    let song = Song {
        schema_version: 1,
        song_id: song_id.clone(),
        display_name: candidate.display_name.clone(),
        source_extension: candidate.source_extension.clone(),
        original_relative_path: format!("original.{}", candidate.source_extension),
        duration_ms: candidate.duration_ms,
        imported_at: now.clone(),
        updated_at: now,
        status: initial_status,
        active_analysis_id: None,
        last_practice_at: None,
    };
    write_versioned_json(&staging.join("song.json"), &song)
        .map_err(|_| SongStoreError::storage("song_metadata"))?;
    fs::rename(&staging, &song_root).map_err(|_| SongStoreError::storage("song_commit"))?;
    Ok(ImportResult {
        song,
        deduplicated: false,
    })
}

pub fn list_songs(app_root: &Path) -> Result<Vec<SongSummary>, SongStoreError> {
    let songs_root = app_root.join("data").join("songs");
    fs::create_dir_all(&songs_root).map_err(|_| SongStoreError::storage("songs_root"))?;
    let mut songs = Vec::new();
    for entry in fs::read_dir(&songs_root).map_err(|_| SongStoreError::storage("list_songs"))? {
        let entry = entry.map_err(|_| SongStoreError::storage("list_song_entry"))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|_| SongStoreError::storage("song_entry_metadata"))?;
        if !metadata.is_dir() || is_link_or_reparse(&metadata) {
            continue;
        }
        let song_id = entry.file_name().to_string_lossy().into_owned();
        if !is_sha256(&song_id) {
            continue;
        }
        let local_size_bytes = directory_size(&entry.path())?;
        match read_song_at(&entry.path().join("song.json")) {
            Ok(song) if validate_song_identity(&song, &song_id).is_ok() => {
                let status = if !original_exists(&entry.path(), &song)
                    || song.status == SongStatus::Ready
                        && !basic_ready_assets_exist(&entry.path(), &song)
                {
                    SongStatus::Damaged
                } else {
                    song.status
                };
                songs.push(SongSummary {
                    song_id,
                    display_name: song.display_name,
                    duration_ms: song.duration_ms,
                    status,
                    imported_at: song.imported_at,
                    last_practice_at: song.last_practice_at,
                    local_size_bytes,
                });
            }
            _ => songs.push(SongSummary {
                song_id: song_id.clone(),
                display_name: format!("损坏的歌曲 {}", &song_id[..8]),
                duration_ms: 0,
                status: SongStatus::Damaged,
                imported_at: "1970-01-01T00:00:00Z".to_owned(),
                last_practice_at: None,
                local_size_bytes,
            }),
        }
    }
    songs.sort_by(|left, right| {
        right
            .imported_at
            .cmp(&left.imported_at)
            .then_with(|| left.song_id.cmp(&right.song_id))
    });
    Ok(songs)
}

pub fn get_song(app_root: &Path, song_id: &str) -> Result<Song, SongStoreError> {
    if !is_sha256(song_id) {
        return Err(SongStoreError::new(
            "SONG_NOT_FOUND",
            "song.error.notFound",
            false,
        ));
    }
    let song_root = app_root.join("data").join("songs").join(song_id);
    let song = read_song_at(&song_root.join("song.json"))?;
    validate_song_identity(&song, song_id)?;
    if !original_exists(&song_root, &song) {
        return Err(SongStoreError::damaged("original_missing"));
    }
    Ok(song)
}

pub fn recover_interrupted_song_states(app_root: &Path) -> Result<usize, SongStoreError> {
    let songs_root = app_root.join("data").join("songs");
    if !songs_root.exists() {
        return Ok(0);
    }
    let mut recovered = 0;
    for entry in fs::read_dir(&songs_root).map_err(|_| SongStoreError::storage("recover_list"))? {
        let entry = entry.map_err(|_| SongStoreError::storage("recover_entry"))?;
        let metadata_path = entry.path().join("song.json");
        let Ok(mut song) = read_song_at(&metadata_path) else {
            continue;
        };
        let status = match song.status {
            SongStatus::Analyzing => Some(if song.active_analysis_id.is_some() {
                SongStatus::Ready
            } else {
                SongStatus::AnalysisFailed
            }),
            SongStatus::Deleting => Some(SongStatus::Damaged),
            _ => None,
        };
        if let Some(status) = status {
            song.status = status;
            song.updated_at = timestamp();
            write_versioned_json(&metadata_path, &song)
                .map_err(|_| SongStoreError::storage("recover_write"))?;
            recovered += 1;
        }
    }
    Ok(recovered)
}

pub fn mark_song_status(
    app_root: &Path,
    song_id: &str,
    status: SongStatus,
) -> Result<(), SongStoreError> {
    let song_root = app_root.join("data").join("songs").join(song_id);
    let metadata_path = song_root.join("song.json");
    let mut song = read_song_at(&metadata_path)?;
    validate_song_identity(&song, song_id)?;
    song.status = status;
    song.updated_at = timestamp();
    write_versioned_json(&metadata_path, &song)
        .map_err(|_| SongStoreError::storage("mark_song_status"))
}

pub fn prepare_delete(app_root: &Path, song_id: &str) -> Result<DeletePlan, SongStoreError> {
    let song_root = app_root.join("data").join("songs").join(song_id);
    let song = read_song_at(&song_root.join("song.json"))?;
    validate_song_identity(&song, song_id)?;
    let mut categories = vec!["original".to_owned()];
    if song_root.join("analyses").exists() {
        categories.push("analyses".to_owned());
    }
    if song_root.join("sessions").exists() {
        categories.push("sessions".to_owned());
    }
    Ok(DeletePlan {
        song_id: song_id.to_owned(),
        display_name: song.display_name,
        local_size_bytes: directory_size(&song_root)?,
        asset_categories: categories,
    })
}

pub fn delete_song(
    app_root: &Path,
    song_id: &str,
    interruption: DeleteInterruption,
) -> Result<u64, SongStoreError> {
    let song_root = app_root.join("data").join("songs").join(song_id);
    let mut song = read_song_at(&song_root.join("song.json"))?;
    validate_song_identity(&song, song_id)?;
    let reclaimed = directory_size(&song_root)?;
    song.status = SongStatus::Deleting;
    song.updated_at = timestamp();
    let metadata_path = song_root.join("song.json");
    write_versioned_json(&metadata_path, &song)
        .map_err(|_| SongStoreError::storage("mark_deleting"))?;

    let mut residual = Vec::new();
    remove_category(&song_root.join("sessions"), "sessions", &mut residual);
    remove_category(&song_root.join("analyses"), "analyses", &mut residual);
    if interruption == DeleteInterruption::AfterAnalyses {
        residual.push("injected".to_owned());
    }
    if residual.is_empty() {
        let original = resolve_relative(&song_root, Path::new(&song.original_relative_path))
            .map_err(|_| SongStoreError::damaged("original_path"))?;
        if original.exists() && fs::remove_file(&original).is_err() {
            residual.push("original".to_owned());
        }
    }
    if !residual.is_empty() {
        song.status = SongStatus::Damaged;
        song.updated_at = timestamp();
        let _ignored = write_versioned_json(&metadata_path, &song);
        let mut error = SongStoreError::new("DELETE_PARTIAL", "song.error.deletePartial", true);
        error
            .safe_details
            .insert("residualCategories".to_owned(), residual.join(","));
        return Err(error);
    }

    fs::remove_file(&metadata_path).map_err(|_| {
        let mut error = SongStoreError::new("DELETE_PARTIAL", "song.error.deletePartial", true);
        error
            .safe_details
            .insert("residualCategories".to_owned(), "metadata".to_owned());
        error
    })?;
    fs::remove_dir(&song_root).map_err(|_| {
        let mut error = SongStoreError::new("DELETE_PARTIAL", "song.error.deletePartial", true);
        error
            .safe_details
            .insert("residualCategories".to_owned(), "unknown".to_owned());
        error
    })?;
    Ok(reclaimed)
}

fn remove_category(path: &Path, category: &str, residual: &mut Vec<String>) {
    if path.exists() && fs::remove_dir_all(path).is_err() {
        residual.push(category.to_owned());
    }
}

fn copy_and_hash(source: &Path, destination: &Path) -> Result<String, SongStoreError> {
    let mut input = File::open(source).map_err(|_| SongStoreError::source_unreadable("open"))?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|_| SongStoreError::storage("copy_create"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = input
            .read(&mut buffer)
            .map_err(|_| SongStoreError::source_unreadable("copy_read"))?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .map_err(|_| SongStoreError::storage("copy_write"))?;
        digest.update(&buffer[..count]);
    }
    output
        .sync_all()
        .map_err(|_| SongStoreError::storage("copy_sync"))?;
    Ok(hex_digest(digest.finalize()))
}

fn read_song_at(path: &Path) -> Result<Song, SongStoreError> {
    let song: Song = read_versioned_json(path).map_err(|_| SongStoreError::damaged("metadata"))?;
    validate_song(&song)?;
    Ok(song)
}

fn validate_song(song: &Song) -> Result<(), SongStoreError> {
    if song.schema_version != 1
        || !is_sha256(&song.song_id)
        || song.display_name.trim().is_empty()
        || song.display_name.chars().count() > 200
        || !matches!(song.source_extension.as_str(), "mp3" | "wav" | "flac")
        || !(1..=MAX_SONG_DURATION_MS).contains(&song.duration_ms)
        || song
            .active_analysis_id
            .as_ref()
            .is_some_and(|id| !is_analysis_id(id))
    {
        return Err(SongStoreError::damaged("metadata_fields"));
    }
    Ok(())
}

fn validate_song_identity(song: &Song, expected: &str) -> Result<(), SongStoreError> {
    if song.song_id != expected {
        return Err(SongStoreError::damaged("identity"));
    }
    Ok(())
}

fn original_exists(song_root: &Path, song: &Song) -> bool {
    resolve_relative(song_root, Path::new(&song.original_relative_path))
        .is_ok_and(|path| path.is_file())
}

fn basic_ready_assets_exist(song_root: &Path, song: &Song) -> bool {
    song.active_analysis_id.as_ref().is_some_and(|analysis_id| {
        let root = song_root.join("analyses").join(analysis_id);
        root.join("analysis.json").is_file()
            && root.join("instrumental.wav").is_file()
            && root.join("vocals.wav").is_file()
            && root.join("reference-track.json").is_file()
    })
}

fn source_extension(path: &Path) -> Result<String, SongStoreError> {
    let extension = path
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| SongStoreError::invalid_audio("extension"))?;
    if matches!(extension.as_str(), "mp3" | "wav" | "flac") {
        Ok(extension)
    } else {
        Err(SongStoreError::invalid_audio("extension"))
    }
}

fn directory_size(root: &Path) -> Result<u64, SongStoreError> {
    let metadata =
        fs::symlink_metadata(root).map_err(|_| SongStoreError::storage("directory_metadata"))?;
    if is_link_or_reparse(&metadata) {
        return Err(SongStoreError::damaged("reparse_point"));
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    let mut size = 0_u64;
    for entry in fs::read_dir(root).map_err(|_| SongStoreError::storage("directory_read"))? {
        let entry = entry.map_err(|_| SongStoreError::storage("directory_entry"))?;
        size = size.saturating_add(directory_size(&entry.path())?);
    }
    Ok(size)
}

fn timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_analysis_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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

#[cfg(windows)]
fn available_space(path: &Path) -> Result<u64, SongStoreError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    wide.push(0);
    let mut available = 0_u64;
    let result = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        Err(SongStoreError::storage("disk_space"))
    } else {
        Ok(available)
    }
}

#[cfg(not(windows))]
fn available_space(_path: &Path) -> Result<u64, SongStoreError> {
    Ok(u64::MAX)
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    let mut output = String::with_capacity(bytes.as_ref().len() * 2);
    for byte in bytes.as_ref() {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "cybermuse-m5-{label}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn candidate(source: &Path, token: &str) -> ImportCandidate {
        let metadata = fs::metadata(source).expect("fixture metadata");
        ImportCandidate {
            token: token.to_owned(),
            source_path: source.to_owned(),
            file_name: "测试 音频.wav".to_owned(),
            display_name: "测试 音频".to_owned(),
            source_extension: "wav".to_owned(),
            duration_ms: 1_000,
            source_size_bytes: metadata.len(),
            estimated_local_bytes: metadata.len() + 581_000,
            required_free_bytes: 1,
            available_bytes: u64::MAX,
            modified: metadata.modified().ok(),
        }
    }

    #[test]
    fn tc_imp_003_copy_hash_deduplicate_and_original_independence() {
        let app_root = root("deduplicate");
        let source_root = root("source");
        fs::create_dir_all(&app_root).expect("app root");
        fs::create_dir_all(&source_root).expect("source root");
        let source = source_root.join("测试 音频.wav");
        fs::write(&source, b"fixture-audio-content").expect("source");
        let first = import_song(
            &app_root,
            &candidate(&source, "00000000-0000-4000-8000-000000000001"),
            SongStatus::NeedsAnalysis,
            ImportInterruption::Never,
        )
        .expect("first import");
        let second = import_song(
            &app_root,
            &candidate(&source, "00000000-0000-4000-8000-000000000002"),
            SongStatus::NeedsAnalysis,
            ImportInterruption::Never,
        )
        .expect("deduplicated import");
        assert!(!first.deduplicated);
        assert!(second.deduplicated);
        assert_eq!(first.song.song_id, second.song.song_id);
        fs::remove_file(&source).expect("external source can move or disappear");
        assert!(get_song(&app_root, &first.song.song_id).is_ok());
        let _ignored = fs::remove_dir_all(app_root);
        let _ignored = fs::remove_dir_all(source_root);
    }

    #[test]
    fn tc_imp_002_copy_interruption_leaves_no_song() {
        let app_root = root("copy-interruption");
        fs::create_dir_all(&app_root).expect("app root");
        let source = app_root.join("source.wav");
        fs::write(&source, b"fixture-audio-content").expect("source");
        let error = import_song(
            &app_root,
            &candidate(&source, "00000000-0000-4000-8000-000000000003"),
            SongStatus::NeedsAnalysis,
            ImportInterruption::AfterCopySync,
        )
        .expect_err("interruption must fail");
        assert_eq!(error.code, "STORE_UNAVAILABLE");
        assert!(list_songs(&app_root).expect("list").is_empty());
        let _ignored = fs::remove_dir_all(app_root);
    }

    #[test]
    fn tc_sto_001_partial_delete_remains_visible_and_retryable() {
        let app_root = root("partial-delete");
        fs::create_dir_all(&app_root).expect("app root");
        let source = app_root.join("source.wav");
        fs::write(&source, b"fixture-audio-content").expect("source");
        let imported = import_song(
            &app_root,
            &candidate(&source, "00000000-0000-4000-8000-000000000004"),
            SongStatus::NeedsAnalysis,
            ImportInterruption::Never,
        )
        .expect("import");
        let song_root = app_root
            .join("data")
            .join("songs")
            .join(&imported.song.song_id);
        fs::create_dir_all(song_root.join("analyses")).expect("analyses");
        let error = delete_song(
            &app_root,
            &imported.song.song_id,
            DeleteInterruption::AfterAnalyses,
        )
        .expect_err("injected partial delete");
        assert_eq!(error.code, "DELETE_PARTIAL");
        assert_eq!(
            list_songs(&app_root).expect("list")[0].status,
            SongStatus::Damaged
        );
        delete_song(&app_root, &imported.song.song_id, DeleteInterruption::Never)
            .expect("retry delete");
        assert!(list_songs(&app_root).expect("list").is_empty());
        let _ignored = fs::remove_dir_all(app_root);
    }
}
