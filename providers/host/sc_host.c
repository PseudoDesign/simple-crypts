#define _POSIX_C_SOURCE 200809L
#include "sc_host.h"
#include "core/sc.h"
#include "providers/sodium/sc_sodium.h"
#ifdef SC_ENABLE_TESTING
#include "core/sc_test.h"
#endif
#include <sodium.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#include <time.h>

#define HOST_CRYPTO_ERROR (-12)
#define HOST_PATH_MAX 4096
#define HOST_NONCE_DOMAINS 8
typedef struct {
    uint32_t domain;
    uint64_t next;
} counter_slot;
typedef struct {
    uint8_t magic[8];
    uint32_t format, role;
    char serial[SC_MAX_SERIAL + 1];
    uint8_t public_key[32], private_key[64], server_key[32], token[32];
    counter_slot counters[HOST_NONCE_DOMAINS];
    uint64_t generation;
    uint32_t length;
    uint8_t record[SC_MAX_RECORD];
    uint8_t digest[32];
} disk_record;
struct sc_host {
    sc_context core;
    sc_sodium_keystore keystore;
    disk_record disk;
    int lock_fd, dir_fd, poisoned, random_unavailable;
    unsigned fail_storage, fail_random, fail_crypto;
};

static int consume(unsigned *count) {
    if (!*count) {
        return 0;
    }
    --*count;
    return 1;
}
static int write_all(int fd, const void *data, size_t size) {
    const uint8_t *p = data;
    while (size) {
        ssize_t n = write(fd, p, size);
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n <= 0) {
            return -1;
        }
        p += n;
        size -= (size_t)n;
    }
    return 0;
}
static int sync_parent(const char *path) {
    char parent[HOST_PATH_MAX];
    char *slash;
    size_t length;
    int fd, result;
    length = strlen(path);
    if (length >= sizeof parent) {
        return -1;
    }
    memcpy(parent, path, length + 1);
    while (length > 1 && parent[length - 1] == '/') {
        parent[--length] = 0;
    }
    slash = strrchr(parent, '/');
    if (!slash) {
        strcpy(parent, ".");
    } else if (slash == parent) {
        parent[1] = 0;
    } else {
        *slash = 0;
    }
    fd = open(parent, O_RDONLY | O_DIRECTORY);
    if (fd < 0) {
        return -1;
    }
    result = fsync(fd);
    if (close(fd)) {
        result = -1;
    }
    return result;
}
static sc_status persist(sc_host *h, disk_record *next) {
    int fd, saved;
    if (h->poisoned || consume(&h->fail_storage)) {
        return SC_ERR_STORAGE;
    }
    if (crypto_generichash(next->digest, sizeof next->digest, (const unsigned char *)next,
                           offsetof(disk_record, digest), NULL, 0)) {
        return SC_ERR_STORAGE;
    }
    fd = openat(h->dir_fd, "state.tmp", O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
    if (fd < 0) {
        return SC_ERR_STORAGE;
    }
    saved = write_all(fd, next, sizeof *next) || fsync(fd);
    if (close(fd)) {
        saved = 1;
    }
    if (saved) {
        unlinkat(h->dir_fd, "state.tmp", 0);
        return SC_ERR_STORAGE;
    }
    if (renameat(h->dir_fd, "state.tmp", h->dir_fd, "state.bin")) {
        return SC_ERR_STORAGE;
    }
    /* A failure after rename has an ambiguous durability outcome. Fail closed
     * until reopen; never continue allocating counters from old in-memory data. */
    if (fsync(h->dir_fd)) {
        h->poisoned = 1;
        return SC_ERR_STORAGE;
    }
    h->disk = *next;
    return SC_OK;
}
static sc_status p_public(void *user, sc_key_handle key, uint8_t out[32]) {
    sc_host *h = user;
    if (key != 1) {
        return SC_ERR_ARGUMENT;
    }
    if (consume(&h->fail_crypto)) {
        return (sc_status)HOST_CRYPTO_ERROR;
    }
    return sc_sodium_public(&h->keystore, key, out);
}
static sc_status key_lookup(void *user, sc_key_handle key, const uint8_t **pk, const uint8_t **sk) {
    sc_host *h = user;
    if (key != 1) {
        return SC_ERR_ARGUMENT;
    }
    *pk = h->disk.public_key;
    *sk = h->disk.private_key;
    return SC_OK;
}
static sc_status p_seal(void *user, sc_key_handle key, const uint8_t peer[32],
                        const uint8_t nonce[24], const uint8_t *plain, size_t length,
                        uint8_t *cipher, size_t capacity) {
    sc_host *h = user;
    if (key != 1 || length > SIZE_MAX - 16 || capacity < length + 16) {
        return SC_ERR_BOUNDS;
    }
    if (h->poisoned) {
        return SC_ERR_STORAGE;
    }
    if (consume(&h->fail_crypto)) {
        return (sc_status)HOST_CRYPTO_ERROR;
    }
    return sc_sodium_ed_seal(&h->keystore, key, peer, nonce, plain, length, cipher, capacity);
}
static sc_status p_open(void *user, sc_key_handle key, const uint8_t peer[32],
                        const uint8_t nonce[24], const uint8_t *cipher, size_t length,
                        uint8_t *plain, size_t capacity) {
    sc_host *h = user;
    if (key != 1 || length < 16 || capacity < length - 16) {
        return SC_ERR_BOUNDS;
    }
    if (h->poisoned) {
        return SC_ERR_STORAGE;
    }
    if (consume(&h->fail_crypto)) {
        return (sc_status)HOST_CRYPTO_ERROR;
    }
    return sc_sodium_ed_open(&h->keystore, key, peer, nonce, cipher, length, plain, capacity);
}
static sc_status p_random(void *user, uint8_t *out, size_t length) {
    sc_host *h = user;
    if (h->random_unavailable || consume(&h->fail_random)) {
        return SC_ERR_RANDOM;
    }
    randombytes_buf(out, length);
    return SC_OK;
}
static sc_status p_secret(void *user, uint8_t out[32]) {
    sc_host *h = user;
    memcpy(out, h->disk.token, 32);
    return SC_OK;
}
static sc_status p_load(void *user, uint8_t *out, size_t capacity, size_t *length,
                        uint64_t *generation) {
    sc_host *h = user;
    if (h->poisoned || consume(&h->fail_storage)) {
        return SC_ERR_STORAGE;
    }
    if (!h->disk.generation) {
        return SC_NOT_FOUND;
    }
    if (capacity < h->disk.length) {
        return SC_ERR_BOUNDS;
    }
    memcpy(out, h->disk.record, h->disk.length);
    *length = h->disk.length;
    *generation = h->disk.generation;
    return SC_OK;
}
static sc_status p_commit(void *user, uint64_t expected, const uint8_t *record, size_t length) {
    sc_host *h = user;
    disk_record next;
    if (length > SC_MAX_RECORD) {
        return SC_ERR_BOUNDS;
    }
    if (expected != h->disk.generation) {
        return SC_ERR_CONFLICT;
    }
    if (expected == UINT64_MAX) {
        return SC_ERR_EXHAUSTED;
    }
    next = h->disk;
    memset(next.record, 0, sizeof next.record);
    memcpy(next.record, record, length);
    next.length = (uint32_t)length;
    next.generation = expected + 1;
    return persist(h, &next);
}
static sc_status p_reserve(void *user, uint32_t domain, uint64_t count, uint64_t *first) {
    sc_host *h = user;
    disk_record next = h->disk;
    size_t i;
    if (!domain || !count) {
        return SC_ERR_ARGUMENT;
    }
    for (i = 0; i < HOST_NONCE_DOMAINS; ++i) {
        if (next.counters[i].domain == domain || !next.counters[i].domain) {
            break;
        }
    }
    if (i == HOST_NONCE_DOMAINS) {
        return SC_ERR_BOUNDS;
    }
    if (next.counters[i].next > UINT64_MAX - count) {
        return SC_ERR_EXHAUSTED;
    }
    *first = next.counters[i].next;
    next.counters[i].domain = domain;
    next.counters[i].next += count;
    return persist(h, &next);
}
int sc_host_fixture_public(const uint8_t seed[32], uint8_t public_key[32]) {
    uint8_t sk[64];
    int result;
    if (!seed || !public_key || sodium_init() < 0) {
        return HOST_CRYPTO_ERROR;
    }
    result = crypto_sign_seed_keypair(public_key, sk, seed);
    sodium_memzero(sk, sizeof sk);
    return result ? HOST_CRYPTO_ERROR : SC_OK;
}
static sc_status p_sign(void *user, sc_key_handle key, const uint8_t *m, size_t n,
                        uint8_t sig[64]) {
    sc_host *h = user;
    if (consume(&h->fail_crypto)) {
        return SC_ERR_CRYPTO;
    }
    return sc_sodium_sign(&h->keystore, key, m, n, sig);
}
static sc_status p_verify(void *user, const uint8_t key[32], const uint8_t *m, size_t n,
                          const uint8_t sig[64]) {
    sc_host *h = user;
    if (consume(&h->fail_crypto)) {
        return SC_ERR_CRYPTO;
    }
    return sc_sodium_verify(&h->keystore, key, m, n, sig);
}
int sc_host_initialize(int role, const char *storage, const char *serial, const uint8_t *secret,
                       const uint8_t *seed, const uint8_t *server_key, int random_unavailable,
                       sc_host **out) {
    sc_host *h = NULL;
    sc_config config;
    sc_provider provider;
    disk_record initial;
    uint8_t digest[32], check_pk[32], check_sk[64];
    int fd, created, result = SC_ERR_STORAGE;
    size_t used;
    ssize_t n;
    struct stat st;
    if (!out) {
        return SC_ERR_ARGUMENT;
    }
    *out = NULL;
    if (!storage || !serial || !secret || strlen(serial) > SC_MAX_SERIAL || !*serial ||
        strlen(storage) >= HOST_PATH_MAX || (role != SC_DEVICE && role != SC_SERVER) ||
        (role == SC_DEVICE && !server_key)) {
        return SC_ERR_ARGUMENT;
    }
    if (sodium_init() < 0) {
        return HOST_CRYPTO_ERROR;
    }
    h = calloc(1, sizeof *h);
    if (!h) {
        return SC_ERR_STORAGE;
    }
    h->lock_fd = h->dir_fd = -1;
    h->random_unavailable = random_unavailable;
    h->keystore.user = h;
    h->keystore.lookup = key_lookup;
    created = mkdir(storage, 0700) == 0;
    if (!created && errno != EEXIST) {
        goto fail;
    }
    /* Persist the new directory entry before any keys or reserved nonces can
     * be used. Otherwise a power loss could remove a newly created store. */
    if (created && sync_parent(storage)) {
        goto fail;
    }
    h->dir_fd = open(storage, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (h->dir_fd < 0 || fstat(h->dir_fd, &st) || st.st_uid != geteuid() || (st.st_mode & 077)) {
        goto fail;
    }
    h->lock_fd = openat(h->dir_fd, "state.lock", O_RDWR | O_CREAT | O_NOFOLLOW, 0600);
    if (h->lock_fd < 0 || flock(h->lock_fd, LOCK_EX | LOCK_NB)) {
        goto fail;
    }
    fd = openat(h->dir_fd, "state.bin", O_RDONLY | O_NOFOLLOW);
    if (fd >= 0) {
        if (fstat(fd, &st) || st.st_size != (off_t)sizeof initial || st.st_uid != geteuid() ||
            (st.st_mode & 077)) {
            close(fd);
            goto fail;
        }
        used = 0;
        while (used < sizeof initial) {
            n = read(fd, (uint8_t *)&initial + used, sizeof initial - used);
            if (n < 0 && errno == EINTR) {
                continue;
            }
            if (n <= 0) {
                close(fd);
                goto fail;
            }
            used += (size_t)n;
        }
        close(fd);
        crypto_generichash(digest, sizeof digest, (const unsigned char *)&initial,
                           offsetof(disk_record, digest), NULL, 0);
        if (memcmp(initial.magic, "SCSTORE3", 8) || initial.format != 3 ||
            initial.length > SC_MAX_RECORD || sodium_memcmp(digest, initial.digest, 32)) {
            goto fail;
        }
        if (initial.role != (uint32_t)role || sodium_memcmp(initial.token, secret, 32) ||
            strncmp(initial.serial, serial, sizeof initial.serial) ||
            (role == SC_DEVICE && memcmp(initial.server_key, server_key, 32))) {
            result = SC_ERR_CONFLICT;
            goto fail;
        }
        if (seed) {
            crypto_sign_seed_keypair(check_pk, check_sk, seed);
            sodium_memzero(check_sk, sizeof check_sk);
            if (memcmp(check_pk, initial.public_key, 32)) {
                result = SC_ERR_CONFLICT;
                goto fail;
            }
        }
        h->disk = initial;
    } else {
        if (errno != ENOENT) {
            goto fail;
        }
        memset(&initial, 0, sizeof initial);
        memcpy(initial.magic, "SCSTORE3", 8);
        initial.format = 3;
        initial.role = (uint32_t)role;
        memcpy(initial.serial, serial, strlen(serial) + 1);
        memcpy(initial.token, secret, 32);
        if (role == SC_DEVICE) {
            memcpy(initial.server_key, server_key, 32);
        }
        if (seed) {
            crypto_sign_seed_keypair(initial.public_key, initial.private_key, seed);
        } else {
            uint8_t generated_seed[32];
            result = p_random(h, generated_seed, sizeof generated_seed);
            if (result != SC_OK) {
                goto fail;
            }
            crypto_sign_seed_keypair(initial.public_key, initial.private_key, generated_seed);
            sodium_memzero(generated_seed, sizeof generated_seed);
        }
        result = persist(h, &initial);
        if (result != SC_OK) {
            goto fail;
        }
    }
    memset(&config, 0, sizeof config);
    config.role = (sc_role)role;
    config.identity_key = 1;
    memcpy(config.serial, serial, strlen(serial) + 1);
    if (role == SC_DEVICE) {
        memcpy(config.peer_public_key, server_key, 32);
    }
    memset(&provider, 0, sizeof provider);
    provider.user = h;
    provider.sign = p_sign;
    provider.verify = p_verify;
    provider.public_key = p_public;
    provider.seal = p_seal;
    provider.open = p_open;
    provider.random = p_random;
    provider.enrollment_secret = p_secret;
    provider.load = p_load;
    provider.commit = p_commit;
    provider.reserve = p_reserve;
    result = sc_init(&h->core, &config, &provider);
    if (result != SC_OK) {
        goto fail;
    }
    sodium_memzero(&initial, sizeof initial);
    *out = h;
    return SC_OK;
fail:
    sodium_memzero(&initial, sizeof initial);
    sc_host_close(h);
    return result;
}
void sc_host_close(sc_host *h) {
    if (!h) {
        return;
    }
    if (h->lock_fd >= 0) {
        close(h->lock_fd);
    }
    if (h->dir_fd >= 0) {
        close(h->dir_fd);
    }
    sodium_memzero(h, sizeof *h);
    free(h);
}
int sc_host_set_credits_issued(sc_host *h, uint64_t total) {
    return h ? sc_set_credits_issued(&h->core, total) : SC_ERR_ARGUMENT;
}
int sc_host_consume_credits(sc_host *h, uint64_t amount) {
    return h ? sc_consume_credits(&h->core, amount) : SC_ERR_ARGUMENT;
}
int sc_host_request_credit_status(sc_host *h) {
    return h ? sc_request_credit_status(&h->core) : SC_ERR_ARGUMENT;
}

int sc_host_receive(sc_host *h, const uint8_t *frame, size_t n) {
    return h ? sc_receive_at(&h->core, frame, n, (uint64_t)time(NULL)) : SC_ERR_ARGUMENT;
}
int sc_host_outbound(sc_host *h, size_t budget, uint8_t *frame, size_t capacity, size_t *n) {
    return h ? sc_outbound(&h->core, budget, frame, capacity, n) : SC_ERR_ARGUMENT;
}
const char *sc_host_status(int status) {
    switch (status) {
    case SC_OK:
        return "ok";
    case SC_NO_OUTPUT:
        return "idle";
    case SC_NOT_FOUND:
        return "not_found";
    case SC_ERR_ARGUMENT:
        return "invalid";
    case SC_ERR_BOUNDS:
        return "buffer";
    case SC_ERR_AUTH:
        return "auth";
    case SC_ERR_PROTOCOL:
        return "protocol";
    case SC_ERR_STORAGE:
        return "storage";
    case SC_ERR_RANDOM:
        return "random";
    case SC_ERR_CONFLICT:
        return "conflict";
    case SC_ERR_EXHAUSTED:
        return "exhausted";
    case SC_ERR_ROLE:
        return "role";
    case SC_ERR_ENROLLMENT:
        return "enrollment";
    case SC_ERR_UTF8:
        return "utf8";
    case HOST_CRYPTO_ERROR:
        return "crypto";
    default:
        return "internal";
    }
}
int sc_host_fail(sc_host *h, const char *operation, unsigned count) {
    if (!h || !operation) {
        return SC_ERR_ARGUMENT;
    }
    if (!strcmp(operation, "storage")) {
        h->fail_storage = count;
    } else if (!strcmp(operation, "random")) {
        h->fail_random = count;
    } else if (!strcmp(operation, "crypto")) {
        h->fail_crypto = count;
    } else {
        return SC_ERR_ARGUMENT;
    }
    return SC_OK;
}
static void json_string(const char *input, char *output) {
    static const char hex[] = "0123456789abcdef";
    const unsigned char *p = (const unsigned char *)input;
    while (*p) {
        unsigned c = *p++;
        if (c == '"' || c == '\\') {
            *output++ = '\\';
            *output++ = (char)c;
        } else if (c < 32) {
            memcpy(output, "\\u00", 4);
            output += 4;
            *output++ = hex[c >> 4];
            *output++ = hex[c & 15];
        } else {
            *output++ = (char)c;
        }
    }
    *output = 0;
}
int sc_host_enrollment_enable(sc_host *h) {
    return h ? sc_enrollment_enable(&h->core) : SC_ERR_ARGUMENT;
}
int sc_host_enrollment_begin(sc_host *h, uint64_t now, uint64_t expires) {
    return h ? sc_enrollment_begin(&h->core, now, expires) : SC_ERR_ARGUMENT;
}
int sc_host_enrollment_approve(sc_host *h, const uint8_t challenge[32], const uint8_t key[32],
                               uint64_t now) {
    return h ? sc_enrollment_approve(&h->core, challenge, key, now) : SC_ERR_ARGUMENT;
}
int sc_host_enrollment_cancel(sc_host *h) {
    return h ? sc_enrollment_cancel(&h->core) : SC_ERR_ARGUMENT;
}
int sc_host_receive_at(sc_host *h, const uint8_t *frame, size_t n, uint64_t now) {
    return h ? sc_receive_at(&h->core, frame, n, now) : SC_ERR_ARGUMENT;
}
int sc_host_inspect(sc_host *h, char *json, size_t capacity) {
    sc_state state;
    char serial[6 * SC_MAX_SERIAL + 1], public_key[65], peer_key[65], buffer[4096];
    int n, result;
    if (!h || !json) {
        return SC_ERR_ARGUMENT;
    }
    result = sc_inspect(&h->core, &state);
    if (result) {
        return result;
    }
    json_string(state.serial, serial);
    sodium_bin2hex(public_key, 65, h->disk.public_key, 32);
    sodium_bin2hex(peer_key, 65, state.peer_public_key, 32);
    const sc_group_state *g = &state.data.groups[0];
    n = snprintf(buffer, sizeof buffer,
                 "{\"role\":\"%s\",\"serial\":\"%s\",\"public_key\":\"%s\",\"peer_public_key\":\"%"
                 "s\",\"registered\":%s,\"pending\":%s,"
                 "\"credits_issued\":\"%" PRIu64 "\",\"credits_consumed\":\"%" PRIu64
                 "\",\"snapshot_issued\":\"%" PRIu64 "\",\"snapshot_consumed\":\"%" PRIu64 "\","
                 "\"request_id\":\"%" PRIu64 "\",\"snapshot_id\":\"%" PRIu64
                 "\",\"acknowledged_id\":\"%" PRIu64 "\",\"local_revision\":\"%" PRIu64
                 "\",\"has_snapshot\":%s,\"storage_generation\":\"%" PRIu64 "\"}",
                 state.role == SC_DEVICE ? "device" : "server", serial, public_key, peer_key,
                 state.registered ? "true" : "false", state.pending ? "true" : "false",
                 g->values[0].u64, g->values[1].u64, g->snapshot[0].u64, g->snapshot[1].u64,
                 g->request_id, g->snapshot_id, g->acknowledged_id, g->local_revision,
                 g->has_snapshot ? "true" : "false", state.storage_generation);
    if (n > 0 && (size_t)n < sizeof buffer) {
        char challenge[65], candidate[65];
        size_t used = (size_t)n - 1;
        sodium_bin2hex(challenge, sizeof challenge, state.challenge, 32);
        sodium_bin2hex(candidate, sizeof candidate, state.candidate_key, 32);
        n = snprintf(buffer + used, sizeof buffer - used,
                     ",\"enrollment_mode\":%u,\"challenge\":\"%s\",\"candidate_key\":\"%s\","
                     "\"candidate_revision\":\"%" PRIu64 "\",\"enrollment_expires\":\"%" PRIu64
                     "\"}",
                     state.enrollment_mode, challenge, candidate, state.candidate_revision,
                     state.enrollment_expires);
        if (n < 0 || (size_t)n >= sizeof buffer - used) {
            return SC_ERR_BOUNDS;
        }
        n += (int)used;
    }
    if (n < 0 || (size_t)n >= sizeof buffer || capacity <= (size_t)n) {
        return SC_ERR_BOUNDS;
    }
    memcpy(json, buffer, (size_t)n + 1);
    return SC_OK;
}
int sc_host_fixture_revision(sc_host *h, uint64_t revision) {
#ifdef SC_ENABLE_TESTING
    return h ? sc_test_seed_revision(&h->core, revision) : SC_ERR_ARGUMENT;
#else
    (void)h;
    (void)revision;
    return SC_ERR_ARGUMENT;
#endif
}

int sc_host_update_group(sc_host *h, uint16_t id, const uint8_t *data, size_t size) {
    return h ? sc_data_update_encoded(&h->core, id, data, size) : SC_ERR_ARGUMENT;
}
int sc_host_request_group(sc_host *h, uint16_t id) {
    return h ? sc_data_request(&h->core, id) : SC_ERR_ARGUMENT;
}
int sc_host_inspect_group(sc_host *h, uint16_t id, char *out, size_t cap) {
    sc_group_state g;
    uint8_t data[SC_DATA_MAX_PAYLOAD];
    char hex[SC_DATA_MAX_PAYLOAD * 2 + 1], json[1024];
    size_t length;
    int n;
    sc_status status;
    if (!h || !out) {
        return SC_ERR_ARGUMENT;
    }
    status = sc_data_inspect(&h->core, id, &g);
    if (status != SC_OK) {
        return status;
    }
    status = sc_data_encode_values(&h->core, id, data, sizeof data, &length);
    if (status != SC_OK) {
        return status;
    }
    sodium_bin2hex(hex, sizeof hex, data, length);
    n = snprintf(json, sizeof json,
                 "{\"data\":\"%s\",\"local_revision\":\"%" PRIu64 "\",\"request_id\":\"%" PRIu64
                 "\",\"snapshot_id\":\"%" PRIu64 "\",\"acknowledged_id\":\"%" PRIu64
                 "\",\"has_snapshot\":%s,\"pending\":%s}",
                 hex, g.local_revision, g.request_id, g.snapshot_id, g.acknowledged_id,
                 g.has_snapshot ? "true" : "false",
                 g.request_pending || g.response_pending || g.receipt_pending ? "true" : "false");
    if (n < 0 || (size_t)n >= sizeof json || cap <= (size_t)n) {
        return SC_ERR_BOUNDS;
    }
    memcpy(out, json, (size_t)n + 1);
    return SC_OK;
}
