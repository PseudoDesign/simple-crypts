/** @file
 * @brief Portable libsodium cryptographic provider.
 */
#ifndef SIMPLECRYPTS_SODIUM_H
#define SIMPLECRYPTS_SODIUM_H
#include "core/sc.h"
/** @ingroup providers
 * @brief Software-key lookup boundary used only inside the provider; never expose secret pointers
 * to application relays. */
typedef struct {
    /** Borrowed provider-specific state; must outlive the context. */
    void *user;
    /** @ingroup providers
     * @brief Borrow a public/private key pair for an operation.
     * @param user Borrowed keystore-specific state.
     * @param key Provider-local identity handle.
     * @param public_key Non-null destination for a borrowed 32-byte public key pointer.
     * @param private_key Non-null destination for a borrowed secret key pointer: 32 bytes
     * for raw X25519 operations or 64 bytes for Ed25519 operations.
     * @return SC_OK only with valid key pointers, or a negative sc_status.
     * @details Key storage must remain valid through the calling crypto operation.
     * The application initializes libsodium before using this provider.
     */
    sc_status (*lookup)(void *user, sc_key_handle key, const uint8_t **public_key,
                        const uint8_t **private_key);
} sc_sodium_keystore;
/**
 * @brief Copy the public key selected by a provider handle.
 * @ingroup providers
 * @details The keystore and returned key pointers must remain valid for the duration of the call.
 * @param user Keystore pointer; unused by sc_sodium_verify().
 * @param handle Provider-local identity key handle.
 * @param out Non-null 32-byte public-key destination.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_sodium_public(void *user, sc_key_handle handle, uint8_t out[32]);
/**
 * @brief Encrypt and authenticate with raw X25519 box keys.
 * @ingroup providers
 * @details Requires 32-byte X25519 keys from lookup. Caller supplies a unique 24-byte nonce. The
 * ciphertext includes a 16-byte tag; capacity must be at least length + 16. No random calls occur.
 * @param user Keystore pointer; unused by sc_sodium_verify().
 * @param handle Provider-local identity key handle.
 * @param peer Non-null 32-byte peer public key in the format required by this function.
 * @param nonce Non-null 24-byte nonce; must be unique for encryption under this key pair.
 * @param plain Non-null plaintext buffer.
 * @param length Input byte count.
 * @param cipher Non-null ciphertext buffer including authentication tag.
 * @param capacity Writable buffer capacity, in bytes.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_sodium_seal(void *user, sc_key_handle handle, const uint8_t peer[32],
                         const uint8_t nonce[24], const uint8_t *plain, size_t length,
                         uint8_t *cipher, size_t capacity);
/**
 * @brief Authenticate and decrypt with raw X25519 box keys.
 * @ingroup providers
 * @details Requires 32-byte X25519 keys from lookup. Input includes a 16-byte tag; length must be
 * at least 16 and output capacity at least length - 16. Discard output on failure.
 * @param user Keystore pointer; unused by sc_sodium_verify().
 * @param handle Provider-local identity key handle.
 * @param peer Non-null 32-byte peer public key in the format required by this function.
 * @param nonce Non-null 24-byte nonce; must be unique for encryption under this key pair.
 * @param cipher Non-null ciphertext buffer including authentication tag.
 * @param length Input byte count.
 * @param plain Non-null plaintext buffer.
 * @param capacity Writable buffer capacity, in bytes.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_sodium_open(void *user, sc_key_handle handle, const uint8_t peer[32],
                         const uint8_t nonce[24], const uint8_t *cipher, size_t length,
                         uint8_t *plain, size_t capacity);
/**
 * @brief Encrypt using Ed25519 identities converted to X25519.
 * @ingroup providers
 * @details Lookup must return a 32-byte Ed25519 public key and 64-byte libsodium Ed25519 secret
 * key. Never pass raw X25519 keys. Nonce uniqueness is the caller's responsibility; capacity must
 * be at least length + 16. Converted secret material is wiped.
 * @param user Keystore pointer; unused by sc_sodium_verify().
 * @param handle Provider-local identity key handle.
 * @param peer Non-null 32-byte peer public key in the format required by this function.
 * @param nonce Non-null 24-byte nonce; must be unique for encryption under this key pair.
 * @param plain Non-null plaintext buffer.
 * @param length Input byte count.
 * @param cipher Non-null ciphertext buffer including authentication tag.
 * @param capacity Writable buffer capacity, in bytes.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_sodium_ed_seal(void *user, sc_key_handle handle, const uint8_t peer[32],
                            const uint8_t nonce[24], const uint8_t *plain, size_t length,
                            uint8_t *cipher, size_t capacity);
/**
 * @brief Decrypt using Ed25519 identities converted to X25519.
 * @ingroup providers
 * @details Lookup must return a 32-byte Ed25519 public key and 64-byte libsodium Ed25519 secret
 * key. Input contains a 16-byte tag; output capacity must be at least length - 16. Discard output
 * on failure. Converted secret material is wiped.
 * @param user Keystore pointer; unused by sc_sodium_verify().
 * @param handle Provider-local identity key handle.
 * @param peer Non-null 32-byte peer public key in the format required by this function.
 * @param nonce Non-null 24-byte nonce; must be unique for encryption under this key pair.
 * @param cipher Non-null ciphertext buffer including authentication tag.
 * @param length Input byte count.
 * @param plain Non-null plaintext buffer.
 * @param capacity Writable buffer capacity, in bytes.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_sodium_ed_open(void *user, sc_key_handle handle, const uint8_t peer[32],
                            const uint8_t nonce[24], const uint8_t *cipher, size_t length,
                            uint8_t *plain, size_t capacity);
/**
 * @brief Create a detached Ed25519 signature.
 * @ingroup providers
 * @details Lookup must return a 64-byte libsodium Ed25519 secret key. All pointers must be valid;
 * no random calls occur.
 * @param user Keystore pointer; unused by sc_sodium_verify().
 * @param handle Provider-local identity key handle.
 * @param message Non-null message buffer borrowed for this call.
 * @param length Input byte count.
 * @param signature Non-null 64-byte detached signature buffer.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_sodium_sign(void *user, sc_key_handle handle, const uint8_t *message, size_t length,
                         uint8_t signature[64]);
/**
 * @brief Verify a detached Ed25519 signature.
 * @ingroup providers
 * @details All message, key and signature pointers must be valid. The user pointer is ignored. No
 * random calls occur.
 * @param user Keystore pointer; unused by sc_sodium_verify().
 * @param key Non-null 32-byte Ed25519 verification key.
 * @param message Non-null message buffer borrowed for this call.
 * @param length Input byte count.
 * @param signature Non-null 64-byte detached signature buffer.
 * @return SC_OK on success; otherwise a sc_status error. Provider failures propagate.
 */
sc_status sc_sodium_verify(void *user, const uint8_t key[32], const uint8_t *message, size_t length,
                           const uint8_t signature[64]);
#endif
