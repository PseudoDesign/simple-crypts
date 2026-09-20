/* Power-cut model: each erase/program may stop before, during, or after mutation. */
#include "store.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    uint8_t bytes[3 * QT_SECTOR];
    unsigned operation, cut, mode;
} flash_model;
static int read_flash(void *u, uint32_t at, void *out, size_t n) {
    flash_model *m = u;
    assert(at + n <= sizeof m->bytes);
    memcpy(out, m->bytes + at, n);
    return 0;
}
static int mutate(flash_model *m, uint32_t at, const uint8_t *data, size_t n) {
    unsigned cut = ++m->operation == m->cut;
    size_t count = cut ? (m->mode == 0 ? 0 : m->mode == 1 ? n / 2 : n) : n;
    for (size_t i = 0; i < count; ++i) {
        m->bytes[at + i] = data ? data[i] : 255;
    }
    return cut ? -1 : 0;
}
static int erase_flash(void *u, uint32_t at) {
    flash_model *m = u;
    assert(at % QT_SECTOR == 0 && at + QT_SECTOR <= sizeof m->bytes);
    return mutate(m, at, NULL, QT_SECTOR);
}
static int program_flash(void *u, uint32_t at, const void *data, size_t n) {
    flash_model *m = u;
    assert(at % QT_PAGE == 0 && n == QT_PAGE && at + n <= sizeof m->bytes);
    for (size_t i = 0; i < n; ++i) {
        assert(m->bytes[at + i] == 255);
    }
    return mutate(m, at, data, n);
}
static qt_flash backend(flash_model *m) {
    qt_flash f = {m, read_flash, erase_flash, program_flash};
    return f;
}
int main(void) {
    flash_model base = {0};
    memset(base.bytes, 255, sizeof base.bytes);
    qt_flash f = backend(&base);
    qt_store s;
    assert(qt_store_open(&s, &f) == 0 && !s.state.provisioned);
    qt_snapshot identity = {0};
    identity.provisioned = 1;
    memcpy(identity.serial, "fixture", 8);
    memset(identity.secret, 0x5a, sizeof identity.secret);
    assert(qt_store_save(&s, &identity) == 0);
    const uint8_t record[] = {1, 2, 3};
    assert(qt_store_commit(&s, 0, record, sizeof record) == SC_OK);
    uint64_t first = 99;
    assert(qt_store_reserve(&s, 7, 32, &first) == SC_OK && first == 0);
    assert(s.state.generation == 1 && s.state.nonce_end == 32);
    assert(qt_store_commit(&s, 0, record, sizeof record) == SC_ERR_CONFLICT);
    assert(qt_store_reserve(&s, 8, 32, &first) == SC_ERR_STORAGE);
    assert(qt_store_commit(&s, 1, record, sizeof record) == SC_OK);
    assert(s.state.nonce_end == 32 && s.state.nonce_domain == 7);
    /* A returned success must survive reboot and skip the previously leased range. */
    assert(qt_store_open(&s, &f) == 0);
    assert(qt_store_reserve(&s, 7, 32, &first) == SC_OK && first == 32);
    assert(s.state.generation == 2);
    base.operation = 0;
    for (unsigned mode = 0; mode < 3; ++mode) {
        for (unsigned cut = 1; cut <= 17; ++cut) {
            flash_model m = base;
            qt_flash target = backend(&m);
            assert(qt_store_open(&s, &target) == 0);
            m.cut = cut;
            m.mode = mode;
            assert(qt_store_reserve(&s, 7, 32, &first) == SC_ERR_STORAGE);
            assert(s.fault);
            assert(qt_store_commit(&s, 2, record, sizeof record) == SC_ERR_STORAGE);
            m.cut = 0;
            int rc = qt_store_open(&s, &target);
            if (!rc) {
                assert(s.state.nonce_end == 64 || s.state.nonce_end == 96);
                assert(s.state.generation == 2);
                assert(memcmp(s.state.secret, identity.secret, 64) == 0);
                assert(qt_store_reserve(&s, 7, 32, &first) == SC_OK);
                assert(first >= 64);
            } else {
                assert(s.fault);
            }
        }
        for (unsigned cut = 1; cut <= 4; ++cut) {
            flash_model m = base;
            qt_flash target = backend(&m);
            assert(qt_store_open(&s, &target) == 0);
            m.cut = cut;
            m.mode = mode;
            assert(qt_store_reset(&s) != 0);
            m.cut = 0;
            assert(qt_store_open(&s, &target) == 0);
            /* A cut before the first marker byte leaves the original identity intact. */
            if (cut == 1 && mode == 0) {
                assert(s.state.provisioned);
            } else {
                assert(!s.state.provisioned);
            }
        }
    }
    /* A valid commit marker plus corrupt contents cannot roll back nonce state. */
    assert(qt_store_open(&s, &f) == 0);
    base.bytes[s.active * QT_SECTOR + 32] ^= 1;
    assert(qt_store_open(&s, &f) != 0 && s.fault);
    assert(qt_store_reset(&s) == 0);
    assert(qt_store_open(&s, &f) == 0 && !s.state.provisioned);
    puts("snapshot, reservation, reset, and 63 power-cut cases passed");
    return 0;
}
