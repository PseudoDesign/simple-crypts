#!/usr/bin/env python3
"""Regenerate in a temporary directory and compare committed bounded codec."""

import argparse
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile

from dependency_paths import dependency

root = Path.cwd()
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--write", action="store_true", help="Update the checkout's generated codec")
args = parser.parse_args()
protoc = dependency("protoc") / "protoc"
env = dict(os.environ, PATH=str(protoc.parent) + ":/usr/bin:/bin")
with tempfile.TemporaryDirectory() as temporary:
    env["NANOPB_PB2_TEMP_DIR"] = temporary
    subprocess.run(
        [
            sys.executable,
            str(dependency("nanopb") / "generator/nanopb_generator.py"),
            "-I",
            "schema",
            "-D",
            temporary,
            "schema/sc.proto",
        ],
        env=env,
        check=True,
    )
    for name in ("sc.pb.c", "sc.pb.h"):
        if args.write:
            destination = Path(os.environ["BUILD_WORKSPACE_DIRECTORY"]) / "schema" / name
            shutil.copyfile(Path(temporary) / name, destination)
            continue
        assert (Path(temporary) / name).read_bytes() == (root / "schema" / name).read_bytes(), (
            "Stale generated schema: " + name
        )
print(
    "Generated C codec updated."
    if args.write
    else "Pinned protoc/nanopb regeneration matches committed C codec."
)
