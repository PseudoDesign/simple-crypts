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

Each SDK exposes initialization, `name`, `report`, `receive`, `outbound`, and
state inspection using its language's naming conventions. A device reports
integer millidegrees Celsius; a server requests a name. `receive` accepts owned
or borrowed binary bytes for the duration of one synchronous call. SDK outbound
buffers and diagnostic state are independently owned and remain valid after
later operations. Native C outbound and inspection buffers belong to the caller.

Contexts are single-owner. Add application synchronization when needed. Rust
handles are deliberately neither `Send` nor `Sync`; its consuming close prevents
use after close in safe code. Go and Python reject use after closing. Rust and Go
use int32 temperature parameters so out-of-range values cannot be passed without
an explicit caller conversion. Python additionally checks integer range and type.

Diagnostic JSON represents 64-bit counters as decimal strings. The wire protocol
uses native uint64 protobuf values and does not depend on JSON numbers. Raw
private keys are never returned. Server public keys enter the device API as
public bytes; fixed server seeds exist only in explicitly test-oriented helpers.

`adapters/` supplies the same JSONL test process interface for each language.
Every adapter calls its language's public SDK directly. None launches a C adapter
subprocess to impersonate a language implementation. JSON and base64 are test
control formats; the relay forwards the returned opaque binary frames.
