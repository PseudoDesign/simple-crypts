#ifndef SIMPLECRYPTS_HOST_H
#define SIMPLECRYPTS_HOST_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Host convenience API. Owns its memory, software keys and an exclusively
 * locked durable store. The embedded API in core/sc.h owns no heap memory.
 * A handle is single-threaded and represents one role and one device peer.
 * Private keys are never returned. Close every successful initialization.
 */
typedef struct sc_host sc_host;
/* role: 1=device, 2=server. secret and optional provisioned_seed are 32
 * bytes. server_public_key is required on a device and is not secret.
 * provisioned_seed is a trusted provisioning input; test fixtures use fixed
 * seeds, real installations must provide independently generated secrets.
 * Existing stores are resumed and checked against the supplied identity.
 */
int sc_host_initialize(int role, const char *storage, const char *serial,
                       const uint8_t *secret, const uint8_t *provisioned_seed,
                       const uint8_t *server_public_key, int random_unavailable,
                       sc_host **out);
void sc_host_close(sc_host *host);
int sc_host_name(sc_host *host, const char *name);
int sc_host_report(sc_host *host, int32_t temperature_mC);
int sc_host_receive(sc_host *host, const uint8_t *frame, size_t size);
int sc_host_outbound(sc_host *host, size_t budget, uint8_t *frame,
                     size_t capacity, size_t *size);
/* JSON diagnostics are a host API convenience, never the protocol encoding.
 * Counters are decimal strings. Returns buffer error without truncation. */
int sc_host_inspect(sc_host *host, char *json, size_t capacity);
const char *sc_host_status(int status);
/* Deterministic fault injection for tests. operation: storage/random/crypto.
 * A positive count fails that many subsequent operations. */
int sc_host_fail(sc_host *host, const char *operation, unsigned count);
/* Explicit fixture-only helpers. Not used by the protocol or firmware. */
int sc_host_fixture_public(const uint8_t seed[32], uint8_t public_key[32]);
int sc_host_fixture_revision(sc_host *host, uint64_t revision);
#ifdef __cplusplus
}
#endif
#endif
