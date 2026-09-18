# Simple Crypts

A sample device/server library for encrypted state synchronization through an
untrusted, intermittently connected relay. The device reports its temperature;
the server requests a name. Applications work with state and opaque frames.

View the [published test report](https://pseudodesign.github.io/simple-crypts/)
for the language matrix, scenario logs, and MCU resource evidence.

Milestone 1 uses a bounded C99 protocol core, nanopb, and NaCl box
(X25519/XSalsa20-Poly1305). Python uses CFFI, Rust wraps the C ABI, and Go uses
cgo. Each SDK supports both roles. A server context represents one serial
number; a fleet service supplies the registry and routes frames to contexts.

## Build and run

The build targets Linux x86-64. Install Bazel 9.2.0, a C compiler and binutils,
Python 3.12, GNU Make, and the Arm GNU bare-metal toolchain. Pinned dependency
sources are included; `tools/bootstrap.py` installs the pinned Go, Rust,
protobuf, and Python tools used by Bazel. Downloads happen during bootstrap,
not during tests.

```sh
python3 tools/bootstrap.py
bazel test //...
bazel run //examples:device_server_demo
bazel build //platforms/cortex_m4:resource_report
```

The demo runs a C device and a Python server as separate processes, drops an
enrollment packet and an application report, restarts the device, and verifies
that the latest snapshots converge. It does not connect to a network.

For a short example calling the SDK directly, read
[examples/python_api.py](examples/python_api.py) or run
`bazel run //examples:python_api`. It uses fresh identities and the production
library, with no test hooks.

## Application model

```text
device.report(temperature_mC)
server.name("Freezer 3")

frame = endpoint.outbound(byte_budget)   # only on a transmission opportunity
peer.receive(frame)                     # whenever the relay actually delivers it
state = endpoint.inspect()
```

See [the C API](core/sc.h), [Python SDK](bindings/python/simplecrypts.py),
[Rust SDK](bindings/rust/src/lib.rs), and [Go SDK](bindings/go/simplecrypts.go).
Host SDKs own their native context and reference file store. Firmware uses the
caller-owned C context and supplies platform callbacks; it needs no filesystem,
heap, sockets, wall clock, or background thread in the protocol engine.

Provision each device with a unique identity key, the server's **public** key,
its serial number, and a high-entropy enrollment secret. Supply that secret to
the server through a trusted provisioning path. The device's first report
contains its encrypted enrollment claim; no server round trip is necessary.

The server's requested name remains pending until an authenticated device
report says it was processed. Temperature is latest state, not an event log.
Snapshots coalesce while communication is withheld. Delivery opportunities are
explicit; there are no pings or keepalives. The wire is binary, bounded to 512
bytes per envelope. Base64 and JSON are used only by the test adapters.

## What the tests establish

- Sixteen named device/server language pairings exercise both directions with
  the same fault scenarios, including kill/restart against the existing store.
- Durable commits, nonce reservation, replay ordering, enrollment authorization,
  buffer bounds, provider failures, and exact 64-bit revisions are exercised.
- Published NaCl vectors and independent Go box operations check cryptographic
  compatibility in both directions. The four SDKs intentionally share one core.
- Parser fuzz smoke tests and sanitizer builds check project-owned C code.
- The Cortex-M4 report links the core and libsodium provider and records code,
  static RAM, declared workspaces, and compiler stack-usage information.

[Testing and replay](docs/testing.md) explains the harness and failure artifacts.
[Publishing the report](docs/publishing.md) explains how to refresh Pages from a tested commit.
[The protocol](docs/protocol.md) specifies the frame and state rules.
[Platform integration](docs/platforms.md) states the keystore, entropy, and
durability contracts.

## Scope

The host provider is an inspectable reference implementation, with software
keys in a private file store. It is not the hypothetical protected MCU keystore.
Counter storage must survive ordinary reboot and must not be rolled back or
cloned under an existing identity. Weak entropy cannot create a safe new key;
preprovisioned keys allow the protocol to use durable counters instead of fresh
random nonces.

The Cortex build supplies static resource evidence, not hardware qualification,
runtime peak RAM, timing, or a side-channel assessment. Libsodium documents
limitations for Cortex-M0/M3/M4 deployment; selecting a production backend and
qualifying a physical board remain separate work.
[Upstream MCU guidance](https://doc.libsodium.org/installation#cross-compiling-to-arm-microcontrollers).

An interactive GitHub Pages demonstration, physical-board qualification, key
rotation, fleet registry integration, and telemetry history are later milestones.
The earlier [planning notes](PLAN.md) and [MCU feasibility discussion](MCU_FEASIBILITY.md)
retain the alternatives considered; the implementation and protocol documents
define this milestone's selected profile.
