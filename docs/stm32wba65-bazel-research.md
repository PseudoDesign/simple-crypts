# Research: hermetic Bazel firmware for STM32WBA65I-DK1

Researched 2026-09-20. This is a research brief for the next planning discussion,
not an implementation plan or a hardware qualification. Recommendations below
are provisional. No firmware project, dependency upgrade, or board programming
was performed.

The subsequent [implementation plan](stm32wba65-demo-plan.md) records the
selected approach, including the validated toolchain-module integration,
reset behavior, NVM budget, and acceptance criteria. Its decisions supersede
the provisional alternatives in this research brief.

## Findings that determine the approach

The supplied identifiers, “STMB2143A” and “MB2130A,” match the two boards of
**STM32WBA65I-DK1**. The application processor is a **Cortex-M33**, whereas this
repository's existing embedded target is a Cortex-M4 resource probe.

The strongest starting option is a board/application package in this Bazel
module, using standard `rules_cc` targets and a pinned Arm GNU bare-metal
toolchain. Reuse the library sources, add actual startup and board services, and
use ST-LINK's serial port to communicate with a host server. Radio, an RTOS,
and a secure/nonsecure split are additional choices, not requirements imposed
by the library. This is an engineering recommendation based on the findings
below, not a decision already made for the project.

The substantial integration work is durable storage and randomness as well as
the build. The current host archives, probe callbacks, and historical memory
figures cannot be carried over as a working board application.

## Hardware identification

| Item | Verified identification or implication |
| --- | --- |
| Kit | STM32WBA65I-DK1 |
| MB2130 | MCU/RF board with STM32WBA65RIV7 |
| MB2143 | Mezzanine providing additional user-interface/audio peripherals |
| CPU and capacity | Cortex-M33, up to 100 MHz, 2 MiB flash, 512 KiB SRAM |
| Debug and serial | On-board STLINK-V3EC supports SWD and virtual COM |
| Published assembly revisions | MB2130-WBA65RI-A03 and MB2143-WBA65I-A02 |

These mappings come from ST's [UM3462 kit manual, especially product information
and board descriptions](https://www.st.com/resource/en/user_manual/um3462-discovery-kit-with-stm32wba65ri-mcu-stmicroelectronics.pdf).
The user's abbreviated markings identify the kit well, but do not establish
the physical board revision, silicon revision, jumpers, or current option bytes.

Use the kit's CN6 ST-LINK USB connection and USART1 virtual COM port for initial
serial communication; CN5 is the application USB connector. This
avoids requiring an application USB stack. A framed byte transport can carry
the existing opaque protocol frames; UI/audio hardware can be left unused.

## What the repository already supplies

The observations here refer to the workspace inspected on the research date.
Git revision metadata was not available in this environment.

| Existing component | Reuse and gap |
| --- | --- |
| [C core](../core/sc.h), [implementation](../core/sc.c) | Caller-owned C99 context, synchronous callbacks, bounded buffers, no core heap requirement. Appropriate application entry point. |
| [Schema](../schema/BUILD.bazel), [nanopb](../third_party/nanopb/BUILD.bazel) | Generated C files and descriptors are already present; normal firmware compilation need not run protoc. Preserve regeneration checks separately. |
| [Sodium provider](../providers/sodium/sc_sodium.c) | Current Ed25519 identity conversion, box encryption, signing and verification are reusable after MCU compilation and initialization are validated. |
| [Host provider](../providers/host/sc_host.c) | Useful behavior reference; its POSIX filesystem, locking and OS randomness are not MCU services. |
| [Core build targets](../core/BUILD.bazel) | `//core:sc` and dependencies return the private `CLibrary` provider, not standard `CcInfo`; existing archives are built for the host. |
| [Build rules](../build/defs.bzl), [action driver](../tools/build_action.py) | Explicitly nonhermetic C/Arm tools: `/usr/bin/python3`, system `cc`/`ar`, `arm-none-eabi-*`, shell utilities and Make. |
| [Cortex-M4 target](../platforms/cortex_m4/BUILD.bazel) | Cross-links a resource ELF; has no board vector table/startup, real storage, entropy or provisioning. Its sodium build fixes Cortex-M4 flags. |

The [probe](../platforms/cortex_m4/probe.c) also selects the raw-key
`sc_sodium_seal/open` path. The current application profile uses Ed25519
identities, `sc_sodium_ed_seal/open`, and signed enrollment. A new resource
measurement must include that full path and runtime initialization.

The [published M4 report](../site/resources/cortex-m4.md) records a 952-byte
context and a 512-byte record buffer. Those are historical measurements, not
the current source layout. A small compile-only investigation with the local
Arm GCC 13.2.1 and `-mcpu=cortex-m33 -mthumb` found:

| Current source measurement | Bytes |
| --- | ---: |
| `sizeof(sc_context)` | 3648 |
| `sizeof(sc_state)` | 2056 |
| `SC_MAX_RECORD` | 1408 |
| `SC_MAX_FRAME` | 512 |

With `-Os -fstack-usage`, individual frames included 2608 bytes for
`sc_receive_at` and `sc_outbound`, and 2520 bytes for `save`. These are compiler
observations using an unpinned local tool, **not whole-program stack peaks or
board measurements**. Nested calls, crypto, interrupts, buffers and library
runtime all need inclusion in the eventual RAM budget.

## Bazel and toolchain options

The repository pins Bazel **9.2.0**, enables Bzlmod, disables C++ autodetection,
and disables external rule autoload. It currently declares no `rules_cc`
dependency. Add explicit external rule loads for new C targets; older tutorials
based on WORKSPACE or implicit built-in C++ rules need adaptation.
[Bazel 9 changes](https://blog.bazel.build/2026/01/20/bazel-9.html).

| Option | Assessment for this application |
| --- | --- |
| Pinned Arm GNU archive plus project-owned `cc_toolchain` | Preferred starting point: close to ST's GCC examples, with an explicit and reviewable build graph. We own a small amount of toolchain configuration. |
| `hexdae/toolchains_arm_gnu` | Useful alternative/reference with Bzlmod and embedded features, but validate Bazel 9.2 compatibility before selecting a release. |
| Arm Toolchain for Embedded (LLVM) | Credible alternative, but adds compiler/runtime/linker and vendor-binary compatibility work during initial bring-up. |
| Zephyr application | Board support exists and may be attractive if BLE, RTOS services or TF-M become requirements. Wrapping its build under Bazel would still require pinning its SDK, modules, generators and tools. |

`rules_cc` provides the APIs and rules, but does not itself distribute a hermetic
compiler. The GNU toolchain package must include GCC's internal executables,
assembler, linker, binutils, target headers, specs, multilib runtime libraries,
and newlib as applicable. [rules_cc](https://github.com/bazelbuild/rules_cc),
[C++ toolchain configuration](https://bazel.build/docs/cc-toolchain-config-reference).

At research time, the community GNU project advertised v1.2.0 while BCR listed
1.1.0. Its inspected `config.bzl` still referenced global `cc_common`, `CcInfo`
and `CcToolchainConfigInfo` without explicit loads. That is a **static
compatibility concern**, not an executed failure report. Use a verified release
or reviewed patch if choosing it.
[Project](https://github.com/hexdae/toolchains_arm_gnu),
[BCR entry](https://registry.bazel.build/modules/toolchains_arm_gnu/),
[configuration source](https://github.com/hexdae/toolchains_arm_gnu/blob/master/toolchain/config.bzl).

The current LLVM option is [Arm Toolchain for Embedded](https://github.com/arm/arm-toolchain/tree/arm-software/arm-software/embedded).
The older [LLVM Embedded Toolchain for Arm repository](https://github.com/ARM-software/LLVM-embedded-toolchain-for-Arm)
is deprecated. Arm's GNU download entry now points to its
[GNU toolchains project](https://gitlab.arm.com/tooling/gnu-toolchains-for-arm).
Choose and hash an actual archive during implementation; this research does
not nominate an untested compiler release.

[Zephyr's board documentation](https://docs.zephyrproject.org/latest/boards/st/stm32wba65i_dk1/doc/index.html)
confirms board support and notes that radio support requires controller binary
blobs. An RTOS adds a substantial dependency closure for a library that already
works with a simple single-owner event loop.

## What “hermetic” should mean for this project

Recommend a precise initial contract: **the same declared sources, configuration,
tools and execution environment produce identical firmware artifacts, without
network access during build actions**. Network-free rebuilds after dependency
preparation and cross-host portability should be tested separately.
[Bazel's hermeticity guidance](https://bazel.build/basics/hermeticity).

1. **Pin the complete inputs.** Retain `.bazelversion` and verify the Bazel
   bootstrap executable (plus Bazelisk/JVM if used separately); pin `rules_cc`, Arm GNU,
   STM32Cube release/commit and submodules, crypto sources, build overlays and
   any generators. Fetch immutable archives with SHA-256/integrity and retain
   verified mirrors. A version string alone is insufficient.
   [HTTP repository rules](https://bazel.build/rules/lib/repo/http).
2. **Commit the Bzlmod lockfile.** Use `--lockfile_mode=error` in CI to reject
   unrecorded resolution changes. This does not forbid all downloading:
   reproducible module extensions can still access the network.
   [Lockfile behavior](https://bazel.build/external/lockfile).
3. **Prepare an offline dependency set.** Vendor for the actual target and
   configuration, including registry metadata, or provide equivalent complete
   caches. Revalidate after tool/configuration changes. Existing local SDK
   directories are not made portable just by enabling vendor mode.
   [Vendor mode](https://bazel.build/versions/9.0.0/external/vendor).
4. **Declare every action dependency.** No `/usr/bin` compiler, Python, Make,
   hidden Cube installation, package-manager fetch, or CubeMX invocation in a
   compile action. Build-time generators execute with host tools selected for
   the execution platform; firmware libraries use the target platform.
   [Toolchain framework](https://bazel.build/extending/toolchains).
5. **Pin the execution environment too.** A downloaded compiler can still use
   the host dynamic loader and shared libraries. Start with a documented Linux
   x86-64 execution profile and a digest-pinned build/worker image, or package
   the required runtime explicitly. Ordinary sandboxing still permits some
   absolute-path host reads. A successful sandbox build alone proves too little.
   [Sandboxing](https://bazel.build/docs/sandboxing).
6. **Control artifact variability.** Avoid volatile stamping/timestamps, map
   source/debug paths to stable names, use deterministic archives and ordering,
   and pin image-conversion tools. If time macros are needed, use a declared
   fixed `SOURCE_DATE_EPOCH`.
   [GCC path options](https://gcc.gnu.org/onlinedocs/gcc/Overall-Options.html),
   [GCC environment](https://gcc.gnu.org/onlinedocs/gcc/Environment-Variables.html),
   [GNU archive mode](https://sourceware.org/binutils/docs/binutils/ar-cmdline.html).

This contract should initially apply to the new firmware target's complete
dependency graph. Making all existing language bindings and browser builds
hermetic would be a separate expansion of scope.

## Candidate project boundaries

The following are suggested responsibilities, not files created by this research:

| Area | Responsibility |
| --- | --- |
| `toolchains/arm_gnu` | Download manifest, `cc_toolchain`, execution constraints, runtime/ABI features |
| `platforms/stm32wba65` | Armv8-M/no-OS target, board/security-state constraints |
| `third_party/stm32cube_wba` | Narrow Bazel overlays for checksum-pinned external CMSIS/device/HAL/BSP repositories |
| Portable `cc_library` targets | Core, generated schemas, nanopb and software crypto built for the selected target |
| `providers/stm32wba` | RNG, key lookup, durable records and counter reservations |
| `examples/stm32wba65` | Application loop, transport, startup, IRQs, HAL configuration and linker layout |
| Explicit developer tools | Flash, debug, serial host bridge and hardware tests |

Keeping the application in the existing module avoids duplicating library
sources and dependency management. If an independently versioned project is
preferred later, first make the portable library consumable through standard
`CcInfo` targets and explicit module dependencies. A separate module does not
by itself fix nonhermetic build actions.

The BCR `platforms` package has `@platforms//cpu:armv8-m` and
`@platforms//os:none`. Add finer board/ABI/security constraints where needed;
Armv8-M alone does not identify an M33 configuration. Keep execution OS/CPU
separate from target CPU. Prefer `--platforms` and registered toolchains over
sprinkling compiler paths or `--cpu` assumptions through rules.
[Remote execution rule guidance](https://bazel.build/remote/rules).

Reuse source files through new standard C targets or migrate shared targets
deliberately. Do not import a host archive or the current M4 sodium archive as
if selecting a new platform could retarget its machine code.

The output should include ELF, BIN/HEX as required, link map, section sizes and
a machine-readable manifest of inputs/configuration. Declare the linker script
as an input, including scripts it includes. Declare map and conversion outputs;
a bare `-Map` side effect is not sufficient. Use toolchain-selected objcopy and
size tools. [C/C++ rule reference](https://bazel.build/reference/be/c-cpp).

## ST source and boot configuration

Use a coherent STM32CubeWBA release as the source baseline. ST's repository
contains submodules; a top-level GitHub ZIP omits their contents. Pin their exact
commits or construct a checksummed source bundle. Preserve component licenses
and provenance. ST also excludes some click-through audio middleware from the
public repository; the proposed serial application does not need that audio
demonstration dependency.
[STM32CubeWBA repository instructions](https://github.com/STMicroelectronics/STM32CubeWBA).

An inspected baseline is **STM32CubeWBA v1.10.0**, dated 2026-06-03, parent commit
`e455b860ceb52aaa0332a98f1e7a10bbd7014fc9`. Its gitlinks identify these component
commits; these are research references, not a tested dependency lock for this
application. [Pinned release notes](https://github.com/STMicroelectronics/STM32CubeWBA/blob/e455b860ceb52aaa0332a98f1e7a10bbd7014fc9/Release_Notes.html),
[pinned Drivers tree](https://github.com/STMicroelectronics/STM32CubeWBA/tree/e455b860ceb52aaa0332a98f1e7a10bbd7014fc9/Drivers).

| Component | Commit |
| --- | --- |
| [CMSIS device](https://github.com/STMicroelectronics/cmsis_device_wba/tree/3373b40fa3b71ce114f58b170acd0f8833d42508) | `3373b40fa3b71ce114f58b170acd0f8833d42508` |
| [WBA HAL](https://github.com/STMicroelectronics/stm32wbaxx_hal_driver/tree/c36d9aabc6068051ed27a3a683a6b4f35f04d815) | `c36d9aabc6068051ed27a3a683a6b4f35f04d815` |
| [DK1 BSP](https://github.com/STMicroelectronics/stm32wba65ri-dk1-bsp/tree/ee5fbfa1a25a7bb78588ab163817f54ed1479c33) | `ee5fbfa1a25a7bb78588ab163817f54ed1479c33` |

This table is not the entire dependency closure: CMSIS core headers, selected
utilities and any peripheral components also need provenance and checksums.

Start from the board's own startup/system/template sources and selected HAL/BSP
files. Review and commit the needed generated configuration. CubeMX can be an
authoring tool without becoming a required dependency of every build.

The board has multiple upstream templates, including `TrustZoneDisabled`,
`TrustZoneEnabled`, and `TrustZoneEnabled_NoIsolation`.
[Pinned board templates](https://github.com/STMicroelectronics/STM32CubeWBA/tree/e455b860ceb52aaa0332a98f1e7a10bbd7014fc9/Projects/STM32WBA65I-DK1/Templates).
The disabled template requires TZEN=0; the no-isolation template is a single
secure application with TZEN=1. A full split needs separate secure/nonsecure
images and an explicit boundary. These choices change startup, addresses,
peripheral attribution and linker behavior; `-mcpu=cortex-m33` alone is not
enough.

The inspected disabled template uses flash `0x08000000` and RAM `0x20000000`;
the secure no-isolation template uses aliases `0x0C000000` and `0x30000000`.
Both stock linker files declare 2048 KiB flash and 512 KiB RAM, before our own
persistent partitions. Its CubeIDE configuration selects `STM32WBA65xx`,
`USE_HAL_DRIVER`, `fpv5-sp-d16` and hard float. A matching GNU configuration is
`-mcpu=cortex-m33 -mthumb -mfpu=fpv5-sp-d16 -mfloat-abi=hard`; secure builds need
their appropriate CMSE settings as well. These are baseline settings to validate,
not a complete compiler command.
[Disabled linker](https://github.com/STMicroelectronics/STM32CubeWBA/blob/e455b860ceb52aaa0332a98f1e7a10bbd7014fc9/Projects/STM32WBA65I-DK1/Templates/TrustZoneDisabled/STM32CubeIDE/STM32WBA65RIVX_FLASH.ld),
[secure linker](https://github.com/STMicroelectronics/STM32CubeWBA/blob/e455b860ceb52aaa0332a98f1e7a10bbd7014fc9/Projects/STM32WBA65I-DK1/Templates/TrustZoneEnabled_NoIsolation/STM32CubeIDE/STM32WBA65RIVX_FLASH.ld),
[IDE configuration](https://github.com/STMicroelectronics/STM32CubeWBA/blob/e455b860ceb52aaa0332a98f1e7a10bbd7014fc9/Projects/STM32WBA65I-DK1/Templates/TrustZoneDisabled/STM32CubeIDE/.cproject).

Read the physical board's option bytes before selecting a matching image.
Changing security state can erase flash and destroy provisioned identity/counter
state. Programming should be a separate explicit operation, with a partition
layout that preserves data on routine firmware updates. Do not put option-byte
changes, mass erase or provisioning inside `bazel build`.
[ST boot/security overview](https://wiki.st.com/stm32mcu/wiki/Security%3ASecurity_features_on_STM32WBA),
[Zephyr's board-specific TrustZone notes](https://docs.zephyrproject.org/latest/boards/st/stm32wba65i_dk1/doc/index.html).

Startup must retain the vector table, establish the stack, initialize `.data`
and `.bss`, initialize clocks/FPU as configured, and reach the application.
Compile and link every object with matching Thumb/CPU/FPU/float-ABI settings.
Retain the upstream memory-region requirements and reserve persistent storage
in the actual linker map. Newlib syscall stubs and `nosys.specs` can satisfy a
link without providing working storage, entropy or output; inspect the live
call paths. Disable debugger-dependent semihosting for standalone operation.

## Library services the board must implement

**Cryptography.** Preserve the current wire profile: Ed25519 identities,
conversion to X25519, and XSalsa20-Poly1305 box. ST's PKA explicitly excludes
Edwards curves and Curve25519. AES/PKA hardware therefore is not a drop-in
provider for this library. Software crypto is the lowest-change initial option;
hardware AES might serve a separate storage-protection design.
[RM0515, section 3.10.1, table 16](https://www.st.com/resource/en/reference_manual/rm0515-stm32wba6xxx-advanced-armbased-32-mcus-stmicroelectronics.pdf).

Port the sodium initialization/RNG path as well as its box functions. Its
upstream ARM notes demonstrate cross-compilation, but do not qualify this
Cortex-M33 board. The specific upstream warning names M0/M3/M4; absence of M33
from that warning is not evidence of qualification. Upstream also advises
against LTO for libsodium; avoid enabling whole-program LTO indiscriminately.
[Libsodium installation guidance](https://doc.libsodium.org/installation).

The sodium build itself needs a hermetic strategy: either a reviewed Bazel
source/configuration overlay or a fully declared cross-configure/Make action
with its tools pinned. A wrapper around the existing host-tool action does not
meet the goal. Compare known-answer and interoperability results after changing
how sodium is built.

**Randomness.** Use the WBA6 RNG with the required initialization, health/error
handling and failure propagation. Install any custom sodium randombytes
implementation before `sodium_init()`. Its callbacks do not all return errors,
so define a fail-closed policy for failures inside sodium; the core's random
callback can return `SC_ERR_RANDOM`. Never return unfilled or predictable bytes
as success. [ST RNG description, datasheet section 3.24](https://www.st.com/resource/en/datasheet/stm32wba65ri.pdf),
[Sodium custom RNG interface](https://doc.libsodium.org/advanced/custom_rng).

**Durable storage.** Implement the precise [provider contract](platforms.md):
atomic compare-and-replace records and durably reserved, nonoverlapping nonce
ranges. `SC_NONCE_RESERVATION` is currently 32. Persist the reservation before
returning success and burn its unused tail after reset. Namespace it by key
identity and direction. Keys, records and reservations must remain consistent
through interrupted writes and firmware upgrades.

An append journal or alternating-page design is a candidate, not a completed
design. Account for partial programming, ECC behavior, compaction, wear and
ambiguous completion. The device has 8 KiB flash pages, dual banks and documented
endurance limits; those facts affect partition and write-amplification choices.
[Datasheet sections 3.5 and 5.3.13](https://www.st.com/resource/en/datasheet/stm32wba65ri.pdf).
Do not assume a generic STM32 EEPROM example provides whole-record transactions
or rollback protection. Atomic persistence and resistance to malicious rollback
are different properties.

**Identity and provisioning.** Keep private keys and live persistent state out
of reproducible firmware artifacts and shared build caches. Provision separately
or generate from qualified entropy and persist before use. A serial/MCU UID can
identify a device but supplies no secret entropy. A reset/reprovision operation
must never reuse an old identity with reset nonce counters. These requirements
follow from the existing [platform](platforms.md) and [protocol](protocol.md)
contracts.

**Application and transport.** A minimal meaningful demo can enroll a board
against a host server, receive a credit grant, consume credits via a command or
button, report requested state, and retain its identity/totals across reboot.
Use bounded framing around the 512-byte maximum protocol object, with separate
handling for diagnostics. Keep core calls in one owner/event loop; an ISR can
collect bytes and signal work. BLE would add fragmentation, buffers, controller
libraries, scheduling and radio/flash coordination to this same interface.

The [production Python API example](../examples/python_api.py) is a useful
workflow reference. The browser fleet manager currently has no physical serial
transport; a host bridge would be new work. Server enrollment approval should
remain explicit in that companion application.

## Evidence needed before claiming success

These are prospective acceptance criteria, not tests passed during research:

- A clean machine builds the explicit firmware target using only the recorded
  dependency bundle and execution profile; it does not require the host SDKs
  used by unrelated Go/Rust/browser targets.
- Two uncached builds in different checkout/output paths produce identical
  ELF/BIN/HEX hashes. Repeat without networking after dependency preparation.
  Check map/report paths too if their reproducibility is part of the contract.
- Action inspection shows declared compiler/runtime/sysroot/linker/tool inputs,
  with no accidental host include or library paths.
- The board boots after a power cycle without a debugger and communicates via
  the chosen transport. The map preserves reserved flash and all required
  startup/crypto/enrollment symbols.
- Known-answer crypto tests and a host/board exchange exercise the actual
  Ed25519 profile, signed enrollment, replay/corruption handling and reboot.
- Storage fault injection and interrupted-write/power-cycle tests establish
  record recovery and nonce-range nonreuse, including compaction and updates.
- Target measurements establish flash use, whole-call-chain/interrupt stack
  headroom, latency and transport buffers. Individual `.su` entries alone do
  not establish peak RAM.

Pin the programmer/debugger independently from the compiler. The current
Zephyr board documentation warns that full WBA6 OpenOCD support arrived after
the 0.12.0 tag; the generic tool name is not enough to establish compatibility.
STM32CubeProgrammer is its default flashing runner.
[Board programming/debug notes](https://docs.zephyrproject.org/latest/boards/st/stm32wba65i_dk1/doc/index.html).
Consult the actual silicon revision against [ES0644 device errata](https://www.st.com/resource/en/errata_sheet/es0644-stm32wba6xxx-device-errata-stmicroelectronics.pdf)
when qualifying the chosen peripherals.

## Decisions left for the planning discussion

The research supports discussing these choices on return, without blocking on
answers now:

- In-repository application package versus an independently released project.
- First-demo behavior and UART versus a requirement for BLE from the outset.
- Supported build execution hosts; Linux x86-64 is the narrowest initial scope.
- Physical board revision and existing TrustZone/boot configuration.
- Single-image bring-up versus an initial secure/nonsecure architecture.
- Provisioning, persistent flash layout, update behavior and intended resistance
  to physical rollback/key extraction.
- Exact compiler, `rules_cc`, Cube components and sodium build configuration to
  validate and pin together.

The hardware identification and architectural fit are well supported. A working
firmware link, reproducibility proof, physical-board execution and persistent
storage qualification remain implementation work.

## Reproducing the compile-only observations

These commands describe the isolated research experiments above. They use the
host-installed compiler, and are not the proposed hermetic build interface.
Run from the repository root. The ABI check prints assembly size directives:

```sh
arm-none-eabi-gcc -mcpu=cortex-m33 -mthumb -I. -x c -S -o - - <<'EOF'
#include "core/sc.h"
unsigned char context_bytes[sizeof(sc_context)];
unsigned char state_bytes[sizeof(sc_state)];
unsigned char max_record_bytes[SC_MAX_RECORD];
unsigned char max_frame_bytes[SC_MAX_FRAME];
EOF
```

The stack check writes only temporary compiler outputs:

```sh
research_tmp=$(mktemp -d /tmp/sc-m33-research.XXXXXX)
nanopb_header=$(bazel cquery @nanopb//:pb.h --output=files)
arm-none-eabi-gcc -std=c99 -Os -mcpu=cortex-m33 -mthumb \
  -ffunction-sections -fdata-sections -fstack-usage \
  -I. -I"$(bazel info execution_root)/$(dirname "$nanopb_header")" -c core/sc.c -o "$research_tmp/sc.o"
cat "$research_tmp/sc.su"
rm -rf "$research_tmp"
```
