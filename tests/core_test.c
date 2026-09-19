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
static void unchanged(const sc_context *ctx, const sc_state *before) {
    sc_state after;
    OK(sc_inspect(ctx, &after)); CHECK(memcmp(&after, before, sizeof after) == 0);
}

static void synchronization(void) {
    sc_context d, s, reboot;
    memory_store dm, sm;
    uint8_t old[512], frame[512], nonce[24];
    size_t old_n, n;
    uint64_t generation;
    pair(&d, &dm, &s, &sm);
    CHECK(!d.state.pending && !s.state.pending);
    OK(sc_set_name(&s, "Freezer \xe2\x98\x83"));
    CHECK(s.state.pending);
    CHECK(sc_outbound(&s, 512, frame, 512, &n) == SC_NO_OUTPUT);
    OK(sc_report_temperature(&d, -1000)); old_n = outbound(&d, old);
    OK(sc_report_temperature(&d, -18250)); n = outbound(&d, frame);
    OK(sc_receive(&s, frame, n));
    CHECK(s.state.registered && s.state.reported_revision == 2 && s.state.temperature_mC == -18250);
    generation = sm.generation;
    sm.fail_secret = 1;
    OK(sc_receive(&s, frame, n)); CHECK(sm.generation == generation);
    OK(sc_receive(&s, old, old_n)); CHECK(sm.generation == generation);
    n = outbound(&s, frame); OK(sc_receive(&d, frame, n));
    CHECK(d.state.registered && d.state.applied_desired_revision == 1);
    CHECK(strcmp(d.state.actual_name, "Freezer \xe2\x98\x83") == 0);
    n = outbound(&d, frame); memcpy(nonce, frame + 38, 24);
    OK(sc_receive(&s, frame, n)); CHECK(!s.state.pending);
    n = outbound(&s, frame); OK(sc_receive(&d, frame, n));
    CHECK(!d.state.pending);
    start(&reboot, &dm, SC_DEVICE, sm.key);
    CHECK(reboot.state.applied_desired_revision == 1 && reboot.state.temperature_mC == -18250);
    OK(sc_report_temperature(&reboot, 42)); n = outbound(&reboot, frame);
    CHECK(memcmp(nonce, frame + 38, 24) != 0);
    CHECK(frame[61] >= SC_NONCE_RESERVATION);
    OK(sc_receive(&s, frame, n));
    CHECK(dm.random_calls == 0 && sm.random_calls == 0);
    CHECK(s.state.temperature_mC == 42);
}

static void transactional_failures(void) {
    sc_context d, s;
    memory_store dm, sm;
    sc_state before;
    uint8_t frame[512];
    size_t n;
    uint64_t counter;
    pair(&d, &dm, &s, &sm);
    before = d.state; dm.fail_commit = 1;
    CHECK(sc_report_temperature(&d, 10) == SC_ERR_STORAGE); unchanged(&d, &before);
    dm.fail_commit = 0; OK(sc_report_temperature(&d, 10)); before = d.state;
    CHECK(sc_outbound(&d, 1, frame, sizeof frame, &n) == SC_ERR_BOUNDS);
    CHECK(n == 0 && dm.counters[1] == 0); unchanged(&d, &before);
    dm.fail_reserve = 1;
    CHECK(sc_outbound(&d, 512, frame, 512, &n) == SC_ERR_STORAGE);
    CHECK(n == 0); unchanged(&d, &before);
    dm.fail_reserve = 0; dm.fail_seal = 1;
    CHECK(sc_outbound(&d, 512, frame, 512, &n) == SC_ERR_CRYPTO);
    CHECK(n == 0); unchanged(&d, &before);
    dm.fail_seal = 0; dm.fail_commit = 1; counter = d.nonce_next;
    CHECK(sc_outbound(&d, 512, frame, 512, &n) == SC_ERR_STORAGE);
    CHECK(n == 0 && d.nonce_next > counter); unchanged(&d, &before);
    dm.fail_commit = 0; n = outbound(&d, frame);
    before = s.state; sm.fail_commit = 1;
    CHECK(sc_receive(&s, frame, n) == SC_ERR_STORAGE); unchanged(&s, &before);
    CHECK(!s.state.registered);
    sm.fail_commit = 0; OK(sc_receive(&s, frame, n)); CHECK(s.state.registered);
    OK(sc_set_name(&s, "new")); n = outbound(&s, frame);
    before = d.state; dm.fail_commit = 1;
    CHECK(sc_receive(&d, frame, n) == SC_ERR_STORAGE); unchanged(&d, &before);
    dm.fail_commit = 0; OK(sc_receive(&d, frame, n)); CHECK(strcmp(d.state.actual_name, "new") == 0);
}

static void malformed_and_conflicting(void) {
    sc_context d, s;
    memory_store dm, sm;
    sc_state before;
    uint8_t original[512], frame[512];
    size_t n, mutated_n, i;
    simplecrypts_Packet packet;
    pair(&d, &dm, &s, &sm);
    OK(sc_report_temperature(&d, 123)); n = outbound(&d, original);
    before = s.state;
    memcpy(frame, original, n); frame[62] ^= 1;
    CHECK(sc_receive(&s, frame, n) == SC_ERR_AUTH); unchanged(&s, &before);
    for (i = 0; i < sizeof s.work; ++i) CHECK(s.work[i] == 0);
    memcpy(frame, original, n); packet = decode_packet(frame, n); packet.serial.bytes[0] ^= 1;
    mutated_n = rewrite_packet(frame, &packet);
    CHECK(sc_receive(&s, frame, mutated_n) == SC_ERR_PROTOCOL); unchanged(&s, &before);
    packet = decode_packet(original, n); packet.enrollment_token.bytes[0] ^= 1;
    memcpy(frame, original, n); mutated_n = rewrite_packet(frame, &packet);
    CHECK(sc_receive(&s, frame, mutated_n) == SC_ERR_ENROLLMENT); unchanged(&s, &before);
    packet = decode_packet(original, n); packet.name.size = 2;
    packet.name.bytes[0] = 0xc0; packet.name.bytes[1] = 0x80;
    memcpy(frame, original, n); mutated_n = rewrite_packet(frame, &packet);
    CHECK(sc_receive(&s, frame, mutated_n) == SC_ERR_UTF8); unchanged(&s, &before);
    OK(sc_receive(&s, original, n)); before = s.state;
    packet = decode_packet(original, n); ++packet.temperature_mC;
    memcpy(frame, original, n); mutated_n = rewrite_packet(frame, &packet);
    CHECK(sc_receive(&s, frame, mutated_n) == SC_ERR_CONFLICT); unchanged(&s, &before);
    packet = decode_packet(original, n); packet.revision = UINT64_MAX;
    packet.processed_desired_revision = 123;
    memcpy(frame, original, n); mutated_n = rewrite_packet(frame, &packet);
    CHECK(sc_receive(&s, frame, mutated_n) == SC_ERR_PROTOCOL); unchanged(&s, &before);
    CHECK(sc_set_name(&s, "\xed\xa0\x80") == SC_ERR_UTF8);
    CHECK(sc_set_name(&s, "\xf4\x90\x80\x80") == SC_ERR_UTF8);
    CHECK(sc_set_name(&s, "\xe2") == SC_ERR_UTF8);
}

static void rejection_and_old_receipt(void) {
    sc_context d, s;
    memory_store dm, sm;
    uint8_t frame[512], old[512];
    size_t n, old_n;
    sc_state before;
    simplecrypts_Packet p;
    pair(&d, &dm, &s, &sm);
    OK(sc_report_temperature(&d, 1)); n = outbound(&d, frame); OK(sc_receive(&s, frame, n));
    old_n = outbound(&s, old); OK(sc_receive(&d, old, old_n));
    OK(sc_set_name(&s, "")); n = outbound(&s, frame); OK(sc_receive(&d, frame, n));
    CHECK(d.state.apply_status == SC_APPLY_REJECTED && d.state.processed_desired_revision == 1);
    CHECK(d.state.applied_desired_revision == 0 && d.state.reported_revision == 2);
    before = d.state; OK(sc_receive(&d, old, old_n)); unchanged(&d, &before);
    n = outbound(&d, frame); OK(sc_receive(&s, frame, n)); CHECK(!s.state.pending);
    n = outbound(&s, frame); p = decode_packet(frame, n); p.acked_reported_revision = 99;
    n = rewrite_packet(frame, &p); before = d.state;
    CHECK(sc_receive(&d, frame, n) == SC_ERR_PROTOCOL); unchanged(&d, &before);
}

static void revision_limits_and_storage_identity(void) {
    sc_context d, s, reboot;
    memory_store dm, sm;
    sc_state before;
    uint8_t frame[512];
    size_t n;
    sc_provider p;
    sc_config cfg;
    pair(&d, &dm, &s, &sm);
    OK(sc_test_seed_revision(&d, UINT64_C(9007199254740992)));
    OK(sc_report_temperature(&d, 8)); n = outbound(&d, frame); OK(sc_receive(&s, frame, n));
    CHECK(s.state.reported_revision == UINT64_C(9007199254740993));
    pair(&d, &dm, &s, &sm);
    OK(sc_test_seed_revision(&d, UINT64_MAX)); before = d.state;
    CHECK(sc_report_temperature(&d, 9) == SC_ERR_EXHAUSTED); unchanged(&d, &before);
    OK(sc_test_seed_revision(&s, UINT64_MAX)); before = s.state;
    CHECK(sc_set_name(&s, "x") == SC_ERR_EXHAUSTED); unchanged(&s, &before);
    p = provider(&dm); cfg = d.config; strcpy(cfg.serial, "OTHER");
    CHECK(sc_init(&reboot, &cfg, &p) == SC_ERR_STORAGE);
    cfg = d.config; dm.key[0] ^= 1;
    CHECK(sc_init(&reboot, &cfg, &p) == SC_ERR_STORAGE);
}

static void deterministic_parser_fuzz(void) {
    sc_context d, s;
    memory_store dm, sm;
    uint8_t frame[512], valid[512];
    size_t i, j, n;
    uint32_t rng = 0xc0decafeu;
    sc_state before;
    pair(&d, &dm, &s, &sm);
    OK(sc_report_temperature(&d, 12)); n = outbound(&d, valid);
    before = s.state;
    for (i = 0; i < 3000; ++i) {
        size_t fuzz_len;
        rng = rng * 1664525u + 1013904223u; fuzz_len = rng % sizeof frame;
        for (j = 0; j < fuzz_len; ++j) { rng = rng * 1664525u + 1013904223u; frame[j] = (uint8_t)(rng >> 24); }
        if ((i & 1u) && fuzz_len >= 78) {
            /* Reach the protobuf parser behind the test authentication gate. */
            memcpy(frame, valid, 78);
        }
        CHECK(sc_receive(&s, frame, fuzz_len) != SC_OK); unchanged(&s, &before);
    }
    OK(sc_receive(&s, valid, n));
}

int main(void) {
    synchronization(); transactional_failures(); malformed_and_conflicting();
    rejection_and_old_receipt(); revision_limits_and_storage_identity(); deterministic_parser_fuzz();
    printf("core state/parser/provider contract tests passed\n");
    return 0;
}
