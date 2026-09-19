#!/usr/bin/env python3
"""A C device and Python server converge across deliberately lost traffic."""
import argparse
import time

from coordinator import Relay


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", required=True)
    parser.add_argument("--server", required=True)
    args = parser.parse_args()
    relay = Relay(args.device, args.server)
    try:
        device, server = relay.pair()
        for endpoint in (device, server):
            endpoint.ok("enrollment_enable")
        now = int(time.time())
        server.ok("enrollment_begin", now=now, expires=now+600)
        relay.exchange("server", "device")
        print("Device verifies the signed server challenge using its pinned Ed25519 key.")
        device.ok("report", temperature=-18250)
        first = relay.opportunity("device")
        print(f"Device reports -18.250°C in an opaque {len(relay.queue[first])}-byte packet.")
        relay.drop(first)
        print("Host drops the first enrollment packet.")
        device.ok("report", temperature=-18125)
        relay.exchange("device", "server")
        candidate = server.state()
        assert not candidate["registered"]
        print("The response authenticated; the candidate key is awaiting approval.")
        server.ok("enrollment_approve", challenge=candidate["challenge"],
                  key=candidate["candidate_key"], now=int(time.time()))
        assert server.state()["registered"]
        assert server.state()["temperature"] == -18125
        print("Trusted approval registers the exact key and accepts -18.125°C.")
        server.ok("name", name="Freezer 3")
        relay.exchange("server", "device")
        assert device.state()["actual_name"] == "Freezer 3"
        assert server.state()["pending"]
        print("Device applies 'Freezer 3'; the server still shows pending confirmation.")
        relay.drop(relay.opportunity("device"))
        print("Host drops the application report. Both endpoints retain their latest state.")
        relay.restart("device")
        relay.exchange("device", "server")
        relay.exchange("server", "device")
        assert not server.state()["pending"] and not device.state()["pending"]
        print("After a reboot and another transmission opportunity, both endpoints confirm.")
        print("Enrollment used an explicit challenge/response; no pings or keepalives were needed.")
    except BaseException as error:
        relay.save("device-server-demo", error)
        raise
    finally:
        relay.close()


if __name__ == "__main__":
    main()
