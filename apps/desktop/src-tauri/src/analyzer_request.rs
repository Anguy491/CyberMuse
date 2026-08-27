use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::analysis_store::{
    AnalysisStoreError, ExpectedModel, ValidationExpectation, analysis_id_for,
    canonical_json_sha256,
};
use crate::storage::resolve_relative;

const REQUEST_LIMIT_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedRoots {
    pub song_root: PathBuf,
    pub staging_root: PathBuf,
    pub model_root: PathBuf,
    pub tool_root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInput {
    pub model_id: String,
    pub version: String,
    pub engine: String,
    pub path: PathBuf,
    pub sha256: String,
    pub license_expression: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInput {
    pub tool_id: String,
    pub version: String,
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzerConfig {
    pub sample_rate_hz: u32,
    pub pitch_min_hz: f64,
    pub pitch_max_hz: f64,
    pub confidence_threshold: f64,
    pub max_interpolated_gap_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzerRequest {
    pub schema_version: u32,
    pub job_id: String,
    pub song_id: String,
    pub requested_analysis_id: String,
    pub input_path: PathBuf,
    pub staging_path: PathBuf,
    pub expected_duration_ms: u64,
    pub pipeline_version: String,
    pub roots: ApprovedRoots,
    pub models: Vec<ModelInput>,
    pub tools: Vec<ToolInput>,
    pub config: AnalyzerConfig,
}

pub fn read_and_validate_request(path: &Path) -> Result<AnalyzerRequest, AnalysisStoreError> {
    let metadata = fs::metadata(path).map_err(|_| request_error("request_missing"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > REQUEST_LIMIT_BYTES {
        return Err(request_error("request_size"));
    }
    let bytes = fs::read(path).map_err(|_| request_error("request_read"))?;
    let request = parse_request_contract(&bytes)?;
    validate_request(&request)?;
    Ok(request)
}

pub fn parse_request_contract(bytes: &[u8]) -> Result<AnalyzerRequest, AnalysisStoreError> {
    let request: AnalyzerRequest =
        serde_json::from_slice(bytes).map_err(|_| request_error("request_schema"))?;
    if request.schema_version != 1
        || !is_uuid_v4(&request.job_id)
        || !is_hex(&request.song_id, 64)
        || !is_hex(&request.requested_analysis_id, 32)
        || request.pipeline_version.is_empty()
        || request.pipeline_version.len() > 128
        || !(1..=1_200_000).contains(&request.expected_duration_ms)
        || request.config.sample_rate_hz != 48_000
        || !request.config.pitch_min_hz.is_finite()
        || !request.config.pitch_max_hz.is_finite()
        || !request.config.confidence_threshold.is_finite()
        || request.config.pitch_min_hz <= 0.0
        || request.config.pitch_max_hz <= request.config.pitch_min_hz
        || !(0.0..=1.0).contains(&request.config.confidence_threshold)
        || request.config.max_interpolated_gap_ms > 50
    {
        return Err(request_error("request_fields"));
    }
    let mut model_ids = BTreeSet::new();
    for model in &request.models {
        if !model_ids.insert(model.model_id.as_str())
            || !is_hex(&model.sha256, 64)
            || model.version.is_empty()
            || model.engine.is_empty()
            || model.license_expression.is_empty()
            || !model.path.is_absolute()
        {
            return Err(request_error("model_set"));
        }
    }
    let mut tool_ids = BTreeSet::new();
    for tool in &request.tools {
        if !tool_ids.insert(tool.tool_id.as_str())
            || !is_hex(&tool.sha256, 64)
            || tool.version.is_empty()
            || !tool.path.is_absolute()
        {
            return Err(request_error("tool_set"));
        }
    }
    if !request.input_path.is_absolute()
        || !request.staging_path.is_absolute()
        || !request.roots.song_root.is_absolute()
        || !request.roots.staging_root.is_absolute()
        || !request.roots.model_root.is_absolute()
        || !request.roots.tool_root.is_absolute()
        || model_ids.is_empty()
        || model_ids.len() > 8
        || tool_ids.is_empty()
        || tool_ids.len() > 8
    {
        return Err(request_error("request_paths_or_sets"));
    }
    Ok(request)
}

pub fn validate_request(request: &AnalyzerRequest) -> Result<(), AnalysisStoreError> {
    parse_request_contract(
        &serde_json::to_vec(request).map_err(|_| request_error("request_schema"))?,
    )?;
    canonical_within(&request.input_path, &request.roots.song_root, "input_path")?;
    let staging = canonical_within(
        &request.staging_path,
        &request.roots.staging_root,
        "staging_path",
    )?;
    if staging.file_name().and_then(|value| value.to_str()) != Some(request.job_id.as_str()) {
        return Err(request_error("staging_job"));
    }
    if sha256_file(&request.input_path)? != request.song_id {
        return Err(request_error("input_hash"));
    }

    let mut model_ids = BTreeSet::new();
    for model in &request.models {
        if !model_ids.insert(model.model_id.as_str())
            || !is_hex(&model.sha256, 64)
            || model.version.is_empty()
            || model.engine.is_empty()
            || model.license_expression.is_empty()
        {
            return Err(request_error("model_set"));
        }
        canonical_within(&model.path, &request.roots.model_root, "model_path")?;
        if sha256_file(&model.path)? != model.sha256 {
            return Err(request_error("model_hash"));
        }
    }
    if model_ids != BTreeSet::from(["demucs-htdemucs", "swiftf0"])
        || !approved_models(&request.models)
    {
        return Err(request_error("model_approval"));
    }

    let mut tool_ids = BTreeSet::new();
    for tool in &request.tools {
        if !tool_ids.insert(tool.tool_id.as_str())
            || !is_hex(&tool.sha256, 64)
            || tool.version.is_empty()
        {
            return Err(request_error("tool_set"));
        }
        canonical_within(&tool.path, &request.roots.tool_root, "tool_path")?;
        if sha256_file(&tool.path)? != tool.sha256 {
            return Err(request_error("tool_hash"));
        }
    }
    if tool_ids != BTreeSet::from(["ffmpeg", "ffprobe"]) || !approved_tools(&request.tools) {
        return Err(request_error("tool_approval"));
    }
    if analysis_id(request)? != request.requested_analysis_id {
        return Err(request_error("analysis_id"));
    }
    Ok(())
}

pub fn fingerprint_payload(request: &AnalyzerRequest) -> serde_json::Value {
    let mut models = request.models.clone();
    models.sort_by(|left, right| left.model_id.cmp(&right.model_id));
    serde_json::json!({
        "schemaVersion": 1,
        "songId": request.song_id,
        "pipelineVersion": request.pipeline_version,
        "config": {
            "sampleRateHz": request.config.sample_rate_hz,
            "pitchMinHz": request.config.pitch_min_hz,
            "pitchMaxHz": request.config.pitch_max_hz,
            "confidenceThreshold": request.config.confidence_threshold,
            "maxInterpolatedGapMs": request.config.max_interpolated_gap_ms,
        },
        "models": models.iter().map(|model| serde_json::json!({
            "modelId": model.model_id,
            "version": model.version,
            "engine": model.engine,
            "sha256": model.sha256,
        })).collect::<Vec<_>>(),
        "manifestSchemaMajor": 1,
        "referenceTrackSchemaMajor": 1,
    })
}

pub fn analysis_id(request: &AnalyzerRequest) -> Result<String, AnalysisStoreError> {
    analysis_id_for(&fingerprint_payload(request))
}

pub fn validation_expectation(
    request: &AnalyzerRequest,
) -> Result<ValidationExpectation, AnalysisStoreError> {
    let fingerprint = canonical_json_sha256(&fingerprint_payload(request))?;
    if !fingerprint.starts_with(&request.requested_analysis_id) {
        return Err(request_error("analysis_id"));
    }
    Ok(ValidationExpectation {
        analysis_id: request.requested_analysis_id.clone(),
        song_id: request.song_id.clone(),
        duration_ms: request.expected_duration_ms,
        pipeline_version: request.pipeline_version.clone(),
        models: request
            .models
            .iter()
            .map(|model| {
                (
                    model.model_id.clone(),
                    ExpectedModel {
                        version: model.version.clone(),
                        engine: model.engine.clone(),
                        sha256: model.sha256.clone(),
                        license_expression: model.license_expression.clone(),
                    },
                )
            })
            .collect::<BTreeMap<_, _>>(),
    })
}

fn approved_models(models: &[ModelInput]) -> bool {
    models.iter().all(|model| match model.model_id.as_str() {
        "demucs-htdemucs" => {
            model.version == "spectral-v1.0.0"
                && model.engine == "onnxruntime-cpu-spectral"
                && model.sha256
                    == "c3395410b1319976683bc874d97461655a9ea6089bbb0f3bd163d3829db13d02"
                && model.license_expression == "MIT"
        }
        "swiftf0" => {
            model.version == "0.1.2"
                && model.engine == "onnxruntime-cpu"
                && model.sha256
                    == "212715116025a490be70db0afda8fb27b1eadf267a3b18ed8df4866c1574e717"
                && model.license_expression == "MIT"
        }
        _ => false,
    })
}

fn approved_tools(tools: &[ToolInput]) -> bool {
    tools.iter().all(|tool| match tool.tool_id.as_str() {
        "ffmpeg" => {
            tool.version == "n9.0.1-6-g9d4ca21220"
                && tool.sha256 == "f4326d7a480fb9e81a34440e775a70ebcf263a0c5fbc45678ffc594a9a7eccf3"
        }
        "ffprobe" => {
            tool.version == "n9.0.1-6-g9d4ca21220"
                && tool.sha256 == "1c9b4e13cdc83bf7a4e2f40a69716a62eddc6810a7a6abaacbc568ffaf77c8e9"
        }
        _ => false,
    })
}

fn canonical_within(
    path: &Path,
    root: &Path,
    reason: &'static str,
) -> Result<PathBuf, AnalysisStoreError> {
    let root = root.canonicalize().map_err(|_| request_error(reason))?;
    let path = path.canonicalize().map_err(|_| request_error(reason))?;
    let relative = path
        .strip_prefix(&root)
        .map_err(|_| request_error(reason))?;
    let resolved = resolve_relative(&root, relative).map_err(|_| request_error(reason))?;
    if resolved != path {
        return Err(request_error(reason));
    }
    Ok(path)
}

fn sha256_file(path: &Path) -> Result<String, AnalysisStoreError> {
    let mut file = File::open(path).map_err(|_| request_error("hash_open"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| request_error("hash_read"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn is_uuid_v4(value: &str) -> bool {
    value.len() == 36
        && value.as_bytes().get(8) == Some(&b'-')
        && value.as_bytes().get(13) == Some(&b'-')
        && value.as_bytes().get(14) == Some(&b'4')
        && value.as_bytes().get(18) == Some(&b'-')
        && value
            .as_bytes()
            .get(19)
            .is_some_and(|byte| matches!(byte.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'))
        && value.as_bytes().get(23) == Some(&b'-')
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
}

fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn request_error(reason: &'static str) -> AnalysisStoreError {
    let mut safe_details = BTreeMap::new();
    safe_details.insert("reason".to_owned(), reason.to_owned());
    AnalysisStoreError {
        code: "ANALYZER_INVALID_REQUEST",
        message_key: "analyzer.error.invalidRequest",
        retryable: false,
        safe_details,
        diagnostic_id: format!("request-{}", std::process::id()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("..")
                .join("fixtures")
                .join("contracts")
                .join("analyzer")
                .join(name),
        )
        .expect("shared fixture should read")
    }

    #[test]
    fn tc_con_001_shared_request_fixture_current_extra_and_unknown_major() {
        let current = parse_request_contract(&fixture("analyzer-request-v1-current.json"))
            .expect("current request should parse");
        assert!(current.input_path.to_string_lossy().chars().count() > 180);
        assert!(current.input_path.to_string_lossy().contains("歌曲 根目录"));
        let extra = parse_request_contract(&fixture("analyzer-request-v1-extra.json"))
            .expect("same-major extra fields should parse");
        assert_eq!(extra.schema_version, 1);
        assert_eq!(
            parse_request_contract(&fixture("analyzer-request-v2-unsupported.json"))
                .expect_err("unknown major should fail")
                .code,
            "ANALYZER_INVALID_REQUEST"
        );
    }

    #[test]
    fn tc_an_003_matches_python_canonical_fingerprint() {
        let request = AnalyzerRequest {
            schema_version: 1,
            job_id: "4ab0c16f-1234-4abc-8def-1234567890ab".to_owned(),
            song_id: "7878b2eb81f57e43e613599e1a19e692a54fb368cfe7b8bc124b24febd245f6a".to_owned(),
            requested_analysis_id: "29537af5d863a178370a8abe4fa12ee5".to_owned(),
            input_path: PathBuf::new(),
            staging_path: PathBuf::new(),
            expected_duration_ms: 6000,
            pipeline_version: "m6-demucs-v1".to_owned(),
            roots: ApprovedRoots {
                song_root: PathBuf::new(),
                staging_root: PathBuf::new(),
                model_root: PathBuf::new(),
                tool_root: PathBuf::new(),
            },
            models: vec![
                ModelInput {
                    model_id: "demucs-htdemucs".to_owned(),
                    version: "spectral-v1.0.0".to_owned(),
                    engine: "onnxruntime-cpu-spectral".to_owned(),
                    path: PathBuf::new(),
                    sha256: "c3395410b1319976683bc874d97461655a9ea6089bbb0f3bd163d3829db13d02"
                        .to_owned(),
                    license_expression: "MIT".to_owned(),
                },
                ModelInput {
                    model_id: "swiftf0".to_owned(),
                    version: "0.1.2".to_owned(),
                    engine: "onnxruntime-cpu".to_owned(),
                    path: PathBuf::new(),
                    sha256: "212715116025a490be70db0afda8fb27b1eadf267a3b18ed8df4866c1574e717"
                        .to_owned(),
                    license_expression: "MIT".to_owned(),
                },
            ],
            tools: Vec::new(),
            config: AnalyzerConfig {
                sample_rate_hz: 48_000,
                pitch_min_hz: 65.0,
                pitch_max_hz: 1046.5,
                confidence_threshold: 0.45,
                max_interpolated_gap_ms: 50,
            },
        };
        assert_eq!(
            analysis_id(&request).expect("fingerprint should hash"),
            request.requested_analysis_id
        );
    }
}
