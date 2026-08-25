from __future__ import annotations

from pathlib import Path

import pytest

from cybermuse_analyzer.contracts import AnalyzerRequest, parse_request
from cybermuse_analyzer.errors import AnalyzerFailure
from cybermuse_analyzer.json_limits import loads_strict


def request_json(request: AnalyzerRequest) -> dict[str, object]:
    return {
        "schemaVersion": request.schema_version,
        "jobId": request.job_id,
        "songId": request.song_id,
        "requestedAnalysisId": request.requested_analysis_id,
        "inputPath": str(request.input_path),
        "stagingPath": str(request.staging_path),
        "expectedDurationMs": request.expected_duration_ms,
        "pipelineVersion": request.pipeline_version,
        "roots": {
            "songRoot": str(request.roots.song_root),
            "stagingRoot": str(request.roots.staging_root),
            "modelRoot": str(request.roots.model_root),
            "toolRoot": str(request.roots.tool_root),
        },
        "models": [
            {
                "modelId": model.model_id,
                "version": model.version,
                "engine": model.engine,
                "path": str(model.path),
                "sha256": model.sha256,
                "licenseExpression": model.license_expression,
            }
            for model in request.models
        ],
        "tools": [
            {
                "toolId": tool.tool_id,
                "version": tool.version,
                "path": str(tool.path),
                "sha256": tool.sha256,
            }
            for tool in request.tools
        ],
        "config": {
            "sampleRateHz": request.config.sample_rate_hz,
            "pitchMinHz": request.config.pitch_min_hz,
            "pitchMaxHz": request.config.pitch_max_hz,
            "confidenceThreshold": request.config.confidence_threshold,
            "maxInterpolatedGapMs": request.config.max_interpolated_gap_ms,
        },
    }


@pytest.mark.contract
def test_current_request_accepts_additive_unknown_field(analyzer_request: AnalyzerRequest) -> None:
    value = request_json(analyzer_request)
    value["futureOptionalField"] = {"ignored": True}
    parsed = parse_request(value)
    assert parsed == analyzer_request


@pytest.mark.contract
@pytest.mark.parametrize("schema_version", [0, 2])
def test_unsupported_schema_is_rejected(
    analyzer_request: AnalyzerRequest, schema_version: int
) -> None:
    value = request_json(analyzer_request)
    value["schemaVersion"] = schema_version
    with pytest.raises(AnalyzerFailure) as raised:
        parse_request(value)
    assert raised.value.exit_code == 2
    assert raised.value.safe_details == {"reason": "schema_version"}


@pytest.mark.contract
def test_relative_paths_are_rejected(analyzer_request: AnalyzerRequest) -> None:
    value = request_json(analyzer_request)
    value["inputPath"] = str(Path("relative.flac"))
    with pytest.raises(AnalyzerFailure) as raised:
        parse_request(value)
    assert raised.value.safe_details == {"reason": "input_path"}


def test_non_finite_and_deep_json_are_rejected() -> None:
    with pytest.raises(ValueError, match="non-finite"):
        loads_strict('{"value":NaN}')
    value: object = 1
    for _ in range(17):
        value = [value]
    import json

    with pytest.raises(ValueError, match="depth"):
        loads_strict(json.dumps(value))
