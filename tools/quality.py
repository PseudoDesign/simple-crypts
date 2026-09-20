#!/usr/bin/env python3
"""Read-only C quality gates; --format is an explicit developer-only mutation."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from build_action import C_FLAGS

ROOTS = ("core", "modules/credits", "providers/host", "providers/sodium")


def sources():
    return sorted(
        p for root in ROOTS for p in Path(root).iterdir() if p.suffix in (".c", ".h", ".inc")
    )


def tool(name, version):
    executable = (
        str(Path(os.environ["SC_QUALITY_BIN"]) / name) if os.environ.get("SC_QUALITY_BIN") else name
    )
    result = subprocess.run([executable, "--version"], check=True, text=True, capture_output=True)
    if not re.search(r"(?<![\d.])" + re.escape(version) + r"(?![\d.])", result.stdout):
        raise RuntimeError(f"{name} must be version {version}: {result.stdout.strip()}")
    return executable


def format_check(write=False):
    formatter = tool("clang-format-18", "18.1.3")
    subprocess.run(
        [formatter, *(["-i"] if write else ["--dry-run", "--Werror"]), *map(str, sources())],
        check=True,
    )


def lint(database):
    tidy = tool("clang-tidy-18", "18.1.3")
    failed = False
    for record in json.loads(Path(database).read_text()):
        if not any(record["file"].startswith(root + "/") for root in ROOTS):
            continue
        print(f"Analyzing {record['file']} {record['copts']}", flush=True)
        command = [
            tidy,
            "--config-file=.clang-tidy",
            record["file"],
            "--",
            *C_FLAGS,
            *record["copts"],
            *["-I" + p for p in record["includes"]],
        ]
        failed |= subprocess.run(command).returncode != 0
    if failed:
        raise RuntimeError("C static analysis failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--format", action="store_true")
    group.add_argument("--format-check", action="store_true")
    group.add_argument("--lint", metavar="DATABASE")
    args = parser.parse_args()
    if args.lint:
        lint(args.lint)
    else:
        # Bazel runs in its read-only runfiles tree. Only direct invocation may edit.
        if args.format and os.environ.get("RUNFILES_DIR"):
            parser.error("Run python3 tools/quality.py --format from the source checkout")
        format_check(args.format)


if __name__ == "__main__":
    main()
