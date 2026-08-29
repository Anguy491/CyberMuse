use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::analysis_coordinator::{
    AnalysisCoordinator, AnalyzerJob, CoordinatorError, EventSink, StartAnalysisResult,
    cleanup_abandoned_staging, default_abandoned_age, new_job_id,
};
use crate::analysis_store::{
    AnalysisStoreError, ArtifactKind, ExpectedModel, ValidationExpectation, validate_analysis,
};
use crate::analyzer_request::{
    AnalyzerConfig, AnalyzerRequest, ApprovedRoots, ModelInput, ToolInput, analysis_id,
};
use crate::asset_protocol::ResourceRegistry;
use crate::diagnostics::{
    DiagnosticBundle, DiagnosticContext, DiagnosticError, DiagnosticEvent, DiagnosticPreview,
    append_event, clear_logs, prepare_bundle, prune_logs, write_bundle,
};
use crate::lyrics_store::{
    LyricsCandidatePreview, LyricsDocument, LyricsError, LyricsStatus, LyricsView, commit_document,
    lyrics_status, parse_lrc, read_document, remove_document, update_offset,
};
use crate::model_manager::{
    ModelError, ModelInstallProgress, ModelStatus, install_model_controlled, model_catalog,
    model_statuses, remove_model as remove_model_asset,
};
use crate::session_store::{
    PracticeSession, SessionReview, SessionStoreError, SessionSummary,
    delete_session as delete_session_data, get_session_review as get_session_review_data,
    list_sessions as list_session_data, save_session as save_session_data,
};
use crate::settings_store::{
    AppSettings, AppSettingsPatch, SettingsStoreError, clear_settings as clear_settings_data,
    load_settings, update_settings as update_settings_data,
};
use crate::song_store::{
    DeleteInterruption, DeletePlan, ImportCandidate, ImportCandidateView, ImportInterruption,
    ImportResult, Song, SongStatus, SongStoreError, SongSummary, delete_song as delete_song_data,
    get_song as get_song_data, import_song as import_song_data, inspect_import_candidate,
    list_songs as list_song_data, mark_song_status, prepare_delete as prepare_delete_data,
    recover_interrupted_song_states,
};
use crate::storage::{read_versioned_json, resolve_relative, write_versioned_json};
use crate::storage_overview::{StorageOverview, StorageOverviewError, collect_storage_overview};
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

impl From<SongStoreError> for ApiError {
    fn from(value: SongStoreError) -> Self {
        Self {
            code: value.code.to_owned(),
            message_key: value.message_key.to_owned(),
            retryable: value.retryable,
            safe_details: value.safe_details,
            diagnostic_id: value.diagnostic_id,
        }
    }
}

impl From<LyricsError> for ApiError {
    fn from(value: LyricsError) -> Self {
        Self {
            code: value.code.to_owned(),
            message_key: value.message_key.to_owned(),
            retryable: value.retryable,
            safe_details: value.safe_details,
            diagnostic_id: value.diagnostic_id,
        }
    }
}

impl From<AnalysisStoreError> for ApiError {
    fn from(value: AnalysisStoreError) -> Self {
        Self {
            code: value.code.to_owned(),
            message_key: value.message_key.to_owned(),
            retryable: value.retryable,
            safe_details: value.safe_details,
            diagnostic_id: value.diagnostic_id,
        }
    }
}

impl From<SessionStoreError> for ApiError {
    fn from(value: SessionStoreError) -> Self {
        Self {
            code: value.code.to_owned(),
            message_key: value.message_key.to_owned(),
            retryable: value.retryable,
            safe_details: value.safe_details,
            diagnostic_id: value.diagnostic_id,
        }
    }
}

impl From<SettingsStoreError> for ApiError {
    fn from(value: SettingsStoreError) -> Self {
        Self {
            code: value.code.to_owned(),
            message_key: value.message_key.to_owned(),
            retryable: value.retryable,
            safe_details: value.safe_details,
            diagnostic_id: value.diagnostic_id,
        }
    }
}

impl From<DiagnosticError> for ApiError {
    fn from(value: DiagnosticError) -> Self {
        Self {
            code: value.code.to_owned(),
            message_key: value.message_key.to_owned(),
            retryable: value.retryable,
            safe_details: value.safe_details,
            diagnostic_id: value.diagnostic_id,
        }
    }
}

impl From<StorageOverviewError> for ApiError {
    fn from(value: StorageOverviewError) -> Self {
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
    pending_imports: Arc<Mutex<HashMap<String, PendingImport>>>,
    pending_deletes: Arc<Mutex<HashMap<String, PendingDelete>>>,
    pending_lyrics: Arc<Mutex<HashMap<String, PendingLyrics>>>,
    pending_lyrics_deletes: Arc<Mutex<HashMap<String, PendingLyricsDelete>>>,
    pending_diagnostics: Arc<Mutex<HashMap<String, PendingDiagnostic>>>,
    resources: ResourceRegistry,
    sink: EventSink,
}

struct ModelJobControl {
    model_id: String,
    version: String,
    cancel: Arc<AtomicBool>,
    terminal: bool,
}

struct PendingImport {
    candidate: ImportCandidate,
    expires_at: Instant,
}

struct PendingDelete {
    song_id: String,
    expires_at: Instant,
}

struct PendingLyrics {
    song_id: String,
    document: LyricsDocument,
    expires_at: Instant,
}

struct PendingLyricsDelete {
    song_id: String,
    lyric_id: String,
    expires_at: Instant,
}

struct PendingDiagnostic {
    bundle: DiagnosticBundle,
    expires_at: Instant,
}

pub fn initialize(app: &AppHandle, resources: ResourceRegistry) -> Result<RuntimeState, String> {
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
    fs::create_dir_all(app_root.join("tmp").join("imports"))
        .map_err(|_| "import staging root unavailable".to_owned())?;
    let staging_root = app_root.join("tmp").join("jobs");
    fs::create_dir_all(&staging_root).map_err(|_| "staging root unavailable".to_owned())?;
    let _removed = cleanup_abandoned_staging(&staging_root, default_abandoned_age(), &[])
        .map_err(|_| "staging recovery failed".to_owned())?;
    recover_interrupted_song_states(&app_root).map_err(|_| "song recovery failed".to_owned())?;
    fs::create_dir_all(app_root.join("logs")).map_err(|_| "log root unavailable".to_owned())?;
    prune_logs(&app_root).map_err(|_| "log retention failed".to_owned())?;
    append_event(
        &app_root,
        DiagnosticEvent {
            schema_version: 1,
            recorded_at: String::new(),
            recorded_unix_ms: 0,
            component: "desktop".to_owned(),
            code: "APP_STARTED".to_owned(),
            diagnostic_id: "startup".to_owned(),
            duration_ms: None,
            safe_details: BTreeMap::new(),
        },
    )
    .map_err(|_| "startup log failed".to_owned())?;

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
        pending_imports: Arc::new(Mutex::new(HashMap::new())),
        pending_deletes: Arc::new(Mutex::new(HashMap::new())),
        pending_lyrics: Arc::new(Mutex::new(HashMap::new())),
        pending_lyrics_deletes: Arc::new(Mutex::new(HashMap::new())),
        pending_diagnostics: Arc::new(Mutex::new(HashMap::new())),
        resources,
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmImportRequest {
    api_version: u32,
    candidate_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongRequest {
    api_version: u32,
    song_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmLyricsImportRequest {
    api_version: u32,
    song_id: String,
    candidate_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLyricsOffsetRequest {
    api_version: u32,
    song_id: String,
    lyric_id: String,
    user_offset_ms: i64,
    expected_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveLyricsRequest {
    api_version: u32,
    song_id: String,
    confirmation_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSongRequest {
    api_version: u32,
    song_id: String,
    confirmation_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectImportResponse {
    candidate: Option<ImportCandidateView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongsResponse {
    songs: Vec<SongSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongResponse {
    song: Song,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareDeleteResponse {
    confirmation_token: String,
    plan: DeletePlan,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSongResponse {
    deleted: bool,
    reclaimed_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsCandidate {
    token: String,
    #[serde(flatten)]
    preview: LyricsCandidatePreview,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectLyricsResponse {
    candidate: Option<LyricsCandidate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmLyricsImportResponse {
    lyrics: LyricsView,
    deduplicated: bool,
    replaced: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsResponse {
    lyrics: LyricsView,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareRemoveLyricsResponse {
    confirmation_token: String,
    lyric_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveLyricsResponse {
    removed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeAssetsResponse {
    song_id: String,
    analysis_id: String,
    instrumental_resource_url: String,
    vocals_resource_url: String,
    reference_track: serde_json::Value,
    duration_ms: u64,
    lyrics_status: LyricsStatus,
    lyrics: Option<LyricsView>,
    lyrics_error: Option<ApiError>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePracticeSessionRequest {
    api_version: u32,
    session: PracticeSession,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPracticeSessionsRequest {
    api_version: u32,
    song_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeSessionRequest {
    api_version: u32,
    session_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePracticeSessionResponse {
    session_id: String,
    saved_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeSessionsResponse {
    sessions: Vec<SessionSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePracticeSessionResponse {
    deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAppSettingsRequest {
    api_version: u32,
    patch: AppSettingsPatch,
    expected_revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsResponse {
    settings: AppSettings,
    recovered: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareDiagnosticBundleRequest {
    api_version: u32,
    #[serde(default)]
    context: DiagnosticContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDiagnosticBundleRequest {
    api_version: u32,
    consent_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareDiagnosticBundleResponse {
    consent_token: String,
    preview: DiagnosticPreview,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDiagnosticBundleResponse {
    saved: bool,
    file_name: Option<String>,
    size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearDiagnosticLogsResponse {
    cleared_event_count: usize,
}

const CAPABILITY_LIFETIME: Duration = Duration::from_secs(5 * 60);

#[tauri::command]
pub async fn select_import_file(
    request: VersionedRequest,
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<CommandResult<SelectImportResponse>, ApiError> {
    if request.api_version != 1 {
        return Ok(CommandResult::unsupported());
    }
    let resource_root = state.resource_root.clone();
    let app_root = state.app_root.clone();
    let pending_imports = Arc::clone(&state.pending_imports);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .add_filter("CyberMuse audio", &["mp3", "wav", "flac"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let source_path = selected.into_path().map_err(|_| {
            ApiError::new("SOURCE_UNREADABLE", "import.error.sourceUnreadable", true)
        })?;
        let tools = validate_bundled_ffmpeg(&resource_root.join("ffmpeg"))?;
        inspect_import_candidate(
            new_job_id(),
            source_path,
            &tools.ffmpeg_path,
            &tools.ffprobe_path,
            &app_root,
        )
        .map(Some)
        .map_err(ApiError::from)
    })
    .await;
    Ok(match result {
        Ok(Ok(Some(candidate))) => {
            let view = ImportCandidateView::from(&candidate);
            let mut pending = pending_imports
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            pending.retain(|_, value| value.expires_at > Instant::now());
            pending.insert(
                candidate.token.clone(),
                PendingImport {
                    candidate,
                    expires_at: Instant::now() + CAPABILITY_LIFETIME,
                },
            );
            CommandResult::success(SelectImportResponse {
                candidate: Some(view),
            })
        }
        Ok(Ok(None)) => CommandResult::success(SelectImportResponse { candidate: None }),
        Ok(Err(error)) => CommandResult::failure(error),
        Err(_) => CommandResult::failure(ApiError::new(
            "IMPORT_INTERNAL",
            "import.error.internal",
            true,
        )),
    })
}

#[tauri::command]
pub fn confirm_import(
    request: ConfirmImportRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<ImportResult> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    let candidate = {
        let mut pending = state
            .pending_imports
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        pending.retain(|_, value| value.expires_at > Instant::now());
        pending
            .get(&request.candidate_token)
            .map(|value| value.candidate.clone())
    };
    let Some(candidate) = candidate else {
        return CommandResult::failure(ApiError::new(
            "IMPORT_CONFIRMATION_INVALID",
            "import.error.confirmationInvalid",
            false,
        ));
    };
    let models_ready = model_statuses(&state.app_root.join("models"))
        .iter()
        .all(|model| model.installed && model.valid);
    let initial_status = if models_ready {
        SongStatus::NeedsAnalysis
    } else {
        SongStatus::ModelRequired
    };
    match import_song_data(
        &state.app_root,
        &candidate,
        initial_status,
        ImportInterruption::Never,
    ) {
        Ok(result) => {
            state
                .pending_imports
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .remove(&request.candidate_token);
            CommandResult::success(result)
        }
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn list_songs(
    request: VersionedRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<SongsResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    match list_song_data(&state.app_root) {
        Ok(songs) => CommandResult::success(SongsResponse { songs }),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn get_song(
    request: SongRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<SongResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    match get_song_data(&state.app_root, &request.song_id) {
        Ok(song) => CommandResult::success(SongResponse { song }),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn prepare_delete_song(
    request: SongRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<PrepareDeleteResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    match prepare_delete_data(&state.app_root, &request.song_id) {
        Ok(plan) => {
            let confirmation_token = new_job_id();
            let mut pending = state
                .pending_deletes
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            pending.retain(|_, value| value.expires_at > Instant::now());
            pending.insert(
                confirmation_token.clone(),
                PendingDelete {
                    song_id: request.song_id,
                    expires_at: Instant::now() + CAPABILITY_LIFETIME,
                },
            );
            CommandResult::success(PrepareDeleteResponse {
                confirmation_token,
                plan,
            })
        }
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn delete_song(
    request: DeleteSongRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<DeleteSongResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    let valid = {
        let mut pending = state
            .pending_deletes
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        pending.retain(|_, value| value.expires_at > Instant::now());
        pending
            .get(&request.confirmation_token)
            .is_some_and(|value| {
                value.song_id == request.song_id && value.expires_at > Instant::now()
            })
    };
    if !valid {
        return CommandResult::failure(ApiError::new(
            "CONFIRMATION_INVALID",
            "song.error.confirmationInvalid",
            false,
        ));
    }

    if let Ok(Some(job)) = state.coordinator.cancel_song(&request.song_id) {
        let deadline = Instant::now() + Duration::from_secs(6);
        while Instant::now() < deadline {
            if state
                .coordinator
                .get(&job.job_id)
                .is_ok_and(|current| current.status.is_terminal())
            {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        if !state
            .coordinator
            .get(&job.job_id)
            .is_ok_and(|current| current.status.is_terminal())
        {
            return CommandResult::failure(ApiError::new(
                "DELETE_ANALYSIS_BUSY",
                "song.error.analysisBusy",
                true,
            ));
        }
    }
    state.resources.revoke_song(&request.song_id);
    match delete_song_data(&state.app_root, &request.song_id, DeleteInterruption::Never) {
        Ok(reclaimed_bytes) => {
            state
                .pending_deletes
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .remove(&request.confirmation_token);
            CommandResult::success(DeleteSongResponse {
                deleted: true,
                reclaimed_bytes,
            })
        }
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub async fn select_lyrics_file(
    request: SongRequest,
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<CommandResult<SelectLyricsResponse>, ApiError> {
    if request.api_version != 1 {
        return Ok(CommandResult::unsupported());
    }
    let song = match get_song_data(&state.app_root, &request.song_id) {
        Ok(song) => song,
        Err(error) => return Ok(CommandResult::failure(error)),
    };
    let song_id = request.song_id;
    let replacing = lyrics_status(&state.app_root, &song_id) != LyricsStatus::None;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .add_filter("LRC lyrics", &["lrc"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let source_path = selected.into_path().map_err(|_| {
            ApiError::new(
                "LYRICS_SOURCE_UNREADABLE",
                "lyrics.error.sourceUnreadable",
                true,
            )
        })?;
        let bytes = fs::read(source_path).map_err(|_| {
            ApiError::new(
                "LYRICS_SOURCE_UNREADABLE",
                "lyrics.error.sourceUnreadable",
                true,
            )
        })?;
        parse_lrc(&song_id, song.duration_ms, &bytes, replacing)
            .map(Some)
            .map_err(ApiError::from)
    })
    .await;
    Ok(match result {
        Ok(Ok(Some((document, preview)))) => {
            let token = new_job_id();
            let mut pending = state
                .pending_lyrics
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            pending.retain(|_, value| value.expires_at > Instant::now());
            pending.insert(
                token.clone(),
                PendingLyrics {
                    song_id: document.song_id.clone(),
                    document,
                    expires_at: Instant::now() + CAPABILITY_LIFETIME,
                },
            );
            CommandResult::success(SelectLyricsResponse {
                candidate: Some(LyricsCandidate { token, preview }),
            })
        }
        Ok(Ok(None)) => CommandResult::success(SelectLyricsResponse { candidate: None }),
        Ok(Err(error)) => CommandResult::failure(error),
        Err(_) => CommandResult::failure(ApiError::new(
            "LYRICS_INTERNAL",
            "lyrics.error.internal",
            true,
        )),
    })
}

#[tauri::command]
pub fn confirm_lyrics_import(
    request: ConfirmLyricsImportRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<ConfirmLyricsImportResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    let document = {
        let mut pending = state
            .pending_lyrics
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        pending.retain(|_, value| value.expires_at > Instant::now());
        pending
            .get(&request.candidate_token)
            .filter(|value| value.song_id == request.song_id)
            .map(|value| value.document.clone())
    };
    let Some(document) = document else {
        return CommandResult::failure(ApiError::new(
            "LYRICS_CONFIRMATION_INVALID",
            "lyrics.error.confirmationInvalid",
            false,
        ));
    };
    match commit_document(&state.app_root, &document) {
        Ok((lyrics, deduplicated, replaced)) => {
            state
                .pending_lyrics
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .remove(&request.candidate_token);
            CommandResult::success(ConfirmLyricsImportResponse {
                lyrics,
                deduplicated,
                replaced,
            })
        }
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn update_lyrics_offset(
    request: UpdateLyricsOffsetRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<LyricsResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    match update_offset(
        &state.app_root,
        &request.song_id,
        &request.lyric_id,
        request.user_offset_ms,
        request.expected_revision,
    ) {
        Ok(lyrics) => CommandResult::success(LyricsResponse { lyrics }),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn prepare_remove_lyrics(
    request: SongRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<PrepareRemoveLyricsResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    match read_document(&state.app_root, &request.song_id) {
        Ok(document) => {
            let confirmation_token = new_job_id();
            let mut pending = state
                .pending_lyrics_deletes
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            pending.retain(|_, value| value.expires_at > Instant::now());
            pending.insert(
                confirmation_token.clone(),
                PendingLyricsDelete {
                    song_id: request.song_id,
                    lyric_id: document.lyric_id.clone(),
                    expires_at: Instant::now() + CAPABILITY_LIFETIME,
                },
            );
            CommandResult::success(PrepareRemoveLyricsResponse {
                confirmation_token,
                lyric_id: document.lyric_id,
            })
        }
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn remove_lyrics(
    request: RemoveLyricsRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<RemoveLyricsResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    let valid = {
        let mut pending = state
            .pending_lyrics_deletes
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        pending.retain(|_, value| value.expires_at > Instant::now());
        pending
            .get(&request.confirmation_token)
            .filter(|value| value.song_id == request.song_id)
            .is_some_and(|value| {
                read_document(&state.app_root, &request.song_id)
                    .is_ok_and(|document| document.lyric_id == value.lyric_id)
            })
    };
    if !valid {
        return CommandResult::failure(ApiError::new(
            "LYRICS_CONFIRMATION_INVALID",
            "lyrics.error.confirmationInvalid",
            false,
        ));
    }
    match remove_document(&state.app_root, &request.song_id) {
        Ok(()) => {
            state
                .pending_lyrics_deletes
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .remove(&request.confirmation_token);
            CommandResult::success(RemoveLyricsResponse { removed: true })
        }
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn get_practice_assets(
    request: SongRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<PracticeAssetsResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    match load_practice_assets(&state, &request.song_id) {
        Ok(assets) => CommandResult::success(assets),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn save_practice_session(
    request: SavePracticeSessionRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<SavePracticeSessionResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    let session_id = request.session.session_id.clone();
    match save_session_data(&state.app_root, &request.session) {
        Ok(()) => CommandResult::success(SavePracticeSessionResponse {
            session_id,
            saved_at: timestamp(),
        }),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn list_practice_sessions(
    request: ListPracticeSessionsRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<PracticeSessionsResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    match list_session_data(&state.app_root, &request.song_id) {
        Ok(sessions) => CommandResult::success(PracticeSessionsResponse { sessions }),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn get_practice_session(
    request: PracticeSessionRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<SessionReview> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    match get_session_review_data(&state.app_root, &request.session_id) {
        Ok(review) => CommandResult::success(review),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn delete_practice_session(
    request: PracticeSessionRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<DeletePracticeSessionResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    match delete_session_data(&state.app_root, &request.session_id) {
        Ok(()) => CommandResult::success(DeletePracticeSessionResponse { deleted: true }),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn get_app_settings(
    request: VersionedRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<AppSettingsResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    match load_settings(&state.app_root) {
        Ok((settings, recovered)) => CommandResult::success(AppSettingsResponse {
            settings,
            recovered,
        }),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn update_app_settings(
    request: UpdateAppSettingsRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<AppSettingsResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    match update_settings_data(&state.app_root, request.patch, request.expected_revision) {
        Ok(settings) => CommandResult::success(AppSettingsResponse {
            settings,
            recovered: false,
        }),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub fn clear_app_settings(
    request: VersionedRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<AppSettingsResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    match clear_settings_data(&state.app_root) {
        Ok(settings) => CommandResult::success(AppSettingsResponse {
            settings,
            recovered: false,
        }),
        Err(error) => CommandResult::failure(error),
    }
}

#[tauri::command]
pub async fn get_storage_overview(
    request: VersionedRequest,
    state: State<'_, RuntimeState>,
) -> Result<CommandResult<StorageOverview>, ApiError> {
    if request.api_version != 1 {
        return Ok(CommandResult::unsupported());
    }
    let app_root = state.app_root.clone();
    Ok(
        match tauri::async_runtime::spawn_blocking(move || collect_storage_overview(&app_root))
            .await
        {
            Ok(Ok(overview)) => CommandResult::success(overview),
            Ok(Err(error)) => CommandResult::failure(error),
            Err(_) => CommandResult::failure(ApiError::new(
                "STORAGE_OVERVIEW_UNAVAILABLE",
                "storage.error.overviewUnavailable",
                true,
            )),
        },
    )
}

#[tauri::command]
pub fn prepare_diagnostic_bundle(
    request: PrepareDiagnosticBundleRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<PrepareDiagnosticBundleResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    let (preview, bundle) = match prepare_bundle(&state.app_root, request.context) {
        Ok(value) => value,
        Err(error) => return CommandResult::failure(error),
    };
    let consent_token = new_job_id();
    let mut pending = match state.pending_diagnostics.lock() {
        Ok(pending) => pending,
        Err(_) => {
            return CommandResult::failure(ApiError::new(
                "DIAGNOSTIC_STORE_UNAVAILABLE",
                "diagnostics.error.store",
                true,
            ));
        }
    };
    let now = Instant::now();
    pending.retain(|_, candidate| candidate.expires_at > now);
    pending.insert(
        consent_token.clone(),
        PendingDiagnostic {
            bundle,
            expires_at: now + CAPABILITY_LIFETIME,
        },
    );
    CommandResult::success(PrepareDiagnosticBundleResponse {
        consent_token,
        preview,
    })
}

#[tauri::command]
pub async fn save_diagnostic_bundle(
    app: AppHandle,
    request: SaveDiagnosticBundleRequest,
    state: State<'_, RuntimeState>,
) -> Result<CommandResult<SaveDiagnosticBundleResponse>, ApiError> {
    if request.api_version != 1 {
        return Ok(CommandResult::unsupported());
    }
    let pending = match state.pending_diagnostics.lock() {
        Ok(mut pending) => pending.remove(&request.consent_token),
        Err(_) => {
            return Ok(CommandResult::failure(ApiError::new(
                "DIAGNOSTIC_STORE_UNAVAILABLE",
                "diagnostics.error.store",
                true,
            )));
        }
    };
    let Some(pending) = pending.filter(|candidate| candidate.expires_at > Instant::now()) else {
        return Ok(CommandResult::failure(ApiError::new(
            "CONSENT_REQUIRED",
            "diagnostics.error.consentRequired",
            false,
        )));
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .add_filter("CyberMuse diagnostics", &["json"])
            .set_file_name("CyberMuse-diagnostics.json")
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(SaveDiagnosticBundleResponse {
                saved: false,
                file_name: None,
                size_bytes: 0,
            });
        };
        let destination = selected.into_path().map_err(|_| {
            ApiError::new(
                "DIAGNOSTIC_STORE_UNAVAILABLE",
                "diagnostics.error.store",
                true,
            )
        })?;
        let file_name = destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("CyberMuse-diagnostics.json")
            .to_owned();
        let size_bytes = write_bundle(&destination, &pending.bundle).map_err(ApiError::from)?;
        Ok::<SaveDiagnosticBundleResponse, ApiError>(SaveDiagnosticBundleResponse {
            saved: true,
            file_name: Some(file_name),
            size_bytes,
        })
    })
    .await;
    Ok(match result {
        Ok(Ok(response)) => CommandResult::success(response),
        Ok(Err(error)) => CommandResult::failure(error),
        Err(_) => CommandResult::failure(ApiError::new(
            "DIAGNOSTIC_STORE_UNAVAILABLE",
            "diagnostics.error.store",
            true,
        )),
    })
}

#[tauri::command]
pub fn clear_diagnostic_logs(
    request: VersionedRequest,
    state: State<'_, RuntimeState>,
) -> CommandResult<ClearDiagnosticLogsResponse> {
    if request.api_version != 1 {
        return CommandResult::unsupported();
    }
    match clear_logs(&state.app_root) {
        Ok(cleared_event_count) => CommandResult::success(ClearDiagnosticLogsResponse {
            cleared_event_count,
        }),
        Err(error) => CommandResult::failure(error),
    }
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

fn load_practice_assets(
    state: &RuntimeState,
    song_id: &str,
) -> Result<PracticeAssetsResponse, ApiError> {
    let song = get_song_data(&state.app_root, song_id).map_err(ApiError::from)?;
    let Some(analysis_id) = song.active_analysis_id.clone() else {
        return Err(ApiError::new(
            "SONG_NOT_READY",
            "practice.error.songNotReady",
            true,
        ));
    };
    if song.status != SongStatus::Ready {
        return Err(ApiError::new(
            "SONG_NOT_READY",
            "practice.error.songNotReady",
            true,
        ));
    }
    let expected_models = model_catalog()
        .into_iter()
        .map(|model| {
            (
                model.model_id,
                ExpectedModel {
                    version: model.version,
                    engine: model.engine,
                    sha256: model.sha256,
                    license_expression: model.license_expression,
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    let expectation = ValidationExpectation {
        analysis_id: analysis_id.clone(),
        song_id: song_id.to_owned(),
        duration_ms: song.duration_ms,
        pipeline_version: "m6-demucs-v1".to_owned(),
        models: expected_models,
    };
    let analysis_root = state
        .app_root
        .join("data")
        .join("songs")
        .join(song_id)
        .join("analyses")
        .join(&analysis_id);
    let validated = match validate_analysis(&analysis_root, &expectation) {
        Ok(validated) => validated,
        Err(error) => {
            let _ignored = mark_song_status(&state.app_root, song_id, SongStatus::Damaged);
            let mut mapped = ApiError::from(error);
            mapped.code = "ASSET_INVALID".to_owned();
            mapped.message_key = "practice.error.assetInvalid".to_owned();
            return Err(mapped);
        }
    };
    let instrumental = validated
        .manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.kind == ArtifactKind::Instrumental)
        .ok_or_else(|| ApiError::new("ASSET_INVALID", "practice.error.assetInvalid", true))?;
    let instrumental_path =
        resolve_relative(&validated.root, Path::new(&instrumental.relative_path))
            .map_err(|_| ApiError::new("ASSET_INVALID", "practice.error.assetInvalid", true))?
            .canonicalize()
            .map_err(|_| ApiError::new("ASSET_INVALID", "practice.error.assetInvalid", true))?;
    let vocals = validated
        .manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.kind == ArtifactKind::Vocals)
        .ok_or_else(|| ApiError::new("ASSET_INVALID", "practice.error.assetInvalid", true))?;
    let vocals_path = resolve_relative(&validated.root, Path::new(&vocals.relative_path))
        .map_err(|_| ApiError::new("ASSET_INVALID", "practice.error.assetInvalid", true))?
        .canonicalize()
        .map_err(|_| ApiError::new("ASSET_INVALID", "practice.error.assetInvalid", true))?;
    let reference_path = resolve_relative(
        &validated.root,
        Path::new(&validated.manifest.reference_track_relative_path),
    )
    .map_err(|_| ApiError::new("ASSET_INVALID", "practice.error.assetInvalid", true))?;
    let reference_bytes = fs::read(reference_path)
        .map_err(|_| ApiError::new("ASSET_INVALID", "practice.error.assetInvalid", true))?;
    if reference_bytes.len() > 128 * 1024 * 1024 {
        return Err(ApiError::new(
            "ASSET_INVALID",
            "practice.error.assetInvalid",
            true,
        ));
    }
    let reference_track: serde_json::Value = serde_json::from_slice(&reference_bytes)
        .map_err(|_| ApiError::new("ASSET_INVALID", "practice.error.assetInvalid", true))?;
    let lyrics_status = lyrics_status(&state.app_root, song_id);
    let (lyrics, lyrics_error) = match lyrics_status {
        LyricsStatus::None => (None, None),
        LyricsStatus::Ready => match read_document(&state.app_root, song_id) {
            Ok(document) => (Some(LyricsView::from(&document)), None),
            Err(error) => (None, Some(ApiError::from(error))),
        },
        LyricsStatus::Damaged => (
            None,
            Some(ApiError::new(
                "LYRICS_DAMAGED",
                "lyrics.error.damaged",
                true,
            )),
        ),
    };
    Ok(PracticeAssetsResponse {
        song_id: song_id.to_owned(),
        analysis_id,
        instrumental_resource_url: state.resources.issue(
            song_id,
            &validated.manifest.analysis_id,
            instrumental_path,
        ),
        vocals_resource_url: state.resources.issue(
            song_id,
            &validated.manifest.analysis_id,
            vocals_path,
        ),
        reference_track,
        duration_ms: song.duration_ms,
        lyrics_status,
        lyrics,
        lyrics_error,
    })
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
    let song_root = song_root
        .canonicalize()
        .map_err(|_| ApiError::new("SOURCE_UNREADABLE", "song.error.unreadable", true))?;
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
    let model_root = model_root
        .canonicalize()
        .map_err(|_| ApiError::new("MODEL_REQUIRED", "analyzer.error.modelRequired", true))?;
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
    ];

    let staging_root = state.app_root.join("tmp").join("jobs");
    fs::create_dir_all(&staging_root)
        .map_err(|_| ApiError::new("ANALYZER_DISK_FULL", "analyzer.error.storage", true))?;
    let staging_root = staging_root
        .canonicalize()
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
        pipeline_version: "m6-demucs-v1".to_owned(),
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

fn timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
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
    fn tc_voc_001_practice_assets_serialize_distinct_stem_capabilities() {
        let response = PracticeAssetsResponse {
            song_id: "a".repeat(64),
            analysis_id: "b".repeat(32),
            instrumental_resource_url: "cybermuse://localhost/instrumental".to_owned(),
            vocals_resource_url: "cybermuse://localhost/vocals".to_owned(),
            reference_track: serde_json::json!({ "schemaVersion": 1 }),
            duration_ms: 1_000,
            lyrics_status: LyricsStatus::None,
            lyrics: None,
            lyrics_error: None,
        };
        let value = serde_json::to_value(response).expect("practice assets should serialize");
        assert_eq!(
            value["instrumentalResourceUrl"],
            "cybermuse://localhost/instrumental"
        );
        assert_eq!(value["vocalsResourceUrl"], "cybermuse://localhost/vocals");
        assert_ne!(value["instrumentalResourceUrl"], value["vocalsResourceUrl"]);
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
