# Simple Crypts

Simple Crypts is an open-source library and interactive demonstration of
authenticated device/server messaging. It provides a bounded-memory C core,
language bindings, and replaceable cryptography and storage providers. The
current example synchronizes server-issued and device-consumed credit totals
through an untrusted relay.

Try the [live browser demo](https://pseudodesign.github.io/simple-crypts/): follow
the guided exchange by dragging message boxes yourself, then try reflected,
reordered, replayed, or corrupted messages in the shared message log. The actual C
library and NaCl box run locally through WebAssembly. View the
[test evidence](https://pseudodesign.github.io/simple-crypts/report/) separately.
See [web build and browser tests](web/README.md) to run the demo locally.

The implementation uses a bounded C99 protocol core, nanopb, and NaCl box
(X25519/XSalsa20-Poly1305), with Ed25519 identities converted inside the provider. Python uses CFFI, Rust wraps the C ABI, and Go uses
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
enrollment packet and a requested credit snapshot, restarts the device, and
verifies that both endpoints agree on the reported totals. It does not connect to a network.

For a short example calling the SDK directly, read
[examples/python_api.py](examples/python_api.py) or run
`bazel run //examples:python_api`. It uses fresh identities and the production
library, with no test hooks.

For documented application projects, start with [examples/README.md](examples/README.md).
Run `bazel run //examples/fleet_manager:preview` for a browser-local fleet
database with interactive C++ WebAssembly device consoles. Type commands and
watch encrypted messages travel over the simulated link. Enrollment approval
remains explicit, and saved browser devices retain their identities.

## Application model

```text
server.set_credits_issued(100)
device.consume_credits(25)              # local durable update, no report
server.request_credit_status()          # capture a fresh snapshot on delivery

frame = endpoint.outbound(byte_budget)   # only on a transmission opportunity
peer.receive(frame)                     # whenever the relay actually delivers it
state = endpoint.inspect()
```

See [the C API](core/sc.h), [Python SDK](bindings/python/simplecrypts.py),
[Rust SDK](bindings/rust/src/lib.rs), and [Go SDK](bindings/go/simplecrypts.go).
Host SDKs own their native context and reference file store. Firmware uses the
caller-owned C context and supplies platform callbacks; it needs no filesystem,
heap, sockets, wall clock, or background thread in the protocol engine.

Devices hold an Ed25519 identity, their serial, and the server's pinned Ed25519
public key. Enable signed enrollment on both endpoints. The application's enrollment
authorization policy opens a session; the device verifies its signed challenge and sends
an encrypted response. Registration occurs only after explicit approval of the
exact serial/session/key binding. The protected reply confirms enrollment.
See [the enrollment and key-format contract](docs/protocol.md#enrollment).
Version 3 intentionally rejects earlier wire/store formats. Start with fresh
sample storage; existing identities and counters are never silently replaced.

The server owns cumulative credits issued; the device owns cumulative credits
consumed and refuses to overspend. Issuance also requests status. Local consumption
stays local until a new authenticated request captures a snapshot. Replayed grants
do not add credits, and retries preserve the captured response. Receipts acknowledge
snapshots without creating report loops.

Credits are a module built on [shared resource primitives](docs/resources.md):
typed owned values, monotonic totals, atomic groups, and requested snapshots.
Schemas generate bounded C descriptors, binding constants, and browser metadata.
There are no pings or keepalives. Envelopes remain bounded to 512 bytes; JSON and
base64 belong only to diagnostics and test adapters.

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
keys in a private file store. Platform integrations can replace it with a
provider appropriate to their key-protection requirements.
Counter storage must survive ordinary reboot and must not be rolled back or
cloned under an existing identity. Weak entropy cannot create a safe new key;
preprovisioned keys allow the protocol to use durable counters instead of fresh
random nonces.

The Cortex build supplies static resource evidence, not hardware qualification,
runtime peak RAM, timing, or a side-channel assessment. Libsodium documents
limitations for Cortex-M0/M3/M4 deployment; selecting a production backend and
qualifying a physical board remain separate work.
[Upstream MCU guidance](https://doc.libsodium.org/installation#cross-compiling-to-arm-microcontrollers).

Physical-board qualification, key rotation, production fleet services, and
telemetry history are outside the current implementation. The examples provide
a browser-local fleet registry for learning the application API.
The [design notes](PLAN.md) summarize architecture choices and historical
alternatives. [Embedded evaluation notes](MCU_FEASIBILITY.md) describe optional
platform integrations; the protocol documents define the implemented profile.

## C API reference and quality checks

Browse the [generated C API reference](https://pseudodesign.github.io/simple-crypts/api/)
for ownership, buffers, return codes, enrollment, credits, and provider contracts.
With clang-format/clang-tidy 18.1.3 and Doxygen 1.9.8 installed, run
`bazel test //tools:quality` and `bazel build //docs:api`.
See [C quality checks](docs/quality.md) for setup, formatting, analysis, and local HTML/XML output.
