import os
import subprocess

os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "/tmp/simple-crypts-browsers")
subprocess.run([
    "/usr/bin/node", "examples/fleet_manager/browser_test.mjs", "examples/fleet_manager/site",
], check=True, timeout=240)
