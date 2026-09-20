# Application examples

Start here for small, documented applications consuming the production Simple
Crypts APIs. The application decides who may register and when to exchange
messages; the library supplies authentication, credit invariants, and replay
handling. These examples do not use fixture identities or test adapters.

| Project | What it demonstrates |
| --- | --- |
| [Fleet manager](fleet_manager/README.md) | A browser-local registry, explicit enrollment approval, interactive consoles, and saved fleet state |
| [C++ device console](device_console/README.md) | A WebAssembly device application with typed commands and a simulated connection to the fleet server |
| [Direct Python API](python_api.py) | A short, noninteractive SDK walkthrough |

The older `device_server_demo.py` demonstrates packet loss and reboot through
the test harness. The [guided browser demo](../web/README.md) remains available
separately for manually exploring packet delivery and attacks.

## Quick start

Follow the repository's [build prerequisites](../README.md#build-and-run), then:

```sh
python3 tools/bootstrap.py
bazel run //examples/fleet_manager:preview
```

Open `http://127.0.0.1:8001/`. **Create device**, **Authorize enrollment**, and
**Approve device**. Set issued credits to 100, type `consume 25` in its console,
and request a consumption report. The console shows the actual exchange; there
is no copy/paste transport and no external device application to launch.

## Read the code

`device_console/console.cpp` implements commands. `fleet_manager/worker.mjs`
owns the fleet and serializes actions. `fleet_manager/transport.mjs` exchanges
opaque frames and pauses enrollment for explicit approval. `app.mjs` renders
public state and the console transcript.

Shared browser support lives in `common/`: `endpoint.c` implements the public C
provider contract; `endpoint.mjs` makes awaited Wasm calls; `storage.mjs` supplies
atomic IndexedDB transactions. This is platform glue, not a second protocol.

The database belongs to the browser origin, including its port. Refresh and
ordinary close/reopen retain identities. Clearing site data removes them. There
is no remote service, account system, or physical UART in these examples.

## Check the examples

```sh
bazel test //examples/...
bazel test //examples/fleet_manager:browser_test --test_output=errors
```

The browser target uses the existing pinned Playwright installation and engines
from [web/README.md](../web/README.md). It tests the interactive workflow in
Chromium and Firefox. The production Wasm tests cover message exchange,
approval, exact counters, persistence failures, and nonce reservation safety.

## QT Py RP2040

The [QT Py RP2040 demo](embedded/qtpy_rp2040/README.md) builds a pinned UF2 firmware
and provides a Linux USB operator, erasable identity/state storage, and factory
reset. Entropy provisioning remains an application detail outside the protocol.
