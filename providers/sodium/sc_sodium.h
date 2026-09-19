#ifndef SIMPLECRYPTS_SODIUM_H
#define SIMPLECRYPTS_SODIUM_H
#include "core/sc.h"
/* Portable libsodium reference provider. The lookup callback is an INTERNAL
 * software-keystore boundary, never exposed by language SDKs. Hardware-backed
 * providers implement sc_provider directly rather than exporting private keys.
 * The caller initializes the selected libsodium backend once; these operations
 * perform no RNG calls and are suitable for preprovisioned identity keys.
 */
typedef struct {
    void *user;
    sc_status (*lookup)(void *, sc_key_handle, const uint8_t **public_key,
                       const uint8_t **private_key);
} sc_sodium_keystore;
sc_status sc_sodium_public(void *, sc_key_handle, uint8_t out[32]);
sc_status sc_sodium_seal(void *, sc_key_handle, const uint8_t peer[32],
                        const uint8_t nonce[24], const uint8_t *plain,
                        size_t length, uint8_t *cipher, size_t capacity);
sc_status sc_sodium_open(void *, sc_key_handle, const uint8_t peer[32],
                        const uint8_t nonce[24], const uint8_t *cipher,
                        size_t length, uint8_t *plain, size_t capacity);
/* These functions expect a 32-byte Ed25519 public key and a 64-byte libsodium
 * Ed25519 secret key from lookup. Never pass a raw X25519 key to these APIs. */
sc_status sc_sodium_ed_seal(void *,sc_key_handle,const uint8_t[32],const uint8_t[24],const uint8_t *,size_t,uint8_t *,size_t);
sc_status sc_sodium_ed_open(void *,sc_key_handle,const uint8_t[32],const uint8_t[24],const uint8_t *,size_t,uint8_t *,size_t);
sc_status sc_sodium_sign(void *,sc_key_handle,const uint8_t *,size_t,uint8_t[64]);
sc_status sc_sodium_verify(void *,const uint8_t[32],const uint8_t *,size_t,const uint8_t[64]);
#endif
