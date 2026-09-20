/* Persistent example platform for the public C API.
 *
 * The protocol stays in core/sc.c. This file supplies software keys, entropy,
 * and atomic storage. Asyncify lets synchronous provider callbacks wait for
 * IndexedDB transaction completion, including nonce reservations BEFORE seal.
 * Private storage bytes stay in the owning worker, never in UI messages.
 */
#include "examples/common/endpoint.h"
#include "core/sc.h"
#include "providers/sodium/sc_sodium.h"
#include <emscripten/emscripten.h>
#include <inttypes.h>
#include <sodium.h>
#include <stdio.h>
#include <string.h>

#define API EMSCRIPTEN_KEEPALIVE
#define HEADER_SIZE 213u
static sc_context context;
static sc_config config;
static sc_sodium_keystore keystore;
static struct {
    uint8_t public_key[32], secret_key[64], record[SC_MAX_RECORD];
    size_t length;
    uint64_t generation, next[3];
} saved;
static uint8_t input[4096], frame[SC_MAX_FRAME];
static uint8_t checkpoint[HEADER_SIZE + SC_MAX_RECORD];
static size_t frame_length;
static char state_json[4096];
static int ready, failed;

EM_ASYNC_JS(int, disk_write, (const uint8_t *bytes, size_t length), {
    try {
        await Module.storage.save(HEAPU8.slice(bytes, bytes + length));
        return 0;
    } catch (error) {
        return -5;
    }
});

EM_ASYNC_JS(int, disk_read, (uint8_t *bytes, size_t capacity), {
    try {
        const blob = await Module.storage.load();
        if (!(blob instanceof Uint8Array) || blob.length > capacity) return -5;
        HEAPU8.set(blob, bytes);
        return blob.length;
    } catch (error) {
        return -5;
    }
});

static void put64(uint8_t *p, uint64_t value) {
    for (unsigned i = 0; i < 8; ++i) p[7 - i] = (uint8_t)(value >> (8 * i));
}

static uint64_t get64(const uint8_t *p) {
    uint64_t value = 0;
    for (unsigned i = 0; i < 8; ++i) value = (value << 8) | p[i];
    return value;
}

/* Explicit versioned encoding, never a dump of C structs or Wasm memory.
 * Config and identity precede the protocol record and reservation high-water
 * marks. Runtime nonce cursors are deliberately absent: reboot burns leftovers.
 */
static int persist(const uint8_t *record, size_t length, uint64_t generation,
                   uint64_t device_next, uint64_t server_next) {
    memset(checkpoint, 0, HEADER_SIZE);
    memcpy(checkpoint, "SCEX0001", 8);
    checkpoint[8] = (uint8_t)config.role;
    memcpy(checkpoint + 9, config.serial, 33);
    memcpy(checkpoint + 42, config.peer_public_key, 32);
    memcpy(checkpoint + 74, saved.public_key, 32);
    memcpy(checkpoint + 106, saved.secret_key, 64);
    put64(checkpoint + 170, length);
    put64(checkpoint + 178, generation);
    put64(checkpoint + 186, device_next);
    put64(checkpoint + 194, server_next);
    /* Bytes 202..212 are reserved and must remain zero in version 1. */
    memcpy(checkpoint + HEADER_SIZE, record, length);
    int result = disk_write(checkpoint, HEADER_SIZE + length);
    sodium_memzero(checkpoint, sizeof checkpoint);
    if (result != SC_OK) failed = 1; /* Require reopening after ambiguous I/O. */
    return result;
}

static int restore(void) {
    int length = disk_read(checkpoint, sizeof checkpoint);
    int result = SC_ERR_STORAGE;
    if (length < (int)HEADER_SIZE || memcmp(checkpoint, "SCEX0001", 8) ||
        checkpoint[8] != config.role ||
        memcmp(checkpoint + 9, config.serial, 33) ||
        memcmp(checkpoint + 42, config.peer_public_key, 32) ||
        !sodium_is_zero(checkpoint + 202, 11)) goto done;
    uint64_t record_length = get64(checkpoint + 170);
    if (record_length > SC_MAX_RECORD ||
        record_length + HEADER_SIZE != (uint64_t)length ||
        get64(checkpoint + 178) == 0) goto done;
    /* Check the seed-derived keypair, including the public half in the secret. */
    uint8_t pk[32], sk[64];
    crypto_sign_seed_keypair(pk, sk, checkpoint + 106);
    int mismatch = sodium_memcmp(pk, checkpoint + 74, 32) |
                   sodium_memcmp(sk, checkpoint + 106, 64);
    sodium_memzero(sk, sizeof sk);
    if (mismatch) goto done;
    memcpy(saved.public_key, checkpoint + 74, 32);
    memcpy(saved.secret_key, checkpoint + 106, 64);
    saved.length = (size_t)record_length;
    saved.generation = get64(checkpoint + 178);
    saved.next[1] = get64(checkpoint + 186);
    saved.next[2] = get64(checkpoint + 194);
    memcpy(saved.record, checkpoint + HEADER_SIZE, saved.length);
    result = SC_OK;
done:
    sodium_memzero(checkpoint, sizeof checkpoint);
    return result;
}

static sc_status lookup(void *user, sc_key_handle key,
                        const uint8_t **pk, const uint8_t **sk) {
    (void)user;
    if (key != 1 || !ready || failed) return SC_ERR_STORAGE;
    *pk = saved.public_key;
    *sk = saved.secret_key;
    return SC_OK;
}

static sc_status entropy(void *user, uint8_t *out, size_t length) {
    (void)user;
    randombytes_buf(out, length);
    return SC_OK;
}

static sc_status unused_secret(void *user, uint8_t out[32]) {
    (void)user;
    memset(out, 0, 32); /* Compatibility callback; signed enrollment ignores it. */
    return SC_OK;
}

static sc_status load(void *user, uint8_t *out, size_t capacity,
                      size_t *length, uint64_t *generation) {
    (void)user;
    if (failed) return SC_ERR_STORAGE;
    if (!saved.generation) return SC_NOT_FOUND;
    if (capacity < saved.length) return SC_ERR_BOUNDS;
    memcpy(out, saved.record, saved.length);
    *length = saved.length;
    *generation = saved.generation;
    return SC_OK;
}

static sc_status commit(void *user, uint64_t generation,
                        const uint8_t *record, size_t length) {
    (void)user;
    if (failed || generation != saved.generation || generation == UINT64_MAX ||
        length > sizeof saved.record) return SC_ERR_STORAGE;
    int result = persist(record, length, generation + 1, saved.next[1], saved.next[2]);
    if (result != SC_OK) return (sc_status)result;
    memcpy(saved.record, record, length);
    saved.length = length;
    saved.generation = generation + 1;
    return SC_OK;
}

static sc_status reserve(void *user, uint32_t domain, uint64_t count, uint64_t *first) {
    (void)user;
    if (failed) return SC_ERR_STORAGE;
    if (domain < 1 || domain > 2 || count > UINT64_MAX - saved.next[domain])
        return SC_ERR_EXHAUSTED;
    uint64_t next[3] = {0, saved.next[1], saved.next[2]};
    next[domain] += count;
    int result = persist(saved.record, saved.length, saved.generation, next[1], next[2]);
    if (result != SC_OK) return (sc_status)result;
    *first = saved.next[domain];
    saved.next[domain] = next[domain];
    return SC_OK;
}

API int ex_reboot(void) {
    if (!ready || failed) return SC_ERR_STORAGE;
    sc_provider provider = {0};
    provider.user = &keystore;
    provider.public_key = sc_sodium_public;
    provider.sign = sc_sodium_sign;
    provider.verify = sc_sodium_verify;
    provider.seal = sc_sodium_ed_seal;
    provider.open = sc_sodium_ed_open;
    provider.random = entropy;
    provider.enrollment_secret = unused_secret;
    provider.load = load;
    provider.commit = commit;
    provider.reserve = reserve;
    sodium_memzero(&context, sizeof context);
    frame_length = 0;
    int result = sc_init(&context, &config, &provider);
    return result == SC_OK ? sc_enrollment_enable(&context) : result;
}

API int ex_init(int role, int fresh) {
    if (ready || (role != SC_DEVICE && role != SC_SERVER) ||
        !memchr(input + 32, 0, 33) || !input[32]) return SC_ERR_ARGUMENT;
    if (sodium_init() < 0) return SC_ERR_RANDOM;
    config.role = (sc_role)role;
    config.identity_key = 1;
    memcpy(config.peer_public_key, input, 32);
    memcpy(config.serial, input + 32, 33);
    for (size_t i = 0; config.serial[i]; ++i)
        if ((unsigned char)config.serial[i] < 33 || (unsigned char)config.serial[i] > 126)
            return SC_ERR_ARGUMENT;
    sodium_memzero(input, sizeof input);
    int result = fresh ? crypto_sign_keypair(saved.public_key, saved.secret_key) : restore();
    if (result != 0) return result < 0 ? result : SC_ERR_CRYPTO;
    keystore.lookup = lookup;
    ready = 1;
    return ex_reboot();
}

API uint8_t *ex_input(void) { return input; }
API const char *ex_status(int status) { return sc_status_string((sc_status)status); }
API int ex_begin(void) { return failed ? SC_ERR_STORAGE : sc_enrollment_begin(&context, get64(input + 2048), get64(input + 2056)); }
API int ex_approve(void) { return failed ? SC_ERR_STORAGE : sc_enrollment_approve(&context, input, input + 32, get64(input + 2048)); }
API int ex_cancel(void) { return failed ? SC_ERR_STORAGE : sc_enrollment_cancel(&context); }
API int ex_issue(void) { return failed ? SC_ERR_STORAGE : sc_set_credits_issued(&context, get64(input + 2048)); }
int ex_consume(uint64_t value) { return failed ? SC_ERR_STORAGE : sc_consume_credits(&context, value); }
API int ex_request(void) { return failed ? SC_ERR_STORAGE : sc_request_credit_status(&context); }
API int ex_receive(size_t length) {
    if (failed) return SC_ERR_STORAGE;
    if (length > SC_MAX_FRAME) return SC_ERR_BOUNDS;
    return sc_receive_at(&context, input, length, get64(input + 2048));
}
API int ex_outbound(void) {
    frame_length = 0;
    return failed ? SC_ERR_STORAGE : sc_outbound(&context, 512, frame, sizeof frame, &frame_length);
}
API const uint8_t *ex_frame(void) { return frame; }
API size_t ex_frame_length(void) { return frame_length; }

API const char *ex_state(void) {
    sc_state state;
    if (sc_inspect(&context, &state) != SC_OK) return "null";
    char serial[2 * SC_MAX_SERIAL + 1], *out = serial;
    for (const char *p = state.serial; *p; ++p) {
        if (*p == '"' || *p == '\\') *out++ = '\\';
        *out++ = *p;
    }
    *out = 0;
    char pk[65], peer[65], challenge[65], candidate[65];
    sodium_bin2hex(pk, sizeof pk, saved.public_key, 32);
    sodium_bin2hex(peer, sizeof peer, state.peer_public_key, 32);
    sodium_bin2hex(challenge, sizeof challenge, state.challenge, 32);
    sodium_bin2hex(candidate, sizeof candidate, state.candidate_key, 32);
    const sc_group_state *group = &state.data.groups[0];
    snprintf(state_json, sizeof state_json,
             "{\"serial\":\"%s\",\"public_key\":\"%s\",\"peer_public_key\":\"%s\","
             "\"registered\":%s,\"pending\":%s,\"credits_issued\":\"%" PRIu64 "\","
             "\"credits_consumed\":\"%" PRIu64 "\",\"challenge\":\"%s\","
             "\"candidate_key\":\"%s\",\"enrollment_expires\":\"%" PRIu64 "\","
             "\"storage_generation\":\"%" PRIu64 "\",\"storage_failed\":%s}",
             serial, pk, peer, state.registered ? "true" : "false",
             state.pending ? "true" : "false", group->values[0].u64,
             group->values[1].u64, challenge, candidate, state.enrollment_expires,
             state.storage_generation, failed ? "true" : "false");
    return state_json;
}
