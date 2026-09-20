# External dependencies

Keep only project-owned Bazel adapters and necessary patches here. Upstream source
belongs in Bazel's external repository cache, not in this checkout. Prefer pinned
BCR modules; use checksummed release archives when the required release or build
interface is unavailable. Preserve licenses in fetched sources and distribution
notices. Never downgrade a dependency just to use a registry entry.

| Dependency | Source and pin | Local integration |
| --- | --- | --- |
| Bazel platforms | BCR `platforms` 1.0.0 | `MODULE.bazel`; no override or local snapshot |
| nanopb | BCR `nanopb` 0.4.9.1.bcr.3 (runtime/generator 0.4.9.1) | `nanopb/BUILD.bazel` shares upstream sources with the existing C, Arm and Wasm drivers |
| libsodium | Upstream 1.0.20 release archive, SHA-256 in `MODULE.bazel` | `libsodium.BUILD.bazel` exposes sources; `libsodium/BUILD.bazel` preserves portable builds; `libsodium-version.patch` supplies the existing release version header |
| Rust crates | crates.io archives, versions and checksums from `bindings/rust/Cargo.lock` | `//build:dependencies.lock.json` and `language_sources` expose an external Cargo directory source |
| Go oracle modules | Go module proxy archives, verified against `tests/crypto/go.sum` | The same download lock exposes a local file proxy; Go checks its module sums during offline compilation |

BCR currently provides libsodium 1.0.19, while this project requires 1.0.20. Its
archive adapter preserves `--disable-asm`, `--enable-minimal`, and the existing
host/Arm/Wasm configure settings. No cryptographic implementation is patched.
The tiny version-header patch is derived from upstream `version.h.in` and must
be reviewed alongside any libsodium version change.

The language source adapter preserves the current Cargo/Go action drivers. It
fetches through Bazel with archive checksums; it does not resolve package versions
or permit compiler actions to access the network. After intentionally changing
Cargo.lock or go.sum, run `python3 tools/lock_dependencies.py`, then
`bazel test //tools:dependency_lock_check`. This command verifies Go's `h1` module
checksums before recording archive SHA-256 values. `bazel test //...` includes the
lock consistency check.

Bootstrap SDKs and npm packages are pinned, ignored local installations, not
committed dependencies. See [the audit](../docs/dependency-audit.md) for the full
inventory and remaining toolchain portability limits. For offline preparation,
use Bazel's repository cache or vendor mode for the desired targets; do not add
manual `local_path_override` snapshots to the main module.
