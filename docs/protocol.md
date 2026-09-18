# Protocol version 1

This sample fixes one profile: standard NaCl box, using X25519, XSalsa20 and
Poly1305. There is no algorithm negotiation. The cryptographic provider operates
on opaque identity-key handles. The protocol never obtains a private identity
key. The profile does not provide forward secrecy or third-party signatures.

## Bounds and encoding

An envelope is a fixed 62-byte routing header followed by a 16-byte NaCl tag
and encrypted protobuf bytes. The complete envelope is at most 512 bytes.
`schema/sc.proto` and `schema/sc.options` define the nanopb objects. Generated
fields have fixed capacities; the core validates both sizes and semantics.

| Header byte offset | Length | Meaning |
| --- | ---: | --- |
| 0 | 2 | ASCII `SC` |
| 2 | 1 | Protocol version, `1` |
| 3 | 1 | Profile, `1` |
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
allocation. At 115200 baud with 8N1 framing, an envelope of N bytes requires
`10*N/115200` seconds of serialization, excluding any transport framing or
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
authorized lifecycle operation; version 1 deliberately has no key-reset command.

Application records use atomic compare-and-replace commits. The core stages
changes and publishes them only after a successful commit. Before returning a
newly issued frame it also persists its highest sent revision, so a receipt
cannot acknowledge an unissued revision after restart. Provider callbacks must
report ambiguous commit outcomes as unusable until the store has been reopened.

## Enrollment

Before confirmation, every device report includes a 32-byte enrollment secret
inside the encrypted body. Each report is independently sufficient to enroll
and deliver useful data. The server verifies the serial authorization, then
atomically records the peer key, consumes the authorization by marking the
serial bound, and accepts the initial reported snapshot.

A bound serial accepts reports only from that key. Repeated claims from the
same key do not consume the authorization again. Claims from a conflicting key
cannot replace the binding, even if they contain the original secret. The
reference store retains its provisioning material; authorization consumption
means the irreversible binding in the atomic protocol record, not erasure of
every copy of the provisioning secret.

The server's protected receipt confirms enrollment. Until that receipt arrives
the device continues attaching the claim. Losing the first report or any number
of receipts therefore does not require a special recovery handshake.

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
