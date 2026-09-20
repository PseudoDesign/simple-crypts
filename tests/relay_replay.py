#!/usr/bin/env python3
"""Verify that an emitted relay transcript can actually be replayed."""

import argparse
import json
from pathlib import Path
import tempfile

from coordinator import Relay, replay
from conformance import generated_schedule


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", required=True)
    parser.add_argument("--server", required=True)
    args = parser.parse_args()
    relay = Relay(args.device, args.server, seed=773521)
    try:
        generated_schedule(relay)
        content = {
            "format": 1,
            "seed": relay.seed,
            "scenario": "generated_schedule",
            "events": relay.events,
        }
    finally:
        relay.close()
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "transcript.json"
        path.write_text(json.dumps(content))
        replay(path, args.device, args.server)
    print("PASS exact transcript replay including restarted persistent endpoints")


if __name__ == "__main__":
    main()
