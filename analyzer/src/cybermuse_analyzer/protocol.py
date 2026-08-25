from __future__ import annotations

import json
import sys
import threading
from dataclasses import dataclass, field
from typing import TextIO

from .json_limits import MAX_NDJSON_LINE_BYTES, loads_strict
from .version import ANALYZER_VERSION, PROTOCOL_MAJOR, SCHEMA_VERSION


class ProtocolStateError(RuntimeError):
    pass


@dataclass(slots=True)
class ProtocolWriter:
    job_id: str
    stream: TextIO = sys.stdout
    sequence: int = 0
    terminal_sent: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def _write(self, payload: dict[str, object], *, terminal: bool = False) -> None:
        with self._lock:
            if self.terminal_sent:
                raise ProtocolStateError("output attempted after terminal")
            line = json.dumps(
                payload,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            )
            if len(line.encode("utf-8")) > MAX_NDJSON_LINE_BYTES:
                raise ProtocolStateError("protocol line exceeds 64 KiB")
            self.stream.write(line + "\n")
            self.stream.flush()
            if terminal:
                self.terminal_sent = True

    def hello(self) -> None:
        self._write(
            {
                "schemaVersion": SCHEMA_VERSION,
                "type": "hello",
                "jobId": self.job_id,
                "protocolMajor": PROTOCOL_MAJOR,
                "analyzerVersion": ANALYZER_VERSION,
            }
        )

    def event(self, event_type: str, **values: object) -> None:
        self.sequence += 1
        self._write(
            {
                "schemaVersion": SCHEMA_VERSION,
                "type": event_type,
                "jobId": self.job_id,
                "sequence": self.sequence,
                **values,
            }
        )

    def completed(self, manifest_relative_path: str = "analysis.json") -> None:
        self.sequence += 1
        self._write(
            {
                "schemaVersion": SCHEMA_VERSION,
                "type": "completed",
                "jobId": self.job_id,
                "sequence": self.sequence,
                "manifestRelativePath": manifest_relative_path,
            },
            terminal=True,
        )

    def failed(self, error: dict[str, object]) -> None:
        self.sequence += 1
        self._write(
            {
                "schemaVersion": SCHEMA_VERSION,
                "type": "failed",
                "jobId": self.job_id,
                "sequence": self.sequence,
                "error": error,
            },
            terminal=True,
        )

    def cancelled(self) -> None:
        self.sequence += 1
        self._write(
            {
                "schemaVersion": SCHEMA_VERSION,
                "type": "cancelled",
                "jobId": self.job_id,
                "sequence": self.sequence,
            },
            terminal=True,
        )


@dataclass(slots=True)
class CancellationMonitor:
    job_id: str
    stream: TextIO = sys.stdin
    _cancelled: threading.Event = field(default_factory=threading.Event)
    _protocol_error: threading.Event = field(default_factory=threading.Event)
    _thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._read, name="cancel-monitor", daemon=True)
        self._thread.start()

    @property
    def cancelled(self) -> bool:
        return self._cancelled.is_set()

    @property
    def protocol_error(self) -> bool:
        return self._protocol_error.is_set()

    def _read(self) -> None:
        while True:
            line = self.stream.readline(MAX_NDJSON_LINE_BYTES + 1)
            if line == "":
                return
            if len(line.encode("utf-8")) > MAX_NDJSON_LINE_BYTES:
                self._protocol_error.set()
                return
            try:
                value = loads_strict(line)
            except (ValueError, json.JSONDecodeError):
                print("ignored invalid analyzer control message", file=sys.stderr, flush=True)
                continue
            if not isinstance(value, dict) or value.get("schemaVersion") != 1:
                print("ignored unsupported analyzer control message", file=sys.stderr, flush=True)
                continue
            if value.get("type") != "cancel":
                print("ignored unknown analyzer control type", file=sys.stderr, flush=True)
                continue
            if value.get("jobId") != self.job_id:
                self._protocol_error.set()
                return
            self._cancelled.set()
            return
