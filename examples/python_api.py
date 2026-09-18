#!/usr/bin/env python3
"""Use the production SDK directly; the forwarding code sees only bytes."""
import os
from pathlib import Path
import tempfile

from simplecrypts import Endpoint


def main():
    # This one-process example acts as the trusted provisioning environment.
    # A real MCU receives its token and the server PUBLIC key at provisioning.
    enrollment_secret = os.urandom(32)
    with tempfile.TemporaryDirectory(prefix="simple-crypts-api-") as directory:
        root = Path(directory)
        # With no provisioned_seed, the host provider generates and persists a
        # fresh identity using OS cryptographic randomness. No fixture APIs.
        with Endpoint("server", root / "server", "mcu-001", enrollment_secret) as server:
            server_public_key = bytes.fromhex(server.inspect()["public_key"])
            with Endpoint("device", root / "device", "mcu-001", enrollment_secret,
                          server_public_key=server_public_key) as device:
                device.report(-18250)
                server.receive(device.outbound(budget=512))
                assert server.inspect()["temperature"] == -18250

                server.name("Freezer 3")
                device.receive(server.outbound(budget=512))
                assert server.inspect()["pending"]

                server.receive(device.outbound(budget=512))
                device.receive(server.outbound(budget=512))
                assert device.inspect()["actual_name"] == "Freezer 3"
                assert not server.inspect()["pending"]
                assert not device.inspect()["pending"]
                print("Freezer 3: last reported temperature -18.250°C; confirmed.")


if __name__ == "__main__":
    main()
