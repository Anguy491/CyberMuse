# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path


source_root = Path(SPECPATH)

a = Analysis(
    [str(source_root / "src" / "cybermuse_spleeter_engine" / "cli.py")],
    pathex=[str(source_root / "src")],
    binaries=[],
    datas=[],
    hiddenimports=["spleeter.model.functions.unet"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "spleeter.__main__",
        "jax",
        "jaxlib",
        "scipy",
        "pytest",
        "py",
        "norbert",
        "httpx",
        "cryptography",
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="cybermuse-spleeter-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="cybermuse-spleeter-engine",
)
