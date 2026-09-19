# Live browser demo

The production C99 protocol core, nanopb, and libsodium 1.0.20 compile to a
WebAssembly module with checksum-pinned Emscripten 4.0.10. Vanilla ES modules
render the tour and sandbox. No server application, CDN, analytics, or runtime
package downloads are used. Only static assets are requested.

```sh
python3 tools/bootstrap.py
bazel build //web:site
bazel test //web:protocol_test //web:lab_test
bazel run //web:preview -- --port 8000
```

Open `http://127.0.0.1:8000/`. The compiler and Node.js need Linux x86-64;
Node.js 18+ is a system prerequisite, like the existing host C compiler.
The Emscripten archive and sysroot are declared Bazel action inputs. The build
uses the archive's frozen system-library cache, with no network access.

Browser acceptance tests use npm's committed lockfile:

```sh
npm ci --prefix web --ignore-scripts --no-audit --no-fund
PLAYWRIGHT_BROWSERS_PATH=/tmp/simple-crypts-browsers web/node_modules/.bin/playwright install chromium firefox
bazel test //web:browser_test --test_output=errors
```

The explicit `//web:browser_test` target is marked manual because browser
engines are separate development prerequisites; `bazel test //...` runs the
protocol, relay, and site-verification checks without them. Browser tests launch a loopback-only HTTP server and need permission to bind a
local socket. They test `/simple-crypts/` URL resolution, both browsers, the tour,
native drag/drop, touch dragging, keyboard selection, reflected/replayed messages,
focused guide visibility and one-destination gating, tampering, reordered reports, queue limits, reset during pending work, refresh,
UTF-8 validation, keyboard use, narrow layouts, and unavailable randomness.
Screenshots are written to `/tmp/simple-crypts-{browser}-{tour,mobile}.png`.
The Node/Bazel protocol tests additionally check native C interoperability in
both roles, byte-identical fixtures, full uint64 revisions, storage failures,
nonce reservation/reboot, and the production build's absence of test exports.

## Runtime boundary

Each endpoint has its own worker and Wasm instance. Workers serialize commands;
only public state and copied frames cross the application boundary. Identity
private keys stay inside the software provider. The common page is still a
trusted demo orchestrator, not a hostile security boundary or hardware keystore.
Initialization pins the server’s Ed25519 public key on the device. The demo
enables signed, server-initiated enrollment; there is no shared enrollment code. Secure browser randomness is required at
provisioning. Counter-based encryption and reboot use the retained keys without
requiring new random nonces.

The C bridge owns bounded in-memory storage. Record commits atomically replace
a snapshot, while direction-specific nonce reservations are monotonic and
separate. Reboot reinitializes the protocol context, preserving this storage.
Refresh/Reset destroys the session and generates new keys. Nothing is saved to
localStorage or IndexedDB. Wasm memory sizing is a browser build setting, not an
MCU resource estimate.

The message board shows each signed or encrypted frame as a box in its source outbox.
Drag its handle to either endpoint inbox, Hold, or Discard. Keyboard and touch
users can also select a box and activate a destination. A destination inbox
always invokes that endpoint, including attempts to reflect a message back to
its sender. State differences and rejection reasons come from the real library.

Device and server cards remain visible throughout the guide, showing their
public keys and private-key status (private bytes remain in the worker).
Provisioning adds the pinned server key to the device; successful enrollment
adds the registered device key to the server.

The six-step enrollment tour generates a device Ed25519 key pair, prepares the
pinned server identity, sends a signed server challenge, delivers an encrypted
device response, explicitly approves the serial/session/key binding, and delivers
the encrypted confirmation. X25519 keys are converted internally for NaCl box.
The existing trusted user-authentication mechanism is outside the demo; only
its authorize/approve decisions are shown. The response is staged and cannot
register a device before that separate approval action.

Each packet shows its actual size and wire bytes. The signed invitation is
public; response/confirmation details are a sender-side teaching view, not host
decryption. The server clock is virtual and held at 1000 during the guided tour;
sessions expire at 1600. Automated tests advance trusted time to test expiry.
Forms, history, and experiment controls
are hidden until Sandbox is opened. A successful drop shows a short result and
Continue; the next packet is generated only when Continue is activated. Wrong
drops leave the current packet untouched. Mouse dragging, touch dragging, and
keyboard selection all invoke the same delivery operation. On touchscreens, a
floating packet follows the finger and the entire destination entity accepts
the drop. Interrupted gestures leave the packet queued; tapping a packet and
then its inbox is also supported.
The latest 16 tried messages are retained for replay as independent copies.

The relay holds at most 64 copied frames. Full queues block new opportunities;
endpoints retain their latest pending state. The history retains the latest 200
events. No pings, retries, clock callbacks, or animation events transmit frames.
The guided tour explicitly invokes the same operations as the sandbox. Delivery
of an authenticated duplicate or stale snapshot can succeed without changing
application state. Transport acceptance alone does not establish convergence.

The test-only Wasm build adds deterministic provisioning, revision seeding, and
provider failure injection. It is never assembled into the published site.
Production provisioning cannot accept test seeds.

See [publishing instructions](../docs/publishing.md) for source attribution and
the separate recorded test report, whose original evidence remains unchanged.
