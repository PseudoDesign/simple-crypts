# C++ device console (WebAssembly only)

This application is a small C++17 command interpreter compiled to WebAssembly.
It runs inside the [fleet manager](../fleet_manager/README.md); it does not open
an OS terminal or connect to hardware. For a native terminal application, use
the [Python example](../python_device/README.md).

```sh
bazel build //examples/device_console:module
bazel run //examples/fleet_manager:preview
```

Choose **Create simulated device**. The webpage starts an independent Wasm
instance and opens a small console. The JavaScript renderer passes text to
`device_command()` in `console.cpp`; parsing and device operations run in C++.
`examples/common/endpoint.c` supplies the platform and calls the public C API.

| Command | Operation |
| --- | --- |
| `help` | Show the command vocabulary |
| `status` | Inspect public identity, registration, and exact decimal totals |
| `consume 25` | Persist a local debit; do not transmit |
| `rx HEX` | Receive one manually pasted frame; do not transmit a reply |
| `tx` | Generate one frame, or print `No output.` |
| `reboot` | Reload the protocol from saved state and burn unused nonce values |
| `quit` | Stop the instance while keeping its persistent identity and state |

Frames are contiguous hexadecimal strings of at most 512 bytes. Amounts are
unsigned decimal uint64 values. Protocol errors appear as `error: STATUS`;
invalid commands never silently become zero-valued credit operations.

**Copy last frame** copies only a generated frame. It never delivers it. **Hide**
hides the console; **Open console** restores it. **Stop device** and **Start saved
device** discard and restore the instance without replacing the identity.
Console history is bounded and temporary; protocol state is saved.

The C++ output buffer is read only after the awaited command completes. Asyncify
suspends storage calls until IndexedDB commits, so no successful debit or
outbound frame is exposed before its required durable writes complete. Private
keys remain in the worker's provider/storage boundary. See the fleet README
for storage behavior and the complete manual exchange.
