# Publishing the demo and test report

The [GitHub Pages homepage](https://pseudodesign.github.io/simple-crypts/) presents a
project overview, with links to the live C/WebAssembly demos at `demo.html` and `demo.html#credits`. The [test report](https://pseudodesign.github.io/simple-crypts/report/)
is a separately attributed snapshot of tested source. Existing resource and log
URLs remain available. Hardware measurements are maintained separately from demo publication.

`web/` contains editable demo sources. Bazel generates a preview site under
`bazel-bin/web/site`; committed `site/` contains the published static assets.
The recorded report under `site/report/` supplies existing evidence without
rerunning the hardware build. Demo builds do not change its source revision,
test timestamps, cache labels, or result counts.

The fleet application's editable sources live under `examples/`; `//web:site`
includes its static bundle at `examples/fleet_manager/`. New demo manifests
inventory both examples. The verifier continues to accept the previous manifest
format so the existing committed site can remain published until intentionally
regenerated. No saved browser database or native identity store is packaged.

## Publish a tested demo revision

1. Bootstrap the pinned SDKs and run the library and web checks:

   ```sh
   bazel test //...
   bazel build //web:site
   npm ci --prefix web --ignore-scripts --no-audit --no-fund
   PLAYWRIGHT_BROWSERS_PATH=/tmp/simple-crypts-browsers web/node_modules/.bin/playwright install chromium firefox
   bazel test //web:browser_test --test_output=errors
   bazel test //examples/fleet_manager:browser_test --test_output=errors
   ```

2. Commit the tested implementation. Assemble the publishable assets using
   that immutable source revision, then verify them:

   ```sh
   python3 web/site.py --output site --source-commit "$(git rev-parse HEAD)"
   python3 web/site.py --verify-site site
   PLAYWRIGHT_BROWSERS_PATH=/tmp/simple-crypts-browsers node web/browser_test.mjs site
   PLAYWRIGHT_BROWSERS_PATH=/tmp/simple-crypts-browsers node examples/fleet_manager/browser_test.mjs site/examples/fleet_manager
   ```

3. Commit the generated assets and push to `main`. The existing Pages workflow
   verifies demo hashes and report evidence before uploading only `site/`.
   Confirm deployment and exercise the live guided tour.

`demo.json` identifies the tested source and hashes every demo HTML/CSS/JS/Wasm
asset. Working-tree previews intentionally use `working-tree` instead of a
commit; deployment verification rejects that placeholder. The workflow verifies
committed evidence and assets; it does not claim to rerun the protocol tests.

## Refresh recorded test evidence separately

The existing report generator now defaults to `site/report/` so it cannot
replace the demo homepage. To refresh it deliberately, capture a complete
successful Bazel invocation and supply the resource snapshot being reported:

```sh
bazel test //... --build_event_json_file=/tmp/simple-crypts-report.bep.json
python3 tools/test_report.py \
  --bep /tmp/simple-crypts-report.bep.json \
  --source-commit "$(git rev-parse HEAD)" \
  --resources site/report/resources/cortex-m4.json \
  --resource-markdown site/report/resources/cortex-m4.md \
  --output site/report
```

The existing resource snapshot remains historical evidence; its hardware limits
still apply. Reassemble the site after report changes so legacy evidence URLs
and `/report/` agree. Do not attribute hardware results to changed hardware code
without rebuilding that measurement. Bazel cache hits are labeled and retain
their original timestamps. No caches, identity stores, or private keys are
published.

The site build now includes `//docs:api`; install the quality/documentation tools
listed in [quality.md](quality.md) before assembly. API HTML is published at
`/api/`, while XML remains a local/CI artifact. Manifest version 4 inventories
API assets independently of the demo bundle. Assembly replaces the entire API
subtree to remove obsolete pages. Existing manifest versions remain verifiable.
