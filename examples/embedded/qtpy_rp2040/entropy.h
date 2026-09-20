/** @file
 * @brief Demo-only, single-use startup randomness. Never used by the wire protocol.
 */
#ifndef QT_ENTROPY_H
#define QT_ENTROPY_H
#include <stddef.h>
#include <stdint.h>
#include <sodium.h>
extern randombytes_implementation qtpy_random;
int qt_crypto_start(const uint8_t *bytes, size_t length);
/* Platform hook must not return; production resets the MCU. */
void qt_entropy_fault(void);
#endif
