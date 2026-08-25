from __future__ import annotations

import os
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Protocol

from .errors import AnalyzerFailure


class CancellationState(Protocol):
    @property
    def cancelled(self) -> bool: ...

    @property
    def protocol_error(self) -> bool: ...


@dataclass(frozen=True, slots=True)
class ProcessResult:
    return_code: int
    stdout: bytes
    stderr: bytes
    stdout_truncated: bool
    stderr_truncated: bool


class _BoundedDrain:
    def __init__(self, stream: IO[bytes], limit: int) -> None:
        self._stream = stream
        self._limit = limit
        self.data = bytearray()
        self.truncated = False

    def run(self) -> None:
        while chunk := self._stream.read(8192):
            remaining = self._limit - len(self.data)
            if remaining > 0:
                self.data.extend(chunk[:remaining])
            if len(chunk) > max(remaining, 0):
                self.truncated = True


def run_process(
    executable: Path,
    arguments: list[str],
    *,
    cancel: CancellationState,
    stage: str,
    timeout_seconds: float,
    stdout_limit: int = 1024 * 1024,
    stderr_limit: int = 64 * 1024,
) -> ProcessResult:
    command = [str(executable), *arguments]
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(executable.parent),
            env={
                "PATH": str(executable.parent),
                "SYSTEMROOT": os.environ.get("SYSTEMROOT", r"C:\Windows"),
                "WINDIR": os.environ.get("WINDIR", r"C:\Windows"),
                "TEMP": os.environ.get("TEMP", str(executable.parent)),
                "TMP": os.environ.get("TMP", str(executable.parent)),
            },
            shell=False,
            creationflags=(
                subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
            ),
        )
    except OSError as error:
        raise AnalyzerFailure(
            code="ANALYZER_STAGE_FAILED",
            message_key="analyzer.error.toolStartFailed",
            stage=stage,
            retryable=True,
            safe_details={"tool": executable.name},
        ) from error

    assert process.stdout is not None
    assert process.stderr is not None
    stdout_drain = _BoundedDrain(process.stdout, stdout_limit)
    stderr_drain = _BoundedDrain(process.stderr, stderr_limit)
    threads = [
        threading.Thread(target=stdout_drain.run, name=f"{stage}-stdout", daemon=True),
        threading.Thread(target=stderr_drain.run, name=f"{stage}-stderr", daemon=True),
    ]
    for thread in threads:
        thread.start()

    deadline = time.monotonic() + timeout_seconds
    while process.poll() is None:
        if cancel.cancelled or cancel.protocol_error:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
            break
        if time.monotonic() >= deadline:
            process.kill()
            raise AnalyzerFailure(
                code="ANALYZER_STAGE_FAILED",
                message_key="analyzer.error.toolTimeout",
                stage=stage,
                retryable=True,
                safe_details={"tool": executable.name},
            )
        time.sleep(0.02)

    return_code = process.wait()
    for thread in threads:
        thread.join(timeout=2)
    return ProcessResult(
        return_code=return_code,
        stdout=bytes(stdout_drain.data),
        stderr=bytes(stderr_drain.data),
        stdout_truncated=stdout_drain.truncated,
        stderr_truncated=stderr_drain.truncated,
    )
