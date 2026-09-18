# Simple Crypts: secure device state synchronization

> Historical design discussion. Milestone 1 selected a C99 core with Python,
> Rust, and Go bindings and standard NaCl box, superseding the HPKE/Rust-core
> candidates below. See [README.md](README.md) for the implementation and
> [docs/protocol.md](docs/protocol.md) for the current contract. The website and
> physical-board qualification are deferred to later milestones.

Proposed plan, researched September 18, 2026. This document describes work to implement; no library, protocol implementation, or deployment is claimed complete.

The demonstration should let someone rename a device, change its temperature, interfere with the relay, and see the two endpoints synchronize through a small application API. Its central claim is that applications can use asymmetric cryptography through a small, tested interface.

**Constraints agreed so far.** Devices are secure-booted microcontrollers, with the server's public key provisioned in advance. Each device has its own private key. A low-bandwidth serial link connects the device to an uncontrolled host that may read, alter, inject, duplicate, delay, reorder, or discard traffic. The host must not see message contents. Registration and initial data must work without a server round trip. Enrollment uses a one-time secret per serial number. C must support an MCU/RTOS from the beginning. Bazel builds the workspace, SDKs target C/Python/Rust/Go, and the project generates an interactive static site.

The serial link is 115200 baud, with intermittent server contact and no required pings or keepalives. Available MCU memory may be very small. Key protection stays behind an abstract keystore; raw entropy quality is not assumed. [MCU_FEASIBILITY.md](MCU_FEASIBILITY.md) defines the platform contracts, provisioned-seed option, algorithm/resource comparisons, and opportunistic transmission policy. Those details refine the initial implementation candidates below.

**Use a device twin as the application model.** AWS IoT shadows and Azure device twins separate server-owned desired properties from device-owned reported properties. Adopt that ownership model without depending on their cloud services, JSON wire formats, or MQTT transports. [AWS shadows](https://docs.aws.amazon.com/iot/latest/developerguide/iot-device-shadows.html), [Azure device twins](https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-device-twins)

| State | Authoritative writer | Example | Meaning at the other endpoint |
| --- | --- | --- | --- |
| Desired configuration | Server | `name = "Freezer 3"`, revision 12 | Configuration to validate and apply |
| Applied configuration | Device | `actual_name = "Freezer 3"`, applied revision 12 | Evidence that the device applied that configuration |
| Latest measurement | Device | `temperature_mC = -18250` | Last reported measurement; not necessarily current |
| Delivery receipt | Receiving endpoint | Received reported revision 84 | That revision was accepted, not a promise about later delivery |

Keep `desired_revision` and `reported_revision` independent. Server software serializes desired-state writes per device, using a transaction or compare-and-swap if multiple callers edit the same device. The host never becomes an authoritative writer. Do not use wall-clock timestamps to resolve competing writes, and do not introduce multi-writer conflict resolution for properties that already have clear owners.

**Begin with small, complete snapshots.** A desired snapshot contains all desired configuration. A reported snapshot contains the actual name, applied/processed desired revisions, application status, and latest temperature. A later snapshot completely replaces an earlier snapshot in the same stream. Missing revision 11 must not prevent revision 12 from being useful.

Do not attach one global revision to unrelated sparse patches and then discard all older patches: a newer temperature-only patch could otherwise cause a delayed name acknowledgment to disappear. AWS's ability to discard old state messages depends on their cumulative semantics. [AWS message ordering](https://docs.aws.amazon.com/iot/latest/developerguide/iot-device-shadows.html)

Add independent per-property revisions or patches with explicit base revisions only if measurements show snapshots cost too much. Define deletion explicitly using field presence or a reset operation; an absent patch field must not accidentally mean delete. Schema version and state revision are different values.

**Separate latest state from event history.** For v1, temperature means the latest known measurement, so an unsent newer report may replace an older one. If every sample later matters, add a separate bounded telemetry-event stream with sample IDs, batches, retention, and explicit overflow/gap reporting. Azure makes the same distinction between last-known properties and time-series telemetry. [Azure reported properties](https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-device-twins#reported-property-example)

**Protect messages at the endpoints.** The architecture is:

```text
MCU: state -> encode -> protect
                 |
          opaque serial frame
                 |
       uncontrolled host / queue
                 |
Server: unprotect -> validate -> update twin

Desired snapshots and authenticated receipts travel back the same way.
```

HTTPS between host and server may still be useful, but device security must not depend on the host's TLS connection. Every protected message must be independently processable; losing one packet must not break decryption of later packets. Do not introduce a required session handshake or a chained encrypted stream in v1.

**Crypto selection is an early feasibility decision.** The initial candidate is single-shot authenticated HPKE as specified in RFC 9180, using a fresh encryption context for each object. It can encrypt to the provisioned server public key and authenticate the device key without a round trip. Reverse messages authenticate the server to the device. This is authenticated encryption, not a third-party-verifiable digital signature. HPKE does not provide application replay protection. [RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html)

This is a correctness baseline to measure against an established static-key datagram construction that amortizes asymmetric work. Very small memory budgets may favor a compact C/provider backend. Keep the public interface independent of that selection, and do not substitute private-key export for an unsupported keystore operation.

Benchmark two suites before freezing one: P-256/HKDF-SHA-256/AES-128-GCM, and X25519/HKDF-SHA-256/ChaCha20-Poly1305. Their encapsulation-plus-tag overhead is respectively 81 and 48 bytes, before routing, framing, and enrollment fields. Actual MCU support, key storage, code size, execution cost, and baud rate decide the choice. V1 supports one fixed profile, with no algorithm negotiation or silent fallback. [RFC 9180 suite definitions](https://www.rfc-editor.org/rfc/rfc9180.html#section-7)

The Rust `hpke` library is a concrete candidate for a shared core: it exposes Auth mode, caller-supplied randomness, and nonallocating in-place operations. A C API can wrap a `no_std` static library. Validate a pinned version on the chosen MCU before committing to this dependency. Language bindings are accurately described as bindings; they are not independent cryptographic implementations. [Rust HPKE API](https://docs.rs/hpke/latest/hpke/)

Auth mode availability needs explicit checking: the newer IETF HPKE draft omits the RFC 9180 Auth modes. A dependency advertising “HPKE” is insufficient evidence that it implements the selected profile. The feasibility milestone must decide whether to pin RFC 9180 Auth or choose a different established construction and revise provisioning accordingly. Do not implement a missing cryptographic construction from scratch to preserve a preferred API. [IETF HPKE revision](https://datatracker.ietf.org/doc/html/draft-ietf-hpke-hpke-04)

OSCORE is another relevant reference: it provides object security for constrained CoAP applications across intermediaries. Revisit OSCORE if CoAP integration or packet-overhead measurements justify it; context establishment and reboot handling would still need a concrete design. [RFC 8613](https://www.rfc-editor.org/rfc/rfc8613.html)

**Enrollment is a self-contained claim.** Provision the MCU with its serial number, a high-entropy one-time enrollment secret, and the server public key through a trusted manufacturing/setup path. The uncontrolled host must never receive the plaintext enrollment secret. The device obtains its identity-key handle from the keystore before transmitting: that key may be provisioned externally or generated through trusted cryptographic randomness. The server holds the corresponding per-serial enrollment verifier and authorization status.

1. The device creates a reported snapshot containing its first useful data, and attaches an encrypted enrollment claim: serial, enrollment ID, enrollment secret, and device-key binding.
2. An outer header supplies the device public key needed to authenticate/decrypt that first packet. It is untrusted until cryptographic verification succeeds. A key fingerprint can replace the full key in later registered traffic.
3. The server authenticates/decrypts the packet, validates its fields, and checks that the secret authorizes this serial. Key possession and serial authorization are separate checks.
4. In one transaction, the server consumes the secret, records the serial-to-key association, and accepts the initial snapshot. A conflicting key cannot replace an existing association through ordinary enrollment.
5. The server returns a protected receipt bound to the enrollment ID and key identity, optionally carrying the latest desired configuration.
6. Until that receipt arrives, each new report can repeat the enrollment claim. Once the same association exists, these are idempotent authenticated reports, not attempts to consume the secret again. The first registration packet therefore need not be the first packet delivered.

An exact duplicate must not repeat a state change. It may cause a fresh receipt to be sent. A lost receipt leaves the device in an unconfirmed state while the server can already accept its data. Reenrollment after key loss requires a new authorized provisioning operation. The normal sample must not let a host request an identity reset.

**Proposed schema.** Use a small `.proto` schema with bounded fields, generated language types, and explicit validation. Nanopb is the C candidate because it supports fixed-size strings, bytes, and arrays. Binary protobuf is the wire representation; JSON is only a documentation/debug view. [Nanopb concepts](https://jpa.kapsi.fi/nanopb/docs/concepts.html)

```text
ProtectedEnvelope
  header_bytes       version, fixed profile, direction, key IDs;
                     device public key when enrollment is attached
  encapsulated_key
  ciphertext         includes authentication tag

EncryptedBody
  schema_version
  device_identity / key_generation
  optional enrollment_claim
  oneof:
    DesiredSnapshot  desired_revision, name
    ReportedSnapshot reported_revision, actual_name,
                     processed_desired_revision,
                     applied_desired_revision, apply_status,
                     temperature_mC, sample_metadata
    Receipt          acknowledged stream/revision or enrollment ID
```

The profile binds direction, protocol domain, identities, and the exact header bytes through HPKE context information and authenticated associated data. Reuse the original header bytes during verification. Protobuf serialization is not canonical, including when deterministic output is requested. After authentication, validate the decoded message before changing state. [Protobuf serialization](https://protobuf.dev/programming-guides/serialization-not-canonical/)

Reserve removed protobuf field numbers, distinguish unknown schema versions from unsupported message types, and fix maximum frame, string, and batch sizes. Use integer millidegrees Celsius to give all languages the same temperature representation. Keep 64-bit revisions exact in the browser with BigInt or decimal strings.

**Ordering, retries, and reboot behavior.** Persist the latest accepted revision for each owned state stream and key generation. An older complete snapshot cannot roll back state; an equal revision is a duplicate only if its contents agree. A future revision is accepted only after authentication and semantic validation. Authentication failure must never advance a revision.

The device records desired revision, resulting configuration, and apply status atomically before reporting success. Keep the highest processed desired revision even when a setting is rejected, while reporting the unchanged actual value and last successfully applied revision. A rejected update must not cause an older configuration to be applied later.

Use durable revision allocation on the device, with reserved counter ranges if needed to reduce flash wear. Crashes may skip revisions, but must not reuse one for different content. Keep the server's registry and revision state durable as well. Restoring an older database or rolling back MCU state needs an explicit recovery policy; ordinary reboot must not reset trust or replay state.

Coalesce pending state snapshots, bound local queues, and retransmit the latest snapshot with backoff when the application supplies a transmission opportunity and byte budget. No ping, heartbeat, or preliminary round trip is required. Piggyback acknowledgments and desired state on useful traffic where possible. Receipts can acknowledge state revisions cumulatively because each snapshot is complete. Distinguish sent, accepted, applied, and confirmed. Repeated transmission only converges if the relay eventually delivers sufficiently recent traffic in both directions.

Receipts bind the device identity, key generation, state stream, and acknowledged revision. Track acknowledgment progress monotonically and reject acknowledgments for revisions never issued. Replaying an older receipt must not clear a newer pending snapshot or move confirmation backward.

**Freshness has a limit.** An authentic packet can still have been withheld. Name changes are persistent desired state, so eventual application is appropriate. Display temperature as last reported, with server receipt time distinct from any device sample time and clock-quality indicator. Without trusted time or a fresh challenge exchange, do not claim an upper bound on sample age or execute commands that require one. Integrity and relative ordering do not establish absolute freshness. [OSCORE freshness](https://www.rfc-editor.org/rfc/rfc8613.html#section-7.3), [CoAP freshness](https://www.rfc-editor.org/rfc/rfc9175.html#section-2)

**Serial transport.** Put a bounded binary envelope inside a delimiter-based framing format such as COBS. Validate frame length before expensive work and recover cleanly from truncated/concatenated frames. A checksum, if used, is only an early transmission-error check; authenticated encryption decides authenticity. Avoid base64 on the serial link. Add fragmentation only after measuring actual frame-size requirements.

**Embedded boundary.** Platform providers supply key operations, cryptographic randomness, durable storage, frame I/O, and scheduling. Raw entropy is separate from the protocol's randomness interface: a trusted provisioned seed and safe generator-state evolution may support operation despite poor local entropy. No sockets, filesystem, wall clock, heap, or OS RNG are assumed in the portable MCU core. Buffer ownership and maximum sizes are explicit. Failure to obtain required cryptographic randomness, authenticate a message, or commit required state fails the operation; it never activates weaker behavior. A shared context has one owner unless an RTOS adapter supplies synchronization.

Secure boot is an assumption about firmware authorization, not automatic protection against private-key extraction, storage rollback, or evidence of remote attestation. Document the selected board's actual key-storage and rollback properties. A Rust wrapper does not automatically support nonexportable hardware key handles; that capability must be verified if required.

The proposed HPKE profile does not promise forward secrecy after recipient-key compromise; recipient compromise can also undermine sender authentication. No protocol can force relay delivery. Ciphertext length, timing, and required routing identifiers remain visible to the host. [RFC 9180 security properties](https://www.rfc-editor.org/rfc/rfc9180.html#section-9)

**Libraries and reference programs.** Keep cryptography, synchronization, and transport as separate layers so the visible API speaks in state updates.

| Target | Initial implementation | Both roles |
| --- | --- | --- |
| Rust | Shared protocol/crypto core; MCU-compatible configuration | Produce and consume desired/reported snapshots |
| C | Bounded C ABI, nanopb types, MCU platform adapter | Device firmware and a host-side server-role harness |
| Python | Idiomatic binding and generated schema types | Tutorial programs and readable reference server |
| Go | Idiomatic binding initially | Relay/server examples; independent crypto adapter for interop |
| Browser | WASM build of the tested core | Local simulated device and server, real protected packets |

Use Go CIRCL as an independent HPKE interoperability candidate after it passes the pinned RFC vectors; its API exposes authenticated setup. A four-language wrapper matrix alone is not four independent checks of the cryptography. [CIRCL HPKE](https://pkg.go.dev/github.com/cloudflare/circl/hpke)

The application-facing shape should be approximately:

```text
server.set_desired(device_id, Name("Freezer 3"))
device.report_temperature_mC(-18250)
endpoint.next_outbound(output_buffer)
endpoint.receive(input_frame)
```

These are proposed operations, not code that already exists. Examples must show initialization, storage/entropy adapters, and error handling as well as the small happy path. Do not expose raw-key arithmetic or nonce management in the tutorial API.

**Bazel workspace.** Use `MODULE.bazel`, a pinned Bazel release, committed lockfiles, declared code generators, and pinned toolchains. Start with `rules_cc`, `rules_rust`, `rules_python`, and `rules_go`; add the static-site toolchain as a build target. Keep dependency resolution separate from build actions. The RTOS integration must pin its SDK/modules and make inputs explicit, rather than downloading them inside a build. [Bazel dependencies](https://bazel.build/external/overview)

```text
schema/                 protobuf definitions and embedded bounds
core/                   protected envelopes and state reconciliation
bindings/{c,python,go}/  language APIs; Rust API lives with core
platforms/              MCU/RTOS, entropy, storage, framing adapters
server/                 reference registry and desired/reported store
relay/                  opaque serial relay and fault injection
examples/               runnable device/server tutorials
tests/{vectors,interop,faults}/
docs/                   quickstart, protocol, guarantees, measured limits
site/                   interactive demo and generated documentation
tools/                  schema/site/measurement build support
```

Planned top-level commands are `bazel test //...`, `bazel run //examples:demo`, and `bazel build //site:dist`. These targets will be introduced during implementation; they do not exist yet. Separate named targets build and run the selected MCU image.

**Interactive site.** The final static site has three actors: device, hostile relay, and server. Users edit a desired name and a device temperature, then drop, delay, reorder, corrupt, duplicate, and replay packets. Show the device's actual state beside the server's last-known state, with pending/applied status. Let users inspect payloads at endpoints and see only opaque bytes at the relay. An explicit teaching view may reveal both endpoints' data, but that is not information available to the modeled host.

Run the actual tested core in the browser using disposable local keys. A static page simulates both endpoints locally; it is not a hosted production server or a separate security boundary. Include language examples extracted from runnable examples, links to tests behind each behavior, and measured byte counts. A baud-rate control estimates serialization time using the selected UART framing; report crypto and framing overhead separately.

Build a static artifact with Bazel and publish through a GitHub Pages workflow when repository/hosting setup is available. Publishing is a later implementation step. GitHub Pages supports custom build artifacts through Actions. [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

**Implementation order and acceptance gates.**

| Milestone | Deliverable | Completion evidence |
| --- | --- | --- |
| 0. Target and crypto feasibility | Select MCU/RTOS, baud rate, frame/memory budgets, key-storage model, fixed crypto profile | Cross-compiled endpoint crypto round trip; pinned reference vectors; recorded flash/RAM/stack/latency/packet sizes |
| 1. First useful exchange | C MCU example, Python server, hostile relay, enrollment plus first reported snapshot | No server reply needed before first data; dropped enrollment frame and lost receipt both recover |
| 2. State synchronization | Desired name, applied acknowledgment, latest temperature, persistence | Duplicates/reordering/reboots do not roll back state; eventual delivery converges; withheld traffic remains visibly unconfirmed |
| 3. Language support | C/Python/Rust/Go SDKs and independent crypto comparison | Every sender/receiver pairing handles common fixtures, failures, and schema boundaries |
| 4. Pitch and documentation | Real browser crypto, interactive relay, static site, runnable tutorials | Site behavior matches integration tests; one-command local demo and reproducible site build |

Keep a named MCU target in CI from milestone 0. Emulator tests establish reproducible firmware execution; actual board measurements establish hardware claims. Set budgets from the selected board and measured first slice, then enforce regressions. Avoid inventing flash, RAM, or throughput figures in advance.

**Tests that substantiate the pitch.**

- Published crypto vectors and an independent implementation agree; modified ciphertext, headers, direction, keys, and encapsulation are rejected.
- A stolen serial alone cannot enroll; conflicting keys and reused enrollment authorizations cannot take over a device.
- Initial data works when the first packet is lost; duplicate claims and lost receipts do not duplicate registration or state changes.
- Latest complete snapshots survive arbitrary finite loss/reordering; older valid snapshots never revert newer state.
- A desired write is not shown as applied until the device reports the matching result; rejected names produce a stable error acknowledgment.
- Crash injection covers revision allocation, identity persistence, enrollment commit, configuration commit, and receipt creation.
- Entropy/storage failures, malformed protobuf, oversize frames, partial serial frames, and queue exhaustion remain bounded and recoverable.
- Browser counters preserve 64-bit values, queues remain bounded, and the demo never uses fixed test keys in MCU builds.
- Property-based state tests show convergence under eventual delivery and make no delivery/freshness promise under indefinite suppression.

The first implementation should end with a short reproducible story: enroll and send temperature; set a name; drop its first update; deliver a newer snapshot; replay the old one; observe the correct name and an authenticated report. That story becomes the README example, integration test, MCU demonstration, and interactive page. Include a variant with failed local entropy and a trusted provisioned generator seed, and a variant with no trusted seed that correctly refuses new encryption.
