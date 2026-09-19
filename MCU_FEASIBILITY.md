# Embedded platform evaluation notes

Simple Crypts separates its bounded C protocol engine from platform services.
An MCU or RTOS port is an optional integration, not a required deployment model.
The implemented interfaces are documented in [Platform integration](docs/platforms.md).
This document summarizes evaluation considerations and earlier alternatives;
it does not establish hardware qualification.

## Platform services

A platform supplies key-handle lookup, cryptographic operations, secure
randomness, atomic record storage, and durable nonce-range reservation.
Private keys remain behind provider handles. A hardware key slot must support
the selected cryptographic operations; generic ECDH support alone is insufficient.

Key confidentiality and resistance to storage rollback are platform properties.
Atomic record writes protect against partial updates but do not prevent an
attacker from restoring an older complete record. Counter reservations must
never overlap under the same key and direction, including after reboot.

## Randomness

Key generation requires cryptographically trustworthy randomness or trusted
secret seed material. Predictable serial numbers, clocks, public challenges,
and counters cannot supply missing secret entropy. Providers must report
unavailable randomness rather than silently substituting predictable bytes.

A securely seeded standard random generator may suit platforms without a
continuous hardware entropy source. Its initialization, state evolution, and
reboot behavior require platform-specific review. Health checks alone do not
establish unpredictability. The current core provides no entropy-repair fallback.

With established keys, the selected box profile uses durable counter nonces
rather than fresh random nonces. This does not remove randomness requirements
for key generation, fresh enrollment challenges, or provider-internal operations.

## Cryptographic alternatives

The selected profile is NaCl box, with Ed25519 identities converted to X25519
inside the provider. Earlier exploration considered authenticated HPKE suites
using P-256/AES-GCM or X25519/ChaCha20-Poly1305, and integration with OSCORE.
These alternatives are not implemented profiles. Their suitability depends on
available cryptographic hardware, key access, wire overhead, and measured memory
and execution cost.

Static-key box does not provide forward secrecy. Semantic routing metadata is
authenticated inside the encrypted body and checked against outer hints because
NaCl box has no separate associated-data input. The [protocol](docs/protocol.md)
defines nonce and replay handling for the implemented profile.

## Transport examples

Applications decide when to offer transmission and how many bytes are available.
The protocol requires no particular link speed, polling interval, or keepalive.

For an illustrative UART link using 8N1 framing, serialization time is
`10 * frame_bytes / baud_rate` seconds before additional transport overhead.
At an example rate of 115200 baud, a 512-byte envelope takes about 44.4 ms.
This is a transport calculation, not a device requirement or latency benchmark.
Cryptographic execution, scheduling, and delivery delays are separate costs.

## Resource evidence

The optional Cortex-M4 probe links the core, nanopb, and reference crypto provider.
It records linked sections, declared workspaces, and compiler stack-usage data.
The report identifies platform stubs separately. It does not measure runtime
peak RAM, interrupt/task stacks, latency, energy, or side-channel resistance.

A complete platform evaluation must include caller buffers, nested call stacks,
transport buffers, scheduler state, and crypto-provider scratch space. Individual
compiler stack entries cannot simply be summed into a peak-memory claim.
Libsodium documents limitations for Cortex-M deployment; see its
[MCU guidance](https://doc.libsodium.org/installation#cross-compiling-to-arm-microcontrollers).

Published measurements remain attributed to their tested source revision.
Changes to providers or build settings require new measurements before updating
those claims. See [publishing instructions](docs/publishing.md).
