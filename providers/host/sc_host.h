/** @file
 * @brief Durable Linux host convenience API.
 */
#ifndef SIMPLECRYPTS_HOST_H
#define SIMPLECRYPTS_HOST_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/** @brief Opaque heap-owned, single-threaded host endpoint with an exclusively locked durable
 * store. */
typedef struct sc_host sc_host;
/**
 * @brief Open or create an exclusively locked durable endpoint store.
 * @ingroup host
 * @details Owns allocated memory and software keys until sc_host_close(). Creates missing stores,
 * but rejects incompatible, corrupt or mismatched stores. Supplied strings and key bytes are
 * copied. Storage failures after uncertain writes poison the handle; close it and reopen through
 * normal initialization.
 * @param role SC_DEVICE (1) or SC_SERVER (2).
 * @param storage Non-null path to a private store directory owned by the current user.
 * @param serial Non-null printable ASCII serial of 1 through SC_MAX_SERIAL bytes.
 * @param secret Non-null 32-byte enrollment secret; must match an existing store.
 * @param seed Optional 32-byte provisioning seed; NULL generates a fresh identity for a new store.
 * @param server_key Required 32-byte pinned Ed25519 server public key on devices; ignored for
 * servers.
 * @param random_unavailable Nonzero simulates unavailable entropy for tests; use zero in
 * applications.
 * @param out Non-null handle destination; set to NULL before initialization and owned by the caller
 * on success.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
int sc_host_initialize(int role, const char *storage, const char *serial, const uint8_t *secret,
                       const uint8_t *seed, const uint8_t *server_key, int random_unavailable,
                       sc_host **out);
/**
 * @brief Permanently opt an unregistered context into signed enrollment.
 * @ingroup host
 * @details Call before legacy enrollment. Persists the mode; it cannot be disabled. Signed
 * enrollment needs sign/verify callbacks and server randomness. See sc_enrollment_enable(). The
 * handle owns its context and durable provider.
 * @param h Host handle; non-null except for sc_host_close().
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
int sc_host_enrollment_enable(sc_host *h);
/**
 * @brief Authorize or restart a signed enrollment session on a server.
 * @ingroup host
 * @details Requires signed mode, an unregistered server and expires greater than now. Generates a
 * fresh random challenge and persists the session. Application policy chooses the time units and
 * lifetime; use the same trusted clock for all server enrollment operations. See
 * sc_enrollment_begin(). The handle owns its context and durable provider.
 * @param h Host handle; non-null except for sc_host_close().
 * @param now Current trusted server time in application-defined units.
 * @param expires Exclusive expiry in the same units and clock as now.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
int sc_host_enrollment_begin(sc_host *h, uint64_t now, uint64_t expires);
/**
 * @brief Approve the exact received session and device key on a server.
 * @ingroup host
 * @details Application authorization must verify the displayed serial, challenge and candidate key.
 * Rejects expired or stale bindings. Persists enrollment and queues confirmation. Never expose this
 * operation to an untrusted relay. See sc_enrollment_approve(). The handle owns its context and
 * durable provider.
 * @param h Host handle; non-null except for sc_host_close().
 * @param challenge Exact 32-byte active session challenge.
 * @param key Exact 32-byte candidate Ed25519 public key.
 * @param now Current trusted server time in application-defined units.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
int sc_host_enrollment_approve(sc_host *h, const uint8_t challenge[32], const uint8_t key[32],
                               uint64_t now);
/**
 * @brief Cancel an unregistered server enrollment session.
 * @ingroup host
 * @details Clears the challenge, candidate and expiry durably. Does not revoke an already enrolled
 * device. See sc_enrollment_cancel(). The handle owns its context and durable provider.
 * @param h Host handle; non-null except for sc_host_close().
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
int sc_host_enrollment_cancel(sc_host *h);
/**
 * @brief Authenticate and process one complete incoming protocol frame.
 * @ingroup host
 * @details The server uses trusted time to enforce signed enrollment expiry. Accepted state changes
 * are committed before success. Responses remain pending for sc_outbound(); this call never sends
 * them. See sc_receive_at(). The handle owns its context and durable provider.
 * @param h Host handle; non-null except for sc_host_close().
 * @param frame Non-null frame buffer; borrowed for this call.
 * @param n Input frame byte count.
 * @param now Current trusted server time in application-defined units.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
int sc_host_receive_at(sc_host *h, const uint8_t *frame, size_t n, uint64_t now);
/**
 * @brief Apply typed field records as one atomic update.
 * @ingroup host
 * @details Each record contains a big-endian uint16 field ID, one-byte type, one-byte length, and
 * value bytes. Numeric values use eight big-endian bytes; Boolean values use one byte; text is
 * UTF-8 without a NUL terminator. Uses the same validation and persistence as
 * sc_data_update_group(). See sc_data_update_encoded(). The handle owns its context and durable
 * provider.
 * @param h Host handle; non-null except for sc_host_close().
 * @param id Resource group ID from the configured schema.
 * @param data Non-null encoded typed-record input.
 * @param size Input byte count.
 * @return SC_OK on success, SC_NOT_FOUND for an unknown group, or a negative sc_status.
 */
int sc_host_update_group(sc_host *h, uint16_t id, const uint8_t *data, size_t size);
/**
 * @brief Queue a new resource-group request on an enrolled server.
 * @ingroup host
 * @details Advances and persists the request ID. Does not transfer a frame. Exhausted counters fail
 * without wrapping. See sc_data_request(). The handle owns its context and durable provider.
 * @param h Host handle; non-null except for sc_host_close().
 * @param id Resource group ID from the configured schema.
 * @return SC_OK on success, SC_NOT_FOUND for an unknown group, or a negative sc_status.
 */
int sc_host_request_group(sc_host *h, uint16_t id);
/**
 * @brief Write NUL-terminated JSON diagnostics for one resource group.
 * @ingroup host
 * @details Includes encoded value bytes as hexadecimal and decimal-string counters. Insufficient
 * capacity returns SC_ERR_BOUNDS without truncation.
 * @param h Host handle; non-null except for sc_host_close().
 * @param id Resource group ID from the configured schema.
 * @param out Non-null JSON output buffer.
 * @param cap Writable buffer capacity, in bytes.
 * @return SC_OK on success, SC_NOT_FOUND for an unknown group, or a negative sc_status.
 */
int sc_host_inspect_group(sc_host *h, uint16_t id, char *out, size_t cap);
/**
 * @brief Release the store lock, wipe keys and free a host handle.
 * @ingroup host
 * @details Accepts NULL. Call once for every successful initialization; do not use the handle
 * afterward.
 * @param h Host handle; non-null except for sc_host_close().
 */
void sc_host_close(sc_host *h);
/**
 * @brief Set cumulative credits issued by an enrolled server.
 * @ingroup host
 * @details The total must not decrease. This is a cumulative total, not an increment. Requires the
 * credits schema; commits through sc_data_update_group() and queues protocol work. See
 * sc_set_credits_issued(). The handle owns its context and durable provider.
 * @param h Host handle; non-null except for sc_host_close().
 * @param total Cumulative issued total, in credits.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
int sc_host_set_credits_issued(sc_host *h, uint64_t total);
/**
 * @brief Consume a positive amount on an enrolled device.
 * @ingroup host
 * @details Requires the credits schema. Returns SC_ERR_CONFLICT when the resulting consumption
 * exceeds issued credits, SC_ERR_EXHAUSTED on uint64 overflow, and SC_ERR_ARGUMENT for zero.
 * Commits locally; the server learns consumption through a later report. See sc_consume_credits().
 * The handle owns its context and durable provider.
 * @param h Host handle; non-null except for sc_host_close().
 * @param amount Positive number of credits to consume.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
int sc_host_consume_credits(sc_host *h, uint64_t amount);
/**
 * @brief Queue a credit report request on an enrolled server.
 * @ingroup host
 * @details Requires the credits schema. Persists a new request ID through sc_data_request(); no
 * frame is transferred. See sc_request_credit_status(). The handle owns its context and durable
 * provider.
 * @param h Host handle; non-null except for sc_host_close().
 * @return Borrowed static status string; never free it.
 */
int sc_host_request_credit_status(sc_host *h);
/**
 * @brief Process one complete incoming protocol frame without trusted time.
 * @ingroup host
 * @details Equivalent to sc_receive_at() with UINT64_MAX. An unapproved signed server enrollment
 * therefore fails closed; use sc_receive_at() during enrollment. Link framing such as COBS is the
 * caller's responsibility. See sc_receive(). The handle owns its context and durable provider.
 * @param h Host handle; non-null except for sc_host_close().
 * @param frame Non-null frame buffer; borrowed for this call.
 * @param n Input frame byte count.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
int sc_host_receive(sc_host *h, const uint8_t *frame, size_t n);
/**
 * @brief Generate one pending frame within a byte budget.
 * @ingroup host
 * @details Does not deliver the frame. Returns SC_NO_OUTPUT when idle; output length is initially
 * zero. Budget/capacity failures do not consume pending output. Successful encrypted output durably
 * reserves nonces before use. Transport loss may require retransmission; never restore runtime
 * nonce cursors. See sc_outbound(). The handle owns its context and durable provider.
 * @param h Host handle; non-null except for sc_host_close().
 * @param budget Maximum permitted output frame size, in bytes.
 * @param frame Non-null frame buffer; borrowed for this call.
 * @param capacity Writable buffer capacity, in bytes.
 * @param n Non-null destination for the output byte count; zero when no frame is returned.
 * @return SC_OK with a frame, SC_NO_OUTPUT when idle, or a sc_status error.
 */
int sc_host_outbound(sc_host *h, size_t budget, uint8_t *frame, size_t capacity, size_t *n);
/**
 * @brief Write a NUL-terminated JSON public-state diagnostic.
 * @ingroup host
 * @details Counters are decimal strings. No private keys are exposed. Insufficient capacity returns
 * SC_ERR_BOUNDS without truncation; JSON is not a protocol encoding.
 * @param h Host handle; non-null except for sc_host_close().
 * @param json Non-null JSON output buffer.
 * @param capacity Writable buffer capacity, in bytes.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
int sc_host_inspect(sc_host *h, char *json, size_t capacity);
/**
 * @brief Return a static host status token.
 * @ingroup host
 * @details Unknown values map to internal; tokens differ from sc_status_string() descriptions.
 * @param status Status code to describe.
 * @return Borrowed static status string; never free it.
 */
const char *sc_host_status(int status);
/**
 * @brief Inject deterministic provider failures for test fixtures.
 * @ingroup fixtures
 * @details Only storage, random and crypto operations are supported. Zero clears that injection
 * counter. Not an application recovery mechanism.
 * @param h Host handle; non-null except for sc_host_close().
 * @param operation Non-null injection name: storage, random or crypto.
 * @param count Number of subsequent matching operations to fail.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
int sc_host_fail(sc_host *h, const char *operation, unsigned count);
/**
 * @brief Derive an Ed25519 public key from a fixture seed.
 * @ingroup fixtures
 * @details For test fixtures only. Real deployments need independently generated provisioning
 * secrets.
 * @param seed Optional 32-byte provisioning seed; NULL generates a fresh identity for a new store.
 * @param public_key Non-null 32-byte public-key destination.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
int sc_host_fixture_public(const uint8_t seed[32], uint8_t public_key[32]);
/**
 * @brief Seed a fixture revision near a uint64 boundary.
 * @ingroup fixtures
 * @details Requires an SC_ENABLE_TESTING build; production builds return SC_ERR_ARGUMENT.
 * @param h Host handle; non-null except for sc_host_close().
 * @param revision Fixture revision to persist.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
int sc_host_fixture_revision(sc_host *h, uint64_t revision);
#ifdef __cplusplus
}
#endif
#endif
