from __future__ import annotations

import argparse
import math
import os
from pathlib import Path
from uuid import uuid4

from cybermuse_analyzer.contracts import parse_request
from cybermuse_analyzer.hashing import sha256_file
from cybermuse_analyzer.io_utils import atomic_write_json
from cybermuse_analyzer.media import write_pcm24_wav
from cybermuse_analyzer.pipeline import expected_analysis_id


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-root", required=True, type=Path)
    parser.add_argument("--model-root", required=True, type=Path)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    parser.add_argument("--ffprobe", required=True, type=Path)
    parser.add_argument("--spleeter-engine", required=True, type=Path)
    parser.add_argument("--duration-seconds", type=int, default=6)
    return parser


def _generate_mix(path: Path, duration_seconds: int) -> None:
    sample_rate = 48_000
    sample_count = duration_seconds * sample_rate
    fade_samples = sample_rate // 20
    left: list[float] = []
    right: list[float] = []
    for index in range(sample_count):
        time_seconds = index / sample_rate
        envelope = min(1.0, index / fade_samples, (sample_count - index - 1) / fade_samples)
        vocal = 0.26 * math.sin(2 * math.pi * 220 * time_seconds)
        vocal += 0.09 * math.sin(2 * math.pi * 440 * time_seconds)
        accompaniment_left = 0.11 * math.sin(2 * math.pi * 329.6276 * time_seconds)
        accompaniment_right = 0.11 * math.sin(2 * math.pi * 391.9954 * time_seconds)
        left.append(envelope * (vocal + accompaniment_left))
        right.append(envelope * (vocal + accompaniment_right))
    write_pcm24_wav(path, [left, right], sample_rate)


def main() -> int:
    args = _parser().parse_args()
    artifact_root = args.artifact_root.resolve(strict=True)
    model_root = args.model_root.resolve(strict=True)
    ffmpeg = args.ffmpeg.resolve(strict=True)
    ffprobe = args.ffprobe.resolve(strict=True)
    spleeter_engine = args.spleeter_engine.resolve(strict=True)
    tool_root = Path(os.path.commonpath([ffmpeg, ffprobe, spleeter_engine]))

    smoke_root = artifact_root / "smoke"
    song_root = smoke_root / "Unicode 与 spaces" / ("long-path-" + "x" * 96)
    staging_root = smoke_root / "staging"
    song_root.mkdir(parents=True, exist_ok=True)
    staging_root.mkdir(parents=True, exist_ok=True)
    input_path = song_root / "合成 song fixture.wav"
    _generate_mix(input_path, args.duration_seconds)

    job_id = str(uuid4())
    staging_path = staging_root / job_id
    staging_path.mkdir()
    request: dict[str, object] = {
        "schemaVersion": 1,
        "jobId": job_id,
        "songId": sha256_file(input_path),
        "requestedAnalysisId": "0" * 32,
        "inputPath": str(input_path),
        "stagingPath": str(staging_path),
        "expectedDurationMs": args.duration_seconds * 1000,
        "pipelineVersion": "m4-production-v1",
        "roots": {
            "songRoot": str(smoke_root),
            "stagingRoot": str(staging_root),
            "modelRoot": str(model_root),
            "toolRoot": str(tool_root),
        },
        "models": [
            {
                "modelId": "spleeter-2stems",
                "version": "1.4.0",
                "engine": "tensorflow-cpu",
                "path": str(model_root / "spleeter-2stems" / "1.4.0" / "2stems.tar.gz"),
                "sha256": "f3a90b39dd2874269e8b05a48a86745df897b848c61f3958efc80a39152bd692",
                "licenseExpression": "MIT",
            },
            {
                "modelId": "swiftf0",
                "version": "0.1.2",
                "engine": "onnxruntime-cpu",
                "path": str(model_root / "swiftf0" / "0.1.2" / "swift_f0-0.1.2-py3-none-any.whl"),
                "sha256": "212715116025a490be70db0afda8fb27b1eadf267a3b18ed8df4866c1574e717",
                "licenseExpression": "MIT",
            },
        ],
        "tools": [
            {
                "toolId": "ffmpeg",
                "version": "n9.0.1-6-g9d4ca21220",
                "path": str(ffmpeg),
                "sha256": sha256_file(ffmpeg),
            },
            {
                "toolId": "ffprobe",
                "version": "n9.0.1-6-g9d4ca21220",
                "path": str(ffprobe),
                "sha256": sha256_file(ffprobe),
            },
            {
                "toolId": "spleeter-engine",
                "version": "0.1.0",
                "path": str(spleeter_engine),
                "sha256": sha256_file(spleeter_engine),
            },
        ],
        "config": {
            "sampleRateHz": 48_000,
            "pitchMinHz": 65.0,
            "pitchMaxHz": 1046.5,
            "confidenceThreshold": 0.45,
            "maxInterpolatedGapMs": 50,
        },
    }
    parsed = parse_request(request)
    request["requestedAnalysisId"] = expected_analysis_id(parsed)
    request_path = staging_path / "request.json"
    atomic_write_json(request_path, request)
    print(request_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
