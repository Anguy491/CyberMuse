from pathlib import Path

import pytest

from cybermuse_spleeter_engine.cli import run


def test_rejects_raw_size_mismatch(tmp_path: Path) -> None:
    raw = tmp_path / "input.f32"
    raw.write_bytes(b"short")
    with pytest.raises(ValueError, match="size mismatch"):
        run(tmp_path / "config.json", raw, 100, tmp_path / "v.f32", tmp_path / "i.f32")
