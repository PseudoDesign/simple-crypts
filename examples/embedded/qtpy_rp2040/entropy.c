#include "entropy.h"
#include <string.h>
static uint8_t pool[32];
static size_t cursor;
static int available;
static void fault(void) {
    sodium_memzero(pool, sizeof pool);
    available = 0;
    qt_entropy_fault();
    for (;;) { /* Even an incorrectly returning platform hook cannot supply bytes. */
    }
}
static const char *name(void) {
    return "qtpy-host-once";
}
static void bytes(void *out, size_t length) {
    if (!available || length > sizeof pool - cursor) {
        fault();
    }
    memcpy(out, pool + cursor, length);
    sodium_memzero(pool + cursor, length);
    cursor += length;
}
static uint32_t word(void) {
    uint8_t b[4];
    bytes(b, sizeof b);
    return (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24;
}
static void stir(void) {
    if (!available) {
        fault();
    }
}
static int close_pool(void) {
    sodium_memzero(pool, sizeof pool);
    available = 0;
    return 0;
}
randombytes_implementation qtpy_random = {name, word, stir, NULL, bytes, close_pool};
int qt_crypto_start(const uint8_t *input, size_t length) {
    if (length != sizeof pool || available) {
        return -1;
    }
    memcpy(pool, input, sizeof pool);
    cursor = 0;
    available = 1;
    randombytes_set_implementation(&qtpy_random);
    int rc = sodium_init();
    /* Pin the initialization closure: unexpected dependency changes fail visibly. */
    if (rc < 0 || (rc == 0 && cursor != 16)) {
        fault();
    }
    close_pool();
    return 0;
}
