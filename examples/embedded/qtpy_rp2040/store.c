#include "store.h"
#include <limits.h>
#include <string.h>

typedef char snapshot_fits[(232u + SC_MAX_RECORD <= QT_BODY) ? 1 : -1];
static void wipe(void *p, size_t n) {
    volatile uint8_t *bytes = p;
    while (n--) {
        *bytes++ = 0;
    }
}
static void put64(uint8_t *p, uint64_t n) {
    for (unsigned i = 0; i < 8; ++i) {
        p[i] = (uint8_t)(n >> (8u * i));
    }
}
static uint64_t get64(const uint8_t *p) {
    uint64_t n = 0;
    for (unsigned i = 0; i < 8; ++i) {
        n |= (uint64_t)p[i] << (8u * i);
    }
    return n;
}
uint32_t qt_crc(const uint8_t *p, size_t n) {
    uint32_t c = UINT32_MAX;
    for (size_t i = 0; i < n; ++i) {
        c ^= p[i];
        for (unsigned j = 0; j < 8; ++j) {
            c = (c >> 1) ^ (0xedb88320u & (0u - (c & 1u)));
        }
    }
    return ~c;
}
static int blank(const uint8_t *p, size_t n) {
    for (size_t i = 0; i < n; ++i) {
        if (p[i] != 255) {
            return 0;
        }
    }
    return 1;
}
static int fail(qt_store *s) {
    s->fault = 1;
    wipe(s->state.secret, sizeof s->state.secret);
    wipe(s->scratch, sizeof s->scratch);
    return -1;
}
static int read_at(qt_store *s, uint32_t at, void *out, size_t n) {
    if (s->flash.read(s->flash.user, at, out, n)) {
        return fail(s);
    }
    return 0;
}
static int erase(qt_store *s, unsigned sector) {
    s->erase_attempts[sector]++;
    if (s->flash.erase(s->flash.user, sector * QT_SECTOR)) {
        return fail(s);
    }
    if (read_at(s, sector * QT_SECTOR, s->scratch, QT_SECTOR) || !blank(s->scratch, QT_SECTOR)) {
        return fail(s);
    }
    return 0;
}
static void encode(uint8_t *p, const qt_snapshot *v, uint64_t sequence) {
    memset(p, 0, QT_BODY);
    memcpy(p, "QTS2", 4);
    put64(p + 8, sequence);
    memcpy(p + 32, v->secret, 64);
    memcpy(p + 96, v->public_key, 32);
    memcpy(p + 128, v->server_key, 32);
    memcpy(p + 160, v->serial, 32);
    p[192] = v->provisioned;
    put64(p + 200, v->generation);
    put64(p + 208, v->nonce_domain);
    put64(p + 216, v->nonce_end);
    put64(p + 224, v->record_len);
    memcpy(p + 232, v->record, v->record_len);
    put64(p + 16, qt_crc(p, QT_BODY));
}
static void marker(uint8_t *p, uint64_t sequence, uint64_t crc) {
    memset(p, 0, QT_PAGE);
    memcpy(p, "QTC2", 4);
    put64(p + 8, sequence);
    put64(p + 16, crc);
}
/* A nonblank but malformed commit page is ambiguous, never permission to roll back. */
static int decode(qt_store *s, unsigned sector, qt_snapshot *v, uint64_t *sequence) {
    uint8_t expected[QT_PAGE];
    uint8_t *p = s->scratch;
    if (read_at(s, sector * QT_SECTOR, p, QT_SECTOR)) {
        return -1;
    }
    if (blank(p + QT_BODY, QT_PAGE)) {
        return 0;
    }
    uint64_t crc = get64(p + 16);
    *sequence = get64(p + 8);
    marker(expected, *sequence, crc);
    if (memcmp(p, "QTS2", 4) || !*sequence || memcmp(expected, p + QT_BODY, QT_PAGE)) {
        return fail(s);
    }
    memset(p + 16, 0, 8);
    if (crc != qt_crc(p, QT_BODY) || p[192] != 1 || get64(p + 224) > SC_MAX_RECORD ||
        get64(p + 208) > UINT32_MAX) {
        return fail(s);
    }
    memset(v, 0, sizeof *v);
    memcpy(v->secret, p + 32, 64);
    memcpy(v->public_key, p + 96, 32);
    memcpy(v->server_key, p + 128, 32);
    memcpy(v->serial, p + 160, 32);
    v->provisioned = 1;
    v->generation = get64(p + 200);
    v->nonce_domain = (uint32_t)get64(p + 208);
    v->nonce_end = get64(p + 216);
    v->record_len = (uint32_t)get64(p + 224);
    memcpy(v->record, p + 232, v->record_len);
    if ((!v->generation) != (!v->record_len)) {
        return fail(s);
    }
    return 1;
}
int qt_store_reset(qt_store *s) {
    uint8_t intent[QT_PAGE];
    memset(intent, 0, sizeof intent);
    /* Reuse an existing marker after power loss. Do not reprogram its page. */
    if (read_at(s, QT_RESET_SECTOR * QT_SECTOR, s->scratch, QT_SECTOR)) {
        return -1;
    }
    if (blank(s->scratch, QT_SECTOR)) {
        s->programmed_bytes += QT_PAGE;
        if (s->flash.program(s->flash.user, QT_RESET_SECTOR * QT_SECTOR, intent, QT_PAGE) ||
            read_at(s, QT_RESET_SECTOR * QT_SECTOR, s->scratch, QT_PAGE) ||
            memcmp(s->scratch, intent, QT_PAGE)) {
            return fail(s);
        }
    }
    for (unsigned i = 0; i < QT_NVM_SECTORS; ++i) {
        if (erase(s, i)) {
            return -1;
        }
    }
    wipe(&s->state, sizeof s->state);
    wipe(s->scratch, sizeof s->scratch);
    s->active = -1;
    s->sequence = 0;
    s->fault = 0;
    return 0;
}
int qt_store_open(qt_store *s, const qt_flash *flash) {
    qt_snapshot candidate = {0};
    memset(s, 0, sizeof *s);
    s->flash = *flash;
    s->active = -1;
    if (read_at(s, QT_RESET_SECTOR * QT_SECTOR, s->scratch, QT_SECTOR)) {
        return -1;
    }
    if (!blank(s->scratch, QT_SECTOR)) {
        return qt_store_reset(s);
    }
    uint64_t sequences[QT_SNAPSHOT_SECTORS] = {0};
    for (unsigned i = 0; i < QT_SNAPSHOT_SECTORS; ++i) {
        uint64_t seq = 0;
        int rc = decode(s, i, &candidate, &seq);
        if (rc < 0) {
            wipe(&candidate, sizeof candidate);
            return -1;
        }
        if (rc) {
            for (unsigned j = 0; j < i; ++j) {
                if (seq == sequences[j]) {
                    wipe(&candidate, sizeof candidate);
                    return fail(s);
                }
            }
            sequences[i] = seq;
        }
        if (rc && seq > s->sequence) {
            s->sequence = seq;
            s->active = (int)i;
            s->state = candidate;
        }
    }
    wipe(&candidate, sizeof candidate);
    wipe(s->scratch, sizeof s->scratch);
    return 0;
}
int qt_store_save(qt_store *s, const qt_snapshot *next) {
    uint8_t page[QT_PAGE], verify[QT_PAGE];
    if (s->fault || !next->provisioned || next->record_len > SC_MAX_RECORD ||
        s->sequence == UINT64_MAX) {
        return fail(s);
    }
    unsigned dest = s->active < 0 ? 0u : ((unsigned)s->active + 1u) % QT_SNAPSHOT_SECTORS;
    if (erase(s, dest)) {
        return -1;
    }
    encode(s->scratch, next, s->sequence + 1);
    marker(page, s->sequence + 1, get64(s->scratch + 16));
    for (uint32_t at = 0; at < QT_BODY; at += QT_PAGE) {
        s->programmed_bytes += QT_PAGE;
        if (s->flash.program(s->flash.user, dest * QT_SECTOR + at, s->scratch + at, QT_PAGE) ||
            read_at(s, dest * QT_SECTOR + at, verify, QT_PAGE) ||
            memcmp(verify, s->scratch + at, QT_PAGE)) {
            wipe(verify, sizeof verify);
            return fail(s);
        }
        wipe(verify, sizeof verify);
    }
    s->programmed_bytes += QT_PAGE;
    if (s->flash.program(s->flash.user, dest * QT_SECTOR + QT_BODY, page, QT_PAGE) ||
        read_at(s, dest * QT_SECTOR + QT_BODY, verify, QT_PAGE) || memcmp(verify, page, QT_PAGE)) {
        return fail(s);
    }
    s->state = *next;
    s->sequence++;
    s->active = (int)dest;
    wipe(s->scratch, sizeof s->scratch);
    return 0;
}
sc_status qt_store_load(void *user, uint8_t *out, size_t cap, size_t *n, uint64_t *generation) {
    qt_store *s = user;
    if (s->fault) {
        return SC_ERR_STORAGE;
    }
    if (!s->state.record_len) {
        return SC_NOT_FOUND;
    }
    if (cap < s->state.record_len) {
        return SC_ERR_BOUNDS;
    }
    memcpy(out, s->state.record, s->state.record_len);
    *n = s->state.record_len;
    *generation = s->state.generation;
    return SC_OK;
}
sc_status qt_store_commit(void *user, uint64_t gen, const uint8_t *record, size_t n) {
    qt_store *s = user;
    if (s->fault) {
        return SC_ERR_STORAGE;
    }
    if (gen != s->state.generation) {
        return SC_ERR_CONFLICT;
    }
    if (n > SC_MAX_RECORD || !n || gen == UINT64_MAX) {
        return SC_ERR_BOUNDS;
    }
    qt_snapshot next = s->state;
    memcpy(next.record, record, n);
    next.record_len = (uint32_t)n;
    next.generation++;
    int rc = qt_store_save(s, &next);
    wipe(&next, sizeof next);
    if (rc) {
        return SC_ERR_STORAGE;
    }
    s->commits++;
    return SC_OK;
}
sc_status qt_store_reserve(void *user, uint32_t domain, uint64_t count, uint64_t *first) {
    qt_store *s = user;
    if (s->fault) {
        return SC_ERR_STORAGE;
    }
    if (!count || count > UINT64_MAX - s->state.nonce_end ||
        (s->state.nonce_end && s->state.nonce_domain != domain)) {
        return SC_ERR_STORAGE;
    }
    qt_snapshot next = s->state;
    *first = next.nonce_end;
    next.nonce_domain = domain;
    next.nonce_end += count;
    int rc = qt_store_save(s, &next);
    wipe(&next, sizeof next);
    if (rc) {
        return SC_ERR_STORAGE;
    }
    s->reservations++;
    return SC_OK;
}
