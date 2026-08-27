from __future__ import annotations

import shutil
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import pairwise
from pathlib import Path
from typing import Protocol

from .cancellation import AnalysisCancelled
from .contracts import STAGE_WEIGHTS, STAGES, AnalyzerRequest
from .errors import AnalyzerFailure, invalid_request
from .hashing import canonical_json_sha256, sha256_file
from .io_utils import atomic_write_json, flush_existing_file
from .media import ProbeResult, inspect_pcm_wav
from .postprocess import PitchFrame, RawPitchFrame, postprocess_frames
from .semantic_validation import validate_stem_semantics
from .subprocesses import CancellationState

ProgressCallback = Callable[[str, float, float], None]


class AnalysisBackend(Protocol):
    def probe(self, request: AnalyzerRequest, cancel: CancellationState) -> ProbeResult: ...

    def normalize(
        self, request: AnalyzerRequest, cancel: CancellationState, destination: Path
    ) -> None: ...

    def separate(
        self,
        request: AnalyzerRequest,
        cancel: CancellationState,
        normalized_path: Path,
        vocals_path: Path,
        instrumental_path: Path,
        progress: Callable[[float], None],
    ) -> None: ...

    def pitch(
        self,
        request: AnalyzerRequest,
        cancel: CancellationState,
        vocals_path: Path,
        progress: Callable[[float], None],
    ) -> list[RawPitchFrame]: ...


@dataclass(frozen=True, slots=True)
class AnalysisResult:
    manifest_path: Path
    reference_track_path: Path
    vocals_path: Path
    instrumental_path: Path


def _check_control(cancel: CancellationState) -> None:
    if cancel.protocol_error:
        raise invalid_request("control_job_mismatch")
    if cancel.cancelled:
        raise AnalysisCancelled


def _config_fingerprint_payload(request: AnalyzerRequest) -> dict[str, object]:
    return {
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
        "models": [
            {
                "modelId": model.model_id,
                "version": model.version,
                "engine": model.engine,
                "sha256": model.sha256,
            }
            for model in sorted(request.models, key=lambda item: item.model_id)
        ],
        "manifestSchemaMajor": 1,
        "referenceTrackSchemaMajor": 1,
    }


def expected_analysis_id(request: AnalyzerRequest) -> str:
    return canonical_json_sha256(_config_fingerprint_payload(request))[:32]


def verify_request_materials(request: AnalyzerRequest) -> None:
    if sha256_file(request.input_path) != request.song_id:
        raise invalid_request("input_hash")
    if expected_analysis_id(request) != request.requested_analysis_id:
        raise invalid_request("analysis_id_fingerprint")
    for model in request.models:
        if not model.path.is_file():
            raise AnalyzerFailure(
                code="ANALYZER_MODEL_MISSING",
                message_key="analyzer.error.modelMissing",
                stage=None,
                retryable=True,
                safe_details={"modelId": model.model_id, "version": model.version},
                exit_code=3,
            )
        if sha256_file(model.path) != model.sha256:
            raise AnalyzerFailure(
                code="ANALYZER_MODEL_INVALID",
                message_key="analyzer.error.modelInvalid",
                stage=None,
                retryable=False,
                safe_details={"modelId": model.model_id, "version": model.version},
                exit_code=3,
            )
    for tool in request.tools:
        if not tool.path.is_file() or sha256_file(tool.path) != tool.sha256:
            raise invalid_request("tool_hash")


def _artifact(
    kind: str,
    path: Path,
    *,
    duration_ms: int | None,
    sample_rate_hz: int | None,
    channels: int | None,
) -> dict[str, object]:
    return {
        "kind": kind,
        "relativePath": path.name,
        "mediaType": "audio/wav" if path.suffix == ".wav" else "application/json",
        "sizeBytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "durationMs": duration_ms,
        "sampleRateHz": sample_rate_hz,
        "channels": channels,
    }


def _write_outputs(
    request: AnalyzerRequest,
    probe: ProbeResult,
    frames: list[PitchFrame],
    vocals_path: Path,
    instrumental_path: Path,
    cancel: CancellationState,
) -> tuple[Path, Path]:
    reference_path = request.staging_path / "reference-track.json"
    manifest_path = request.staging_path / "analysis.json"
    hop_ms = (
        min((right.time_ms - left.time_ms for left, right in pairwise(frames)), default=0)
        if frames
        else 0
    )
    atomic_write_json(
        reference_path,
        {
            "schemaVersion": 1,
            "durationMs": probe.duration_ms,
            "hopMs": hop_ms,
            "minHz": request.config.pitch_min_hz,
            "maxHz": request.config.pitch_max_hz,
            "frames": [frame.as_json() for frame in frames],
        },
    )
    _check_control(cancel)
    flush_existing_file(vocals_path)
    flush_existing_file(instrumental_path)
    _check_control(cancel)
    try:
        vocal_rate, vocal_channels, vocal_duration = inspect_pcm_wav(vocals_path)
        instrumental_rate, instrumental_channels, instrumental_duration = inspect_pcm_wav(
            instrumental_path
        )
    except (OSError, ValueError) as error:
        raise AnalyzerFailure(
            code="ANALYZER_OUTPUT_INVALID",
            message_key="analyzer.error.outputInvalid",
            stage="write",
            retryable=True,
        ) from error
    if (
        vocal_rate != 48_000
        or instrumental_rate != 48_000
        or vocal_duration != instrumental_duration
        or abs(vocal_duration - probe.duration_ms) > 50
    ):
        raise AnalyzerFailure(
            code="ANALYZER_OUTPUT_INVALID",
            message_key="analyzer.error.outputInvalid",
            stage="write",
            retryable=True,
        )
    config_fingerprint = canonical_json_sha256(_config_fingerprint_payload(request))
    artifacts = [
        _artifact(
            "instrumental",
            instrumental_path,
            duration_ms=instrumental_duration,
            sample_rate_hz=instrumental_rate,
            channels=instrumental_channels,
        ),
        _artifact(
            "vocals",
            vocals_path,
            duration_ms=vocal_duration,
            sample_rate_hz=vocal_rate,
            channels=vocal_channels,
        ),
        _artifact(
            "reference_track",
            reference_path,
            duration_ms=probe.duration_ms,
            sample_rate_hz=None,
            channels=None,
        ),
    ]
    _check_control(cancel)
    atomic_write_json(
        manifest_path,
        {
            "schemaVersion": 1,
            "analysisId": request.requested_analysis_id,
            "songId": request.song_id,
            "inputSha256": request.song_id,
            "createdAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "pipelineVersion": request.pipeline_version,
            "configFingerprint": config_fingerprint,
            "durationMs": probe.duration_ms,
            "models": [
                {
                    "modelId": model.model_id,
                    "version": model.version,
                    "engine": model.engine,
                    "sha256": model.sha256,
                    "licenseExpression": model.license_expression,
                }
                for model in request.models
            ],
            "artifacts": artifacts,
            "referenceTrackRelativePath": "reference-track.json",
            "warnings": [],
        },
    )
    _check_control(cancel)
    return reference_path, manifest_path


def run_pipeline(
    request: AnalyzerRequest,
    backend: AnalysisBackend,
    cancel: CancellationState,
    on_progress: ProgressCallback,
) -> AnalysisResult:
    work_path = request.staging_path / "work"
    normalized_path = work_path / "normalized.wav"
    vocals_path = request.staging_path / "vocals.wav"
    instrumental_path = request.staging_path / "instrumental.wav"
    final_paths = (
        vocals_path,
        instrumental_path,
        request.staging_path / "reference-track.json",
        request.staging_path / "analysis.json",
    )
    completed_weight = 0.0

    def progress(stage: str, stage_progress: float) -> None:
        bounded = min(1.0, max(0.0, stage_progress))
        total = completed_weight + STAGE_WEIGHTS[stage] * bounded
        on_progress(stage, bounded, min(1.0, total))

    try:
        request.staging_path.mkdir(parents=False, exist_ok=True)
        work_path.mkdir(parents=False, exist_ok=False)
        verify_request_materials(request)
        _check_control(cancel)
        probe = backend.probe(request, cancel)
        if abs(probe.duration_ms - request.expected_duration_ms) > 1000:
            raise invalid_request("duration_mismatch")
        progress("probe", 1.0)
        completed_weight += STAGE_WEIGHTS["probe"]

        _check_control(cancel)
        backend.normalize(request, cancel, normalized_path)
        progress("normalize", 1.0)
        completed_weight += STAGE_WEIGHTS["normalize"]

        _check_control(cancel)
        backend.separate(
            request,
            cancel,
            normalized_path,
            vocals_path,
            instrumental_path,
            lambda value: progress("separate", value),
        )
        progress("separate", 1.0)
        completed_weight += STAGE_WEIGHTS["separate"]

        _check_control(cancel)
        validate_stem_semantics(vocals_path, instrumental_path)
        raw_frames = backend.pitch(
            request,
            cancel,
            vocals_path,
            lambda value: progress("pitch", value),
        )
        progress("pitch", 1.0)
        completed_weight += STAGE_WEIGHTS["pitch"]

        _check_control(cancel)
        frames = postprocess_frames(
            raw_frames,
            duration_ms=probe.duration_ms,
            min_hz=request.config.pitch_min_hz,
            max_hz=request.config.pitch_max_hz,
            max_interpolated_gap_ms=request.config.max_interpolated_gap_ms,
        )
        progress("postprocess", 1.0)
        completed_weight += STAGE_WEIGHTS["postprocess"]

        _check_control(cancel)
        reference_path, manifest_path = _write_outputs(
            request, probe, frames, vocals_path, instrumental_path, cancel
        )
        progress("write", 1.0)
        _check_control(cancel)
        return AnalysisResult(
            manifest_path=manifest_path,
            reference_track_path=reference_path,
            vocals_path=vocals_path,
            instrumental_path=instrumental_path,
        )
    except Exception:
        for path in final_paths:
            path.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(work_path, ignore_errors=True)
        if tuple(STAGES) != tuple(STAGE_WEIGHTS):
            raise RuntimeError("stage weights do not match stage order")
