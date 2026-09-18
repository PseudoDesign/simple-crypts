# Publishing the test report

The [GitHub Pages report](https://pseudodesign.github.io/simple-crypts/) is a
snapshot of the tested source commit. It includes all sixteen language pairings,
their recorded scenario seeds, per-target logs, independent crypto evidence,
and the Cortex-M4 resource report. The page distinguishes local Bazel results
and cache hits from GitHub-hosted execution; the Pages workflow deploys evidence,
it does not rerun the cryptography tests.

The generated `site/` directory is committed to `main`. The Pages workflow
verifies its evidence hashes and embedded data, then uploads **only `site/`**.
It runs when the report or deployment configuration changes, and can also be
run manually. No build caches, SDK downloads, relay state, or enrollment stores
are published.

To refresh the report from a clean source checkout:

```sh
bazel test //... --build_event_json_file=/tmp/simple-crypts-report.bep.json
bazel build //platforms/cortex_m4:resource_report
python3 tools/test_report.py \
  --bep /tmp/simple-crypts-report.bep.json \
  --source-commit "$(git rev-parse HEAD)" \
  --output site
python3 tools/test_report.py --verify-site site
```

Commit the resulting `site/` files and push to `main`. The source commit records
the code tested before that report-only commit. Do not label results with a
commit that differs from the tested source. The generator requires a completed,
successful Bazel invocation, summaries for every configured test, all sixteen
pairings, and the independent crypto/fuzz/sanitizer targets. It does not infer
success from stale files left in `bazel-testlogs`.

Results from Bazel's cache are legitimate results for unchanged declared inputs;
the report marks them explicitly and retains their original test timestamps.
To execute every test again, add `--nocache_test_results` to the test command.

This site contains public sample fixtures and test evidence only. The full
interactive device/relay/server simulation remains a separate milestone.
