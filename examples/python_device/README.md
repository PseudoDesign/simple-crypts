# Native Python device console

`console.py` is a small terminal application using the production Python SDK.
It creates its identity using OS randomness, enables signed enrollment, and
pins the server public key supplied at launch. Existing stores are resumed.

In the [fleet webpage](../fleet_manager/README.md), choose **Add external device**
and copy the displayed command. From the repository root, it looks like:

```sh
bazel run //examples/python_device:console -- \
  --serial python-001 \
  --store /tmp/simple-crypts-python-001 \
  --server-key SERVER_PUBLIC_KEY_HEX
```

Replace the key with the actual 64-character public key shown for this serial.
Choose a persistent private store outside `/tmp` if you want it to survive
system cleanup. Bazel supplies the SDK, CFFI, and native shared library; Python
does not launch a C or C++ adapter subprocess.

Commands match the browser C++ console:

```text
help
status
rx <hexadecimal frame copied from the server>
tx
consume 25
reboot
quit
```

`tx` prints a frame to paste into the server's receive field. `rx` only receives;
it never transmits. `consume` updates local durable consumption and leaves the
server's last reported consumption unchanged until a requested snapshot is
delivered. `status` prints JSON with uint64 totals as exact decimal strings.

The `DeviceConsole` class owns one `Endpoint`. Reboot closes and reopens that
endpoint with the same serial, storage directory, and pinned public key. The
host provider exclusively locks the store and checks identity binding. Invalid
stores and wrong keys produce errors; the application does not erase or replace
them. Use a separate store for each device and never copy an existing identity
store to create another device.

The native application accepts piped command lines as well as interactive
input. Ctrl-C, EOF, and `quit` close the endpoint. The protocol tests exercise
both direct command calls and a real Python process communicating with a Wasm
server through manually generated frames.
