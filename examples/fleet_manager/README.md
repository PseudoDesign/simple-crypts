# Browser fleet manager

A barebones fleet application built with HTML, CSS, ES modules, and the real C
protocol compiled to WebAssembly. The server and registry run locally in a
worker; IndexedDB is the saved database for this browser origin.

```sh
bazel build //examples/fleet_manager:site
bazel run //examples/fleet_manager:preview -- --port 8001
```

Open `http://127.0.0.1:8001/`. HTTPS and localhost provide the secure browser
context required for randomness and Web Locks. The static bundle is generated
at `bazel-bin/examples/fleet_manager/site`. It is also included under
`examples/fleet_manager/` in the existing `//web:site` bundle.

## Manual walkthrough

1. **Create simulated device** opens a C++ WebAssembly console. Alternatively,
   **Add external device** displays a native Python launch command. Adding a
   registry entry does not approve registration.
2. **Authorize / restart enrollment** opens a ten-minute session. **Generate
   next frame**, copy the challenge, and type `rx HEX` in the device console.
3. Type `tx` on the device. Copy its frame to **Paste device frame** and click
   **Receive pasted frame**. The server now shows a candidate, still unregistered.
4. Compare the candidate key with the public key printed by device `status`.
   **Approve displayed candidate** binds the exact serial, challenge, and key.
   Generate the server confirmation and deliver it with device `rx HEX`.
5. Set **Cumulative credits issued** to `100`. Generate and deliver the server
   frame, then the device's `tx` response, then the server's `tx` receipt.
6. Run `consume 25`. Device consumption becomes 25; server **last reported
   consumed** stays 0. Device `tx` has no output solely because of consumption.
7. **Request consumption report**, then repeat the server → device → server →
   device exchange. Server consumption now reads 25.

Every transmission requires `tx` or **Generate next frame**. Nothing automatically
delivers, retries, or acknowledges a frame. Re-copy a saved frame to explore
replay handling. Leaving a frame undelivered simulates loss. Receiving an old or
duplicate frame may succeed without changing state.

## Application boundaries

- `app.mjs` renders public snapshots, console output, and copied frames. It never
  handles private checkpoints. Each console keeps only its latest 200 log entries.
- `worker.mjs` owns the fleet, serializes operations, and holds the exclusive
  fleet Web Lock before loading storage. A second tab shows an error until the
  owning tab closes. Each endpoint has its own Wasm memory and independent key.
- Each serial has a **separate server identity**, matching the library's
  one-peer-per-context API. The native device must pin that serial's displayed
  public key. There is no shared-key nonce allocator across the fleet.
- `../common/endpoint.c` implements the public `sc_provider` interface using
  libsodium and versioned saved records. `../common/storage.mjs` owns IndexedDB
  transactions. The existing guided demo retains its separate in-memory provider.

The server's issuance field is an absolute cumulative total, not a credit
increment. Values travel as decimal strings/BigInt, never floating-point
numbers. The server only knows authenticated requested snapshots, not a live
device's unreported consumption.

## Persistence and recovery

Version 1 checkpoints encode the role, serial, pinned key, identity, core record,
record generation, and nonce reservation high-water marks. They contain no
pointers or runtime nonce cursors. Restart invokes normal `sc_init`, so unused
values in a previous reservation are burned. Keys are software keys in local
browser storage; this example is not a hardware keystore.

The C callbacks use Asyncify to await IndexedDB transaction **completion** with
strict durability requested. Record commits and nonce reservations are separate
atomic writes. A failed later commit cannot roll back a completed reservation.
Failed storage stops that endpoint; reload after resolving the storage problem.
Missing, truncated, or incompatible records never create replacement identities.

Creation reserves a registry row before generating identities. An interrupted
creation stays visible as an incomplete entry rather than silently starting over.
There is no migration, identity export/import, or destructive reset button. For a
fresh disposable demo, deliberately clear this origin's site data in browser
settings; existing Python stores will still pin their old server keys.

An enrollment confirmation is transient protocol work. If the server reloads
after approval but before the device receives confirmation, resend the device's
enrollment response, then generate the server confirmation again. A stopped
browser device can be started with its original identity and credit state.

Changing the preview port changes the browser origin and therefore its saved
fleet. Local logs/outbound text are temporary; identities and protocol state
survive refresh. There is no cloud backend, automatic exchange, physical serial
port, user authentication, or revocation in this example.

## Validation

```sh
bazel test //examples/fleet_manager:protocol_test //examples/python_device:console_test
bazel test //examples/fleet_manager:browser_test --test_output=errors
```

Protocol tests use production modules, including real Python/Wasm interoperability,
exact uint64 values, approval, replay, expiration, storage failures, nonce safety,
and restart. Browser tests exercise actual IndexedDB, competing tabs, corrupt
stores, console lifecycle, manual exchange, and a narrow viewport in Chromium
and Firefox. Browser artifacts default to `/tmp/simple-crypts-fleet-browser`.
