#!/usr/bin/env python3
import subprocess

subprocess.run(
    [
        "/usr/bin/node",
        "web/protocol_test.mjs",
        "web/endpoint.test.mjs",
        "web/endpoint.wasm.mjs",
        "adapters/c/adapter",
    ],
    check=True,
    timeout=120,
)
