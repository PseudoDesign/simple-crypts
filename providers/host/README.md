# Durable host reference provider

`sc_host.h` is a small owned-handle facade for host applications and the Python,
Rust and Go bindings. The MCU-facing API remains the caller-owned C99 core in
`core/sc.h`. Every process represents one device or one server-side device
context. Callers must serialize operations; a provider store cannot be shared
between live contexts. Private identity keys stay inside the provider.

The host uses the portable `providers/sodium` reference crypto provider and
libsodium's established `crypto_box_easy` construction (X25519, XSalsa20,
Poly1305). It does not implement an asymmetric construction itself. Independent
messages use separately reserved nonces; encryption requires no handshake and
does not chain ciphertexts. This static-key profile does not provide forward
secrecy or nonrepudiation. `crypto_box` authenticates both holders of the pair's
shared secret, not signatures that third parties can verify.

The POSIX reference store is a trusted local software keystore, **not storage
safe to place on the uncontrolled relay**. It contains private keys and the
enrollment secret. Directories must be owned by the current UID and mode 0700;
files are created mode 0600. An exclusive advisory lock prevents cooperating
processes from opening a live store twice. The application must protect the
directory's parent and backups. This provider does not resist a malicious
process running as the same UID, administrator access, disk rollback, or
restoration of older snapshots. A hardware deployment supplies its own
keystore, durable counter allocator, and antirollback policy.

Creating a store also fsyncs its parent directory before keys can be used.
Each commit writes a complete aggregate record to a temporary file, fsyncs it,
renames it, and fsyncs the directory. The record includes keys, serial and token
binding, core snapshot, and nonce reservations. Reserving counters preserves
the latest snapshot; committing a snapshot preserves reserved counters. A
failure after rename poisons the live handle because durability is uncertain;
reopen it before further work. Gaps in counter allocation are intentional.
Atomicity/durability assume a filesystem implementing these POSIX guarantees.
The digest detects accidental corruption; it is not cryptographic protection
against a party able to rewrite the store. The fixed host record is local
architecture/ABI dependent, not a network or backup interchange format.

Production initialization either resumes an existing key, accepts a trusted
32-byte provisioned seed, or requests host cryptographic randomness for a new
identity. Fixed seeds in JSONL adapters are **test fixtures only**. The public
device API accepts the server's public key; `server_seed` exists only in test
adapters to derive fixtures and must never be installed on a real device.

`random_unavailable` and `fail("random", n)` model failure at the provider RNG
boundary. The core and portable box operations do not call RNG for a provisioned
identity. Host `sodium_init()` still initializes libsodium's OS random subsystem;
these tests establish behavior with an unavailable application RNG callback,
not physical proof that a host with no entropy can start. The MCU target checks
the independent portable provider and platform entropy contract.

`fail("storage", n)` rejects the next n durable operations before writes;
`fail("crypto", n)` rejects the next n key/public/seal/open operations. Faults
are test controls rather than wire messages. Counter boundary fixtures are
enabled only in builds defining `SC_ENABLE_TESTING`; ordinary builds return an
error from that fixture helper. SDK status strings are stable lowercase names:
`ok`, `idle`, `invalid`, `buffer`, `auth`, `protocol`, `storage`, `random`,
`crypto`, `conflict`, `exhausted`, `role`, `enrollment`, `utf8`, `not_found`.

Host state inspection uses diagnostic JSON with all uint64 values as decimal
strings. `temperature_mC` and compatibility alias `temperature` are integer
millidegrees Celsius. JSON/base64 are only the test control interface; actual
protected messages carry bounded protobuf snapshots.
