from __future__ import annotations

import io
import json

import pytest

from cybermuse_analyzer.protocol import CancellationMonitor, ProtocolStateError, ProtocolWriter

JOB_ID = "4ab0c16f-bf39-44bf-bbc0-e9672b0f4d93"


@pytest.mark.contract
def test_protocol_has_hello_strict_sequences_and_one_terminal() -> None:
    stream = io.StringIO()
    writer = ProtocolWriter(JOB_ID, stream)
    writer.hello()
    writer.event("progress", stage="probe", stageProgress=1.0, progress=0.02)
    writer.completed()
    messages = [json.loads(line) for line in stream.getvalue().splitlines()]
    assert [message["type"] for message in messages] == ["hello", "progress", "completed"]
    assert "sequence" not in messages[0]
    assert [message["sequence"] for message in messages[1:]] == [1, 2]
    with pytest.raises(ProtocolStateError):
        writer.cancelled()


@pytest.mark.contract
def test_eof_is_not_cancellation() -> None:
    monitor = CancellationMonitor(JOB_ID, io.StringIO(""))
    monitor._read()
    assert monitor.cancelled is False
    assert monitor.protocol_error is False


@pytest.mark.contract
def test_matching_cancel_and_mismatched_job() -> None:
    cancel = CancellationMonitor(
        JOB_ID,
        io.StringIO(json.dumps({"schemaVersion": 1, "type": "cancel", "jobId": JOB_ID}) + "\n"),
    )
    cancel._read()
    assert cancel.cancelled is True
    mismatch = CancellationMonitor(
        JOB_ID,
        io.StringIO(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "type": "cancel",
                    "jobId": "6bd42a4a-d753-449c-ab12-94937a558374",
                }
            )
            + "\n"
        ),
    )
    mismatch._read()
    assert mismatch.protocol_error is True
