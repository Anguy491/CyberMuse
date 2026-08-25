from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from cybermuse_analyzer.contracts import AnalyzerRequest
from cybermuse_analyzer.errors import AnalyzerFailure
from cybermuse_analyzer.path_safety import validate_request_paths


@pytest.mark.contract
def test_unicode_space_paths_are_accepted(analyzer_request: AnalyzerRequest) -> None:
    validate_request_paths(analyzer_request)


@pytest.mark.contract
def test_input_escape_is_rejected(analyzer_request: AnalyzerRequest, tmp_path: Path) -> None:
    outside = tmp_path / "outside.flac"
    outside.write_bytes(b"outside")
    with pytest.raises(AnalyzerFailure) as raised:
        validate_request_paths(replace(analyzer_request, input_path=outside))
    assert raised.value.safe_details == {"reason": "input_escape"}


@pytest.mark.contract
def test_staging_job_mismatch_is_rejected(analyzer_request: AnalyzerRequest) -> None:
    wrong = analyzer_request.roots.staging_root / "wrong-job"
    wrong.mkdir()
    with pytest.raises(AnalyzerFailure) as raised:
        validate_request_paths(replace(analyzer_request, staging_path=wrong))
    assert raised.value.safe_details == {"reason": "staging_job_mismatch"}


@pytest.mark.contract
def test_missing_model_candidate_is_safe_then_reported_by_pipeline(
    analyzer_request: AnalyzerRequest,
) -> None:
    missing = analyzer_request.models[0].path.parent / "missing-model.bin"
    request = replace(
        analyzer_request,
        models=(replace(analyzer_request.models[0], path=missing),),
    )
    validate_request_paths(request)

    from cybermuse_analyzer.pipeline import verify_request_materials

    with pytest.raises(AnalyzerFailure) as raised:
        verify_request_materials(request)
    assert raised.value.code == "ANALYZER_MODEL_MISSING"
    assert raised.value.safe_details["modelId"] == analyzer_request.models[0].model_id
