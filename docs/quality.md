# Repository quality checks and API documentation

Quality rules cover all maintained first-party code: the C library and providers,
C/C++ adapters, tests and browser bridges, Python, Go, Rust, JavaScript, HTML,
CSS, Bazel/Starlark, and configuration/schema files. Tests and examples follow
the same rules as production code. `tools/source_policy.py` defines ownership;
vendored dependencies, toolchains, generated schema bindings, and published site
artifacts are excluded from source rewriting. Schema/codec regeneration checks
and site asset manifests validate generated outputs separately. Recorded evidence
is retained unchanged.

Use Linux x86_64 and the [build prerequisites](../tools/README.md). LLVM and
Doxygen are version-checked system tools, matching Ubuntu 24.04 packages:

```sh
sudo apt-get install nodejs npm clang-18 clang-format-18 clang-tidy-18 doxygen
python3 tools/bootstrap.py
npm ci --prefix web --ignore-scripts --no-audit --no-fund
bazel test //tools:quality
bazel build //docs:api
```

| Source | Formatting | Analysis and documentation |
| --- | --- | --- |
| C/C++ and headers/includes | clang-format 18.1.3 | clang-tidy 18.1.3, Clang Static Analyzer; Doxygen 1.9.8 for application APIs |
| Python | Ruff 0.11.13 | Ruff correctness/bugbear checks; public binding docstrings, AST-generated reference |
| Go | gofmt, Go 1.24.4 | go vet for bindings, adapters, oracle and documentation tool; Go AST validates exported binding comments |
| Rust | rustfmt 1.85.1 | Clippy 1.85.1 with warnings denied, missing public docs denied, rustdoc reference |
| JavaScript | Prettier 3.5.3 | ESLint 9.28.0, exported API JSDoc, parsed reference |
| HTML/CSS | Prettier 3.5.3 | html-validate 8.29.0 and Stylelint 16.20.0 correctness checks |
| Bazel/Starlark | Buildifier 8.2.1 | Buildifier lint and Bazel analysis |
| JSON/YAML | Prettier 3.5.3 | Syntax validation and consuming build/workflow/schema checks |
| TOML, Protocol Buffers, linker scripts | Native conventions; clang-format for `.proto` | TOML parsing, pinned protoc regeneration, ARM compilation/linking |

Bootstrap downloads checksum-pinned Ruff, Buildifier, SDKs, Rustfmt and Clippy.
Browser tools use exact versions in `web/package.json` and its npm lockfile.
No test downloads dependencies. Incompatible LLVM/Doxygen versions fail with a
clear diagnostic. `SC_QUALITY_BIN` can select an unpacked installation; pass it
using `--action_env=SC_QUALITY_BIN --test_env=SC_QUALITY_BIN` and expose its
runtime libraries to Bazel actions when required.

Individual read-only gates:

```sh
bazel test //tools:format_check
bazel test //tools:lint
bazel test //docs:api_check
bazel test //docs:example
```

To intentionally format maintained sources from the checkout:

```sh
python3 tools/repository_quality.py format
```

Checks never rewrite source. C/C++ uses four spaces, attached braces, expanded
control-flow bodies, 100 columns and preserved include order. Other languages
use their formatter's conventional style, with 100 columns where supported.
Keep mechanical formatting separate from behavior changes.

Clang analysis uses compilation metadata from the Bazel rules, including C99,
C++17, transitive includes, production/testing defines, Emscripten headers and
Cortex-M4 targeting. Included `.inc` implementations are analyzed through their
containing translation unit. Dependency headers remain available to analysis,
but diagnostics from vendored sources are not lint targets. Any suppression
must name one check and explain the false positive next to the code. Do not
add blanket baselines. The generated Rust resource constants have a narrowly
scoped documentation exemption because the schema generator owns that file.

Public documentation describes ownership, lifetime, buffers, units, prerequisites,
errors and persistence effects. Use Doxygen comments for C/example headers,
docstrings for Python, Go comments, Rust doc comments and JSDoc for exported
browser interfaces. Comments on private code explain invariants and decisions.
Fixture helpers are identified as test-only; example interfaces are separate from
the stable C library API. None of these rules changes the public C ABI, wire
format, storage format or C99 requirement.

`bazel-bin/docs/api/html/index.html` links the C reference to the Python, Go,
JavaScript and Rust references. C also emits XML; Python/Go/JS emit `api.json`
with parsed signatures and contracts. All references support search. Generation
fails on missing public documentation, incomplete C parameter documentation or
broken local links. Python extraction never imports the native binding or opens
a store; Rust documentation compiles offline against pinned dependencies.

Failure fixtures exercise formatting, static-analysis and documentation gates.
Documentation builds are compared across different source/output paths. Existing
sanitizer, fuzz-smoke, conformance, browser and platform checks remain necessary;
static analysis does not establish protocol correctness.

The [published reference](https://pseudodesign.github.io/simple-crypts/api/) is
assembled at `/api/`. The asset manifest inventories every reference asset and
rejects missing or changed files. Regeneration removes obsolete reference files
while preserving recorded evidence. See [publishing](publishing.md).
