/* Power-cut model: each erase/program may stop before, during, or after mutation. */
#include "store.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    uint8_t bytes[QT_NVM_BYTES];
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
    /* Fill and wrap the ring repeatedly; all sectors must share the wear equally. */
    assert(qt_store_reset(&s) == 0);
    assert(qt_store_open(&s, &f) == 0);
    qt_snapshot current = identity;
    current.generation = 2;
    current.record_len = sizeof record;
    memcpy(current.record, record, sizeof record);
    current.nonce_domain = 7;
    current.nonce_end = 64;
    for (unsigned i = 0; i < 3 * QT_SNAPSHOT_SECTORS; ++i) {
        assert(qt_store_save(&s, &current) == 0);
        assert(s.active == (int)(i % QT_SNAPSHOT_SECTORS));
    }
    for (unsigned i = 0; i < QT_SNAPSHOT_SECTORS; ++i) {
        assert(s.erase_attempts[i] == 3);
    }
    assert(s.erase_attempts[QT_RESET_SECTOR] == 0);
    assert(qt_store_open(&s, &f) == 0);
    assert(s.sequence == 3 * QT_SNAPSHOT_SECTORS);
    assert(s.active == (int)QT_SNAPSHOT_SECTORS - 1);
    /* Fault injection below overwrites an old committed sector at ring wrap. */
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
        for (unsigned cut = 1; cut <= QT_NVM_SECTORS + 1; ++cut) {
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
                for (size_t i = 0; i < sizeof m.bytes; ++i) {
                    assert(m.bytes[i] == 255);
                }
            }
        }
    }
    /* Reject duplicate sequences even when neither is the newest snapshot. */
    flash_model duplicate = base;
    memcpy(duplicate.bytes + QT_SECTOR, duplicate.bytes, QT_SECTOR);
    qt_flash duplicate_backend = backend(&duplicate);
    assert(qt_store_open(&s, &duplicate_backend) != 0 && s.fault);
    /* A legacy two-sector image at its original physical offsets requires reset. */
    flash_model legacy = {0};
    memset(legacy.bytes, 255, sizeof legacy.bytes);
    uint8_t *old = legacy.bytes + (QT_SNAPSHOT_SECTORS - 2) * QT_SECTOR;
    memcpy(old, base.bytes, QT_SECTOR);
    memcpy(old, "QTS1", 4);
    memcpy(old + QT_BODY, "QTC1", 4);
    memset(old + 16, 0, 8);
    uint64_t legacy_crc = qt_crc(old, QT_BODY);
    for (unsigned i = 0; i < 8; ++i) {
        old[16 + i] = (uint8_t)(legacy_crc >> (8 * i));
        old[QT_BODY + 16 + i] = old[16 + i];
    }
    qt_flash legacy_backend = backend(&legacy);
    assert(qt_store_open(&s, &legacy_backend) != 0 && s.fault);
    /* The unchanged physical reset-marker address also recovers old interrupted resets. */
    legacy.bytes[QT_RESET_SECTOR * QT_SECTOR] = 0;
    assert(qt_store_open(&s, &legacy_backend) == 0 && !s.state.provisioned);
    assert(qt_store_reset(&s) == 0);
    assert(qt_store_open(&s, &legacy_backend) == 0 && !s.state.provisioned);
    /* A valid commit marker plus corrupt contents cannot roll back nonce state. */
    assert(qt_store_open(&s, &f) == 0);
    base.bytes[s.active * QT_SECTOR + 32] ^= 1;
    assert(qt_store_open(&s, &f) != 0 && s.fault);
    assert(qt_store_reset(&s) == 0);
    assert(qt_store_open(&s, &f) == 0 && !s.state.provisioned);
    puts("ring wear, wrap recovery, legacy rejection, and 153 power-cut cases passed");
    return 0;
}
