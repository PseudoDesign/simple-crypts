#!/usr/bin/env python3
"""Install checksum-pinned local SDKs; Linux x86_64 / CPython 3.12 profile."""

import argparse
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".toolchains"


def download(row):
    path = CACHE / "downloads" / row["file"]
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        print("Downloading", row["file"], flush=True)
        temporary = path.with_suffix(path.suffix + ".partial")
        with (
            urllib.request.urlopen(row["url"], timeout=120) as response,
            temporary.open("wb") as out,
        ):
            shutil.copyfileobj(response, out)
        temporary.replace(path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != row["sha256"]:
        raise SystemExit("Checksum mismatch: " + str(path))
    return path


def repo_files(path):
    (path / "WORKSPACE").write_text("")
    (path / "BUILD.bazel").write_text("""package(default_visibility=["//visibility:public"])
filegroup(name="files", srcs=glob(["**"], exclude=["BUILD.bazel", "WORKSPACE"]))
exports_files(glob(["bin/*", "cffi/__init__.py"], allow_empty=True))
""")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Verify cached archives and prerequisites without installation",
    )
    options = parser.parse_args()
    if (
        platform.system() != "Linux"
        or platform.machine() not in ("x86_64", "AMD64")
        or sys.version_info[:2] != (3, 12)
    ):
        raise SystemExit("This pinned sample build profile requires Linux x86_64 and Python 3.12.")
    for name in (
        "cc",
        "ar",
        "make",
        "bazel",
        "arm-none-eabi-gcc",
        "arm-none-eabi-ar",
        "arm-none-eabi-size",
        "node",
    ):
        if not shutil.which(name):
            raise SystemExit("Missing system prerequisite: " + name)
    rows = json.loads((ROOT / "tools/downloads.lock.json").read_text())
    for row in rows:
        name = row["file"]
        if options.verify_only and not (CACHE / "downloads" / name).is_file():
            raise SystemExit("Missing cached archive: " + name)
        archive = download(row)
        if options.verify_only:
            continue
        if name.startswith("emscripten-"):
            with tarfile.open(archive) as tar:
                with tempfile.TemporaryDirectory(dir=CACHE) as temporary:
                    tar.extractall(temporary, filter="data")
                    shutil.copytree(
                        Path(temporary) / "install", CACHE / "emscripten", dirs_exist_ok=True
                    )
        elif name.startswith("ruff-"):
            with tarfile.open(archive) as tar:
                tar.extractall(CACHE / "quality", filter="data")
        elif name == "buildifier-linux-amd64":
            target = CACHE / "quality" / "buildifier"
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(archive, target)
            target.chmod(0o755)
        elif name.startswith("go"):
            with tarfile.open(archive) as tar:
                tar.extractall(CACHE, filter="data")
        elif name.startswith(("rustc-", "rust-std-", "cargo-", "rustfmt-", "clippy-")):
            with tempfile.TemporaryDirectory(dir=CACHE) as temporary:
                with tarfile.open(archive) as tar:
                    tar.extractall(temporary, filter="data")
                component = next(Path(temporary).iterdir())
                subprocess.run(
                    [
                        str(component / "install.sh"),
                        "--prefix=" + str(CACHE / "rust"),
                        "--disable-ldconfig",
                    ],
                    check=True,
                    stdout=subprocess.DEVNULL,
                )
        elif name.startswith("protoc-"):
            with zipfile.ZipFile(archive) as wheel:
                wheel.extractall(CACHE / "protobuf")
            (CACHE / "protobuf/bin/protoc").chmod(0o755)
        elif name.endswith(".whl"):
            with zipfile.ZipFile(archive) as wheel:
                wheel.extractall(CACHE / "python")
    if not options.verify_only:
        for name in ("go", "rust", "python", "protobuf", "emscripten", "quality"):
            repo_files(CACHE / name)
    print(
        "Pinned SDKs verified"
        if options.verify_only
        else "Pinned SDKs installed. Run bazel test //... (first Bazel module fetch requires network)."
    )


if __name__ == "__main__":
    main()
