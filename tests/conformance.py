#!/usr/bin/env python3
"""The same behavioral contract runs against all sixteen SDK pairings."""
from __future__ import annotations

import argparse
import base64
import random
import sys

from coordinator import Relay, replay


def number(state, key):
    value = state[key]
    assert isinstance(value, str), (key, "64-bit values must be decimal strings", value)
    return int(value)


def accepted(response):
    assert response["status"] in ("ok", "duplicate", "stale"), response


def rejected(response):
    assert response["status"] not in ("ok", "idle", "duplicate", "stale"), response


def enrolled(relay):
    d, s = relay.pair()
    d.ok("report", temperature=21000)
    relay.exchange("device", "server")
    relay.exchange("server", "device")
    assert d.state()["registered"] and s.state()["registered"]
    return d, s


def first_exchange(r):
    d, s = r.pair()
    d.ok("report", temperature=-18250)
    frame = r.exchange("device", "server")
    assert s.state()["temperature"] == -18250
    assert s.state()["registered"] and not d.state()["registered"]
    s.ok("name", name="Freezer 3")
    assert s.state()["pending"]
    r.exchange("server", "device")
    assert d.state()["actual_name"] == "Freezer 3"
    assert s.state()["pending"], "delivery is not application confirmation"
    r.exchange("device", "server")
    state = s.state()
    assert state["actual_name"] == "Freezer 3" and not state["pending"]
    assert number(state, "applied_desired_revision") == number(state, "desired_revision")
    r.exchange("server", "device")
    assert not d.state()["pending"]
    assert b"Freezer 3" not in r.queue[frame]


def lost_initial(r):
    d, s = r.pair()
    d.ok("report", temperature=1000)
    r.drop(r.opportunity("device"))
    d.ok("report", temperature=2000)
    r.advance(1000000)
    r.exchange("device", "server")
    assert s.state()["temperature"] == 2000 and s.state()["registered"]
    assert not d.state()["registered"]
    r.exchange("server", "device")
    assert d.state()["registered"]


def authorization(r):
    d, s = r.pair(secret="44" * 32, key_seed="44" * 32)
    d.ok("report", temperature=1000)
    before = s.state()
    rejected(r.deliver(r.opportunity("device"), "server"))
    assert s.state() == before
    legit, result = r.spawn("legit", "device")
    assert result["status"] == "ok"
    legit.ok("report", temperature=22000)
    r.exchange("legit", "server")
    before = s.state()
    conflict, result = r.spawn("conflict", "device", key_seed="55" * 32)
    assert result["status"] == "ok"
    conflict.ok("report", temperature=99000)
    rejected(r.deliver(r.opportunity("conflict"), "server"))
    assert s.state() == before, "serial/key binding must not be replaceable"


def lost_receipts(r):
    d, s = r.pair()
    d.ok("report", temperature=1)
    original = r.exchange("device", "server")
    lost = r.opportunity("server")
    assert lost is not None
    accepted(r.deliver(original, "server"))
    assert number(s.state(), "reported_revision") == 1
    d.ok("report", temperature=2)
    r.exchange("device", "server")
    accepted(r.deliver(lost, "device"))
    assert d.state()["pending"], "old receipt must not clear newer report"
    r.exchange("server", "device")
    assert not d.state()["pending"]
    accepted(r.deliver(original, "server"))
    assert s.state()["temperature"] == 2
    assert number(s.state(), "reported_revision") == 2


def lost_application_report(r):
    d, s = enrolled(r)
    s.ok("name", name="new name")
    desired = r.exchange("server", "device")
    r.drop(r.opportunity("device"))
    assert s.state()["pending"]
    accepted(r.deliver(desired, "device"))
    r.exchange("device", "server")
    assert not s.state()["pending"]
    assert s.state()["actual_name"] == "new name"


def rejected_name(r):
    d, s = enrolled(r)
    s.ok("name", name="kept name")
    old = r.exchange("server", "device")
    r.exchange("device", "server")
    s.ok("name", name="")
    assert s.state()["pending"]
    r.exchange("server", "device")
    assert d.state()["actual_name"] == "kept name"
    assert d.state()["apply_status"] == "rejected"
    assert s.state()["pending"]
    r.exchange("device", "server")
    assert not s.state()["pending"]
    state = s.state()
    assert state["apply_status"] == "rejected"
    assert number(state, "processed_desired_revision") == number(state, "desired_revision")
    assert number(state, "applied_desired_revision") < number(state, "desired_revision")
    accepted(r.deliver(old, "device"))
    assert d.state()["apply_status"] == "rejected", "older successful name must not undo rejection"


def reordered_snapshots(r):
    d, s = enrolled(r)
    s.ok("name", name="older")
    old_name = r.opportunity("server")
    s.ok("name", name="newer")
    new_name = r.opportunity("server")
    accepted(r.deliver(new_name, "device"))
    accepted(r.deliver(old_name, "device"))
    assert d.state()["actual_name"] == "newer"
    d.ok("report", temperature=100)
    old_report = r.opportunity("device")
    d.ok("report", temperature=200)
    new_report = r.opportunity("device")
    accepted(r.deliver(new_report, "server"))
    accepted(r.deliver(old_report, "server"))
    assert s.state()["temperature"] == 200
    assert s.state()["actual_name"] == "newer"
    assert not s.state()["pending"]


def tamper_and_reflect(r):
    d, s = r.pair()
    d.ok("report", temperature=21000)
    original = r.opportunity("device")
    raw = r.queue[original]
    before = s.state()
    for offset in sorted(set((0, 1, len(raw) // 4, len(raw) // 2, len(raw) - 1))):
        rejected(r.deliver(r.mutate(original, offset), "server"))
        assert s.state() == before
    for raw_invalid in (raw[:1], raw[:-1], bytes(513)):
        rejected(s.command("rx", frame=base64.b64encode(raw_invalid).decode()))
        assert s.state() == before
    device_before = d.state()
    rejected(r.deliver(original, "device"))
    assert d.state() == device_before
    accepted(r.deliver(original, "server"))
    s.ok("name", name="protected")
    downstream = r.opportunity("server")
    server_before = s.state()
    rejected(r.deliver(downstream, "server"))
    assert s.state() == server_before
    device_before = d.state()
    rejected(r.deliver(r.mutate(downstream, -1), "device"))
    assert d.state() == device_before


def reboot(r):
    d, s = enrolled(r)
    s.ok("name", name="before reboot")
    old_desired = r.exchange("server", "device")
    old_report = r.exchange("device", "server")
    device_before, server_before = d.state(), s.state()
    r.restart("device")
    r.restart("server")
    for key in ("registered", "actual_name", "reported_revision", "applied_desired_revision"):
        assert d.state()[key] == device_before[key]
        assert s.state()[key] == server_before[key]
    s.ok("name", name="after reboot")
    new_desired = r.exchange("server", "device")
    new_report = r.exchange("device", "server")
    assert r.queue[old_desired] != r.queue[new_desired]
    assert r.queue[old_report] != r.queue[new_report]
    accepted(r.deliver(old_desired, "device"))
    accepted(r.deliver(old_report, "server"))
    assert d.state()["actual_name"] == s.state()["actual_name"] == "after reboot"
    assert not s.state()["pending"]


def failed_commits(r):
    d, s = r.pair()
    before = d.state()
    d.ok("fail", operation="storage", count=1)
    rejected(d.command("report", temperature=123))
    assert d.state() == before
    r.restart("device")
    assert d.state()["reported_revision"] == before["reported_revision"]
    d.ok("report", temperature=456)
    frame = r.opportunity("device")
    before = s.state()
    s.ok("fail", operation="storage", count=1)
    rejected(r.deliver(frame, "server"))
    assert s.state() == before
    r.restart("server")
    assert not s.state()["registered"]
    accepted(r.deliver(frame, "server"))
    assert s.state()["registered"] and s.state()["temperature"] == 456
    s.ok("name", name="commit me")
    desired = r.opportunity("server")
    before = d.state()
    d.ok("fail", operation="storage", count=1)
    rejected(r.deliver(desired, "device"))
    assert d.state() == before
    r.restart("device")
    assert d.state()["actual_name"] == before["actual_name"]
    accepted(r.deliver(desired, "device"))
    assert d.state()["actual_name"] == "commit me"


def buffer_and_provider_failures(r):
    d, s = r.pair()
    d.ok("report", temperature=321)
    before = d.state()
    for arguments in ({"budget": 0}, {"budget": 1}, {"capacity": 1}, {"capacity": 0}):
        response = d.command("tx", budget=arguments.get("budget", 512),
                             capacity=arguments.get("capacity", 512))
        assert not response.get("frame"), response
        assert d.state() == before
    d.ok("fail", operation="storage", count=1)
    rejected(d.command("tx", budget=512, capacity=512))
    assert d.state() == before
    d.ok("fail", operation="crypto", count=1)
    rejected(d.command("tx", budget=512, capacity=512))
    assert d.state()["pending"]
    r.exchange("device", "server")
    s.ok("name", name="a" * 64)
    before = s.state()
    rejected(s.command("name", name="a" * 65))
    rejected(s.command("name", name="é" * 33))
    assert s.state() == before
    s.ok("name", name="é" * 32)
    r.exchange("server", "device")
    assert d.state()["actual_name"] == "é" * 32


def unavailable_randomness(r):
    d, result = r.spawn("unprovisioned", "device", key_seed=None, random_unavailable=True)
    assert result["status"] == "random", result
    d, s = r.pair(random_unavailable=True)
    d.ok("report", temperature=789)
    first = r.exchange("device", "server")
    r.restart("device")
    d.ok("report", temperature=790)
    second = r.exchange("device", "server")
    assert r.queue[first] != r.queue[second]
    r.exchange("server", "device")
    assert not d.state()["pending"] and s.state()["temperature"] == 790


def exact_uint64(r):
    base_device, base_server = 2**53 + 17, 2**53 + 31
    d, dr = r.spawn("device", "device", initial_revision=str(base_device))
    s, sr = r.spawn("server", "server", initial_revision=str(base_server))
    assert dr["status"] == sr["status"] == "ok", (dr, sr)
    d.ok("report", temperature=1234)
    s.ok("name", name="64-bit revisions")
    r.exchange("device", "server")
    assert number(s.state(), "reported_revision") == base_device + 1
    r.exchange("server", "device")
    assert number(d.state(), "applied_desired_revision") == base_server + 1
    assert number(d.state(), "reported_revision") == base_device + 2
    r.exchange("device", "server")
    assert not s.state()["pending"]
    for name in ("device", "server"):
        r.endpoints[name].config.pop("initial_revision")
        r.restart(name)
    assert number(s.state(), "reported_revision") == base_device + 2
    assert number(d.state(), "applied_desired_revision") == base_server + 1
    for role, operation, arguments in (("device", "report", {"temperature": 1}),
                                       ("server", "name", {"name": "overflow"})):
        endpoint, response = r.spawn("exhausted-" + role, role,
                                    initial_revision=str(2**64 - 1))
        assert response["status"] == "ok", response
        before = endpoint.state()
        rejected(endpoint.command(operation, **arguments))
        assert endpoint.state() == before, "revision must never wrap"


def bounded_withholding(r):
    d, s = enrolled(r)
    for i in range(100):
        d.ok("report", temperature=i)
        s.ok("name", name=f"latest-{i}")
        r.advance(1000000)
        # The library retains snapshots, not a history or a timer-driven queue.
        if i % 10 == 0:
            r.drop(r.opportunity("device"))
            r.drop(r.opportunity("server"))
    assert d.state()["pending"] and s.state()["pending"]
    r.exchange("server", "device")
    r.exchange("device", "server")
    r.exchange("server", "device")
    assert s.state()["temperature"] == 99
    assert d.state()["actual_name"] == "latest-99"
    assert not s.state()["pending"] and not d.state()["pending"]


def generated_schedule(r):
    d, s = enrolled(r)
    rng = random.Random(r.seed)
    pending = []
    latest_temp, latest_name = 21000, ""
    for i in range(80):
        action = rng.randrange(8)
        if action == 0:
            latest_temp = rng.randrange(-50000, 100000)
            d.ok("report", temperature=latest_temp)
        elif action == 1:
            latest_name = f"seed-{r.seed}-{i}"
            s.ok("name", name=latest_name)
        elif action in (2, 3):
            sender, receiver = ("device", "server") if action == 2 else ("server", "device")
            frame = r.opportunity(sender)
            if frame is not None:
                pending.append((frame, receiver))
        elif action == 4 and pending:
            frame, receiver = rng.choice(pending)
            before = r.endpoints[receiver].state()
            accepted(r.deliver(frame, receiver))
            after = r.endpoints[receiver].state()
            for key in ("reported_revision", "desired_revision", "applied_desired_revision"):
                assert number(after, key) >= number(before, key), (key, before, after)
        elif action == 5:
            r.restart(rng.choice(("device", "server")))
        elif action == 6 and pending:
            frame, receiver = rng.choice(pending)
            before = r.endpoints[receiver].state()
            rejected(r.deliver(r.mutate(frame, -1), receiver))
            assert r.endpoints[receiver].state() == before
        else:
            r.advance(rng.randrange(1, 1000000))
    # Once the hostile relay cooperates, only current snapshots are needed.
    for _ in range(3):
        for sender, receiver in (("device", "server"), ("server", "device")):
            frame = r.opportunity(sender)
            if frame is not None:
                accepted(r.deliver(frame, receiver))
    assert s.state()["temperature"] == latest_temp
    assert d.state()["actual_name"] == s.state()["actual_name"] == latest_name
    assert not s.state()["pending"] and not d.state()["pending"]


SCENARIOS = [first_exchange, lost_initial, authorization, lost_receipts,
             lost_application_report, rejected_name, reordered_snapshots, tamper_and_reflect,
             reboot, failed_commits, buffer_and_provider_failures,
             unavailable_randomness, exact_uint64, bounded_withholding, generated_schedule]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", required=True)
    parser.add_argument("--server", required=True)
    parser.add_argument("--seed", type=int, default=73821)
    parser.add_argument("--scenario", default="all")
    parser.add_argument("--replay")
    args = parser.parse_args()
    if args.replay:
        replay(args.replay, args.device, args.server)
        return
    selected = [s for s in SCENARIOS if args.scenario in ("all", s.__name__)]
    assert selected, f"unknown scenario: {args.scenario}"
    for scenario in selected:
        seeds = [args.seed, args.seed + 1, args.seed + 2] if scenario is generated_schedule else [args.seed]
        for seed in seeds:
            relay = Relay(args.device, args.server, seed)
            try:
                scenario(relay)
                print(f"PASS {scenario.__name__} seed={seed}", flush=True)
            except BaseException as error:
                relay.save(scenario.__name__ + f"-{seed}", error)
                raise
            finally:
                relay.close()


if __name__ == "__main__":
    main()
