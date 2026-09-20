"""Resolve declared dependency locations in Bazel actions and test runfiles."""

import json
import os
from pathlib import Path


def dependency(name):
    """Return a repository directory recorded from a Bazel File, without canonical-name guesses."""
    action_manifest = os.environ.get("SC_DEPENDENCY_PATHS")
    manifest = Path(action_manifest or "build/dependency_paths.json")
    if not manifest.exists():
        raise RuntimeError(
            "Dependency paths are declared by Bazel; run this tool through its Bazel target"
        )
    paths = json.loads(manifest.read_text())[name]
    path = Path(paths["exec" if action_manifest else "runfiles"])
    if path.is_dir():
        return path
    raise FileNotFoundError(f"Missing declared dependency: {name}")
