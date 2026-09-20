# Language SDKs

These are language bindings to one bounded C protocol engine and one selected
crypto provider. Interoperability tests exercise the public APIs and the real
binary wire format in separate language processes. They do not claim four
independent cryptographic implementations.

| Language | Public entry point | Ownership and errors |
| --- | --- | --- |
| C, MCU | `core/sc.h` | Caller-owned context and buffers; status returns; no allocation |
| C, host | `providers/host/sc_host.h` | Opaque owned handle; close once; status returns |
| Python | `bindings/python/simplecrypts.py` | CFFI; context manager or `close()`; `Error.status` |
| Rust | `bindings/rust/src/lib.rs` | Safe C ABI wrapper; `Drop` or consuming `close()`; `Result` |
| Go | `bindings/go/simplecrypts.go` | cgo; explicit idempotent `Close()`; returned `error` |

Each SDK exposes initialization, `set_credits_issued`, `consume_credits`,
`request_credit_status`, `receive`, `outbound`, and state inspection using its
language's naming conventions. Generic `update_group`, `request_group`, and
`inspect_group` operations use the same core ownership and invariant checks.
Resource IDs come from generated constants. See [resource definitions](../docs/resources.md).

`receive` borrows bytes only for one synchronous call. Outbound frames and
inspection results are independently owned. C buffers belong to the caller.

Contexts are single-owner. Add application synchronization when needed. Rust
handles are deliberately neither `Send` nor `Sync`; its consuming close prevents
use after close in safe code. Go and Python reject use after closing. Rust and Go
use uint64 credit parameters. Python additionally checks integer range and type.

Diagnostic JSON represents 64-bit counters as decimal strings. The wire protocol
uses exact binary integer values and does not depend on JSON numbers. Raw
private keys are never returned. Server public keys enter the device API as
public bytes; fixed server seeds exist only in explicitly test-oriented helpers.

`adapters/` supplies the same JSONL test process interface for each language.
Every adapter calls its language's public SDK directly. None launches a C adapter
subprocess to impersonate a language implementation. JSON and base64 are test
control formats; the relay forwards the returned opaque binary frames.

## Signed enrollment (protocol 3 / crypto profile 2)

Host identities are Ed25519; the provider converts them to X25519 for NaCl box.
Private keys never cross the SDK boundary. Call `enrollment_enable()` on fresh
Python/Rust endpoints (`EnrollmentEnable` in Go, `sc_host_enrollment_enable` in C)
before sending traffic. Begin an authorized session, deliver its signed challenge,
and deliver the encrypted response. Inspect `candidate_key` and approve the exact
challenge/key pair through the application's enrollment authorization policy.

`enrollment_begin(now, expires)`, `enrollment_approve(challenge, key, now)`, and
`enrollment_cancel()` are trusted control-plane calls; they are not relay inputs.
`receive_at(frame, now)` uses trusted server time for deterministic callers; normal
host `receive()` uses OS wall-clock seconds. Session timestamps are uint64 values.
The existing `secret` initialization argument is an unused compatibility slot in
signed mode (examples pass 32 zero bytes). Legacy token-mode tests remain explicit
callers that omit `enrollment_enable()`. SCSTORE1 and SCSTORE2 stores are rejected; use fresh sample storage.

See [the protocol](../docs/protocol.md#enrollment) and
[the production Python example](../examples/python_api.py).
