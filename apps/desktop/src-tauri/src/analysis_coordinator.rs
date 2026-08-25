use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::analysis_store::{AnalysisStoreError, commit_analysis, lookup_cache};
use crate::analyzer_process::{ProcessError, run_analyzer};
use crate::analyzer_protocol::{AnalyzerErrorPayload, AnalyzerStage, ProtocolEvent, Terminal};
use crate::analyzer_request::{AnalyzerRequest, read_and_validate_request, validation_expectation};
use crate::storage::{read_versioned_json, write_versioned_json};

const ABANDONED_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
static JOB_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub type EventSink = Arc<dyn Fn(&str, &serde_json::Value) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalyzerJobStatus {
    Queued,
    Running,
    Cancelling,
    Cancelled,
    Succeeded,
    Failed,
}

impl AnalyzerJobStatus {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Cancelled | Self::Succeeded | Self::Failed)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobError {
    pub schema_version: u32,
    pub code: String,
    pub message_key: String,
    pub stage: Option<AnalyzerStage>,
    pub retryable: bool,
    pub safe_details: BTreeMap<String, serde_json::Value>,
    pub diagnostic_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzerJob {
    pub schema_version: u32,
    pub job_id: String,
    pub song_id: String,
    pub requested_analysis_id: String,
    pub status: AnalyzerJobStatus,
    pub stage: Option<AnalyzerStage>,
    pub stage_progress: f64,
    pub progress: f64,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub error: Option<JobError>,
    pub forced_termination: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAnalysisResult {
    pub job: AnalyzerJob,
    pub cache_hit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinatorError {
    pub code: &'static str,
    pub message_key: &'static str,
    pub retryable: bool,
    pub safe_details: BTreeMap<String, String>,
    pub diagnostic_id: String,
}

impl CoordinatorError {
    fn new(code: &'static str, message_key: &'static str, retryable: bool) -> Self {
        Self {
            code,
            message_key,
            retryable,
            safe_details: BTreeMap::new(),
            diagnostic_id: format!(
                "analysis-coordinator-{}-{}",
                std::process::id(),
                JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ),
        }
    }

    fn active() -> Self {
        Self::new(
            "JOB_ALREADY_ACTIVE",
            "analyzer.error.jobAlreadyActive",
            true,
        )
    }

    fn not_found() -> Self {
        Self::new("JOB_NOT_FOUND", "analyzer.error.jobNotFound", false)
    }

    fn terminal() -> Self {
        Self::new(
            "JOB_ALREADY_TERMINAL",
            "analyzer.error.jobAlreadyTerminal",
            false,
        )
    }
}

impl From<AnalysisStoreError> for CoordinatorError {
    fn from(value: AnalysisStoreError) -> Self {
        Self {
            code: value.code,
            message_key: value.message_key,
            retryable: value.retryable,
            safe_details: value.safe_details.into_iter().collect::<BTreeMap<_, _>>(),
            diagnostic_id: value.diagnostic_id,
        }
    }
}

#[derive(Clone)]
pub struct AnalysisCoordinator {
    analyzer_executable: PathBuf,
    jobs: Arc<Mutex<JobState>>,
    sink: EventSink,
}

#[derive(Default)]
struct JobState {
    jobs: HashMap<String, JobControl>,
    active_by_song: HashMap<String, String>,
}

impl JobState {
    fn try_activate(&mut self, song_id: &str, job_id: &str) -> bool {
        if self.active_by_song.contains_key(song_id) {
            return false;
        }
        self.active_by_song
            .insert(song_id.to_owned(), job_id.to_owned());
        true
    }
}

struct JobControl {
    job: AnalyzerJob,
    cancel: Arc<AtomicBool>,
}

impl AnalysisCoordinator {
    pub fn new(analyzer_executable: PathBuf, sink: EventSink) -> Self {
        Self {
            analyzer_executable,
            jobs: Arc::new(Mutex::new(JobState::default())),
            sink,
        }
    }

    pub fn start_request(
        &self,
        request_path: &Path,
        analyses_root: &Path,
        song_metadata_path: Option<&Path>,
    ) -> Result<StartAnalysisResult, CoordinatorError> {
        let request = read_and_validate_request(request_path)?;
        let expectation = validation_expectation(&request)?;
        let now = timestamp();

        {
            let state = self
                .jobs
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if state.active_by_song.contains_key(&request.song_id) {
                return Err(CoordinatorError::active());
            }
        }

        if lookup_cache(analyses_root, &expectation)?.is_some() {
            if let Some(path) = song_metadata_path {
                update_song(
                    path,
                    Some(&request.requested_analysis_id),
                    SongUpdate::Succeeded,
                )?;
            }
            let job = AnalyzerJob {
                schema_version: 1,
                job_id: request.job_id.clone(),
                song_id: request.song_id,
                requested_analysis_id: request.requested_analysis_id,
                status: AnalyzerJobStatus::Succeeded,
                stage: Some(AnalyzerStage::Write),
                stage_progress: 1.0,
                progress: 1.0,
                started_at: Some(now.clone()),
                completed_at: Some(now),
                error: None,
                forced_termination: false,
            };
            self.insert_terminal(job.clone());
            emit_terminal(&self.sink, &job);
            return Ok(StartAnalysisResult {
                job,
                cache_hit: true,
            });
        }

        let cancel = Arc::new(AtomicBool::new(false));
        let job = AnalyzerJob {
            schema_version: 1,
            job_id: request.job_id.clone(),
            song_id: request.song_id.clone(),
            requested_analysis_id: request.requested_analysis_id.clone(),
            status: AnalyzerJobStatus::Queued,
            stage: None,
            stage_progress: 0.0,
            progress: 0.0,
            started_at: None,
            completed_at: None,
            error: None,
            forced_termination: false,
        };
        {
            let mut state = self
                .jobs
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if !state.try_activate(&request.song_id, &request.job_id) {
                return Err(CoordinatorError::active());
            }
            state.jobs.insert(
                request.job_id.clone(),
                JobControl {
                    job: job.clone(),
                    cancel: Arc::clone(&cancel),
                },
            );
        }

        if let Some(path) = song_metadata_path
            && let Err(error) = update_song(path, None, SongUpdate::Analyzing)
        {
            let mut state = self
                .jobs
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            state.active_by_song.remove(&request.song_id);
            state.jobs.remove(&request.job_id);
            return Err(error.into());
        }

        let coordinator = self.clone();
        let request_path = request_path.to_owned();
        let analyses_root = analyses_root.to_owned();
        let song_metadata_path = song_metadata_path.map(Path::to_owned);
        thread::spawn(move || {
            coordinator.run_job(
                request,
                request_path,
                analyses_root,
                song_metadata_path,
                expectation,
                cancel,
            );
        });
        Ok(StartAnalysisResult {
            job,
            cache_hit: false,
        })
    }

    pub fn cancel(&self, job_id: &str) -> Result<AnalyzerJob, CoordinatorError> {
        let mut state = self
            .jobs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let control = state
            .jobs
            .get_mut(job_id)
            .ok_or_else(CoordinatorError::not_found)?;
        if control.job.status.is_terminal() {
            return Err(CoordinatorError::terminal());
        }
        control.cancel.store(true, Ordering::Release);
        control.job.status = AnalyzerJobStatus::Cancelling;
        Ok(control.job.clone())
    }

    pub fn get(&self, job_id: &str) -> Result<AnalyzerJob, CoordinatorError> {
        self.jobs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .jobs
            .get(job_id)
            .map(|control| control.job.clone())
            .ok_or_else(CoordinatorError::not_found)
    }

    fn insert_terminal(&self, job: AnalyzerJob) {
        self.jobs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .jobs
            .insert(
                job.job_id.clone(),
                JobControl {
                    job,
                    cancel: Arc::new(AtomicBool::new(false)),
                },
            );
    }

    fn run_job(
        &self,
        request: AnalyzerRequest,
        request_path: PathBuf,
        analyses_root: PathBuf,
        song_metadata_path: Option<PathBuf>,
        expectation: crate::analysis_store::ValidationExpectation,
        cancel: Arc<AtomicBool>,
    ) {
        self.mutate_job(&request.job_id, |job| {
            job.status = AnalyzerJobStatus::Running;
            job.started_at = Some(timestamp());
        });
        let jobs = Arc::clone(&self.jobs);
        let sink = Arc::clone(&self.sink);
        let job_id = request.job_id.clone();
        let song_id = request.song_id.clone();
        let result = run_analyzer(
            &self.analyzer_executable,
            &request_path,
            &request.job_id,
            cancel,
            |event| {
                if let ProtocolEvent::Progress {
                    stage,
                    stage_progress,
                    progress,
                } = event
                {
                    let payload = {
                        let mut state = jobs.lock().unwrap_or_else(|poison| poison.into_inner());
                        let Some(control) = state.jobs.get_mut(&job_id) else {
                            return;
                        };
                        control.job.stage = Some(stage);
                        control.job.stage_progress = stage_progress;
                        control.job.progress = progress;
                        serde_json::json!({
                            "apiVersion": 1,
                            "jobId": job_id,
                            "songId": song_id,
                            "stage": stage,
                            "stageProgress": stage_progress,
                            "progress": progress,
                        })
                    };
                    sink("analysis://progress", &payload);
                }
            },
        );

        let (status, error, forced) = match result {
            Ok(run) => match run.terminal {
                Terminal::Completed => match commit_analysis(
                    &request.staging_path,
                    &analyses_root,
                    &request.job_id,
                    &expectation,
                ) {
                    Ok(_) => {
                        if let Some(path) = &song_metadata_path {
                            match update_song(
                                path,
                                Some(&request.requested_analysis_id),
                                SongUpdate::Succeeded,
                            ) {
                                Ok(()) => (AnalyzerJobStatus::Succeeded, None, false),
                                Err(error) => (
                                    AnalyzerJobStatus::Failed,
                                    Some(job_error_from_store(error)),
                                    false,
                                ),
                            }
                        } else {
                            (AnalyzerJobStatus::Succeeded, None, false)
                        }
                    }
                    Err(error) => (
                        AnalyzerJobStatus::Failed,
                        Some(job_error_from_store(error)),
                        false,
                    ),
                },
                Terminal::Failed(error) => (
                    AnalyzerJobStatus::Failed,
                    Some(job_error_from_analyzer(error)),
                    false,
                ),
                Terminal::Cancelled => (AnalyzerJobStatus::Cancelled, None, run.forced_termination),
            },
            Err(error) => (
                AnalyzerJobStatus::Failed,
                Some(job_error_from_process(error)),
                false,
            ),
        };

        if status != AnalyzerJobStatus::Succeeded {
            if let Some(path) = &song_metadata_path {
                let update = if status == AnalyzerJobStatus::Cancelled {
                    SongUpdate::Cancelled
                } else {
                    SongUpdate::Failed
                };
                let _ignored = update_song(path, None, update);
            }
            let _ignored = mark_abandoned(&request.staging_path, status);
        } else {
            let _ignored = fs::remove_dir_all(&request.staging_path);
        }
        self.mutate_job(&request.job_id, |job| {
            job.status = status;
            job.completed_at = Some(timestamp());
            job.error = error;
            job.forced_termination = forced;
            if status == AnalyzerJobStatus::Succeeded {
                job.stage = Some(AnalyzerStage::Write);
                job.stage_progress = 1.0;
                job.progress = 1.0;
            }
        });
        let terminal_job = self.get(&request.job_id).ok();
        {
            let mut state = self
                .jobs
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            state.active_by_song.remove(&request.song_id);
        }
        if let Some(job) = terminal_job {
            emit_terminal(&self.sink, &job);
        }
    }

    fn mutate_job(&self, job_id: &str, mutate: impl FnOnce(&mut AnalyzerJob)) {
        let mut state = self
            .jobs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(control) = state.jobs.get_mut(job_id) {
            mutate(&mut control.job);
        }
    }
}

fn timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

pub fn new_job_id() -> String {
    let sequence = JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut digest = Sha256::new();
    digest.update(std::process::id().to_le_bytes());
    digest.update(sequence.to_le_bytes());
    digest.update(now.to_le_bytes());
    let mut bytes: [u8; 16] = digest.finalize()[..16]
        .try_into()
        .expect("SHA-256 prefix length is fixed");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

pub fn cleanup_abandoned_staging(
    staging_root: &Path,
    maximum_age: Duration,
    active_job_ids: &[String],
) -> Result<usize, CoordinatorError> {
    if !staging_root.exists() {
        return Ok(0);
    }
    let canonical_root = staging_root
        .canonicalize()
        .map_err(|_| CoordinatorError::new("STORE_UNAVAILABLE", "storage.error.io", true))?;
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in fs::read_dir(&canonical_root)
        .map_err(|_| CoordinatorError::new("STORE_UNAVAILABLE", "storage.error.io", true))?
    {
        let entry = entry
            .map_err(|_| CoordinatorError::new("STORE_UNAVAILABLE", "storage.error.io", true))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if active_job_ids.contains(&name) || !looks_like_job_id(&name) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|_| CoordinatorError::new("STORE_UNAVAILABLE", "storage.error.io", true))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let age = now
            .duration_since(metadata.modified().unwrap_or(now))
            .unwrap_or_default();
        if age >= maximum_age {
            let path = entry.path();
            if path.parent() == Some(canonical_root.as_path()) {
                fs::remove_dir_all(path).map_err(|_| {
                    CoordinatorError::new("STORE_UNAVAILABLE", "storage.error.io", true)
                })?;
                removed += 1;
            }
        }
    }
    Ok(removed)
}

fn looks_like_job_id(value: &str) -> bool {
    value.len() == 36
        && value.as_bytes().get(8) == Some(&b'-')
        && value.as_bytes().get(13) == Some(&b'-')
        && value.as_bytes().get(18) == Some(&b'-')
        && value.as_bytes().get(23) == Some(&b'-')
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SongUpdate {
    Analyzing,
    Succeeded,
    Failed,
    Cancelled,
}

fn update_song(
    song_metadata_path: &Path,
    analysis_id: Option<&str>,
    update: SongUpdate,
) -> Result<(), AnalysisStoreError> {
    let mut value: serde_json::Value =
        read_versioned_json(song_metadata_path).map_err(|_| AnalysisStoreError {
            code: "ANALYZER_OUTPUT_INVALID",
            message_key: "analyzer.error.songMetadata",
            retryable: true,
            safe_details: BTreeMap::new(),
            diagnostic_id: format!("song-update-{}", std::process::id()),
        })?;
    let object = value.as_object_mut().ok_or_else(|| AnalysisStoreError {
        code: "ANALYZER_OUTPUT_INVALID",
        message_key: "analyzer.error.songMetadata",
        retryable: true,
        safe_details: BTreeMap::new(),
        diagnostic_id: format!("song-update-{}", std::process::id()),
    })?;
    let has_active = object
        .get("activeAnalysisId")
        .is_some_and(|value| value.as_str().is_some());
    if update == SongUpdate::Succeeded {
        let analysis_id = analysis_id.ok_or_else(|| AnalysisStoreError {
            code: "ANALYZER_OUTPUT_INVALID",
            message_key: "analyzer.error.songMetadata",
            retryable: true,
            safe_details: BTreeMap::new(),
            diagnostic_id: format!("song-update-{}", std::process::id()),
        })?;
        object.insert(
            "activeAnalysisId".to_owned(),
            serde_json::Value::String(analysis_id.to_owned()),
        );
        object.insert(
            "status".to_owned(),
            serde_json::Value::String("ready".to_owned()),
        );
    } else {
        let status = match update {
            SongUpdate::Analyzing => "analyzing",
            SongUpdate::Failed if !has_active => "analysis_failed",
            SongUpdate::Cancelled if !has_active => "needs_analysis",
            SongUpdate::Failed | SongUpdate::Cancelled => "ready",
            SongUpdate::Succeeded => unreachable!("handled above"),
        };
        object.insert(
            "status".to_owned(),
            serde_json::Value::String(status.to_owned()),
        );
    }
    object.insert(
        "updatedAt".to_owned(),
        serde_json::Value::String(timestamp()),
    );
    write_versioned_json(song_metadata_path, &value).map_err(|_| AnalysisStoreError {
        code: "ANALYZER_DISK_FULL",
        message_key: "analyzer.error.storage",
        retryable: true,
        safe_details: BTreeMap::new(),
        diagnostic_id: format!("song-update-{}", std::process::id()),
    })
}

fn mark_abandoned(path: &Path, status: AnalyzerJobStatus) -> Result<(), CoordinatorError> {
    if !path.exists() {
        return Ok(());
    }
    write_versioned_json(
        &path.join("job-state.json"),
        &serde_json::json!({
            "schemaVersion": 1,
            "status": status,
            "completedAt": timestamp(),
        }),
    )
    .map_err(|_| CoordinatorError::new("STORE_UNAVAILABLE", "storage.error.io", true))
}

fn emit_terminal(sink: &EventSink, job: &AnalyzerJob) {
    sink(
        "analysis://terminal",
        &serde_json::json!({"apiVersion": 1, "job": job}),
    );
}

fn job_error_from_analyzer(value: AnalyzerErrorPayload) -> JobError {
    JobError {
        schema_version: 1,
        code: value.code,
        message_key: value.message_key,
        stage: value.stage,
        retryable: value.retryable,
        safe_details: value.safe_details,
        diagnostic_id: value.diagnostic_id,
    }
}

fn job_error_from_process(value: ProcessError) -> JobError {
    JobError {
        schema_version: 1,
        code: value.code.to_owned(),
        message_key: value.message_key.to_owned(),
        stage: None,
        retryable: value.retryable,
        safe_details: value
            .safe_details
            .into_iter()
            .map(|(key, value)| (key, serde_json::Value::String(value)))
            .collect(),
        diagnostic_id: value.diagnostic_id,
    }
}

fn job_error_from_store(value: AnalysisStoreError) -> JobError {
    JobError {
        schema_version: 1,
        code: value.code.to_owned(),
        message_key: value.message_key.to_owned(),
        stage: Some(AnalyzerStage::Write),
        retryable: value.retryable,
        safe_details: value
            .safe_details
            .into_iter()
            .map(|(key, value)| (key, serde_json::Value::String(value)))
            .collect(),
        diagnostic_id: value.diagnostic_id,
    }
}

pub fn default_abandoned_age() -> Duration {
    ABANDONED_AFTER
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "cybermuse-m4-coordinator-{label}-{}-{}",
            std::process::id(),
            JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn tc_an_004_cancel_state_changes_synchronously_and_terminal_is_stable() {
        let coordinator = AnalysisCoordinator::new(PathBuf::new(), Arc::new(|_, _| {}));
        let job_id = new_job_id();
        let song_id = "a".repeat(64);
        let job = AnalyzerJob {
            schema_version: 1,
            job_id: job_id.clone(),
            song_id: song_id.clone(),
            requested_analysis_id: "b".repeat(32),
            status: AnalyzerJobStatus::Running,
            stage: Some(AnalyzerStage::Separate),
            stage_progress: 0.5,
            progress: 0.4,
            started_at: Some(timestamp()),
            completed_at: None,
            error: None,
            forced_termination: false,
        };
        {
            let mut state = coordinator.jobs.lock().expect("state lock");
            state.active_by_song.insert(song_id, job_id.clone());
            state.jobs.insert(
                job_id.clone(),
                JobControl {
                    job,
                    cancel: Arc::new(AtomicBool::new(false)),
                },
            );
        }
        let started = std::time::Instant::now();
        let job = coordinator.cancel(&job_id).expect("cancel should start");
        assert_eq!(job.status, AnalyzerJobStatus::Cancelling);
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(
            coordinator.jobs.lock().expect("state lock").jobs[&job_id]
                .cancel
                .load(Ordering::Acquire)
        );
    }

    #[test]
    fn same_song_cannot_register_two_active_jobs() {
        let mut state = JobState::default();
        let song_id = "a".repeat(64);
        let first_job_id = new_job_id();
        let second_job_id = new_job_id();
        assert!(state.try_activate(&song_id, &first_job_id));
        assert!(!state.try_activate(&song_id, &second_job_id));
        assert_eq!(state.active_by_song.len(), 1);
        assert_eq!(state.active_by_song[&song_id], first_job_id);
    }

    #[test]
    fn startup_cleanup_removes_only_inactive_job_directories() {
        let staging = root("cleanup");
        fs::create_dir_all(&staging).expect("staging root");
        let active = new_job_id();
        let abandoned = new_job_id();
        let unrelated = "not-a-job";
        fs::create_dir(staging.join(&active)).expect("active staging");
        fs::create_dir(staging.join(&abandoned)).expect("abandoned staging");
        fs::create_dir(staging.join(unrelated)).expect("unrelated staging");
        assert_eq!(
            cleanup_abandoned_staging(&staging, Duration::ZERO, std::slice::from_ref(&active))
                .expect("cleanup should pass"),
            1
        );
        assert!(staging.join(active).exists());
        assert!(!staging.join(abandoned).exists());
        assert!(staging.join(unrelated).exists());
        let _ignored = fs::remove_dir_all(staging);
    }

    #[test]
    fn generated_job_id_is_uuid_v4_shaped() {
        let id = new_job_id();
        assert!(looks_like_job_id(&id));
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
    }
}
