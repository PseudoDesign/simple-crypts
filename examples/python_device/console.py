#!/usr/bin/env python3
"""A manual device console using only the production Python SDK.

The console is the application; hexadecimal text is its transport. Neither a
credit debit nor receiving a packet silently transmits a response.
"""
import argparse
import json
import re
import sys
from pathlib import Path

from simplecrypts import Endpoint, Error

HELP = "help | status | consume <amount> | rx <hex> | tx | reboot | quit"


def uint64(text):
    if not re.fullmatch(r"[0-9]+", text) or len(text) > 20:
        raise ValueError("Expected an unsigned decimal uint64")
    value = int(text)
    if value >= 2**64:
        raise ValueError("Expected an unsigned decimal uint64")
    return value


def frame_bytes(text):
    if not re.fullmatch(r"(?:[0-9a-fA-F]{2}){1,512}", text):
        raise ValueError("Expected 1–512 bytes of contiguous hexadecimal text")
    return bytes.fromhex(text)


class DeviceConsole:
    """Own one endpoint; reboot reopens the same exclusively locked store."""

    def __init__(self, serial, storage, server_key):
        if not re.fullmatch(r"[!-~]{1,32}", serial):
            raise ValueError("Serial must be 1–32 printable ASCII bytes")
        if not re.fullmatch(r"[0-9a-fA-F]{64}", server_key):
            raise ValueError("Server key must be 32 hexadecimal bytes")
        self.serial = serial
        self.storage = Path(storage).absolute()
        self.server_key = bytes.fromhex(server_key)
        self.endpoint = None
        self.storage.parent.mkdir(parents=True, exist_ok=True)
        self.open()

    def open(self):
        # A missing seed means OS randomness creates a new identity. Existing
        # stores are resumed and checked against this serial and pinned key.
        self.endpoint = Endpoint("device", self.storage, self.serial, bytes(32),
                                 server_public_key=self.server_key)
        try:
            self.endpoint.enrollment_enable()
        except Exception:
            self.close()
            raise

    def close(self):
        if self.endpoint is not None:
            self.endpoint.close()
            self.endpoint = None

    def command(self, line):
        words = line.split()
        if not words:
            return ""
        command, *args = words
        if command == "quit" and not args:
            self.close()
            return "Stopped. Saved device state retained."
        if self.endpoint is None:
            raise ValueError("Device is stopped")
        if command == "help" and not args:
            return HELP
        if command == "status" and not args:
            return json.dumps(self.endpoint.inspect(), sort_keys=True)
        if command == "consume" and len(args) == 1:
            self.endpoint.consume_credits(uint64(args[0]))
        elif command == "rx" and len(args) == 1:
            self.endpoint.receive(frame_bytes(args[0]))
        elif command == "tx" and not args:
            frame = self.endpoint.outbound()
            return frame.hex() if frame is not None else "No output."
        elif command == "reboot" and not args:
            self.close()
            self.open()
        else:
            raise ValueError(HELP)
        return "ok"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--store", type=Path, required=True)
    parser.add_argument("--server-key", required=True)
    args = parser.parse_args()
    try:
        device = DeviceConsole(args.serial, args.store, args.server_key)
    except (Error, ValueError, OSError) as error:
        parser.exit(1, f"Cannot open device: {error}\n")
    print(HELP, flush=True)
    try:
        while device.endpoint is not None:
            if sys.stdin.isatty():
                print(f"{args.serial}> ", end="", flush=True)
            line = sys.stdin.readline(4097)
            if not line:
                break
            if len(line) > 4096:
                while line and not line.endswith("\n"):
                    line = sys.stdin.readline(4097)
                print("error: Command too long", flush=True)
                continue
            try:
                print(device.command(line), flush=True)
            except (Error, ValueError, OSError) as error:
                print(f"error: {error}", flush=True)
    except KeyboardInterrupt:
        print()
    finally:
        device.close()


if __name__ == "__main__":
    main()
