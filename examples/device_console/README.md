# Interactive C++ device console

A C++17 command interpreter compiled to WebAssembly and embedded in the
[fleet manager](../fleet_manager/README.md). Each console runs a separate device
instance with its own saved identity and credit state.

```sh
bazel build //examples/device_console:module
bazel run //examples/fleet_manager:preview
```

Choose **Create device**, type a command, and press Enter. Use the up/down arrow
keys to recall commands. The console shows application output; enable **Debug**
in its title bar to see messages exchanged with the server; no frame copying or terminal setup is required.

| Command | Operation |
| --- | --- |
| `help` | Show commands |
| `status` | Show identity, registration, issued/consumed credits, and remaining balance |
| `consume 25` | Persist a local debit |
| `sync` | Exchange pending messages with the server |
| `reboot` | Restore saved identity and credits, then synchronize |
| `quit` | Stop the device, retaining its saved state |

Rejected commands explain the cause and the next step. For example, `consume 25`
with no available balance reports `Insufficient credits: requested 25, available 0`,
confirms no debit occurred, and points to the fleet's credit control. Invalid or
zero amounts, unconfirmed enrollment, exhausted counters, and storage failures
have distinct messages. Balances in these diagnostics retain full uint64 precision.

The server's **Authorize enrollment** action sends a signed challenge and
receives the device response. **Approve device** explicitly approves the exact
candidate/session binding and delivers confirmation. Issuing credits or
requesting a report completes its message exchange automatically. Local
consumption stays local until the server requests a fresh report; `sync` does
not create such a request.

`console.cpp` parses commands and calls the public C API through the example
platform. Its result tells the worker whether to stop or synchronize. Transport
lives in `fleet_manager/transport.mjs`, which forwards real opaque binary frames
between the two endpoints. It never bypasses enrollment approval or synthesizes
protocol responses. Amounts are exact unsigned decimal uint64 values.

**Hide** only hides a console; **Open console** restores it. **Stop device** and
**Start saved device** discard and restore the instance. Successful output is
read only after awaited storage calls complete. Console activity is bounded to
200 lines and command history to 50 entries; both are temporary. Persistent
identity and protocol records remain in the provider's browser-local storage.
