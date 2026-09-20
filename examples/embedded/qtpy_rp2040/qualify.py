"""Build in two clean Bazel output bases and compare firmware; used by five-host CI."""

import argparse
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import urllib.request

TARGET = "//examples/embedded/qtpy_rp2040:firmware"
CONFIG = ["--config=qtpy", "--lockfile_mode=error"]


def bazel_binary(destination):
    """Install a release executable checked against committed upstream SHA-256 pins."""
    system = {"Linux": "linux", "Darwin": "darwin", "Windows": "windows"}[platform.system()]
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x86_64"
    name = f"{system}-{arch}" + (".exe" if system == "windows" else "")
    pin = json.loads(Path(__file__).with_name("bazel-pins.json").read_text())[name]
    path = destination / ("bazel.exe" if system == "windows" else "bazel")
    with urllib.request.urlopen(pin["url"], timeout=120) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != pin["sha256"]:
        raise RuntimeError("Bazel download checksum mismatch")
    path.write_bytes(data)
    path.chmod(0o755)
    return str(path)


def validate_actions(graph):
    """Reject native compiler fallbacks and changes to the audited crypto profile."""
    actions = graph["actions"]
    compiles = [a for a in actions if a["mnemonic"] == "CppCompile"]
    links = [a for a in actions if a["mnemonic"] == "CppLink"]
    if not compiles or not links:
        raise RuntimeError("missing firmware compilation/link actions")
    for action in compiles + links:
        arguments = action["arguments"]
        if "arm-none-eabi-" not in arguments[0] or "-mcpu=cortex-m0plus" not in arguments:
            raise RuntimeError("unexpected compiler or CPU in firmware closure")
        if any(
            "SC_ENABLE_TESTING" in arg or "ED25519_NONDETERMINISTIC" in arg for arg in arguments
        ):
            raise RuntimeError("test hooks or nondeterministic signing enabled")
        if action["mnemonic"] == "CppCompile":
            if "-fno-lto" not in arguments or "-Os" not in arguments:
                raise RuntimeError("unexpected firmware compile profile")
    forbidden = (
        "picotool",
        "pioasm",
        "libusb",
        "randombytes_sysrandom.c",
        "randombytes_internal_random.c",
    )
    for action in actions:
        arguments = action.get("arguments", [])
        if any(word in arg for word in forbidden for arg in arguments):
            raise RuntimeError("unexpected host tool or RNG backend in firmware actions")


def main():
    """Download once, rebuild with downloads disabled, and retain reproducible evidence."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--bazel", help="Use an already installed Bazel 9.2.0")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    bazel = shutil.which(args.bazel) if args.bazel else bazel_binary(output)
    if not bazel:
        parser.error("Bazel executable not found")
    repository = Path(__file__).resolve().parents[3]
    artifacts = output / "artifacts"
    artifacts.mkdir()
    fingerprints = []
    for name in ("first", "second"):
        base = output / name
        if base.exists():
            parser.error("qualification requires fresh output bases")
        command = [bazel, "--batch", f"--output_base={base}"]
        cache = [f"--repository_cache={output / 'repository-cache'}"]
        subprocess.run(command + ["fetch", *CONFIG, *cache, TARGET], cwd=repository, check=True)
        subprocess.run(
            command + ["build", *CONFIG, *cache, "--repository_disable_download", TARGET],
            cwd=repository,
            check=True,
        )
        execution_root = Path(
            subprocess.check_output(
                command + ["info", "execution_root"], cwd=repository, text=True
            ).strip()
        )
        generated = subprocess.check_output(
            command + ["cquery", *CONFIG, "--output=files", TARGET], cwd=repository, text=True
        ).splitlines()
        source = (
            execution_root
            / Path(next(path for path in generated if path.endswith("/demo.uf2"))).parent
        )
        hashes = {}
        for file in ("demo.elf", "demo.bin", "demo.uf2", "image-report.json", "symbol-map.txt"):
            data = (source / file).read_bytes()
            hashes[file] = hashlib.sha256(data).hexdigest()
            if name == "first":
                (artifacts / file).write_bytes(data)
        fingerprints.append(hashes)
        if name == "first":
            query = subprocess.check_output(
                command + ["aquery", *CONFIG, "--output=jsonproto", f"deps({TARGET})"],
                cwd=repository,
            )
            validate_actions(json.loads(query))
            (artifacts / "actions.json").write_bytes(query)
    if fingerprints[0] != fingerprints[1]:
        raise RuntimeError(f"Builds differ: {fingerprints}")
    (artifacts / "qualification.json").write_text(
        json.dumps(
            {
                "host": platform.platform(),
                "matching_builds": 2,
                "downloads_disabled_during_build": True,
                "sha256": fingerprints[0],
            },
            indent=2,
        )
        + "\n"
    )
    print(json.dumps(fingerprints[0], indent=2))


if __name__ == "__main__":
    main()
