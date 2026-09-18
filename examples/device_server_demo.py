#!/usr/bin/env python3
"""A C device and Python server converge across deliberately lost traffic."""
import argparse

from coordinator import Relay


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", required=True)
    parser.add_argument("--server", required=True)
    args = parser.parse_args()
    relay = Relay(args.device, args.server)
    try:
        device, server = relay.pair()
        device.ok("report", temperature=-18250)
        first = relay.opportunity("device")
        print(f"Device reports -18.250°C in an opaque {len(relay.queue[first])}-byte packet.")
        relay.drop(first)
        print("Host drops the first enrollment packet.")
        device.ok("report", temperature=-18125)
        relay.exchange("device", "server")
        assert server.state()["registered"]
        assert server.state()["temperature"] == -18125
        print("A later self-contained report enrolls the device and supplies -18.125°C.")
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
        print("No network handshake, ping, or keepalive was needed.")
    except BaseException as error:
        relay.save("device-server-demo", error)
        raise
    finally:
        relay.close()


if __name__ == "__main__":
    main()
