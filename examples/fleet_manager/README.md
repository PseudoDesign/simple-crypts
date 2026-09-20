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
   encrypted response. Its fleet row shows that it is awaiting approval.
3. Compare the candidate key in **Enrollment identity** with device `status`,
   then **Approve device**. Confirmation is delivered to the device.
4. In the fleet table, set **Cumulative credits issued** to `100`. The request, device response, and
   receipt are exchanged over the simulated link.
5. Type `consume 25`. `status` shows 75 remaining; server **last reported
   consumed** remains zero until you **Request report**.
6. Try `reboot`, `quit`, or stop/start. Identities and credits survive. Pending
   server changes made while a device is stopped arrive when it starts.

The top banner links back to Home and the guided demos. All enrollment, credit,
report, and power controls live in each device's fleet row. Consoles
are small floating windows: drag their title bar, or focus it and use arrow keys.
Escape cancels a drag. Hide/Open preserves the window position within the page;
viewport resizing keeps windows reachable. Positions and command history are
only UI state, not device checkpoints.

**Disconnect** in the console title bar disables the simulated link without stopping the device. Local
commands still work, while issuance, reports, and enrollment messages wait.
**Connect** resumes pending exchanges. The setting survives reload/reboot and
stop/start; previously saved devices default to connected.

**Debug: off/on**, next to Hide, toggles protocol debug logging for that device.
Debug starts off on page load. While off, no new protocol chatter is recorded
and previously captured debug lines are hidden. Command output and errors stay
visible. Enabling it shows previously captured lines and records future exchanges;
it does not trigger message delivery. Debug settings survive hide/reopen and
stop/start within the page, but are not persisted across reloads.

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

## Physical QT Py over Web Serial

Open `qtpy.html` from the same preview (or
`examples/fleet_manager/qtpy.html` in the complete site). Desktop Chrome and Edge
on Windows, macOS, and Linux can select the QT Py's USB CDC port. HTTPS or
localhost, Web Serial, Web Locks, IndexedDB, and secure browser randomness are
required. iPad browsers do not support this connection. The firmware must be the
[QT Py demo](../embedded/qtpy_rp2040/README.md), not its ROM bootloader.

1. Close other serial clients and choose the board's port.
2. Select **Register device**, review the displayed device identity, then select
   **Approve device**. Approval is a separate action; the serial number alone is
   not authentication.
3. Set the cumulative issued total (for example, `100`). Press BOOT on the board
   to consume credits; select **Refresh balance** to obtain an authenticated report.
4. After a reboot or page reload, reconnect using the same browser profile and
   site address, then select **Refresh balance**. This supplies fresh per-boot
   entropy and restores the existing host/device relationship.

The browser persists the production Wasm server's identity, encoded state, and
nonce reservations in a separate `simple-crypts-qtpy-v1` IndexedDB database.
A Web Lock prevents two tabs from concurrently owning it. The page is the trusted
application owner; private checkpoint bytes stay in its provider/storage layer,
not DOM messages or logs. Clearing site data, changing origin/profile, or private
browsing can lose the host identity. This first version has no host-key export or
Python-store import. Simulated fleet data is separate and its reset control does
not clear hardware host identities.

A board already enrolled by the Python operator or another browser is inspected
but cannot be registered here. Use the original host, or explicitly factory-reset
the board and enroll again. The page never erases hardware or replaces a foreign
server pin. After physical reset, a new browser host session is saved before any
provisioning bundle is sent; old endpoint records remain retained. A failed or
interrupted setup can reconnect and resume with its saved host identity.

The transport implements the existing bounded COBS/CRC management framing with
DTR asserted, a 30-second command deadline, one outstanding request, and matching
command/sequence checks. Corruption, disconnect, or timeout ends the connection;
mutations are never automatically retried. Reconnect and inspect after uncertain
results. User actions drive exchanges; there is no background status polling.
The setup entropy bundle is a private demo command, not a public library or
protocol extension. No firmware changes are needed.

`//examples/fleet_manager:qtpy_serial_test` checks chunked framing, negative
statuses, sequence/CRC failures, deadlines, disconnects, and no automatic retries.
The existing manual `//examples/fleet_manager:browser_test` additionally runs the
production Wasm server and exact native firmware simulator through a Web Serial
stream fixture: enrollment, approval, persistence failure before provisioning,
lost-setup-response recovery, page reload, device reboot, full uint64 issuance,
foreign-host rejection, competing tabs, and reset/re-enrollment. A Firefox check
verifies the unsupported-browser message. These fixtures do not prove Windows
USB-driver behavior; physical Windows Chrome/Edge qualification remains required.
