from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np

from cybermuse_analyzer.backend import OfflineBackend
from cybermuse_analyzer.contracts import (
    AnalyzerConfig,
    AnalyzerRequest,
    ApprovedRoots,
    ModelInput,
    ToolInput,
)
from cybermuse_analyzer.hashing import sha256_file
from cybermuse_analyzer.io_utils import atomic_write_json
from cybermuse_analyzer.pipeline import expected_analysis_id, run_pipeline
from cybermuse_analyzer.semantic_validation import measure_stem_semantics

DEMUCS_SHA256 = "c3395410b1319976683bc874d97461655a9ea6089bbb0f3bd163d3829db13d02"
SWIFTF0_SHA256 = "212715116025a490be70db0afda8fb27b1eadf267a3b18ed8df4866c1574e717"
FFMPEG_VERSION = "n9.0.1-6-g9d4ca21220"


@dataclass(frozen=True, slots=True)
class NeverCancelled:
    cancelled: bool = False
    protocol_error: bool = False


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ceremony", required=True, type=Path)
    parser.add_argument("--moth-to-a-flame", required=True, type=Path)
    parser.add_argument("--model-root", required=True, type=Path)
    parser.add_argument("--ffmpeg", required=True, type=Path)
    parser.add_argument("--ffprobe", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--reuse-ceremony", type=Path)
    return parser


def _probe_duration_ms(ffprobe: Path, input_path: Path) -> int:
    completed = subprocess.run(
        [
            str(ffprobe),
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(input_path),
        ],
        check=True,
        capture_output=True,
        creationflags=(
            subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
        ),
    )
    return round(float(completed.stdout.decode("utf-8").strip()) * 1000)


def _request(
    *,
    input_path: Path,
    staging_path: Path,
    staging_root: Path,
    model_root: Path,
    ffmpeg: Path,
    ffprobe: Path,
) -> AnalyzerRequest:
    song_id = sha256_file(input_path)
    models = (
        ModelInput(
            model_id="demucs-htdemucs",
            version="spectral-v1.0.0",
            engine="onnxruntime-cpu-spectral",
            path=model_root / "demucs-htdemucs" / "spectral-v1.0.0" / "htdemucs.spectral.onnx",
            sha256=DEMUCS_SHA256,
            license_expression="MIT",
        ),
        ModelInput(
            model_id="swiftf0",
            version="0.1.2",
            engine="onnxruntime-cpu",
            path=model_root / "swiftf0" / "0.1.2" / "swift_f0-0.1.2-py3-none-any.whl",
            sha256=SWIFTF0_SHA256,
            license_expression="MIT",
        ),
    )
    tools = (
        ToolInput("ffmpeg", FFMPEG_VERSION, ffmpeg, sha256_file(ffmpeg)),
        ToolInput("ffprobe", FFMPEG_VERSION, ffprobe, sha256_file(ffprobe)),
    )
    request = AnalyzerRequest(
        schema_version=1,
        job_id=str(uuid4()),
        song_id=song_id,
        requested_analysis_id="0" * 32,
        input_path=input_path,
        staging_path=staging_path,
        expected_duration_ms=_probe_duration_ms(ffprobe, input_path),
        pipeline_version="m6-demucs-v1",
        roots=ApprovedRoots(
            song_root=input_path.parent,
            staging_root=staging_root,
            model_root=model_root,
            tool_root=ffmpeg.parent,
        ),
        models=models,
        tools=tools,
        config=AnalyzerConfig(48_000, 65.0, 1046.5, 0.45, 50),
    )
    return AnalyzerRequest(
        schema_version=request.schema_version,
        job_id=request.job_id,
        song_id=request.song_id,
        requested_analysis_id=expected_analysis_id(request),
        input_path=request.input_path,
        staging_path=request.staging_path,
        expected_duration_ms=request.expected_duration_ms,
        pipeline_version=request.pipeline_version,
        roots=request.roots,
        models=request.models,
        tools=request.tools,
        config=request.config,
    )


def _decode_f32(ffmpeg: Path, source: Path, destination: Path) -> None:
    subprocess.run(
        [
            str(ffmpeg),
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-f",
            "f32le",
            str(destination),
        ],
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=(
            subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
        ),
    )


def _reconstruction_ratio(
    ffmpeg: Path,
    mix_path: Path,
    vocals_path: Path,
    instrumental_path: Path,
) -> float:
    with tempfile.TemporaryDirectory(prefix="cybermuse-demucs-verification-") as raw_directory:
        raw_root = Path(raw_directory)
        raw_paths = [raw_root / name for name in ("mix.f32", "vocals.f32", "instrumental.f32")]
        for source, destination in zip(
            (mix_path, vocals_path, instrumental_path), raw_paths, strict=True
        ):
            _decode_f32(ffmpeg, source, destination)
        byte_sizes = [path.stat().st_size for path in raw_paths]
        if min(byte_sizes) <= 0 or max(byte_sizes) - min(byte_sizes) > 8192:
            raise ValueError("decoded reconstruction inputs have mismatched lengths")
        sample_count = min(byte_sizes) // 4
        arrays = [
            np.memmap(path, dtype="<f4", mode="r", shape=(sample_count,)) for path in raw_paths
        ]
        mix_squared = 0.0
        residual_squared = 0.0
        for start in range(0, sample_count, 2_000_000):
            stop = min(sample_count, start + 2_000_000)
            mix = np.asarray(arrays[0][start:stop], dtype=np.float64)
            residual = mix - np.asarray(arrays[1][start:stop], dtype=np.float64)
            residual -= np.asarray(arrays[2][start:stop], dtype=np.float64)
            mix_squared += float(np.dot(mix, mix))
            residual_squared += float(np.dot(residual, residual))
        if mix_squared <= 1e-20:
            raise ValueError("decoded mix is silent")
        ratio = float((residual_squared / mix_squared) ** 0.5)
        del arrays
        return ratio


def _measure_outputs(
    *,
    label: str,
    input_path: Path,
    output_directory: Path,
    ffmpeg: Path,
    elapsed_seconds: float | None,
) -> dict[str, object]:
    vocals_path = output_directory / "vocals.wav"
    instrumental_path = output_directory / "instrumental.wav"
    reference_path = output_directory / "reference-track.json"
    manifest_path = output_directory / "analysis.json"
    for path in (vocals_path, instrumental_path, reference_path, manifest_path):
        path.resolve(strict=True)
    metrics = measure_stem_semantics(vocals_path, instrumental_path)
    reconstruction_ratio = _reconstruction_ratio(ffmpeg, input_path, vocals_path, instrumental_path)
    reference = json.loads(reference_path.read_text(encoding="utf-8"))
    frames = reference["frames"]
    if not isinstance(frames, list) or not frames:
        raise ValueError("reference track contains no frames")
    voiced_count = sum(
        1 for frame in frames if isinstance(frame, dict) and frame.get("voiced") is True
    )
    voiced_ratio = voiced_count / len(frames)
    passed = (
        not metrics.identical_pcm
        and metrics.vocals_rms >= 1e-4
        and metrics.instrumental_rms >= 1e-4
        and abs(metrics.correlation) < 0.995
        and reconstruction_ratio < 0.25
        and 0.02 <= voiced_ratio <= 0.95
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    artifacts = manifest.get("artifacts", [])
    return {
        "label": label,
        "passed": passed,
        "durationMs": manifest.get("durationMs"),
        "elapsedSeconds": None if elapsed_seconds is None else round(elapsed_seconds, 3),
        "stemMetrics": {
            "vocalsRms": round(metrics.vocals_rms, 8),
            "instrumentalRms": round(metrics.instrumental_rms, 8),
            "correlation": round(metrics.correlation, 8),
            "scaleResidualRatio": round(metrics.residual_ratio, 8),
            "identicalPcm": metrics.identical_pcm,
            "mixReconstructionResidualRatio": round(reconstruction_ratio, 8),
        },
        "referenceTrack": {
            "frameCount": len(frames),
            "voicedFrameCount": voiced_count,
            "voicedFrameRatio": round(voiced_ratio, 8),
        },
        "artifacts": [
            {
                "kind": item.get("kind"),
                "relativePath": item.get("relativePath"),
                "sizeBytes": item.get("sizeBytes"),
                "sha256": item.get("sha256"),
            }
            for item in artifacts
            if isinstance(item, dict)
        ],
        "outputDirectoryName": output_directory.name,
    }


def _verify_song(
    *,
    label: str,
    input_path: Path,
    output_root: Path,
    model_root: Path,
    ffmpeg: Path,
    ffprobe: Path,
) -> dict[str, object]:
    job_id = str(uuid4())
    staging_path = output_root / job_id
    request = _request(
        input_path=input_path,
        staging_path=staging_path,
        staging_root=output_root,
        model_root=model_root,
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
    )
    # Keep the randomly generated request job ID and the directory contract aligned.
    request = AnalyzerRequest(
        schema_version=request.schema_version,
        job_id=job_id,
        song_id=request.song_id,
        requested_analysis_id=request.requested_analysis_id,
        input_path=request.input_path,
        staging_path=request.staging_path,
        expected_duration_ms=request.expected_duration_ms,
        pipeline_version=request.pipeline_version,
        roots=request.roots,
        models=request.models,
        tools=request.tools,
        config=request.config,
    )
    output_root.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    last_stage = ""

    def progress(stage: str, stage_progress: float, _total_progress: float) -> None:
        nonlocal last_stage
        if stage != last_stage or stage_progress >= 1.0:
            print(f"{label}: {stage} {stage_progress:.0%}", flush=True)
            last_stage = stage

    result = run_pipeline(request, OfflineBackend(), NeverCancelled(), progress)
    elapsed_seconds = time.perf_counter() - started
    return _measure_outputs(
        label=label,
        input_path=input_path,
        output_directory=result.manifest_path.parent,
        ffmpeg=ffmpeg,
        elapsed_seconds=elapsed_seconds,
    )


def main() -> int:
    args = _parser().parse_args()
    ceremony = args.ceremony.resolve(strict=True)
    moth = args.moth_to_a_flame.resolve(strict=True)
    model_root = args.model_root.resolve(strict=True)
    ffmpeg = args.ffmpeg.resolve(strict=True)
    ffprobe = args.ffprobe.resolve(strict=True)
    output_root = args.output_root.resolve() / "runs"
    results: list[dict[str, object]] = [
        (
            _measure_outputs(
                label="ceremony",
                input_path=ceremony,
                output_directory=args.reuse_ceremony.resolve(strict=True),
                ffmpeg=ffmpeg,
                elapsed_seconds=None,
            )
            if args.reuse_ceremony is not None
            else _verify_song(
                label="ceremony",
                input_path=ceremony,
                output_root=output_root,
                model_root=model_root,
                ffmpeg=ffmpeg,
                ffprobe=ffprobe,
            )
        ),
        _verify_song(
            label="moth-to-a-flame",
            input_path=moth,
            output_root=output_root,
            model_root=model_root,
            ffmpeg=ffmpeg,
            ffprobe=ffprobe,
        ),
    ]
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "pipelineVersion": "m6-demucs-v1",
        "model": {
            "modelId": "demucs-htdemucs",
            "version": "spectral-v1.0.0",
            "engine": "onnxruntime-cpu-spectral",
            "sha256": DEMUCS_SHA256,
        },
        "criteria": {
            "bothStemsRmsMinimum": 1e-4,
            "absoluteStemCorrelationMaximumExclusive": 0.995,
            "mixReconstructionResidualRatioMaximumExclusive": 0.25,
            "voicedFrameRatioInclusive": [0.02, 0.95],
        },
        "passed": all(bool(item["passed"]) for item in results),
        "songs": results,
    }
    report_path = output_root.parent / "verification-report.json"
    atomic_write_json(report_path, report)
    print(report_path)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
