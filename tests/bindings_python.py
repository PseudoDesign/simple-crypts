#!/usr/bin/env python3
"""Test actual CFFI ownership and argument conversions, outside JSON adapters."""
import tempfile
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bindings" / "python"))
from simplecrypts import Endpoint, Error, fixture_public_key


def fails(operation):
    try:
        operation()
    except (Error, ValueError, OverflowError):
        return
    raise AssertionError("invalid operation succeeded")


def main():
    with tempfile.TemporaryDirectory() as directory:
        device = Endpoint("device", Path(directory) / "d", "python-test", bytes([3]) * 32,
                          server_public_key=fixture_public_key(bytes([2]) * 32),
                          provisioned_seed=bytes([1]) * 32, random_unavailable=True)
        with device:
            device.fixture_revision(2**53 + 9)
            device.report(-18250)
            state = device.inspect()
            assert state["reported_revision"] == str(2**53 + 10)
            frame = device.outbound()
            saved = bytes(frame)
            device.report(25000)
            next_frame = device.outbound()
            assert frame == saved and frame != next_frame
            assert state["reported_revision"] == str(2**53 + 10), "state aliases native memory"
            fails(lambda: device.report(2**31))
            fails(lambda: device.report(True))
            fails(lambda: device.report(1.5))
            fails(lambda: device.outbound(capacity=-1))
            fails(lambda: device.receive(bytearray(frame)))
            fails(lambda: device.receive(bytes(513)))
            fails(lambda: device.name("wrong role"))
            fails(lambda: device.fixture_revision(2**64))
        device.close()
        fails(lambda: device.report(1))
        fails(lambda: device.inspect())
    print("PASS Python CFFI buffer ownership, errors, close, and exact uint64")


if __name__ == "__main__":
    main()
