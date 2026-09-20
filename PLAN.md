# Project design notes

Simple Crypts explores authenticated device/server state synchronization through
an untrusted relay. Its public APIs separate application state, message delivery,
and platform services. The [README](README.md) describes the implementation;
[the protocol specification](docs/protocol.md) defines the current wire contract.

## Design goals

- Provide a bounded-memory C99 engine with C, Python, Rust, and Go interfaces.
- Authenticate messages at the endpoints, independently of the transport.
- Make duplicate, reordered, delayed, and corrupted messages observable and testable.
- Keep transmission explicit: applications supply opportunities and byte budgets.
- Demonstrate the protocol with real library calls in an interactive static site.

Serial links, queued gateways, and other intermittent transports are possible
integrations. No particular baud rate, operating system, boot mechanism, or
hardware configuration is required by the protocol. Platform implementations
supply key access, cryptography, randomness, and durable storage.

## State model

The current example uses server-issued and device-consumed credit totals.
Each field has one authoritative writer. A generic resource layer provides
bounded types, monotonic values, atomic groups, and requested snapshots.
Consumption is persisted locally; only explicit requests capture reports.
See [shared resources](docs/resources.md) for the implemented contract.

The application supplies enrollment authorization policy. Signed enrollment
binds approval to an exact serial, session challenge, and public key. A valid
cryptographic response stages a candidate; it does not independently authorize
registration. The [protocol](docs/protocol.md#enrollment) documents the sequence.

## Architecture choices

The implementation uses nanopb for bounded protobuf encoding and standard NaCl
box with Ed25519 identities converted inside the crypto provider. Python, Rust,
and Go bind to the same C engine. Cross-language tests exercise API and wire
compatibility; an independent Go implementation checks NaCl interoperability.

Earlier design exploration considered a Rust core, authenticated HPKE, and
OSCORE. These remain historical alternatives, not implemented profiles or
current requirements. The current implementation has one fixed cryptographic
profile and no algorithm negotiation. Static-key NaCl box does not provide
forward secrecy; see the [provider documentation](providers/host/README.md).

The initial token-authorized enrollment example is retained for explicit legacy
callers and tests. The browser demo uses signed server challenges and explicit
application approval. Earlier assumptions about enrollment without a server
round trip do not define the current signed-enrollment flow.

## Evaluation and extensions

The [test harness](docs/testing.md) covers all sixteen language pairings and
reproducible relay schedules. The [browser demo](web/README.md) exposes messages,
endpoint state, and library results. The [MCU evaluation notes](MCU_FEASIBILITY.md)
describe optional platform measurements and their limits.

The application examples now include a browser-local multi-device registry,
interactive C++ WebAssembly consoles, action-driven message exchange, and saved
identities. Enrollment approval remains an explicit application action. Key rotation, event history, and production fleet services
remain possible extensions. Future application
models should preserve explicit ownership, bounded storage, and authenticated
state transitions without changing the transport boundary.
