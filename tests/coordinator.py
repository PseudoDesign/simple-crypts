"""Deterministic hostile relay. Only the JSONL control channel uses base64.

No sockets, sleeps, background delivery, or wall-clock protocol decisions.
The readline deadline detects a broken adapter; it does not schedule traffic.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile


DEVICE_SEED = "11" * 32
SERVER_SEED = "22" * 32
SECRET = "33" * 32
SERIAL = "mcu-0001"


def resolve(path: str) -> str:
    p = Path(path)
    if p.exists():
        return str(p.absolute())
    root = os.environ.get("RUNFILES_DIR") or os.environ.get("TEST_SRCDIR")
    if root:
        for candidate in (Path(root) / path, Path(root) / "_main" / path):
            if candidate.exists():
                return str(candidate)
    raise FileNotFoundError(path)


class Endpoint:
    def __init__(self, relay, name, executable, config):
        self.relay, self.name, self.executable = relay, name, executable
        self.config = dict(config)
        self.process = None
        self.log = None
        self.start()

    def start(self):
        self.log = open(self.relay.directory / (self.name + ".stderr"), "a+")
        self.process = subprocess.Popen(
            [self.executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self.log, text=True, bufsize=1,
        )

    def command(self, command: str, **arguments):
        request = {"command": command, **arguments}
        p = self.process
        assert p is not None and p.poll() is None, f"{self.name} exited"
        p.stdin.write(json.dumps(request, ensure_ascii=True) + "\n")
        p.stdin.flush()
        with selectors.DefaultSelector() as sel:
            sel.register(p.stdout, selectors.EVENT_READ)
            assert sel.select(20), f"{self.name}: adapter did not reply to {command}"
        line = p.stdout.readline()
        if not line:
            self.log.flush()
            raise AssertionError(f"{self.name}: closed stdout; see {self.log.name}")
        try:
            response = json.loads(line)
        except ValueError as exc:
            raise AssertionError(f"{self.name}: non-JSON stdout {line!r}") from exc
        self.relay.events.append({"action": "command", "endpoint": self.name,
                                  "request": request, "response": response})
        assert isinstance(response, dict) and isinstance(response.get("status"), str), response
        return response

    def ok(self, command, **arguments):
        response = self.command(command, **arguments)
        assert response["status"] == "ok", (self.name, command, response)
        return response

    def state(self):
        return self.ok("state")["state"]

    def kill(self):
        if self.process is not None:
            if self.process.poll() is None:
                self.process.kill()
            self.process.wait(timeout=20)
            self.process.stdin.close()
            self.process.stdout.close()
            self.log.close()
            self.process = None


class Relay:
    def __init__(self, device, server, seed=0, directory=None):
        self.executables = {"device": resolve(device), "server": resolve(server)}
        self.seed = seed
        self.temp = tempfile.TemporaryDirectory(prefix="simple-crypts-", dir=directory)
        self.directory = Path(self.temp.name)
        self.endpoints = {}
        self.queue = {}
        self.events = []
        self.time = 0
        self.next_frame = 0
        self.nonces = {}

    def spawn(self, name, role, **overrides):
        config = {"role": role, "storage": str(self.directory / name),
                  "serial": SERIAL, "secret": SECRET,
                  "key_seed": DEVICE_SEED if role == "device" else SERVER_SEED,
                  "server_seed": SERVER_SEED}
        config.update(overrides)
        self.events.append({"action": "spawn", "endpoint": name,
                            "role": role, "config": config})
        endpoint = Endpoint(self, name, self.executables[role], config)
        self.endpoints[name] = endpoint
        return endpoint, endpoint.command("init", **config)

    def pair(self, **device_overrides):
        d, dr = self.spawn("device", "device", **device_overrides)
        s, sr = self.spawn("server", "server")
        assert dr["status"] == sr["status"] == "ok", (dr, sr)
        return d, s

    def opportunity(self, sender, budget=512, capacity=512):
        response = self.endpoints[sender].command("tx", budget=budget, capacity=capacity)
        if response["status"] == "idle":
            assert not response.get("frame"), response
            return None
        assert response["status"] == "ok", response
        frame = base64.b64decode(response["frame"], validate=True)
        assert 0 < len(frame) <= min(512, budget, capacity), len(frame)
        assert frame[:4] == b"SC\x01\x01" and len(frame) >= 78, frame.hex()
        assert frame[4] in (1, 2) and frame[38] == frame[4]
        domain_nonce = (frame[6:38], frame[38:62])
        previous = self.nonces.get(domain_nonce)
        assert previous is None or previous == frame, "nonce reused for different ciphertext"
        self.nonces[domain_nonce] = frame
        identifier = str(self.next_frame)
        self.next_frame += 1
        self.queue[identifier] = frame
        self.events.append({"action": "queue", "frame_id": identifier,
                            "sender": sender, "frame": response["frame"]})
        return identifier

    def deliver(self, identifier, receiver):
        assert identifier is not None, "expected pending outbound frame"
        self.events.append({"action": "deliver", "frame_id": identifier, "receiver": receiver})
        # Delivery does not remove a frame: keeping an opaque copy models replay.
        return self.endpoints[receiver].command(
            "rx", frame=base64.b64encode(self.queue[identifier]).decode("ascii"))

    def exchange(self, sender, receiver):
        identifier = self.opportunity(sender)
        assert identifier is not None
        response = self.deliver(identifier, receiver)
        assert response["status"] in ("ok", "duplicate", "stale"), response
        return identifier

    def drop(self, identifier):
        self.events.append({"action": "drop", "frame_id": identifier})
        self.queue.pop(identifier)

    def mutate(self, identifier, offset=0, mask=1):
        frame = bytearray(self.queue[identifier])
        frame[offset] ^= mask
        new_id = str(self.next_frame)
        self.next_frame += 1
        self.queue[new_id] = bytes(frame)
        self.events.append({"action": "mutate", "source": identifier,
                            "frame_id": new_id, "offset": offset, "mask": mask})
        return new_id

    def advance(self, ticks):
        assert ticks >= 0
        self.time += ticks
        self.events.append({"action": "advance", "ticks": ticks, "time": self.time})

    def restart(self, name):
        endpoint = self.endpoints[name]
        self.events.append({"action": "restart", "endpoint": name})
        endpoint.kill()
        endpoint.start()
        return endpoint.ok("init", **endpoint.config)

    def save(self, name, error=None):
        directory = Path(os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR") or
                         tempfile.mkdtemp(prefix="simple-crypts-replay-"))
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / (name + ".json")
        content = {"format": 1, "seed": self.seed, "scenario": name,
                   "error": str(error) if error else None, "events": self.events}
        path.write_text(json.dumps(content, indent=2, ensure_ascii=True) + "\n")
        for endpoint in self.endpoints.values():
            if endpoint.log and not endpoint.log.closed:
                endpoint.log.flush()
            source = self.directory / (endpoint.name + ".stderr")
            if source.exists() and source.parent != directory:
                (directory / (name + "-" + source.name)).write_bytes(source.read_bytes())
        print(f"Replay transcript: {path}", flush=True)
        return path

    def close(self):
        for endpoint in self.endpoints.values():
            endpoint.kill()
        self.temp.cleanup()


def replay(path, device, server):
    """Replay exact commands and public responses, remapping only storage paths."""
    transcript = json.loads(Path(path).read_text())
    relay = Relay(device, server, transcript["seed"])
    try:
        for event in transcript["events"]:
            action = event["action"]
            if action == "spawn":
                config = dict(event["config"])
                config["storage"] = str(relay.directory / event["endpoint"])
                role = event["role"]
                endpoint = Endpoint(relay, event["endpoint"], relay.executables[role], config)
                relay.endpoints[event["endpoint"]] = endpoint
            elif action == "restart":
                endpoint = relay.endpoints[event["endpoint"]]
                endpoint.kill()
                endpoint.start()
            elif action == "command":
                endpoint = relay.endpoints[event["endpoint"]]
                request = dict(event["request"])
                if request["command"] == "init":
                    request["storage"] = endpoint.config["storage"]
                command = request.pop("command")
                actual = endpoint.command(command, **request)
                assert actual == event["response"], (event, actual)
        print(f"Replayed {len(transcript['events'])} recorded actions (seed {relay.seed})")
    finally:
        relay.close()
