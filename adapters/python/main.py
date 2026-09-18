#!/usr/bin/env python3
"""Test-only JSONL process adapter exercising the public Python SDK."""
import base64
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bindings" / "python"))
from simplecrypts import Endpoint, Error, fixture_public_key


def hex32(value):
    result = bytes.fromhex(value)
    if len(result) != 32:
        raise ValueError("expected 32-byte hexadecimal fixture")
    return result


def main():
    endpoint = None
    for line in sys.stdin:
        result = {"status": "ok"}
        try:
            item = json.loads(line)
            command = item.get("command", item.get("cmd", item.get("op")))
            if command == "init":
                if endpoint:
                    raise ValueError("already initialized")
                server_public = hex32(item["server_public_key"]) if "server_public_key" in item else fixture_public_key(hex32(item.get("server_seed", "22" * 32)))
                endpoint = Endpoint(item["role"], item["storage"], item.get("serial", "SAMPLE-001"),
                    hex32(item.get("secret", "33" * 32)), server_public_key=server_public,
                    provisioned_seed=hex32(item["key_seed"]) if item.get("key_seed") is not None else None,
                    random_unavailable=item.get("random_unavailable", item.get("provision_without_random", False)))
                if "initial_revision" in item:
                    endpoint.fixture_revision(int(item["initial_revision"]))
            elif endpoint is None:
                raise ValueError("not initialized")
            elif command == "name":
                endpoint.name(item["name"])
            elif command == "report":
                endpoint.report(item.get("temperature", item.get("temperature_mC")))
            elif command == "rx":
                endpoint.receive(base64.b64decode(item["frame"], validate=True))
            elif command == "tx":
                frame = endpoint.outbound(item.get("budget", 512), item.get("capacity", 512))
                if frame is None:
                    result["status"] = "idle"
                else:
                    result["frame"] = base64.b64encode(frame).decode()
            elif command == "fail":
                endpoint.fail(item["operation"], item.get("count", 1))
            elif command == "close":
                endpoint.close()
                endpoint = None
            elif command != "state":
                raise ValueError("unknown command")
        except Error as error:
            result["status"] = error.status
        except (ValueError, KeyError, TypeError, OverflowError):
            result["status"] = "invalid"
        if endpoint:
            result["state"] = endpoint.inspect()
        print(json.dumps(result, separators=(",", ":")), flush=True)
    if endpoint:
        endpoint.close()


if __name__ == "__main__":
    main()
