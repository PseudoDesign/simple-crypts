# Platform integration

The embedded entry point is `core/sc.h`. Allocate `sc_context`, configuration,
provider state, and bounded input/output buffers in caller-owned memory.
Initialize the context and call it from one owner, or provide external
synchronization. The core is C99 and does not allocate heap memory.

## Provider contracts

| Interface | Required behavior |
| --- | --- |
| Keystore / public key | Resolve an opaque key handle; reveal only its public key to the core. |
| Crypto seal/open | Use the fixed NaCl box profile, with the handle and peer public key. Authenticate before publishing plaintext to application logic. |
| Randomness | Return cryptographically trustworthy random bytes or an error. Never substitute serials, clocks, counters, or predictable sensor samples for entropy. |
| Enrollment secret (legacy mode) | Retrieve the authorization secret inside the endpoint boundary; unused by signed enrollment. |
| Durable load | Return a bounded complete record and its generation, or an explicit not-found result. |
| Durable commit | Atomically compare the expected generation and replace the entire record. A failure must not expose a partially applied record. |
| Durable reserve | Persistently burn a nonoverlapping counter range before returning it. Scope the namespace to key identity and direction. |

The keystore interface supports hardware key slots, secure-world
software, or protected external storage. A hardware backend must implement
the actual selected cryptographic operation; a generic ECDH-capable key slot
does not by itself provide NaCl box. The reference libsodium backend is a
software implementation, useful for testing the interface.

Strong initial key material is indispensable. Keys may be provisioned through
a trusted process, or generated from a provider that guarantees suitable
cryptographic randomness. Raw entropy health testing and a correctly seeded
standard DRBG belong to that provider. The core cannot detect a provider that
silently labels predictable bytes as trustworthy. There is no entropy-repair
fallback in this library.

Once keys are provisioned, encryption uses durable counter nonces and needs no
per-message randomness. The host reference's injected `random_unavailable`
condition exercises this provider boundary; ordinary libsodium initialization
still initializes its OS RNG. That host test is not a qualification of a board
with no hardware entropy.

The host store uses a private directory, an exclusive process lock, a temporary
file, file synchronization, atomic rename, and directory synchronization.
It fails closed after an ambiguous rename/durability result. It holds a
software private key, provisioning secret, counter reservations, and a bounded
protocol record. Its checksum detects accidental corruption, not malicious
rollback or rewriting by an attacker who controls the endpoint's storage.
The on-disk reference format is local to the host ABI, not a portable backup
or fleet database format.

Keep the server and device stores outside the relay's authority. Platform
implementations must protect private-key confidentiality and prevent rollback
or cloning of counters under an existing identity. Atomic writes alone do not
establish these properties.

## Memory evidence

The Cortex-M4 resource target cross-links the protocol core, nanopb and
libsodium cryptographic provider into a probe. It retains encryption and
decryption code and emits a linked image, section sizes, a map, and compiler
stack-usage evidence. Platform stubs are identified separately. They are
build-only substitutes for persistent storage, provisioning, and scheduling.

The declared core context and provider workspaces are not the total peak RAM.
Also account for caller frames, active call chains, interrupt stacks, UART/DMA
buffers, RTOS objects, and hardware-provider scratch. GCC `.su` entries report
individual compiler stack frames; adding the largest entries is not a valid
whole-program peak-memory measurement. Physical timing and stack high-water
measurements remain board qualification work.

This milestone measures one backend; it does not claim libsodium is the
smallest or a qualified production MCU implementation. Its own documentation
states Cortex-M qualification limitations. Preserve the platform interface
while selecting and validating a board-specific provider later.
