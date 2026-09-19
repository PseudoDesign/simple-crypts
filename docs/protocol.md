# Protocol version 2

Profile 2 uses Ed25519 identity keys. The libsodium provider converts them to
X25519 for standard NaCl box (XSalsa20-Poly1305), and uses Ed25519 directly
for signed enrollment challenges. There is no algorithm negotiation. The cryptographic provider operates
on opaque identity-key handles. The protocol never obtains a private identity
key. Box traffic does not provide forward secrecy or third-party signatures; enrollment invitations have detached Ed25519 signatures.

## Bounds and encoding

An envelope is a fixed 62-byte routing header followed by a 16-byte NaCl tag
and encrypted protobuf bytes. The complete envelope is at most 512 bytes.
`schema/sc.proto` and `schema/sc.options` define the nanopb objects. Generated
fields have fixed capacities; the core validates both sizes and semantics.

| Header byte offset | Length | Meaning |
| --- | ---: | --- |
| 0 | 2 | ASCII `SC` |
| 2 | 1 | Protocol version, `2` |
| 3 | 1 | Profile, `2` |
| 4 | 1 | Direction: `1` device to server; `2` server to device |
| 5 | 1 | Kind: `1` report; `2` desired snapshot plus receipt |
| 6 | 32 | Sender public key, an untrusted routing hint |
| 38 | 24 | Nonce |
| 62 | variable | NaCl `box_easy` ciphertext, including its 16-byte tag |

The authenticated protobuf body repeats the version, profile, direction, kind,
serial, sender public key, recipient public key, and fixed key generation `1`.
The receiver compares them with its identity and the header before changing
state. NaCl box has no associated-data parameter: these authenticated copies
are mandatory. Reflection is rejected by direction and recipient checks.
Changing the nonce also invalidates the authentication tag.

Serials contain 1–32 printable non-space ASCII bytes. Names contain at most 64
UTF-8 bytes, excluding a C terminator. Invalid UTF-8, embedded NULs on the wire,
oversized fields, malformed protobuf, unknown versions/profiles/kinds, and
inconsistent role-specific fields are rejected. Temperature is signed 32-bit
integer millidegrees Celsius. Revisions are unsigned 64-bit integers; host JSON
diagnostics encode them as decimal strings.

The core API accepts one complete envelope. UART delimiter framing, COBS,
checksums, and partial-byte assembly are transport responsibilities. The caller
must bound that assembly buffer; serial noise must never create an unbounded
allocation. As an optional UART example, at 115200 baud with 8N1 framing an
envelope of N bytes requires `10*N/115200` seconds of serialization, excluding any transport framing or
processing time. A 512-byte envelope takes about 44.4 ms.

## Nonces and durable state

The 24-byte nonce is `direction[1] || zero[15] || counter_be64[8]`.
Direction separation is necessary because box derives the same shared secret
for either ordering of a key pair. The provider reserves ranges of 32 counters
durably **before use**. On restart the core reserves a new range and abandons
unused values from the old range. Counter exhaustion fails closed.

Every outbound retry uses a newly reserved/available nonce. The protocol has no
ciphertext queue. It encodes the current snapshot on each explicit opportunity.
Failed encryption or a later failed commit may burn a nonce; a burned nonce is
never reused. An insufficient byte budget or output capacity emits no frame.

Nonce ranges are independent of application revisions. `commit` must never
overwrite a newer counter reservation. Providers sharing a key across contexts
must allocate from a shared identity/direction counter namespace. Do not clone a
store, restore an old backup, or reprovision the same key into a fresh counter
store. Replacing both key material and its generation requires a future
authorized lifecycle operation; version 2 deliberately has no key-reset command.

Application records use atomic compare-and-replace commits. The core stages
changes and publishes them only after a successful commit. Before returning a
newly issued frame it also persists its highest sent revision, so a receipt
cannot acknowledge an unissued revision after restart. Provider callbacks must
report ambiguous commit outcomes as unusable until the store has been reopened.

## Enrollment

Call `sc_enrollment_enable()` on a fresh device and server before transmission.
The mode is persisted and cannot be disabled. The public host SDKs expose the
same operation. The pre-existing token-authorized path is retained only for
explicit legacy sample callers/tests that do not enable signed enrollment.
It does not prove hardware provenance. New demos and examples enable signed
enrollment and use no shared enrollment secret.

1. The application's enrollment authorization policy calls `sc_enrollment_begin(now, expires)`
   for the context's serial. The server needs cryptographic randomness for a
   fresh 32-byte session challenge; signing and encryption need no fresh RNG.
2. On a transmission opportunity the server emits a **public, signed** invitation.
   The device verifies the signature against its pinned Ed25519 server identity,
   checks the serial, and durably retains the challenge. It need not have a clock.
3. The device encrypts a report containing the challenge and its Ed25519 public
   identity. The server uses `sc_receive_at(..., now)` to validate the response
   against the active, unexpired session. The response stages a candidate key
   and first report; it does not register a device or accept application state.
4. The application authorizes approval and calls `sc_enrollment_approve(challenge, key, now)`.
   It must authorize this **exact serial, session, and key**. Registration,
   initial state acceptance, and session consumption commit atomically.
5. An encrypted confirmation echoes the challenge and acknowledges the report.
   A duplicate authenticated response regenerates a lost confirmation.

Authentication and authorization are supplied by the application. Enrollment
approval is a control-plane operation, never an action authorized by a relay packet.
`sc_enrollment_cancel()` and session replacement invalidate pending responses.
Pending candidates survive reboot. Only one candidate is retained per session;
a different key is rejected until the application authorizes a replacement session.
The first candidate may include a temperature report but may not claim prior
name application. The current reporting API creates that first report with
`sc_report_temperature()`.

Expiry uses trusted server time in a caller-chosen consistent unit. A receive
or approval at `now >= expires` fails. The normal host `receive()` supplies OS
wall-clock seconds; `receive_at()` supports a trusted application's clock and
deterministic tests. Core `sc_receive()` has no clock, so it fails closed on
unapproved server responses; use `sc_receive_at()` there. Consumed sessions stay
bound: idempotent approval or duplicate reports cannot change the identity.

The invitation is exactly 172 bytes, all fields except the signature signed:

| Offset | Bytes | Value |
| --- | ---: | --- |
| 0 | 4 | Domain/version marker `SCE2` |
| 4 | 32 | Server Ed25519 public key |
| 36 | 32 | Serial, zero-padded |
| 68 | 32 | Random session challenge |
| 100 | 8 | Expiration, unsigned big-endian |
| 108 | 64 | Ed25519 signature over bytes 0–107 |

The protobuf `enrollment_token` field carries the public challenge in signed
mode, including confirmations and subsequent reports. It is not a bearer secret.
The encrypted protocol binds both Ed25519 identities; conversion to X25519 is
only a provider operation. Invalid public-key conversions fail closed.

A signed challenge proves the server originated the invitation, not that the
responding hardware is genuine. The trusted approver is responsible for the
serial/key association. A clockless device can accept an old signed invitation,
but its response cannot enroll against an expired, canceled, or replaced server
session. An untrusted host can always withhold traffic.

### Key and storage compatibility

Each identity uses one Ed25519 key pair. The software keystore stores the
libsodium 64-byte secret representation; temporary X25519 secret scalars are
wiped after each box operation. Public keys, pins, wire identity fields, and
approvals are all Ed25519. The raw-X25519 helper functions remain available
only for independent primitive tests and the optional hardware probe.

This is a wire/storage break from version 1. Old envelopes and `SCSTORE1`
stores are rejected; existing keys are not silently reinterpreted or overwritten.
Reprovisioning and field migration require an explicit authorized deployment
plan. Sharing one identity for signatures and encryption couples their rotation
and compromise. This sample follows the requested single-identity design;
[libsodium documents the conversion and recommends separate keys when feasible](https://doc.libsodium.org/advanced/ed25519-curve25519).

## Desired and reported state

The server owns the desired name and its revision. The device owns the latest
temperature, actual name, processed/applied desired revision, application result,
and reported revision. Each stream contains a complete snapshot. A newer
revision replaces the previous snapshot; an older one cannot roll it back.
An equal revision must agree with the already accepted contents.

The name example applies nonempty valid names immediately and durably. An empty
name is a processed rejection: the device retains its actual name and reports
the rejected desired revision. The server can distinguish processed rejection
from successful application. A physical application integration must arrange
its own atomic/idempotent actuator behavior before claiming success.

For a server, public `pending` means the desired revision has not yet been
processed according to an authenticated report. Receipt traffic is tracked
separately. For a device, `pending` means its current reported revision has not
been acknowledged. An older receipt never clears a newer report. An
acknowledgment beyond the highest durably sent revision is invalid.

Receipts can be regenerated from the current state when a duplicate report
arrives. They do not cause acknowledgment loops. No timer or network traffic
runs internally. The application supplies transmission opportunities and byte
budgets; the core returns a frame or indicates that it has none.

The host can indefinitely suppress progress. Convergence assumes eventual
delivery of current snapshots and their application reports. Revision ordering
provides relative freshness, not proof of measurement age. An authentic first
report might have been delayed for a long time. Keep time-sensitive actuation
and guaranteed event history out of this snapshot protocol.
