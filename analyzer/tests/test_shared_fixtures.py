from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from cybermuse_analyzer.contracts import STAGES, parse_request
from cybermuse_analyzer.errors import AnalyzerFailure

FIXTURES = Path(__file__).parents[2] / "fixtures" / "contracts" / "analyzer"
JOB_ID = "4ab0c16f-1234-4abc-8def-1234567890ab"


def fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.mark.contract
def test_shared_analyzer_request_current_extra_and_unknown_major() -> None:
    current = parse_request(fixture("analyzer-request-v1-current.json"))
    assert len(str(current.input_path)) > 180
    assert "歌曲 根目录" in str(current.input_path)
    extra = parse_request(fixture("analyzer-request-v1-extra.json"))
    assert extra.schema_version == 1
    with pytest.raises(AnalyzerFailure) as raised:
        parse_request(fixture("analyzer-request-v2-unsupported.json"))
    assert raised.value.safe_details == {"reason": "schema_version"}


@pytest.mark.contract
def test_shared_protocol_trace_cancel_and_terminal_variants() -> None:
    trace = fixture("protocol-v1-current.json")
    assert isinstance(trace, list)
    assert trace[0]["type"] == "hello"
    assert "sequence" not in trace[0]
    assert [message["sequence"] for message in trace[1:]] == list(range(1, len(trace)))
    assert [message["stage"] for message in trace if message["type"] == "progress"] == list(STAGES)
    assert trace[-1]["type"] == "completed"
    assert trace[-1]["manifestRelativePath"] == "analysis.json"
    assert all(message["jobId"] == JOB_ID for message in trace)

    control = fixture("cancel-v1-current.json")
    assert control == {"schemaVersion": 1, "type": "cancel", "jobId": JOB_ID}
    terminals = fixture("protocol-v1-terminals.json")
    assert terminals["failed"]["error"]["code"] == "ANALYZER_MODEL_MISSING"
    assert terminals["cancelled"]["type"] == "cancelled"


@pytest.mark.contract
def test_shared_model_and_tauri_payload_fixtures() -> None:
    catalog = fixture("model-catalog-v1-current.json")
    assert catalog["schemaVersion"] == 1
    assert {model["modelId"] for model in catalog["models"]} == {
        "demucs-htdemucs",
        "swiftf0",
    }
    manifest = fixture("model-manifest-v1-current.json")
    assert manifest["sha256"] == (
        "212715116025a490be70db0afda8fb27b1eadf267a3b18ed8df4866c1574e717"
    )
    payloads = fixture("tauri-payloads-v1-current.json")
    assert payloads["installModel"]["consentToken"] == manifest["sha256"]
    assert payloads["analysisProgress"]["stage"] == "pitch"
