use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::settings_store::load_settings;
use crate::storage::{read_versioned_json, write_versioned_json};

const RETENTION_MS: u64 = 14 * 24 * 60 * 60 * 1_000;
const MAX_LOG_EVENTS: usize = 200;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticContext {
    pub input_state: Option<String>,
    pub sample_rate_hz: Option<u32>,
    pub channels: Option<u8>,
    pub valid_observation_count: Option<u64>,
    pub latency_p95_ms: Option<f64>,
    pub latency_p99_ms: Option<f64>,
    #[serde(default)]
    pub error_codes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEvent {
    pub schema_version: u32,
    pub recorded_at: String,
    pub recorded_unix_ms: u64,
    pub component: String,
    pub code: String,
    pub diagnostic_id: String,
    pub duration_ms: Option<u64>,
    pub safe_details: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticLog {
    schema_version: u32,
    events: Vec<DiagnosticEvent>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticPreview {
    pub schema_version: u32,
    pub items: Vec<String>,
    pub excluded: Vec<String>,
    pub estimated_size_bytes: usize,
    pub event_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticBundle {
    pub schema_version: u32,
    pub bundle_version: u32,
    pub created_at: String,
    pub application: ApplicationSummary,
    pub device_capabilities: DeviceCapabilities,
    pub performance_summary: PerformanceSummary,
    pub error_codes: Vec<String>,
    pub logs: Vec<DiagnosticEvent>,
    pub privacy: PrivacySummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationSummary {
    pub version: String,
    pub platform: String,
    pub architecture: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCapabilities {
    pub input_state: String,
    pub sample_rate_hz: Option<u32>,
    pub channels: Option<u8>,
    pub input_selection_configured: bool,
    pub output_selection_configured: bool,
    pub saved_calibration_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSummary {
    pub valid_observation_count: u64,
    pub latency_p95_ms: Option<f64>,
    pub latency_p99_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacySummary {
    pub redaction_passed: bool,
    pub excluded: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticError {
    pub code: &'static str,
    pub message_key: &'static str,
    pub retryable: bool,
    pub safe_details: BTreeMap<String, String>,
    pub diagnostic_id: String,
}

impl DiagnosticError {
    fn new(code: &'static str, message_key: &'static str, retryable: bool) -> Self {
        Self {
            code,
            message_key,
            retryable,
            safe_details: BTreeMap::new(),
            diagnostic_id: format!("diagnostics-{}", std::process::id()),
        }
    }

    fn invalid(reason: &'static str) -> Self {
        let mut error = Self::new(
            "DIAGNOSTIC_CONTEXT_INVALID",
            "diagnostics.error.contextInvalid",
            false,
        );
        error
            .safe_details
            .insert("reason".to_owned(), reason.to_owned());
        error
    }

    fn io(operation: &'static str) -> Self {
        let mut error = Self::new(
            "DIAGNOSTIC_STORE_UNAVAILABLE",
            "diagnostics.error.store",
            true,
        );
        error
            .safe_details
            .insert("operation".to_owned(), operation.to_owned());
        error
    }

    fn redaction() -> Self {
        Self::new(
            "DIAGNOSTIC_REDACTION_FAILED",
            "diagnostics.error.redaction",
            false,
        )
    }
}

pub fn prepare_bundle(
    app_root: &Path,
    context: DiagnosticContext,
) -> Result<(DiagnosticPreview, DiagnosticBundle), DiagnosticError> {
    validate_context(&context)?;
    let now_ms = unix_ms();
    let logs = retained_events(app_root, now_ms)?;
    let (settings, _recovered) =
        load_settings(app_root).map_err(|_| DiagnosticError::io("settings"))?;
    let mut error_codes = context.error_codes.clone();
    error_codes.extend(logs.iter().map(|event| event.code.clone()));
    error_codes.sort();
    error_codes.dedup();
    let excluded = excluded_fields();
    let bundle = DiagnosticBundle {
        schema_version: 1,
        bundle_version: 1,
        created_at: timestamp(),
        application: ApplicationSummary {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            platform: std::env::consts::OS.to_owned(),
            architecture: std::env::consts::ARCH.to_owned(),
        },
        device_capabilities: DeviceCapabilities {
            input_state: context.input_state.unwrap_or_else(|| "unknown".to_owned()),
            sample_rate_hz: context.sample_rate_hz,
            channels: context.channels,
            input_selection_configured: settings.input_device_fingerprint.is_some(),
            output_selection_configured: settings.output_device_fingerprint.is_some(),
            saved_calibration_count: settings.latency_calibrations.len(),
        },
        performance_summary: PerformanceSummary {
            valid_observation_count: context.valid_observation_count.unwrap_or(0),
            latency_p95_ms: context.latency_p95_ms,
            latency_p99_ms: context.latency_p99_ms,
        },
        error_codes,
        logs,
        privacy: PrivacySummary {
            redaction_passed: true,
            excluded: excluded.clone(),
        },
    };
    validate_bundle_redaction(&bundle)?;
    let estimated_size_bytes = serde_json::to_vec_pretty(&bundle)
        .map_err(|_| DiagnosticError::redaction())?
        .len();
    let preview = DiagnosticPreview {
        schema_version: 1,
        items: vec![
            "应用版本与 Windows 架构".to_owned(),
            "匿名设备能力".to_owned(),
            "实时性能摘要".to_owned(),
            "稳定错误码".to_owned(),
            "最近 14 天脱敏事件日志".to_owned(),
        ],
        excluded,
        estimated_size_bytes,
        event_count: bundle.logs.len(),
    };
    Ok((preview, bundle))
}

pub fn write_bundle(path: &Path, bundle: &DiagnosticBundle) -> Result<u64, DiagnosticError> {
    validate_bundle_redaction(bundle)?;
    write_versioned_json(path, bundle).map_err(|_| DiagnosticError::io("write_bundle"))?;
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .map_err(|_| DiagnosticError::io("bundle_metadata"))
}

pub fn append_event(app_root: &Path, mut event: DiagnosticEvent) -> Result<(), DiagnosticError> {
    validate_event(&event)?;
    let now_ms = unix_ms();
    if event.recorded_unix_ms == 0 {
        event.recorded_unix_ms = now_ms;
        event.recorded_at = timestamp();
    }
    let mut events = retained_events(app_root, now_ms)?;
    events.push(event);
    if events.len() > MAX_LOG_EVENTS {
        events.drain(..events.len() - MAX_LOG_EVENTS);
    }
    write_log(app_root, events)
}

pub fn prune_logs(app_root: &Path) -> Result<usize, DiagnosticError> {
    let path = log_path(app_root);
    if !path.exists() {
        return Ok(0);
    }
    let log: DiagnosticLog =
        read_versioned_json(&path).map_err(|_| DiagnosticError::io("read_log"))?;
    let before = log.events.len();
    let events = filter_events(log.events, unix_ms())?;
    let removed = before.saturating_sub(events.len());
    write_log(app_root, events)?;
    Ok(removed)
}

pub fn clear_logs(app_root: &Path) -> Result<usize, DiagnosticError> {
    let path = log_path(app_root);
    if !path.exists() {
        return Ok(0);
    }
    let count = read_versioned_json::<DiagnosticLog>(&path)
        .map(|log| log.events.len())
        .unwrap_or(0);
    fs::remove_file(path).map_err(|_| DiagnosticError::io("clear_logs"))?;
    Ok(count)
}

fn retained_events(app_root: &Path, now_ms: u64) -> Result<Vec<DiagnosticEvent>, DiagnosticError> {
    let path = log_path(app_root);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let log: DiagnosticLog =
        read_versioned_json(&path).map_err(|_| DiagnosticError::io("read_log"))?;
    filter_events(log.events, now_ms)
}

fn filter_events(
    events: Vec<DiagnosticEvent>,
    now_ms: u64,
) -> Result<Vec<DiagnosticEvent>, DiagnosticError> {
    let mut retained = Vec::new();
    for event in events {
        validate_event(&event)?;
        if now_ms.saturating_sub(event.recorded_unix_ms) <= RETENTION_MS {
            retained.push(event);
        }
    }
    if retained.len() > MAX_LOG_EVENTS {
        retained.drain(..retained.len() - MAX_LOG_EVENTS);
    }
    Ok(retained)
}

fn write_log(app_root: &Path, events: Vec<DiagnosticEvent>) -> Result<(), DiagnosticError> {
    write_versioned_json(
        &log_path(app_root),
        &DiagnosticLog {
            schema_version: 1,
            events,
        },
    )
    .map_err(|_| DiagnosticError::io("write_log"))
}

fn validate_context(context: &DiagnosticContext) -> Result<(), DiagnosticError> {
    if context.input_state.as_ref().is_some_and(|value| {
        !matches!(
            value.as_str(),
            "unknown"
                | "not_requested"
                | "requesting"
                | "ready"
                | "permission_denied"
                | "recoverable_error"
                | "fatal_error"
        )
    }) || context
        .sample_rate_hz
        .is_some_and(|value| !(8_000..=192_000).contains(&value))
        || context
            .channels
            .is_some_and(|value| !(1..=8).contains(&value))
        || context
            .latency_p95_ms
            .is_some_and(|value| !value.is_finite() || !(0.0..=10_000.0).contains(&value))
        || context
            .latency_p99_ms
            .is_some_and(|value| !value.is_finite() || !(0.0..=10_000.0).contains(&value))
        || context.error_codes.len() > 64
        || context.error_codes.iter().any(|value| !is_safe_code(value))
    {
        return Err(DiagnosticError::invalid("fields"));
    }
    Ok(())
}

fn validate_event(event: &DiagnosticEvent) -> Result<(), DiagnosticError> {
    let allowed_detail_keys: HashSet<&str> = [
        "operation",
        "stage",
        "sampleRateHz",
        "channels",
        "observationCount",
        "durationBucket",
    ]
    .into_iter()
    .collect();
    if event.schema_version != 1
        || !is_safe_token(&event.component)
        || !is_safe_code(&event.code)
        || !is_safe_token(&event.diagnostic_id)
        || event.safe_details.len() > 8
        || event.safe_details.iter().any(|(key, value)| {
            !allowed_detail_keys.contains(key.as_str())
                || value.len() > 64
                || contains_forbidden_value(value)
        })
    {
        return Err(DiagnosticError::redaction());
    }
    Ok(())
}

fn validate_bundle_redaction(bundle: &DiagnosticBundle) -> Result<(), DiagnosticError> {
    for event in &bundle.logs {
        validate_event(event)?;
    }
    let bytes = serde_json::to_vec(bundle).map_err(|_| DiagnosticError::redaction())?;
    let text = String::from_utf8(bytes).map_err(|_| DiagnosticError::redaction())?;
    let forbidden_keys = [
        "audioBytes",
        "pitchTrack",
        "fileName",
        "filePath",
        "sourcePath",
        "deviceId",
        "deviceName",
        "accountId",
    ];
    if forbidden_keys.iter().any(|key| text.contains(key))
        || text.split('"').any(contains_forbidden_value)
    {
        return Err(DiagnosticError::redaction());
    }
    Ok(())
}

fn contains_forbidden_value(value: &str) -> bool {
    value.contains(":\\")
        || value.contains("\\\\")
        || value.contains("file://")
        || value.contains("/Users/")
        || value.contains("/home/")
}

fn is_safe_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn is_safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn excluded_fields() -> Vec<String> {
    vec![
        "音频内容与 PCM".to_owned(),
        "完整 F0/音高轨".to_owned(),
        "歌曲文件名与完整路径".to_owned(),
        "设备名称、ID 与序列号".to_owned(),
        "账户与持久用户标识".to_owned(),
    ]
}

fn log_path(app_root: &Path) -> std::path::PathBuf {
    app_root.join("logs").join("events.json")
}

fn timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn root(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "cybermuse-m6-diagnostics-{label}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn event(recorded_unix_ms: u64) -> DiagnosticEvent {
        DiagnosticEvent {
            schema_version: 1,
            recorded_at: "2026-08-26T03:00:00Z".to_owned(),
            recorded_unix_ms,
            component: "audio".to_owned(),
            code: "AUDIO_DEVICE_LOST".to_owned(),
            diagnostic_id: "audio-safe-1".to_owned(),
            duration_ms: Some(42),
            safe_details: BTreeMap::from([("sampleRateHz".to_owned(), "48000".to_owned())]),
        }
    }

    #[test]
    fn tc_dia_001_previews_and_writes_only_redacted_fields() {
        let app_root = root("bundle");
        append_event(&app_root, event(unix_ms())).expect("event");
        let (preview, bundle) = prepare_bundle(
            &app_root,
            DiagnosticContext {
                input_state: Some("ready".to_owned()),
                sample_rate_hz: Some(48_000),
                channels: Some(1),
                valid_observation_count: Some(1_000),
                latency_p95_ms: Some(68.3),
                latency_p99_ms: Some(70.7),
                error_codes: vec!["AUDIO_DEVICE_LOST".to_owned()],
            },
        )
        .expect("bundle");
        assert_eq!(preview.event_count, 1);
        assert!(preview.excluded.iter().any(|item| item.contains("音频")));
        let destination = app_root.join("exports").join("诊断 包.json");
        assert!(write_bundle(&destination, &bundle).expect("write") > 0);
        let text = fs::read_to_string(destination).expect("read");
        for forbidden in ["audioBytes", "filePath", "deviceId", ":\\"] {
            assert!(!text.contains(forbidden), "forbidden {forbidden}");
        }
        let _ignored = fs::remove_dir_all(app_root);
    }

    #[test]
    fn tc_dia_002_prunes_fourteen_days_and_clears_logs() {
        let app_root = root("retention");
        let now = unix_ms();
        write_log(
            &app_root,
            vec![event(now.saturating_sub(RETENTION_MS + 1)), event(now)],
        )
        .expect("log");
        assert_eq!(prune_logs(&app_root).expect("prune"), 1);
        assert_eq!(clear_logs(&app_root).expect("clear"), 1);
        assert!(!log_path(&app_root).exists());
        let _ignored = fs::remove_dir_all(app_root);
    }

    #[test]
    fn tc_dia_002_rejects_path_like_log_values() {
        let app_root = root("redaction");
        let mut invalid = event(unix_ms());
        invalid.safe_details = BTreeMap::from([(
            "operation".to_owned(),
            "C:\\Users\\person\\song.wav".to_owned(),
        )]);
        assert_eq!(
            append_event(&app_root, invalid)
                .expect_err("redaction")
                .code,
            "DIAGNOSTIC_REDACTION_FAILED"
        );
        let _ignored = fs::remove_dir_all(app_root);
    }
}
