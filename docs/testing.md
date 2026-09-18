# Conformance and replay

`tests/coordinator.py` starts two persistent adapter processes. Each adapter
calls its language's public SDK; Rust and Go do not launch the C adapter.
JSON Lines is the control protocol. Binary envelopes are base64-wrapped only
within this local control channel, and adapter diagnostics go to stderr.

`tests/conformance.py` supplies the same scenarios to all sixteen combinations
of C, Python, Rust, and Go. Both directions are exercised in every pairing.
Commands and delivery schedules are deterministic. Virtual time advances are
recorded relay actions; they do not sleep or trigger protocol traffic.

The coordinator can hold, drop, copy, reorder, corrupt, and deliver frames;
give either endpoint a byte-budgeted transmission opportunity; inject provider
failures; and kill/restart a process using the same persistent storage. It
checks the full public state after rejected frames and checks nonces across
successful outputs and restarts. Fixed test seeds and provisioning secrets are
public fixtures, never production keys.

Coverage includes first-packet loss, unauthorized/conflicting enrollment,
lost receipts, duplicate claims, lost application reports, both snapshot
orders, tampering and reflection, reboot, failed commits and reservations,
buffer limits, unavailable randomness, uint64 boundaries, long withholding,
and generated relay schedules. Direct binding tests cover ownership and
argument conversion separately from the JSON adapters.

Each failed scenario writes a JSON transcript and adapter stderr to Bazel's
`TEST_UNDECLARED_OUTPUTS_DIR`. A standalone run writes artifacts to a retained
temporary directory and prints that path. Transcripts record the scenario
seed, exact commands, frame bytes, relay actions, and public endpoint states.
They contain test provisioning fixtures; do not use this logger for real
enrollment secrets.

Replay against the same adapter builds:

```sh
python3 tests/conformance.py --device /path/to/c-adapter \
  --server /path/to/python-adapter --replay /path/to/scenario.json
```

Storage paths are remapped into a fresh temporary directory. Responses are
compared exactly. The replay runner reissues recorded commands; transport
events provide the human-readable explanation of those commands. Adapter
read deadlines detect a hung process and are not part of the simulated
delivery schedule.

`tests/crypto/vector.json` records the published NaCl fixture from libsodium
1.0.20's `box.c`, `box2.c`, and `box.exp`, with upstream source hashes. The
independent Go oracle imports `golang.org/x/crypto/nacl/box` and never the C SDK.
Tests check the published ciphertext exactly and test encryption/decryption
in both directions for empty, boundary-sized, and bounded maximum plaintexts,
including tag rejection. These checks are distinct from the shared-core
language matrix.

The C fuzz target exposes `LLVMFuzzerTestOneInput`; the ordinary test suite
also runs a deterministic seeded fuzz corpus. Sanitizer builds instrument
project-owned C code. Pinned upstream cryptographic code is built separately.
Fuzz smoke tests are bounded regression checks, not a claim of exhaustive
protocol analysis.

Run `bazel test //tests:sanitizers` for ASan and UBSan checks. The target uses
system GCC to instrument the core, generated schema, nanopb, portable sodium
provider, host storage provider, and C adapter. It runs the core contract tests,
the reusable fuzz entry point's seeded smoke corpus, and every C/C conformance
scenario. The pinned libsodium archive is linked without instrumentation.
Any compiler error, sanitizer report, or failed subprocess fails the target;
crashes are not retried. LeakSanitizer is disabled because the execution host
uses ptrace, which LeakSanitizer does not support. Address and undefined-behavior
checks remain enabled, and UBSan findings stop execution.
