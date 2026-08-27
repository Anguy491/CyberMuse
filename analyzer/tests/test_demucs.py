from __future__ import annotations

import numpy as np
import pytest

from cybermuse_analyzer.demucs import (
    CONTRACT_FREQS,
    DEMUCS_SEGMENT_FRAMES,
    SPECTRAL_CONTRACT,
    SPECTRAL_FRAMES,
    _validate_interface,
    demucs_ispec,
    demucs_spec,
)


def _contract_inputs() -> list[tuple[str, list[int]]]:
    return [
        ("spectral", [1, 2, 2, CONTRACT_FREQS, SPECTRAL_FRAMES]),
        ("mix", [1, 2, DEMUCS_SEGMENT_FRAMES]),
    ]


def _contract_outputs() -> list[tuple[str, list[int]]]:
    return [
        ("spectral_out", [1, 4, 2, 2, CONTRACT_FREQS, SPECTRAL_FRAMES]),
        ("time_out", [1, 4, 2, DEMUCS_SEGMENT_FRAMES]),
    ]


def test_spectral_contract_round_trip_is_exact_away_from_window_edges() -> None:
    time = np.arange(DEMUCS_SEGMENT_FRAMES, dtype=np.float64) / 44_100.0
    mix = np.stack(
        (
            0.2 * np.sin(2.0 * np.pi * 220.0 * time),
            0.15 * np.sin(2.0 * np.pi * 440.0 * time),
        )
    ).astype(np.float32)

    spectral = demucs_spec(mix)
    reconstructed = demucs_ispec(spectral, DEMUCS_SEGMENT_FRAMES)

    assert spectral.shape == (2, 2, CONTRACT_FREQS, SPECTRAL_FRAMES)
    interior_error = reconstructed[:, 4096:-4096] - mix[:, 4096:-4096]
    assert float(np.max(np.abs(interior_error))) < 1e-6


def test_spectral_interface_requires_exact_names_shapes_and_metadata() -> None:
    metadata = {
        "openkara.spectral_contract": SPECTRAL_CONTRACT,
        "openkara.tensor_interface": "spectral-core",
    }
    _validate_interface(_contract_inputs(), _contract_outputs(), metadata)

    invalid_inputs = _contract_inputs()
    invalid_inputs[1] = ("audio", invalid_inputs[1][1])
    with pytest.raises(ValueError, match="tensor interface"):
        _validate_interface(invalid_inputs, _contract_outputs(), metadata)

    with pytest.raises(ValueError, match="metadata"):
        _validate_interface(_contract_inputs(), _contract_outputs(), {})
