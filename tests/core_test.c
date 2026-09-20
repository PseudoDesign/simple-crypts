#include "core/sc.h"
#include "core/sc_test.h"
#include "schema/sc.pb.h"
#include "pb_decode.h"
#include "pb_encode.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

/* Deliberately NONCRYPTOGRAPHIC test provider. It lets parser/state tests
 * inject authenticated-but-malformed plaintext. Real crypto is exercised by
 * the libsodium adapter matrix and independent implementation vectors. Never
 * link these callbacks into a sample, library, or production provider. */
typedef struct {
    uint8_t record[SC_MAX_RECORD], key[32], token[32];
    size_t record_len;
    uint64_t generation, counters[3];
    int fail_commit, fail_reserve, fail_seal, fail_open, fail_secret;
    unsigned secret_calls, random_calls;
} memory_store;

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "check failed at %s:%d: %s\n", __FILE__, __LINE__, #x); exit(1); } } while (0)
#define OK(x) CHECK((x) == SC_OK)

static sc_status public_key(void *u, sc_key_handle h, uint8_t out[32]) {
    (void)h; memcpy(out, ((memory_store *)u)->key, 32); return SC_OK;
}
static sc_status seal(void *u, sc_key_handle h, const uint8_t peer[32],
    const uint8_t nonce[24], const uint8_t *p, size_t n, uint8_t *out, size_t cap) {
    (void)h; (void)peer; (void)nonce;
    if (((memory_store *)u)->fail_seal) return SC_ERR_CRYPTO;
    if (cap < n + 16) return SC_ERR_BOUNDS;
    memset(out, 0xa5, 16); memcpy(out + 16, p, n); return SC_OK;
}
static sc_status open_box(void *u, sc_key_handle h, const uint8_t peer[32],
    const uint8_t nonce[24], const uint8_t *p, size_t n, uint8_t *out, size_t cap) {
    size_t i;
    (void)h; (void)peer; (void)nonce;
    if (((memory_store *)u)->fail_open) return SC_ERR_CRYPTO;
    if (n < 16 || cap < n - 16) return SC_ERR_BOUNDS;
    for (i = 0; i < 16; ++i) if (p[i] != 0xa5) {
        /* Simulate a provider that wrote provisional data before failure. */
        memset(out, 0xcc, cap); return SC_ERR_AUTH;
    }
    memcpy(out, p + 16, n - 16); return SC_OK;
}
static sc_status random_bytes(void *u, uint8_t *out, size_t n) {
    (void)out; (void)n; ++((memory_store *)u)->random_calls; return SC_ERR_RANDOM;
}
static sc_status secret(void *u, uint8_t out[32]) {
    memory_store *m = u;
    ++m->secret_calls;
    if (m->fail_secret) return SC_ERR_ENROLLMENT;
    memcpy(out, m->token, 32); return SC_OK;
}
static sc_status load(void *u, uint8_t *out, size_t cap, size_t *n, uint64_t *g) {
    memory_store *m = u;
    if (!m->generation) return SC_NOT_FOUND;
    if (cap < m->record_len) return SC_ERR_BOUNDS;
    memcpy(out, m->record, m->record_len); *n = m->record_len; *g = m->generation;
    return SC_OK;
}
static sc_status commit(void *u, uint64_t expected, const uint8_t *p, size_t n) {
    memory_store *m = u;
    if (m->fail_commit) return SC_ERR_STORAGE;
    if (expected != m->generation) return SC_ERR_CONFLICT;
    if (n > sizeof m->record) return SC_ERR_BOUNDS;
    memcpy(m->record, p, n); m->record_len = n; ++m->generation; return SC_OK;
}
static sc_status reserve(void *u, uint32_t domain, uint64_t count, uint64_t *first) {
    memory_store *m = u;
    if (m->fail_reserve) return SC_ERR_STORAGE;
    if (domain > 2 || domain == 0) return SC_ERR_ARGUMENT;
    if (m->counters[domain] > UINT64_MAX - count) return SC_ERR_EXHAUSTED;
    *first = m->counters[domain]; m->counters[domain] += count; return SC_OK;
}
static sc_provider provider(memory_store *m) {
    sc_provider p = {m, public_key, seal, open_box, random_bytes, secret, load, commit, reserve, NULL, NULL};
    return p;
}
static void start(sc_context *ctx, memory_store *m, sc_role role, const uint8_t peer[32]) {
    sc_config cfg;
    sc_provider p = provider(m);
    memset(&cfg, 0, sizeof cfg); cfg.role = role; cfg.identity_key = 1;
    strcpy(cfg.serial, "SN-0001");
    if (peer) memcpy(cfg.peer_public_key, peer, 32);
    OK(sc_init(ctx, &cfg, &p));
}
static void pair(sc_context *d, memory_store *dm, sc_context *s, memory_store *sm) {
    memset(dm, 0, sizeof *dm); memset(sm, 0, sizeof *sm);
    memset(dm->key, 0x22, 32); memset(sm->key, 0x11, 32);
    memset(dm->token, 0x73, 32); memcpy(sm->token, dm->token, 32);
    start(d, dm, SC_DEVICE, sm->key); start(s, sm, SC_SERVER, NULL);
}
static size_t outbound(sc_context *ctx, uint8_t out[SC_MAX_FRAME]) {
    size_t n = 0;
    OK(sc_outbound(ctx, SC_MAX_FRAME, out, SC_MAX_FRAME, &n));
    CHECK(n > 78 && n <= SC_MAX_FRAME); return n;
}
static simplecrypts_Packet decode_packet(const uint8_t *frame, size_t n) {
    simplecrypts_Packet p = simplecrypts_Packet_init_zero;
    pb_istream_t input = pb_istream_from_buffer(frame + 78, n - 78);
    CHECK(pb_decode(&input, simplecrypts_Packet_fields, &p)); return p;
}
static size_t rewrite_packet(uint8_t frame[SC_MAX_FRAME], const simplecrypts_Packet *p) {
    pb_ostream_t output = pb_ostream_from_buffer(frame + 78, SC_MAX_FRAME - 78);
    CHECK(pb_encode(&output, simplecrypts_Packet_fields, p)); return 78 + output.bytes_written;
}
#include "schema/test_resources.h"
static void transfer(sc_context *from,sc_context *to){uint8_t f[512];size_t n=outbound(from,f);OK(sc_receive(to,f,n));}
static void enroll(sc_context *d,sc_context *s){transfer(d,s);transfer(s,d);CHECK(d->state.registered&&s->state.registered);}
static void credits(void){
 sc_context d,s;memory_store dm,sm;uint8_t f[512],old[512];size_t n,on;sc_state before;sc_group_state g;simplecrypts_Packet p;
 pair(&d,&dm,&s,&sm);CHECK(sc_consume_credits(&d,1)==SC_ERR_ENROLLMENT);enroll(&d,&s);
 OK(sc_set_credits_issued(&s,100));on=outbound(&s,old);OK(sc_receive(&d,old,on));
 OK(sc_consume_credits(&d,25));n=outbound(&d,f);OK(sc_receive(&s,f,n));CHECK(s.state.data.groups[0].values[1].u64==0);
 transfer(&s,&d);CHECK(!d.state.pending);OK(sc_receive(&d,old,on));transfer(&d,&s);CHECK(s.state.data.groups[0].values[1].u64==0);transfer(&s,&d);
 before=d.state;CHECK(sc_consume_credits(&d,76)==SC_ERR_CONFLICT);CHECK(!memcmp(&before,&d.state,sizeof before));CHECK(sc_consume_credits(&d,0)==SC_ERR_ARGUMENT);
 OK(sc_request_credit_status(&s));transfer(&s,&d);n=outbound(&d,f);
 start(&d,&dm,SC_DEVICE,sm.key);CHECK(d.state.data.groups[0].values[1].u64==25);transfer(&d,&s);CHECK(s.state.data.groups[0].values[1].u64==25);transfer(&s,&d);
 CHECK(sc_set_credits_issued(&s,99)==SC_ERR_CONFLICT);CHECK(sc_set_credits_issued(&d,200)==SC_ERR_ROLE);
 OK(sc_request_credit_status(&s));on=outbound(&s,old);OK(sc_request_credit_status(&s));transfer(&s,&d);OK(sc_receive(&d,old,on));transfer(&d,&s);transfer(&s,&d);
 dm.fail_commit=1;before=d.state;CHECK(sc_consume_credits(&d,1)==SC_ERR_STORAGE);CHECK(!memcmp(&before,&d.state,sizeof before));dm.fail_commit=0;
 OK(sc_set_credits_issued(&s,UINT64_MAX));transfer(&s,&d);transfer(&d,&s);transfer(&s,&d);OK(sc_consume_credits(&d,UINT64_MAX-25));CHECK(sc_consume_credits(&d,1)==SC_ERR_EXHAUSTED);
 OK(sc_request_credit_status(&s));on=outbound(&s,old);n=0;CHECK(sc_outbound(&s,1,f,sizeof f,&n)==SC_ERR_BOUNDS&&n==0);
 before=d.state;p=decode_packet(old,on);p.schema_hash.bytes[0]^=1;n=rewrite_packet(f,&p);memcpy(f,old,78);CHECK(sc_receive(&d,f,n)==SC_ERR_PROTOCOL);CHECK(!memcmp(&before,&d.state,sizeof before));
 memcpy(f,old,on);f[2]=2;CHECK(sc_receive(&d,f,on)==SC_ERR_PROTOCOL);
 OK(sc_data_inspect(&d,1,&g));CHECK(g.values[1].u64==UINT64_MAX);
 puts("PASS credits: ownership, frozen responses, receipts, restart, bounds, failure atomicity, exact uint64, schema/version rejection");
}
static void generic(void){
 sc_context d,s;memory_store dm,sm;sc_config dc,sc;sc_provider dp,sp;sc_data_update u[3];sc_state before;
 pair(&d,&dm,&s,&sm);dc=d.config;sc=s.config;dc.data_schema=&sc_example_schema;sc.data_schema=&sc_example_schema;
 dm.generation=0;sm.generation=0;dp=provider(&dm);sp=provider(&sm);OK(sc_init(&d,&dc,&dp));OK(sc_init(&s,&sc,&sp));enroll(&d,&s);
 memset(u,0,sizeof u);u[0].field_id=2;u[0].value.i64=INT64_MIN;u[1].field_id=3;u[1].value.boolean=1;u[2].field_id=4;u[2].value.length=5;memcpy(u[2].value.bytes,"hello",5);
 OK(sc_data_update_group(&s,7,u,3));transfer(&s,&d);CHECK(d.state.data.groups[0].values[1].i64==INT64_MIN);CHECK(d.state.data.groups[0].values[2].boolean==1);transfer(&d,&s);transfer(&s,&d);
 u[0].field_id=5;u[0].value.length=3;memcpy(u[0].value.bytes,"\0\xffx",3);OK(sc_data_update_group(&d,7,u,1));CHECK(!d.state.pending);OK(sc_data_request(&s,7));transfer(&s,&d);transfer(&d,&s);CHECK(s.state.data.groups[0].values[4].length==3);transfer(&s,&d);
 before=s.state;u[0].field_id=4;u[0].value.length=1;u[0].value.bytes[0]=0xff;CHECK(sc_data_update_group(&s,7,u,1)==SC_ERR_UTF8);CHECK(!memcmp(&before,&s.state,sizeof before));
 u[0].value.length=17;CHECK(sc_data_update_group(&s,7,u,1)==SC_ERR_BOUNDS);u[0].field_id=1;CHECK(sc_data_update_group(&s,7,u,1)==SC_ERR_ROLE);
 OK(sc_init(&d,&dc,&dp));CHECK(d.state.data.groups[0].values[4].length==3);
 OK(sc_data_request(&s,7));OK(sc_data_request(&s,8));
 {uint8_t a[512],b[512];size_t an=outbound(&s,a),bn=outbound(&s,b);simplecrypts_Packet ap=decode_packet(a,an),bp=decode_packet(b,bn);CHECK(ap.group_id!=bp.group_id);OK(sc_receive(&d,a,an));OK(sc_receive(&d,b,bn));transfer(&d,&s);transfer(&d,&s);transfer(&s,&d);transfer(&s,&d);}
 dc.data_schema=NULL;CHECK(sc_init(&d,&dc,&dp)==SC_ERR_STORAGE);
 puts("PASS generic resources: alternate schema, int64, Boolean, UTF-8, bytes, atomic validation, durable schema binding");
}
static void exhaustion(void){
 sc_context d,s;memory_store dm,sm;uint8_t f[512];size_t n;sc_state before;
 pair(&d,&dm,&s,&sm);OK(sc_test_seed_revision(&s,UINT64_MAX));enroll(&d,&s);before=s.state;
 CHECK(sc_request_credit_status(&s)==SC_ERR_EXHAUSTED);CHECK(!memcmp(&before,&s.state,sizeof before));
 pair(&d,&dm,&s,&sm);OK(sc_test_seed_revision(&d,UINT64_MAX));enroll(&d,&s);OK(sc_set_credits_issued(&s,10));transfer(&s,&d);before=d.state;CHECK(sc_consume_credits(&d,1)==SC_ERR_EXHAUSTED);CHECK(!memcmp(&before,&d.state,sizeof before));
 d.nonce_next=d.nonce_limit;dm.fail_reserve=1;n=0;CHECK(sc_outbound(&d,512,f,512,&n)==SC_ERR_STORAGE&&n==0);dm.fail_reserve=0;transfer(&d,&s);transfer(&s,&d);
 puts("PASS revision exhaustion and failed nonce reservations preserve state");
}
/* A repeated response must not commit inactive value members or padding. */
static void semantic_replay(void) {
    sc_context d, s;
    memory_store dm, sm;
    uint8_t frame[SC_MAX_FRAME];
    size_t length;
    uint64_t generation;
    pair(&d, &dm, &s, &sm);
    enroll(&d, &s);
    OK(sc_set_credits_issued(&s, 10));
    transfer(&s, &d);
    length = outbound(&d, frame);
    OK(sc_receive(&s, frame, length));
    generation = sm.generation;
    /* i64 is inactive for credits' uint64 fields. */
    s.state.data.groups[0].values[0].i64 = 42;
    s.state.data.groups[0].snapshot[0].bytes[0] = 7;
    sm.fail_commit = 1;
    OK(sc_receive(&s, frame, length));
    CHECK(sm.generation == generation);
    sm.fail_commit = 0;
    generation = dm.generation;
    dm.fail_commit = 1;
    length = outbound(&d, frame);
    CHECK(length > 0 && dm.generation == generation);
    dm.fail_commit = 0;
    transfer(&s, &d);
    puts("PASS semantic replay avoids redundant durable writes");
}
int main(void){semantic_replay();credits();generic();exhaustion();return 0;}
