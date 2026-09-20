# QT Py RP2040 demo

This application runs the existing Simple Crypts device endpoint on an Adafruit
QT Py RP2040 (product 4900), with a Linux USB operator using the production Python
SDK as the server. Entropy, provisioning bundles, USB framing, flash management,
and reset are **private demo implementation details**. The library API, provider
interfaces, schemas, signed invitations, and protocol frames are unchanged.

Implementation started from upstream `main` at
`2d6581d3dc6cfa9ea1b9b330734ce9fdb21a5a14`. The supplied workspace had no usable Git
metadata, so its tracked files were synchronized byte-for-byte against that
immutable upstream archive before changes began; no Git pull or branch operation
was possible in this workspace.

## Build and flash

Install Bazel **9.2.0**, then from the repository root:

```sh
bazel build --config=qtpy //examples/embedded/qtpy_rp2040:firmware --lockfile_mode=error
```

Firmware compilation does not require `tools/bootstrap.py`, a system Arm compiler,
CMake, picotool, libusb, pioasm, or an installed Pico SDK. Bazel downloads and checks
Pico SDK 2.3.1, Arm GNU 13.2.Rel1, CPython 3.11.14, TinyUSB, libsodium 1.0.20, and
nanopb 0.4.9.1.bcr.3. MODULE.bazel and its lockfile pin the dependencies; the SDK's
five compiler archives are checksum pinned. Python generators execute with the
**execution-platform** interpreter, without building native launcher binaries.
The small SDK patch only changes build actions; the nanopb patch exports its
header include directory. The libsodium MCU configuration and source subset are
separate from the existing host build.

Outputs in `bazel-bin/examples/embedded/qtpy_rp2040/`:

- `demo.elf`, `demo.bin`, `demo.uf2`;
- `image-report.json`: sections, symbols, flash/RAM sizes, stack bounds, versions,
  and BIN/UF2 hashes;
- `symbol-map.txt`: ordered ELF symbol addresses (not a GNU linker cross-reference map).

The build checks the ROM boot2 checksum, initial stack/reset vectors, 256-byte
boot2 location, every loadable flash segment, the 32 KiB main-SRAM stack, and the
Pico `__aeabi_lmul` wrapper used by portable crypto. Core 0 runs the application;
core 1 stays parked. No LTO or random-nonce Ed25519 signing is enabled.

Hold **BOOT**, press and release **RESET**, then release BOOT to enter the ROM
`RPI-RP2` drive. Select its actual mount explicitly. Either copy `demo.uf2` to that
drive or, after the normal host bootstrap below, use the validating helper:

```sh
bazel run //examples/embedded/qtpy_rp2040:flash -- \
  --mount /media/YOUR_USER/RPI-RP2 \
  /ABSOLUTE/PATH/TO/demo.uf2
```

The helper verifies the RP2040 family, block counts/order, addresses, boot code,
and the mount's `INFO_UF2.TXT` before opening its output. It cannot distinguish
one physical RP2040 board from another: selecting the mount is the operator's
responsibility. It writes only this application's flash range. Firmware reflashes
preserve the demo's final three sectors. Do not use a chip-erase/flash-nuke image
when preserving identity or counters matters. Initial installation replaces any
existing CircuitPython/application image; it does not preserve that application's
filesystem or provide a CircuitPython backup.

## Run the demo (Linux host)

The operator and simulator reuse the repository's existing native host build,
which has system prerequisites and is distinct from the hermetic firmware build.
Follow [CONTRIBUTING.md](../../../CONTRIBUTING.md), including
`python3 tools/bootstrap.py`, for that environment.

Choose the CDC port explicitly, preferably its stable `/dev/serial/by-id/` path.
Keep the host store; it contains the server identity and enrollment state. Run
these commands, substituting the actual port and an absolute private directory. If a first
installation finds incompatible contents in the reserved sectors (`fault=1`),
use the reset procedure below before setup; do not overwrite an existing identity
implicitly.

```sh
bazel run //examples/embedded/qtpy_rp2040:operator -- --port /dev/ttyACM0 --store /ABSOLUTE/demo-host inspect
bazel run //examples/embedded/qtpy_rp2040:operator -- --port /dev/ttyACM0 --store /ABSOLUTE/demo-host setup
bazel run //examples/embedded/qtpy_rp2040:operator -- --port /dev/ttyACM0 --store /ABSOLUTE/demo-host approve
bazel run //examples/embedded/qtpy_rp2040:operator -- --port /dev/ttyACM0 --store /ABSOLUTE/demo-host issue 100
bazel run //examples/embedded/qtpy_rp2040:operator -- --port /dev/ttyACM0 --store /ABSOLUTE/demo-host consume 25
bazel run //examples/embedded/qtpy_rp2040:operator -- --port /dev/ttyACM0 --store /ABSOLUTE/demo-host status
```

Expected device counters are issued=100, consumed=25, leaving **75**. `issue` sets
the **cumulative issued total**, rather than adding that many credits. `status`
requests a fresh protocol round trip and can write flash. `inspect` only reads
local diagnostics and never writes flash; after reboot, its protocol counters
and registration flag are not loaded until `ready=1`. It also reports JEDEC ID,
snapshot sequence, nonce high-water mark, per-boot write/erase counts, and observed
stack high-water bytes (including a conservative marking margin).

On reboot the board waits for fresh host startup entropy. A normal `status`,
`enroll`, `issue`, or `consume` supplies it and restores the existing identity.
USB reconnection never generates a replacement device key. `enroll` resumes an
unapproved enrollment with a fresh signed challenge; `approve` is a separate
explicit operator action. If the host store is lost or belongs to another board,
the CLI fails rather than silently changing the board's trusted server.

Commands time out after 10 seconds. A timeout/disconnect can mean an operation
committed but its response was lost. Mutating commands are never automatically
retried. Reconnect, inspect/obtain fresh status, and reconcile the cumulative
counters before deciding on another consume or reset. CDC is binary, has no log
output, and disables CR/LF translation and the SDK's USB reset shortcuts.

## Entropy and identity boundary

Each boot accepts 32 fresh bytes from the host OS CSPRNG into a finite private
libsodium randombytes pool. Real `sodium_init()` consumes its 16-byte canary;
the remaining pool is immediately wiped and closed. A request while unseeded,
exhausted, or closed wipes and resets the MCU without returning bytes. The core
provider's random callback returns `SC_ERR_RANDOM`; ordinary device operation
uses deterministic signing and durably reserved counters, not new randomness.
This build deliberately requires a trusted host after each boot.

Initial `setup` privately bundles:

```
startup entropy[32] | identity seed[32] | trusted server public key[32] |
existing signed enrollment invitation[172]
```

The two random values are independent. Before creating a key, the demo checks
the invitation signature, pinned server, board serial, and nonzero challenge and
expiry. The server enforces invitation expiry during approval; the board has no
trusted wall clock. The identity seed keys BLAKE2b-256 over the exact domain
`simple-crypts/demo/device-identity/v1` followed by the entire verified invitation.
That output seeds Ed25519 key generation. The keypair and server pin are committed
before library initialization or outbound enrollment traffic. On the MCU, temporary seeds,
hash state, and transport buffers are wiped after use. The Python host does not
guarantee heap zeroization. Raw seeds are never CLI
arguments, logs, firmware constants, or persisted records.

This is trusted-host provisioning: anyone capturing the seed and invitation can
reconstruct the identity. Plain USB is not a confidential/authenticated management
channel, and external flash stores the device secret without readout protection.
The demo supplies neither device-only key provenance nor physical anti-rollback.
Do not add entropy fields to protocol messages, public configuration structures,
or provider interfaces to extend this demo.

## NVM, recovery, and endurance

Only JEDEC `ef4017` (Winbond) or `c84017` (GigaDevice), both 8 MiB configurations,
enable storage. An unknown part exposes read-only diagnostics and refuses flash
operations. Identify and qualify the actual fitted part/revision before extending
that allowlist. See the [hardware audit](../../../docs/qtpy-rp2040-demo-audit.md)
for the board and flash references.

| Region | Flash offset | XIP address | Size |
| --- | --- | --- | --- |
| Application | `0x000000` | `0x10000000` | At most `0x7fd000` |
| Snapshot A | `0x7fd000` | `0x107fd000` | 4096 bytes |
| Snapshot B | `0x7fe000` | `0x107fe000` | 4096 bytes |
| Reset intent | `0x7ff000` | `0x107ff000` | 4096 bytes |

Snapshots alternate sectors. Each update erases one sector, programs/verifies
15 body pages, then programs/verifies one dedicated commit page. Bodies contain
identity, trusted peer, serialized core state/generation, and nonce reservation
high-water mark. Snapshot sequence and core generation are separate. State
commits retain reservations; reservations retain state. Reboot burns unused
members of the core's 32-counter reservation. An ambiguous nonblank commit page,
CRC failure, or readback failure stops protocol work instead of rolling back to
an older nonce range. CRC detects accidental corruption, not malicious editing.

Observed device writes in the simulator with one settled exchange per command:

| Operation | Snapshot writes | Bytes programmed |
| --- | ---: | ---: |
| Initial setup, through pending approval | 6 | 24,576 |
| Approve | 1 | 4,096 |
| Issue a new cumulative total | 3 | 12,288 |
| Consume | 1 | 4,096 |
| Fresh status exchange | 3 | 12,288 |
| Inspect or fresh startup entropy alone | 0 | 0 |
| Reserve the next 32 outgoing nonces | 1 additional | 4,096 |

Retries, enrollment restarts, and rebooting with unused reservations change these
counts. The counters in `inspect` are per boot, not a guaranteed lifetime wear
meter. Conditional on the fitted part's **100,000 erase-cycle** rating and its
specified operating conditions, two evenly alternating sectors budget about
**200,000 snapshot writes**. A repeated issue/consume/status cycle costs 7 writes
plus reservations (typically 2 outgoing frames/32), giving approximately
`200000 / (7 + 2/32) = 28,300` cycles before setup, resets, retries, retention, and
qualification margins. This is an engineering budget, not a lifetime guarantee.
There is no persistent entropy/DRBG state and no per-boot entropy write.

To factory-reset the **demo**, run the operator's `reset` action, or hold the
runtime BOOT button (GPIO21) for five seconds. Reset first writes and verifies an
intent marker, erases/verifies both identity/state sectors, then erases/verifies
the marker, wipes RAM, and reboots. Any nonblank intent sector on boot resumes
that erasure before processing protocol work. A reset normally uses one page
program and one erase per sector. Afterwards, `setup` creates new device and
server identities in a fresh host session; old host sessions remain available
for inspection. A power cut before any marker byte is written may leave the old
identity intact, so verify reset completion before provisioning again.

“Factory reset” here means restoring an unprovisioned demo. It does not restore
the vendor's original application. ROM BOOTSEL recovery remains available for a
bad application image. No OTP, security-register programming, permanent locks,
or chip erase are introduced. The SDK's existing boot2 may perform reversible
flash status/QE setup; this is not a promise of zero flash status-register writes.

## Verification and remaining hardware qualification

```sh
bazel test //examples/embedded/qtpy_rp2040:store_test \
  //examples/embedded/qtpy_rp2040:entropy_test \
  //examples/embedded/qtpy_rp2040:image_test \
  //examples/embedded/qtpy_rp2040:integration_test --lockfile_mode=error
python3 examples/embedded/qtpy_rp2040/qualify.py --bazel bazel --output /tmp/qtpy-fresh-check
```

The locally verified Linux x86-64 firmware uses **182,164 bytes of flash**,
**29,468 bytes of static main SRAM**, and a separately reserved **32,768-byte
stack**. Its UF2 SHA-256 is
`3928092a6dc4151831902904766a8564d6896831864c7e983224399b773a6626`.
Two clean output bases produced identical ELF, BIN, UF2, and reports. These are
build results, not evidence that a physical board has been exercised.

The storage test injects cuts before, during, and after each erase/program in
snapshot and reset transactions. The process-based simulator exercises the exact
application, finite RNG, flash store, COBS/RPC codec, production Python server,
explicit approval, credit exchange, reboot, recovery from a process killed
immediately after identity persistence but before core initialization, enrollment
resume, and identity
rotation on reset. It is not a Pico SDK or electrical simulator.

`qualify.py` uses two fresh output bases, fetches declared dependencies first,
builds with Bazel downloads disabled, compares ELF/BIN/UF2/reports, and saves the
Bazel action graph. It does not claim to disconnect the machine's network.
The [CI workflow](../../../.github/workflows/qtpy.yml) runs this on Linux x86-64
and Arm64, macOS Intel and Arm64, and Windows x86-64 using checksum-pinned Bazel
executables. These runner labels follow the
[GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Only locally executed hosts should be called qualified; adding the matrix does
not establish that its remote jobs have passed.

Before treating this as a demonstrated board build, run these physical checks:

1. Record the fitted JEDEC ID, flash markings, firmware hashes, and serial port.
2. Flash through BOOTSEL, verify the startup wait, then run the 100/25/75 sequence.
3. Reboot/reconnect and repeat status: identity and credits must survive; nonce
   reservations must advance. Reflash the same UF2 and verify the same state.
4. Exercise USB loss during mutation, full/oversized/truncated packets, and power
   cuts during flash/reset. Ambiguous storage must refuse protocol work.
5. Exercise both reset methods, confirm identity rotation, and recover with
   BOOTSEL after a bad application. Confirm the reset marker resumes after a cut.
6. Record maximum stack high-water, operation latency, and USB behavior during
   flash erasure and crypto. The 32 KiB reservation and host tests do not prove a
   worst-case embedded call-stack bound or physical flash timing.
