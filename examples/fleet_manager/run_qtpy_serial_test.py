"""Run browser transport contract tests with Node's Web Streams implementation."""

import subprocess

subprocess.run(
    ["/usr/bin/node", "examples/fleet_manager/qtpy_serial_test.mjs"], check=True, timeout=30
)
