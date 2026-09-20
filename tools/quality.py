#!/usr/bin/env python3
"""Read-only C quality gates; --format is an explicit developer-only mutation."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess

from build_action import C_FLAGS
from source_policy import owned, sources as repository_sources


def sources():
    return [p for p in repository_sources() if p.suffix in (".c", ".h", ".inc", ".cpp", ".proto")]


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
    records = json.loads(Path(database).read_text())
    expected = {str(path) for path in repository_sources() if path.suffix in (".c", ".cpp")}
    missing = expected - {record["file"] for record in records}
    if missing:
        raise RuntimeError(
            "First-party translation units missing from Bazel analysis: "
            + ", ".join(sorted(missing))
        )
    failed = False
    for record in records:
        if not owned(record["file"]):
            continue
        print(f"Analyzing {record['file']} {record['copts']}", flush=True)
        profile = record.get("profile", "native")
        flags = C_FLAGS if profile == "native" else ["-Wall", "-Wextra", "-std=c99"]
        if profile == "wasm":
            sysroot = str(Path(record["sdk"]) / "emscripten/cache/sysroot")
            flags += [
                "--target=wasm32-unknown-emscripten",
                "--sysroot=" + sysroot,
                "-isystem",
                sysroot + "/include/compat",
            ]
            if record["file"].endswith(".cpp"):
                flags = [f for f in flags if f != "-std=c99"]
                flags += ["-std=c++17", "-nostdinc++", "-isystem", sysroot + "/include/c++/v1"]
        elif profile in ("arm", "rp2040"):
            flags += [
                "--target=arm-none-eabi",
                "-mcpu=cortex-m0plus" if profile == "rp2040" else "-mcpu=cortex-m4",
                "-mthumb",
                "-isystem",
                "/usr/include/newlib",
            ]
        command = [
            tidy,
            "--config-file=.clang-tidy",
            record["file"],
            "--",
            *flags,
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
        from repository_quality import format_all

        format_all(args.format)


if __name__ == "__main__":
    main()
