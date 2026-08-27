from __future__ import annotations

import json
import struct
from collections.abc import Callable
from pathlib import Path

import pytest

from cybermuse_analyzer.cancellation import AnalysisCancelled
from cybermuse_analyzer.contracts import STAGES, AnalyzerRequest
from cybermuse_analyzer.errors import AnalyzerFailure
from cybermuse_analyzer.media import ProbeResult, inspect_pcm_wav, write_pcm24_wav
from cybermuse_analyzer.pipeline import run_pipeline
from cybermuse_analyzer.postprocess import RawPitchFrame
from cybermuse_analyzer.subprocesses import CancellationState


class Control(CancellationState):
    def __init__(
        self,
        *,
        cancelled: bool = False,
        protocol_error: bool = False,
        cancel_on_read: int | None = None,
    ) -> None:
        self._cancelled = cancelled
        self._protocol_error = protocol_error
        self._cancel_on_read = cancel_on_read
        self._reads = 0

    @property
    def cancelled(self) -> bool:
        self._reads += 1
        if self._cancel_on_read == self._reads:
            self._cancelled = True
        return self._cancelled

    @property
    def protocol_error(self) -> bool:
        return self._protocol_error


class FixtureBackend:
    def probe(self, request: AnalyzerRequest, cancel: CancellationState) -> ProbeResult:
        del request, cancel
        return ProbeResult(100, 44_100, 1)

    def normalize(
        self, request: AnalyzerRequest, cancel: CancellationState, destination: Path
    ) -> None:
        del request, cancel
        write_pcm24_wav(destination, [[0.0] * 4_800, [0.0] * 4_800], 48_000)

    def separate(
        self,
        request: AnalyzerRequest,
        cancel: CancellationState,
        normalized_path: Path,
        vocals_path: Path,
        instrumental_path: Path,
        progress: Callable[[float], None],
    ) -> None:
        del request, cancel, normalized_path
        progress(0.5)
        samples = [0.0] * 4_800
        write_pcm24_wav(vocals_path, [samples, samples], 48_000)
        write_pcm24_wav(instrumental_path, [samples, samples], 48_000)

    def pitch(
        self,
        request: AnalyzerRequest,
        cancel: CancellationState,
        vocals_path: Path,
        progress: Callable[[float], None],
    ) -> list[RawPitchFrame]:
        del request, cancel, vocals_path
        progress(0.5)
        return [RawPitchFrame(time_ms, 220.0, 0.99, True) for time_ms in range(0, 100, 20)]


class CollapsedStemBackend(FixtureBackend):
    pitch_called = False

    def separate(
        self,
        request: AnalyzerRequest,
        cancel: CancellationState,
        normalized_path: Path,
        vocals_path: Path,
        instrumental_path: Path,
        progress: Callable[[float], None],
    ) -> None:
        del request, cancel, normalized_path
        samples = [0.2 if index % 2 else -0.2 for index in range(4_800)]
        write_pcm24_wav(vocals_path, [samples, samples], 48_000)
        write_pcm24_wav(instrumental_path, [samples, samples], 48_000)
        progress(1.0)

    def pitch(
        self,
        request: AnalyzerRequest,
        cancel: CancellationState,
        vocals_path: Path,
        progress: Callable[[float], None],
    ) -> list[RawPitchFrame]:
        del request, cancel, vocals_path, progress
        self.pitch_called = True
        return []


@pytest.mark.contract
def test_pipeline_writes_manifest_last_and_monotonic_progress(
    analyzer_request: AnalyzerRequest,
) -> None:
    progress: list[tuple[str, float, float]] = []
    result = run_pipeline(
        analyzer_request,
        FixtureBackend(),
        Control(),
        lambda stage, stage_progress, total: progress.append((stage, stage_progress, total)),
    )
    manifest = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    reference = json.loads(result.reference_track_path.read_text(encoding="utf-8"))
    assert manifest["analysisId"] == analyzer_request.requested_analysis_id
    assert manifest["songId"] == analyzer_request.song_id
    assert [artifact["kind"] for artifact in manifest["artifacts"]] == [
        "instrumental",
        "vocals",
        "reference_track",
    ]
    assert len(reference["frames"]) == 5
    assert [item[0] for item in progress if item[1] == 1.0] == list(STAGES)
    assert [item[2] for item in progress] == sorted(item[2] for item in progress)
    assert progress[-1][2] == pytest.approx(1.0)
    assert not (analyzer_request.staging_path / "analysis.json.tmp").exists()
    assert not (analyzer_request.staging_path / "work").exists()


@pytest.mark.contract
def test_pre_cancel_does_not_publish_partial_outputs(analyzer_request: AnalyzerRequest) -> None:
    with pytest.raises(AnalysisCancelled):
        run_pipeline(analyzer_request, FixtureBackend(), Control(cancelled=True), lambda *_: None)
    assert not (analyzer_request.staging_path / "analysis.json").exists()
    assert not (analyzer_request.staging_path / "vocals.wav").exists()


@pytest.mark.contract
@pytest.mark.parametrize(
    ("stage", "cancel_on_read"),
    zip(STAGES, range(1, 7), strict=True),
)
def test_cancel_at_every_stage_removes_all_publishable_outputs(
    analyzer_request: AnalyzerRequest,
    stage: str,
    cancel_on_read: int,
) -> None:
    del stage
    with pytest.raises(AnalysisCancelled):
        run_pipeline(
            analyzer_request,
            FixtureBackend(),
            Control(cancel_on_read=cancel_on_read),
            lambda *_: None,
        )
    for name in ("vocals.wav", "instrumental.wav", "reference-track.json", "analysis.json"):
        assert not (analyzer_request.staging_path / name).exists()
    assert not (analyzer_request.staging_path / "work").exists()


@pytest.mark.contract
def test_cancel_during_write_removes_reference_and_stems(analyzer_request: AnalyzerRequest) -> None:
    with pytest.raises(AnalysisCancelled):
        run_pipeline(
            analyzer_request,
            FixtureBackend(),
            Control(cancel_on_read=7),
            lambda *_: None,
        )
    assert not (analyzer_request.staging_path / "reference-track.json").exists()
    assert not (analyzer_request.staging_path / "analysis.json").exists()
    assert not (analyzer_request.staging_path / "vocals.wav").exists()


def test_rejects_mismatched_fingerprint(analyzer_request: AnalyzerRequest) -> None:
    from dataclasses import replace

    with pytest.raises(AnalyzerFailure):
        run_pipeline(
            replace(analyzer_request, requested_analysis_id="0" * 32),
            FixtureBackend(),
            Control(),
            lambda *_: None,
        )


def test_collapsed_stems_fail_before_pitch_or_manifest(analyzer_request: AnalyzerRequest) -> None:
    backend = CollapsedStemBackend()
    with pytest.raises(AnalyzerFailure) as captured:
        run_pipeline(analyzer_request, backend, Control(), lambda *_: None)

    assert captured.value.code == "ANALYZER_OUTPUT_SEMANTIC_INVALID"
    assert not backend.pitch_called
    for name in ("vocals.wav", "instrumental.wav", "reference-track.json", "analysis.json"):
        assert not (analyzer_request.staging_path / name).exists()


def test_inspects_ffmpeg_pcm24_wave_format_extensible(tmp_path: Path) -> None:
    pcm_guid = bytes.fromhex("0100000000001000800000aa00389b71")
    fmt = struct.pack("<HHIIHHH", 0xFFFE, 2, 48_000, 288_000, 6, 24, 22)
    fmt += struct.pack("<HI", 24, 3) + pcm_guid
    data = bytes(6)
    riff_size = 4 + 8 + len(fmt) + 8 + len(data)
    path = tmp_path / "extensible.wav"
    path.write_bytes(
        b"RIFF"
        + struct.pack("<I", riff_size)
        + b"WAVEfmt "
        + struct.pack("<I", len(fmt))
        + fmt
        + b"data"
        + struct.pack("<I", len(data))
        + data
    )
    assert inspect_pcm_wav(path) == (48_000, 2, 0)
