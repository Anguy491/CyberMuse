use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::storage::{read_versioned_json, write_versioned_json};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyCalibration {
    pub calibration_id: String,
    pub input_device_fingerprint: String,
    pub output_device_fingerprint: String,
    pub sample_rate_hz: u32,
    pub latency_ms: i64,
    pub source: String,
    pub confidence: Option<f64>,
    pub measured_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub schema_version: u32,
    pub revision: u64,
    pub input_device_fingerprint: Option<String>,
    pub output_device_fingerprint: Option<String>,
    pub volume: f64,
    pub theme_preference: String,
    pub motion_preference: String,
    #[serde(default = "default_language_preference")]
    pub language_preference: String,
    pub model_cache_selection: Vec<String>,
    pub latency_calibrations: Vec<LatencyCalibration>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSettingsPatch {
    pub input_device_fingerprint: Option<Option<String>>,
    pub output_device_fingerprint: Option<Option<String>>,
    pub volume: Option<f64>,
    pub theme_preference: Option<String>,
    pub motion_preference: Option<String>,
    pub language_preference: Option<String>,
    pub model_cache_selection: Option<Vec<String>>,
    pub latency_calibrations: Option<Vec<LatencyCalibration>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsStoreError {
    pub code: &'static str,
    pub message_key: &'static str,
    pub retryable: bool,
    pub safe_details: BTreeMap<String, String>,
    pub diagnostic_id: String,
}

impl SettingsStoreError {
    fn new(code: &'static str, message_key: &'static str, retryable: bool) -> Self {
        Self {
            code,
            message_key,
            retryable,
            safe_details: BTreeMap::new(),
            diagnostic_id: format!("settings-store-{}", std::process::id()),
        }
    }

    fn invalid(reason: &'static str) -> Self {
        let mut error = Self::new("SETTINGS_INVALID", "settings.error.invalid", false);
        error
            .safe_details
            .insert("reason".to_owned(), reason.to_owned());
        error
    }

    fn io(operation: &'static str) -> Self {
        let mut error = Self::new("SETTINGS_STORE_UNAVAILABLE", "settings.error.store", true);
        error
            .safe_details
            .insert("operation".to_owned(), operation.to_owned());
        error
    }
}

pub fn default_settings() -> AppSettings {
    AppSettings {
        schema_version: 1,
        revision: 0,
        input_device_fingerprint: None,
        output_device_fingerprint: None,
        volume: 0.65,
        theme_preference: "system".to_owned(),
        motion_preference: "system".to_owned(),
        language_preference: default_language_preference(),
        model_cache_selection: Vec::new(),
        latency_calibrations: Vec::new(),
    }
}

pub fn load_settings(app_root: &Path) -> Result<(AppSettings, bool), SettingsStoreError> {
    let path = settings_path(app_root);
    if !path.exists() {
        return Ok((default_settings(), false));
    }
    match read_versioned_json::<AppSettings>(&path) {
        Ok(settings) if validate_settings(&settings).is_ok() => Ok((settings, false)),
        _ => {
            let recovered = default_settings();
            write_versioned_json(&path, &recovered)
                .map_err(|_| SettingsStoreError::io("recover_settings"))?;
            Ok((recovered, true))
        }
    }
}

pub fn update_settings(
    app_root: &Path,
    patch: AppSettingsPatch,
    expected_revision: u64,
) -> Result<AppSettings, SettingsStoreError> {
    let (mut settings, _recovered) = load_settings(app_root)?;
    if settings.revision != expected_revision {
        let mut error =
            SettingsStoreError::new("SETTINGS_CONFLICT", "settings.error.revisionConflict", true);
        error
            .safe_details
            .insert("actualRevision".to_owned(), settings.revision.to_string());
        return Err(error);
    }
    if let Some(value) = patch.input_device_fingerprint {
        settings.input_device_fingerprint = value;
    }
    if let Some(value) = patch.output_device_fingerprint {
        settings.output_device_fingerprint = value;
    }
    if let Some(value) = patch.volume {
        settings.volume = value;
    }
    if let Some(value) = patch.theme_preference {
        settings.theme_preference = value;
    }
    if let Some(value) = patch.motion_preference {
        settings.motion_preference = value;
    }
    if let Some(value) = patch.language_preference {
        settings.language_preference = value;
    }
    if let Some(value) = patch.model_cache_selection {
        settings.model_cache_selection = value;
    }
    if let Some(value) = patch.latency_calibrations {
        settings.latency_calibrations = value;
    }
    settings.revision = settings
        .revision
        .checked_add(1)
        .ok_or_else(|| SettingsStoreError::invalid("revision"))?;
    validate_settings(&settings)?;
    write_versioned_json(&settings_path(app_root), &settings)
        .map_err(|_| SettingsStoreError::io("write_settings"))?;
    Ok(settings)
}

pub fn clear_settings(app_root: &Path) -> Result<AppSettings, SettingsStoreError> {
    let path = settings_path(app_root);
    let reset = default_settings();
    write_versioned_json(&path, &reset).map_err(|_| SettingsStoreError::io("clear_settings"))?;
    Ok(reset)
}

fn validate_settings(settings: &AppSettings) -> Result<(), SettingsStoreError> {
    if settings.schema_version != 1
        || settings
            .input_device_fingerprint
            .as_ref()
            .is_some_and(|value| !is_sha256(value))
        || settings
            .output_device_fingerprint
            .as_ref()
            .is_some_and(|value| !is_sha256(value))
        || !settings.volume.is_finite()
        || !(0.0..=1.0).contains(&settings.volume)
        || !matches!(
            settings.theme_preference.as_str(),
            "system" | "dark" | "light"
        )
        || !matches!(
            settings.motion_preference.as_str(),
            "system" | "reduce" | "full"
        )
        || !matches!(
            settings.language_preference.as_str(),
            "system" | "zh-CN" | "en-US"
        )
        || settings.model_cache_selection.len() > 32
        || settings.latency_calibrations.len() > 32
    {
        return Err(SettingsStoreError::invalid("fields"));
    }
    let mut models = HashSet::new();
    if settings.model_cache_selection.iter().any(|value| {
        value.is_empty()
            || value.len() > 128
            || !value.contains('@')
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'@')
            })
            || !models.insert(value)
    }) {
        return Err(SettingsStoreError::invalid("model_cache_selection"));
    }
    let mut pairs = HashSet::new();
    for calibration in &settings.latency_calibrations {
        if !is_uuid_v4(&calibration.calibration_id)
            || !is_sha256(&calibration.input_device_fingerprint)
            || !is_sha256(&calibration.output_device_fingerprint)
            || !matches!(calibration.source.as_str(), "measured" | "manual")
            || !(8_000..=192_000).contains(&calibration.sample_rate_hz)
            || match calibration.source.as_str() {
                "measured" => {
                    !(0..=2_000).contains(&calibration.latency_ms)
                        || calibration
                            .confidence
                            .is_none_or(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
                }
                "manual" => {
                    !(-250..=500).contains(&calibration.latency_ms)
                        || calibration.confidence.is_some()
                }
                _ => true,
            }
            || !is_iso_utc(&calibration.measured_at)
            || !pairs.insert((
                &calibration.input_device_fingerprint,
                &calibration.output_device_fingerprint,
            ))
        {
            return Err(SettingsStoreError::invalid("calibration"));
        }
    }
    Ok(())
}

fn default_language_preference() -> String {
    "system".to_owned()
}

fn settings_path(app_root: &Path) -> std::path::PathBuf {
    app_root.join("data").join("settings.json")
}

fn is_uuid_v4(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[14] == b'4'
        && bytes[18] == b'-'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes[23] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
}

fn is_iso_utc(value: &str) -> bool {
    value.len() >= 20
        && value.ends_with('Z')
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(10) == Some(&b'T')
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn root(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "cybermuse-m6-settings-{label}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn tc_set_001_persists_revision_and_calibration() {
        let app_root = root("roundtrip");
        let fingerprint = "a".repeat(64);
        let settings = update_settings(
            &app_root,
            AppSettingsPatch {
                input_device_fingerprint: Some(Some(fingerprint.clone())),
                volume: Some(0.75),
                theme_preference: Some("dark".to_owned()),
                latency_calibrations: Some(vec![LatencyCalibration {
                    calibration_id: "00000000-0000-4000-8000-000000000001".to_owned(),
                    input_device_fingerprint: fingerprint,
                    output_device_fingerprint: "b".repeat(64),
                    sample_rate_hz: 48_000,
                    latency_ms: 84,
                    source: "measured".to_owned(),
                    confidence: Some(0.95),
                    measured_at: "2026-08-26T02:00:00Z".to_owned(),
                }]),
                ..AppSettingsPatch::default()
            },
            0,
        )
        .expect("update");
        assert_eq!(settings.revision, 1);
        assert_eq!(settings.volume, 0.75);
        assert_eq!(load_settings(&app_root).expect("restart").0, settings);
        assert_eq!(
            update_settings(&app_root, AppSettingsPatch::default(), 0)
                .expect_err("revision conflict")
                .code,
            "SETTINGS_CONFLICT"
        );
        let _ignored = fs::remove_dir_all(app_root);
    }

    #[test]
    fn tc_set_001_recovers_corrupt_settings_and_can_clear() {
        let app_root = root("recovery");
        fs::create_dir_all(app_root.join("data")).expect("data");
        fs::write(settings_path(&app_root), b"not json").expect("corrupt fixture");
        let (settings, recovered) = load_settings(&app_root).expect("recover");
        assert!(recovered);
        assert_eq!(settings, default_settings());
        assert_eq!(
            clear_settings(&app_root).expect("clear"),
            default_settings()
        );
        let _ignored = fs::remove_dir_all(app_root);
    }

    #[test]
    fn tc_i18n_001_normalizes_legacy_v1_language_and_rejects_invalid_values() {
        let app_root = root("legacy-language");
        fs::create_dir_all(app_root.join("data")).expect("data");
        let legacy = serde_json::json!({
            "schemaVersion": 1,
            "revision": 0,
            "inputDeviceFingerprint": null,
            "outputDeviceFingerprint": null,
            "volume": 0.65,
            "themePreference": "system",
            "motionPreference": "system",
            "modelCacheSelection": [],
            "latencyCalibrations": []
        });
        fs::write(
            settings_path(&app_root),
            serde_json::to_vec_pretty(&legacy).expect("legacy json"),
        )
        .expect("legacy fixture");
        let (loaded, recovered) = load_settings(&app_root).expect("legacy load");
        assert!(!recovered);
        assert_eq!(loaded.language_preference, "system");

        let updated = update_settings(
            &app_root,
            AppSettingsPatch {
                language_preference: Some("en-US".to_owned()),
                ..AppSettingsPatch::default()
            },
            0,
        )
        .expect("language update");
        assert_eq!(updated.language_preference, "en-US");
        let persisted = fs::read_to_string(settings_path(&app_root)).expect("persisted settings");
        assert!(persisted.contains("languagePreference"));

        assert_eq!(
            update_settings(
                &app_root,
                AppSettingsPatch {
                    language_preference: Some("fr-FR".to_owned()),
                    ..AppSettingsPatch::default()
                },
                1,
            )
            .expect_err("unsupported language")
            .code,
            "SETTINGS_INVALID"
        );
        let _ignored = fs::remove_dir_all(app_root);
    }

    #[test]
    fn tc_lat_001_enforces_source_range_confidence_and_sample_rate() {
        let mut settings = default_settings();
        settings.latency_calibrations = vec![LatencyCalibration {
            calibration_id: "00000000-0000-4000-8000-000000000002".to_owned(),
            input_device_fingerprint: "a".repeat(64),
            output_device_fingerprint: "b".repeat(64),
            sample_rate_hz: 48_000,
            latency_ms: -125,
            source: "manual".to_owned(),
            confidence: None,
            measured_at: "2026-08-26T02:00:00Z".to_owned(),
        }];
        validate_settings(&settings).expect("valid negative manual offset");

        settings.latency_calibrations[0].latency_ms = -251;
        assert_eq!(
            validate_settings(&settings)
                .expect_err("manual lower bound")
                .code,
            "SETTINGS_INVALID"
        );
        settings.latency_calibrations[0].latency_ms = 84;
        settings.latency_calibrations[0].source = "measured".to_owned();
        settings.latency_calibrations[0].confidence = None;
        assert_eq!(
            validate_settings(&settings)
                .expect_err("measured confidence")
                .code,
            "SETTINGS_INVALID"
        );
        settings.latency_calibrations[0].confidence = Some(0.9);
        settings.latency_calibrations[0].sample_rate_hz = 1;
        assert_eq!(
            validate_settings(&settings).expect_err("sample rate").code,
            "SETTINGS_INVALID"
        );
    }
}
