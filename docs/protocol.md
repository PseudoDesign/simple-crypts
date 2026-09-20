# Protocol version 3

Simple Crypts carries independent authenticated envelopes over a caller-supplied
transport. Both roles use the same bounded C core. Application data is defined
by [resource schemas](resources.md), rather than built into the crypto layer.

## Frames and encoding

Encrypted frames have a 62-byte outer header and a 16-byte NaCl authentication
tag followed by encrypted bounded protobuf data. The header contains `SC`,
protocol version 3, crypto profile 2, direction, kind, sender Ed25519 public key,
and a 24-byte nonce. Header identities, direction, and kind must match the
corresponding authenticated inner fields. Serial, recipient, key generation,
schema hash, group ID, request ID, and revision are authenticated in the body.

Profile 2 uses standard X25519/XSalsa20-Poly1305 box with Ed25519 identities
converted inside the provider. Private keys remain behind handles; temporary
converted secret scalars are wiped. Static-key box provides no forward secrecy
or third-party-verifiable signature on encrypted application messages.

The entire envelope is at most 512 bytes. UART delimiters, COBS, stream assembly,
and transport checksums belong to the caller. No particular transport or baud
rate is required. JSON/base64 appear only in diagnostic/test control channels.

A resource message names one group and its schema hash. Data kind 1 requests a
snapshot, 2 returns the captured snapshot, and 3 acknowledges it. Request ID and
message revision agree. Values use a bounded typed encoding within protobuf:
big-endian uint16 field ID, uint8 type, uint8 length, then value bytes. Numeric
values are eight-byte big-endian integers (signed values use two's complement),
Booleans are one byte, and text/bytes carry their explicit length. A snapshot
contains every field in descriptor order. Type, ID, length, duplicate/extra
fields, UTF-8, and application invariants are validated before committing.

The retired name/temperature protobuf tags are reserved, never reinterpreted.
The schema compiler checks group bounds; C static assertions check maximum
packet and record sizes. Unknown groups and mismatched schema hashes are rejected.

## Enrollment

Signed enrollment is explicitly enabled on fresh contexts. The application
supplies the authorization policy; relay packets cannot invoke approval.

1. The server authorizes a serial/session with `sc_enrollment_begin(now, expires)`.
   A fresh challenge requires cryptographic randomness.
2. Its public invitation is 172 bytes: `SCE3`, server Ed25519 public key,
   zero-padded 32-byte serial, 32-byte challenge, big-endian uint64 expiry,
   and a 64-byte Ed25519 signature over the first 108 bytes.
3. The device checks the signature against its pinned server key and retains
   the challenge. Its encrypted identity claim carries no application data.
4. The server uses trusted time to reject expired sessions and stages one
   candidate key. `sc_enrollment_approve(challenge, key, now)` authorizes that
   exact serial/session/key association and commits registration atomically.
5. An encrypted confirmation lets the device complete enrollment. A repeated
   claim can regenerate a lost confirmation. Credits begin at zero.

The browser verifies the invitation before generating the device identity;
its provider mixes public challenge material with fresh secret randomness.
The challenge is not secret entropy and cannot repair predictable randomness.
Other callers may initialize an already established identity before enrollment.

The device needs no clock. A clockless device may accept an old signed challenge,
but the server rejects a response against an expired, canceled, or replaced
session. Approval requires an application policy; key possession and a serial
alone do not prove hardware provenance. An untrusted relay can withhold progress.
The explicit legacy token enrollment mode remains available to test/sample
callers that do not enable signed enrollment, using version 3 identity-only claims.

## Durable state and retries

Nonce reservations are separate from application record commits. Reserve a
range durably before using it; reboot burns unused values and reserves a fresh
range. Nonces are direction-separated and unique for the key pair. Never clone
or roll back counter storage under an existing identity. Counters supply
uniqueness, not entropy.

Resource updates, captured snapshots, request state, and receipts commit
atomically. No frame leaves the outbound operation before its sent-ID state is
durable. Failed output commits burn the reserved nonce and leave recoverable
application state. Retransmission uses a new nonce or identical cached bytes.

Local consumption does not produce traffic. Explicit requests capture snapshots;
responses retry until acknowledged. Duplicate snapshots may return success
without changing values. Older snapshots cannot roll back state. See
[shared resources](resources.md) for ownership and correlation rules.

## Compatibility

Version 3 rejects earlier encrypted envelopes, signed invitations, and host
`SCSTORE1`/`SCSTORE2` records. The host format is now `SCSTORE3`; the core record
also checks version and schema hash. There is no automatic data migration or
silent identity replacement. Use fresh sample stores for this release.

The host record is local to its architecture/ABI, not a backup interchange
format. A production migration would require a separately authorized design
that preserves identities, nonce uniqueness, and application totals.
