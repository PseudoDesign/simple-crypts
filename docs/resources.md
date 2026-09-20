# Shared resources and the credits module

Resource schemas are build-time definitions. `schema/resources.json` declares
the default credits schema; `schema/test_resources.json` exercises other types
and multiple groups. Run `python3 tools/resource_schema.py` to regenerate C
descriptors, language constants, and browser metadata. Bazel's
`//tools:resource_schema_check` regenerates and compares these outputs; its
schema validator rejects oversized groups. Nanopb generation is checked separately.

## Resource definitions

Each group has a stable numeric ID, fields with stable numeric IDs, one writer
per field, and optional atomic validation. Supported types are uint64, int64,
Boolean, bounded UTF-8 text (without NUL), and bounded bytes. Monotonic fields
must be uint64. Defaults are zero, false, and empty. Validators must accept the
initial values. Schemas and callbacks have static lifetime; validators are pure
and may not cause external side effects or mutate state.

The C API accepts a schema through `sc_config.data_schema`; NULL selects credits.
The host SDK and browser use the generated default schema. Changing a schema
requires rebuilding participants and starting compatible stores. A SHA-256
schema identifier binds each encrypted packet and stored record to its field
IDs, types, ownership, bounds, and declared validation policy. Implementations
must bump the schema version when changing a validator's semantics.

Current compile-time ceilings are two groups, five fields per group, 64 bytes
per variable-length value, and 160 encoded bytes per group. C buffers are
caller-owned; the engine allocates no heap. Each group stores current values,
a captured response, revision/request counters, and pending flags. The record
buffer is calculated from these ceilings and checked against nanopb's maximum
record size. Packet maximum size is also checked against the 512-byte envelope.

`sc_data_update_group` applies typed field updates atomically. Ownership, type
bounds, monotonicity, and group validation apply to local and remote changes.
`sc_data_inspect` copies values and synchronization state into caller memory.
`sc_data_request` asks for a fresh snapshot. Host bindings offer `update_group`,
`request_group`, and `inspect_group` (with language-appropriate naming).
Host updates encode typed fields for the same C validator; no validation is
trusted solely to a language wrapper. C consumers normally use typed structs.

## Requests and snapshots

The server requests group snapshots. Changing a server-owned field also opens
a new request; an identical update is a no-op. Device-owned changes stay local.
Each request sends the complete current group; the device applies only its
peer's owned fields, then validates and atomically captures its current group.
Request IDs are independent of local revisions and cryptographic nonces.

A response is frozen for its request ID. A duplicate request resends that
snapshot even if local state has since changed. A newer request supersedes the
old response and captures current values. Older requests and responses do not
roll back state. A duplicate with conflicting content is rejected.

The server records responses only for its current, durably sent request and
returns a receipt. Receipt IDs cannot exceed a device's durably sent response.
Receipts create no new reports. Pending work and captured snapshots persist
across reboot. Transmission rotates among groups so a withheld response cannot
starve another group's traffic. There are no automatic timers or keepalives.

## Credits

Group 1 contains `issued` (field 1, server-owned) and `consumed` (field 2,
device-owned). Both are monotonic uint64 totals. The group validator requires
`consumed <= issued`; generic update APIs cannot bypass this rule.

- `set_credits_issued(total)` increases the cumulative grant and requests status.
  The same total is a no-op; decreasing it is rejected.
- `consume_credits(amount)` commits local consumption before returning success.
  It rejects zero, insufficient credits, overflow, and unconfirmed enrollment.
  It generates no report.
- `request_credit_status()` asks for a new snapshot without changing issuance.

Fresh enrollment starts with zero credits. Ordinary reboot preserves totals.
The server's consumption is its last reported value, not a live balance. The
device enforces spending using its accepted issuance. A repeated grant of 100
still means 100 total credits, not another 100.

The caller must coordinate durable debit with any external physical action;
this library does not atomically transact with external hardware. Key and
counter storage must meet the platform's integrity and anti-rollback contract.
All SDK diagnostic uint64 values are decimal strings; browser arithmetic uses
BigInt. Credit totals do not expire.

Desired/applied configuration, arbitrary remote commands, multi-writer merging,
and event history are outside this initial resource layer.
