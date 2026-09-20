"""Linux operator CLI for the private QT Py demo transport, not a library API."""

import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import secrets
import select
import struct
import sys
import termios
import time
import tty
import uuid
import zlib

HELLO, START, SETUP, RECEIVE, OUTBOUND, CONSUME, RESET, REBOOT = range(1, 9)


def encode(data):
    """Frame bounded bytes with COBS and a zero delimiter."""
    out = bytearray(b"\0")
    mark, code = 0, 1
    for byte in data:
        if byte:
            out.append(byte)
            code += 1
        if not byte or code == 255:
            out[mark] = code
            mark, code = len(out), 1
            out.append(0)
    out[mark] = code
    return out + b"\0"


def decode(data):
    """Decode a complete bounded COBS frame, rejecting malformed input."""
    out = bytearray()
    at = 0
    while at < len(data):
        code = data[at]
        at += 1
        if not code or at + code - 1 > len(data):
            raise ValueError("invalid COBS packet")
        chunk = data[at : at + code - 1]
        if 0 in chunk:
            raise ValueError("zero inside COBS packet")
        out += chunk
        at += code - 1
        if code != 255 and at < len(data):
            out.append(0)
    if len(out) > 1024:
        raise ValueError("oversized demo packet")
    return bytes(out)


class Link:
    """One outstanding command on an owned serial/pipe connection; never retry mutations."""

    def __init__(self, read_fd, write_fd=None):
        self.read_fd = read_fd
        self.write_fd = read_fd if write_fd is None else write_fd
        self.sequence = 0

    def command(self, command, payload=b""):
        """Send once; return response bytes or report an uncertain result on timeout."""
        if len(payload) > 1008:
            raise ValueError("oversized management payload")
        self.sequence += 1
        message = struct.pack("!2sBBI", b"QT", 1, command, self.sequence) + payload
        frame = encode(message + struct.pack("!I", zlib.crc32(message)))
        deadline = time.monotonic() + 10
        sent = 0
        while sent < len(frame):
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([], [self.write_fd], [], remaining)[1]:
                raise TimeoutError("write timed out; result uncertain, inspect before retrying")
            try:
                count = os.write(self.write_fd, frame[sent:])
            except BlockingIOError:
                continue
            if not count:
                raise ConnectionError("device disconnected; result uncertain")
            sent += count
        buffer = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.read_fd], [], [], remaining)[0]:
                raise TimeoutError("response lost; result uncertain, inspect before retrying")
            try:
                byte = os.read(self.read_fd, 1)
            except BlockingIOError:
                continue
            if not byte:
                raise ConnectionError("device disconnected; result uncertain")
            if byte != b"\0":
                buffer += byte
                if len(buffer) > 1030:
                    raise ValueError("oversized device response")
                continue
            if not buffer:
                continue
            response = decode(buffer)
            buffer.clear()
            if len(response) < 16 or response[:4] != b"QR\1" + bytes([command]):
                raise ValueError("unexpected response header")
            if struct.unpack("!I", response[4:8])[0] != self.sequence:
                continue
            if zlib.crc32(response[:-4]) != struct.unpack("!I", response[-4:])[0]:
                raise ValueError("response checksum mismatch")
            status = struct.unpack("!i", response[8:12])[0]
            if status < 0:
                raise RuntimeError(f"device status {status}; inspect before retrying")
            return response[12:-4]

    def inspect(self):
        """Read public device and storage diagnostics without flash writes."""
        return json.loads(self.command(HELLO))

    def start(self):
        """Supply fresh startup entropy only when this boot needs it."""
        state = self.inspect()
        if state["fault"]:
            raise RuntimeError("device storage is faulted; use inspect/reset/recovery")
        if not state["crypto_ready"]:
            self.command(START, secrets.token_bytes(32))
        return self.inspect()


def exchange(link, server):
    """Move opaque library frames until idle or waiting for explicit approval."""
    for _ in range(32):
        moved = False
        frame = server.outbound()
        if frame:
            link.command(RECEIVE, frame)
            moved = True
        frame = link.command(OUTBOUND)
        if frame:
            server.receive_at(frame, int(time.time()))
            moved = True
        state = server.inspect()
        if not state["registered"] and int(state["candidate_revision"]):
            return state
        if not moved:
            return state
    raise RuntimeError("exchange did not settle; inspect both endpoints")


def save_session(directory, record):
    """Durably select a host session before sending device provisioning material."""
    temporary = directory / "current.tmp"
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(record, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, directory / "current.json")
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def operate(link, directory, action, amount=None):
    """Execute a demo action using the unchanged production Python SDK."""
    from simplecrypts import Endpoint  # Native SDK is supplied by the Bazel CLI target.

    if action == "inspect":
        return link.inspect()
    if action in ("reset", "reboot"):
        link.command(RESET if action == "reset" else REBOOT)
        return {"result": "device restarting; reconnect before setup"}
    state = link.inspect()
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / "operator.lock").open("a", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fresh = action == "setup" and not state["provisioned"]
        if fresh:
            session = {"serial": state["serial"], "session": str(uuid.uuid4())}
        else:
            session = json.loads((directory / "current.json").read_text())
            if session["serial"] != state["serial"]:
                raise RuntimeError("host session belongs to another board")
        with Endpoint(
            "server", directory / session["session"], state["serial"], bytes(32)
        ) as server:
            if fresh:
                server.enrollment_enable()
                server.enrollment_begin(int(time.time()), int(time.time()) + 600)
                invitation = server.outbound()
                pin = bytes.fromhex(server.inspect()["public_key"])
                save_session(directory, session)
                link.command(
                    SETUP, secrets.token_bytes(32) + secrets.token_bytes(32) + pin + invitation
                )
            else:
                if state["server_key"] != server.inspect()["public_key"]:
                    raise RuntimeError("server pin mismatch; do not replace an existing identity")
                link.start()
            if action in ("setup", "enroll") and not fresh:
                if not server.inspect()["registered"]:
                    server.enrollment_begin(int(time.time()), int(time.time()) + 600)
            elif action == "approve":
                pending = server.inspect()
                server.enrollment_approve(
                    bytes.fromhex(pending["challenge"]),
                    bytes.fromhex(pending["candidate_key"]),
                    int(time.time()),
                )
            elif action == "issue":
                server.set_credits_issued(amount)
            elif action == "consume":
                link.command(CONSUME, amount.to_bytes(8, "big"))
            elif action == "status":
                server.request_credit_status()
            host = exchange(link, server)
            return {"device": link.inspect(), "server": host}


@contextlib.contextmanager
def serial_link(port):
    """Open an explicitly selected Linux CDC port and assert DTR."""
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    old = None
    try:
        old = termios.tcgetattr(fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        tty.setraw(fd)
        fcntl.ioctl(fd, termios.TIOCMBIS, struct.pack("I", termios.TIOCM_DTR))
        termios.tcflush(fd, termios.TCIOFLUSH)
        os.write(fd, b"\0")
        yield Link(fd)
    finally:
        if old is not None:
            with contextlib.suppress(OSError):
                termios.tcsetattr(fd, termios.TCSANOW, old)
        os.close(fd)


def main():
    """Parse explicit operator actions; never print provisioning payloads."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--store", type=Path, required=True)
    parser.add_argument(
        "action",
        choices=[
            "setup",
            "enroll",
            "approve",
            "issue",
            "consume",
            "status",
            "inspect",
            "reset",
            "reboot",
        ],
    )
    parser.add_argument("amount", nargs="?", type=int)
    args = parser.parse_args()
    if not args.store.is_absolute():
        parser.error("--store must be absolute so it cannot land in temporary Bazel runfiles")
    if args.action in ("issue", "consume") and (
        args.amount is None or not 0 <= args.amount < 2**64
    ):
        parser.error("issue/consume requires a uint64 amount")
    os.umask(0o077)
    try:
        with serial_link(args.port) as link:
            print(json.dumps(operate(link, args.store, args.action, args.amount), indent=2))
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
