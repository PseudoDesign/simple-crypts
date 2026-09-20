# Interactive fleet manager

A small fleet application built with HTML, CSS, ES modules, and the real C/C++
protocol applications compiled to WebAssembly. Device consoles and the server
run locally in one owning worker, using isolated Wasm instances. IndexedDB is
the persistent database for this browser origin.

```sh
bazel build //examples/fleet_manager:site
bazel run //examples/fleet_manager:preview -- --port 8001
```

Open `http://127.0.0.1:8001/`. HTTPS and localhost supply the secure browser
context required for randomness and Web Locks. The standalone output is
`bazel-bin/examples/fleet_manager/site`; `//web:site` also includes the example
under `examples/fleet_manager/`.

## Console walkthrough

1. **Create device** opens its C++ console. Type `help` or `status` and press
   Enter. Up/down arrows recall previous commands.
2. **Authorize enrollment** delivers the signed challenge and the device's
   encrypted response. The console reports that it is awaiting approval.
3. Compare the candidate key in **Enrollment identity** with device `status`,
   then **Approve device**. Confirmation is delivered to the device.
4. In the fleet table, set **Cumulative credits issued** to `100`. The request, device response, and
   receipt are exchanged over the simulated link.
5. Type `consume 25`. `status` shows 75 remaining; server **last reported
   consumed** remains zero until you **Request report**.
6. Try `reboot`, `quit`, or stop/start. Identities and credits survive. Pending
   server changes made while a device is stopped arrive when it starts.

The top banner links back to Home and the guided demos. All enrollment, credit,
report, power, and connection controls live in each device's fleet row. Consoles
are small floating windows: drag their title bar, or focus it and use arrow keys.
Escape cancels a drag. Hide/Open preserves the window position within the page;
viewport resizing keeps windows reachable. Positions and command history are
only UI state, not device checkpoints.

**Disconnect** disables the simulated link without stopping the device. Local
commands still work, while issuance, reports, and enrollment messages wait.
**Connect** resumes pending exchanges. The setting survives reload/reboot and
stop/start; previously saved devices default to connected.

**Reset browser data** at the top asks for confirmation, then atomically clears
all saved fleet entries and endpoint checkpoints, including retired external
entries. It also closes consoles. Cancel leaves everything intact. The owning
worker retains its exclusive lock throughout, so another tab cannot race reset.
Reset affects this demo's saved data on the current browser origin.

`sync` retries pending protocol work when connected. There are no raw-frame fields, clipboard
controls, or external-device launch commands. The existing guided demo is still
available for experimenting with individual packet delivery.

## Application boundaries

- `app.mjs` renders public state and each console's latest 200 activity lines.
  Commands and events use text, not HTML. Command history is local to each console.
- `worker.mjs` owns endpoints and registry records, serializes operations, and
  holds the exclusive fleet Web Lock before loading state. A second tab cannot
  run the same saved fleet concurrently.
- `transport.mjs` forwards opaque binary frames on server actions, `sync`,
  restart, and saved-device restoration. It waits for explicit application
  approval during enrollment and bounds every exchange to prevent endless retries.
- `../device_console/console.cpp` implements device commands in C++, including
  local consumption and inspection. JavaScript does not emulate device state.
- `../common/endpoint.c` implements the public `sc_provider` contract using
  libsodium and versioned durable records; `storage.mjs` owns the IndexedDB I/O.

Each serial has a separate server identity, matching the library's one-peer
context. Credit totals are exact decimal strings/BigInt. Issuance is an absolute
cumulative total. A local debit does not imply a requested snapshot: neither
`consume` nor `sync` manufactures a server report request.

## Persistence and recovery

Checkpoints encode role, serial, pinned key, identity, core record, generation,
and nonce reservation high-water marks. They never serialize runtime pointers
or nonce cursors. Normal `sc_init` restoration burns unused reservations.

The provider uses Asyncify to await IndexedDB transaction completion with strict
durability requested. A completed nonce reservation survives a later failed
record commit. Storage errors stop an endpoint; reload after resolving the
problem. Missing or incompatible records never generate replacement identities.

A partially created device remains an explicit incomplete entry. An interrupted
enrollment confirmation is recovered by resending the saved device response
through the transport. No approval is inferred from device creation or restart.

Browser devices saved by the earlier manual demo remain compatible. Retired
external-device entries are omitted from the runtime/UI, but their stored data
and serial reservations are not deleted or reassigned. There is no destructive
migration. Use **Reset browser data** to deliberately discard the entire fleet.

Changing the preview port changes the origin. Console activity is temporary;
identity and protocol state survive refresh. Keys use local software storage,
not a hardware keystore. This example has no cloud service or physical UART.

## Validation

```sh
bazel test //examples/fleet_manager:protocol_test
bazel test //examples/fleet_manager:browser_test --test_output=errors
```

Tests cover explicit approval, automatic frame exchange, command parsing,
keyboard history, mouse/keyboard window movement, reset cancellation/deletion,
persistent connection toggles, exact uint64 credits, stopped-device queues, reload/reboot,
replay, expiry, isolated devices, finite exchange bounds, transaction failures,
nonce reservations, and compatibility with old saved entries. Browser checks
run in Chromium and Firefox, with artifacts under `/tmp/simple-crypts-fleet-browser`.
