# Pinned third-party code

- **libsodium 1.0.20** — upstream source archive from libsodium.org. ISC license in `libsodium/LICENSE`. Build adds `BUILD.bazel` and a generated `src/libsodium/include/sodium/version.h` with the release's version constants; cryptographic source is unchanged. Both builds use portable C with assembly disabled; the host build also disables PIE so the static library can be linked into the SDK shared object.
- **nanopb 0.4.9.1** — upstream Git tag archive. Zlib license in `nanopb/LICENSE.txt`. `BUILD.bazel` adapts the runtime/generator to this workspace. Generated application codecs live in `schema/`.
- **Bazel platforms 0.0.11** — upstream tag archive, Apache-2.0 license. Local Bzlmod override avoids a separate platform-repository fetch.
- **Rust crates** — `cargo vendor` output, exact package checksums in each `.cargo-checksum.json`, versions in `bindings/rust/Cargo.lock`, each crate's original license files retained. Used with Cargo offline and locked.
- **Go oracle dependencies** — `tests/crypto/vendor` contains `golang.org/x/crypto v0.36.0` and `golang.org/x/sys v0.31.0`, resolved by `tests/crypto/go.mod`/`go.sum`; BSD license notices retained.

Original archive URLs and SHA-256 values are in `tools/downloads.lock.json`. Downloaded SDKs are reconstructed by `tools/bootstrap.py` and are not committed. Source code remains in the repository so tests have no runtime network dependency.
