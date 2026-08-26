from __future__ import annotations

import json
import sys
from pathlib import Path

from cybermuse_analyzer.subprocesses import CancellationState, run_process


class _ActiveControl(CancellationState):
    @property
    def cancelled(self) -> bool:
        return False

    @property
    def protocol_error(self) -> bool:
        return False


def test_tool_process_uses_only_staging_scoped_writable_directories(tmp_path: Path) -> None:
    state_directory = tmp_path / "process-state"
    keys = (
        "PROGRAMDATA",
        "ALLUSERSPROFILE",
        "USERPROFILE",
        "HOME",
        "LOCALAPPDATA",
        "APPDATA",
        "TEMP",
        "TMP",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "KERAS_HOME",
        "MPLCONFIGDIR",
        "PYTHONPYCACHEPREFIX",
        "TFHUB_CACHE_DIR",
    )
    script = (
        "import json, os, pathlib; "
        "pathlib.Path(os.environ['KERAS_HOME']).joinpath('keras.json').write_text('{}'); "
        f"print(json.dumps({{key: os.environ[key] for key in {keys!r}}}))"
    )

    result = run_process(
        Path(sys.executable),
        ["-c", script],
        state_directory=state_directory,
        cancel=_ActiveControl(),
        stage="test",
        timeout_seconds=10,
    )

    assert result.return_code == 0
    assert result.stderr == b""
    environment = json.loads(result.stdout)
    resolved_state = state_directory.resolve()
    for key in keys:
        assert Path(environment[key]).resolve().is_relative_to(resolved_state)
    assert (state_directory / "keras" / "keras.json").read_text() == "{}"


def test_tool_state_creation_failure_is_structured(tmp_path: Path) -> None:
    from cybermuse_analyzer.errors import AnalyzerFailure

    invalid_state = tmp_path / "state-file"
    invalid_state.write_text("not a directory")

    try:
        run_process(
            Path(sys.executable),
            ["-c", "print('unreachable')"],
            state_directory=invalid_state,
            cancel=_ActiveControl(),
            stage="separate",
            timeout_seconds=10,
        )
    except AnalyzerFailure as error:
        assert error.code == "ANALYZER_STAGE_FAILED"
        assert error.message_key == "analyzer.error.toolStateFailed"
        assert error.stage == "separate"
        assert error.safe_details == {"tool": Path(sys.executable).name}
    else:
        raise AssertionError("Expected a structured tool-state failure")
