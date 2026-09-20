# Application examples

Start here for small applications that consume the production Simple Crypts
APIs. The applications decide when to transmit and who may register; the
library owns authentication, enrollment state, credit invariants, and replay
handling. None of these examples uses fixture identities or test adapters.

| Project | What it demonstrates |
| --- | --- |
| [Fleet manager](fleet_manager/README.md) | A browser-local device registry, explicit enrollment approval, manual messages, and saved fleet state |
| [C++ device console](device_console/README.md) | A WebAssembly-only application with serial-style commands, embedded in the fleet webpage |
| [Python device console](python_device/README.md) | A native terminal application using the Python SDK and durable host storage |
| [Direct Python API](python_api.py) | A short, noninteractive SDK walkthrough |

The older `device_server_demo.py` is a test-harness demonstration of packet loss
and reboot. The [guided browser demo](../web/README.md) remains available
separately, with drag-and-drop packets and temporary state.

## Quick start

Follow the repository's [build prerequisites](../README.md#build-and-run), then:

```sh
python3 tools/bootstrap.py
bazel run //examples/fleet_manager:preview
```

Open `http://127.0.0.1:8001/`. Create a simulated device and follow the walkthrough
below the consoles. To use a terminal instead, choose **Add external device**
and run the Python command displayed for that serial. Copy hexadecimal frames
between the webpage and the terminal using `rx HEX` and `tx`.

The C++ application is **WebAssembly-only**; Python is the native console. Both
support the same command vocabulary, but each calls its own API boundary.

## Read the code

Each project README explains the application entry points. Shared browser
support lives in `common/`: `endpoint.c` implements the public C provider
contract; `endpoint.mjs` translates worker requests into awaited Wasm calls;
`storage.mjs` implements IndexedDB transactions. These files are platform glue,
not a second protocol implementation.

The fleet database belongs to the browser origin (including its port). Browser
refresh and normal close/reopen retain identities. Clearing site data removes
them; a saved Python device still pins its original server identity. There is
no remote service, account system, real UART, or automatic transport here.

## Check the examples

```sh
bazel test //examples/...
bazel test //examples/fleet_manager:browser_test --test_output=errors
```

The browser target uses the existing pinned Playwright installation and browser
engines described in [web/README.md](../web/README.md). It tests Chromium and
Firefox. Protocol tests also run the native Python console against a Wasm
server through its real stdin/stdout interface.
