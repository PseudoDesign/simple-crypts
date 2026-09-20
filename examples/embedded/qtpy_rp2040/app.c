#include "app.h"
#include "entropy.h"
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

static sc_status lookup(void *u, sc_key_handle handle, const uint8_t **pk, const uint8_t **sk) {
    qt_app *a = u;
    if (handle != 1 || !a->store.state.provisioned || a->store.fault) {
        return SC_ERR_CRYPTO;
    }
    *pk = a->store.state.public_key;
    *sk = a->store.state.secret;
    return SC_OK;
}
static sc_status public_key(void *u, sc_key_handle h, uint8_t *out) {
    return sc_sodium_public(&((qt_app *)u)->keys, h, out);
}
static sc_status seal(void *u, sc_key_handle h, const uint8_t *pk, const uint8_t *nonce,
                      const uint8_t *in, size_t n, uint8_t *out, size_t cap) {
    return sc_sodium_ed_seal(&((qt_app *)u)->keys, h, pk, nonce, in, n, out, cap);
}
static sc_status open_box(void *u, sc_key_handle h, const uint8_t *pk, const uint8_t *nonce,
                          const uint8_t *in, size_t n, uint8_t *out, size_t cap) {
    return sc_sodium_ed_open(&((qt_app *)u)->keys, h, pk, nonce, in, n, out, cap);
}
static sc_status no_random(void *u, uint8_t *out, size_t n) {
    (void)u;
    (void)out;
    (void)n;
    return SC_ERR_RANDOM;
}
static sc_status no_legacy(void *u, uint8_t *out) {
    (void)u;
    (void)out;
    return SC_ERR_ENROLLMENT;
}
static sc_status load(void *u, uint8_t *out, size_t cap, size_t *n, uint64_t *g) {
    return qt_store_load(&((qt_app *)u)->store, out, cap, n, g);
}
static sc_status commit(void *u, uint64_t g, const uint8_t *record, size_t n) {
    return qt_store_commit(&((qt_app *)u)->store, g, record, n);
}
static sc_status reserve(void *u, uint32_t d, uint64_t n, uint64_t *first) {
    return qt_store_reserve(&((qt_app *)u)->store, d, n, first);
}
static sc_status sign(void *u, sc_key_handle h, const uint8_t *in, size_t n, uint8_t *sig) {
    return sc_sodium_sign(&((qt_app *)u)->keys, h, in, n, sig);
}
static int restore(qt_app *a) {
    sc_config config = {0};
    sc_provider provider = {0};
    config.role = SC_DEVICE;
    config.identity_key = 1;
    memcpy(config.serial, a->serial, sizeof config.serial);
    memcpy(config.peer_public_key, a->store.state.server_key, 32);
    provider.user = a;
    provider.public_key = public_key;
    provider.seal = seal;
    provider.open = open_box;
    provider.random = no_random;
    provider.enrollment_secret = no_legacy;
    provider.load = load;
    provider.commit = commit;
    provider.reserve = reserve;
    provider.sign = sign;
    provider.verify = sc_sodium_verify;
    int rc = sc_init(&a->core, &config, &provider);
    sc_state state = {0};
    if (rc == SC_OK) {
        rc = sc_inspect(&a->core, &state);
    }
    if (rc == SC_OK && !state.enrollment_mode) {
        rc = sc_enrollment_enable(&a->core);
    }
    a->ready = rc == SC_OK;
    return rc;
}
int qt_app_open(qt_app *a, const qt_flash *flash, const char *serial) {
    memset(a, 0, sizeof *a);
    if (!serial[0] || strlen(serial) > 32) {
        return SC_ERR_ARGUMENT;
    }
    memcpy(a->serial, serial, strlen(serial));
    a->keys.user = a;
    a->keys.lookup = lookup;
    int rc = qt_store_open(&a->store, flash);
    if (!rc && a->store.state.provisioned && strcmp(a->serial, a->store.state.serial)) {
        a->store.fault = 1;
        return SC_ERR_STORAGE;
    }
    return rc ? SC_ERR_STORAGE : SC_OK;
}
static void hex(const uint8_t *in, char *out) {
    const char digits[] = "0123456789abcdef";
    for (unsigned i = 0; i < 32; ++i) {
        out[2 * i] = digits[in[i] >> 4];
        out[2 * i + 1] = digits[in[i] & 15];
    }
    out[64] = 0;
}
static int status(qt_app *a, uint8_t *out, size_t cap, size_t *length) {
    char pk[65], server[65];
    sc_state state = {0};
    if (a->ready) {
        sc_inspect(&a->core, &state);
    }
    hex(a->store.state.public_key, pk);
    hex(a->store.state.server_key, server);
    uint64_t snapshot_erases = 0;
    for (unsigned i = 0; i < QT_SNAPSHOT_SECTORS; ++i) {
        snapshot_erases += a->store.erase_attempts[i];
    }
    int n = snprintf(
        (char *)out, cap,
        "{\"version\":1,\"flash_jedec\":\"%06" PRIx32 "\",\"stack_high_water\":%" PRIu32
        ",\"serial\":\"%s\",\"crypto_ready\":%d,\"provisioned\":%d,"
        "\"ready\":%d,\"fault\":%d,\"registered\":%d,\"public_key\":\"%s\",\"server_key\":\"%s\","
        "\"issued\":\"%" PRIu64 "\",\"consumed\":\"%" PRIu64 "\",\"sequence\":\"%" PRIu64 "\","
        "\"nonce_end\":\"%" PRIu64 "\",\"commits\":%" PRIu64 ",\"reservations\":%" PRIu64 ","
        "\"programmed_bytes\":%" PRIu64 ",\"snapshot_erase_attempts\":%" PRIu64
        ",\"reset_erase_attempts\":%" PRIu64 "}",
        a->flash_jedec, a->stack_high_water, a->serial, a->crypto_ready, a->store.state.provisioned,
        a->ready, a->store.fault, state.registered, pk, server, state.data.groups[0].values[0].u64,
        state.data.groups[0].values[1].u64, a->store.sequence, a->store.state.nonce_end,
        a->store.commits, a->store.reservations, a->store.programmed_bytes, snapshot_erases,
        a->store.erase_attempts[QT_RESET_SECTOR]);
    if (n < 0 || (size_t)n >= cap) {
        return SC_ERR_BOUNDS;
    }
    *length = (size_t)n;
    return SC_OK;
}
static int start(qt_app *a, const uint8_t *input, size_t n) {
    if (a->crypto_ready || n != 32) {
        return SC_ERR_ARGUMENT;
    }
    if (qt_crypto_start(input, n)) {
        return SC_ERR_RANDOM;
    }
    a->crypto_ready = 1;
    return a->store.state.provisioned ? restore(a) : SC_OK;
}
static int setup(qt_app *a, const uint8_t *input, size_t n) {
    /* startup[32], identity seed[32], trusted server pin[32], unchanged invitation[172]. */
    if (n != 268 || a->store.state.provisioned) {
        return SC_ERR_ARGUMENT;
    }
    if (!a->crypto_ready) {
        int rc = start(a, input, 32);
        if (rc) {
            return rc;
        }
    }
    const uint8_t *invitation = input + 96;
    uint8_t serial[32] = {0}, seed[32];
    memcpy(serial, a->serial, strlen(a->serial));
    if (memcmp(invitation, "SCE3", 4) || memcmp(invitation + 4, input + 64, 32) ||
        memcmp(invitation + 36, serial, 32) || sodium_is_zero(invitation + 68, 32) ||
        sodium_is_zero(invitation + 100, 8) ||
        crypto_sign_verify_detached(invitation + 108, invitation, 108, input + 64)) {
        return SC_ERR_AUTH;
    }
    crypto_generichash_state hash;
    static const uint8_t domain[] = "simple-crypts/demo/device-identity/v1";
    crypto_generichash_init(&hash, input + 32, 32, 32);
    crypto_generichash_update(&hash, domain, sizeof domain - 1);
    crypto_generichash_update(&hash, invitation, 172);
    crypto_generichash_final(&hash, seed, 32);
    qt_snapshot next = {0};
    crypto_sign_seed_keypair(next.public_key, next.secret, seed);
    sodium_memzero(seed, sizeof seed);
    sodium_memzero(&hash, sizeof hash);
    next.provisioned = 1;
    memcpy(next.serial, a->serial, sizeof next.serial);
    memcpy(next.server_key, input + 64, 32);
    int saved = qt_store_save(&a->store, &next);
    sodium_memzero(&next, sizeof next);
    if (saved) {
        return SC_ERR_STORAGE;
    }
    int rc = restore(a);
    return rc ? rc : sc_receive_at(&a->core, invitation, 172, 0);
}
int qt_app_command(qt_app *a, unsigned cmd, const uint8_t *in, size_t n, uint8_t *out, size_t cap,
                   size_t *length) {
    *length = 0;
    if (cmd == QT_HELLO && !n) {
        return status(a, out, cap, length);
    }
    if (cmd == QT_REBOOT && !n) {
        a->reboot = 1;
        return SC_OK;
    }
    if (cmd == QT_RESET && !n) {
        a->ready = 0;
        int rc = qt_store_reset(&a->store);
        sodium_memzero(&a->core, sizeof a->core);
        if (rc) {
            return SC_ERR_STORAGE;
        }
        a->reboot = 1;
        return SC_OK;
    }
    if (a->store.fault) {
        return SC_ERR_STORAGE;
    }
    if (cmd == QT_START) {
        return start(a, in, n);
    }
    if (cmd == QT_SETUP) {
        return setup(a, in, n);
    }
    if (!a->ready) {
        return SC_ERR_ARGUMENT;
    }
    if (cmd == QT_RECEIVE && n && n <= SC_MAX_FRAME) {
        return sc_receive_at(&a->core, in, n, 0);
    }
    if (cmd == QT_OUTBOUND && !n) {
        return sc_outbound(&a->core, SC_MAX_FRAME, out, cap, length);
    }
    if (cmd == QT_CONSUME && n == 8) {
        uint64_t amount = 0;
        for (unsigned i = 0; i < 8; ++i) {
            amount = (amount << 8) | in[i];
        }
        return sc_consume_credits(&a->core, amount);
    }
    return SC_ERR_ARGUMENT;
}
