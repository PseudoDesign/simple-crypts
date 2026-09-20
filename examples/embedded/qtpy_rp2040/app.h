/** @file
 * @brief Private QT Py application commands; not Simple Crypts protocol messages.
 */
#ifndef QT_APP_H
#define QT_APP_H
#include "store.h"
#include "providers/sodium/sc_sodium.h"
#define QT_MESSAGE_MAX 1024u
#define QT_HELLO 1u
#define QT_START 2u
#define QT_SETUP 3u
#define QT_RECEIVE 4u
#define QT_OUTBOUND 5u
#define QT_CONSUME 6u
#define QT_RESET 7u
#define QT_REBOOT 8u

typedef struct {
    qt_store store;
    uint32_t stack_high_water, flash_jedec;
    sc_context core;
    sc_sodium_keystore keys;
    char serial[33];
    int crypto_ready, ready, reboot;
} qt_app;
int qt_app_open(qt_app *app, const qt_flash *flash, const char *serial);
int qt_app_command(qt_app *app, unsigned command, const uint8_t *input, size_t length,
                   uint8_t *output, size_t capacity, size_t *output_length);
size_t qt_rpc(qt_app *app, uint8_t *input, size_t length, uint8_t *out, size_t capacity);
size_t qt_cobs_encode(const uint8_t *src, size_t n, uint8_t *dst, size_t cap);
size_t qt_cobs_decode(const uint8_t *src, size_t n, uint8_t *dst, size_t cap);
#endif
