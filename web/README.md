# Live browser demo

The production C99 protocol core, nanopb, and libsodium 1.0.20 compile to a
WebAssembly module with checksum-pinned Emscripten 4.0.10. Vanilla ES modules
render the guided chapters and shared message log. No server application, CDN, analytics, or runtime
package downloads are used. Only static assets are requested.

The site also links to the [fleet application example](../examples/fleet_manager/README.md)
at `examples/fleet_manager/`. That example has persistent browser-local storage,
C++ WebAssembly consoles, and a native Python console counterpart. The temporary
storage behavior below describes the original guided demo only.

```sh
python3 tools/bootstrap.py
bazel build //web:site
bazel test //web:protocol_test //web:lab_test
bazel run //web:preview -- --port 8000
```

Open `http://127.0.0.1:8000/` for the project landing page. It introduces the libraries and links to `demo.html` (enrollment) and `demo.html#credits` (an enrolled pair ready for credits). The landing page loads no JavaScript or WebAssembly. The demo chapter bar links back home. The compiler and Node.js need Linux x86-64;
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
local socket. They test both chapters in Chromium and Firefox, corruption toggles,
replays and reflections, delayed responses, rejection recovery, bounded history,
and simulated touch dragging. Screenshots are written to
`/tmp/simple-crypts-{browser}-{chapter}-log.png` and `/tmp/simple-crypts-touch-log.png`.
The [browser coverage audit](../docs/browser-coverage.md) lists the checked behaviors, failure diagnostics, and remaining limits. Pages now runs browser acceptance against the exact committed site before deployment.
The Node/Bazel protocol tests additionally check native C interoperability in
both roles, byte-identical fixtures, full uint64 revisions, storage failures,
nonce reservation/reboot, and the production build's absence of test exports.

## Runtime boundary

Each endpoint has its own worker and Wasm instance. Workers serialize commands;
only public state and copied frames cross the application boundary. Identity
private keys stay inside the software provider. The common page is still a
trusted demo orchestrator, not a hostile security boundary or hardware keystore.
Initialization pins the server’s Ed25519 public key on the device. The demo
enables signed, server-initiated enrollment; there is no shared enrollment code. Secure browser randomness is required for identity generation. Counter-based encryption and reboot use the retained keys without
requiring new random nonces.

The C bridge owns bounded in-memory storage. Record commits atomically replace
a snapshot, while direction-specific nonce reservations are monotonic and
separate. Reboot reinitializes the protocol context, preserving this storage.
Refresh/Reset destroys the session and generates new keys. Nothing is saved to
localStorage or IndexedDB. Wasm memory sizing is a browser build setting, not an
MCU resource estimate.

Both chapters use one draggable message log. Drag a packet onto either endpoint
to deliver it; drag a saved attempt again to replay it. The corruption button
flips/restores a wire byte. The page shows actual status codes and explains
rejections. Duplicates may return success with no state change. Leaving a packet
in the log withholds delivery; there is no receiver call or fabricated timeout.
The explicit server-clock button advances simulated time by 601 seconds to cross
the ten-minute session deadline. Expiry is checked when a response arrives.

The guide starts with server authorization and a signed public challenge. Before
creating a device identity, the demo's C bridge verifies the signature against the
pinned server key, frame structure, serial, and nonzero challenge/expiry. The next
action generates the device key and encrypted response. A domain-separated keyed
BLAKE2b hash mixes the verified invitation with 32 fresh secret random bytes; its
32-byte output seeds libsodium's Ed25519 keypair function. Temporary secret inputs
are wiped. The public challenge adds session diversity, **not secret entropy**:
it cannot repair predictable local randomness. Missing browser randomness fails
closed. This is a demo provider extension, not a change to the C protocol API.

The server stages the response until the application authorizes the exact
serial/session/key binding, then emits an encrypted confirmation. Enrollment
contains no application measurement; the credit group starts at zero. X25519 keys
are converted internally for NaCl box. User authentication is outside the demo.
Device and server cards remain visible with public keys and private-key status.
Packet details for ciphertext are the sender's teaching view, not host decryption.

A rejection offers Restart enrollment. Before registration this cancels the
server session and clears the message log, retaining any generated device key;
the next authorization creates a fresh challenge. After registration it starts a
fresh demo session, like Reset. The device does not regenerate an existing key
on subsequent challenges. Mouse, touch, and pen use the same drag delivery path;
tapping a recipient does not deliver a packet.

The relay holds at most 64 copied frames. Full queues block new opportunities;
endpoints retain their latest pending state. The history retains the latest 200
events. No pings, retries, clock callbacks, or animation events transmit frames.
The guided tour and message log invoke the same endpoint operations. Delivery
of an authenticated duplicate or stale snapshot can succeed without changing
application state. Transport acceptance alone does not establish convergence.

The test-only Wasm build adds deterministic provisioning, revision seeding, and
provider failure injection. It is never assembled into the published site.
Production provisioning cannot accept test seeds.

See [publishing instructions](../docs/publishing.md) for source attribution and
the separate recorded test report, whose original evidence remains unchanged.

## Credit walkthrough

Both chapters continue through cumulative issuance, its captured report and
receipt, local consumption without transmission, and a new requested report.
The server panel labels consumption as last reported. Replay and corruption
controls operate on the same real library messages. `resources.mjs` supplies
labels from the build-time resource definition. JavaScript passes uint64 values
as exact strings/BigInt, never floating-point numbers. The recorded `/report/`
evidence remains a separately attributed historical snapshot.

Establish Trust ends at confirmation with suggestions to corrupt and replay saved packets or advance server time. Completed enrollment stays valid after time advances; reset the session and delay its response to explore expiration. The Credits chapter reuses a freshly enrolled pair when reached from enrollment, or completes a real local enrollment as setup when opened directly. Only credit packets appear in its message log.

In Credits, + beside server issuance adds 100 and + beside device consumption spends 25. After the exchange, users press + until a debit is rejected, drop a new grant, request a retry, and deliver that retry twice. Dropping calls no receiver and returns no fabricated library error; retries remain pending and duplicates do not add credits. A report and receipt settle the exchange before users can restart the exercise.
