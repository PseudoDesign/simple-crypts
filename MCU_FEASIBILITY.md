# MCU platform contract and feasibility choices

> These are the earlier feasibility alternatives. Milestone 1 implements the
> C99/NaCl box profile. [docs/platforms.md](docs/platforms.md) describes the
> implemented provider boundary and the Cortex-M4 resource target. Numeric
> estimates below remain comparisons, not measurements of this implementation.

Design update, September 18, 2026. Keystore protection and entropy-source internals remain abstract. UART is 115200 baud; server contact is intermittent. Memory may be very small. These are interface contracts and proposed measurements, not implemented APIs or measured application limits.

**Separate four platform services.** Key storage, cryptographic operations, cryptographic randomness, and durable state have different responsibilities. A good keystore does not by itself establish a good entropy source or power-safe counters.

The following is language-neutral interface notation. C bindings will use status codes, opaque handles, explicit lengths, caller-owned buffers, and provider context pointers.

```text
KeyStore.open(slot, required_usage) -> Result<KeyHandle>
KeyStore.public_key(key, output_buffer) -> Result<length>

Crypto.require_profile(profile, key) -> Result<ResourceRequirements>
Crypto.protect(key, peer_public_key, context, inout_buffer,
               random_source, scratch_buffer) -> Result<ProtectedObject>
Crypto.unprotect(key, peer_public_key, context, protected_object,
                 inout_buffer, random_source,
                 scratch_buffer) -> Result<plaintext_length>

Random.fill(purpose, output_buffer) -> Result

DurableState.load(record_id, output_buffer) -> Result<generation, length>
DurableState.commit(record_id, expected_generation, record) -> Result
DurableState.reserve_ids(domain, count) -> Result<first, limit>
```

`ProtectedObject` contains lengths/views into caller-owned storage for the profile-specific auxiliary fields (HPKE encapsulation or a box nonce) and ciphertext/tag; it does not allocate. `context` includes the selected fixed profile, protocol domain, direction, and exact authenticated header bytes. It is assembled by the protocol implementation and bound through the profile's defined authenticated representation. `ResourceRequirements` declares buffer sizes, alignment, required key operations, and provider workspace; measured call-stack requirements are documented separately.

The receive-side random source is available for providers that require blinding or other internal randomness; decryption does not automatically consume entropy when its provider does not need it. Authentication failure returns no plaintext length, and the provider clears any provisional plaintext before returning. Unsupported profiles, insufficient buffers, invalid peer keys, authentication failure, randomness unavailability, and storage failure have distinct local status codes; these need not be exposed to the relay.

If the selected profile uses counter-based nonces, its crypto provider is configured with `DurableState` and reserves the relevant nonce range before encryption. The protocol does not silently reuse application revision numbers as nonces. Retries either resend an identical protected object or invoke protection with a newly allocated nonce/context.

**Keystore contract.**

- A handle names a provisioned identity key and its permitted uses; it is not a public key, wire identity, or serializable secret. Opening a slot does not silently generate or replace its key.
- Identity keys may be provisioned externally or generated through an explicit provisioning operation backed by trusted randomness. Runtime enrollment obtains the existing key handle.
- Private-key export is not part of the application contract. Public-key export uses the fixed profile's canonical encoding.
- `Crypto` operates on handles through the selected provider. It may delegate key agreement and derivation into a hardware keystore. Unsupported operations produce an error, never an automatic private-key export or downgrade.
- Returning raw ECDH output is not needed at the application boundary. The provider performs the chosen established construction; applications do not assemble ECDH, HKDF, and AEAD themselves.
- A software implementation may hold private material inside its provider. Wrapping a raw scalar in a handle does not demonstrate support for a nonexportable hardware key. Check the actual library's operation boundary before selecting it.
- Enrollment secrets and DRBG seeds use separate protected slots/policies. Provisioning owns their access; the public application API cannot dump them. The enrollment implementation obtains its claim through an authorized provider path and encrypts it before serial transmission.

This follows PSA's operation/usage-based treatment of keys. PSA also distinguishes raw key agreement output from derivation into further key material. [PSA key policies](https://arm-software.github.io/psa-api/crypto/1.2/api/keys/policy.html), [PSA key agreement](https://arm-software.github.io/psa-api/crypto/1.2/api/ops/ka.html)

**Randomness contract and poor local entropy.** `Random.fill` supplies cryptographically unpredictable bytes at the selected profile's required strength or returns `NOT_READY`/`RANDOM_UNAVAILABLE`. No partial successful result is exposed. Its purpose identifier separates provider uses such as ephemeral-key generation from other random material; this is not an instruction to design a new random generator.

An optional raw entropy source is private to the random provider. Its interface can be `collect(buffer) -> samples/status`; deployment configuration establishes any justified entropy estimate. Raw bytes never go directly into protocol key generation. Health checks can identify some failures, but passing a statistical test does not establish unpredictability. [NIST SP 800-90B](https://csrc.nist.gov/pubs/sp/800/90/b/final)

For a device with poor runtime entropy, the proposed fallback is trusted provisioning of a device-unique random seed and a standard DRBG, separate from the identity key and enrollment token. HMAC-DRBG/SHA-256 is a candidate when SHA-256/HMAC are already present. A correctly initialized DRBG can expand a secret seed; hashing a predictable serial number, timestamp, host input, or weak noise cannot create the missing secret. [NIST SP 800-90A](https://csrc.nist.gov/pubs/sp/800/90/a/r1/final)

The random provider must also prevent output repetition after reboot. Two implementation paths to evaluate are power-safe advancement of protected generator state, or a reviewed derivation from a secret root and nonrepeating durable epochs. The latter needs an explicit construction; adding a counter is not automatically a conforming DRBG instantiation or fresh reseeding. Never restart the same generator from the same seed and initial state on every boot. NIST's RBG constructions are a reference for the provisioning/state design, not a claim of certification. [NIST SP 800-90C](https://csrc.nist.gov/pubs/sp/800/90/c/final)

There are three distinct outcomes:

| Available trust | Behavior |
| --- | --- |
| Adequate live entropy | Initialize/use the CSPRNG; propagate failures |
| Trusted provisioned seed and safe generator-state evolution | Operate despite weak/unavailable local noise, within generator usage limits |
| Neither | Do not create new keys or new protected objects requiring randomness |

Exact cached ciphertext may still be retransmitted when randomness is unavailable. Its contents cannot change. Poor optional local noise must not replace good secret generator state. Without fresh trusted entropy, do not promise recovery after that state is compromised. Hardware operations may require randomness for blinding even when the wire protocol has no random nonce; account for the provider's requirements too.

**Durable state contract.** `reserve_ids` commits the exclusive upper bound before returning a usable range. Ranges never overlap for the same domain, including after torn writes, power cuts, or resets; exhaustion returns an error. Domains include identity/key generation, direction, and purpose. Revision counters, random-generator epochs, and any nonce counters are separate namespaces. A counter supplies uniqueness, not entropy.

`commit` is an atomic compare-and-replace operation for a bounded record. Store the applied name, desired revision, and application result together. Reserve outgoing revision ranges to reduce flash writes; unused IDs may be skipped after reboot. Fresh temperature samples need not each be committed to flash when only latest state is required. Protection against malicious storage rollback is an additional provider requirement, not something implied by atomic writes or secure boot. [OSCORE counter reservation](https://www.rfc-editor.org/rfc/rfc8613.html#appendix-B.1.1)

**Algorithm and construction tradeoffs.** Keep one fixed profile in a device build. The existing single-shot HPKE candidate is a baseline for comparison, not a decision that every tiny MCU must implement it.

| Candidate | Wire overhead beyond plaintext | Resource advantages | Costs and limits |
| --- | --- | --- | --- |
| HPKE Auth: P-256 / HKDF-SHA-256 / AES-128-GCM | 65-byte encapsulation + 16-byte tag = 81 bytes | Can use suitable P-256/AES hardware; compact C P-256 implementations exist | Repeats asymmetric work; HKDF, AEAD, key validation, provider state and buffers add to ECC memory |
| HPKE Auth: X25519 / HKDF-SHA-256 / ChaCha20-Poly1305 | 32-byte encapsulation + 16-byte tag = 48 bytes | Compact public keys; software candidate without AES hardware | Also repeats asymmetric work; smaller wire format does not guarantee lower stack/code size |
| Established static NaCl box with precomputed shared key | 24-byte nonce + 16-byte tag = 40 bytes | Amortizes asymmetric work; independent packets need no handshake | Retains a 32-byte shared secret or handle; needs nonce/replay discipline and a suitable provider; static-key compromise exposes history |
| AES-CCM within an existing constrained-device protocol | Depends on that protocol and its context establishment | Can reuse hardware AES and avoids GCM's GHASH tables | Requires known plaintext length; not a drop-in AEAD for RFC 9180's listed suites |

The figures omit routing IDs, schema/framing bytes, and enrollment claims. HPKE derives its nonce internally. Fresh encapsulations require secure random generation, not necessarily fresh physical entropy for every packet. Static box is a different construction, not permission to reuse HPKE's ephemeral key. [RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html), [NaCl box](https://doc.libsodium.org/public-key_cryptography/authenticated_encryption)

Both HPKE candidates lack forward secrecy against later recipient-key compromise. Static box also exposes prior traffic after sender-key compromise. NaCl box has no separate AAD input, so any semantic metadata must be authenticated inside the protected body and checked against outer routing hints. Its nonce space must remain disjoint across both directions; an established counter-based allocation can remove dependence on random nonces without removing the need for strong initial keys. Libsodium's documented Cortex-M limitations mean it is a comparison candidate, not an assumed MCU provider. [Libsodium installation](https://doc.libsodium.org/installation#cross-compiling-to-arm-microcontrollers)

AES-GCM-SIV can reduce the damage of nonce reuse, but cannot repair predictable keys or supply replay protection. It also needs a different supported profile and additional processing; do not substitute it silently into HPKE. Deterministic signatures similarly address signing randomness only and do not encrypt messages. [RFC 8452](https://www.rfc-editor.org/rfc/rfc8452.html)

**Some concrete memory evidence.** The `p256-m` README preserved in Mbed TLS 3.6.6 reports 2,900 bytes of code and 596 bytes of ECDH stack in a specific Cortex-M4/ARM-GCC build. The code measurement excludes the supplied RNG; the stack accounting assumes an RNG stack of at most 384 bytes. The corresponding ECDH benchmark was 144 ms at 100 MHz. These are historical primitive measurements, not the footprint or latency of our proposed complete library. They show why a small P-256 provider is worth measuring. [p256-m measurements](https://raw.githubusercontent.com/Mbed-TLS/mbedtls/mbedtls-3.6.6/3rdparty/p256-m/p256-m/README.md)

Library settings also matter. Mbed TLS 3.6.6's GCM context contains a 256-byte GHASH table in its small configuration; the large configuration expands that table to 4,096 bytes, before other state. CCM instead maintains two 16-byte working arrays plus bookkeeping and its cipher context. Those values describe these implementations, not universal totals. [GCM context](https://raw.githubusercontent.com/Mbed-TLS/mbedtls/mbedtls-3.6.6/include/mbedtls/gcm.h), [CCM context](https://raw.githubusercontent.com/Mbed-TLS/mbedtls/mbedtls-3.6.6/include/mbedtls/ccm.h)

**Plan for tight RAM.**

- Build only the selected profile and message types. Use fixed bounds, no heap, no TLS/X.509 stack, and no unbounded queues.
- Keep one current state snapshot rather than a history of encoded packets. Coalesce superseded temperature updates. Retain at most one cached transmitted object when affordable; otherwise regenerate a new protected object from unchanged immutable state using the provider's randomness rules.
- Reuse one in-place packet buffer between serialization and protection. Process one crypto operation at a time; release/reuse scratch only when its owner has finished. Avoid separate maximum-size decoded structures when a bounded incremental encoder suffices.
- On receive, decrypted bytes are private, provisional data until the entire tag is verified. Do not apply names, commit revisions, or expose plaintext on authentication failure. If a full record cannot fit, use trusted staging or a separately designed authenticated fragment/commit protocol; unauthenticated streaming is not a memory optimization.
- Account for buffers, persistent RAM state, crypto/provider workspace, actual call-stack overlap, UART/DMA rings, and interrupt stack together. `no_std` or zero heap allocation does not imply low stack use.
- Define distinct maximum enrollment and steady-state frame sizes. As initial design ceilings to test, consider 512 and 256 bytes respectively; these are adjustable caps, not demonstrated sizes or guaranteed minimum RAM. A shared 512-byte frame buffer already consumes that much RAM before any cryptography.

**115200 baud and opportunistic synchronization.** Assuming UART 8N1, each byte costs 10 bits. A 128-byte complete frame takes 11.1 ms; 256 bytes take 22.2 ms; 512 bytes take 44.4 ms. The difference between HPKE's two encapsulation/tag sizes is only 2.9 ms of wire time. Actual crypto execution and available RAM may be more decisive than that difference.

The sync engine has no required ping, heartbeat, connection handshake, or continuously available server. The application supplies an explicit `transmit_opportunity(byte_budget)` event. Sources can include startup, meaningful state change, a host drain request, or an optional local retry schedule. A host request is a transport hint, never proof of server availability or authority.

Send the latest pending snapshot when an opportunity and rate budget exist. Include enrollment until a genuine receipt confirms it. Piggyback acknowledgment metadata and desired state on useful traffic where possible; receipt-only messages remain possible when an application needs confirmation. Retries have bounded rate/backoff and preserve only current state. No pending work means no required traffic. Persisted identities and revisions do not expire just because no server has been heard from.

Progress remains conditional: when the host withholds all opportunities or traffic, state stays pending. The device can continue measuring locally. Generating encryption keys, reporting data, or applying an authenticated desired state does not require a preliminary server ping.

**Recommendation for the next implementation step.** Stabilize these contracts and build a no-heap measurement harness. Compare a compact C/provider implementation with the shared Rust candidate instead of making either language backend mandatory. Measure complete enrollment and state-exchange paths, including provider calls, stack peaks, encoded sizes, and cold-boot recovery. If the full single-shot profile exceeds memory, evaluate an established static-key datagram construction before inventing an optimized session protocol.

Fault injection should include an all-zero raw entropy source, unavailable entropy, repeated boot sequences, failed durable reservations, torn commits, tampered packets, exact retries, and dropped enrollment receipts. Test-provider controls are never exposed in the normal MCU API. A trusted seeded generator may continue through failure of optional raw noise; a device with no trusted seed must fail rather than emit predictable new cryptographic material.
