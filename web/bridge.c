/* Demo-only platform: each Wasm instance owns one endpoint and a simulated
 * durable store. Reboot resets only ctx. Refresh destroys the entire instance.
 * No real keystore, filesystem durability, or MCU memory claim is made here. */
#include "core/sc.h"
#include "providers/sodium/sc_sodium.h"
#ifdef SC_ENABLE_TESTING
#include "core/sc_test.h"
#endif
#include <sodium.h>
#include <stdio.h>
#include <string.h>
#include <inttypes.h>
#include <emscripten/emscripten.h>
#define API EMSCRIPTEN_KEEPALIVE
static sc_context ctx;
static sc_config config;
static struct {
    sc_sodium_keystore keys; /* First member: provider and keystore share user. */
    uint8_t pk[32], sk[64], token[32], record[SC_MAX_RECORD];
    size_t length;
    uint64_t generation, next[3];
    int ready, key_ready;
#ifdef SC_ENABLE_TESTING
    int fail_commit, fail_reserve;
#endif
} store;
static uint8_t input[4096], frame[SC_MAX_FRAME];
static size_t frame_length;
static char json[4096];
static sc_status lookup(void *u, sc_key_handle h, const uint8_t **pk, const uint8_t **sk) {
    (void)u; if(h!=1 || !store.ready) return SC_ERR_ARGUMENT;
    *pk=store.pk; *sk=store.sk; return SC_OK;
}
static sc_status entropy(void *u,uint8_t *out,size_t n) { (void)u;randombytes_buf(out,n);return SC_OK; }
static sc_status token(void *u,uint8_t out[32]) { (void)u;memcpy(out,store.token,32);return SC_OK; }
static sc_status load(void *u,uint8_t *out,size_t cap,size_t *n,uint64_t *g) {
    (void)u;if(!store.generation)return SC_NOT_FOUND;
    if(cap<store.length)return SC_ERR_BOUNDS;
    memcpy(out,store.record,store.length);*n=store.length;*g=store.generation;return SC_OK;
}
static sc_status commit(void *u,uint64_t g,const uint8_t *p,size_t n) {
    (void)u;
#ifdef SC_ENABLE_TESTING
    if(store.fail_commit){store.fail_commit--;return SC_ERR_STORAGE;}
#endif
    if(g!=store.generation || g==UINT64_MAX || n>sizeof store.record)return SC_ERR_STORAGE;
    memcpy(store.record,p,n);store.length=n;store.generation++;return SC_OK;
}
static sc_status reserve(void *u,uint32_t d,uint64_t n,uint64_t *first) {
    (void)u;
#ifdef SC_ENABLE_TESTING
    if(store.fail_reserve){store.fail_reserve--;return SC_ERR_STORAGE;}
#endif
    if(d<1 || d>2 || n>UINT64_MAX-store.next[d])return SC_ERR_EXHAUSTED;
    *first=store.next[d];store.next[d]+=n;return SC_OK;
}
API int scw_reboot(void) {
    sc_provider p={0};
    if(!store.ready)return SC_ERR_ARGUMENT;
    p.user=&store;p.sign=sc_sodium_sign;p.verify=sc_sodium_verify;p.public_key=sc_sodium_public;p.seal=sc_sodium_ed_seal;p.open=sc_sodium_ed_open;
    p.random=entropy;p.enrollment_secret=token;p.load=load;p.commit=commit;p.reserve=reserve;
    sodium_memzero(&ctx,sizeof ctx);frame_length=0;
    return sc_init(&ctx,&config,&p);
}
/* Key generation is a distinct demo action; private bytes stay in this instance. */
API int scw_generate(void) {
    if(store.key_ready || store.ready)return SC_ERR_ARGUMENT;
    if(sodium_init()<0)return SC_ERR_RANDOM;
    if(crypto_sign_keypair(store.pk,store.sk)!=0)return SC_ERR_CRYPTO;
    store.key_ready=1;
    return SC_OK;
}
/* Input: authorization[32], pinned server public key[32], NUL serial at 64.
 * Fresh keys only in production. Test seeds are a separate build/export. */
static int initialize(int role,const uint8_t *seed) {
    if(store.ready || (role!=SC_DEVICE && role!=SC_SERVER))return SC_ERR_ARGUMENT;
    if(!memchr(input+64,0,SC_MAX_SERIAL+1))return SC_ERR_ARGUMENT;
    if(sodium_init()<0)return SC_ERR_RANDOM;
    if(seed){if(store.key_ready)return SC_ERR_ARGUMENT;crypto_sign_seed_keypair(store.pk,store.sk,seed);store.key_ready=1;}
    else if(!store.key_ready){int status=scw_generate();if(status!=SC_OK)return status;}
    memcpy(store.token,input,32);memset(&config,0,sizeof config);
    config.role=(sc_role)role;config.identity_key=1;memcpy(config.peer_public_key,input+32,32);
    memcpy(config.serial,input+64,SC_MAX_SERIAL+1);
    store.keys.user=&store;store.keys.lookup=lookup;store.ready=1;
    sodium_memzero(input,sizeof input);
    return scw_reboot();
}
API int scw_init(int role){return initialize(role,NULL);}
API uint8_t *scw_input(void){return input;}
API const uint8_t *scw_public(void){return store.pk;}
API const uint8_t *scw_frame(void){return frame;}
API size_t scw_frame_length(void){return frame_length;}
API int scw_enrollment_enable(void){return sc_enrollment_enable(&ctx);}
API int scw_enrollment_begin(uint64_t now,uint64_t expires){return sc_enrollment_begin(&ctx,now,expires);}
API int scw_enrollment_approve(uint64_t now){return sc_enrollment_approve(&ctx,input,input+32,now);}
API int scw_enrollment_cancel(void){return sc_enrollment_cancel(&ctx);}
API int scw_receive_at(size_t n,uint64_t now){if(n>SC_MAX_FRAME)return SC_ERR_BOUNDS;return sc_receive_at(&ctx,input,n,now);}
API int scw_report(int32_t t){return sc_report_temperature(&ctx,t);}
API int scw_name(size_t n){
    if(n>SC_MAX_NAME || memchr(input,0,n))return SC_ERR_BOUNDS;
    input[n]=0;return sc_set_name(&ctx,(const char *)input);
}
API int scw_receive(size_t n){if(n>SC_MAX_FRAME)return SC_ERR_BOUNDS;return sc_receive(&ctx,input,n);}
API int scw_outbound(size_t budget){frame_length=0;return sc_outbound(&ctx,budget,frame,sizeof frame,&frame_length);}
API const char *scw_status(int status){return sc_status_string((sc_status)status);}
static void escape(char *out,const char *s) {
    while(*s){unsigned c=(unsigned char)*s++;if(c=='"'||c=='\\'){*out++='\\';*out++=(char)c;}
    else if(c<32){sprintf(out,"\\u%04x",c);out+=6;}else *out++=(char)c;}*out=0;
}
API const char *scw_state(void){
    sc_state s;char desired[6*SC_MAX_NAME+1],actual[6*SC_MAX_NAME+1],serial[6*SC_MAX_SERIAL+1],pk[65],peer[65];
    if(sc_inspect(&ctx,&s)!=SC_OK)return "null";
    escape(desired,s.desired_name);escape(actual,s.actual_name);escape(serial,s.serial);
    sodium_bin2hex(pk,sizeof pk,store.pk,32);sodium_bin2hex(peer,sizeof peer,s.peer_public_key,32);
    snprintf(json,sizeof json,"{\"role\":%u,\"serial\":\"%s\",\"desired_name\":\"%s\",\"actual_name\":\"%s\",\"temperature\":%" PRId32 ",\"has_temperature\":%u,\"registered\":%u,\"pending\":%u,\"apply_status\":%u,\"public_key\":\"%s\",\"peer_public_key\":\"%s\","
      "\"desired_revision\":\"%" PRIu64 "\",\"reported_revision\":\"%" PRIu64 "\",\"processed_desired_revision\":\"%" PRIu64 "\",\"applied_desired_revision\":\"%" PRIu64 "\",\"acked_reported_revision\":\"%" PRIu64 "\",\"storage_generation\":\"%" PRIu64 "\"}",
      (unsigned)s.role,serial,desired,actual,s.temperature_mC,s.has_temperature,s.registered,s.pending,s.apply_status,pk,peer,s.desired_revision,s.reported_revision,s.processed_desired_revision,s.applied_desired_revision,s.acked_reported_revision,s.storage_generation);
    {
        char challenge[65],candidate[65];size_t used=strlen(json)-1;
        sodium_bin2hex(challenge,sizeof challenge,s.challenge,32);sodium_bin2hex(candidate,sizeof candidate,s.candidate_key,32);
        snprintf(json+used,sizeof json-used,",\"enrollment_mode\":%u,\"challenge\":\"%s\",\"candidate_key\":\"%s\",\"candidate_revision\":\"%" PRIu64 "\",\"enrollment_expires\":\"%" PRIu64 "\"}",s.enrollment_mode,challenge,candidate,s.candidate_revision,s.enrollment_expires);
    }
    return json;
}
#ifdef SC_ENABLE_TESTING
API int scw_test_init(int role){uint8_t seed[32];memcpy(seed,input+128,32);int s=initialize(role,seed);sodium_memzero(seed,32);return s;}
API int scw_test_revision(uint64_t value){return sc_test_seed_revision(&ctx,value);}
API void scw_test_fail(int operation){if(operation==1)store.fail_commit++;if(operation==2)store.fail_reserve++;}
#endif
