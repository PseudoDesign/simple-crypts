# Demo feasibility audit: Adafruit QT Py RP2040

Researched 2026-09-20. Status: feasible candidate, with build probes completed;
no firmware installed or board behavior tested. “QTPY2040” is interpreted as
the **Adafruit QT Py RP2040, product 4900**.

The recommended demo uses the existing C library and signed enrollment profile,
Pico SDK's native Bazel support, USB CDC, and erasable external flash. It keeps
the no-OTP and factory-reset requirements from the
[STM32 implementation plan](stm32wba65-demo-plan.md). This audit does not replace
that agreed plan or add Bazel linting/style work.

The main design decision is **trusted-host provisioning and fresh host-supplied
entropy at every boot**. The stock RP2040 randomness facilities do not satisfy
our cryptographic provider contract. Autonomous generation of device-only
secrets would require a separately qualified entropy source.

## 1. Hardware fit and differences

| Area | QT Py RP2040 | Consequence for this demo |
| --- | --- | --- |
| CPU | Dual Cortex-M0+, approximately 125 MHz; no FPU | Start with core 0 only; rebuild all code for M0+ and soft float. |
| Memory | 264 KiB SRAM; 8 MiB external QSPI flash | Capacity appears adequate; flash operations interrupt execution from flash. |
| Transport | Native USB-C | Firmware must run TinyUSB; no independent ST-LINK serial bridge. |
| Recovery | ROM USB BOOTSEL and UF2 | A broken application can be replaced through BOOT + RESET. |
| Buttons | RESET and BOOT; BOOT also connects to GPIO21 | Use a runtime long press for application reset, separate from ROM recovery. |
| Debug | No normal exposed SWD pads/header in the inspected PCB | Plan initial bring-up through USB and UF2. |

These are board-specific findings from the [Adafruit overview][adafruit],
[button guide][buttons], and [published schematic][schematic]/[layout][layout].
This is not the Trinkey QT2040. The SDK already defines
`adafruit_qtpy_rp2040`, including its 8 MiB size, crystal startup delay and
W25Q080-compatible second-stage bootloader. Preserve that configuration.
[SDK board header][board]

The public schematic labels the flash only “8MB QSPI Flash.” Adafruit's
[CircuitPython board configuration][cpconfig] supports **W25Q64JVxQ** and
**GD25Q64C**. The actual chip and temperature grade on the user's board remain
unverified; do not turn one candidate's endurance specification into an
unconditional board guarantee.

## 2. Bazel build route

Prefer **Pico SDK's first-party Bazel rules and toolchains** over wrapping CMake
or rebuilding its startup/linker integration ourselves. Keep the repository's
Bazel 9.2.0 baseline and the proposed `rules_cc` 0.2.25 / `platforms` 1.0.0
alignment. Resolve `platforms` through BCR; do not maintain a local source snapshot.

The selected research pin is **Pico SDK 2.3.1**, released 2026-09-04. At audit
time the Bazel Central Registry still offers 2.3.0, so use a checksummed archive
override for 2.3.1 rather than assuming it is already registered.
[SDK release][sdkrelease], [BCR entry][bcr]

| Input | Pin |
| --- | --- |
| Pico SDK commit | `079c6f39023649b154152db30f1d781e884879bc` |
| Release archive | `https://github.com/raspberrypi/pico-sdk/releases/download/2.3.1/pico-sdk-2.3.1.tar.gz` |
| SHA256 | `4cd9f1f36feb34b6853ca866b5e0d977e3d344a361b9b7c94ae383693303591a` |
| Archive prefix | `pico-sdk-2.3.1` |
| SDK Arm compiler | Arm GNU 13.2.Rel1, archive checksums supplied by SDK |
| SDK TinyUSB commit | `86ad6e56c1700e85f1c5678607a762cfe3aa2f47` |
| SDK picotool dependency | 2.3.0 |

The [SDK module][sdkmodule] provides Arm compiler archives for Linux x86-64 and
AArch64, macOS Intel and Apple Silicon, and Windows x86-64. Compiler availability
does not establish a working build on all five hosts: the SDK's own
[Bazel CI configuration][sdkci] excludes Windows as currently broken.
Retain five-host firmware builds as an acceptance goal, with explicit work to
prove or repair Windows support. Linux remains the initial CLI/flashing host.

### What was actually built

An isolated temporary workspace successfully built:

- A minimal QT Py ELF using Bazel 9.2.0 and the unpatched SDK 2.3.1.
- A USB-stdio variant and UF2 using the SDK's official UF2 aspect.
- A 256-byte `.boot2` section and an ARMv6-M, Thumb-1, soft-float image.
  The UF2 was 119,808 bytes, with RP2040 family ID `0xe48bff56` and its first
  payload at `0x10000000`.

The USB/UF2 build completed 275 actions, including 234 Linux-sandbox actions.
Resolved dependencies included `rules_python` 1.7.0, downloaded CPython 3.11.14,
`bazel_skylib` 1.9.0 and `picotool` 2.3.0. These are observed probe resolutions;
record and lock the final repository graph during implementation.

This establishes Linux build feasibility, **not a complete hermetic application**.
The probe allowed automatic discovery of the native C++ compiler for host
utilities. The repository disables that discovery, so it needs an explicitly
registered native compiler toolchain in addition to the embedded compiler.
It also needs a declared Python runtime for boot2 checksum and generation
steps. UF2 conversion runs host picotool, which brings libusb and native C++
runtime dependencies; define the supported host runtime as part of the build
contract. SDK shell/batch generation actions also need declared tools or
replacement rules. [Picotool build][picotoolbuild], [boot2 pipeline][boot2build]

For reference, after the module/archive override and toolchain registration,
the minimal `cc_binary` probe depended on `@pico-sdk//src/rp2_common/pico_stdlib`
and used this command:

```text
bazel build //:hello.elf \
  --platforms=@pico-sdk//bazel/platform:rp2040 \
  --@pico-sdk//bazel/config:PICO_BOARD=adafruit_qtpy_rp2040 \
  --@pico-sdk//bazel/config:PICO_STDIO_USB=true \
  --@pico-sdk//bazel/config:PICO_STDIO_UART=false \
  --aspects=@pico-sdk//tools:uf2_aspect.bzl%pico_uf2_aspect \
  --output_groups=+pico_uf2_files
```

This is a starting point for a smoke-build workspace, not a target
already added to this repository. It does not include the proposed application,
custom partition or entropy adapter. [UF2 aspect][uf2aspect]

### Remaining build integration

1. Add standard `CcInfo` targets for the existing core, nanopb and sodium
   provider, sharing their sources with other builds. Compile libsodium's
   portable sources with a reviewed MCU configuration; do not reuse host or
   Cortex-M4/M33 archives or run configure/Make inside firmware actions.
2. Register the SDK's RP2040 toolchains explicitly. They are SDK development
   registrations and are not automatically inherited by a consuming module.
   Use the board setting `PICO_BOARD=adafruit_qtpy_rp2040` and matching RP2040
   platform. Compile/link ABI must be Cortex-M0+, Thumb, soft float; no M33
   FPU flags or LTO.
3. Pin all tools and transitive dependencies, including Python, native C++
   tools, TinyUSB and UF2 tooling. Replace required git fetches with checksummed
   archives or vendor the resolved repositories; `git_repository` needs system
   Git and does not use Bazel's download repository cache. Keep unrelated
   wireless dependencies out of the required build closure.
   [Bazel git repository documentation][bazelgit]
4. Supply an explicit linker layout. The SDK's Bazel linker default remains
   **2 MiB** unless overridden; the board's 8 MiB macro alone does not expand it.
   Reserve the NVM range below and assert every loadable segment/UF2 block
   stays outside it. Include data copied into SRAM in that check.
   [SDK default linker configuration][sdklink]
5. Emit ELF, UF2, BIN/HEX as useful, linker map, size and stack reports, and an
   input/configuration manifest. Make postprocessing tools declared inputs.
6. Remove the repository-wide `/tmp` output setting for portable builds.
   Verify clean/offline builds after dependency preparation, path independence,
   repeatability, and all five native hosts. Distinguish firmware byte equality
   from ELF debug-path differences.

Do not automatically replace the STM32 plan's toolchain choice. A shared Arm
compiler cache is optional; each board's platform constraints and startup/link
rules must resolve without competing toolchain registrations.

## 3. Library and cryptography fit

The same C99 core, 512-byte frame limit, Ed25519 identities, NaCl box profile,
signed enrollment and Python server can be retained. Board-specific work is in
transport, key storage, random bytes, durable state and startup. Preserve the
[provider contracts](platforms.md) and one-owner execution model.

A separate Cortex-M0+ link probe compiled 82 C files using Arm GNU 13.2.1,
including the portable libsodium 1.0.20 closure, real `sodium_init`, signed
provider, core and nanopb:

| Measurement | Bytes |
| --- | ---: |
| Linked text | 141,244 |
| Initialized data | 2,592 |
| BSS | 6,056 |
| `sizeof(sc_context)` | 3,648 |
| `sizeof(sc_state)` | 2,056 |
| Maximum encoded core record | 1,408 |

This was a **nonhermetic, link-only feasibility experiment** with a nonreturning
RNG stub and a synthetic linker layout. It excludes Pico startup, USB, flash
storage and the real randomness adapter. The size rows are not additive RAM
requirements, and none measure peak stack or execution time. Use an initial
32 KiB stack reservation and measure the complete application on hardware.
Place that stack in explicitly reserved main SRAM and update the linker stack
symbols and overlap assertions. The SDK's default core-0 stack placement is
the 4 KiB scratch-Y bank; merely increasing a stack-size macro will not provide
a valid 32 KiB allocation. [SDK stack placement][sdkstack]
The probe used `-Os -mcpu=cortex-m0plus -mthumb -mfloat-abi=soft -fno-lto`,
disabled OS/unsupported CPU features, retained the portable minimal source
closure and explicitly selected its custom randomness implementation.

There is a specific compiler-runtime concern to address. In the probe,
libsodium field arithmetic called libgcc's `__aeabi_lmul`, whose implementation
has an operand-dependent carry branch. The SDK supplies a straight-line
replacement through [`pico_int64_ops`][int64ops]. Add that dependency explicitly
and inspect the final ELF to verify multiplication calls are wrapped as intended.
Its wrapper covers `__aeabi_lmul`, the entrypoint emitted by this probe;
it does not independently wrap the `__muldi3` alias.
This does not establish general side-channel resistance: libsodium explicitly
describes Cortex-M0/M3/M4 use as untested and unsuitable where side channels are
a concern. [Libsodium MCU guidance][sodiuminstall]

### Entropy and provisioning recommendation

RP2040's datasheet says its ROSC random-bit facility does not meet security
randomness requirements. SDK `pico_rand` combines several inputs with a
software PRNG; it is not an acceptable drop-in for the library's cryptographic
randomness contract. Flash unique IDs, timers and serial numbers are also not
secret seeds. [RP2040 datasheet, section 2.17.5][rp2040],
[SDK random implementation][picorand]

For this USB-connected demo, use this explicit trust model:

1. Bring up minimal USB management before cryptographic initialization. The
   Linux provisioning host and its direct USB connection are trusted with
   secrets; the provisioning exchange is outside the untrusted relay boundary.
2. At every boot, the host supplies fresh cryptographic seed material from its
   OS CSPRNG. Seed a reviewed standard cryptographic generator adapter, then
   register it with libsodium before calling the real `sodium_init`. The adapter
   and its dependency/configuration remain an implementation design item;
   do not invent a PRNG or use zero-filled stubs.
3. Initial provisioning uses separate fresh material for the device identity.
   Persist the identity and pinned server key before use. Existing identities
   survive ordinary reboot; the fresh boot seed is temporary RAM state and
   does not require an additional flash write. The trusted host can know the
   device's secret material under this model.
4. Until seeding succeeds, reject protocol work. Define generator exhaustion
   and failure behavior explicitly; never fall back to ROSC or predictable
   values. Do not allow arbitrary reseeding/rekeying through relay messages.
5. Established encryption continues to use durable counter nonces, with the
   existing reservation size of 32. It does not require fresh per-message
   entropy. Factory reset erases identity/state and waits for fresh provisioning.

Use separate fresh 32-byte seeds for startup and initial identity provisioning;
keep them out of source files, build outputs, logs and reusable configuration.
Retain sodium's initialization closure: it initializes randomness and a random
allocator canary even when protocol operations need no random bytes. Defining
`RANDOMBYTES_CUSTOM_IMPLEMENTATION` alone is insufficient; explicitly select
the custom default rather than retaining the OS sysrandom reference.
See the repository's [initialization source](https://github.com/jedisct1/libsodium/blob/1.0.20-RELEASE/src/libsodium/sodium/core.c)
and [randomness dispatch](https://github.com/jedisct1/libsodium/blob/1.0.20-RELEASE/src/libsodium/randombytes/randombytes.c).

This deliberately makes usable startup dependent on the trusted USB host.
A qualified external RNG, or a board with a suitable entropy peripheral, can
support autonomous boot and device-only key generation. Autonomous reboot
after trusted-host provisioning can also use the persistent RNG design below;
it does not make the initial device secret unknown to the provisioning host.

### Bundling provisioning with the enrollment challenge

The host can present initial provisioning and enrollment as one operation.
Send the unchanged signed invitation alongside a **separate secret 32-byte
provisioning seed** in a trusted USB management envelope. The envelope is not
a relay-visible protocol packet. Never derive the private key from the public
challenge alone: anyone who receives that challenge could derive the same key.
A signature authenticates the invitation but does not hide its contents.

The browser already verifies an invitation and derives a device identity by
mixing it with fresh secret randomness using keyed BLAKE2b. The QT Py wrapper
can use host-provisioned secret randomness for that input, persist the resulting
key, initialize the core and deliver the invitation through normal enrollment.
Keep startup RNG material separately generated or explicitly domain-separated.
No public invitation format or core protocol change is required; the host still
knows or can reconstruct the device secret under this provisioning model.
See [the browser derivation](../web/bridge.c) and
[the enrollment contract](protocol.md#enrollment).

Key generation is not literally the only randomness consumer in the selected
build: real `sodium_init` consumes randomness for its allocator canary. Default
Ed25519 signing and the current counter-nonce encryption path need no fresh
per-operation randomness; keep `ED25519_NONDETERMINISTIC` disabled.

Fresh host entropy on every boot is the simple recommended lifecycle above,
not a protocol requirement. An alternative is one-time erasable provisioning
of an independent RNG secret plus a reviewed DRBG restart design with durable,
nonrepeating state. That can permit subsequent autonomous boots, but its
atomic state advancement, rollback/failure handling and additional NVM writes
must be designed and budgeted. Merely replaying the original seed at every
boot would repeat the generator's output. Factory reset must erase that RNG
state along with the identity and require a new secret provisioning seed.

## 4. NVM layout, write rate and endurance

Use ordinary external-flash array sectors. For either documented candidate,
the relevant geometry is **4 KiB erase sectors and 256-byte program pages**.
Both candidates publish a 100,000-cycle endurance rating, subject to the exact
part's conditions. The GD25Q64C official datasheet is directly available;
Winbond's inspected Rev K document is manufacturer-authored but obtained from
a distributor mirror. Verify the fitted chip before adopting that budget.
[GigaDevice datasheet][gdflash], [Winbond datasheet][winbond]

For a verified 8 MiB part, reserve the last **12 KiB**:

| Purpose | Flash offset | XIP address | Size |
| --- | --- | --- | ---: |
| Snapshot A | `0x7FD000` | `0x107FD000` | 4 KiB |
| Snapshot B | `0x7FE000` | `0x107FE000` | 4 KiB |
| Reset intent | `0x7FF000` | `0x107FF000` | 4 KiB |

These are proposed addresses, not measured board configuration. Confirm JEDEC
identity/capacity before writes; verify markings or the ordering code for
temperature grade and matching endurance/timing conditions. Limit the serialized
header plus snapshot to **3,840 bytes**, leaving the final 256-byte program page
for the commit marker. Use bounded address checks in the storage provider and
flashing helper.
The application flash region ends at offset `0x7FD000` (exclusive).

Reuse the STM32 plan's two-snapshot state machine with RP2040 geometry:

- Serialize identity, server pin, core record and nonce high-water marks
  explicitly. Storage sequence and protocol generation are separate.
- Erase the inactive sector, program its snapshot, verify it, then program a
  **separate, previously untouched 256-byte commit page last**. Keep the old
  committed sector intact until the replacement is confirmed. Never depend
  on repeated programming of one page without erasure.
- A record commit preserves the latest counter reservation; a counter
  reservation preserves record bytes and generation. Acknowledge neither
  before verified durable completion.
- Recover from a definitely uncommitted destination using the old snapshot.
  A committed-but-corrupt snapshot or ambiguous ordering fails closed rather
  than rolling counters back.

### How often it writes

With that provider and the same demo sequence, protocol write counts are
unchanged from the [STM32 NVM analysis](stm32wba65-demo-plan.md):

| Operation | Snapshot writes |
| --- | ---: |
| Consume a positive quantity | 1 |
| Request and exchange a fresh status | 3 |
| Changed server issuance and its report exchange | 3 |
| Reserve another 32 outbound nonces | 1 |
| Fresh per-boot host entropy | 0 |
| Read-only inspection, idle time, retransmitting unchanged bytes | 0 |

Initial setup, identity/server-pin persistence and enrollment add writes.
Each boot's first outbound encrypted message needs a new durable reservation;
the unused tail of the previous boot's reservation is discarded. There is no
automatic periodic status polling or background snapshot timer.

For two alternating data sectors each rated at `E` erase cycles, the ideal
snapshot budget is approximately `2 × E`. At a verified **100k per sector**:

| Repeated workload | Approximate ideal budget |
| --- | ---: |
| Snapshot updates | 200,000 |
| Consume plus fresh status (`4 + 1/32` writes) | 49,600 cycles |
| Changed issuance + consume + fresh status (`7 + 2/32` writes) | 28,300 cycles |
| Fresh status alone (`3 + 1/32` writes) | 66,000 requests |

These are planning estimates before initialization, resets, power-loss retries
and safety margin, not a device lifetime guarantee. One status request per
minute would consume the nominal status budget in about 46 days. Factory reset
adds erasures to both data sectors and the separate marker sector, plus new
provisioning writes. The marker does not add a third sector to the snapshot
budget. Factory reset never restores endurance. Keep diagnostic write/erase
counters in RAM so measurement does not itself create persistent writes.

### Flash execution and USB latency

Flash writes suspend XIP. Use the SDK's `flash_safe_execute`, SRAM-resident
callback/data and ROM/SRAM flash routines; no interrupt, DMA transfer or second
core may fetch flash during the critical section. Keep core 1 parked initially.
If later enabled, use the SDK's cooperative flash lockout correctly.
[Flash API][flashapi], [flash-safe execution contract][flashsafe]

Ordinary flash critical sections also pause USB interrupt servicing. Candidate
parts specify sector erase maxima of roughly **300 ms (GD25Q64C, -40..85 C)**
or **400 ms (W25Q64JV)**, before additional programming time; higher-temperature
grades can differ. Bound traffic to one outstanding command, provide generous
host timeouts, and measure worst-case commit and multi-commit response latency.
Do not log over USB inside flash callbacks or persist from USB IRQ context.
[GigaDevice AC tables][gdflash], [Winbond AC tables][winbond]

An SDK flash-safe timeout can occur after the callback ran. Treat this as
potentially committed work, not a canceled erase, and preserve the provider's
ambiguous-failure behavior. Never automatically repeat a consume or other
mutation just because the USB response was lost.

## 5. Factory reset and recoverability

Keep three actions distinct:

| Action | Behavior |
| --- | --- |
| RESET / power cycle | Restarts; preserves persistent demo state. |
| BOOT held while resetting/powering on | Enters ROM UF2 firmware recovery; does not itself erase demo state. |
| Explicit demo reset command or runtime BOOT long press | Erases reserved demo state, preserves firmware, then waits for new provisioning. |

On this board BOOT is an active-low GPIO21 input. Use a deliberate five-second
hold **after application startup**, with a visible readiness/reset indication.
The STM32 boot-time joystick gesture cannot be copied literally: holding QT Py
BOOT during reset selects ROM recovery. Do not use the generic Pico workaround
that temporarily samples QSPI chip select; GPIO21 is directly available here.
[Board schematic][schematic], [Adafruit pin definitions][cppins]

Persist and verify reset intent first; then erase and verify both data sectors,
clear the marker, wipe old RAM secrets and wait for fresh setup. Any nonblank,
invalid or unreadable reset marker enters recovery before protocol processing.
Loss of power must not resurrect a pre-reset identity or old nonce state.
The Linux demo must establish a fresh paired session after device reset.

Normal UF2 updates must contain only firmware addresses and preserve the NVM
partition. A broken app is recovered with BOOT + RESET, a known-good image,
then application reset. Avoid whole-chip erase or `flash_nuke.uf2` in normal
demo workflows. Restoring CircuitPython or another original application is a
separate firmware installation, not the definition of demo factory reset.
[ROM recovery documentation][recovery]

No OTP writes, flash security-register programming or permanent locks are
needed. One detail must be documented accurately: the SDK's
[selected boot2][boot2] sets quad-enable by writing ordinary status registers
and can clear ordinary block-protection bits. It does not set permanent lock
bits, but the registers are not untouched. Keep this reversible boot setup;
exclude OTP/security-register commands and chip erase from demo tooling.
No RP2350 OTP/signing/lifecycle setup applies to this RP2040 project.

## 6. Suggested project shape and proof sequence

Share the protocol application, COBS framing, management commands, logical
snapshot format/state machine, Python server CLI and fault-injection tests with
the STM32 application. Add a board directory such as
`examples/embedded/boards/qtpy_rp2040/` for Pico startup/link configuration,
TinyUSB transport, flash operations, BOOT handling and the entropy adapter.
Keep the public core API and wire profile unchanged.
All library, sodium, entropy and storage operations have one main-loop owner;
USB/interrupt handlers queue work without reentering them.

Use bounded binary CDC framing without printf/newline conversion or unframed
logs. Either own TinyUSB CDC directly or carefully configure the SDK stdio
adapter; its default USB-triggered reboot behavior must be an explicit choice.
A CDC baud setting of 115200 is compatibility metadata, not the physical
throughput of a UART bridge. [SDK USB stdio documentation][usbstdio]

The implementation should proceed through these reviewable checks:

1. **Repository build proof:** full pinned source graph, declared host compiler
   and Python, ELF/UF2 generation, partition checks, then all five host profiles
   and offline/repeatability checks. Resolve the known Windows gap explicitly.
2. **USB and recovery proof:** enumerate on Linux, exchange framed commands,
   survive disconnect/reconnect and flash stalls, verify BOOT recovery and
   runtime reset gesture. Record flash identification read-only first.
3. **Crypto proof:** trusted-host seed before real initialization, entropy
   failure rejection, known-answer/interoperability tests, final multiply-helper
   inspection, and measured signing/verification/box latency and stack high-water.
4. **Persistence proof:** fault-inject every erase/program/commit/reset boundary,
   check nonce reservations and generation preservation, prove firmware updates
   exclude NVM, and exercise reset after partial writes and corrupt markers.
5. **Complete demo:** signed enrollment and explicit approval, issue 100 credits,
   consume 25, obtain a fresh status of 75, reboot and recover state, then factory
   reset and repeat with fresh identities. Count actual provider writes against
   the estimates and confirm no irreversible configuration commands occur.

The current evidence supports proceeding to this implementation sequence.
The outstanding gates are the entropy adapter/trust model, fully declared host
build tools and Windows support, the fitted flash part, and actual USB/crypto/
NVM behavior on the board. No connected-board qualification is claimed.

[adafruit]: https://learn.adafruit.com/adafruit-qt-py-2040
[buttons]: https://learn.adafruit.com/adafruit-qt-py-2040/pinouts
[schematic]: https://github.com/adafruit/Adafruit-QT-Py-RP2040-PCB/blob/5b6ebd1661fd5250b4f60bdba14d5c475259b7f4/Adafruit%20QT%20Py%20RP2040.sch
[layout]: https://github.com/adafruit/Adafruit-QT-Py-RP2040-PCB/blob/5b6ebd1661fd5250b4f60bdba14d5c475259b7f4/Adafruit%20QT%20Py%20RP2040.brd
[cpconfig]: https://github.com/adafruit/circuitpython/blob/8808ab7a1a4449d373a33eb98260b54b5bfa7f12/ports/raspberrypi/boards/adafruit_qtpy_rp2040/mpconfigboard.mk
[cppins]: https://github.com/adafruit/circuitpython/blob/8808ab7a1a4449d373a33eb98260b54b5bfa7f12/ports/raspberrypi/boards/adafruit_qtpy_rp2040/pins.c
[board]: https://github.com/raspberrypi/pico-sdk/blob/079c6f39023649b154152db30f1d781e884879bc/src/boards/include/boards/adafruit_qtpy_rp2040.h
[sdkrelease]: https://github.com/raspberrypi/pico-sdk/releases/tag/2.3.1
[sdkmodule]: https://github.com/raspberrypi/pico-sdk/blob/079c6f39023649b154152db30f1d781e884879bc/MODULE.bazel
[sdkci]: https://github.com/raspberrypi/pico-sdk/blob/079c6f39023649b154152db30f1d781e884879bc/.github/workflows/bazel_build.yml
[sdklink]: https://github.com/raspberrypi/pico-sdk/blob/079c6f39023649b154152db30f1d781e884879bc/src/rp2_common/pico_standard_link/BUILD.bazel
[sdkstack]: https://github.com/raspberrypi/pico-sdk/blob/079c6f39023649b154152db30f1d781e884879bc/src/rp2_common/pico_standard_link/script_include/sections_stack.incl
[picotoolbuild]: https://github.com/raspberrypi/picotool/blob/2.3.0/BUILD.bazel
[boot2build]: https://github.com/raspberrypi/pico-sdk/blob/079c6f39023649b154152db30f1d781e884879bc/src/rp2040/boot_stage2/BUILD.bazel
[uf2aspect]: https://github.com/raspberrypi/pico-sdk/blob/079c6f39023649b154152db30f1d781e884879bc/tools/uf2_aspect.bzl
[bcr]: https://registry.bazel.build/modules/pico-sdk
[bazelgit]: https://bazel.build/rules/lib/repo/git#git_repository
[int64ops]: https://github.com/raspberrypi/pico-sdk/blob/079c6f39023649b154152db30f1d781e884879bc/src/rp2_common/pico_int64_ops/pico_int64_ops_aeabi.S
[sodiuminstall]: https://doc.libsodium.org/installation#cross-compiling-to-arm-microcontrollers
[rp2040]: https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf#page=224
[picorand]: https://github.com/raspberrypi/pico-sdk/blob/079c6f39023649b154152db30f1d781e884879bc/src/rp2_common/pico_rand/rand.c
[gdflash]: https://download.gigadevice.com/Datasheet/DS-00111-GD25Q64C-Rev3.2.pdf
[winbond]: https://media.digikey.com/pdf/Data%20Sheets/Winbond%20PDFs/W25Q64JV_RevK_3-10-21.pdf
[flashapi]: https://www.raspberrypi.com/documentation/pico-sdk/hardware.html#hardware_flash
[flashsafe]: https://www.raspberrypi.com/documentation/pico-sdk/high_level.html#pico_flash
[recovery]: https://www.raspberrypi.com/documentation/microcontrollers/pico-series.html#reset-flash-memory
[boot2]: https://github.com/raspberrypi/pico-sdk/blob/079c6f39023649b154152db30f1d781e884879bc/src/rp2040/boot_stage2/boot2_w25q080.S
[usbstdio]: https://www.raspberrypi.com/documentation/pico-sdk/runtime.html#pico_stdio_usb

## Implementation

The implementation and operator instructions are in
[`examples/embedded/qtpy_rp2040`](../examples/embedded/qtpy_rp2040/README.md).
That README records the current-main baseline, concrete targets, storage layout,
measured write counts, and remaining physical-board qualification.
