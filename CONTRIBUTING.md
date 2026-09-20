# Contributing to Simple Crypts

Start with the [README](README.md) for the application model and
[tools/README.md](tools/README.md) for the supported Linux x86-64 build profile,
system packages, and pinned tool versions.

## Set up and check a change

After installing the system prerequisites and Bazel 9.2.0:

```sh
python3 tools/bootstrap.py
npm ci --prefix web --ignore-scripts --no-audit --no-fund
web/node_modules/.bin/playwright install --with-deps chromium firefox
bazel test //... --lockfile_mode=error
bazel build //docs:api //platforms/cortex_m4:resource_report --lockfile_mode=error
bazel test //web:browser_test //examples/fleet_manager:browser_test --lockfile_mode=error --nocache_test_results
```

The two explicit browser targets are tagged `manual`, so `bazel test //...`
does not run them. They check freshly built applications in Chromium and Firefox.
CI runs all the commands above and saves diagnostics. If you set a custom
`PLAYWRIGHT_BROWSERS_PATH`, export it and add
`--test_env=PLAYWRIGHT_BROWSERS_PATH` to the browser test command.

For a focused edit, run its relevant targets first. Before requesting review,
run the complete checks or state which checks could not run and why. Find
individual formatting, lint, and documentation gates in [docs/quality.md](docs/quality.md).
Format maintained sources intentionally with:

```sh
python3 tools/repository_quality.py format
```

Review the resulting diff. Keep machine-specific Bazel options in ignored
`.bazelrc.local`, and keep downloaded SDKs, package caches, and build outputs out
of commits.

## Dependencies and generated files

Prefer Bazel Central Registry modules. For dependencies absent from BCR, use a
checksum-pinned upstream archive and a small BUILD adapter; document exceptions
in the [dependency audit](docs/dependency-audit.md).

When intentionally changing dependencies, update the relevant manifests and
locks together. Run `python3 tools/lock_dependencies.py` after changing Cargo or
Go locks. Resolve intentional Bazel module changes with `bazel mod deps
--lockfile_mode=update`, review `MODULE.bazel.lock`, then run checks with
`--lockfile_mode=error` again. Keep bootstrap versions and checksums together in
`tools/downloads.lock.json`.

Edit `schema/sc.proto` and its options, then run
`bazel run //tools:schema_generate` to regenerate the nanopb codec. Edit
`schema/resources.json`, then run `python3 tools/resource_schema.py` to regenerate
resource descriptors and binding constants. Commit generated source changes
with their inputs; the test suite checks that they agree.

`site/` is a recorded publication snapshot. Update it only through the
[publishing workflow](docs/publishing.md), with its manifests and evidence kept
consistent. Preview application changes through Bazel targets before publishing.

## Prepare a pull request

Explain the problem, the resulting behavior, and the validation performed.
Add a regression test for a behavior fix, update affected API documentation,
and identify changes to protocol, persistence, ABI, or dependency contracts.
Keep unrelated formatting and generated publication changes separate so the
behavioral diff is easy to review. Screenshots or browser traces help for visual
or interaction changes.

Project code is licensed under the [MIT License](LICENSE). Preserve third-party
copyright and license notices; external dependencies retain their own licenses.
