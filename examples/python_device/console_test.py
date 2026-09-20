"""Real signed enrollment and restart through the documented console commands."""
import json
import tempfile
import time
import unittest
from pathlib import Path

from console import DeviceConsole, frame_bytes, uint64
from simplecrypts import Endpoint, Error


class ConsoleTest(unittest.TestCase):
    def test_manual_exchange_and_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with Endpoint("server", root / "server", "python-01", bytes(32)) as server:
                server.enrollment_enable()
                device = DeviceConsole("python-01", root / "device", server.inspect()["public_key"])
                try:
                    original_key = json.loads(device.command("status"))["public_key"]
                    self.assertEqual(device.command("tx"), "No output.")
                    now = int(time.time())
                    server.enrollment_begin(now, now + 600)
                    device.command("rx " + server.outbound().hex())
                    response = bytes.fromhex(device.command("tx"))
                    server.receive(response)
                    candidate = server.inspect()
                    self.assertFalse(candidate["registered"])
                    server.enrollment_approve(bytes.fromhex(candidate["challenge"]),
                                              bytes.fromhex(candidate["candidate_key"]), now)
                    device.command("rx " + server.outbound().hex())
                    server.set_credits_issued(100)
                    device.command("rx " + server.outbound().hex())
                    server.receive(bytes.fromhex(device.command("tx")))
                    device.command("rx " + server.outbound().hex())
                    device.command("consume 25")
                    self.assertEqual(device.command("tx"), "No output.")
                    self.assertEqual(server.inspect()["credits_consumed"], "0")
                    device.command("reboot")
                    state = json.loads(device.command("status"))
                    self.assertEqual(state["public_key"], original_key)
                    self.assertEqual(state["credits_consumed"], "25")
                    with self.assertRaises(Error):
                        device.command("consume 76")
                    server.request_credit_status()
                    device.command("rx " + server.outbound().hex())
                    report = bytes.fromhex(device.command("tx"))
                    server.receive(report)
                    server.receive(report)  # replay does not consume again
                    device.command("rx " + server.outbound().hex())
                    self.assertEqual(server.inspect()["credits_consumed"], "25")
                    device.command("quit")
                    self.assertIsNone(device.endpoint)
                finally:
                    device.close()

    def test_input_validation(self):
        self.assertEqual(uint64("18446744073709551615"), 2**64 - 1)
        for value in ("-1", "+1", "1e3", "1.5", "18446744073709551616", ""):
            with self.assertRaises(ValueError):
                uint64(value)
        for value in ("", "abc", "zz", "00 " * 4, "00" * 513):
            with self.assertRaises(ValueError):
                frame_bytes(value)


if __name__ == "__main__":
    unittest.main()
