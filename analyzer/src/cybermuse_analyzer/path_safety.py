from __future__ import annotations

import os
from pathlib import Path

from .contracts import AnalyzerRequest
from .errors import invalid_request


def _resolved_existing(path: Path, reason: str) -> Path:
    try:
        return path.resolve(strict=True)
    except OSError as error:
        raise invalid_request(reason) from error


def _resolved_directory(path: Path, reason: str) -> Path:
    resolved = _resolved_existing(path, reason)
    if not resolved.is_dir():
        raise invalid_request(reason)
    return resolved


def _within(path: Path, root: Path, reason: str) -> Path:
    resolved = _resolved_existing(path, reason)
    resolved_root = _resolved_directory(root, f"{reason}_root")
    try:
        resolved.relative_to(resolved_root)
    except ValueError as error:
        raise invalid_request(reason) from error
    return resolved


def _within_optional_file(path: Path, root: Path, reason: str) -> tuple[Path, Path]:
    resolved_root = _resolved_directory(root, f"{reason}_root")
    if not path.is_absolute() or not path.name or path.name in {".", ".."}:
        raise invalid_request(reason)
    try:
        resolved_parent = path.parent.resolve(strict=True)
        resolved_parent.relative_to(resolved_root)
    except (OSError, ValueError) as error:
        raise invalid_request(reason) from error
    return resolved_parent / path.name, resolved_parent


def _reject_links_between(path: Path, root: Path, reason: str) -> None:
    resolved_root = root.resolve(strict=True)
    current = resolved_root
    try:
        relative = path.resolve(strict=True).relative_to(resolved_root)
    except (OSError, ValueError) as error:
        raise invalid_request(reason) from error
    for part in relative.parts:
        current = current / part
        try:
            if current.is_symlink():
                raise invalid_request(reason)
            if os.name == "nt" and current.stat(follow_symlinks=False).st_file_attributes & 0x400:
                raise invalid_request(reason)
        except OSError as error:
            raise invalid_request(reason) from error


def validate_request_paths(request: AnalyzerRequest) -> None:
    input_path = _within(request.input_path, request.roots.song_root, "input_escape")
    staging_path = _within(request.staging_path, request.roots.staging_root, "staging_escape")
    _reject_links_between(input_path, request.roots.song_root, "input_link")
    _reject_links_between(staging_path, request.roots.staging_root, "staging_link")

    if staging_path.name != request.job_id:
        raise invalid_request("staging_job_mismatch")

    for model in request.models:
        model_path, existing_parent = _within_optional_file(
            model.path, request.roots.model_root, "model_escape"
        )
        _reject_links_between(existing_parent, request.roots.model_root, "model_link")
        if model_path.exists():
            _reject_links_between(model_path, request.roots.model_root, "model_link")

    for tool in request.tools:
        tool_path = _within(tool.path, request.roots.tool_root, "tool_escape")
        _reject_links_between(tool_path, request.roots.tool_root, "tool_link")
