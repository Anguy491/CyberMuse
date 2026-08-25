from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

from .backend import OfflineBackend
from .contracts import parse_request
from .errors import AnalyzerFailure
from .json_limits import load_request_json
from .path_safety import validate_request_paths
from .pipeline import AnalysisCancelled, run_pipeline
from .protocol import CancellationMonitor, ProtocolStateError, ProtocolWriter
from .version import ANALYZER_VERSION, PROTOCOL_MAJOR, SCHEMA_VERSION


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cybermuse-analyzer")
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--json", action="store_true")
    subparsers = parser.add_subparsers(dest="command")
    analyze = subparsers.add_parser("analyze")
    analyze.add_argument("--request", required=True, type=Path)
    return parser


def _version(json_output: bool) -> int:
    if json_output:
        print(
            json.dumps(
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "name": "cybermuse-analyzer",
                    "version": ANALYZER_VERSION,
                    "protocolMajor": PROTOCOL_MAJOR,
                },
                separators=(",", ":"),
            )
        )
    else:
        print(ANALYZER_VERSION)
    return 0


def _fallback_job_id(path: Path) -> str:
    try:
        value = load_request_json(path)
        if isinstance(value, dict):
            job_id = value.get("jobId")
            if isinstance(job_id, str):
                return job_id
    except AnalyzerFailure:
        pass
    return "00000000-0000-4000-8000-000000000000"


def _analyze(request_path: Path) -> int:
    writer: ProtocolWriter | None = None
    try:
        value = load_request_json(request_path)
        request = parse_request(value)
        writer = ProtocolWriter(request.job_id)
        protocol_writer = writer
        protocol_writer.hello()
        validate_request_paths(request)
        cancel = CancellationMonitor(request.job_id)
        cancel.start()
        run_pipeline(
            request,
            OfflineBackend(),
            cancel,
            lambda stage, stage_progress, progress: protocol_writer.event(
                "progress",
                stage=stage,
                stageProgress=stage_progress,
                progress=progress,
            ),
        )
        protocol_writer.completed()
        return 0
    except AnalysisCancelled:
        if writer is not None:
            writer.cancelled()
        return 6
    except AnalyzerFailure as error:
        if writer is None:
            writer = ProtocolWriter(_fallback_job_id(request_path))
            writer.hello()
        writer.failed(error.as_payload())
        return error.exit_code
    except ProtocolStateError:
        print("analyzer protocol state failure", file=sys.stderr)
        return 10
    except Exception:
        diagnostic = AnalyzerFailure(
            code="ANALYZER_INTERNAL",
            message_key="analyzer.error.internal",
            stage=None,
            retryable=True,
        )
        print(
            f"{diagnostic.diagnostic_id}: {traceback.format_exc(limit=20)}",
            file=sys.stderr,
        )
        if writer is None:
            writer = ProtocolWriter(_fallback_job_id(request_path))
            writer.hello()
        writer.failed(diagnostic.as_payload())
        return 10


def main(arguments: list[str] | None = None) -> int:
    args = _parser().parse_args(arguments)
    if args.version:
        return _version(args.json)
    if args.command == "analyze":
        return _analyze(args.request)
    _parser().print_usage(sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
