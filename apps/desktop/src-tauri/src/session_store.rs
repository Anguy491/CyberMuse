use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::song_store::{get_song, mark_last_practice_at};
use crate::storage::{read_versioned_json, write_versioned_json};

const MAX_SESSION_BYTES: usize = 16 * 1024 * 1024;
const MAX_SESSION_SAMPLES: usize = 180_000;
const MAX_SESSION_TIME_MS: u64 = 3_600_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetrics {
    pub pitch_accuracy: Option<f64>,
    pub median_absolute_error_cents: Option<f64>,
    pub signed_median_error_cents: Option<f64>,
    pub stability: Option<f64>,
    pub coverage: f64,
    pub valid_frame_count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPitchSample {
    pub time_ms: u64,
    pub user_midi: f64,
    pub reference_midi: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absolute_signed_cents: Option<f64>,
    pub signed_cents: f64,
    pub confidence: f64,
    pub voiced: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopRegion {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeTake {
    pub take_id: String,
    pub loop_region: Option<LoopRegion>,
    pub started_at_song_time_ms: u64,
    pub ended_at_song_time_ms: u64,
    pub observations: Vec<SessionPitchSample>,
    pub metrics: SessionMetrics,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeSession {
    pub schema_version: u32,
    pub scoring_version: String,
    #[serde(default = "default_pitch_evaluation_mode")]
    pub pitch_evaluation_mode: String,
    pub session_id: String,
    pub song_id: String,
    pub analysis_id: String,
    pub started_at: String,
    pub ended_at: String,
    pub input_device_fingerprint: Option<String>,
    pub output_device_fingerprint: Option<String>,
    pub applied_latency_ms: i64,
    pub latency_source: String,
    pub takes: Vec<PracticeTake>,
    pub metrics: SessionMetrics,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub song_id: String,
    pub started_at: String,
    pub ended_at: String,
    pub duration_ms: u64,
    pub take_count: usize,
    pub pitch_evaluation_mode: String,
    pub metrics: SessionMetrics,
}

fn default_pitch_evaluation_mode() -> String {
    "absolute".to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnavailableRange {
    pub start_ms: u64,
    pub end_ms: u64,
    pub reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReview {
    pub session: PracticeSession,
    pub unavailable_ranges: Vec<UnavailableRange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStoreError {
    pub code: &'static str,
    pub message_key: &'static str,
    pub retryable: bool,
    pub safe_details: BTreeMap<String, String>,
    pub diagnostic_id: String,
}

impl SessionStoreError {
    fn new(code: &'static str, message_key: &'static str, retryable: bool) -> Self {
        Self {
            code,
            message_key,
            retryable,
            safe_details: BTreeMap::new(),
            diagnostic_id: format!("session-store-{}", std::process::id()),
        }
    }

    fn invalid(reason: &'static str) -> Self {
        let mut error = Self::new("SESSION_INVALID", "session.error.invalid", false);
        error
            .safe_details
            .insert("reason".to_owned(), reason.to_owned());
        error
    }

    fn io(operation: &'static str) -> Self {
        let mut error = Self::new("SESSION_STORE_UNAVAILABLE", "session.error.store", true);
        error
            .safe_details
            .insert("operation".to_owned(), operation.to_owned());
        error
    }

    fn not_found() -> Self {
        Self::new("SESSION_NOT_FOUND", "session.error.notFound", false)
    }
}

pub fn save_session(app_root: &Path, session: &PracticeSession) -> Result<(), SessionStoreError> {
    validate_session(session)?;
    let bytes = serde_json::to_vec(session).map_err(|_| SessionStoreError::invalid("json"))?;
    if bytes.len() > MAX_SESSION_BYTES {
        return Err(SessionStoreError::new(
            "PAYLOAD_TOO_LARGE",
            "session.error.payloadTooLarge",
            false,
        ));
    }

    let song = get_song(app_root, &session.song_id)
        .map_err(|_| SessionStoreError::invalid("song_reference"))?;
    let analysis_root = song_root(app_root, &session.song_id)
        .join("analyses")
        .join(&session.analysis_id);
    if !analysis_root.join("analysis.json").is_file()
        || song.active_analysis_id.as_deref() != Some(session.analysis_id.as_str())
    {
        return Err(SessionStoreError::invalid("analysis_reference"));
    }

    let sessions_root = song_root(app_root, &session.song_id).join("sessions");
    fs::create_dir_all(&sessions_root).map_err(|_| SessionStoreError::io("create_sessions"))?;
    let path = sessions_root.join(format!("{}.json", session.session_id));
    if path.exists() {
        let existing: PracticeSession =
            read_versioned_json(&path).map_err(|_| SessionStoreError::invalid("existing"))?;
        if existing == *session {
            return Ok(());
        }
        return Err(SessionStoreError::invalid("session_id_conflict"));
    }
    write_versioned_json(&path, session).map_err(|_| SessionStoreError::io("write_session"))?;
    if mark_last_practice_at(app_root, &session.song_id, &session.ended_at).is_err() {
        let _ignored = fs::remove_file(&path);
        return Err(SessionStoreError::io("update_song_index"));
    }
    Ok(())
}

pub fn get_session(
    app_root: &Path,
    session_id: &str,
) -> Result<PracticeSession, SessionStoreError> {
    validate_uuid(session_id)?;
    let path = find_session(app_root, session_id)?.ok_or_else(SessionStoreError::not_found)?;
    let session: PracticeSession =
        read_versioned_json(&path).map_err(|_| SessionStoreError::invalid("stored_document"))?;
    validate_session(&session)?;
    Ok(session)
}

pub fn get_session_review(
    app_root: &Path,
    session_id: &str,
) -> Result<SessionReview, SessionStoreError> {
    validate_uuid(session_id)?;
    let path = find_session(app_root, session_id)?.ok_or_else(SessionStoreError::not_found)?;
    let bytes = fs::read(path).map_err(|_| SessionStoreError::io("read_session"))?;
    let mut value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| SessionStoreError::invalid("stored_document"))?;
    if value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
    {
        return Err(SessionStoreError::invalid("stored_schema"));
    }
    let scoring_version = value
        .get("scoringVersion")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| SessionStoreError::invalid("stored_scoring_version"))?
        .to_owned();
    let mut unavailable_ranges = Vec::new();
    let takes = value
        .get_mut("takes")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| SessionStoreError::invalid("stored_takes"))?;
    takes.retain_mut(|take| {
        let start_ms = take
            .get("startedAtSongTimeMs")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let end_ms = take
            .get("endedAtSongTimeMs")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(start_ms.saturating_add(20));
        let Some(observations) = take
            .get_mut("observations")
            .and_then(serde_json::Value::as_array_mut)
        else {
            unavailable_ranges.push(UnavailableRange {
                start_ms,
                end_ms: end_ms.max(start_ms.saturating_add(20)),
                reason: "take_observations_unavailable",
            });
            return false;
        };
        let mut last_valid_time = start_ms;
        observations.retain(|observation| {
            let sample = serde_json::from_value::<SessionPitchSample>(observation.clone());
            match sample {
                Ok(sample) if valid_sample(&sample, &scoring_version) => {
                    last_valid_time = sample.time_ms;
                    true
                }
                _ => {
                    unavailable_ranges.push(UnavailableRange {
                        start_ms: last_valid_time,
                        end_ms: last_valid_time.saturating_add(20).min(end_ms.max(20)),
                        reason: "pitch_sample_unavailable",
                    });
                    false
                }
            }
        });
        true
    });
    let session: PracticeSession =
        serde_json::from_value(value).map_err(|_| SessionStoreError::invalid("stored_document"))?;
    validate_session_with_count(&session, false)?;
    Ok(SessionReview {
        session,
        unavailable_ranges,
    })
}

pub fn list_sessions(
    app_root: &Path,
    song_id: &str,
) -> Result<Vec<SessionSummary>, SessionStoreError> {
    if !is_sha256(song_id) {
        return Err(SessionStoreError::invalid("song_id"));
    }
    get_song(app_root, song_id).map_err(|_| SessionStoreError::invalid("song_reference"))?;
    let root = song_root(app_root, song_id).join("sessions");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut summaries = Vec::new();
    for entry in fs::read_dir(&root).map_err(|_| SessionStoreError::io("list_sessions"))? {
        let entry = entry.map_err(|_| SessionStoreError::io("list_session_entry"))?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let session: PracticeSession = read_versioned_json(&entry.path())
            .map_err(|_| SessionStoreError::invalid("stored_document"))?;
        validate_session(&session)?;
        summaries.push(SessionSummary {
            session_id: session.session_id,
            song_id: session.song_id,
            started_at: session.started_at,
            ended_at: session.ended_at,
            duration_ms: session_duration_ms(&session.takes),
            take_count: session.takes.len(),
            pitch_evaluation_mode: session.pitch_evaluation_mode,
            metrics: session.metrics,
        });
    }
    summaries.sort_by(|left, right| {
        right
            .started_at
            .cmp(&left.started_at)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    Ok(summaries)
}

pub fn delete_session(app_root: &Path, session_id: &str) -> Result<(), SessionStoreError> {
    validate_uuid(session_id)?;
    let path = find_session(app_root, session_id)?.ok_or_else(SessionStoreError::not_found)?;
    fs::remove_file(path).map_err(|_| SessionStoreError::io("delete_session"))
}

fn find_session(app_root: &Path, session_id: &str) -> Result<Option<PathBuf>, SessionStoreError> {
    let songs_root = app_root.join("data").join("songs");
    if !songs_root.exists() {
        return Ok(None);
    }
    for entry in fs::read_dir(songs_root).map_err(|_| SessionStoreError::io("list_songs"))? {
        let entry = entry.map_err(|_| SessionStoreError::io("list_song_entry"))?;
        let song_id = entry.file_name().to_string_lossy().into_owned();
        if !is_sha256(&song_id) {
            continue;
        }
        let candidate = entry
            .path()
            .join("sessions")
            .join(format!("{session_id}.json"));
        if candidate.is_file() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn validate_session(session: &PracticeSession) -> Result<(), SessionStoreError> {
    validate_session_with_count(session, true)
}

fn validate_session_with_count(
    session: &PracticeSession,
    require_exact_sample_count: bool,
) -> Result<(), SessionStoreError> {
    let legacy_scoring = session.scoring_version == "1.0.0";
    let current_scoring = session.scoring_version == "1.1.0";
    if session.schema_version != 1
        || (!legacy_scoring && !current_scoring)
        || !matches!(
            session.pitch_evaluation_mode.as_str(),
            "absolute" | "octaveFolded"
        )
        || (legacy_scoring && session.pitch_evaluation_mode != "absolute")
        || validate_uuid(&session.session_id).is_err()
        || !is_sha256(&session.song_id)
        || !is_analysis_id(&session.analysis_id)
        || !is_iso_utc(&session.started_at)
        || !is_iso_utc(&session.ended_at)
        || session.ended_at < session.started_at
        || session
            .input_device_fingerprint
            .as_ref()
            .is_some_and(|value| !is_sha256(value))
        || session
            .output_device_fingerprint
            .as_ref()
            .is_some_and(|value| !is_sha256(value))
        || !matches!(
            session.latency_source.as_str(),
            "measured" | "manual" | "none"
        )
        || match session.latency_source.as_str() {
            "measured" => {
                !(0..=2_000).contains(&session.applied_latency_ms)
                    || session.input_device_fingerprint.is_none()
                    || session.output_device_fingerprint.is_none()
            }
            "manual" => {
                !(-250..=500).contains(&session.applied_latency_ms)
                    || session.input_device_fingerprint.is_none()
                    || session.output_device_fingerprint.is_none()
            }
            "none" => session.applied_latency_ms != 0,
            _ => true,
        }
        || !valid_metrics(&session.metrics)
    {
        return Err(SessionStoreError::invalid("fields"));
    }

    let mut take_ids = HashSet::new();
    let mut sample_count = 0_usize;
    for take in &session.takes {
        if take.take_id.is_empty()
            || take.take_id.len() > 64
            || !take
                .take_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || !take_ids.insert(&take.take_id)
            || take.started_at_song_time_ms > MAX_SESSION_TIME_MS
            || take.ended_at_song_time_ms > MAX_SESSION_TIME_MS
            || take.ended_at_song_time_ms < take.started_at_song_time_ms
            || take.loop_region.as_ref().is_some_and(|region| {
                region.start_ms >= region.end_ms || region.end_ms > MAX_SESSION_TIME_MS
            })
            || !valid_metrics(&take.metrics)
        {
            return Err(SessionStoreError::invalid("take"));
        }
        for observation in &take.observations {
            if !valid_sample(observation, &session.scoring_version) {
                return Err(SessionStoreError::invalid("observation"));
            }
        }
        sample_count = sample_count.saturating_add(take.observations.len());
    }
    if sample_count > MAX_SESSION_SAMPLES
        || require_exact_sample_count && session.metrics.valid_frame_count as usize != sample_count
    {
        return Err(SessionStoreError::invalid("sample_count"));
    }
    Ok(())
}

fn valid_sample(observation: &SessionPitchSample, scoring_version: &str) -> bool {
    observation.time_ms <= MAX_SESSION_TIME_MS
        && observation.user_midi.is_finite()
        && observation.reference_midi.is_finite()
        && match scoring_version {
            "1.0.0" => observation.absolute_signed_cents.is_none_or(f64::is_finite),
            "1.1.0" => observation
                .absolute_signed_cents
                .is_some_and(f64::is_finite),
            _ => false,
        }
        && observation.signed_cents.is_finite()
        && observation.confidence.is_finite()
        && (0.0..=1.0).contains(&observation.confidence)
        && observation.voiced
}

fn valid_metrics(metrics: &SessionMetrics) -> bool {
    metrics.pitch_accuracy.is_none_or(valid_score)
        && metrics
            .median_absolute_error_cents
            .is_none_or(|value| value.is_finite() && value >= 0.0)
        && metrics.signed_median_error_cents.is_none_or(f64::is_finite)
        && metrics.stability.is_none_or(valid_score)
        && valid_score(metrics.coverage)
        && metrics.valid_frame_count <= MAX_SESSION_SAMPLES as u64
}

fn valid_score(value: f64) -> bool {
    value.is_finite() && (0.0..=100.0).contains(&value)
}

fn session_duration_ms(takes: &[PracticeTake]) -> u64 {
    let minimum = takes.iter().map(|take| take.started_at_song_time_ms).min();
    let maximum = takes.iter().map(|take| take.ended_at_song_time_ms).max();
    match (minimum, maximum) {
        (Some(start), Some(end)) => end.saturating_sub(start),
        _ => 0,
    }
}

fn song_root(app_root: &Path, song_id: &str) -> PathBuf {
    app_root.join("data").join("songs").join(song_id)
}

fn validate_uuid(value: &str) -> Result<(), SessionStoreError> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[14] == b'4'
        && bytes[18] == b'-'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes[23] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit());
    if valid {
        Ok(())
    } else {
        Err(SessionStoreError::invalid("session_id"))
    }
}

fn is_iso_utc(value: &str) -> bool {
    value.len() >= 20
        && value.ends_with('Z')
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value.as_bytes().get(10) == Some(&b'T')
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use crate::song_store::{Song, SongStatus};

    use super::*;

    static SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "cybermuse-m6-session-{label}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn prepare_song(app_root: &Path) -> (String, String) {
        let song_id = "a".repeat(64);
        let analysis_id = "b".repeat(32);
        let song_root = song_root(app_root, &song_id);
        fs::create_dir_all(song_root.join("analyses").join(&analysis_id)).expect("analysis root");
        fs::write(song_root.join("original.wav"), b"audio").expect("original");
        fs::write(
            song_root
                .join("analyses")
                .join(&analysis_id)
                .join("analysis.json"),
            b"{}",
        )
        .expect("analysis");
        let song = Song {
            schema_version: 1,
            song_id: song_id.clone(),
            display_name: "Session Fixture".to_owned(),
            source_extension: "wav".to_owned(),
            original_relative_path: "original.wav".to_owned(),
            duration_ms: 10_000,
            imported_at: "2026-08-26T00:00:00Z".to_owned(),
            updated_at: "2026-08-26T00:00:00Z".to_owned(),
            status: SongStatus::Ready,
            active_analysis_id: Some(analysis_id.clone()),
            last_practice_at: None,
        };
        write_versioned_json(&song_root.join("song.json"), &song).expect("song");
        (song_id, analysis_id)
    }

    fn metrics(count: u64) -> SessionMetrics {
        SessionMetrics {
            pitch_accuracy: Some(100.0),
            median_absolute_error_cents: Some(4.0),
            signed_median_error_cents: Some(-2.0),
            stability: Some(92.0),
            coverage: 80.0,
            valid_frame_count: count,
        }
    }

    fn session(song_id: String, analysis_id: String) -> PracticeSession {
        PracticeSession {
            schema_version: 1,
            scoring_version: "1.1.0".to_owned(),
            pitch_evaluation_mode: "absolute".to_owned(),
            session_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            song_id,
            analysis_id,
            started_at: "2026-08-26T01:00:00Z".to_owned(),
            ended_at: "2026-08-26T01:00:10Z".to_owned(),
            input_device_fingerprint: Some("c".repeat(64)),
            output_device_fingerprint: Some("d".repeat(64)),
            applied_latency_ms: 42,
            latency_source: "measured".to_owned(),
            takes: vec![PracticeTake {
                take_id: "take-0001".to_owned(),
                loop_region: Some(LoopRegion {
                    start_ms: 1_000,
                    end_ms: 2_000,
                }),
                started_at_song_time_ms: 1_000,
                ended_at_song_time_ms: 2_000,
                observations: vec![SessionPitchSample {
                    time_ms: 1_500,
                    user_midi: 69.0,
                    reference_midi: 69.02,
                    absolute_signed_cents: Some(-2.0),
                    signed_cents: -2.0,
                    confidence: 0.99,
                    voiced: true,
                }],
                metrics: metrics(1),
            }],
            metrics: metrics(1),
        }
    }

    #[test]
    fn tc_ses_001_saves_lists_restarts_and_deletes() {
        let app_root = root("roundtrip");
        let (song_id, analysis_id) = prepare_song(&app_root);
        let session = session(song_id.clone(), analysis_id);
        save_session(&app_root, &session).expect("save");
        save_session(&app_root, &session).expect("idempotent retry");
        assert_eq!(
            get_session(&app_root, &session.session_id).expect("get"),
            session
        );
        let summaries = list_sessions(&app_root, &song_id).expect("list");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].take_count, 1);
        assert_eq!(
            get_song(&app_root, &song_id)
                .expect("song")
                .last_practice_at
                .as_deref(),
            Some("2026-08-26T01:00:10Z")
        );
        delete_session(&app_root, &session.session_id).expect("delete");
        assert!(
            list_sessions(&app_root, &song_id)
                .expect("empty")
                .is_empty()
        );
        let _ignored = fs::remove_dir_all(app_root);
    }

    #[test]
    fn tc_ses_001_rejects_invalid_reference_and_sample_count() {
        let app_root = root("invalid");
        let (song_id, analysis_id) = prepare_song(&app_root);
        let mut invalid = session(song_id, analysis_id);
        invalid.metrics.valid_frame_count = 2;
        assert_eq!(
            save_session(&app_root, &invalid).expect_err("count").code,
            "SESSION_INVALID"
        );
        invalid.metrics.valid_frame_count = 1;
        invalid.analysis_id = "e".repeat(32);
        assert_eq!(
            save_session(&app_root, &invalid)
                .expect_err("analysis reference")
                .code,
            "SESSION_INVALID"
        );
        let _ignored = fs::remove_dir_all(app_root);
    }

    #[test]
    fn tc_rev_001_salvages_summary_when_one_pitch_sample_is_corrupt() {
        let app_root = root("partial-review");
        let (song_id, analysis_id) = prepare_song(&app_root);
        let session = session(song_id, analysis_id);
        save_session(&app_root, &session).expect("save");
        let path = song_root(&app_root, &session.song_id)
            .join("sessions")
            .join(format!("{}.json", session.session_id));
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).expect("read")).expect("json");
        value["takes"][0]["observations"][0]["confidence"] =
            serde_json::Value::String("corrupt".to_owned());
        fs::write(&path, serde_json::to_vec_pretty(&value).expect("serialize")).expect("corrupt");

        assert!(get_session(&app_root, &session.session_id).is_err());
        let review = get_session_review(&app_root, &session.session_id).expect("partial review");
        assert_eq!(review.session.metrics.valid_frame_count, 1);
        assert!(review.session.takes[0].observations.is_empty());
        assert_eq!(review.unavailable_ranges.len(), 1);
        let _ignored = fs::remove_dir_all(app_root);
    }

    #[test]
    fn tc_lat_001_accepts_manual_negative_offset_and_rejects_invalid_sources() {
        let app_root = root("manual-latency");
        let (song_id, analysis_id) = prepare_song(&app_root);
        let mut candidate = session(song_id, analysis_id);
        candidate.latency_source = "manual".to_owned();
        candidate.applied_latency_ms = -125;
        validate_session(&candidate).expect("negative manual offset");

        candidate.applied_latency_ms = -251;
        assert_eq!(
            validate_session(&candidate)
                .expect_err("manual lower bound")
                .code,
            "SESSION_INVALID"
        );
        candidate.applied_latency_ms = 0;
        candidate.latency_source = "none".to_owned();
        validate_session(&candidate).expect("zero none offset");
        candidate.applied_latency_ms = 1;
        assert_eq!(
            validate_session(&candidate)
                .expect_err("none must be zero")
                .code,
            "SESSION_INVALID"
        );
        let _ignored = fs::remove_dir_all(app_root);
    }

    #[test]
    fn tc_ses_001_accepts_legacy_absolute_and_requires_current_raw_error() {
        let app_root = root("scoring-compatibility");
        let (song_id, analysis_id) = prepare_song(&app_root);
        let mut legacy = session(song_id, analysis_id);
        legacy.scoring_version = "1.0.0".to_owned();
        legacy.pitch_evaluation_mode = "absolute".to_owned();
        legacy.takes[0].observations[0].absolute_signed_cents = None;
        validate_session(&legacy).expect("legacy absolute session");

        legacy.pitch_evaluation_mode = "octaveFolded".to_owned();
        assert_eq!(
            validate_session(&legacy)
                .expect_err("legacy mode must be absolute")
                .code,
            "SESSION_INVALID"
        );

        let mut current = legacy;
        current.scoring_version = "1.1.0".to_owned();
        assert_eq!(
            validate_session(&current)
                .expect_err("current samples require absolute cents")
                .code,
            "SESSION_INVALID"
        );
        current.takes[0].observations[0].absolute_signed_cents = Some(-2.0);
        validate_session(&current).expect("current folded session");
        let _ignored = fs::remove_dir_all(app_root);
    }
}
