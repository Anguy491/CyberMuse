use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::analysis_coordinator::{
    AnalysisCoordinator, AnalyzerJob, CoordinatorError, EventSink, StartAnalysisResult,
    cleanup_abandoned_staging, default_abandoned_age, new_job_id,
};
use crate::analyzer_request::{
    AnalyzerConfig, AnalyzerRequest, ApprovedRoots, ModelInput, ToolInput, analysis_id,
};
use crate::model_manager::{
    ModelError, ModelInstallProgress, ModelStatus, install_model_controlled, model_catalog,
    model_statuses, remove_model as remove_model_asset,
};
use crate::runtime_manifest::bundled_sha256;
use crate::storage::{read_versioned_json, resolve_relative, write_versioned_json};
use crate::tool_manager::{ToolError, validate_bundled_ffmpeg};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionedRequest {
    api_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAnalysisRequest {
    api_version: u32,
    song_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisJobRequest {
    api_version: u32,
    job_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequest {
    api_version: u32,
    model_id: String,
    version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallModelRequest {
    api_version: u32,
    model_id: String,
    version: String,
    consent_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    code: String,
    message_key: String,
    retryable: bool,
    safe_details: BTreeMap<String, String>,
    diagnostic_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum CommandResult<T: Serialize> {
    Success {
        #[serde(rename = "apiVersion")]
        api_version: u32,
        ok: bool,
        data: T,
    },
    Failure {
        #[serde(rename = "apiVersion")]
        api_version: u32,
        ok: bool,
        error: ApiError,
    },
}

impl<T: Serialize> CommandResult<T> {
    fn success(data: T) -> Self {
        Self::Success {
            api_version: 1,
            ok: true,
            data,
        }
    }

    fn failure(error: impl Into<ApiError>) -> Self {
        Self::Failure {
            api_version: 1,
            ok: false,
            error: error.into(),
        }
    }

    fn unsupported() -> Self {
        Self::failure(ApiError::new(
            "API_VERSION_UNSUPPORTED",
            "api.error.versionUnsupported",
            false,
        ))
    }
}

impl ApiError {
    fn new(code: &str, message_key: &str, retryable: bool) -> Self {
        Self {
            code: code.to_owned(),
            message_key: message_key.to_owned(),
            retryable,
            safe_details: BTreeMap::new(),
            diagnostic_id: format!("tauri-api-{}", std::process::id()),
        }
    }

    fn invalid(reason: &str) -> Self {
        let mut error = Self::new(
            "ANALYZER_INVALID_REQUEST",
            "analyzer.error.invalidRequest",
            false,
        );
        error
            .safe_details
            .insert("reason".to_owned(), reason.to_owned());
        error
    }
}

impl From<CoordinatorError> for ApiError {
    fn from(value: CoordinatorError) -> Self {
        Self {
            code: value.code.to_owned(),
            message_key: value.message_key.to_owned(),
            retryable: value.retryable,
            safe_details: value.safe_details,
            diagnostic_id: value.diagnostic_id,
        }
    }
}

impl From<ModelError> for ApiError {
    fn from(value: ModelError) -> Self {
        Self {
            code: value.code.to_owned(),
            message_key: value.message_key.to_owned(),
            retryable: value.retryable,
            safe_details: value.safe_details,
            diagnostic_id: value.diagnostic_id,
        }
    }
}

impl From<ToolError> for ApiError {
    fn from(value: ToolError) -> Self {
        Self {
            code: value.code.to_owned(),
            message_key: value.message_key.to_owned(),
            retryable: value.retryable,
            safe_details: value.safe_details,
            diagnostic_id: value.diagnostic_id,
        }
    }
}

pub struct RuntimeState {
    app_root: PathBuf,
    resource_root: PathBuf,
    coordinator: AnalysisCoordinator,
    model_jobs: Arc<Mutex<HashMap<String, ModelJobControl>>>,
    sink: EventSink,
}

struct ModelJobControl {
    model_id: String,
    version: String,
    cancel: Arc<AtomicBool>,
    terminal: bool,
}

pub fn initialize(app: &AppHandle) -> Result<RuntimeState, String> {
    let app_root = app
        .path()
        .local_data_dir()
        .map_err(|_| "local data root unavailable".to_owned())?
        .join("CyberMuse");
    let resource_root = app
        .path()
        .resource_dir()
        .map_err(|_| "resource root unavailable".to_owned())?;
    fs::create_dir_all(app_root.join("data").join("songs"))
        .map_err(|_| "data root unavailable".to_owned())?;
    fs::create_dir_all(app_root.join("models")).map_err(|_| "model root unavailable".to_owned())?;
    let staging_root = app_root.join("tmp").join("jobs");
    fs::create_dir_all(&staging_root).map_err(|_| "staging root unavailable".to_owned())?;
    let _removed = cleanup_abandoned_staging(&staging_root, default_abandoned_age(), &[])
        .map_err(|_| "staging recovery failed".to_owned())?;

    let app_handle = app.clone();
    let sink: EventSink = Arc::new(move |event, payload| {
        let _ignored = app_handle.emit(event, payload.clone());
    });
    let analyzer = resource_root
        .join("analyzer")
        .join("cybermuse-analyzer.exe");
    Ok(RuntimeState {
        app_root,
        resource_root,
        coordinator: AnalysisCoordinator::new(analyzer, Arc::clone(&sink)),
        model_jobs: Arc::new(Mutex::new(HashMap::new())),
        sink,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsResponse {
    models: Vec<ModelStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobResponse {
    job: AnalyzerJob,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelJobResponse {
    job_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveModelResponse {
    removed: bool,
    reclaimed_bytes: u64,
}

#[tauri::command]
pub fn get_model_status(
    request: VersionedRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<ModelsResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    CommandResult::success(ModelsResponse {
        models: model_statuses(&state.app_root.join("models")),
    })
}

#[tauri::command]
pub fn install_model(
    request: InstallModelRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<ModelJobResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    let Some(entry) = model_catalog()
        .into_iter()
        .find(|entry| entry.model_id == request.model_id && entry.version == request.version)
    else {
        return CommandResult::failure(ApiError::new(
            "MODEL_NOT_APPROVED",
            "model.error.notApproved",
            false,
        ));
    };
    if request.consent_token != entry.sha256 {
        return CommandResult::failure(ApiError::new(
            "MODEL_CONSENT_REQUIRED",
            "model.error.consentRequired",
            false,
        ));
    }
    {
        let jobs = state
            .model_jobs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if jobs.values().any(|job| {
            !job.terminal && job.model_id == request.model_id && job.version == request.version
        }) {
            return CommandResult::failure(ApiError::new(
                "MODEL_JOB_ALREADY_ACTIVE",
                "model.error.jobAlreadyActive",
                true,
            ));
        }
    }

    let job_id = new_job_id();
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .model_jobs
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .insert(
            job_id.clone(),
            ModelJobControl {
                model_id: request.model_id.clone(),
                version: request.version.clone(),
                cancel: Arc::clone(&cancel),
                terminal: false,
            },
        );
    let root = state.app_root.clone();
    let jobs = Arc::clone(&state.model_jobs);
    let sink = Arc::clone(&state.sink);
    let thread_job_id = job_id.clone();
    thread::spawn(move || {
        let model_id = request.model_id;
        let result = install_model_controlled(
            &root.join("models"),
            &root.join("tmp").join("downloads"),
            &model_id,
            &request.version,
            &request.consent_token,
            &cancel,
            |progress: ModelInstallProgress| {
                sink(
                    "model://progress",
                    &serde_json::json!({
                        "apiVersion": 1,
                        "jobId": thread_job_id,
                        "modelId": model_id,
                        "downloadedBytes": progress.downloaded_bytes,
                        "totalBytes": progress.total_bytes,
                        "status": progress.status,
                    }),
                );
            },
        );
        let (status, error) = match result {
            Ok(_) => ("installed", None),
            Err(error) if error.code == "MODEL_DOWNLOAD_CANCELLED" => ("cancelled", None),
            Err(error) => ("failed", Some(ApiError::from(error))),
        };
        if let Some(job) = jobs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get_mut(&thread_job_id)
        {
            job.terminal = true;
        }
        sink(
            "model://terminal",
            &serde_json::json!({
                "apiVersion": 1,
                "jobId": thread_job_id,
                "modelId": model_id,
                "status": status,
                "error": error,
            }),
        );
    });
    CommandResult::success(ModelJobResponse { job_id })
}

#[tauri::command]
pub fn cancel_model_install(
    request: AnalysisJobRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<ModelJobResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    let mut jobs = state
        .model_jobs
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let Some(job) = jobs.get_mut(&request.job_id) else {
        return CommandResult::failure(ApiError::new(
            "MODEL_JOB_NOT_FOUND",
            "model.error.jobNotFound",
            false,
        ));
    };
    if job.terminal {
        return CommandResult::failure(ApiError::new(
            "MODEL_JOB_ALREADY_TERMINAL",
            "model.error.jobAlreadyTerminal",
            false,
        ));
    }
    job.cancel.store(true, Ordering::Release);
    CommandResult::success(ModelJobResponse {
        job_id: request.job_id,
    })
}

#[tauri::command]
pub fn remove_model(
    request: ModelRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<RemoveModelResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    if state
        .model_jobs
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .values()
        .any(|job| {
            !job.terminal && job.model_id == request.model_id && job.version == request.version
        })
    {
        return CommandResult::failure(ApiError::new("MODEL_IN_USE", "model.error.inUse", true));
    }
    let reclaimed_bytes = model_statuses(&state.app_root.join("models"))
        .into_iter()
        .find(|status| {
            status.model_id == request.model_id
                && status.version == request.version
                && status.installed
        })
        .map_or(0, |status| status.size_bytes);
    match remove_model_asset(
        &state.app_root.join("models"),
        &request.model_id,
        &request.version,
    ) {
        Ok(removed) => CommandResult::success(RemoveModelResponse {
            removed,
            reclaimed_bytes: if removed { reclaimed_bytes } else { 0 },
        }),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn start_analysis(
    request: StartAnalysisRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<StartAnalysisResult> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    match prepare_analysis_request(&state, &request.song_id).and_then(|prepared| {
        state
            .coordinator
            .start_request(
                &prepared.request_path,
                &prepared.analyses_root,
                Some(&prepared.song_metadata_path),
            )
            .map_err(ApiError::from)
    }) {
        Ok(result) => CommandResult::success(result),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn cancel_analysis(
    request: AnalysisJobRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<JobResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    match state.coordinator.cancel(&request.job_id) {
        Ok(job) => CommandResult::success(JobResponse { job }),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn get_analysis_job(
    request: AnalysisJobRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<JobResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    match state.coordinator.get(&request.job_id) {
        Ok(job) => CommandResult::success(JobResponse { job }),
        Err(error) => CommandResult::failure(error),
    }
}

struct PreparedAnalysis {
    request_path: PathBuf,
    analyses_root: PathBuf,
    song_metadata_path: PathBuf,
}

fn prepare_analysis_request(
    state: &RuntimeState,
    song_id: &str,
) -> Result<PreparedAnalysis, ApiError> {
    if !is_sha256(song_id) {
        return Err(ApiError::invalid("song_id"));
    }
    let song_root = state.app_root.join("data").join("songs").join(song_id);
    let song_metadata_path = song_root.join("song.json");
    let song: serde_json::Value = read_versioned_json(&song_metadata_path)
        .map_err(|_| ApiError::new("SONG_NOT_FOUND", "song.error.notFound", false))?;
    if song.get("songId").and_then(serde_json::Value::as_str) != Some(song_id) {
        return Err(ApiError::invalid("song_identity"));
    }
    let duration_ms = song
        .get("durationMs")
        .and_then(serde_json::Value::as_u64)
        .filter(|duration| (1..=1_200_000).contains(duration))
        .ok_or_else(|| ApiError::invalid("song_duration"))?;
    let original_relative = song
        .get("originalRelativePath")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ApiError::invalid("song_path"))?;
    let input_path = resolve_relative(&song_root, Path::new(original_relative))
        .map_err(|_| ApiError::invalid("song_path"))?
        .canonicalize()
        .map_err(|_| ApiError::new("SOURCE_UNREADABLE", "song.error.unreadable", true))?;

    let model_root = state.app_root.join("models");
    let statuses = model_statuses(&model_root);
    if statuses
        .iter()
        .any(|status| !status.installed || !status.valid)
    {
        return Err(ApiError::new(
            "MODEL_REQUIRED",
            "analyzer.error.modelRequired",
            true,
        ));
    }
    let models = model_catalog()
        .into_iter()
        .map(|entry| {
            let path = model_root
                .join(&entry.model_id)
                .join(&entry.version)
                .join(&entry.artifact_name);
            ModelInput {
                model_id: entry.model_id,
                version: entry.version,
                engine: entry.engine,
                path,
                sha256: entry.sha256,
                license_expression: entry.license_expression,
            }
        })
        .collect::<Vec<_>>();

    let ffmpeg = validate_bundled_ffmpeg(&state.resource_root.join("ffmpeg"))?;
    let spleeter_engine = state
        .resource_root
        .join("spleeter-engine")
        .join("cybermuse-spleeter-engine.exe");
    let spleeter_engine_sha256 = bundled_sha256("spleeter-engine/cybermuse-spleeter-engine.exe")
        .ok_or_else(|| {
            ApiError::new("TOOL_INTEGRITY_FAILED", "tool.error.integrityFailed", false)
        })?;
    let tools = vec![
        ToolInput {
            tool_id: "ffmpeg".to_owned(),
            version: ffmpeg.version.clone(),
            path: ffmpeg.ffmpeg_path,
            sha256: ffmpeg.ffmpeg_sha256,
        },
        ToolInput {
            tool_id: "ffprobe".to_owned(),
            version: ffmpeg.version,
            path: ffmpeg.ffprobe_path,
            sha256: ffmpeg.ffprobe_sha256,
        },
        ToolInput {
            tool_id: "spleeter-engine".to_owned(),
            version: "0.1.0".to_owned(),
            path: spleeter_engine,
            sha256: spleeter_engine_sha256,
        },
    ];

    let staging_root = state.app_root.join("tmp").join("jobs");
    fs::create_dir_all(&staging_root)
        .map_err(|_| ApiError::new("ANALYZER_DISK_FULL", "analyzer.error.storage", true))?;
    let job_id = new_job_id();
    let staging_path = staging_root.join(&job_id);
    fs::create_dir(&staging_path)
        .map_err(|_| ApiError::new("ANALYZER_DISK_FULL", "analyzer.error.storage", true))?;
    let mut analyzer_request = AnalyzerRequest {
        schema_version: 1,
        job_id,
        song_id: song_id.to_owned(),
        requested_analysis_id: "0".repeat(32),
        input_path,
        staging_path: staging_path.clone(),
        expected_duration_ms: duration_ms,
        pipeline_version: "m4-production-v1".to_owned(),
        roots: ApprovedRoots {
            song_root,
            staging_root,
            model_root,
            tool_root: state.resource_root.clone(),
        },
        models,
        tools,
        config: AnalyzerConfig {
            sample_rate_hz: 48_000,
            pitch_min_hz: 65.0,
            pitch_max_hz: 1046.5,
            confidence_threshold: 0.45,
            max_interpolated_gap_ms: 50,
        },
    };
    analyzer_request.requested_analysis_id =
        analysis_id(&analyzer_request).map_err(|_| ApiError::invalid("analysis_id"))?;
    let request_path = staging_path.join("request.json");
    if write_versioned_json(&request_path, &analyzer_request).is_err() {
        let _ignored = fs::remove_dir_all(&staging_path);
        return Err(ApiError::new(
            "ANALYZER_DISK_FULL",
            "analyzer.error.storage",
            true,
        ));
    }
    Ok(PreparedAnalysis {
        request_path,
        analyses_root: song_root_for_analyses(&analyzer_request.roots.song_root),
        song_metadata_path,
    })
}

fn song_root_for_analyses(song_root: &Path) -> PathBuf {
    song_root.join("analyses")
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn api_result_has_stable_envelope() {
        let value = serde_json::to_value(CommandResult::success(ModelJobResponse {
            job_id: "fixture".to_owned(),
        }))
        .expect("response should serialize");
        assert_eq!(value["apiVersion"], 1);
        assert_eq!(value["ok"], true);
        assert_eq!(value["data"]["jobId"], "fixture");
    }

    #[test]
    fn unknown_api_major_is_rejected() {
        let value = serde_json::to_value(CommandResult::<ModelJobResponse>::unsupported())
            .expect("response should serialize");
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "API_VERSION_UNSUPPORTED");
    }

    #[test]
    fn tc_con_001_shared_tauri_payload_fixture_deserializes() {
        let bytes = fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("..")
                .join("fixtures")
                .join("contracts")
                .join("analyzer")
                .join("tauri-payloads-v1-current.json"),
        )
        .expect("shared fixture should read");
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).expect("fixture should parse");
        let start: StartAnalysisRequest = serde_json::from_value(value["startAnalysis"].clone())
            .expect("start payload should deserialize");
        let install: InstallModelRequest = serde_json::from_value(value["installModel"].clone())
            .expect("install payload should deserialize");
        assert_eq!(start.api_version, 1);
        assert!(is_sha256(&start.song_id));
        assert_eq!(install.consent_token.len(), 64);
    }
}
