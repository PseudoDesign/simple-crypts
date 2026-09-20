import subprocess

subprocess.run([
    "/usr/bin/node", "examples/fleet_manager/protocol_test.mjs",
    "examples/fleet_manager/server.mjs", "examples/device_console/device.mjs",
    "examples/python_device/console",
], check=True, timeout=120)
