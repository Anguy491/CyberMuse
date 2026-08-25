from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, NoReturn

from .errors import invalid_request

MAX_REQUEST_BYTES = 1024 * 1024
MAX_NDJSON_LINE_BYTES = 64 * 1024
MAX_JSON_DEPTH = 16


def _reject_constant(value: str) -> NoReturn:
    raise ValueError(f"non-finite number: {value}")


def json_depth(value: object) -> int:
    if isinstance(value, Mapping):
        return 1 + max((json_depth(item) for item in value.values()), default=0)
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return 1 + max((json_depth(item) for item in value), default=0)
    return 0


def loads_strict(data: str | bytes, *, max_depth: int = MAX_JSON_DEPTH) -> Any:
    value = json.loads(data, parse_constant=_reject_constant)
    if json_depth(value) > max_depth:
        raise ValueError("JSON exceeds maximum depth")
    return value


def load_request_json(path: Path) -> object:
    try:
        size = path.stat().st_size
    except OSError as error:
        raise invalid_request("request_unreadable") from error
    if size <= 0 or size > MAX_REQUEST_BYTES:
        raise invalid_request("request_size")
    try:
        return loads_strict(path.read_bytes())
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
        raise invalid_request("request_json") from error
