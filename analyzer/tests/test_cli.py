from __future__ import annotations

import json

import pytest

from cybermuse_analyzer.cli import main


def test_json_version(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--version", "--json"]) == 0
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {
        "schemaVersion": 1,
        "name": "cybermuse-analyzer",
        "version": "0.1.0",
        "protocolMajor": 1,
    }
