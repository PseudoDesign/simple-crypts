/** @file
 * @brief Bounded C99 protocol API.
 */
#ifndef SIMPLE_CRYPTS_SC_H
#define SIMPLE_CRYPTS_SC_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Wire and persistence format version. */
#define SC_VERSION 3u
/** Ed25519 identities converted to X25519 for NaCl box. */
#define SC_PROFILE_NACL_BOX 2u /* Ed25519 identities converted for NaCl box */
/** Public key length in bytes. */
#define SC_KEY_BYTES 32u
/** Enrollment secret length in bytes. */
#define SC_TOKEN_BYTES 32u
/** NaCl box nonce length in bytes. */
#define SC_NONCE_BYTES 24u
/** NaCl box authentication tag length in bytes. */
#define SC_TAG_BYTES 16u
/** Maximum serial length, excluding the NUL terminator. */
#define SC_MAX_SERIAL 32u
/** Maximum complete protocol frame length in bytes. */
#define SC_MAX_FRAME 512u
/** Maximum encoded durable protocol record length in bytes. */
#define SC_MAX_RECORD (512u + SC_DATA_MAX_GROUPS * (2u * SC_DATA_MAX_PAYLOAD + 128u))
/** Number of nonce counters durably reserved at once. */
#define SC_NONCE_RESERVATION 32u

/** @ingroup initialization
 * @brief Protocol result codes. Nonnegative values are successful or informational; negative
 * values are errors. */
typedef enum {
    SC_OK = 0,            /**< Operation succeeded. */
    SC_NO_OUTPUT = 1,     /**< No pending outbound frame. */
    SC_NOT_FOUND = 2,     /**< Record or requested resource does not exist. */
    SC_ERR_ARGUMENT = -1, /**< Invalid argument or uninitialized context. */
    SC_ERR_BOUNDS = -2,   /**< Buffer, frame or value exceeds bounds. */
    SC_ERR_AUTH = -3,     /**< Authentication or signature verification failed. */
    SC_ERR_PROTOCOL = -4, /**< Malformed or incompatible protocol data. */
    SC_ERR_STORAGE = -5,  /**< Durable storage failed. */
    SC_ERR_RANDOM = -6,   /**< Required entropy unavailable. */
    SC_ERR_CONFLICT =
        -7, /**< Conflicting state, stale binding, decreasing counter or insufficient credits. */
    SC_ERR_EXHAUSTED = -8,   /**< Counter or nonce space would overflow. */
    SC_ERR_ROLE = -9,        /**< Operation not allowed for this role. */
    SC_ERR_ENROLLMENT = -10, /**< Enrollment state does not permit the operation. */
    SC_ERR_UTF8 = -11,       /**< Invalid UTF-8 text. */
    SC_ERR_CRYPTO = -12      /**< Cryptographic operation failed. */
} sc_status;

/** @ingroup initialization
 * @brief Endpoint role; each context has exactly one peer. */
typedef enum {
    SC_DEVICE = 1, /**< Device endpoint; owns consumption. */
    SC_SERVER = 2  /**< Server endpoint; owns issuance. */
} sc_role;
/** @ingroup initialization
 * @brief Opaque provider-local key identifier; contains no key material. */
typedef uint32_t sc_key_handle;
#include "core/data.h"

/** @ingroup providers
 * @brief Synchronous crypto and durable-storage callbacks. See @ref provider_contract. */
typedef struct {
    /** Borrowed provider-specific state; must outlive the context. */
    void *user;
    /** @ingroup initialization
     * @brief Copy the identity public key.
     * @param user Borrowed callback state from sc_provider.user.
     * @param key Provider-local identity handle.
     * @param out Non-null 32-byte destination.
     * @return SC_OK on success or a negative sc_status; load may return SC_NOT_FOUND.
     */
    sc_status (*public_key)(void *user, sc_key_handle key, uint8_t out[SC_KEY_BYTES]);
    /** @ingroup initialization
     * @brief Encrypt and authenticate a complete plaintext; output is plaintext length plus
     * SC_TAG_BYTES.
     * @param user Borrowed callback state from sc_provider.user.
     * @param key Local key handle.
     * @param peer Non-null peer public key.
     * @param nonce Non-null unique 24-byte nonce.
     * @param plain Non-null plaintext bytes.
     * @param plain_len Plaintext byte count.
     * @param cipher Non-null output buffer.
     * @param capacity Output capacity in bytes.
     * @return SC_OK on success or a negative sc_status; load may return SC_NOT_FOUND.
     */
    sc_status (*seal)(void *user, sc_key_handle key, const uint8_t peer[SC_KEY_BYTES],
                      const uint8_t nonce[SC_NONCE_BYTES], const uint8_t *plain, size_t plain_len,
                      uint8_t *cipher, size_t capacity);
    /** @ingroup initialization
     * @brief Authenticate and decrypt; never expose unauthenticated plaintext to the protocol.
     * @param user Borrowed callback state from sc_provider.user.
     * @param key Local key handle.
     * @param peer Non-null peer public key.
     * @param nonce Non-null received 24-byte nonce.
     * @param cipher Non-null ciphertext including tag.
     * @param cipher_len Ciphertext byte count, including SC_TAG_BYTES.
     * @param plain Non-null output buffer.
     * @param capacity Output capacity in bytes.
     * @return SC_OK on success or a negative sc_status; load may return SC_NOT_FOUND.
     */
    sc_status (*open)(void *user, sc_key_handle key, const uint8_t peer[SC_KEY_BYTES],
                      const uint8_t nonce[SC_NONCE_BYTES], const uint8_t *cipher, size_t cipher_len,
                      uint8_t *plain, size_t capacity);
    /** @ingroup initialization
     * @brief Fill a buffer with cryptographically secure randomness; never substitute
     * deterministic bytes. Required to start signed server enrollment.
     * @param user Borrowed callback state from sc_provider.user.
     * @param out Non-null output buffer.
     * @param length Number of bytes to fill.
     * @return SC_OK on success or a negative sc_status; load may return SC_NOT_FOUND.
     */
    sc_status (*random)(void *user, uint8_t *out, size_t length);
    /** @ingroup initialization
     * @brief Retrieve the legacy enrollment secret inside the trusted provider boundary. Required
     * by sc_init even in signed mode.
     * @param user Borrowed callback state from sc_provider.user.
     * @param out Non-null 32-byte secret destination.
     * @return SC_OK on success or a negative sc_status; load may return SC_NOT_FOUND.
     */
    sc_status (*enrollment_secret)(void *user, uint8_t out[SC_TOKEN_BYTES]);
    /** @ingroup initialization
     * @brief Load the encoded durable protocol record; report SC_NOT_FOUND only when no record
     * exists. Corruption must fail rather than recreate identity or counters.
     * @param user Borrowed callback state from sc_provider.user.
     * @param out Non-null record destination.
     * @param capacity Destination capacity in bytes.
     * @param length Non-null destination for loaded byte count.
     * @param generation Non-null destination for the durable generation; zero means absent.
     * @return SC_OK on success or a negative sc_status; load may return SC_NOT_FOUND.
     */
    sc_status (*load)(void *user, uint8_t *out, size_t capacity, size_t *length,
                      uint64_t *generation);
    /** @ingroup initialization
     * @brief Atomically compare generation and replace the record. Report success only after
     * durable completion; advance generation by one. Reject stale generations.
     * @param user Borrowed callback state from sc_provider.user.
     * @param expected_generation Required current generation; zero creates an absent record.
     * @param record Non-null encoded record, borrowed only for this callback.
     * @param length Record length in bytes.
     * @return SC_OK on success or a negative sc_status; load may return SC_NOT_FOUND.
     */
    sc_status (*commit)(void *user, uint64_t expected_generation, const uint8_t *record,
                        size_t length);
    /** @ingroup initialization
     * @brief Durably burn [first, first + count) before returning success. Never reuse a range
     * after crashes or failed writes. Namespace domains by identity in shared stores.
     * @param user Borrowed callback state from sc_provider.user.
     * @param domain Identity/direction nonce domain selected by the core.
     * @param count Number of contiguous counters to reserve; reject overflow.
     * @param first Non-null destination for the first reserved counter.
     * @return SC_OK on success or a negative sc_status; load may return SC_NOT_FOUND.
     */
    sc_status (*reserve)(void *user, uint32_t domain, uint64_t count, uint64_t *first);
    /** @ingroup initialization
     * @brief Create a detached Ed25519 signature. Required for signed server invitations.
     * @param user Borrowed callback state from sc_provider.user.
     * @param key Local Ed25519 identity handle.
     * @param message Non-null bytes to sign.
     * @param length Message length in bytes.
     * @param signature Non-null 64-byte destination.
     * @return SC_OK on success or a negative sc_status; load may return SC_NOT_FOUND.
     */
    sc_status (*sign)(void *user, sc_key_handle key, const uint8_t *message, size_t length,
                      uint8_t signature[64]);
    /** @ingroup initialization
     * @brief Verify a detached Ed25519 signature. Required to accept signed invitations.
     * @param user Borrowed callback state from sc_provider.user.
     * @param key Non-null 32-byte Ed25519 public key.
     * @param message Non-null signed bytes.
     * @param length Message length in bytes.
     * @param signature Non-null 64-byte signature.
     * @return SC_OK on success or a negative sc_status; load may return SC_NOT_FOUND.
     */
    sc_status (*verify)(void *user, const uint8_t key[32], const uint8_t *message, size_t length,
                        const uint8_t signature[64]);
} sc_provider;

/** @ingroup initialization
 * @brief Initialization configuration, copied by sc_init(). Referenced schema storage remains
 * borrowed. */
typedef struct {
    /** Borrowed immutable schema; NULL selects the generated credits schema. */
    const sc_data_schema *data_schema;
    /** SC_DEVICE or SC_SERVER. */
    sc_role role;
    /** Provider-local identity key handle. */
    sc_key_handle identity_key;
    /** NUL-terminated printable ASCII serial; 1 through SC_MAX_SERIAL bytes. */
    char serial[SC_MAX_SERIAL + 1u];
    /* Device: pinned server key. Server: zero for first authorized enrollment,
     * or a required device key. A nonzero server pin must match enrollment. */
    /** Pinned 32-byte peer Ed25519 public key. Devices require a pin; zero permits initial server
     * enrollment. */
    uint8_t peer_public_key[SC_KEY_BYTES];
} sc_config;

/** @ingroup initialization
 * @brief Public endpoint snapshot. Inspect through sc_inspect(); do not use as a raw persistent
 * image. */
typedef struct {
    /** SC_DEVICE or SC_SERVER. */
    sc_role role;
    /** NUL-terminated printable ASCII serial; 1 through SC_MAX_SERIAL bytes. */
    char serial[SC_MAX_SERIAL + 1u];
    /** Typed resource state; server device-owned values are last reported. */
    sc_data_state data;
    /** Persisted legacy report revision. */
    uint64_t reported_revision;
    /** Legacy acknowledged report revision. */
    uint64_t acked_reported_revision;
    /** Legacy last-sent report revision. */
    uint64_t last_sent_reported_revision;
    /** Durable record generation used for compare-and-replace. */
    uint64_t storage_generation;
    /** Pinned 32-byte peer Ed25519 public key. Devices require a pin; zero permits initial server
     * enrollment. */
    uint8_t peer_public_key[SC_KEY_BYTES];
    /** Zero for legacy token enrollment; one for signed challenge and approval. */
    uint8_t enrollment_mode;
    /** Active 32-byte random session challenge; zero when absent. */
    uint8_t challenge[32];
    /** Received 32-byte candidate Ed25519 public key; requires explicit approval. */
    uint8_t candidate_key[32];
    /** Exclusive server session expiry in application-defined trusted time units. */
    uint64_t enrollment_expires;
    /** Received candidate revision bound to the enrollment session. */
    uint64_t candidate_revision;

    /** Nonzero once enrollment is confirmed locally. */
    uint8_t registered;

    /** Nonzero when protocol work is pending. */
    uint8_t pending;
} sc_state;

/** @ingroup initialization
 * @brief Caller-owned protocol context with no heap allocation. Members are private; use
 * sc_inspect(). Reinitialize through sc_init() on reboot to burn unused nonce reservations. */
typedef struct {
    /// @cond INTERNAL
    sc_provider provider;
    sc_config config;
    sc_state state;
    uint8_t local_public_key[SC_KEY_BYTES];
    uint64_t nonce_next;
    uint64_t nonce_limit;
    uint8_t initialized;
    uint8_t receipt_pending;
    uint8_t data_cursor;
    uint8_t work[SC_MAX_RECORD];
    /// @endcond
} sc_context;

/**
 * @brief Initialize caller-owned storage or restore an existing record.
 * @ingroup initialization
 * @details Loads through the provider; only SC_NOT_FOUND creates a zero-valued record.
 * Configuration and callback tables are copied, but referenced schemas and provider resources must
 * outlive the context. Never restore raw context memory. A failed initialization leaves the context
 * unusable.
 * @param ctx Non-null context; initialized except when passed to sc_init().
 * @param config Non-null role, serial, identity and schema configuration.
 * @param provider Non-null synchronous provider callbacks and their user data.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_init(sc_context *ctx, const sc_config *config, const sc_provider *provider);
/**
 * @brief Copy the current state of a resource group.
 * @ingroup resources
 * @details Does not perform I/O or mutate state. On a server, device-owned values are the last
 * reported values.
 * @param c Non-null initialized context.
 * @param id Resource group ID from the configured schema.
 * @param out Non-null destination for the copied group state.
 * @return SC_OK on success; otherwise a sc_status error or SC_NOT_FOUND for an unknown group.
 */
sc_status sc_data_inspect(const sc_context *c, uint16_t id, sc_group_state *out);
/**
 * @brief Atomically update fields owned by this endpoint.
 * @ingroup resources
 * @details Requires confirmed enrollment. Duplicate or unknown fields, wrong ownership, invalid
 * values and decreasing monotonic counters are rejected. Changed values are committed before
 * success; server updates queue a request. Device updates await a request to be reported.
 * @param c Non-null initialized context.
 * @param id Resource group ID from the configured schema.
 * @param updates Non-null array of count field updates; borrowed for this call.
 * @param count Number of array elements.
 * @return SC_OK on success; otherwise a sc_status error or SC_NOT_FOUND for an unknown group.
 */
sc_status sc_data_update_group(sc_context *c, uint16_t id, const sc_data_update *updates,
                               size_t count);
/**
 * @brief Apply typed field records as one atomic update.
 * @ingroup resources
 * @details Each record contains a big-endian uint16 field ID, one-byte type, one-byte length, and
 * value bytes. Numeric values use eight big-endian bytes; Boolean values use one byte; text is
 * UTF-8 without a NUL terminator. Uses the same validation and persistence as
 * sc_data_update_group().
 * @param c Non-null initialized context.
 * @param id Resource group ID from the configured schema.
 * @param bytes Non-null typed-record input buffer; borrowed for this call.
 * @param n Input byte count, greater than zero.
 * @return SC_OK on success; otherwise a sc_status error or SC_NOT_FOUND for an unknown group.
 */
sc_status sc_data_update_encoded(sc_context *c, uint16_t id, const uint8_t *bytes, size_t n);
/**
 * @brief Encode all current values of a group.
 * @ingroup resources
 * @details Uses schema field order and the typed record format accepted by
 * sc_data_update_encoded(). Sets output length to zero before validation; insufficient capacity
 * leaves the output buffer unchanged.
 * @param c Non-null initialized context.
 * @param id Resource group ID from the configured schema.
 * @param out Non-null destination for encoded value bytes.
 * @param cap Writable buffer capacity, in bytes.
 * @param length Non-null destination for the encoded byte count; zero on failure.
 * @return SC_OK on success; otherwise a sc_status error or SC_NOT_FOUND for an unknown group.
 */
sc_status sc_data_encode_values(const sc_context *c, uint16_t id, uint8_t *out, size_t cap,
                                size_t *length);
/**
 * @brief Queue a new resource-group request on an enrolled server.
 * @ingroup resources
 * @details Advances and persists the request ID. Does not transfer a frame. Exhausted counters fail
 * without wrapping.
 * @param c Non-null initialized context.
 * @param id Resource group ID from the configured schema.
 * @return SC_OK on success; otherwise a sc_status error or SC_NOT_FOUND for an unknown group.
 */
sc_status sc_data_request(sc_context *c, uint16_t id);
/**
 * @brief Set cumulative credits issued by an enrolled server.
 * @ingroup credits
 * @details The total must not decrease. This is a cumulative total, not an increment. Requires the
 * credits schema; commits through sc_data_update_group() and queues protocol work.
 * @param c Non-null initialized context.
 * @param total Cumulative issued total, in credits.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_set_credits_issued(sc_context *c, uint64_t total);
/**
 * @brief Consume a positive amount on an enrolled device.
 * @ingroup credits
 * @details Requires the credits schema. Returns SC_ERR_CONFLICT when the resulting consumption
 * exceeds issued credits, SC_ERR_EXHAUSTED on uint64 overflow, and SC_ERR_ARGUMENT for zero.
 * Commits locally; the server learns consumption through a later report.
 * @param c Non-null initialized context.
 * @param amount Positive number of credits to consume.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_consume_credits(sc_context *c, uint64_t amount);
/**
 * @brief Queue a credit report request on an enrolled server.
 * @ingroup credits
 * @details Requires the credits schema. Persists a new request ID through sc_data_request(); no
 * frame is transferred.
 * @param c Non-null initialized context.
 * @return Borrowed static status string; never free it.
 */
sc_status sc_request_credit_status(sc_context *c);
/**
 * @brief Process one complete incoming protocol frame without trusted time.
 * @ingroup transport
 * @details Equivalent to sc_receive_at() with UINT64_MAX. An unapproved signed server enrollment
 * therefore fails closed; use sc_receive_at() during enrollment. Link framing such as COBS is the
 * caller's responsibility.
 * @param ctx Non-null context; initialized except when passed to sc_init().
 * @param frame Non-null frame buffer; borrowed for this call.
 * @param length Complete input frame length, in bytes.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_receive(sc_context *ctx, const uint8_t *frame, size_t length);
/**
 * @brief Generate one pending frame within a byte budget.
 * @ingroup transport
 * @details Does not deliver the frame. Returns SC_NO_OUTPUT when idle; output length is initially
 * zero. Budget/capacity failures do not consume pending output. Successful encrypted output durably
 * reserves nonces before use. Transport loss may require retransmission; never restore runtime
 * nonce cursors.
 * @param ctx Non-null context; initialized except when passed to sc_init().
 * @param byte_budget Maximum permitted output frame size, in bytes.
 * @param frame Non-null frame buffer; borrowed for this call.
 * @param capacity Writable buffer capacity, in bytes.
 * @param length Non-null destination for the frame byte count; zero when no frame is returned.
 * @return SC_OK with a frame, SC_NO_OUTPUT when idle, or a sc_status error.
 */
sc_status sc_outbound(sc_context *ctx, size_t byte_budget, uint8_t *frame, size_t capacity,
                      size_t *length);
/**
 * @brief Permanently opt an unregistered context into signed enrollment.
 * @ingroup enrollment
 * @details Call before legacy enrollment. Persists the mode; it cannot be disabled. Signed
 * enrollment needs sign/verify callbacks and server randomness.
 * @param ctx Non-null context; initialized except when passed to sc_init().
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_enrollment_enable(sc_context *ctx);
/**
 * @brief Authorize or restart a signed enrollment session on a server.
 * @ingroup enrollment
 * @details Requires signed mode, an unregistered server and expires greater than now. Generates a
 * fresh random challenge and persists the session. Application policy chooses the time units and
 * lifetime; use the same trusted clock for all server enrollment operations.
 * @param ctx Non-null context; initialized except when passed to sc_init().
 * @param now Current trusted server time in application-defined units.
 * @param expires Exclusive expiry in the same units and clock as now.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_enrollment_begin(sc_context *ctx, uint64_t now, uint64_t expires);
/**
 * @brief Approve the exact received session and device key on a server.
 * @ingroup enrollment
 * @details Application authorization must verify the displayed serial, challenge and candidate key.
 * Rejects expired or stale bindings. Persists enrollment and queues confirmation. Never expose this
 * operation to an untrusted relay.
 * @param ctx Non-null context; initialized except when passed to sc_init().
 * @param challenge Exact 32-byte active session challenge.
 * @param key Exact 32-byte candidate Ed25519 public key.
 * @param now Current trusted server time in application-defined units.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_enrollment_approve(sc_context *ctx, const uint8_t challenge[32], const uint8_t key[32],
                                uint64_t now);
/**
 * @brief Cancel an unregistered server enrollment session.
 * @ingroup enrollment
 * @details Clears the challenge, candidate and expiry durably. Does not revoke an already enrolled
 * device.
 * @param ctx Non-null context; initialized except when passed to sc_init().
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_enrollment_cancel(sc_context *ctx);
/**
 * @brief Authenticate and process one complete incoming protocol frame.
 * @ingroup transport
 * @details The server uses trusted time to enforce signed enrollment expiry. Accepted state changes
 * are committed before success. Responses remain pending for sc_outbound(); this call never sends
 * them.
 * @param ctx Non-null context; initialized except when passed to sc_init().
 * @param frame Non-null frame buffer; borrowed for this call.
 * @param length Complete input frame length, in bytes.
 * @param now Current trusted server time in application-defined units.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_receive_at(sc_context *ctx, const uint8_t *frame, size_t length, uint64_t now);
/**
 * @brief Copy public endpoint state without exposing private keys.
 * @ingroup initialization
 * @details No storage or network operation occurs. The copy is diagnostic state, not a restorable
 * context image.
 * @param ctx Non-null context; initialized except when passed to sc_init().
 * @param out Non-null destination for the copied public state.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_inspect(const sc_context *ctx, sc_state *out);
/**
 * @brief Return a static human-readable core status description.
 * @ingroup initialization
 * @details The returned string is borrowed, immutable and has process lifetime. Unknown values
 * return an unknown-status description.
 * @param status Status code to describe.
 * @return Borrowed static status string; never free it.
 */
const char *sc_status_string(sc_status status);

#ifdef __cplusplus
}
#endif
#endif
