# Browser acceptance coverage

The current demo has two chapters: **Establish trust** and **Credits**. The
Playwright suite exercises the generated production site beneath a
`/simple-crypts/` URL prefix, including its workers and WebAssembly module.
It does not replace the endpoints with mocks or invoke test-only crypto exports.

## Audit and coverage

The existing suite covered the main guided exchange, corruption, replay,
expiration, credit arithmetic, and drop/retry behavior. This audit added
lifecycle checks, exact message-action labels, durable pending-state assertions,
loading failures, consistent background-error detection, failure diagnostics,
and a deployment gate.

| Area | Acceptance checks |
| --- | --- |
| Clean enrollment | Both roles and serial shown before key generation; server key pinned; signature verified before device key creation; explicit approval precedes confirmation |
| Enrollment faults | Reversible corruption, rejected packets preserve state, repeated claims and confirmations, reflection, expiration before approval, successful recovery, time changes after enrollment |
| Credit exchange | Entry from enrollment and directly from the chapter link; issuing +100, consuming +25, stage-specific control availability, exact status-report/receipt labels, server's last report stays stale until delivery |
| Snapshots and receipts | Authenticated response accepted; tampered response rejected and recoverable; receipt contains request ID rather than data fields; both sides settle with no pending work |
| Overspending | Repeated presses of the real + control; valid debits persist; rejected debit preserves the balance and creates no report |
| Loss and repetition | Drop leaves both endpoint states unchanged; server stays pending; retry uses different wire bytes with the same request ID; duplicate delivery adds no credits; report/receipt settle the exchange |
| Navigation and resets | Hide/reopen guidance, chapter switching with a pending frame, clean session reset, reload, retry after rejection, completed enrollment retry, credits restart, no Sandbox navigation |
| Pointer interaction | Actual mouse and emulated touch drags, taps that do not deliver, Escape/touch cancellation with no state change or stranded drag preview |
| Layout | No horizontal overflow; completion actions side by side on the 390×844 touch viewport; browser screenshots for manual inspection |
| Startup | Controls locked while Wasm loads; chapter clicks during loading do not switch state; recovery when loading resumes; missing secure randomness and failed Wasm loading show an error and keep actions disabled |
| Background health | Unexpected page exceptions, console errors, HTTP failures, failed asset requests, and visible application errors fail ordinary scenarios, including touch contexts |

Assertions check public endpoint state and returned library status as well as
visible text. Expected failures are isolated in their own browser contexts.
Cancelled navigation requests are excluded from background network failures.
The suite uses event/condition waits, not fixed timing sleeps or whole-test
retries that could conceal a failure.

## Running before a demonstration

After installing the pinned dependencies as described in [web/README.md](../web/README.md):

```sh
bazel test //web:browser_test --test_output=errors
```

This target is deliberately explicit: `bazel test //...` does **not** include
manual browser targets. Chromium and Firefox run the desktop cases. Chromium
also runs the complete flow with emulated touch at 390×844.

To check the exact committed publication without rebuilding it:

```sh
python3 web/site.py --verify-site site
PLAYWRIGHT_BROWSERS_PATH=/tmp/simple-crypts-browsers \
  node web/browser_test.mjs site
```

Pages performs this asset verification and browser acceptance run before
uploading/deploying `site/`. A failure prevents deployment. This checks the
committed publication; changes to source assets still need to be rebuilt and
published through the documented site-generation process.

## Diagnostics and practical limits

Bazel saves traces and per-context diagnostic JSON in
`bazel-testlogs/web/browser_test/test.outputs/`. A failure additionally captures
screenshots, rendered HTML, and its exception. Direct Node runs use
`BROWSER_ARTIFACTS_DIR` or `/tmp/simple-crypts-browser-artifacts`. Open a trace
with `web/node_modules/.bin/playwright show-trace <trace.zip>`.
Pages uploads the same diagnostics as `browser-acceptance`, retained for seven
days. These are evidence for that workflow's commit; the historical report on
`/report/` is not rewritten.

This is not a visual pixel-baseline suite. It does not qualify Safari/WebKit,
physical touch devices, every viewport, or an unreliable demonstration network.
A quick check on the actual presentation device remains useful. Storage and
crypto-provider fault injection, nonce exhaustion, and cross-language behavior
belong to the separate protocol/conformance tests rather than browser mocks.
