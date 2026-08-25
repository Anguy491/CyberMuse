use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const MAX_PROTOCOL_LINE_BYTES: usize = 64 * 1024;
const MAX_JSON_DEPTH: usize = 16;
const STAGE_WEIGHTS: [f64; 6] = [0.02, 0.08, 0.55, 0.25, 0.07, 0.03];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolError {
    pub code: &'static str,
    pub message_key: &'static str,
    pub retryable: bool,
    pub safe_details: BTreeMap<String, String>,
    pub diagnostic_id: String,
}

impl ProtocolError {
    fn new(reason: &'static str) -> Self {
        let mut safe_details = BTreeMap::new();
        safe_details.insert("reason".to_owned(), reason.to_owned());
        Self {
            code: "ANALYZER_PROTOCOL_ERROR",
            message_key: "analyzer.error.protocol",
            retryable: true,
            safe_details,
            diagnostic_id: format!("protocol-{}", std::process::id()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalyzerStage {
    Probe,
    Normalize,
    Separate,
    Pitch,
    Postprocess,
    Write,
}

impl AnalyzerStage {
    fn index(self) -> usize {
        match self {
            Self::Probe => 0,
            Self::Normalize => 1,
            Self::Separate => 2,
            Self::Pitch => 3,
            Self::Postprocess => 4,
            Self::Write => 5,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzerErrorPayload {
    pub schema_version: u32,
    pub code: String,
    pub message_key: String,
    pub stage: Option<AnalyzerStage>,
    pub retryable: bool,
    pub safe_details: BTreeMap<String, serde_json::Value>,
    pub diagnostic_id: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzerWarningPayload {
    pub code: String,
    pub message_key: String,
    pub safe_details: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WireMessage {
    Hello {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "protocolMajor")]
        protocol_major: u32,
        #[serde(rename = "analyzerVersion")]
        analyzer_version: String,
    },
    Progress {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "jobId")]
        job_id: String,
        sequence: u64,
        stage: AnalyzerStage,
        #[serde(rename = "stageProgress")]
        stage_progress: f64,
        progress: f64,
    },
    Warning {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "jobId")]
        job_id: String,
        sequence: u64,
        warning: AnalyzerWarningPayload,
    },
    Completed {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "jobId")]
        job_id: String,
        sequence: u64,
        #[serde(rename = "manifestRelativePath")]
        manifest_relative_path: String,
    },
    Failed {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "jobId")]
        job_id: String,
        sequence: u64,
        error: AnalyzerErrorPayload,
    },
    Cancelled {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "jobId")]
        job_id: String,
        sequence: u64,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProtocolEvent {
    Hello {
        analyzer_version: String,
    },
    Progress {
        stage: AnalyzerStage,
        stage_progress: f64,
        progress: f64,
    },
    Warning(AnalyzerWarningPayload),
    Completed,
    Failed(AnalyzerErrorPayload),
    Cancelled,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Terminal {
    Completed,
    Failed(AnalyzerErrorPayload),
    Cancelled,
}

#[derive(Debug)]
pub struct ProtocolValidator {
    job_id: String,
    greeted: bool,
    next_sequence: u64,
    current_stage: Option<AnalyzerStage>,
    stage_progress: f64,
    progress: f64,
    terminal: Option<Terminal>,
}

impl ProtocolValidator {
    pub fn new(job_id: impl Into<String>) -> Self {
        Self {
            job_id: job_id.into(),
            greeted: false,
            next_sequence: 1,
            current_stage: None,
            stage_progress: 0.0,
            progress: 0.0,
            terminal: None,
        }
    }

    pub fn accept_line(&mut self, line: &[u8]) -> Result<ProtocolEvent, ProtocolError> {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() || line.len() > MAX_PROTOCOL_LINE_BYTES {
            return Err(ProtocolError::new("line_size"));
        }
        let value: serde_json::Value =
            serde_json::from_slice(line).map_err(|_| ProtocolError::new("invalid_json"))?;
        if json_depth(&value, 1) > MAX_JSON_DEPTH {
            return Err(ProtocolError::new("json_depth"));
        }
        let message: WireMessage =
            serde_json::from_value(value).map_err(|_| ProtocolError::new("invalid_message"))?;
        self.accept(message)
    }

    pub fn finish(self, exit_code: i32) -> Result<Terminal, ProtocolError> {
        let terminal = self
            .terminal
            .ok_or_else(|| ProtocolError::new("missing_terminal"))?;
        let consistent = match &terminal {
            Terminal::Completed => exit_code == 0,
            Terminal::Cancelled => exit_code == 6,
            Terminal::Failed(error) => expected_error_exit(&error.code)
                .map_or(exit_code != 0 && exit_code != 6, |expected| {
                    exit_code == expected
                }),
        };
        if !consistent {
            return Err(ProtocolError::new("terminal_exit_mismatch"));
        }
        Ok(terminal)
    }

    fn accept(&mut self, message: WireMessage) -> Result<ProtocolEvent, ProtocolError> {
        if self.terminal.is_some() {
            return Err(ProtocolError::new("output_after_terminal"));
        }
        match message {
            WireMessage::Hello {
                schema_version,
                job_id,
                protocol_major,
                analyzer_version,
            } => {
                if self.greeted {
                    return Err(ProtocolError::new("duplicate_hello"));
                }
                self.validate_base(schema_version, &job_id)?;
                if protocol_major != 1 || analyzer_version.is_empty() || analyzer_version.len() > 64
                {
                    return Err(ProtocolError::new("unsupported_hello"));
                }
                self.greeted = true;
                Ok(ProtocolEvent::Hello { analyzer_version })
            }
            message => {
                if !self.greeted {
                    return Err(ProtocolError::new("first_line_not_hello"));
                }
                self.accept_sequenced(message)
            }
        }
    }

    fn accept_sequenced(&mut self, message: WireMessage) -> Result<ProtocolEvent, ProtocolError> {
        match message {
            WireMessage::Progress {
                schema_version,
                job_id,
                sequence,
                stage,
                stage_progress,
                progress,
            } => {
                self.validate_sequenced(schema_version, &job_id, sequence)?;
                self.validate_progress(stage, stage_progress, progress)?;
                Ok(ProtocolEvent::Progress {
                    stage,
                    stage_progress,
                    progress,
                })
            }
            WireMessage::Warning {
                schema_version,
                job_id,
                sequence,
                warning,
            } => {
                self.validate_sequenced(schema_version, &job_id, sequence)?;
                validate_warning(&warning)?;
                Ok(ProtocolEvent::Warning(warning))
            }
            WireMessage::Completed {
                schema_version,
                job_id,
                sequence,
                manifest_relative_path,
            } => {
                self.validate_sequenced(schema_version, &job_id, sequence)?;
                if manifest_relative_path != "analysis.json"
                    || self.current_stage != Some(AnalyzerStage::Write)
                    || (self.stage_progress - 1.0).abs() > f64::EPSILON
                    || (self.progress - 1.0).abs() > f64::EPSILON
                {
                    return Err(ProtocolError::new("invalid_completed"));
                }
                self.terminal = Some(Terminal::Completed);
                Ok(ProtocolEvent::Completed)
            }
            WireMessage::Failed {
                schema_version,
                job_id,
                sequence,
                error,
            } => {
                self.validate_sequenced(schema_version, &job_id, sequence)?;
                validate_error(&error)?;
                self.terminal = Some(Terminal::Failed(error.clone()));
                Ok(ProtocolEvent::Failed(error))
            }
            WireMessage::Cancelled {
                schema_version,
                job_id,
                sequence,
            } => {
                self.validate_sequenced(schema_version, &job_id, sequence)?;
                self.terminal = Some(Terminal::Cancelled);
                Ok(ProtocolEvent::Cancelled)
            }
            WireMessage::Hello { .. } => Err(ProtocolError::new("duplicate_hello")),
        }
    }

    fn validate_base(&self, schema_version: u32, job_id: &str) -> Result<(), ProtocolError> {
        if schema_version != 1 {
            return Err(ProtocolError::new("unsupported_schema"));
        }
        if job_id != self.job_id {
            return Err(ProtocolError::new("job_mismatch"));
        }
        Ok(())
    }

    fn validate_sequenced(
        &mut self,
        schema_version: u32,
        job_id: &str,
        sequence: u64,
    ) -> Result<(), ProtocolError> {
        self.validate_base(schema_version, job_id)?;
        if sequence != self.next_sequence {
            return Err(ProtocolError::new("sequence"));
        }
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| ProtocolError::new("sequence_overflow"))?;
        Ok(())
    }

    fn validate_progress(
        &mut self,
        stage: AnalyzerStage,
        stage_progress: f64,
        progress: f64,
    ) -> Result<(), ProtocolError> {
        if !stage_progress.is_finite()
            || !progress.is_finite()
            || !(0.0..=1.0).contains(&stage_progress)
            || !(0.0..=1.0).contains(&progress)
            || progress < self.progress
        {
            return Err(ProtocolError::new("progress_range_or_regression"));
        }
        let stage_index = stage.index();
        match self.current_stage {
            None if stage != AnalyzerStage::Probe => {
                return Err(ProtocolError::new("stage_order"));
            }
            Some(current) if stage_index < current.index() || stage_index > current.index() + 1 => {
                return Err(ProtocolError::new("stage_order"));
            }
            Some(current) if stage == current && stage_progress < self.stage_progress => {
                return Err(ProtocolError::new("stage_progress_regression"));
            }
            Some(current)
                if stage != current && (self.stage_progress - 1.0).abs() > f64::EPSILON =>
            {
                return Err(ProtocolError::new("incomplete_stage"));
            }
            _ => {}
        }
        let completed: f64 = STAGE_WEIGHTS[..stage_index].iter().sum();
        let expected = completed + STAGE_WEIGHTS[stage_index] * stage_progress;
        if (expected - progress).abs() > 1e-6 {
            return Err(ProtocolError::new("progress_weight"));
        }
        self.current_stage = Some(stage);
        self.stage_progress = stage_progress;
        self.progress = progress;
        Ok(())
    }
}

fn json_depth(value: &serde_json::Value, current: usize) -> usize {
    match value {
        serde_json::Value::Array(values) => values
            .iter()
            .map(|value| json_depth(value, current + 1))
            .max()
            .unwrap_or(current),
        serde_json::Value::Object(values) => values
            .values()
            .map(|value| json_depth(value, current + 1))
            .max()
            .unwrap_or(current),
        _ => current,
    }
}

fn validate_safe_details(
    details: &BTreeMap<String, serde_json::Value>,
) -> Result<(), ProtocolError> {
    if details.len() > 32 {
        return Err(ProtocolError::new("unsafe_details"));
    }
    for (key, value) in details {
        if key.is_empty() || key.len() > 64 {
            return Err(ProtocolError::new("unsafe_details"));
        }
        match value {
            serde_json::Value::String(text)
                if text.len() <= 256
                    && !text.contains("\\")
                    && !text.contains('/')
                    && !text.contains('\n')
                    && !text.contains('\r') => {}
            serde_json::Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => {}
            serde_json::Value::Bool(_) => {}
            _ => return Err(ProtocolError::new("unsafe_details")),
        }
    }
    Ok(())
}

fn validate_warning(warning: &AnalyzerWarningPayload) -> Result<(), ProtocolError> {
    if warning.code.is_empty()
        || warning.code.len() > 128
        || warning.message_key.is_empty()
        || warning.message_key.len() > 256
    {
        return Err(ProtocolError::new("invalid_warning"));
    }
    validate_safe_details(&warning.safe_details)
}

fn validate_error(error: &AnalyzerErrorPayload) -> Result<(), ProtocolError> {
    if error.schema_version != 1
        || error.code.is_empty()
        || error.code.len() > 128
        || error.message_key.is_empty()
        || error.message_key.len() > 256
        || error.diagnostic_id.is_empty()
        || error.diagnostic_id.len() > 256
    {
        return Err(ProtocolError::new("invalid_error"));
    }
    validate_safe_details(&error.safe_details)
}

fn expected_error_exit(code: &str) -> Option<i32> {
    match code {
        "ANALYZER_INVALID_REQUEST" | "ANALYZER_PROTOCOL_ERROR" => Some(2),
        "ANALYZER_MODEL_MISSING" | "ANALYZER_MODEL_INVALID" => Some(3),
        "ANALYZER_INPUT_UNREADABLE" | "ANALYZER_UNSUPPORTED_AUDIO" => Some(4),
        "ANALYZER_DISK_FULL" => Some(5),
        "ANALYZER_CANCELLED" => Some(6),
        "ANALYZER_STAGE_FAILED" | "ANALYZER_INTERNAL" => Some(10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::*;

    const JOB: &str = "4ab0c16f-1234-4abc-8def-1234567890ab";

    fn hello() -> &'static [u8] {
        br#"{"schemaVersion":1,"type":"hello","jobId":"4ab0c16f-1234-4abc-8def-1234567890ab","protocolMajor":1,"analyzerVersion":"0.1.0"}"#
    }

    fn success_lines() -> Vec<String> {
        let stages = [
            ("probe", 0.02),
            ("normalize", 0.1),
            ("separate", 0.65),
            ("pitch", 0.9),
            ("postprocess", 0.97),
            ("write", 1.0),
        ];
        stages
            .iter()
            .enumerate()
            .map(|(index, (stage, progress))| {
                format!(
                    r#"{{"schemaVersion":1,"type":"progress","jobId":"{JOB}","sequence":{},"stage":"{stage}","stageProgress":1.0,"progress":{progress}}}"#,
                    index + 1
                )
            })
            .chain(std::iter::once(format!(
                r#"{{"schemaVersion":1,"type":"completed","jobId":"{JOB}","sequence":7,"manifestRelativePath":"analysis.json"}}"#
            )))
            .collect()
    }

    #[test]
    fn tc_an_001_accepts_complete_monotonic_protocol() {
        let mut validator = ProtocolValidator::new(JOB);
        assert!(matches!(
            validator.accept_line(hello()).expect("hello should pass"),
            ProtocolEvent::Hello { .. }
        ));
        for line in success_lines() {
            validator
                .accept_line(line.as_bytes())
                .expect("event should pass");
        }
        assert_eq!(
            validator.finish(0).expect("exit should match"),
            Terminal::Completed
        );
    }

    #[test]
    fn tc_an_001_rejects_banner_sequence_progress_and_terminal_errors() {
        let mut banner = ProtocolValidator::new(JOB);
        assert!(banner.accept_line(b"Spleeter banner").is_err());

        let mut sequence = ProtocolValidator::new(JOB);
        sequence.accept_line(hello()).expect("hello should pass");
        let skipped = format!(
            r#"{{"schemaVersion":1,"type":"progress","jobId":"{JOB}","sequence":2,"stage":"probe","stageProgress":1.0,"progress":0.02}}"#
        );
        assert!(sequence.accept_line(skipped.as_bytes()).is_err());

        let mut regression = ProtocolValidator::new(JOB);
        regression.accept_line(hello()).expect("hello should pass");
        let first = format!(
            r#"{{"schemaVersion":1,"type":"progress","jobId":"{JOB}","sequence":1,"stage":"probe","stageProgress":1.0,"progress":0.02}}"#
        );
        regression
            .accept_line(first.as_bytes())
            .expect("first progress should pass");
        let backwards = format!(
            r#"{{"schemaVersion":1,"type":"progress","jobId":"{JOB}","sequence":2,"stage":"probe","stageProgress":0.5,"progress":0.01}}"#
        );
        assert!(regression.accept_line(backwards.as_bytes()).is_err());

        let mut missing = ProtocolValidator::new(JOB);
        missing.accept_line(hello()).expect("hello should pass");
        assert!(missing.finish(0).is_err());
    }

    #[test]
    fn tc_an_001_rejects_limits_depth_job_and_exit_mismatch() {
        let mut oversized = ProtocolValidator::new(JOB);
        assert!(
            oversized
                .accept_line(&vec![b'x'; MAX_PROTOCOL_LINE_BYTES + 1])
                .is_err()
        );

        let nested = format!(
            r#"{{"schemaVersion":1,"type":"hello","jobId":"{JOB}","protocolMajor":1,"analyzerVersion":"0.1.0","future":{}}}"#,
            "[".repeat(17) + &"]".repeat(17)
        );
        let mut depth = ProtocolValidator::new(JOB);
        assert!(depth.accept_line(nested.as_bytes()).is_err());

        let mut wrong_job = ProtocolValidator::new("different");
        assert!(wrong_job.accept_line(hello()).is_err());

        let mut mismatch = ProtocolValidator::new(JOB);
        mismatch.accept_line(hello()).expect("hello should pass");
        for line in success_lines() {
            mismatch
                .accept_line(line.as_bytes())
                .expect("event should pass");
        }
        assert!(mismatch.finish(10).is_err());
    }

    #[test]
    fn tc_con_001_accepts_same_major_extra_fields() {
        let mut validator = ProtocolValidator::new(JOB);
        let line = format!(
            r#"{{"schemaVersion":1,"type":"hello","jobId":"{JOB}","protocolMajor":1,"analyzerVersion":"0.1.0","future":true}}"#
        );
        validator
            .accept_line(line.as_bytes())
            .expect("same-major additions should pass");
    }

    fn fixture(name: &str) -> serde_json::Value {
        serde_json::from_slice(
            &fs::read(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("..")
                    .join("..")
                    .join("fixtures")
                    .join("contracts")
                    .join("analyzer")
                    .join(name),
            )
            .expect("shared fixture should read"),
        )
        .expect("shared fixture should be JSON")
    }

    #[test]
    fn tc_con_001_validates_shared_protocol_and_terminal_fixtures() {
        let trace = fixture("protocol-v1-current.json");
        let messages = trace.as_array().expect("trace should be an array");
        let mut validator = ProtocolValidator::new(JOB);
        for message in messages {
            validator
                .accept_line(&serde_json::to_vec(message).expect("message should serialize"))
                .expect("shared protocol event should pass");
        }
        assert_eq!(
            validator.finish(0).expect("trace should finish"),
            Terminal::Completed
        );

        let terminals = fixture("protocol-v1-terminals.json");
        for (name, exit_code, expected) in [("failed", 3, "failed"), ("cancelled", 6, "cancelled")]
        {
            let mut validator = ProtocolValidator::new(JOB);
            validator.accept_line(hello()).expect("hello should pass");
            let terminal = &terminals[name];
            let event = validator
                .accept_line(&serde_json::to_vec(terminal).expect("terminal should serialize"))
                .expect("terminal should pass");
            assert!(matches!(
                (expected, event),
                ("failed", ProtocolEvent::Failed(_)) | ("cancelled", ProtocolEvent::Cancelled)
            ));
            validator
                .finish(exit_code)
                .expect("exit should match terminal");
        }
    }
}
