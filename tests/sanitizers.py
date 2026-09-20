#!/usr/bin/env python3
"""Instrument the C implementation, then run state, fuzz, and C/C scenarios.

All project sources and the pinned libsodium archive are declared runfiles.
GCC and its sanitizer runtimes are explicit system prerequisites. Upstream
libsodium remains uninstrumented; these tests do not claim sanitizer coverage
inside that archive. No failed process is retried or treated as a pass.
"""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile

from dependency_paths import dependency


def run(arguments: list[str], *, env: dict[str, str]) -> None:
    subprocess.run(arguments, check=True, env=env)


def main() -> None:
    # The repository's Bazel Python launcher enters the _main runfiles tree.
    # Avoid resolving source symlinks back into an undeclared workspace tree.
    root = Path.cwd()
    archive = root / "third_party/libsodium/libsodium.a"
    if not archive.is_file():
        raise FileNotFoundError(f"declared libsodium archive not found: {archive}")
    env = dict(os.environ)
    env["ASAN_OPTIONS"] = "detect_leaks=0"
    env["UBSAN_OPTIONS"] = "halt_on_error=1:print_stacktrace=1"
    compiler = "/usr/bin/gcc"
    flags = [
        "-std=c99",
        "-O1",
        "-g",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-fno-omit-frame-pointer",
        "-fsanitize=address,undefined",
        "-fno-sanitize-recover=all",
        "-fno-pie",
        "-DSC_ENABLE_TESTING",
        "-I" + str(root),
        "-I" + str(dependency("nanopb")),
        "-I" + str(dependency("sodium_headers")),
    ]
    core_sources = [
        "core/sc.c",
        "schema/sc.pb.c",
        str(dependency("nanopb") / "pb_common.c"),
        str(dependency("nanopb") / "pb_encode.c"),
        str(dependency("nanopb") / "pb_decode.c"),
    ]
    adapter_sources = [
        "providers/sodium/sc_sodium.c",
        "providers/host/sc_host.c",
        "adapters/c/main.c",
    ]
    with tempfile.TemporaryDirectory(
        prefix="sc-sanitizers-", dir=env.get("TEST_TMPDIR")
    ) as directory:
        output = Path(directory)

        def compile_source(source: str, extra: list[str] | None = None) -> Path:
            obj = output / (source.replace("/", "_") + ".o")
            run(
                [compiler, *flags, *(extra or []), "-c", str(root / source), "-o", str(obj)],
                env=env,
            )
            return obj

        def link(name: str, objects: list[Path], libraries: list[Path] | None = None) -> Path:
            binary = output / name
            run(
                [
                    compiler,
                    "-no-pie",
                    "-fsanitize=address,undefined",
                    "-fno-sanitize-recover=all",
                    "-o",
                    str(binary),
                    *map(str, objects),
                    *map(str, libraries or []),
                ],
                env=env,
            )
            return binary

        common = [compile_source(source) for source in core_sources]
        core_test = link("core-test", common + [compile_source("tests/core_test.c")])
        core_fuzz = link(
            "core-fuzz", common + [compile_source("tests/core_fuzz.c", ["-DSC_FUZZ_STANDALONE"])]
        )
        adapter = link(
            "adapter", common + [compile_source(source) for source in adapter_sources], [archive]
        )
        print("ASan/UBSan: core contracts and parser fuzz", flush=True)
        run([str(core_test)], env=env)
        run([str(core_fuzz)], env=env)
        print("ASan/UBSan: complete C/C conformance scenarios", flush=True)
        run(
            [
                "/usr/bin/python3",
                str(root / "tests/conformance.py"),
                "--device",
                str(adapter),
                "--server",
                str(adapter),
            ],
            env=env,
        )
    print("Sanitizer checks passed; libsodium archive was not instrumented.", flush=True)


if __name__ == "__main__":
    main()
