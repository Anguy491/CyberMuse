from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cybermuse-spleeter-engine")
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--input-raw", required=True, type=Path)
    parser.add_argument("--samples", required=True, type=int)
    parser.add_argument("--vocals-raw", required=True, type=Path)
    parser.add_argument("--instrumental-raw", required=True, type=Path)
    return parser


def _disable_model_downloads() -> None:
    from spleeter.model.provider import ModelProvider

    class OfflineModelProvider(ModelProvider):
        def download(self, name: str, path: str) -> None:
            del self, name, path
            raise RuntimeError("CyberMuse disables Spleeter network downloads")

    def offline_default(cls: type[ModelProvider]) -> ModelProvider:
        del cls
        return OfflineModelProvider()

    ModelProvider.default = classmethod(offline_default)  # type: ignore[method-assign]


def run(
    config: Path,
    input_raw: Path,
    samples: int,
    vocals_raw: Path,
    instrumental_raw: Path,
) -> None:
    if samples <= 0 or input_raw.stat().st_size != samples * 2 * 4:
        raise ValueError("raw input size mismatch")
    import numpy as np
    from spleeter.separator import Separator

    _disable_model_downloads()
    waveform = np.memmap(input_raw, dtype="<f4", mode="r", shape=(samples, 2))
    separator = Separator(str(config), MWF=False, multiprocess=False)
    sources = separator.separate(np.asarray(waveform, dtype=np.float32), "cybermuse-local")
    if set(sources) != {"vocals", "accompaniment"}:
        raise ValueError("unexpected Spleeter outputs")
    for name, path in (("vocals", vocals_raw), ("accompaniment", instrumental_raw)):
        value = np.asarray(sources[name], dtype="<f4")
        if value.shape != (samples, 2) or not np.isfinite(value).all():
            raise ValueError("invalid Spleeter output")
        value.tofile(path)


def main(arguments: list[str] | None = None) -> int:
    args = _parser().parse_args(arguments)
    try:
        run(args.config, args.input_raw, args.samples, args.vocals_raw, args.instrumental_raw)
    except Exception as error:
        print(f"spleeter engine failed: {type(error).__name__}", file=sys.stderr)
        return 10
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
