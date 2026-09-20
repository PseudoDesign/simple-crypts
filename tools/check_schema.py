#!/usr/bin/env python3
"""Regenerate in a temporary directory and compare committed bounded codec."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path.cwd()
protoc = root.parent / "+local_repository+protobuf_sdk/bin/protoc"
if not protoc.exists():
    protoc = root / ".toolchains/protobuf/bin/protoc"
env = dict(os.environ, PATH=str(protoc.parent) + ":/usr/bin:/bin")
with tempfile.TemporaryDirectory() as temporary:
    subprocess.run(
        [
            sys.executable,
            "third_party/nanopb/generator/nanopb_generator.py",
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
        assert (Path(temporary) / name).read_bytes() == (root / "schema" / name).read_bytes(), (
            "Stale generated schema: " + name
        )
print("Pinned protoc/nanopb regeneration matches committed C codec.")
