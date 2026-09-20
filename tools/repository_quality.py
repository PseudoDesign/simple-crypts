#!/usr/bin/env python3
"""Language-specific formatting and lint gates over all maintained source."""

import argparse
from pathlib import Path
import subprocess
import os
import tempfile
import tomllib

from source_policy import sources
from quality import format_check


def sdk(name):
    """Locate a pinned SDK in a checkout or in Bazel's declared runfiles."""
    candidates = [
        Path(".toolchains") / name,
        Path("external/+local_repository+" + name + "_sdk"),
        Path("../+local_repository+" + name + "_sdk"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise RuntimeError(f"Missing {name} SDK; run python3 tools/bootstrap.py")


def run(args):
    """Run a read-only gate and propagate its nonzero exit status."""
    subprocess.run(list(map(str, args)), check=True)


def selected(*suffixes):
    return [p for p in sources() if p.suffix in suffixes]


def format_all(write=False):
    """Apply or check each language's native formatting without touching vendor output."""
    if write and os.environ.get("RUNFILES_DIR"):
        raise RuntimeError("Run the developer formatter from the source checkout")
    format_check(write)
    run(
        [
            sdk("quality") / "ruff-x86_64-unknown-linux-gnu/ruff",
            "format",
            *([] if write else ["--check"]),
            *selected(".py"),
        ]
    )
    browser_sources = selected(".mjs", ".css", ".html", ".json", ".yml", ".yaml")
    if write:
        run(["web/node_modules/.bin/prettier", "--write", *browser_sources])
    else:
        run(["/usr/bin/node", "tools/check_prettier.mjs", *browser_sources])
    if write:
        run([sdk("go") / "bin/gofmt", "-w", *selected(".go")])
    else:
        result = subprocess.check_output(
            [str(sdk("go") / "bin/gofmt"), "-l", *map(str, selected(".go"))], text=True
        )
        if result.strip():
            raise RuntimeError("Go files need gofmt:\n" + result)
    run(
        [
            sdk("rust") / "bin/rustfmt",
            "--config",
            "skip_children=true",
            *([] if write else ["--check"]),
            *selected(".rs"),
        ]
    )
    run(
        [
            sdk("quality") / "buildifier",
            "-mode=fix" if write else "-mode=check",
            *selected(".bzl", ".bazel"),
        ]
    )


def lint_scripts():
    """Check Python, JavaScript, CSS, HTML and Bazel source without applying fixes."""
    run([sdk("quality") / "ruff-x86_64-unknown-linux-gnu/ruff", "check", *selected(".py")])
    run(
        [
            sdk("quality") / "ruff-x86_64-unknown-linux-gnu/ruff",
            "check",
            "--select",
            "D100,D101,D102,D103,D107",
            "bindings/python/simplecrypts.py",
        ]
    )
    run(["web/node_modules/.bin/eslint", "--config", "web/eslint.config.mjs", *selected(".mjs")])
    run(
        [
            "web/node_modules/.bin/stylelint",
            "--config",
            "web/stylelint.config.mjs",
            *selected(".css"),
        ]
    )
    run(["web/node_modules/.bin/html-validate", *selected(".html")])
    run([sdk("quality") / "buildifier", "-mode=check", "-lint=warn", *selected(".bzl", ".bazel")])
    for path in selected(".toml"):
        tomllib.loads(path.read_text())
    with tempfile.TemporaryDirectory(prefix="sc-vet-") as cache:
        env = dict(
            os.environ,
            GOROOT=str(sdk("go").resolve()),
            GOTOOLCHAIN="local",
            GOCACHE=cache,
            GOPROXY="off",
            GOSUMDB="off",
        )
        subprocess.run([str(sdk("go") / "bin/go"), "vet", "docs/go_docs.go"], env=env, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["format", "format-check", "lint"])
    args = parser.parse_args()
    if args.mode == "lint":
        lint_scripts()
    else:
        format_all(args.mode == "format")


if __name__ == "__main__":
    main()
