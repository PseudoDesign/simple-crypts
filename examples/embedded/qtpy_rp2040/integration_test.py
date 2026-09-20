"""Exercise the exact firmware application through its private framed transport."""

import contextlib
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

from cli import CONSUME, REBOOT, RESET, SETUP, START, Link, operate


class DemoTest(unittest.TestCase):
    """Use a process per boot so libsodium's startup path really runs each time."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.store = self.directory / "server"
        self.flash = self.directory / "flash.bin"

    @contextlib.contextmanager
    def boot(self, cut=False):
        """Run one device boot with durable simulated flash."""
        binary = Path(__file__).with_name("sim")
        environment = dict(os.environ)
        if cut:
            environment["QT_SIM_CUT_AFTER_IDENTITY"] = "1"
        with subprocess.Popen(
            [str(binary), str(self.flash)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            env=environment,
        ) as process:
            try:
                yield Link(process.stdout.fileno(), process.stdin.fileno())
            finally:
                if process.poll() is None:
                    process.stdin.close()
                process.wait(timeout=10)
                self.assertEqual(process.returncode, 43 if cut else 0)

    def action(self, link, action, amount=None):
        """Invoke the same operator flow used for the real USB device."""
        return operate(link, self.store, action, amount)

    def test_lifecycle(self):
        """Enroll, issue/consume, reboot, inspect, and reset without replacing keys."""
        with self.boot() as link:
            self.assertFalse(link.inspect()["provisioned"])
            with self.assertRaises(RuntimeError):
                link.command(START, bytes(31))
            result = self.action(link, "setup")
            key = result["device"]["public_key"]
            server_key = result["device"]["server_key"]
            self.assertFalse(result["device"]["registered"])
            with self.assertRaises(RuntimeError):
                link.command(SETUP, os.urandom(268))
            self.action(link, "approve")
            self.action(link, "issue", 100)
            self.action(link, "consume", 25)
            result = self.action(link, "status")
            self.assertTrue(result["device"]["registered"])
            self.assertEqual(result["device"]["issued"], "100")
            self.assertEqual(result["device"]["consumed"], "25")
            before = self.flash.read_bytes()
            self.action(link, "inspect")
            self.assertEqual(self.flash.read_bytes(), before)
            nonce = int(link.inspect()["nonce_end"])
            link.command(REBOOT)
        with self.boot() as link:
            self.assertFalse(link.inspect()["crypto_ready"])
            result = self.action(link, "status")
            self.assertEqual(result["device"]["public_key"], key)
            self.assertEqual(result["device"]["server_key"], server_key)
            self.assertEqual(result["device"]["consumed"], "25")
            self.assertGreater(int(result["device"]["nonce_end"]), nonce)
            link.command(RESET)
        with self.boot() as link:
            self.assertFalse(link.inspect()["provisioned"])
            result = self.action(link, "setup")
            self.assertNotEqual(result["device"]["public_key"], key)
            self.assertNotEqual(result["device"]["server_key"], server_key)
            self.action(link, "approve")
            with self.assertRaises(RuntimeError):
                link.command(CONSUME, (1).to_bytes(8, "big"))

    def test_ring_consumption_survives_reboot(self):
        """Exercise multiple ring wraps through the real credit commit path."""
        with self.boot() as link:
            self.action(link, "setup")
            self.action(link, "approve")
            self.action(link, "issue", 100)
            before = link.inspect()
            for _ in range(70):
                link.command(CONSUME, (1).to_bytes(8, "big"))
            after = link.inspect()
            self.assertEqual(after["consumed"], "70")
            self.assertEqual(
                after["snapshot_erase_attempts"] - before["snapshot_erase_attempts"], 70
            )
            self.assertEqual(after["reset_erase_attempts"], 0)
            link.command(REBOOT)
        with self.boot() as link:
            result = self.action(link, "status")
            self.assertEqual(result["device"]["consumed"], "70")
            link.command(RESET)
        self.assertEqual(self.flash.read_bytes(), bytes([255]) * (33 * 4096))

    def test_reject_bad_setup_without_persistence(self):
        """Pin/signature/serial failures cannot create an identity or write flash."""
        from simplecrypts import Endpoint

        with self.boot() as link:
            serial = link.inspect()["serial"]
            with Endpoint("server", self.directory / "inviter", serial, bytes(32)) as server:
                server.enrollment_enable()
                server.enrollment_begin(int(time.time()), int(time.time()) + 600)
                invite = server.outbound()
                pin = bytes.fromhex(server.inspect()["public_key"])
                bundle = os.urandom(64) + pin + invite
                blank = self.flash.read_bytes()
                for offset in (64, 96 + 36, 96 + 108):
                    invalid = bytearray(bundle)
                    invalid[offset] ^= 1
                    with self.assertRaises(RuntimeError):
                        link.command(SETUP, invalid)
                    self.assertFalse(link.inspect()["provisioned"])
                    self.assertEqual(self.flash.read_bytes(), blank)
                # Invalid setup may initialize this boot's crypto, but cannot reseed it.
                with self.assertRaises(RuntimeError):
                    link.command(START, os.urandom(32))
                link.command(SETUP, bundle)
                self.assertTrue(link.inspect()["provisioned"])

    def test_transport_recovers_at_delimiter(self):
        """Oversized, truncated and corrupted input cannot change state or desynchronize."""
        with self.boot() as link:
            link.inspect()
            blank = self.flash.read_bytes()
            for packet in (b"x" * 1200 + b"\0", b"\xffbad\0", b"\1\1\0"):
                os.write(link.write_fd, packet)
                self.assertFalse(link.inspect()["provisioned"])
            self.assertEqual(self.flash.read_bytes(), blank)

    def test_resume_after_identity_commit_cut(self):
        """A power cut before sc_init resumes the durable identity and host session."""
        with self.boot(cut=True) as link:
            with self.assertRaises(ConnectionError):
                self.action(link, "setup")
        with self.boot() as link:
            state = link.inspect()
            self.assertTrue(state["provisioned"])
            self.assertFalse(state["ready"])
            key = state["public_key"]
            self.assertEqual(self.action(link, "enroll")["device"]["public_key"], key)
            self.assertTrue(self.action(link, "approve")["device"]["registered"])

    def test_resume_unapproved_identity(self):
        """Reconnection resumes committed provisioning with the original key."""
        with self.boot() as link:
            key = self.action(link, "setup")["device"]["public_key"]
            link.command(REBOOT)
        with self.boot() as link:
            self.assertEqual(self.action(link, "enroll")["device"]["public_key"], key)
            self.assertTrue(self.action(link, "approve")["device"]["registered"])


if __name__ == "__main__":
    unittest.main()
