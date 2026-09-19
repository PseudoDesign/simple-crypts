#!/usr/bin/env python3
"""Use the production SDK directly; the forwarding code sees only bytes."""
import time
from pathlib import Path
import tempfile

from simplecrypts import Endpoint


def main():
    # The caller models the existing trusted enrollment-authority boundary.
    enrollment_secret = bytes(32)  # unused compatibility slot in signed mode
    with tempfile.TemporaryDirectory(prefix="simple-crypts-api-") as directory:
        root = Path(directory)
        # With no provisioned_seed, the host provider generates and persists a
        # fresh identity using OS cryptographic randomness. No fixture APIs.
        with Endpoint("server", root / "server", "mcu-001", enrollment_secret) as server:
            server_public_key = bytes.fromhex(server.inspect()["public_key"])
            with Endpoint("device", root / "device", "mcu-001", enrollment_secret,
                          server_public_key=server_public_key) as device:
                for endpoint in (device, server):
                    endpoint.enrollment_enable()
                now = int(time.time())
                server.enrollment_begin(now, now + 600)
                device.receive(server.outbound(budget=512))  # verifies Ed25519 signature
                device.report(-18250)
                server.receive(device.outbound(budget=512))
                candidate = server.inspect()
                assert not candidate["registered"]
                # Approval binds the session and exact proposed Ed25519 key.
                server.enrollment_approve(bytes.fromhex(candidate["challenge"]),
                                          bytes.fromhex(candidate["candidate_key"]), int(time.time()))
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
