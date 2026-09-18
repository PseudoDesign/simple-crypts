#include "sc_sodium.h"
#include <sodium.h>
#include <string.h>
static sc_status lookup(void *user, sc_key_handle handle, const uint8_t **pk, const uint8_t **sk) {
    sc_sodium_keystore *store = user;
    if (!store || !store->lookup) return SC_ERR_ARGUMENT;
    return store->lookup(store->user, handle, pk, sk);
}
sc_status sc_sodium_public(void *user, sc_key_handle handle, uint8_t out[32]) {
    const uint8_t *pk, *sk; sc_status status;
    if (!out) return SC_ERR_ARGUMENT;
    status = lookup(user, handle, &pk, &sk);
    if (status != SC_OK) return status;
    memcpy(out, pk, 32); return SC_OK;
}
sc_status sc_sodium_seal(void *user, sc_key_handle handle, const uint8_t peer[32],
                        const uint8_t nonce[24], const uint8_t *plain,
                        size_t length, uint8_t *cipher, size_t capacity) {
    const uint8_t *pk, *sk; sc_status status;
    if (!peer || !nonce || !plain || !cipher) return SC_ERR_ARGUMENT;
    if (length > SIZE_MAX - 16 || capacity < length + 16) return SC_ERR_BOUNDS;
    status = lookup(user, handle, &pk, &sk); if (status != SC_OK) return status;
    return crypto_box_easy(cipher, plain, (unsigned long long)length, nonce, peer, sk) ? SC_ERR_CRYPTO : SC_OK;
}
sc_status sc_sodium_open(void *user, sc_key_handle handle, const uint8_t peer[32],
                        const uint8_t nonce[24], const uint8_t *cipher,
                        size_t length, uint8_t *plain, size_t capacity) {
    const uint8_t *pk, *sk; sc_status status;
    if (!peer || !nonce || !cipher || !plain) return SC_ERR_ARGUMENT;
    if (length < 16 || capacity < length - 16) return SC_ERR_BOUNDS;
    status = lookup(user, handle, &pk, &sk); if (status != SC_OK) return status;
    return crypto_box_open_easy(plain, cipher, (unsigned long long)length, nonce, peer, sk) ? SC_ERR_AUTH : SC_OK;
}
