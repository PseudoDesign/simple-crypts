#ifndef SIMPLE_CRYPTS_SC_H
#define SIMPLE_CRYPTS_SC_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SC_VERSION 3u
#define SC_PROFILE_NACL_BOX 2u /* Ed25519 identities converted for NaCl box */
#define SC_KEY_BYTES 32u
#define SC_TOKEN_BYTES 32u
#define SC_NONCE_BYTES 24u
#define SC_TAG_BYTES 16u
#define SC_MAX_SERIAL 32u
#define SC_MAX_FRAME 512u
#define SC_MAX_RECORD (512u + SC_DATA_MAX_GROUPS * (2u * SC_DATA_MAX_PAYLOAD + 128u))
#define SC_NONCE_RESERVATION 32u

typedef enum {
    SC_OK = 0,
    SC_NO_OUTPUT = 1,
    SC_NOT_FOUND = 2,
    SC_ERR_ARGUMENT = -1,
    SC_ERR_BOUNDS = -2,
    SC_ERR_AUTH = -3,
    SC_ERR_PROTOCOL = -4,
    SC_ERR_STORAGE = -5,
    SC_ERR_RANDOM = -6,
    SC_ERR_CONFLICT = -7,
    SC_ERR_EXHAUSTED = -8,
    SC_ERR_ROLE = -9,
    SC_ERR_ENROLLMENT = -10,
    SC_ERR_UTF8 = -11,
    SC_ERR_CRYPTO = -12
} sc_status;

typedef enum { SC_DEVICE = 1, SC_SERVER = 2 } sc_role;
typedef uint32_t sc_key_handle;
#include "core/data.h"

/* All callbacks are synchronous. Failed callbacks must not publish partial
 * results. `commit` is atomic compare-and-replace; generation 0 means absent.
 * `reserve` durably burns [first, first+count) before returning SC_OK. It must
 * never return an overlapping range, including after process/power failure.
 * The nonce domain is already scoped to this identity and direction. A store
 * shared by multiple contexts must additionally namespace by key identity.
 * No callback exports a private identity key. Secret retrieval is confined to
 * the protocol provider, never to a relay or the high-level application API. */
typedef struct {
    void *user;
    sc_status (*public_key)(void *, sc_key_handle, uint8_t out[SC_KEY_BYTES]);
    sc_status (*seal)(void *, sc_key_handle, const uint8_t peer[SC_KEY_BYTES],
                      const uint8_t nonce[SC_NONCE_BYTES], const uint8_t *plain, size_t plain_len,
                      uint8_t *cipher, size_t capacity);
    sc_status (*open)(void *, sc_key_handle, const uint8_t peer[SC_KEY_BYTES],
                      const uint8_t nonce[SC_NONCE_BYTES], const uint8_t *cipher, size_t cipher_len,
                      uint8_t *plain, size_t capacity);
    sc_status (*random)(void *, uint8_t *out, size_t length);
    sc_status (*enrollment_secret)(void *, uint8_t out[SC_TOKEN_BYTES]);
    sc_status (*load)(void *, uint8_t *out, size_t capacity, size_t *length, uint64_t *generation);
    sc_status (*commit)(void *, uint64_t expected_generation, const uint8_t *record, size_t length);
    sc_status (*reserve)(void *, uint32_t domain, uint64_t count, uint64_t *first);
    sc_status (*sign)(void *, sc_key_handle, const uint8_t *, size_t, uint8_t signature[64]);
    sc_status (*verify)(void *, const uint8_t key[32], const uint8_t *, size_t,
                        const uint8_t signature[64]);
} sc_provider;

typedef struct {
    const sc_data_schema *data_schema; /* NULL selects the generated credits schema. */
    sc_role role;
    sc_key_handle identity_key;
    char serial[SC_MAX_SERIAL + 1u];
    /* Device: pinned server key. Server: zero for first authorized enrollment,
     * or a required device key. A nonzero server pin must match enrollment. */
    uint8_t peer_public_key[SC_KEY_BYTES];
} sc_config;

typedef struct {
    sc_role role;
    char serial[SC_MAX_SERIAL + 1u];
    sc_data_state data;
    uint64_t reported_revision;
    uint64_t acked_reported_revision;
    uint64_t last_sent_reported_revision;
    uint64_t storage_generation;
    uint8_t peer_public_key[SC_KEY_BYTES];
    uint8_t enrollment_mode; /* 0=legacy token authorization, 1=signed challenge + approval */
    uint8_t challenge[32], candidate_key[32];
    uint64_t enrollment_expires, candidate_revision;

    uint8_t registered;

    uint8_t pending;
} sc_state;

/* Caller-owned, no malloc. Treat members as private; use sc_inspect(). The
 * nonce reservation cursor is intentionally not restored from snapshot state:
 * a reboot reserves a fresh range, burning unused values from the old range. */
typedef struct {
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
} sc_context;

/* init loads an existing record or atomically creates one on SC_NOT_FOUND.
 * Resource values start at zero/empty. Signed enrollment waits for a verified
 * server challenge; application updates require confirmed enrollment.
 * Contexts are single-owner; callers supply external synchronization. */
sc_status sc_init(sc_context *ctx, const sc_config *config, const sc_provider *provider);
sc_status sc_data_inspect(const sc_context *, uint16_t group_id, sc_group_state *out);
sc_status sc_data_update_group(sc_context *, uint16_t group_id, const sc_data_update *,
                               size_t count);
sc_status sc_data_update_encoded(sc_context *, uint16_t, const uint8_t *, size_t);
sc_status sc_data_encode_values(const sc_context *, uint16_t, uint8_t *, size_t, size_t *);
sc_status sc_data_request(sc_context *, uint16_t group_id);
sc_status sc_set_credits_issued(sc_context *, uint64_t total);
sc_status sc_consume_credits(sc_context *, uint64_t amount);
sc_status sc_request_credit_status(sc_context *);
sc_status sc_receive(sc_context *ctx, const uint8_t *frame, size_t length);
/* One complete opaque object, excluding UART/COBS framing. No output if no
 * work is pending. Budget/capacity failure does not consume an output. */
sc_status sc_outbound(sc_context *ctx, size_t byte_budget, uint8_t *frame, size_t capacity,
                      size_t *length);
/* Opt into signed server-initiated enrollment before sending any report.
 * Persisted mode cannot be disabled. now/expires use the SERVER's trusted time.
 * Approval is an externally authorized operation over the exact session + key.
 * Never expose begin/approve/cancel to the untrusted relay. */
sc_status sc_enrollment_enable(sc_context *ctx);
sc_status sc_enrollment_begin(sc_context *ctx, uint64_t now, uint64_t expires);
sc_status sc_enrollment_approve(sc_context *ctx, const uint8_t challenge[32], const uint8_t key[32],
                                uint64_t now);
sc_status sc_enrollment_cancel(sc_context *ctx);
sc_status sc_receive_at(sc_context *ctx, const uint8_t *frame, size_t length, uint64_t now);
sc_status sc_inspect(const sc_context *ctx, sc_state *out);
const char *sc_status_string(sc_status status);

#ifdef __cplusplus
}
#endif
#endif
