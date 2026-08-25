from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

from .errors import invalid_request

SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
ANALYSIS_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
STAGES = ("probe", "normalize", "separate", "pitch", "postprocess", "write")
STAGE_WEIGHTS = {
    "probe": 0.02,
    "normalize": 0.08,
    "separate": 0.55,
    "pitch": 0.25,
    "postprocess": 0.07,
    "write": 0.03,
}


def _record(value: object, reason: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise invalid_request(reason)
    return value


def _string(value: object, reason: str) -> str:
    if not isinstance(value, str) or not value:
        raise invalid_request(reason)
    return value


def _absolute_path(value: object, reason: str) -> Path:
    path = Path(_string(value, reason))
    if not path.is_absolute():
        raise invalid_request(reason)
    return path


def _sha256(value: object, reason: str) -> str:
    text = _string(value, reason)
    if SHA256_PATTERN.fullmatch(text) is None:
        raise invalid_request(reason)
    return text


def _uuid(value: object, reason: str) -> str:
    text = _string(value, reason)
    try:
        parsed = UUID(text)
    except ValueError as error:
        raise invalid_request(reason) from error
    if parsed.version != 4:
        raise invalid_request(reason)
    return text


@dataclass(frozen=True, slots=True)
class ApprovedRoots:
    song_root: Path
    staging_root: Path
    model_root: Path
    tool_root: Path


@dataclass(frozen=True, slots=True)
class ModelInput:
    model_id: str
    version: str
    engine: str
    path: Path
    sha256: str
    license_expression: str


@dataclass(frozen=True, slots=True)
class ToolInput:
    tool_id: str
    version: str
    path: Path
    sha256: str


@dataclass(frozen=True, slots=True)
class AnalyzerConfig:
    sample_rate_hz: int
    pitch_min_hz: float
    pitch_max_hz: float
    confidence_threshold: float
    max_interpolated_gap_ms: int


@dataclass(frozen=True, slots=True)
class AnalyzerRequest:
    schema_version: int
    job_id: str
    song_id: str
    requested_analysis_id: str
    input_path: Path
    staging_path: Path
    expected_duration_ms: int
    pipeline_version: str
    roots: ApprovedRoots
    models: tuple[ModelInput, ...]
    tools: tuple[ToolInput, ...]
    config: AnalyzerConfig

    def model(self, model_id: str) -> ModelInput:
        matches = [model for model in self.models if model.model_id == model_id]
        if len(matches) != 1:
            raise invalid_request("model_set")
        return matches[0]

    def tool(self, tool_id: str) -> ToolInput:
        matches = [tool for tool in self.tools if tool.tool_id == tool_id]
        if len(matches) != 1:
            raise invalid_request("tool_set")
        return matches[0]


def parse_request(value: object) -> AnalyzerRequest:
    root = _record(value, "request_object")
    if root.get("schemaVersion") != 1:
        raise invalid_request("schema_version")

    job_id = _uuid(root.get("jobId"), "job_id")
    song_id = _sha256(root.get("songId"), "song_id")
    requested_analysis_id = _string(root.get("requestedAnalysisId"), "analysis_id")
    if ANALYSIS_ID_PATTERN.fullmatch(requested_analysis_id) is None:
        raise invalid_request("analysis_id")

    roots_value = _record(root.get("roots"), "roots")
    roots = ApprovedRoots(
        song_root=_absolute_path(roots_value.get("songRoot"), "song_root"),
        staging_root=_absolute_path(roots_value.get("stagingRoot"), "staging_root"),
        model_root=_absolute_path(roots_value.get("modelRoot"), "model_root"),
        tool_root=_absolute_path(roots_value.get("toolRoot"), "tool_root"),
    )

    models_value = root.get("models")
    if not isinstance(models_value, list) or not (1 <= len(models_value) <= 8):
        raise invalid_request("models")
    models: list[ModelInput] = []
    for item in models_value:
        model = _record(item, "model")
        models.append(
            ModelInput(
                model_id=_string(model.get("modelId"), "model_id"),
                version=_string(model.get("version"), "model_version"),
                engine=_string(model.get("engine"), "model_engine"),
                path=_absolute_path(model.get("path"), "model_path"),
                sha256=_sha256(model.get("sha256"), "model_hash"),
                license_expression=_string(model.get("licenseExpression"), "model_license"),
            )
        )

    tools_value = root.get("tools")
    if not isinstance(tools_value, list) or not (1 <= len(tools_value) <= 8):
        raise invalid_request("tools")
    tools: list[ToolInput] = []
    for item in tools_value:
        tool = _record(item, "tool")
        tools.append(
            ToolInput(
                tool_id=_string(tool.get("toolId"), "tool_id"),
                version=_string(tool.get("version"), "tool_version"),
                path=_absolute_path(tool.get("path"), "tool_path"),
                sha256=_sha256(tool.get("sha256"), "tool_hash"),
            )
        )

    config_value = _record(root.get("config"), "config")
    sample_rate = config_value.get("sampleRateHz")
    gap = config_value.get("maxInterpolatedGapMs")
    pitch_min = config_value.get("pitchMinHz")
    pitch_max = config_value.get("pitchMaxHz")
    confidence = config_value.get("confidenceThreshold")
    if sample_rate != 48_000 or not isinstance(gap, int) or not (0 <= gap <= 50):
        raise invalid_request("config_audio")
    if not isinstance(pitch_min, int | float) or not isinstance(pitch_max, int | float):
        raise invalid_request("config_pitch")
    if not (0 < float(pitch_min) < float(pitch_max)):
        raise invalid_request("config_pitch")
    if not isinstance(confidence, int | float) or not (0 <= float(confidence) <= 1):
        raise invalid_request("config_confidence")

    expected_duration = root.get("expectedDurationMs")
    if not isinstance(expected_duration, int) or not (0 < expected_duration <= 1_200_000):
        raise invalid_request("duration")

    return AnalyzerRequest(
        schema_version=1,
        job_id=job_id,
        song_id=song_id,
        requested_analysis_id=requested_analysis_id,
        input_path=_absolute_path(root.get("inputPath"), "input_path"),
        staging_path=_absolute_path(root.get("stagingPath"), "staging_path"),
        expected_duration_ms=expected_duration,
        pipeline_version=_string(root.get("pipelineVersion"), "pipeline_version"),
        roots=roots,
        models=tuple(models),
        tools=tuple(tools),
        config=AnalyzerConfig(
            sample_rate_hz=sample_rate,
            pitch_min_hz=float(pitch_min),
            pitch_max_hz=float(pitch_max),
            confidence_threshold=float(confidence),
            max_interpolated_gap_ms=gap,
        ),
    )
