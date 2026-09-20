#!/usr/bin/env python3
"""Bazel action driver for the pinned Emscripten source build (no network)."""

import json, os, shutil, subprocess, sys, tempfile
from pathlib import Path


def main(c):
    out = Path(c["output"]).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    sdk = Path(c["sdk"]).resolve()
    em = sdk / "emscripten"
    with tempfile.TemporaryDirectory(dir=out.parent, prefix="wasm-") as tmp:
        root = Path(tmp)
        cfg = root / "emscripten_config"
        cfg.write_text(
            f"LLVM_ROOT={str(sdk / 'bin')!r}\nBINARYEN_ROOT={str(sdk)!r}\nNODE_JS='/usr/bin/node'\nCACHE={str(em / 'cache')!r}\nFROZEN_CACHE=True\n"
        )
        env = dict(os.environ, EM_CONFIG=str(cfg), PATH=str(em) + ":/usr/bin:/bin")
        log = root / "build.log"
        try:
            with log.open("w") as stream:
                if c["kind"] == "sodium":
                    source = root / "sodium"
                    shutil.copytree("third_party/libsodium", source)
                    env.update(
                        CC=str(em / "emcc"),
                        AR=str(em / "emar"),
                        RANLIB=str(em / "emranlib"),
                        CFLAGS="-Oz",
                        LDFLAGS="-sWASM_BIGINT=1",
                    )
                    subprocess.run(
                        [
                            str(source / "configure"),
                            "--host=wasm32-unknown-emscripten",
                            "--disable-shared",
                            "--enable-static",
                            "--disable-asm",
                            "--disable-pie",
                            "--disable-ssp",
                            "--without-pthreads",
                            "--enable-minimal",
                        ],
                        cwd=source,
                        env=env,
                        stdout=stream,
                        stderr=subprocess.STDOUT,
                        check=True,
                    )
                    subprocess.run(
                        ["make", "-j4", "-C", "src/libsodium"],
                        cwd=source,
                        env=env,
                        stdout=stream,
                        stderr=subprocess.STDOUT,
                        check=True,
                    )
                    shutil.copyfile(source / "src/libsodium/.libs/libsodium.a", out)
                else:
                    # Compile each language with its own driver; never reinterpret
                    # the C protocol/provider sources as C++.
                    objects = []
                    cpp = any(source.endswith(".cpp") for source in c["sources"])
                    for index, source in enumerate(c["sources"]):
                        is_cpp = source.endswith(".cpp")
                        obj = root / f"{index}.o"
                        argv = [
                            str(em / ("em++" if is_cpp else "emcc")),
                            "-std=c++17" if is_cpp else "-std=c99",
                            "-Oz",
                            "-Wall",
                            "-Wextra",
                            "-Werror",
                            "-I.",
                            "-Ithird_party/nanopb",
                            "-Ithird_party/libsodium/src/libsodium/include",
                            *(["-DSC_ENABLE_TESTING"] if c.get("testing") else []),
                            "-c",
                            source,
                            "-o",
                            str(obj),
                        ]
                        subprocess.run(
                            argv, env=env, stdout=stream, stderr=subprocess.STDOUT, check=True
                        )
                        objects.append(str(obj))
                    persistent = c.get("persistent", False)
                    argv = [
                        str(em / ("em++" if cpp else "emcc")),
                        "-Oz",
                        "-sMODULARIZE=1",
                        "-sEXPORT_ES6=1",
                        "-sENVIRONMENT=web,worker,node",
                        "-sWASM_BIGINT=1",
                        "-sFILESYSTEM=0",
                        "-sALLOW_MEMORY_GROWTH=0",
                        "-sINITIAL_MEMORY=" + ("16777216" if persistent else "4194304"),
                        "-sSTACK_SIZE=131072",
                        "-sEXPORTED_RUNTIME_METHODS="
                        + json.dumps(
                            ["UTF8ToString", "HEAPU8"] + (["ccall"] if persistent else [])
                        ),
                        *(["-sASYNCIFY=1", "-sASYNCIFY_STACK_SIZE=65536"] if persistent else []),
                        *objects,
                        c["sodium"],
                        "-o",
                        str(out),
                    ]
                    subprocess.run(
                        argv, env=env, stdout=stream, stderr=subprocess.STDOUT, check=True
                    )
        except subprocess.CalledProcessError:
            print(log.read_text()[-20000:], file=sys.stderr)
            # Autoconf's summary omits the compiler/linker error. Retain that
            # diagnostic before TemporaryDirectory removes the failed build.
            configure_log = root / "sodium/config.log"
            if configure_log.exists():
                print(configure_log.read_text()[-30000:], file=sys.stderr)
            raise


if __name__ == "__main__":
    main(json.loads(sys.argv[1]))
