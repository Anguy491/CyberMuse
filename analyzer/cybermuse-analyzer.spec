# -*- mode: python ; coding: utf-8 -*-

import os
from pathlib import Path


source_root = Path(SPECPATH)

a = Analysis(
    [str(source_root / "entrypoint.py")],
    pathex=[str(source_root / "src")],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "mypy", "ruff"],
    noarchive=False,
    optimize=0,
)
# The uv-managed CPython runtime currently ships VC 14.29 app-local DLLs, while
# ONNX Runtime 1.29 requires the newer Microsoft VC 2015-2022 runtime. Remove
# those stale copies and package the current retail runtime app-locally so the
# analyzer also starts on a clean supported Windows 11 installation.
vc_runtime_names = {
    "msvcp140.dll",
    "msvcp140_1.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
}
a.binaries = [
    item for item in a.binaries if Path(item[0]).name.lower() not in vc_runtime_names
]
system32 = Path(os.environ["WINDIR"]) / "System32"
for runtime_name in sorted(vc_runtime_names):
    runtime_path = system32 / runtime_name
    if not runtime_path.is_file():
        raise FileNotFoundError(f"Required Microsoft VC runtime is missing: {runtime_path}")
    a.binaries.append((runtime_name, str(runtime_path), "BINARY"))
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="cybermuse-analyzer",
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
    name="cybermuse-analyzer",
)
