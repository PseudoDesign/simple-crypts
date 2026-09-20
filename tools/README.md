# Reproducible sample build profile

The supported development profile is **Linux x86_64, CPython 3.12, Bazel 9.2.0**. Install Node.js 18+ at `/usr/bin/node`, npm, system GCC/binutils, make, and the ARM bare-metal GCC/newlib tools before bootstrapping. The full `bazel test //...` suite also requires clang-format/clang-tidy **18.1.3** and Doxygen **1.9.8**, matching the Ubuntu 24.04 CI profile. The recorded Cortex run uses `arm-none-eabi-gcc 13.2.1`. On Ubuntu 24.04, install the system packages below; install Bazel 9.2.0 separately or use Bazelisk with the root `.bazelversion`.

```sh
sudo apt-get install build-essential python3.12 nodejs npm gcc-arm-none-eabi binutils-arm-none-eabi libnewlib-arm-none-eabi clang-18 clang-format-18 clang-tidy-18 doxygen
```

```sh
python3 tools/bootstrap.py
npm ci --prefix web --ignore-scripts --no-audit --no-fund
bazel test //...
bazel run //examples:device_server_demo
bazel build //platforms/cortex_m4:resource_report
```

`bootstrap.py` fetches official release archives using committed SHA-256 checksums in `downloads.lock.json`, then creates ignored local SDK repositories under `.toolchains`. It installs Go 1.24.4, Rust/Cargo/Rustfmt/Clippy 1.85.1, Ruff 0.11.13, Buildifier 8.2.1, protoc 29.3, CFFI 1.17.1, pycparser 2.22, protobuf Python 5.29.3, and Emscripten 4.0.10. `--verify-only` verifies the cached archives and required system tools. Bootstrap and the first Bazel module fetch require network access; test execution does not. Bazel fetches nanopb/platforms from BCR, libsodium from its checksummed release archive, and locked Rust/Go source archives into its external cache. Cargo builds remain offline; Go uses a declared local file proxy and verifies go.sum. Run `python3 tools/lock_dependencies.py` after changing the language locks. `MODULE.bazel.lock`, Go `go.sum`, Rust `Cargo.lock`, crate checksums, and the bootstrap manifest preserve the dependency selections.

Project Bazel rules declare source files, external dependencies, SDK files, and outputs. The C/ARM compiler, newlib, shell utilities, Node.js, and system Python are **system prerequisites**, not a fully hermetic toolchain. Compiler or operating-system changes can change the measured sizes. `.bazelrc` disables Bazel's external native-rule autoloading because this sample uses explicit small rules; machine-specific output roots, batch mode, and job limits belong in ignored `.bazelrc.local`. See [the dependency audit](../docs/dependency-audit.md) for the inventory and remaining portability limits.

The checked-in nanopb codec is reproducible with `bazel test //tools:schema_check`. To regenerate intentionally:

```sh
bazel run //tools:schema_generate
```

The Cortex target emits `bazel-bin/platforms/cortex_m4/{resource_report.md,resource_report.json,probe.elf,probe.map,stack_usage.txt,size.txt}`. It compiles the actual protocol, nanopb codec, portable libsodium provider, and both box directions. The harness callbacks are explicitly nonproduction and the linker envelope is not a board capacity. Per-function `.su` entries do not establish peak stack use. A real board still needs reviewed durable storage, entropy/key provisioning, initialization, task/interrupt stack measurement, latency, and energy measurements.

Resource descriptors and language metadata are generated from `schema/resources.json`. Run `python3 tools/resource_schema.py` after editing the schema; `bazel test //tools:resource_schema_check` verifies all committed outputs and schema bounds.

The full test suite and site build also require clang-format/clang-tidy 18.1.3
and Doxygen 1.9.8. On Ubuntu 24.04 install `clang-18 clang-format-18 clang-tidy-18
doxygen`. See [repository quality checks](../docs/quality.md) for version enforcement,
read-only gates, and the explicit developer formatting command.
