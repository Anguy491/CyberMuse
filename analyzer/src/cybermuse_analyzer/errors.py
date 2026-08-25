from __future__ import annotations

from dataclasses import dataclass, field
from uuid import uuid4

type SafeValue = str | int | float | bool


@dataclass(frozen=True, slots=True)
class AnalyzerFailure(Exception):
    code: str
    message_key: str
    stage: str | None
    retryable: bool
    safe_details: dict[str, SafeValue] = field(default_factory=dict)
    exit_code: int = 10
    diagnostic_id: str = field(default_factory=lambda: f"analyzer-{uuid4()}")

    def as_payload(self) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "code": self.code,
            "messageKey": self.message_key,
            "stage": self.stage,
            "retryable": self.retryable,
            "safeDetails": dict(self.safe_details),
            "diagnosticId": self.diagnostic_id,
        }


def invalid_request(reason: str) -> AnalyzerFailure:
    return AnalyzerFailure(
        code="ANALYZER_INVALID_REQUEST",
        message_key="analyzer.error.invalidRequest",
        stage=None,
        retryable=False,
        safe_details={"reason": reason},
        exit_code=2,
    )
