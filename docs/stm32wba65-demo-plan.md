# Implementation plan: resettable STM32WBA65 demo

Consolidated 2026-09-20. Status: agreed design, awaiting implementation.
The [research brief](stm32wba65-bazel-research.md) contains the supporting
hardware and repository investigation. This document records the selected
approach and supersedes its provisional alternatives.

## Outcome and boundaries

Add an application project in this repository for **STM32WBA65I-DK1**
(MB2130 MCU board plus MB2143 mezzanine, STM32WBA65RIV7 Cortex-M33).
The board runs the production library; a Linux CLI runs the production Python
SDK as its server and communicates over ST-LINK USB serial.

**No OTP writes, option-byte changes, security locking, protection regression,
or permanent key provisioning.** Debug access remains enabled. Ordinary reboot
and firmware updates preserve identity and protocol state. Factory reset
preserves firmware but clears the demo state and requires fresh identities,
setup, enrollment, and approval. It does not restore flash endurance.

Firmware builds support Linux x86-64/AArch64, macOS Intel/Apple Silicon, and
Windows x86-64. The host CLI and programming helper initially support Linux.
No connected board is needed to build firmware.

BLE, an RTOS, browser integration, a secure/nonsecure application split, and
production key protection are outside this version. Bazel linting and style
enforcement will be handled on a separate branch before implementation; they
are not work items or dependencies to introduce through this plan.

## 1. Portable Bazel build

### Toolchain and dependency pins

Keep Bazel **9.2.0**. Use `rules_cc` **0.2.25**, `platforms` **1.0.0**, and
`toolchains_arm_gnu` **v1.2.0**, explicitly selecting Arm GNU **13.2.1**.
Resolve `rules_cc` and `platforms` through pinned BCR module declarations. Do not rely on implicit C/C++ rule autoloading.

Fetch the Arm toolchain module through BCR when the required release is available;
otherwise use a checksum-pinned `archive_override` with the release below. Keep
only the documented Bazel 9 compatibility patch locally, with provenance and
license information. The module continues to download the checksum-pinned compiler
archive for the execution host. Do not commit a toolchain source snapshot.

- Upstream commit: `76837cb143e98566008eab52e0003a49b6d18e7e`.
- [Release archive](https://github.com/hexdae/toolchains_arm_gnu/releases/download/v1.2.0/toolchains_arm_gnu-v1.2.0.tar.gz).
- SHA256: `51089579bf0d20e2ef9afdd10a5ca7a21eecb274ad177e502956077c63eef5f9`.
- Archive prefix: `toolchains_arm_gnu-1.2.0`.
- In upstream `toolchain/config.bzl`, load `ACTION_NAMES`, `cc_common`,
  `CcInfo`, and `CcToolchainConfigInfo` explicitly from `rules_cc`.
- In `toolchain/transitions.bzl`, load `CcInfo` explicitly.
- In `toolchain/templates/toolchain.bazel`, load `HOST_CONSTRAINTS` from
  `@platforms//host:constraints.bzl` instead of `@local_config_platform`.

Use the module's `arm_toolchain` extension with
`arm_none_eabi(version = "13.2.1")`. Load `arm_none_eabi_toolchain` from the
generated `@arm_none_eabi//toolchain:toolchain.bzl`, provide its required
`empty` filegroup, and register its five concrete host toolchains for the
board platform. Use `@platforms//os:none`, `@platforms//cpu:armv8-m`, and
explicit board/ABI/security-configuration constraints.

Apply the same architecture and ABI flags at compilation and linking:

```text
-mcpu=cortex-m33 -mthumb -mfpu=fpv5-sp-d16 -mfloat-abi=hard -fno-lto
```

The patched module with these Bazel/rules/platform versions passed a Linux
C, assembly, archive, and link probe during research. That is feasibility
evidence, not validation of the complete firmware or the other host platforms.

### Source graph and outputs

- Add standard `cc_library` targets sharing the existing core, schemas,
  nanopb, and sodium-provider sources. Existing host and Cortex-M4 archives
  are not firmware inputs.
- Compile libsodium **1.0.20** directly from its portable minimal C sources
  with a reviewed Cortex-M33 configuration. Do not run configure or Make.
- Pin STM32CubeWBA **v1.10.0** at
  `e455b860ceb52aaa0332a98f1e7a10bbd7014fc9`, including the exact HAL, CMSIS
  device, and BSP commits listed in the research brief. Pin and checksum
  the remaining CMSIS core headers and selected utilities too. Preserve
  upstream licenses; fetch each pinned component through Bazel and retain only
  small BUILD overlays locally. A top-level archive alone does not include submodules.
- Declare startup, linker scripts, headers, runtime libraries, and
  postprocessing executables as inputs. Firmware actions must not invoke
  system Python, Make, CubeMX, or a compiler discovered on `PATH`.
- Remove the repository-wide `/tmp` output-directory setting. Firmware
  targets must not require unrelated Go, Rust, browser, or host SDK setup.
- Produce ELF, HEX, BIN, linker map, size report, and an input/configuration
  manifest. Commit dependency locks and document dependency preparation for
  offline builds.

Downloaded native compilers still depend on a compatible host OS runtime.
Document those requirements and verify all five host profiles; no container
is mandatory. Pinning tools does not make an arbitrary host runtime supported.

## 2. Firmware and cryptography

Use a bare-metal, single-owner application loop, bounded buffers, and an initial
**32 KiB stack reservation**. Start from the board's own startup and clock
configuration and selected USART1, RNG, flash, and joystick drivers.

Build two explicit configurations: **TrustZone disabled** and **a single secure
image without isolation**. Each has the corresponding vector table, linker
addresses, and peripheral setup. Programming selects a matching image after
reading the board configuration; it never changes that configuration to make
an image fit. Unsupported protection, boot, or memory-attribution settings
stop the helper without modification.

Preserve the current Ed25519/NaCl profile and signed enrollment. Keep the public
library API and wire protocol unchanged; platform services and reset behavior
belong in the demo provider/application.

- Configure sodium for little-endian Cortex-M33 using its portable 32-bit
  implementations. Unsupported platform feature macros remain undefined.
  Preserve upstream aliasing/overflow compilation requirements and disable LTO.
- Provide a complete custom `randombytes_implementation` backed by hardware
  RNG. Set the default implementation explicitly; defining only
  `RANDOMBYTES_CUSTOM_IMPLEMENTATION` does not eliminate the OS RNG fallback.
- Initialize hardware RNG and the custom implementation before real
  `sodium_init()`. Retain sodium initialization and its required source closure;
  do not replace initialization with a stub to reduce the link size.
- RNG failure prevents cryptographic output. Sodium callbacks that cannot
  return an error must enter a nonreturning fault path; the core RNG callback
  returns `SC_ERR_RANDOM`. No predictable fallback is permitted.
- Generate device keys on the board and persist them before use. The MCU UID
  supplies a public display serial only. Private keys never enter build
  artifacts or management responses.

## 3. Persistent storage and reset recovery

Reserve the final **24 KiB of ordinary flash**. Use two alternating 8 KiB data
pages and one 8 KiB reset-intent page. Exclude the whole region from firmware
images and routine programming.

| Purpose | Address with normal bank mapping | Secure alias |
| --- | --- | --- |
| Reset intent | `0x081FA000` | `0x0C1FA000` |
| Snapshot A | `0x081FC000` | `0x0C1FC000` |
| Snapshot B | `0x081FE000` | `0x0C1FE000` |

For the 2 MiB device with bank swapping disabled these are Bank 2 pages
125-127. The initial programming helper accepts only this normal bank mapping;
if bank swapping is enabled, stop without changing option bytes. The two
security configurations use aliases of the same physical storage.

Each snapshot contains the identity, server public-key pin, protocol record,
nonce reservations, format/version information, checksum, and snapshot
sequence. Keep the **physical snapshot sequence separate from the core's
protocol-record generation**: nonce reservation persists state without
incrementing protocol-record generation.

- Implement synchronous atomic compare-and-replace `commit` and durable,
  nonoverlapping `reserve` callbacks. Return success only after persistence
  and verification.
- Serialize both callbacks through the provider's single owner. `commit`
  preserves the latest nonce high-water values; `reserve` preserves the
  protocol-record bytes and protocol generation.
- Use one full snapshot per page. Erase the alternate page, write and verify
  the replacement, and write its commit marker last in a separate aligned
  quad-word. Program flash quad-words once between erases; do not update
  fields in place.
- Preserve the current committed page until the replacement is committed.
  Recovery may use an older snapshot only when the interrupted replacement
  is definitively uncommitted. Corrupted committed state or ambiguous ordering
  must fail closed, never silently roll back counters under the same key.
- An ambiguous storage failure stops messaging. An explicit reset remains
  available to recover the demo.

Factory reset stops protocol processing and first records and verifies reset
intent. It then erases and verifies both data pages, clears the reset marker,
clears old in-memory state, generates and persists a fresh device identity,
and waits for setup. On boot, a nonblank, malformed, or unreadable reset marker
prevents messaging and requires reset recovery before normal operation.
An interrupted reset resumes before any protocol output.

The reset marker is cleared only after both data pages are verified erased.
Old identity keys must never be reused with cleared nonce counters. Neither
factory reset nor normal programming modifies OTP or option bytes.

## 4. NVM write frequency and endurance budget

There is no periodic background write in the library. Persistence follows
application operations, protocol exchanges, and nonce reservations. The counts
below concern the board; the Linux server has its own storage writes.

| Operation | Board persistence |
| --- | --- |
| Idle, local inspection, or ordinary boot restoring valid state | None |
| Successful nonzero credit consumption | One state commit, independent of the amount |
| Receive changed issuance, send its report, receive acknowledgment | Three state commits |
| Fresh status request/report/acknowledgment | Three state commits even if credit values are unchanged |
| Encrypted outgoing messages | One additional reservation per block of 32 nonces |
| First encrypted output after reboot | A fresh reservation; unused values from the previous boot are discarded |

Fresh signed initialization/enrollment costs **five state commits plus one
nonce reservation**. Adding issue 100, consume 25, and a fresh status exchange
brings the total to **13 persistent updates**, excluding platform identity and
pin provisioning. One call consuming 25 credits does not cause 25 writes.

Budget one data-page erase per persistent update with this full-snapshot
design. Writing multiple 16-byte quad-words within a snapshot does not multiply
the page-cycle count. A small metadata change still consumes a page cycle if
it replaces a snapshot.

ST specifies **10,000 cycles per page generally**, and **100,000 cycles for up
to 32 pages per bank**, over -40 to +105 degrees C. Any ordinary flash page can
be selected for the higher cycling allowance. The three reserved pages fit
that allowance without an endurance-enable option-byte change. Keep frequent
cycling confined to these pages; other firmware must not consume the bank's
remaining high-cycle allowance.
[Datasheet table 69](https://www.st.com/resource/en/datasheet/stm32wba65ri.pdf#page=139),
[RM0515 section 7.3.9](https://www.stmcu.jp/wp/wp-content/uploads/2025/04/RM0515_Rev3.pdf#page=202).

The two alternating data pages provide a nominal budget of
`2 * per-page endurance`: **20,000** or **200,000** persistent updates.
Derived estimates for successful repeated operations during continuous uptime:

| Repeated completed operation | Average updates | At 10k cycles/page | At 100k cycles/page |
| --- | --- | ---: | ---: |
| Fresh status exchange | `3 + 1/32` | About 6,600 | About 66,000 |
| Consume, then fresh status exchange | `4 + 1/32` | About 5,000 | About 50,000 |
| Increase issuance, complete its exchange, consume, then fresh status exchange | `7 + 2/32` | About 2,800 | About 28,000 |

These are planning budgets, not measured remaining life. Initialization,
provisioning, retries, failures, reset/recovery erases, and prior device wear
reduce them. Track each page because uneven wear makes the most-used page
the limiting one. Repeating an unchanged issuance total is a no-op, not the
changed-issuance operation counted above.

For fresh initialization/enrollment followed by `K` full issue/consume/report
cycles without reboot or errors, the core contributes:

```text
state commits      = 5 + 7*K
nonce reservations = ceil((1 + 2*K) / 32)
```

With multiple boot sessions, count reservations separately per session; one
outgoing message per reboot needs one reservation per message. Failed encryption
or a later commit failure can consume an already allocated nonce. Retries may
also change persisted pending/acknowledgment state. Sending an already-produced
transport frame again causes no new library persistence.

Each uninterrupted factory reset erases each data page and clears the
reset-intent page once, followed by fresh identity/setup writes. Interrupted
recovery may add erases. The reset-intent page has its own endurance budget;
it does not increase the two-page data budget to 300,000 updates.

A fresh status exchange every minute continuously would consume the nominal
higher budget in about **46 days**. Therefore the demo has **no automatic
background report polling**; local inspection is read-only. Use emulated flash
for endurance/failure stress testing rather than deliberately wearing out the
physical board.

Retention is separate from cycling: after 100,000 cycles, ST specifies 30 years
at 55 degrees C, 15 years at 85 degrees C, and 10 years at 105 degrees C. These
are retention conditions, not continuous-write lifetimes.
[Datasheet table 69](https://www.st.com/resource/en/datasheet/stm32wba65ri.pdf#page=139).

Add `inspect --storage` diagnostics for commits, reservations, programmed bytes,
and erase attempts per page **since boot**. Keep counters in RAM so measurement
adds no writes. Distinguish successful logical updates from physical attempts
and observed counts from estimated remaining endurance. Flash timeouts must
accommodate the 100k-cycle erase timing, not just fresh-flash timing.

## 5. Host CLI, transport, and programming

Provide Linux CLI commands for setup, enrollment, approval, issuing/consuming
credits, requesting reports, inspection, reboot, and factory reset. Reuse the
production Python SDK for server operations.

- Use CN6 ST-LINK virtual COM/USART1 at **115200, 8N1**, through Linux serial
  APIs. No application USB stack is required.
- Use bounded COBS-framed packets that distinguish opaque library frames,
  management commands, responses, and diagnostics. Preserve the existing
  **512-byte protocol-frame limit**, with separately bounded framing overhead.
- Setup creates a fresh host identity and provisions only its public key over
  the local USB connection. Enrollment approval remains explicit.
- State-changing management commands are not automatically retried after
  uncertain responses; the CLI reports uncertainty and supports inspection.
- Offer factory reset through an explicit CLI command and by holding joystick
  center for five seconds during boot.
- CLI reset replaces the board's active host demo session with a fresh server
  identity. After physical reset, the next setup makes that replacement.
  Fresh enrollment and approval are required. This avoids changing the
  library's existing enrollment/replacement API.

Add a separate Linux STM32CubeProgrammer helper. It reads identity/configuration
and option bytes, validates the requested image's security configuration and
address ranges, and programs only firmware pages. It never performs mass erase,
OTP programming, protection regression, or option-byte writes. Reject any image
that overlaps persistent storage or another unsupported memory range. Device
configuration mismatches stop the operation; they are not automatically fixed.

Programming and factory reset are explicit user actions, separate from ordinary
build/test commands. Routine reflash preserves the NVM partition. If a future
storage format becomes incompatible, report that setup/reset is needed rather
than silently clearing existing state.

## 6. Implementation sequence and acceptance

Implement in the following order, after the separate style-enforcement branch:

1. **Build foundation:** pin and patch the toolchain module, add standard C
   targets, portable sodium compilation, board platforms, and artifact rules.
   Build both firmware configurations without unrelated SDK setup.
2. **Storage provider:** implement the snapshot and reset state machines with
   an emulated-flash backend for fault injection and accounting. Establish
   commit/generation/nonce behavior before enabling protocol output on hardware.
3. **Board application:** integrate startup, serial, RNG, real sodium
   initialization, provider callbacks, bounded application loop, and joystick
   reset. Confirm boot without a debugger.
4. **Host workflow:** add framing, CLI management, SDK exchange, fresh-session
   setup/reset, and the configuration-reading programming helper.
5. **Qualification and documentation:** run host-platform builds and board
   acceptance, record evidence, and document build, flash, enrollment, normal
   operation, reset, recovery, and the NVM budget.

Acceptance criteria:

- **Portability and reproducibility:** complete firmware builds on all five host
  profiles; declared compiler/runtime/postprocessing inputs; offline rebuild
  after dependency preparation; repeatable ELF hashes per host and matching
  BIN/HEX outputs across hosts. Investigate mismatches rather than silently
  weakening these checks.
- **Functional sequence:** boot standalone, set up and approve enrollment,
  issue 100 credits, consume 25, request a fresh report, and verify it on the
  host. Ordinary reboot/reflash preserve identity, totals, and nonce continuity.
- **NVM accounting:** verify the write counts above, reservation boundaries
  at 32 messages, fresh reservation after reboot, and zero writes during idle
  or local inspection. Test `reserve` followed by `commit`, including power
  cuts: reservation advances the physical snapshot sequence without advancing
  protocol generation, and the later commit preserves the reserved counters.
  Measure physical erase/program attempts and latency.
- **Crash recovery:** emulate interruption at every persistent-write/erase
  boundary, including torn snapshots, corrupted committed data, reservations,
  reset marker creation/clearing, and identity provisioning. Never emit under
  a reused nonce/key combination or silently restore older committed counters.
- **Factory reset:** exercise CLI and joystick paths; firmware survives,
  device identity changes, host session changes at CLI reset or next setup,
  credits return to zero, and new approval is required. Old traffic cannot
  restore enrollment. Hardware tests do not run flash to exhaustion.
- **Other failures:** RNG failures, malformed/oversized serial input,
  disconnects, storage faults, and uncertain command responses behave as
  specified, without automatic repeated consumption.
- **Programming boundaries:** review every programming command and firmware
  flash-write range; compare option bytes before and after flashing/reset tests.
  Confirm protection and bank-mapping mismatches are rejected without writes.
- **Regression/resources:** retain existing protocol, crypto, and schema checks;
  run board crypto vectors and host interoperability; measure initialized
  firmware size and stack high-water, including nested crypto and interrupt
  use. Report hardware results separately from build-only evidence.

Do not declare board acceptance complete without physical-board results.
Assume an accessible development board with debugging available; record its
actual board/silicon revision and initial configuration during first bring-up.
