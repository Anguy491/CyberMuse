from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from .contracts import AnalyzerRequest
from .media import ProbeResult, normalize, probe
from .postprocess import RawPitchFrame
from .separation import separate_spleeter
from .subprocesses import CancellationState
from .swiftf0 import detect_pitch


class OfflineBackend:
    """Production backend whose engines are populated by approved M4 adapters."""

    def probe(self, request: AnalyzerRequest, cancel: CancellationState) -> ProbeResult:
        return probe(request, cancel)

    def normalize(
        self, request: AnalyzerRequest, cancel: CancellationState, destination: Path
    ) -> None:
        normalize(request, cancel, destination)

    def separate(
        self,
        request: AnalyzerRequest,
        cancel: CancellationState,
        normalized_path: Path,
        vocals_path: Path,
        instrumental_path: Path,
        progress: Callable[[float], None],
    ) -> None:
        separate_spleeter(
            request,
            cancel,
            normalized_path,
            vocals_path,
            instrumental_path,
            progress,
        )

    def pitch(
        self,
        request: AnalyzerRequest,
        cancel: CancellationState,
        vocals_path: Path,
        progress: Callable[[float], None],
    ) -> list[RawPitchFrame]:
        return detect_pitch(request, cancel, vocals_path, progress)
