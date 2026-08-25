from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path
from uuid import uuid4

from m4_quality_report import _separation_fixture

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
    parser.add_argument("--duration-seconds", required=True, type=int)
    return parser


def _minimum_environment(executable: Path) -> dict[str, str]:
    return {
        "PATH": str(executable.parent),
        "SYSTEMROOT": os.environ.get("SYSTEMROOT", r"C:\Windows"),
        "WINDIR": os.environ.get("WINDIR", r"C:\Windows"),
        "TEMP": os.environ.get("TEMP", str(executable.parent)),
        "TMP": os.environ.get("TMP", str(executable.parent)),
    }


def _ensure_input(root: Path, ffmpeg: Path, duration_seconds: int) -> Path:
    seed = root / "seed-8s.wav"
    if not seed.is_file():
        vocal, accompaniment = _separation_fixture()
        mixture = vocal + accompaniment
        write_pcm24_wav(seed, [mixture[:, 0].tolist(), mixture[:, 1].tolist()], 48_000)
    output = root / f"input-{duration_seconds}s.flac"
    if not output.is_file():
        result = subprocess.run(
            [
                str(ffmpeg),
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-stream_loop",
                "-1",
                "-i",
                str(seed),
                "-t",
                str(duration_seconds),
                "-ar",
                "48000",
                "-ac",
                "2",
                "-c:a",
                "flac",
                str(output),
            ],
            check=False,
            cwd=ffmpeg.parent,
            env=_minimum_environment(ffmpeg),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        if result.returncode != 0 or not output.is_file():
            raise RuntimeError("performance input generation failed")
    return output


def main() -> int:
    args = _parser().parse_args()
    if args.duration_seconds not in {30, 180, 300, 600}:
        raise ValueError("duration must be warm-up or 3/5/10 minutes")
    artifact_root = args.artifact_root.resolve(strict=True)
    model_root = args.model_root.resolve(strict=True)
    ffmpeg = args.ffmpeg.resolve(strict=True)
    ffprobe = args.ffprobe.resolve(strict=True)
    spleeter_engine = args.spleeter_engine.resolve(strict=True)
    tool_root = Path(os.path.commonpath([ffmpeg, ffprobe, spleeter_engine]))
    performance_root = artifact_root / "performance-work"
    song_root = performance_root / "songs"
    staging_root = performance_root / "staging"
    song_root.mkdir(parents=True, exist_ok=True)
    staging_root.mkdir(parents=True, exist_ok=True)
    input_path = _ensure_input(song_root, ffmpeg, args.duration_seconds)
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
            "songRoot": str(song_root),
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
