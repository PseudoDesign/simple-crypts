/* Reusable libFuzzer entry point. The fake authentication provider is ONLY a
 * parser/state-machine test gate: it intentionally admits arbitrary inner
 * plaintext, so fuzzing reaches nanopb and semantic validation. */
#include "core/sc.h"
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    uint8_t record[SC_MAX_RECORD], key[32], token[32];
    size_t length;
    uint64_t generation, counters[3];
    int fail_commit;
} fuzz_store;

static void require(int condition) { if (!condition) abort(); }
static sc_status f_public(void *u, sc_key_handle key, uint8_t out[32]) {
    (void)key; memcpy(out, ((fuzz_store *)u)->key, 32); return SC_OK;
}
static sc_status f_seal(void *u, sc_key_handle key, const uint8_t peer[32],
    const uint8_t nonce[24], const uint8_t *plain, size_t n, uint8_t *out, size_t cap) {
    (void)u; (void)key; (void)peer; (void)nonce;
    if (cap < n + 16) return SC_ERR_BOUNDS;
    memset(out, 0xa5, 16); memcpy(out + 16, plain, n); return SC_OK;
}
static sc_status f_open(void *u, sc_key_handle key, const uint8_t peer[32],
    const uint8_t nonce[24], const uint8_t *cipher, size_t n, uint8_t *out, size_t cap) {
    size_t i;
    (void)u; (void)key; (void)peer; (void)nonce;
    if (n < 16 || cap < n - 16) return SC_ERR_BOUNDS;
    for (i = 0; i < 16; ++i) if (cipher[i] != 0xa5) return SC_ERR_AUTH;
    memcpy(out, cipher + 16, n - 16); return SC_OK;
}
static sc_status f_secret(void *u, uint8_t out[32]) {
    memcpy(out, ((fuzz_store *)u)->token, 32); return SC_OK;
}
static sc_status f_load(void *u, uint8_t *out, size_t cap, size_t *n, uint64_t *g) {
    fuzz_store *s = u;
    if (!s->generation) return SC_NOT_FOUND;
    if (cap < s->length) return SC_ERR_BOUNDS;
    memcpy(out, s->record, s->length); *n = s->length; *g = s->generation; return SC_OK;
}
static sc_status f_commit(void *u, uint64_t expected, const uint8_t *record, size_t n) {
    fuzz_store *s = u;
    if (s->fail_commit) return SC_ERR_STORAGE;
    if (expected != s->generation || n > sizeof s->record) return SC_ERR_STORAGE;
    memcpy(s->record, record, n); s->length = n; ++s->generation; return SC_OK;
}
static sc_status f_reserve(void *u, uint32_t domain, uint64_t count, uint64_t *first) {
    fuzz_store *s = u;
    if (domain > 2 || domain == 0 || s->counters[domain] > UINT64_MAX - count) return SC_ERR_EXHAUSTED;
    *first = s->counters[domain]; s->counters[domain] += count; return SC_OK;
}
static void f_init(sc_context *ctx, fuzz_store *store, sc_role role, const uint8_t *peer) {
    sc_config config;
    sc_provider provider = {store, f_public, f_seal, f_open, NULL, f_secret, f_load, f_commit, f_reserve, NULL, NULL};
    memset(&config, 0, sizeof config); config.role = role;
    memcpy(config.serial, "fuzz-device", 12);
    if (peer) memcpy(config.peer_public_key, peer, 32);
    require(sc_init(ctx, &config, &provider) == SC_OK);
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    sc_context device, server, *target;
    fuzz_store ds, ss;
    sc_state before, after;
    uint8_t frame[SC_MAX_FRAME];
    size_t n = 0;
    sc_status status;
    unsigned mode;
    if (size == 0) return 0;
    mode = data[0]; ++data; --size;
    if (size > SC_MAX_FRAME) return 0;
    memset(&ds, 0, sizeof ds); memset(&ss, 0, sizeof ss);
    memset(ds.key, 0x22, 32); memset(ss.key, 0x11, 32);
    memset(ds.token, 0x73, 32); memset(ss.token, 0x73, 32);
    f_init(&device, &ds, SC_DEVICE, ss.key);
    f_init(&server, &ss, SC_SERVER, NULL);
    require(sc_outbound(&device, 512, frame, 512, &n) == SC_OK);
    /* Optionally retain an unenrolled server to exercise token authorization. */
    if (!(mode & 16u)) require(sc_receive(&server, frame, n) == SC_OK);
    if (mode & 2u) {
        if (!server.state.registered) require(sc_receive(&server, frame, n) == SC_OK);
        require(sc_set_credits_issued(&server, 100) == SC_OK);
        require(sc_outbound(&server, 512, frame, 512, &n) == SC_OK);
        target = &device;
    } else target = &server;
    if (mode & 1u) {
        memcpy(frame, data, size); n = size;
    } else {
        /* Preserve header and fake auth tag; directly fuzz protobuf contents. */
        if (size > sizeof frame - 78u) return 0;
        memcpy(frame + 78, data, size); n = 78u + size;
    }
    if (mode & 4u) { ds.fail_commit = 1; ss.fail_commit = 1; }
    before = target->state;
    status = sc_receive(target, frame, n);
    after = target->state;
    if (status != SC_OK) require(memcmp(&before, &after, sizeof before) == 0);
    else {
        /* Receiving exactly the same protected snapshot is idempotent. */
        require(sc_receive(target, frame, n) == SC_OK);
        require(memcmp(&after, &target->state, sizeof after) == 0);
    }
    return 0;
}

#ifdef SC_FUZZ_STANDALONE
#include <stdio.h>
int main(void) {
    uint8_t data[SC_MAX_FRAME + 1u];
    uint32_t seed = 0x91e10da5u;
    size_t i, j;
    for (i = 0; i < 5000; ++i) {
        size_t length;
        seed = seed * 1664525u + 1013904223u; length = seed % sizeof data;
        for (j = 0; j < length; ++j) {
            seed = seed * 1664525u + 1013904223u; data[j] = (uint8_t)(seed >> 24);
        }
        LLVMFuzzerTestOneInput(data, length);
    }
    puts("standalone reusable parser fuzz smoke passed");
    return 0;
}
#endif
