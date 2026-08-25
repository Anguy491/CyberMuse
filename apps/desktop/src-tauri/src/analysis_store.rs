use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as FmtWrite;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::storage::resolve_relative;

const MANIFEST_LIMIT_BYTES: u64 = 1024 * 1024;
const REFERENCE_LIMIT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_REFERENCE_FRAMES: usize = 100_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisStoreError {
    pub code: &'static str,
    pub message_key: &'static str,
    pub retryable: bool,
    pub safe_details: BTreeMap<String, String>,
    pub diagnostic_id: String,
}

impl AnalysisStoreError {
    fn invalid(reason: &'static str) -> Self {
        let mut safe_details = BTreeMap::new();
        safe_details.insert("reason".to_owned(), reason.to_owned());
        Self {
            code: "ANALYZER_OUTPUT_INVALID",
            message_key: "analyzer.error.outputInvalid",
            retryable: true,
            safe_details,
            diagnostic_id: format!("analysis-store-{}", std::process::id()),
        }
    }

    fn storage(reason: &'static str) -> Self {
        let mut error = Self::invalid(reason);
        error.code = "ANALYZER_DISK_FULL";
        error.message_key = "analyzer.error.storage";
        error
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedModel {
    pub version: String,
    pub engine: String,
    pub sha256: String,
    pub license_expression: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationExpectation {
    pub analysis_id: String,
    pub song_id: String,
    pub duration_ms: u64,
    pub pipeline_version: String,
    pub models: BTreeMap<String, ExpectedModel>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFingerprint {
    pub model_id: String,
    pub version: String,
    pub engine: String,
    pub sha256: String,
    pub license_expression: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    Instrumental,
    Vocals,
    ReferenceTrack,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDescriptor {
    pub kind: ArtifactKind,
    pub relative_path: String,
    pub media_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub duration_ms: Option<u64>,
    pub sample_rate_hz: Option<u32>,
    pub channels: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisWarning {
    pub code: String,
    pub message_key: String,
    pub safe_details: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisManifest {
    pub schema_version: u32,
    pub analysis_id: String,
    pub song_id: String,
    pub input_sha256: String,
    pub created_at: String,
    pub pipeline_version: String,
    pub config_fingerprint: String,
    pub duration_ms: u64,
    pub models: Vec<ModelFingerprint>,
    pub artifacts: Vec<ArtifactDescriptor>,
    pub reference_track_relative_path: String,
    pub warnings: Vec<AnalysisWarning>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceTrack {
    schema_version: u32,
    duration_ms: u64,
    hop_ms: u64,
    min_hz: f64,
    max_hz: f64,
    frames: Vec<PitchFrame>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PitchFrame {
    time_ms: u64,
    hz: Option<f64>,
    midi: Option<f64>,
    confidence: f64,
    voiced: bool,
    #[serde(default)]
    interpolated: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedAnalysis {
    pub root: PathBuf,
    pub manifest: AnalysisManifest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitDisposition {
    Committed,
    CacheHit,
}

pub fn canonical_json_sha256(value: &serde_json::Value) -> Result<String, AnalysisStoreError> {
    let mut canonical = String::new();
    write_canonical(value, &mut canonical)?;
    Ok(hex_digest(Sha256::digest(canonical.as_bytes())))
}

pub fn analysis_id_for(value: &serde_json::Value) -> Result<String, AnalysisStoreError> {
    Ok(canonical_json_sha256(value)?[..32].to_owned())
}

pub fn validate_analysis(
    root: &Path,
    expected: &ValidationExpectation,
) -> Result<ValidatedAnalysis, AnalysisStoreError> {
    let root = root
        .canonicalize()
        .map_err(|_| AnalysisStoreError::invalid("analysis_root"))?;
    let manifest_path = root.join("analysis.json");
    let manifest: AnalysisManifest = read_limited_json(&manifest_path, MANIFEST_LIMIT_BYTES)?;
    validate_manifest_fields(&manifest, expected)?;

    let mut kinds = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for artifact in &manifest.artifacts {
        if !kinds.insert(artifact.kind) || !paths.insert(artifact.relative_path.clone()) {
            return Err(AnalysisStoreError::invalid("duplicate_artifact"));
        }
        validate_relative_path(&artifact.relative_path)?;
        let path = resolve_relative(&root, Path::new(&artifact.relative_path))
            .map_err(|_| AnalysisStoreError::invalid("artifact_escape"))?;
        let metadata =
            fs::metadata(&path).map_err(|_| AnalysisStoreError::invalid("artifact_missing"))?;
        if !metadata.is_file() || metadata.len() != artifact.size_bytes {
            return Err(AnalysisStoreError::invalid("artifact_size"));
        }
        if sha256_file(&path)? != artifact.sha256 {
            return Err(AnalysisStoreError::invalid("artifact_hash"));
        }
        validate_artifact_media(artifact, &path, expected.duration_ms)?;
    }
    let required = BTreeSet::from([
        ArtifactKind::Instrumental,
        ArtifactKind::Vocals,
        ArtifactKind::ReferenceTrack,
    ]);
    if kinds != required || manifest.artifacts.len() != 3 {
        return Err(AnalysisStoreError::invalid("artifact_set"));
    }
    let reference = manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.kind == ArtifactKind::ReferenceTrack)
        .ok_or_else(|| AnalysisStoreError::invalid("reference_missing"))?;
    if reference.relative_path != manifest.reference_track_relative_path {
        return Err(AnalysisStoreError::invalid("reference_path"));
    }
    Ok(ValidatedAnalysis { root, manifest })
}

pub fn lookup_cache(
    analyses_root: &Path,
    expected: &ValidationExpectation,
) -> Result<Option<ValidatedAnalysis>, AnalysisStoreError> {
    let target = analyses_root.join(&expected.analysis_id);
    if !target.exists() {
        return Ok(None);
    }
    validate_analysis(&target, expected).map(Some)
}

pub fn commit_analysis(
    staging: &Path,
    analyses_root: &Path,
    job_id: &str,
    expected: &ValidationExpectation,
) -> Result<CommitDisposition, AnalysisStoreError> {
    let validated = validate_analysis(staging, expected)?;
    fs::create_dir_all(analyses_root)
        .map_err(|_| AnalysisStoreError::storage("create_analyses_root"))?;
    if lookup_cache(analyses_root, expected)?.is_some() {
        return Ok(CommitDisposition::CacheHit);
    }
    let final_path = analyses_root.join(&expected.analysis_id);
    if final_path.exists() {
        return Err(AnalysisStoreError::invalid("invalid_existing_cache"));
    }
    let temp_path = analyses_root.join(format!(".{}.commit-{job_id}", expected.analysis_id));
    if temp_path.exists() {
        return Err(AnalysisStoreError::storage("commit_temp_exists"));
    }
    fs::create_dir(&temp_path).map_err(|_| AnalysisStoreError::storage("create_commit_temp"))?;
    for artifact in &validated.manifest.artifacts {
        fs::rename(
            validated.root.join(&artifact.relative_path),
            temp_path.join(&artifact.relative_path),
        )
        .map_err(|_| AnalysisStoreError::storage("move_artifact"))?;
    }
    fs::rename(
        validated.root.join("analysis.json"),
        temp_path.join("analysis.json"),
    )
    .map_err(|_| AnalysisStoreError::storage("move_manifest"))?;
    validate_analysis(&temp_path, expected)?;
    fs::rename(&temp_path, &final_path)
        .map_err(|_| AnalysisStoreError::storage("publish_analysis"))?;
    Ok(CommitDisposition::Committed)
}

fn validate_manifest_fields(
    manifest: &AnalysisManifest,
    expected: &ValidationExpectation,
) -> Result<(), AnalysisStoreError> {
    if manifest.schema_version != 1
        || !is_hex(&manifest.analysis_id, 32)
        || !is_hex(&manifest.song_id, 64)
        || manifest.analysis_id != expected.analysis_id
        || manifest.song_id != expected.song_id
        || manifest.input_sha256 != expected.song_id
        || manifest.duration_ms != expected.duration_ms
        || manifest.pipeline_version != expected.pipeline_version
        || !is_hex(&manifest.config_fingerprint, 64)
        || !manifest
            .config_fingerprint
            .starts_with(&manifest.analysis_id)
        || manifest.created_at.len() > 64
        || !manifest.created_at.contains('T')
        || !manifest.created_at.ends_with('Z')
    {
        return Err(AnalysisStoreError::invalid("manifest_identity"));
    }
    if manifest.models.len() != expected.models.len() {
        return Err(AnalysisStoreError::invalid("model_set"));
    }
    let mut seen = BTreeSet::new();
    for model in &manifest.models {
        let expected_model = expected
            .models
            .get(&model.model_id)
            .ok_or_else(|| AnalysisStoreError::invalid("model_set"))?;
        if !seen.insert(model.model_id.clone())
            || model.version != expected_model.version
            || model.engine != expected_model.engine
            || model.sha256 != expected_model.sha256
            || model.license_expression != expected_model.license_expression
            || !is_hex(&model.sha256, 64)
        {
            return Err(AnalysisStoreError::invalid("model_fingerprint"));
        }
    }
    for warning in &manifest.warnings {
        if warning.code.is_empty()
            || warning.message_key.is_empty()
            || !safe_details(&warning.safe_details)
        {
            return Err(AnalysisStoreError::invalid("warning"));
        }
    }
    Ok(())
}

fn validate_artifact_media(
    artifact: &ArtifactDescriptor,
    path: &Path,
    expected_duration_ms: u64,
) -> Result<(), AnalysisStoreError> {
    match artifact.kind {
        ArtifactKind::Instrumental | ArtifactKind::Vocals => {
            if artifact.media_type != "audio/wav"
                || artifact.sample_rate_hz != Some(48_000)
                || artifact.channels != Some(2)
                || artifact
                    .duration_ms
                    .is_none_or(|duration| duration.abs_diff(expected_duration_ms) > 50)
            {
                return Err(AnalysisStoreError::invalid("audio_descriptor"));
            }
            let wave = inspect_wave(path)?;
            if wave.sample_rate_hz != 48_000
                || wave.channels != 2
                || wave.bits_per_sample != 24
                || wave.duration_ms.abs_diff(expected_duration_ms) > 50
                || artifact.duration_ms != Some(wave.duration_ms)
            {
                return Err(AnalysisStoreError::invalid("audio_media"));
            }
        }
        ArtifactKind::ReferenceTrack => {
            if artifact.media_type != "application/json"
                || artifact.duration_ms != Some(expected_duration_ms)
                || artifact.sample_rate_hz.is_some()
                || artifact.channels.is_some()
            {
                return Err(AnalysisStoreError::invalid("reference_descriptor"));
            }
            let track: ReferenceTrack = read_limited_json(path, REFERENCE_LIMIT_BYTES)?;
            validate_reference(&track, expected_duration_ms)?;
        }
    }
    Ok(())
}

fn validate_reference(
    track: &ReferenceTrack,
    expected_duration_ms: u64,
) -> Result<(), AnalysisStoreError> {
    if track.schema_version != 1
        || track.duration_ms != expected_duration_ms
        || track.hop_ms == 0
        || track.hop_ms > 1000
        || !track.min_hz.is_finite()
        || !track.max_hz.is_finite()
        || track.min_hz <= 0.0
        || track.max_hz <= track.min_hz
        || track.frames.len() > MAX_REFERENCE_FRAMES
    {
        return Err(AnalysisStoreError::invalid("reference_header"));
    }
    let mut previous = None;
    for frame in &track.frames {
        if frame.time_ms > expected_duration_ms
            || previous.is_some_and(|time| frame.time_ms <= time)
            || !frame.confidence.is_finite()
            || !(0.0..=1.0).contains(&frame.confidence)
        {
            return Err(AnalysisStoreError::invalid("reference_frame"));
        }
        match (frame.voiced, frame.hz, frame.midi) {
            (false, None, None) => {}
            (true, Some(hz), Some(midi))
                if hz.is_finite()
                    && midi.is_finite()
                    && (track.min_hz..=track.max_hz).contains(&hz)
                    && (midi - (69.0 + 12.0 * (hz / 440.0).log2())).abs() <= 0.01 => {}
            _ => return Err(AnalysisStoreError::invalid("reference_pitch")),
        }
        let _ = frame.interpolated;
        previous = Some(frame.time_ms);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct WaveInfo {
    sample_rate_hz: u32,
    channels: u16,
    bits_per_sample: u16,
    duration_ms: u64,
}

fn inspect_wave(path: &Path) -> Result<WaveInfo, AnalysisStoreError> {
    let mut file = File::open(path).map_err(|_| AnalysisStoreError::invalid("wave_open"))?;
    let mut header = [0_u8; 12];
    file.read_exact(&mut header)
        .map_err(|_| AnalysisStoreError::invalid("wave_header"))?;
    if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
        return Err(AnalysisStoreError::invalid("wave_header"));
    }
    let mut format = None;
    let mut data_bytes = None;
    loop {
        let mut chunk_header = [0_u8; 8];
        match file.read_exact(&mut chunk_header) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(_) => return Err(AnalysisStoreError::invalid("wave_chunk")),
        }
        let size = u32::from_le_bytes(chunk_header[4..8].try_into().expect("slice length"));
        if &chunk_header[..4] == b"fmt " {
            if !(16..=4096).contains(&size) {
                return Err(AnalysisStoreError::invalid("wave_format"));
            }
            let mut bytes = vec![0_u8; size as usize];
            file.read_exact(&mut bytes)
                .map_err(|_| AnalysisStoreError::invalid("wave_format"))?;
            let mut audio_format = u16::from_le_bytes([bytes[0], bytes[1]]);
            let channels = u16::from_le_bytes([bytes[2], bytes[3]]);
            let sample_rate_hz = u32::from_le_bytes(bytes[4..8].try_into().expect("slice length"));
            let block_align = u16::from_le_bytes([bytes[12], bytes[13]]);
            let bits_per_sample = u16::from_le_bytes([bytes[14], bytes[15]]);
            if audio_format == 0xfffe {
                if bytes.len() < 40
                    || u16::from_le_bytes([bytes[16], bytes[17]]) < 22
                    || bytes[28..40] != *b"\0\0\x10\0\x80\0\0\xaa\08\x9bq"
                {
                    return Err(AnalysisStoreError::invalid("wave_extensible"));
                }
                audio_format = u16::from_le_bytes([bytes[24], bytes[25]]);
            }
            if audio_format != 1 || channels == 0 || sample_rate_hz == 0 || block_align == 0 {
                return Err(AnalysisStoreError::invalid("wave_format"));
            }
            format = Some((channels, sample_rate_hz, block_align, bits_per_sample));
        } else if &chunk_header[..4] == b"data" {
            data_bytes = Some(u64::from(size));
            file.seek(SeekFrom::Current(i64::from(size)))
                .map_err(|_| AnalysisStoreError::invalid("wave_data"))?;
        } else {
            file.seek(SeekFrom::Current(i64::from(size)))
                .map_err(|_| AnalysisStoreError::invalid("wave_chunk"))?;
        }
        if size % 2 == 1 {
            file.seek(SeekFrom::Current(1))
                .map_err(|_| AnalysisStoreError::invalid("wave_padding"))?;
        }
    }
    let (channels, sample_rate_hz, block_align, bits_per_sample) =
        format.ok_or_else(|| AnalysisStoreError::invalid("wave_format_missing"))?;
    let data_bytes = data_bytes.ok_or_else(|| AnalysisStoreError::invalid("wave_data_missing"))?;
    let duration_ms = ((u128::from(data_bytes) * 1000
        + u128::from(block_align) * u128::from(sample_rate_hz) / 2)
        / (u128::from(block_align) * u128::from(sample_rate_hz)))
    .try_into()
    .map_err(|_| AnalysisStoreError::invalid("wave_duration"))?;
    Ok(WaveInfo {
        sample_rate_hz,
        channels,
        bits_per_sample,
        duration_ms,
    })
}

fn read_limited_json<T: for<'de> Deserialize<'de>>(
    path: &Path,
    limit: u64,
) -> Result<T, AnalysisStoreError> {
    let metadata = fs::metadata(path).map_err(|_| AnalysisStoreError::invalid("json_missing"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > limit {
        return Err(AnalysisStoreError::invalid("json_size"));
    }
    let bytes = fs::read(path).map_err(|_| AnalysisStoreError::invalid("json_read"))?;
    serde_json::from_slice(&bytes).map_err(|_| AnalysisStoreError::invalid("json_schema"))
}

fn validate_relative_path(value: &str) -> Result<(), AnalysisStoreError> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains('\\')
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || value.as_bytes().get(1) == Some(&b':')
    {
        return Err(AnalysisStoreError::invalid("artifact_relative_path"));
    }
    Ok(())
}

fn safe_details(details: &BTreeMap<String, serde_json::Value>) -> bool {
    details.len() <= 32
        && details.iter().all(|(key, value)| {
            !key.is_empty()
                && key.len() <= 64
                && match value {
                    serde_json::Value::String(value) => {
                        value.len() <= 256
                            && !value.contains('/')
                            && !value.contains('\\')
                            && !value.contains('\n')
                            && !value.contains('\r')
                    }
                    serde_json::Value::Number(value) => value.as_f64().is_some_and(f64::is_finite),
                    serde_json::Value::Bool(_) => true,
                    _ => false,
                }
        })
}

fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_file(path: &Path) -> Result<String, AnalysisStoreError> {
    let mut file = File::open(path).map_err(|_| AnalysisStoreError::invalid("hash_open"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| AnalysisStoreError::invalid("hash_read"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(hex_digest(digest.finalize()))
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    let mut output = String::with_capacity(bytes.as_ref().len() * 2);
    for byte in bytes.as_ref() {
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}

fn write_canonical(
    value: &serde_json::Value,
    output: &mut String,
) -> Result<(), AnalysisStoreError> {
    match value {
        serde_json::Value::Null => output.push_str("null"),
        serde_json::Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        serde_json::Value::Number(value) => output.push_str(&value.to_string()),
        serde_json::Value::String(value) => output.push_str(
            &serde_json::to_string(value)
                .map_err(|_| AnalysisStoreError::invalid("canonical_string"))?,
        ),
        serde_json::Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical(value, output)?;
            }
            output.push(']');
        }
        serde_json::Value::Object(values) => {
            output.push('{');
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by_key(|(key, _)| *key);
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key)
                        .map_err(|_| AnalysisStoreError::invalid("canonical_key"))?,
                );
                output.push(':');
                write_canonical(value, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "cybermuse-m4-analysis-{label}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn expectation() -> ValidationExpectation {
        ValidationExpectation {
            analysis_id: "b".repeat(32),
            song_id: "a".repeat(64),
            duration_ms: 60,
            pipeline_version: "0.1.0".to_owned(),
            models: BTreeMap::from([(
                "fixture".to_owned(),
                ExpectedModel {
                    version: "1.0.0".to_owned(),
                    engine: "fixture".to_owned(),
                    sha256: "c".repeat(64),
                    license_expression: "MIT".to_owned(),
                },
            )]),
        }
    }

    fn write_wave(path: &Path) {
        let samples = 48_000_u32 * 60 / 1000;
        let data_size = samples * 6;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&48_000_u32.to_le_bytes());
        bytes.extend_from_slice(&288_000_u32.to_le_bytes());
        bytes.extend_from_slice(&6_u16.to_le_bytes());
        bytes.extend_from_slice(&24_u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());
        bytes.resize(bytes.len() + data_size as usize, 0);
        fs::write(path, bytes).expect("wave should write");
    }

    fn prepare_valid(root: &Path, expected: &ValidationExpectation) {
        fs::create_dir_all(root).expect("root should create");
        let vocals = root.join("vocals.wav");
        let instrumental = root.join("instrumental.wav");
        write_wave(&vocals);
        write_wave(&instrumental);
        let reference = root.join("reference-track.json");
        fs::write(
            &reference,
            br#"{"schemaVersion":1,"durationMs":60,"hopMs":20,"minHz":65.0,"maxHz":1047.0,"frames":[{"timeMs":0,"hz":220.0,"midi":57.0,"confidence":0.9,"voiced":true}]}"#,
        )
        .expect("reference should write");
        let artifact = |kind: ArtifactKind,
                        path: &Path,
                        media_type: &str,
                        sample_rate_hz: Option<u32>,
                        channels: Option<u16>| ArtifactDescriptor {
            kind,
            relative_path: path
                .file_name()
                .expect("file name")
                .to_string_lossy()
                .into_owned(),
            media_type: media_type.to_owned(),
            size_bytes: fs::metadata(path).expect("metadata").len(),
            sha256: sha256_file(path).expect("hash"),
            duration_ms: Some(60),
            sample_rate_hz,
            channels,
        };
        let manifest = AnalysisManifest {
            schema_version: 1,
            analysis_id: expected.analysis_id.clone(),
            song_id: expected.song_id.clone(),
            input_sha256: expected.song_id.clone(),
            created_at: "2026-08-25T01:02:03Z".to_owned(),
            pipeline_version: expected.pipeline_version.clone(),
            config_fingerprint: format!("{}{}", expected.analysis_id, "d".repeat(32)),
            duration_ms: 60,
            models: vec![ModelFingerprint {
                model_id: "fixture".to_owned(),
                version: "1.0.0".to_owned(),
                engine: "fixture".to_owned(),
                sha256: "c".repeat(64),
                license_expression: "MIT".to_owned(),
            }],
            artifacts: vec![
                artifact(
                    ArtifactKind::Instrumental,
                    &instrumental,
                    "audio/wav",
                    Some(48_000),
                    Some(2),
                ),
                artifact(
                    ArtifactKind::Vocals,
                    &vocals,
                    "audio/wav",
                    Some(48_000),
                    Some(2),
                ),
                artifact(
                    ArtifactKind::ReferenceTrack,
                    &reference,
                    "application/json",
                    None,
                    None,
                ),
            ],
            reference_track_relative_path: "reference-track.json".to_owned(),
            warnings: Vec::new(),
        };
        fs::write(
            root.join("analysis.json"),
            serde_json::to_vec_pretty(&manifest).expect("manifest should serialize"),
        )
        .expect("manifest should write");
    }

    #[test]
    fn tc_an_002_validates_and_atomically_commits_then_hits_cache() {
        let staging = root("commit-staging");
        let analyses = root("commit-analyses");
        let expected = expectation();
        prepare_valid(&staging, &expected);
        assert_eq!(
            commit_analysis(&staging, &analyses, "job", &expected).expect("commit should succeed"),
            CommitDisposition::Committed
        );
        assert!(
            lookup_cache(&analyses, &expected)
                .expect("cache should validate")
                .is_some()
        );

        let retry_staging = root("retry-staging");
        prepare_valid(&retry_staging, &expected);
        assert_eq!(
            commit_analysis(&retry_staging, &analyses, "retry", &expected)
                .expect("valid cache should win"),
            CommitDisposition::CacheHit
        );
        let _ = fs::remove_dir_all(staging);
        let _ = fs::remove_dir_all(retry_staging);
        let _ = fs::remove_dir_all(analyses);
    }

    #[test]
    fn tc_an_002_rejects_hash_path_and_model_tampering() {
        let staging = root("tamper");
        let expected = expectation();
        prepare_valid(&staging, &expected);
        fs::write(staging.join("vocals.wav"), b"tampered").expect("tamper should write");
        assert!(validate_analysis(&staging, &expected).is_err());

        prepare_valid(&staging, &expected);
        let mut manifest: AnalysisManifest =
            read_limited_json(&staging.join("analysis.json"), MANIFEST_LIMIT_BYTES)
                .expect("manifest should read");
        manifest.artifacts[0].relative_path = "../escape.wav".to_owned();
        fs::write(
            staging.join("analysis.json"),
            serde_json::to_vec(&manifest).expect("serialize"),
        )
        .expect("manifest should write");
        assert!(validate_analysis(&staging, &expected).is_err());

        prepare_valid(&staging, &expected);
        let mut wrong_model = expected.clone();
        wrong_model
            .models
            .get_mut("fixture")
            .expect("model")
            .version = "2.0.0".to_owned();
        assert!(validate_analysis(&staging, &wrong_model).is_err());
        let _ = fs::remove_dir_all(staging);
    }

    #[test]
    fn tc_an_003_canonical_fingerprint_changes_for_configuration() {
        let first = serde_json::json!({"schemaVersion": 1, "config": {"threshold": 0.5}});
        let reordered = serde_json::json!({"config": {"threshold": 0.5}, "schemaVersion": 1});
        let changed = serde_json::json!({"schemaVersion": 1, "config": {"threshold": 0.6}});
        assert_eq!(
            analysis_id_for(&first).expect("hash should work"),
            analysis_id_for(&reordered).expect("hash should work")
        );
        assert_ne!(
            analysis_id_for(&first).expect("hash should work"),
            analysis_id_for(&changed).expect("hash should work")
        );
    }
}
