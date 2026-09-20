/* Link-only resource harness: platform callbacks below are measurement stubs,
 * not production entropy, durable storage, provisioning, or a board startup. */
#include "core/sc.h"
#include "providers/sodium/sc_sodium.h"
#include <string.h>
static sc_context endpoint;
static uint8_t frame[SC_MAX_FRAME];
static uint8_t saved[SC_MAX_RECORD];
static size_t saved_length;
static uint64_t generation, reservation;
static uint8_t public_key[32] = {9}, private_key[32] = {1};
static volatile sc_status observed;
static sc_status lookup(void *u, sc_key_handle h, const uint8_t **pk, const uint8_t **sk) {
    (void)u; (void)h; *pk=public_key; *sk=private_key; return SC_OK;
}
static sc_status entropy(void *u, uint8_t *p, size_t n) {
    (void)u; (void)p; (void)n; return SC_ERR_RANDOM;
}
static sc_status secret(void *u, uint8_t p[32]) { (void)u; memset(p, 3, 32); return SC_OK; }
static sc_status load(void *u, uint8_t *p, size_t capacity, size_t *n, uint64_t *g) {
    (void)u; if (!generation) return SC_NOT_FOUND;
    if (saved_length>capacity) return SC_ERR_STORAGE;
    memcpy(p,saved,saved_length);*n=saved_length;*g=generation;return SC_OK;
}
static sc_status commit(void *u, uint64_t g, const uint8_t *p, size_t n) {
    (void)u;if(g!=generation || n>sizeof saved)return SC_ERR_STORAGE;
    memcpy(saved,p,n);saved_length=n;generation++;return SC_OK;
}
static sc_status reserve(void *u,uint32_t d,uint64_t n,uint64_t *first) {
    (void)u;(void)d;*first=reservation;reservation+=n;return SC_OK;
}
/* Volatile roots and actual calls retain both full public-key directions. */
void resource_probe(void) {
    static sc_sodium_keystore keys={0,lookup};
    sc_config config={0};sc_provider provider={0};size_t length=0;
    config.role=SC_DEVICE;config.identity_key=1;strcpy(config.serial,"RESOURCE-PROBE");
    config.peer_public_key[0]=9;
    provider.user=&keys;provider.public_key=sc_sodium_public;
    provider.seal=sc_sodium_seal;provider.open=sc_sodium_open;
    provider.random=entropy;provider.enrollment_secret=secret;
    provider.load=load;provider.commit=commit;provider.reserve=reserve;
    observed=sc_init(&endpoint,&config,&provider);
    observed=sc_consume_credits(&endpoint,25);
    observed=sc_outbound(&endpoint,sizeof frame,frame,sizeof frame,&length);
    observed=sc_receive(&endpoint,frame,length);
    for(;;) {}
}
