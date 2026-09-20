# C quality checks and API documentation

The enforced scope is the C core, credits module, and host/libsodium providers,
including their headers and included `.inc` implementations. Generated schemas,
vendored libraries, C adapters/tests/bridges, and the C++ console are not formatting
inputs. Dependencies are still parsed when needed to analyze the library.

Use Linux x86_64 with the normal [build prerequisites](../tools/README.md), plus
**clang-format 18.1.3, clang-tidy 18.1.3, and Doxygen 1.9.8**. Ubuntu 24.04 provides
these versions in `clang-format-18`, `clang-tidy-18`, and `doxygen`:

```sh
sudo apt-get install nodejs clang-18 clang-format-18 clang-tidy-18 doxygen
python3 tools/bootstrap.py
bazel test //tools:quality
bazel build //docs:api
```

Tools are version-checked system prerequisites, like the existing C compiler;
they are not downloaded during builds or tests. A mismatched version fails with
an explicit diagnostic. CI installs the same upstream versions. For an unpacked
local installation, `SC_QUALITY_BIN` can select its executable directory; pass it
explicitly using Bazel `--action_env=SC_QUALITY_BIN --test_env=SC_QUALITY_BIN`.
Custom installations must also expose their runtime libraries to Bazel actions.

Individual read-only gates:

```sh
bazel test //tools:format_check
bazel test //tools:lint
bazel test //docs:api_check
bazel test //docs:example
```

To intentionally format scoped sources from the checkout:

```sh
python3 tools/quality.py --format
```

Formatting uses four spaces, attached braces, expanded control-flow bodies, a
100-column limit, and preserved include order. Keep formatting commits separate
from functional fixes. The checks never rewrite files.

Clang-tidy uses compilation metadata emitted by the same Bazel library rules as
normal builds, including C99 flags, defines and transitive includes. Production
and `SC_ENABLE_TESTING` variants are analyzed. Included `.inc` files are analyzed
through `core/sc.c`. Only scoped diagnostics are enforced; dependencies are not
lint targets. Analyzer core/dead-store/Unix/security checks and focused memory,
macro, numeric-conversion and braces lint checks are enabled in `.clang-tidy`.
Any suppression must identify one check, explain the false positive beside the
code, and preserve regression coverage. Do not introduce blanket baselines.

Write public API contracts in the headers using Doxygen comments. Describe
parameters, ownership, buffers, units, return codes, state requirements and
persistence effects. Internal comments should explain invariants and decisions.
Context implementation fields are intentionally hidden from the reference;
fixture helpers have their own section. Generated HTML is in
`bazel-bin/docs/api/html/index.html`, with XML in `bazel-bin/docs/api/xml`.
Doxygen warnings and missing parameter documentation fail the build. The
compiled example is included directly from its tested C source.

`//tools:quality_test` proves the gates reject bad formatting, a null dereference,
missing declaration/parameter documentation and broken references. It also
compares generated documentation from different source/output directories.
Existing sanitizer, conformance, browser and platform checks remain necessary:
static analysis is not proof of protocol correctness.

The [published reference](https://pseudodesign.github.io/simple-crypts/api/) is
assembled into the existing site at `/api/`. Its asset hashes are inventoried
alongside the demo, and its source revision is recorded by `demo.json`.
Publication preserves previously recorded test evidence. See
[publishing](publishing.md) for the source-then-site release workflow.
