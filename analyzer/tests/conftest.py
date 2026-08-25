from __future__ import annotations

import hashlib
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path

import pytest

from cybermuse_analyzer.contracts import (
    AnalyzerConfig,
    AnalyzerRequest,
    ApprovedRoots,
    ModelInput,
    ToolInput,
)
from cybermuse_analyzer.pipeline import expected_analysis_id


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def analyzer_request(tmp_path: Path) -> Iterator[AnalyzerRequest]:
    song_root = tmp_path / "歌曲 library"
    staging_root = tmp_path / "分析 staging"
    model_root = tmp_path / "models"
    tool_root = tmp_path / "tools"
    for directory in (song_root, staging_root, model_root, tool_root):
        directory.mkdir()

    input_path = song_root / "旋律 sample.flac"
    input_path.write_bytes(b"deterministic-song-input")
    model_path = model_root / "model.bin"
    model_path.write_bytes(b"deterministic-model")
    ffmpeg_path = tool_root / "ffmpeg.exe"
    ffprobe_path = tool_root / "ffprobe.exe"
    ffmpeg_path.write_bytes(b"ffmpeg")
    ffprobe_path.write_bytes(b"ffprobe")
    job_id = "4ab0c16f-bf39-44bf-bbc0-e9672b0f4d93"
    staging_path = staging_root / job_id
    staging_path.mkdir()
    request = AnalyzerRequest(
        schema_version=1,
        job_id=job_id,
        song_id=file_sha256(input_path),
        requested_analysis_id="0" * 32,
        input_path=input_path,
        staging_path=staging_path,
        expected_duration_ms=100,
        pipeline_version="0.1.0",
        roots=ApprovedRoots(song_root, staging_root, model_root, tool_root),
        models=(
            ModelInput(
                model_id="fixture-model",
                version="1.0.0",
                engine="fixture",
                path=model_path,
                sha256=file_sha256(model_path),
                license_expression="MIT",
            ),
        ),
        tools=(
            ToolInput("ffmpeg", "fixture", ffmpeg_path, file_sha256(ffmpeg_path)),
            ToolInput("ffprobe", "fixture", ffprobe_path, file_sha256(ffprobe_path)),
        ),
        config=AnalyzerConfig(48_000, 65.41, 1046.5, 0.85, 50),
    )
    yield replace(request, requested_analysis_id=expected_analysis_id(request))
