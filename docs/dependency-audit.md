# Dependency and repository footprint audit

Audited 2026-09-20 across module declarations, third-party source, language
manifests, bootstrap downloads, BUILD files, build drivers, CI, documentation,
and generated publication assets.

## Changes

| Finding | Resolution |
| --- | --- |
| `platforms` was declared as a module but overridden with a full source copy | Resolve `platforms` 1.0.0 from BCR; remove the override, archive provenance entry, and copied tree |
| nanopb's full repository was copied for a small runtime and generator | Resolve 0.4.9.1.bcr.3 from BCR; retain a small source adapter for the existing build drivers |
| libsodium 1.0.20's complete release was committed | Fetch the exact checksummed release through `http_archive`; keep the BUILD overlay and existing version-header adaptation |
| Cargo dependencies were checked in under `third_party/rust_crates` | Download exact Cargo.lock archives into an external repository, verified by Bazel before offline Cargo builds |
| Go oracle dependencies were checked in under `tests/crypto/vendor` | Download checksum-pinned Go proxy files into the external repository; compile against its file proxy with read-only module selection |
| Dependency include paths and generators assumed sources lived in the checkout | Derive action paths and runfile paths from declared Bazel Files; update native, Arm, Wasm, sanitizer, schema, lint, and documentation consumers |
| Formatting excluded every file under `third_party` | Include project-owned adapters in source ownership and quality gates; exclude external source paths |
| Shared `.bazelrc` imposed a `/tmp` cache, batch mode, and four jobs | Move machine-specific settings to ignored `.bazelrc.local`; use Bazel defaults in new checkouts |
| Board plans proposed more copied dependency trees | Specify BCR or checksum-pinned archive overrides with small reviewed patches and BUILD overlays |

## Retained inputs and limits

- `tools/bootstrap.py` and `tools/downloads.lock.json` install pinned Go, Rust,
  Python packages, protoc, Emscripten, and quality executables in ignored
  `.toolchains`. These are local SDK installations, not copied upstream source
  committed to the repository. The existing SDK repositories remain explicit
  action inputs. This audit does not claim that they are registered portable
  Bazel toolchains.
- `web/package-lock.json` pins browser and quality packages; ignored
  `web/node_modules` is populated with `npm ci`. Browser engines are separately
  prepared for the manual browser acceptance target.
- Generated schema codecs and resource bindings remain checked in because public
  C/language consumers use them; regeneration checks cover their source schemas.
- `site/` contains the deliberately published site and recorded test evidence.
  It is not a dependency vendor tree. Its commit/hash validation and publishing
  workflow require preserving those snapshots until deliberate republication.
- Licenses remain in fetched dependencies, and browser distributions retain
  `web/THIRD_PARTY_NOTICES.txt`.
- The current C/Arm/Go/Rust/Wasm drivers remain project-specific rules. C/Arm
  compilers, Python, Make, Node.js, and documentation tools still include system
  prerequisites. Replacing them with standard language rules and registered
  toolchains is a separate portability migration; changing storage alone does
  not make this build fully hermetic.

## Policy for additions and updates

1. Use a pinned `bazel_dep` for a suitable BCR module.
2. If the required release or build interface is absent, use a checksum-pinned
   archive and keep only the needed adapter/patch in the repository. Document
   why the exception exists and keep upstream license information.
3. Keep package resolution in the language lockfiles. Refresh the small Bazel
   download lock with `python3 tools/lock_dependencies.py`; never hand-copy a
   package tree. Verify with `bazel test //tools:dependency_lock_check`.
4. Fetch dependencies before offline use. Compiler and test actions must consume
   declared inputs rather than downloading packages or discovering workspace
   copies. Bazel vendor mode is available for an intentional offline bundle.
5. Check module resolution, the full test suite, Arm resource reports, Wasm
   outputs, and generated API documentation when changing shared dependencies.

References: [BCR platforms](https://registry.bazel.build/modules/platforms/),
[BCR nanopb](https://registry.bazel.build/modules/nanopb/),
[BCR libsodium](https://registry.bazel.build/modules/libsodium/),
[Bazel external dependencies](https://bazel.build/external/overview), and
[Bazel vendor mode](https://bazel.build/external/vendor).

## Validation

- `bazel test //...`: all 45 tests pass, including the conformance matrix,
  sanitizers, Go/Rust analysis, C lint, schema checks, API documentation, and
  Wasm protocol/site tests.
- `bazel test //... --nofetch --lockfile_mode=error`: all 45 tests pass with
  the prepared cache and no repository fetching or lockfile updates.
- The compared libsodium sources and nanopb runtime/generator files (607 files)
  match the previous copies byte-for-byte.
- The deleted dependency trees contain 1,779 files totaling 17,208,377 bytes.
  Only small project-owned adapters, a version-header patch, and manifests remain.
