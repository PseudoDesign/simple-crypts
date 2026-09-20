#!/usr/bin/env python3
"""Update/check the Bazel source-download lock against Cargo.lock and Go checksums."""

import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import tomllib
import urllib.request
import zipfile


def go_hash(files):
    """Compute Go's dirhash.Hash1 for a module zip or go.mod."""
    lines = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in sorted(files))
    return "h1:" + base64.b64encode(hashlib.sha256(lines.encode()).digest()).decode()


def packages(root):
    crates = []
    for package in tomllib.loads((root / "bindings/rust/Cargo.lock").read_text())["package"]:
        if "source" not in package:
            continue
        if package["source"] != "registry+https://github.com/rust-lang/crates.io-index":
            raise ValueError("Only crates.io packages are supported by this source bridge")
        crates.append({key: package[key] for key in ("name", "version", "checksum")})
    modules = {}
    for line in (root / "tests/crypto/go.sum").read_text().splitlines():
        name, version, checksum = line.split()
        key = (name, version.removesuffix("/go.mod"))
        modules.setdefault(key, {})["mod" if version.endswith("/go.mod") else "zip"] = checksum
    return crates, modules


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    root = Path.cwd()
    path = root / "build/dependencies.lock.json"
    crates, modules = packages(root)
    if args.check:
        lock = json.loads(path.read_text())
        assert lock["crates"] == crates, (
            "Cargo.lock changed; run python3 tools/lock_dependencies.py"
        )
        actual = {(m["name"], m["version"]): m["go_sum"] for m in lock["go_modules"]}
        assert actual == modules, "go.sum changed; run python3 tools/lock_dependencies.py"
        for module in lock["go_modules"]:
            assert set(module["sha256"]) == {"zip", "mod", "info"}
        print("Bazel source pins match Cargo.lock and go.sum")
        return
    rows = []
    for (name, version), sums in sorted(modules.items()):
        checksums = {}
        for suffix in ("info", "mod", "zip"):
            relative = f"{name}/@v/{version}.{suffix}"
            cached = root / ".toolchains/gomodcache/cache/download" / relative
            if cached.exists():
                data = cached.read_bytes()
            else:
                with urllib.request.urlopen(
                    "https://proxy.golang.org/" + relative, timeout=60
                ) as response:
                    data = response.read()
            if suffix == "mod":
                assert go_hash([("go.mod", data)]) == sums["mod"], (
                    f"go.mod checksum mismatch: {name}"
                )
            elif suffix == "zip":
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    files = [
                        (n, archive.read(n)) for n in archive.namelist() if not n.endswith("/")
                    ]
                assert go_hash(files) == sums["zip"], f"Module checksum mismatch: {name}"
            checksums[suffix] = hashlib.sha256(data).hexdigest()
        rows.append(dict(name=name, version=version, go_sum=sums, sha256=checksums))
    path.write_text(json.dumps(dict(crates=crates, go_modules=rows), indent=2) + "\n")


if __name__ == "__main__":
    main()
