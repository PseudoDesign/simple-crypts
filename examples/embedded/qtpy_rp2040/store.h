/** @file
 * @brief Private demo snapshot store; no public library interfaces are added.
 */
#ifndef QTPY_STORE_H
#define QTPY_STORE_H
#include "core/sc.h"
#include <stddef.h>
#include <stdint.h>

#define QT_SECTOR 4096u
#define QT_PAGE 256u
#define QT_BODY (QT_SECTOR - QT_PAGE)
#define QT_SNAPSHOT_SECTORS 32u
#define QT_RESET_SECTOR QT_SNAPSHOT_SECTORS
#define QT_NVM_SECTORS (QT_SNAPSHOT_SECTORS + 1u)
#define QT_NVM_BYTES (QT_NVM_SECTORS * QT_SECTOR)
#define QT_NVM_OFFSET (0x800000u - QT_NVM_BYTES)

/* Backend addresses are relative to the reserved partition, never chip addresses. */
typedef struct {
    void *user;
    int (*read)(void *, uint32_t, void *, size_t);
    int (*erase)(void *, uint32_t);
    int (*program)(void *, uint32_t, const void *, size_t);
} qt_flash;

typedef struct {
    uint8_t secret[64], public_key[32], server_key[32];
    char serial[33];
    uint8_t provisioned;
    uint32_t record_len, nonce_domain;
    uint64_t generation, nonce_end;
    uint8_t record[SC_MAX_RECORD];
} qt_snapshot;

typedef struct {
    qt_flash flash;
    qt_snapshot state;
    uint64_t sequence, commits, reservations, erase_attempts[QT_NVM_SECTORS], programmed_bytes;
    int active, fault;
    uint8_t scratch[QT_SECTOR];
} qt_store;

/* All failures latch fault; callers must stop protocol work until reboot/reset. */
int qt_store_open(qt_store *store, const qt_flash *flash);
int qt_store_save(qt_store *store, const qt_snapshot *next);
int qt_store_reset(qt_store *store);
sc_status qt_store_load(void *user, uint8_t *out, size_t cap, size_t *length, uint64_t *generation);
sc_status qt_store_commit(void *user, uint64_t generation, const uint8_t *record, size_t length);
sc_status qt_store_reserve(void *user, uint32_t domain, uint64_t count, uint64_t *first);
uint32_t qt_crc(const uint8_t *bytes, size_t length);
#endif
