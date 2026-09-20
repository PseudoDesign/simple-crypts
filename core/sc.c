#include "core/sc.h"
#include "schema/sc.pb.h"
#include "pb_decode.h"
#include "pb_encode.h"

#include <string.h>

#define SC_HEADER 62u
#define SC_REPORT 1u
#define SC_DESIRED 2u

/* Fail the build if schema evolution exceeds the declared MCU buffers. */
typedef char sc_packet_fits_frame
    [(simplecrypts_Packet_size + SC_HEADER + SC_TAG_BYTES <= SC_MAX_FRAME) ? 1 : -1];
typedef char sc_record_fits_storage[(simplecrypts_Record_size <= SC_MAX_RECORD) ? 1 : -1];
typedef char sc_serial_bound_matches
    [(sizeof(((simplecrypts_Packet *)0)->serial.bytes) == SC_MAX_SERIAL) ? 1 : -1];
static const sc_data_schema *data_schema(const sc_context *);
static int group_index(const sc_context *, uint16_t);
static sc_status schema_valid(const sc_data_schema *);
static size_t values_encode(const sc_group_definition *, const sc_value *, uint8_t *);
static sc_status values_decode(const sc_group_definition *, const uint8_t *, size_t, sc_value *);

static void wipe(void *p, size_t n) {
    volatile uint8_t *v = (volatile uint8_t *)p;
    while (n--) {
        *v++ = 0;
    }
}

static int equal_secret(const uint8_t *a, const uint8_t *b, size_t n) {
    uint8_t diff = 0;
    size_t i;
    for (i = 0; i < n; ++i) {
        diff |= (uint8_t)(a[i] ^ b[i]);
    }
    return diff == 0;
}

static int zero_key(const uint8_t *key) {
    static const uint8_t zero[SC_KEY_BYTES] = {0};
    return equal_secret(key, zero, SC_KEY_BYTES);
}

static size_t bounded_length(const char *s, size_t max) {
    size_t n;
    for (n = 0; n <= max && s[n] != '\0'; ++n) {
    }
    return n;
}

/* Strict UTF-8: no embedded NUL, overlong form, surrogate, or > U+10FFFF. */
static int valid_utf8(const uint8_t *s, size_t n) {
    size_t i = 0;
    while (i < n) {
        uint32_t cp, min;
        unsigned follow, j;
        uint8_t c = s[i++];
        if (c == 0) {
            return 0;
        }
        if (c < 0x80) {
            continue;
        }
        if (c >= 0xc2 && c <= 0xdf) {
            cp = c & 31u;
            follow = 1;
            min = 0x80;
        } else if (c >= 0xe0 && c <= 0xef) {
            cp = c & 15u;
            follow = 2;
            min = 0x800;
        } else if (c >= 0xf0 && c <= 0xf4) {
            cp = c & 7u;
            follow = 3;
            min = 0x10000;
        } else {
            return 0;
        }
        if (n - i < follow) {
            return 0;
        }
        for (j = 0; j < follow; ++j) {
            c = s[i++];
            if ((c & 0xc0u) != 0x80u) {
                return 0;
            }
            cp = (cp << 6) | (c & 63u);
        }
        if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
            return 0;
        }
    }
    return 1;
}

static int valid_serial(const char *s) {
    size_t i, n = bounded_length(s, SC_MAX_SERIAL);
    if (n == 0 || n > SC_MAX_SERIAL) {
        return 0;
    }
    for (i = 0; i < n; ++i) {
        if ((uint8_t)s[i] < 0x21 || (uint8_t)s[i] > 0x7e) {
            return 0;
        }
    }
    return 1;
}

static void refresh_pending(sc_context *ctx) {
    unsigned i;
    ctx->state.pending = 0;
    if (!ctx->state.registered) {
        ctx->state.pending =
            (uint8_t)(ctx->config.role == SC_DEVICE &&
                      (!ctx->state.enrollment_mode || !zero_key(ctx->state.challenge)));
        return;
    }
    for (i = 0; i < data_schema(ctx)->count; i++) {
        sc_group_state *g = &ctx->state.data.groups[i];
        if (g->request_pending || g->response_pending || g->receipt_pending) {
            ctx->state.pending = 1;
        }
    }
}

#define SET_BYTES(field, ptr, len)                                                                 \
    do {                                                                                           \
        (field).size = (pb_size_t)(len);                                                           \
        memcpy((field).bytes, (ptr), (len));                                                       \
    } while (0)

static sc_status save(sc_context *ctx, const sc_state *next) {
    simplecrypts_Record record = simplecrypts_Record_init_zero;
    uint8_t bytes[SC_MAX_RECORD];
    pb_ostream_t stream = pb_ostream_from_buffer(bytes, sizeof bytes);
    sc_status status;
    if (ctx->state.storage_generation == UINT64_MAX) {
        return SC_ERR_EXHAUSTED;
    }
    record.version = SC_VERSION;
    record.role = (uint32_t)next->role;
    SET_BYTES(record.serial, next->serial, strlen(next->serial));
    SET_BYTES(record.local_key, ctx->local_public_key, SC_KEY_BYTES);
    SET_BYTES(record.peer_key, next->peer_public_key, SC_KEY_BYTES);
    record.registered = next->registered != 0;
    SET_BYTES(record.schema_hash, data_schema(ctx)->hash, 32);
    record.groups_count = data_schema(ctx)->count;
    {
        unsigned i;
        for (i = 0; i < record.groups_count; i++) {
            simplecrypts_GroupRecord *r = &record.groups[i];
            const sc_group_state *g = &next->data.groups[i];
            const sc_group_definition *d = &data_schema(ctx)->groups[i];
            r->values.size = (pb_size_t)values_encode(d, g->values, r->values.bytes);
            r->snapshot.size = (pb_size_t)values_encode(d, g->snapshot, r->snapshot.bytes);
            r->local_revision = g->local_revision;
            r->request_id = g->request_id;
            r->snapshot_id = g->snapshot_id;
            r->acknowledged_id = g->acknowledged_id;
            r->last_sent_id = g->last_sent_id;
            r->request_pending = g->request_pending;
            r->response_pending = g->response_pending;
            r->receipt_pending = g->receipt_pending;
            r->has_snapshot = g->has_snapshot;
        }
    }
    record.reported_revision = next->reported_revision;
    record.acked_reported_revision = next->acked_reported_revision;
    record.last_sent_reported_revision = next->last_sent_reported_revision;
    if (next->enrollment_mode) {
        record.has_enrollment_mode = true;
        record.enrollment_mode = 1;
        record.has_challenge = true;
        SET_BYTES(record.challenge, next->challenge, 32);
        record.has_enrollment_expires = true;
        record.enrollment_expires = next->enrollment_expires;
        record.has_candidate_key = true;
        SET_BYTES(record.candidate_key, next->candidate_key, 32);
        record.has_candidate_revision = true;
        record.candidate_revision = next->candidate_revision;
    }
    if (!pb_encode(&stream, simplecrypts_Record_fields, &record)) {
        return SC_ERR_BOUNDS;
    }
    status = ctx->provider.commit(ctx->provider.user, ctx->state.storage_generation, bytes,
                                  stream.bytes_written);
    wipe(bytes, sizeof bytes);
    if (status != SC_OK) {
        return status < 0 ? status : SC_ERR_STORAGE;
    }
    {
        uint64_t generation = ctx->state.storage_generation + 1u;
        ctx->state = *next;
        ctx->state.storage_generation = generation;
    }
    refresh_pending(ctx);
    return SC_OK;
}

static sc_status restore(sc_context *ctx, const uint8_t *bytes, size_t n, uint64_t generation) {
    simplecrypts_Record r = simplecrypts_Record_init_zero;
    pb_istream_t stream = pb_istream_from_buffer(bytes, n);
    sc_state *s = &ctx->state;
    size_t serial_len = strlen(ctx->config.serial);
    if (!pb_decode(&stream, simplecrypts_Record_fields, &r) || generation == 0 ||
        r.version != SC_VERSION || r.role != (uint32_t)ctx->config.role ||
        r.serial.size != serial_len || memcmp(r.serial.bytes, ctx->config.serial, serial_len) ||
        r.local_key.size != SC_KEY_BYTES || r.peer_key.size != SC_KEY_BYTES ||
        !equal_secret(r.local_key.bytes, ctx->local_public_key, SC_KEY_BYTES) ||
        (!zero_key(ctx->config.peer_public_key) &&
         !equal_secret(r.peer_key.bytes, ctx->config.peer_public_key, SC_KEY_BYTES)) ||
        r.schema_hash.size != 32 ||
        !equal_secret(r.schema_hash.bytes, data_schema(ctx)->hash, 32) ||
        r.groups_count != data_schema(ctx)->count ||
        r.last_sent_reported_revision > r.reported_revision ||
        r.acked_reported_revision > r.last_sent_reported_revision ||
        (r.registered && zero_key(r.peer_key.bytes))) {
        return SC_ERR_STORAGE;
    }
    memset(s, 0, sizeof *s);
    {
        unsigned i;
        for (i = 0; i < r.groups_count; i++) {
            const simplecrypts_GroupRecord *g = &r.groups[i];
            sc_group_state *t = &s->data.groups[i];
            const sc_group_definition *d = &data_schema(ctx)->groups[i];
            if (values_decode(d, g->values.bytes, g->values.size, t->values) != SC_OK ||
                values_decode(d, g->snapshot.bytes, g->snapshot.size, t->snapshot) != SC_OK ||
                g->snapshot_id > g->request_id || g->last_sent_id > g->request_id ||
                g->acknowledged_id > g->last_sent_id) {
                return SC_ERR_STORAGE;
            }
            t->local_revision = g->local_revision;
            t->request_id = g->request_id;
            t->snapshot_id = g->snapshot_id;
            t->acknowledged_id = g->acknowledged_id;
            t->last_sent_id = g->last_sent_id;
            t->request_pending = g->request_pending;
            t->response_pending = g->response_pending;
            t->receipt_pending = g->receipt_pending;
            t->has_snapshot = g->has_snapshot;
        }
    }
    s->role = ctx->config.role;
    memcpy(s->serial, r.serial.bytes, r.serial.size);
    memcpy(s->peer_public_key, r.peer_key.bytes, SC_KEY_BYTES);
    s->registered = (uint8_t)r.registered;
    s->reported_revision = r.reported_revision;
    s->acked_reported_revision = r.acked_reported_revision;
    s->last_sent_reported_revision = r.last_sent_reported_revision;
    s->storage_generation = generation;
    if (r.enrollment_mode > 1) {
        return SC_ERR_STORAGE;
    }
    if (r.enrollment_mode) {
        if (!r.has_challenge || r.challenge.size != 32 || !r.has_candidate_key ||
            r.candidate_key.size != 32) {
            return SC_ERR_STORAGE;
        }
        s->enrollment_mode = 1;
        memcpy(s->challenge, r.challenge.bytes, 32);
        memcpy(s->candidate_key, r.candidate_key.bytes, 32);
        s->enrollment_expires = r.enrollment_expires;
        s->candidate_revision = r.candidate_revision;
    }
    return SC_OK;
}

sc_status sc_init(sc_context *ctx, const sc_config *config, const sc_provider *provider) {
    sc_status status;
    size_t length = 0;
    uint64_t generation = 0;
    if (!ctx || !config || !provider || !valid_serial(config->serial) ||
        (config->role != SC_DEVICE && config->role != SC_SERVER) || !provider->public_key ||
        !provider->seal || !provider->open || !provider->load || !provider->commit ||
        !provider->reserve || !provider->enrollment_secret ||
        (config->role == SC_DEVICE && zero_key(config->peer_public_key))) {
        return SC_ERR_ARGUMENT;
    }
    memset(ctx, 0, sizeof *ctx);
    ctx->provider = *provider;
    ctx->config = *config;
    if (schema_valid(data_schema(ctx)) != SC_OK) {
        return SC_ERR_ARGUMENT;
    }
    status = provider->public_key(provider->user, config->identity_key, ctx->local_public_key);
    if (status != SC_OK) {
        return status < 0 ? status : SC_ERR_CRYPTO;
    }
    if (zero_key(ctx->local_public_key)) {
        return SC_ERR_ARGUMENT;
    }
    status = provider->load(provider->user, ctx->work, sizeof ctx->work, &length, &generation);
    if (status == SC_NOT_FOUND) {
        sc_state next;
        memset(&next, 0, sizeof next);
        next.role = config->role;
        memcpy(next.serial, config->serial, strlen(config->serial) + 1u);
        memcpy(next.peer_public_key, config->peer_public_key, SC_KEY_BYTES);
        status = save(ctx, &next);
    } else if (status == SC_OK) {
        if (length > sizeof ctx->work) {
            status = SC_ERR_STORAGE;
        } else {
            status = restore(ctx, ctx->work, length, generation);
        }
    }
    wipe(ctx->work, sizeof ctx->work);
    if (status != SC_OK) {
        return status < 0 ? status : SC_ERR_STORAGE;
    }
    ctx->initialized = 1;
    refresh_pending(ctx);
    return SC_OK;
}

/* Fixed, domain-separated signed invitation: magic, server Ed25519 key,
 * zero-padded serial, random session challenge, big-endian expiry, signature.
 * All 108 header bytes are signed. No device identity is known at this point. */
#define SC_INVITATION_SIZE 172u
static void put64(uint8_t *out, uint64_t n) {
    unsigned i;
    for (i = 0; i < 8; i++) {
        out[7 - i] = (uint8_t)(n >> (i * 8));
    }
}
static uint64_t get64(const uint8_t *in) {
    unsigned i;
    uint64_t n = 0;
    for (i = 0; i < 8; i++) {
        n = (n << 8) | in[i];
    }
    return n;
}
sc_status sc_enrollment_enable(sc_context *ctx) {
    sc_state next;
    if (!ctx || !ctx->initialized) {
        return SC_ERR_ARGUMENT;
    }
    if (ctx->state.enrollment_mode) {
        return SC_OK;
    }
    if (ctx->state.registered || ctx->state.reported_revision) {
        return SC_ERR_CONFLICT;
    }
    if (!ctx->provider.verify || (ctx->config.role == SC_SERVER && !ctx->provider.sign)) {
        return SC_ERR_ARGUMENT;
    }
    next = ctx->state;
    next.enrollment_mode = 1;
    return save(ctx, &next);
}
sc_status sc_enrollment_begin(sc_context *ctx, uint64_t now, uint64_t expires) {
    sc_state next;
    sc_status status;
    if (!ctx || !ctx->initialized || expires <= now) {
        return SC_ERR_ARGUMENT;
    }
    if (ctx->config.role != SC_SERVER) {
        return SC_ERR_ROLE;
    }
    if (!ctx->state.enrollment_mode || ctx->state.registered) {
        return SC_ERR_ENROLLMENT;
    }
    if (!ctx->provider.random || !ctx->provider.sign) {
        return SC_ERR_RANDOM;
    }
    next = ctx->state;
    status = ctx->provider.random(ctx->provider.user, next.challenge, 32);
    if (status != SC_OK) {
        return status < 0 ? status : SC_ERR_RANDOM;
    }
    if (zero_key(next.challenge) || equal_secret(next.challenge, ctx->state.challenge, 32)) {
        return SC_ERR_RANDOM;
    }
    next.enrollment_expires = expires;
    memset(next.candidate_key, 0, 32);
    next.candidate_revision = 0;

    return save(ctx, &next);
}
sc_status sc_enrollment_cancel(sc_context *ctx) {
    sc_state next;
    if (!ctx || !ctx->initialized) {
        return SC_ERR_ARGUMENT;
    }
    if (ctx->config.role != SC_SERVER) {
        return SC_ERR_ROLE;
    }
    if (!ctx->state.enrollment_mode || ctx->state.registered) {
        return SC_ERR_ENROLLMENT;
    }
    next = ctx->state;
    memset(next.challenge, 0, 32);
    memset(next.candidate_key, 0, 32);
    next.enrollment_expires = 0;
    next.candidate_revision = 0;
    return save(ctx, &next);
}
sc_status sc_enrollment_approve(sc_context *ctx, const uint8_t challenge[32], const uint8_t key[32],
                                uint64_t now) {
    sc_state next;
    sc_status status;
    if (!ctx || !ctx->initialized || !challenge || !key) {
        return SC_ERR_ARGUMENT;
    }
    if (ctx->config.role != SC_SERVER) {
        return SC_ERR_ROLE;
    }
    next = ctx->state;
    if (!next.enrollment_mode || zero_key(challenge) ||
        !equal_secret(next.challenge, challenge, 32)) {
        return SC_ERR_ENROLLMENT;
    }
    if (next.registered) {
        if (!equal_secret(next.peer_public_key, key, 32)) {
            return SC_ERR_ENROLLMENT;
        }
        ctx->receipt_pending = 1;
        return SC_OK;
    }
    if (!next.enrollment_expires || now >= next.enrollment_expires || !next.candidate_revision ||
        !equal_secret(next.candidate_key, key, 32)) {
        return SC_ERR_ENROLLMENT;
    }
    memcpy(next.peer_public_key, key, 32);
    next.registered = 1;
    next.enrollment_expires = 0;
    next.reported_revision = 1;
    memset(next.candidate_key, 0, 32);
    next.candidate_revision = 0;
    status = save(ctx, &next);
    if (status == SC_OK) {
        ctx->receipt_pending = 1;
    }
    return status;
}
static sc_status invitation(sc_context *ctx, uint8_t *frame, size_t cap, size_t budget,
                            size_t *length) {
    sc_status status;
    if (zero_key(ctx->state.challenge) || !ctx->state.enrollment_expires) {
        return SC_NO_OUTPUT;
    }
    if (cap < SC_INVITATION_SIZE || budget < SC_INVITATION_SIZE) {
        return SC_ERR_BOUNDS;
    }
    if (!ctx->provider.sign) {
        return SC_ERR_CRYPTO;
    }
    memset(frame, 0, SC_INVITATION_SIZE);
    memcpy(frame, "SCE3", 4);
    memcpy(frame + 4, ctx->local_public_key, 32);
    memcpy(frame + 36, ctx->state.serial, strlen(ctx->state.serial));
    memcpy(frame + 68, ctx->state.challenge, 32);
    put64(frame + 100, ctx->state.enrollment_expires);
    status =
        ctx->provider.sign(ctx->provider.user, ctx->config.identity_key, frame, 108, frame + 108);
    if (status == SC_OK) {
        *length = SC_INVITATION_SIZE;
    } else {
        wipe(frame, SC_INVITATION_SIZE);
    }
    return status < 0 ? status : status == SC_OK ? SC_OK : SC_ERR_CRYPTO;
}
static sc_status receive_invitation(sc_context *ctx, const uint8_t *frame, size_t length) {
    sc_state next;
    sc_status status;
    uint8_t serial[32] = {0};
    if (length != SC_INVITATION_SIZE) {
        return SC_ERR_BOUNDS;
    }
    if (ctx->config.role != SC_DEVICE || !ctx->state.enrollment_mode || ctx->state.registered) {
        return SC_ERR_ENROLLMENT;
    }
    if (!ctx->provider.verify || !equal_secret(frame + 4, ctx->state.peer_public_key, 32)) {
        return SC_ERR_AUTH;
    }
    status = ctx->provider.verify(ctx->provider.user, ctx->state.peer_public_key, frame, 108,
                                  frame + 108);
    if (status != SC_OK) {
        return status < 0 ? status : SC_ERR_AUTH;
    }
    memcpy(serial, ctx->state.serial, strlen(ctx->state.serial));
    if (memcmp(serial, frame + 36, 32) || zero_key(frame + 68) || !get64(frame + 100)) {
        return SC_ERR_PROTOCOL;
    }
    if (equal_secret(ctx->state.challenge, frame + 68, 32)) {
        return SC_OK;
    }
    next = ctx->state;
    memcpy(next.challenge, frame + 68, 32);
    next.enrollment_expires = get64(frame + 100);
    return save(ctx, &next);
}

#include "core/data.inc"
#include "modules/credits/credits.inc"

static sc_status make_packet(sc_context *ctx, simplecrypts_Packet *p) {
    const sc_state *s = &ctx->state;
    unsigned i, offset;
    *p = (simplecrypts_Packet)simplecrypts_Packet_init_zero;
    p->version = SC_VERSION;
    p->profile = SC_PROFILE_NACL_BOX;
    p->direction = ctx->config.role;
    p->kind = ctx->config.role == SC_DEVICE ? SC_REPORT : SC_DESIRED;
    p->key_generation = 1;
    p->revision = 1;
    SET_BYTES(p->serial, s->serial, strlen(s->serial));
    SET_BYTES(p->sender_key, ctx->local_public_key, 32);
    SET_BYTES(p->recipient_key, s->peer_public_key, 32);
    SET_BYTES(p->schema_hash, data_schema(ctx)->hash, 32);
    if (s->enrollment_mode) {
        p->has_enrollment_token = true;
        SET_BYTES(p->enrollment_token, s->challenge, 32);
    } else if (!s->registered && ctx->config.role == SC_DEVICE) {
        sc_status st;
        p->has_enrollment_token = true;
        p->enrollment_token.size = 32;
        st = ctx->provider.enrollment_secret(ctx->provider.user, p->enrollment_token.bytes);
        if (st != SC_OK) {
            return st < 0 ? st : SC_ERR_ENROLLMENT;
        }
    }
    if (ctx->config.role == SC_SERVER) {
        p->has_enrollment_confirmed = true;
        p->enrollment_confirmed = true;
        p->has_acked_reported_revision = true;
        p->acked_reported_revision = 1;
    }
    if (!s->registered) {
        return SC_OK;
    }
    /* Send an enrollment confirmation alone before application traffic. */
    if (ctx->receipt_pending) {
        return SC_OK;
    }
    for (offset = 0; offset < data_schema(ctx)->count; offset++) {
        i = (ctx->data_cursor + offset) % data_schema(ctx)->count;
        const sc_group_state *g = &s->data.groups[i];
        const sc_group_definition *d = &data_schema(ctx)->groups[i];
        if (!g->request_pending && !g->response_pending && !g->receipt_pending) {
            continue;
        }
        p->has_group_id = true;
        p->group_id = d->id;
        p->has_request_id = true;
        p->has_data_kind = true;
        p->request_id = g->request_id;
        p->data_kind = ctx->config.role == SC_DEVICE ? 2 : g->request_pending ? 1 : 3;
        if (p->data_kind == 3) {
            p->request_id = g->snapshot_id;
        } else {
            p->has_data = true;
            p->data.size = (pb_size_t)values_encode(d, p->data_kind == 2 ? g->snapshot : g->values,
                                                    p->data.bytes);
        }
        p->revision = p->request_id;
        return SC_OK;
    }
    return SC_NO_OUTPUT;
}

static sc_status receive_data(sc_context *ctx, const simplecrypts_Packet *p) {
    int index;
    unsigned j;
    sc_state next = ctx->state;
    sc_group_state *g;
    const sc_group_definition *d;
    sc_value incoming[SC_DATA_MAX_FIELDS];
    sc_status status;
    if (!p->has_group_id || !p->has_request_id || !p->request_id || !p->has_data_kind ||
        p->group_id > UINT16_MAX || p->revision != p->request_id) {
        return SC_ERR_PROTOCOL;
    }
    index = group_index(ctx, (uint16_t)p->group_id);
    if (index < 0) {
        return SC_ERR_PROTOCOL;
    }
    g = &next.data.groups[index];
    d = &data_schema(ctx)->groups[index];
    if (p->data_kind == 3) {
        if (ctx->config.role != SC_DEVICE || p->has_data || p->request_id > g->last_sent_id) {
            return SC_ERR_PROTOCOL;
        }
        if (p->request_id < g->request_id) {
            return SC_OK;
        }
        if (p->request_id > g->acknowledged_id || g->response_pending) {
            g->acknowledged_id = p->request_id;
            g->response_pending = 0;
            return save(ctx, &next);
        }
        return SC_OK;
    }
    if (!p->has_data || (ctx->config.role == SC_DEVICE ? p->data_kind != 1 : p->data_kind != 2)) {
        return SC_ERR_PROTOCOL;
    }
    status = values_decode(d, p->data.bytes, p->data.size, incoming);
    if (status != SC_OK) {
        return status;
    }
    if (ctx->config.role == SC_DEVICE) {
        if (p->request_id < g->request_id) {
            return SC_OK;
        }
        if (p->request_id == g->request_id) {
            for (j = 0; j < d->count; j++) {
                if (d->fields[j].owner == SC_SERVER &&
                    !value_equal(&d->fields[j], &incoming[j], &g->snapshot[j])) {
                    return SC_ERR_CONFLICT;
                }
            }
            if (g->response_pending) {
                return SC_OK;
            }
            g->response_pending = 1;
            return save(ctx, &next);
        }
        for (j = 0; j < d->count; j++) {
            if (d->fields[j].owner == SC_SERVER) {
                if (d->fields[j].monotonic && incoming[j].u64 < g->values[j].u64) {
                    return SC_ERR_CONFLICT;
                }
                g->values[j] = incoming[j];
            }
        }
        status = values_valid(d, g->values);
        if (status != SC_OK) {
            return status;
        }
        g->request_id = p->request_id;
        g->snapshot_id = p->request_id;
        g->has_snapshot = 1;
        g->response_pending = 1;
        memcpy(g->snapshot, g->values, sizeof g->snapshot);
    } else {
        if (p->request_id > g->last_sent_id) {
            return SC_ERR_PROTOCOL;
        }
        if (p->request_id < g->request_id) {
            return SC_OK;
        }
        if (g->has_snapshot && p->request_id == g->snapshot_id) {
            for (j = 0; j < d->count; j++) {
                if (!value_equal(&d->fields[j], &incoming[j], &g->snapshot[j])) {
                    return SC_ERR_CONFLICT;
                }
            }
        }
        for (j = 0; j < d->count; j++) {
            if (d->fields[j].owner == SC_SERVER &&
                !value_equal(&d->fields[j], &incoming[j], &g->values[j])) {
                return SC_ERR_CONFLICT;
            }
            if (d->fields[j].monotonic && incoming[j].u64 < g->values[j].u64) {
                return SC_ERR_CONFLICT;
            }
            g->values[j] = incoming[j];
        }
        g->snapshot_id = p->request_id;
        g->has_snapshot = 1;
        g->request_pending = 0;
        g->receipt_pending = 1;
        memcpy(g->snapshot, incoming, sizeof g->snapshot);
    }
    return memcmp(&next, &ctx->state, sizeof next) ? save(ctx, &next) : SC_OK;
}

static sc_status next_nonce(sc_context *ctx, uint8_t out[SC_NONCE_BYTES]) {
    unsigned i;
    uint64_t value;
    sc_status status;
    if (ctx->nonce_next == ctx->nonce_limit) {
        uint64_t first;
        status = ctx->provider.reserve(ctx->provider.user, (uint32_t)ctx->config.role,
                                       SC_NONCE_RESERVATION, &first);
        if (status != SC_OK) {
            return status < 0 ? status : SC_ERR_STORAGE;
        }
        if (first > UINT64_MAX - SC_NONCE_RESERVATION) {
            return SC_ERR_EXHAUSTED;
        }
        ctx->nonce_next = first;
        ctx->nonce_limit = first + SC_NONCE_RESERVATION;
    }
    value = ctx->nonce_next++;
    memset(out, 0, SC_NONCE_BYTES);
    out[0] = (uint8_t)ctx->config.role;
    for (i = 0; i < 8; ++i) {
        out[SC_NONCE_BYTES - 1u - i] = (uint8_t)(value >> (i * 8u));
    }
    return SC_OK;
}

sc_status sc_outbound(sc_context *ctx, size_t byte_budget, uint8_t *frame, size_t capacity,
                      size_t *length) {
    simplecrypts_Packet packet;
    pb_ostream_t stream;
    sc_status status;
    size_t total;
    sc_state next;
    uint8_t nonce[SC_NONCE_BYTES];
    if (length) {
        *length = 0;
    }
    if (!ctx || !ctx->initialized || !frame || !length) {
        return SC_ERR_ARGUMENT;
    }
    refresh_pending(ctx);
    if (ctx->state.enrollment_mode && !ctx->state.registered) {
        if (ctx->config.role == SC_SERVER) {
            return invitation(ctx, frame, capacity, byte_budget, length);
        }
        if (zero_key(ctx->state.challenge)) {
            return SC_NO_OUTPUT;
        }
    }
    if (ctx->config.role == SC_DEVICE && !ctx->state.pending) {
        return SC_NO_OUTPUT;
    }
    if (ctx->config.role == SC_SERVER &&
        (!ctx->state.registered || (!ctx->state.pending && !ctx->receipt_pending))) {
        return SC_NO_OUTPUT;
    }
    status = make_packet(ctx, &packet);
    if (status != SC_OK) {
        return status;
    }
    stream = pb_ostream_from_buffer(ctx->work, SC_MAX_FRAME - SC_HEADER - SC_TAG_BYTES);
    if (!pb_encode(&stream, simplecrypts_Packet_fields, &packet)) {
        status = SC_ERR_BOUNDS;
    }
    total = SC_HEADER + stream.bytes_written + SC_TAG_BYTES;
    if (status == SC_OK && (total > capacity || total > byte_budget || total > SC_MAX_FRAME)) {
        status = SC_ERR_BOUNDS;
    }
    if (status == SC_OK) {
        status = next_nonce(ctx, nonce);
    }
    if (status == SC_OK) {
        status = ctx->provider.seal(ctx->provider.user, ctx->config.identity_key,
                                    ctx->state.peer_public_key, nonce, ctx->work,
                                    stream.bytes_written, frame + SC_HEADER, capacity - SC_HEADER);
        if (status > 0) {
            status = SC_ERR_CRYPTO;
        }
    }
    if (status == SC_OK) {
        next = ctx->state;
        if (ctx->config.role == SC_DEVICE) {
            next.last_sent_reported_revision = 1;
            next.reported_revision = 1;
        }
        if (packet.has_group_id) {
            int index = group_index(ctx, (uint16_t)packet.group_id);
            sc_group_state *g = &next.data.groups[index];
            if (packet.data_kind != 3) {
                g->last_sent_id = packet.request_id;
            } else {
                g->receipt_pending = 0;
            }
        }
        if (memcmp(&next, &ctx->state, sizeof next)) {
            status = save(ctx, &next);
        }
    }
    if (status == SC_OK) {
        frame[0] = 'S';
        frame[1] = 'C';
        frame[2] = SC_VERSION;
        frame[3] = SC_PROFILE_NACL_BOX;
        frame[4] = (uint8_t)ctx->config.role;
        frame[5] = ctx->config.role == SC_DEVICE ? SC_REPORT : SC_DESIRED;
        memcpy(frame + 6, ctx->local_public_key, SC_KEY_BYTES);
        memcpy(frame + 38, nonce, SC_NONCE_BYTES);
        *length = total;
        if (packet.has_group_id) {
            ctx->data_cursor = (uint8_t)((group_index(ctx, (uint16_t)packet.group_id) + 1) %
                                         data_schema(ctx)->count);
        }
        ctx->receipt_pending = 0;
        refresh_pending(ctx);
    } else if (capacity) {
        wipe(frame, capacity < SC_MAX_FRAME ? capacity : SC_MAX_FRAME);
    }
    wipe(&packet, sizeof packet);
    wipe(nonce, sizeof nonce);
    wipe(ctx->work, sizeof ctx->work);
    return status;
}

static sc_status receive_report(sc_context *ctx, const simplecrypts_Packet *p, uint64_t now) {
    sc_state next = ctx->state;
    sc_status status;
    uint8_t token[32];
    if (p->has_enrollment_confirmed || p->has_acked_reported_revision) {
        return SC_ERR_PROTOCOL;
    }
    if (next.enrollment_mode &&
        (!p->has_enrollment_token || p->enrollment_token.size != 32 || zero_key(next.challenge) ||
         !equal_secret(next.challenge, p->enrollment_token.bytes, 32))) {
        return SC_ERR_ENROLLMENT;
    }
    if (!next.registered) {
        if (p->has_group_id || p->has_data || p->has_request_id || p->has_data_kind ||
            p->revision != 1) {
            return SC_ERR_PROTOCOL;
        }
        if (next.enrollment_mode) {
            if (!next.enrollment_expires || now >= next.enrollment_expires) {
                return SC_ERR_ENROLLMENT;
            }
            if (!zero_key(next.candidate_key) &&
                !equal_secret(next.candidate_key, p->sender_key.bytes, 32)) {
                return SC_ERR_CONFLICT;
            }
            if (next.candidate_revision) {
                return SC_OK;
            }
            memcpy(next.candidate_key, p->sender_key.bytes, 32);
            next.candidate_revision = 1;
            return save(ctx, &next);
        }
        if (!p->has_enrollment_token || p->enrollment_token.size != 32) {
            return SC_ERR_ENROLLMENT;
        }
        status = ctx->provider.enrollment_secret(ctx->provider.user, token);
        if (status != SC_OK) {
            wipe(token, 32);
            return status < 0 ? status : SC_ERR_ENROLLMENT;
        }
        status = equal_secret(token, p->enrollment_token.bytes, 32) ? SC_OK : SC_ERR_ENROLLMENT;
        wipe(token, 32);
        if (status != SC_OK) {
            return status;
        }
        memcpy(next.peer_public_key, p->sender_key.bytes, 32);
        next.registered = 1;
        next.reported_revision = 1;
        status = save(ctx, &next);
        if (status != SC_OK) {
            return status;
        }
    }
    if (!equal_secret(ctx->state.peer_public_key, p->sender_key.bytes, 32)) {
        return SC_ERR_ENROLLMENT;
    }
    if (p->has_group_id) {
        return receive_data(ctx, p);
    }
    if (p->has_data || p->has_request_id || p->has_data_kind || p->revision != 1) {
        return SC_ERR_PROTOCOL;
    }
    ctx->receipt_pending = 1;
    return SC_OK;
}
static sc_status receive_desired(sc_context *ctx, const simplecrypts_Packet *p) {
    sc_state next = ctx->state;
    sc_status status;
    if (next.enrollment_mode) {
        if (!p->has_enrollment_token || p->enrollment_token.size != 32 ||
            zero_key(next.challenge) ||
            !equal_secret(next.challenge, p->enrollment_token.bytes, 32)) {
            return SC_ERR_ENROLLMENT;
        }
    } else if (p->has_enrollment_token) {
        return SC_ERR_PROTOCOL;
    }
    if (!p->has_enrollment_confirmed || !p->enrollment_confirmed ||
        !p->has_acked_reported_revision || p->acked_reported_revision != 1 ||
        next.last_sent_reported_revision != 1) {
        return SC_ERR_PROTOCOL;
    }
    if (p->has_group_id) {
        if (!next.registered) {
            return SC_ERR_ENROLLMENT;
        }
        return receive_data(ctx, p);
    }
    if (p->has_data || p->has_request_id || p->has_data_kind || p->revision != 1) {
        return SC_ERR_PROTOCOL;
    }
    if (next.registered) {
        return SC_OK;
    }
    next.registered = 1;
    next.acked_reported_revision = 1;
    next.reported_revision = 1;
    status = save(ctx, &next);
    return status;
}

sc_status sc_receive_at(sc_context *ctx, const uint8_t *frame, size_t length, uint64_t now) {
    simplecrypts_Packet packet = simplecrypts_Packet_init_zero;
    pb_istream_t stream;
    sc_status status;
    uint8_t direction;
    size_t i, plain_len;
    if (!ctx || !ctx->initialized || !frame) {
        return SC_ERR_ARGUMENT;
    }
    if (length >= 4 && !memcmp(frame, "SCE3", 4)) {
        return receive_invitation(ctx, frame, length);
    }
    if (length < SC_HEADER + SC_TAG_BYTES || length > SC_MAX_FRAME) {
        return SC_ERR_BOUNDS;
    }
    direction = ctx->config.role == SC_DEVICE ? SC_SERVER : SC_DEVICE;
    if (frame[0] != 'S' || frame[1] != 'C' || frame[2] != SC_VERSION ||
        frame[3] != SC_PROFILE_NACL_BOX || frame[4] != direction ||
        frame[5] != (direction == SC_DEVICE ? SC_REPORT : SC_DESIRED) || frame[38] != direction) {
        return SC_ERR_PROTOCOL;
    }
    for (i = 39; i < 54; ++i) {
        if (frame[i] != 0) {
            return SC_ERR_PROTOCOL;
        }
    }
    if (!zero_key(ctx->state.peer_public_key) &&
        !equal_secret(frame + 6, ctx->state.peer_public_key, SC_KEY_BYTES)) {
        return SC_ERR_AUTH;
    }
    status = ctx->provider.open(ctx->provider.user, ctx->config.identity_key, frame + 6, frame + 38,
                                frame + SC_HEADER, length - SC_HEADER, ctx->work, sizeof ctx->work);
    if (status != SC_OK) {
        wipe(ctx->work, sizeof ctx->work);
        return status < 0 ? status : SC_ERR_AUTH;
    }
    plain_len = length - SC_HEADER - SC_TAG_BYTES;
    stream = pb_istream_from_buffer(ctx->work, plain_len);
    if (!pb_decode(&stream, simplecrypts_Packet_fields, &packet)) {
        status = SC_ERR_PROTOCOL;
    } else if (packet.version != SC_VERSION || packet.profile != SC_PROFILE_NACL_BOX ||
               packet.direction != direction || packet.kind != frame[5] ||
               packet.key_generation != 1 || packet.serial.size != strlen(ctx->state.serial) ||
               memcmp(packet.serial.bytes, ctx->state.serial, packet.serial.size) ||
               packet.sender_key.size != SC_KEY_BYTES ||
               packet.recipient_key.size != SC_KEY_BYTES ||
               !equal_secret(packet.sender_key.bytes, frame + 6, SC_KEY_BYTES) ||
               !equal_secret(packet.recipient_key.bytes, ctx->local_public_key, SC_KEY_BYTES) ||
               packet.schema_hash.size != 32 ||
               !equal_secret(packet.schema_hash.bytes, data_schema(ctx)->hash, 32)) {
        status = SC_ERR_PROTOCOL;
    } else {
        status = ctx->config.role == SC_DEVICE ? receive_desired(ctx, &packet)
                                               : receive_report(ctx, &packet, now);
    }
    wipe(&packet, sizeof packet);
    wipe(ctx->work, sizeof ctx->work);
    return status;
}

sc_status sc_receive(sc_context *ctx, const uint8_t *frame, size_t length) {
    /* Missing trusted server time must fail closed for an unapproved session. */
    return sc_receive_at(ctx, frame, length, UINT64_MAX);
}

sc_status sc_inspect(const sc_context *ctx, sc_state *out) {
    if (!ctx || !ctx->initialized || !out) {
        return SC_ERR_ARGUMENT;
    }
    *out = ctx->state;
    return SC_OK;
}

const char *sc_status_string(sc_status status) {
    switch (status) {
    case SC_OK:
        return "ok";
    case SC_NO_OUTPUT:
        return "no_output";
    case SC_NOT_FOUND:
        return "not_found";
    case SC_ERR_ARGUMENT:
        return "argument";
    case SC_ERR_BOUNDS:
        return "bounds";
    case SC_ERR_AUTH:
        return "authentication";
    case SC_ERR_PROTOCOL:
        return "protocol";
    case SC_ERR_STORAGE:
        return "storage";
    case SC_ERR_RANDOM:
        return "random_unavailable";
    case SC_ERR_CONFLICT:
        return "conflict";
    case SC_ERR_EXHAUSTED:
        return "exhausted";
    case SC_ERR_ROLE:
        return "role";
    case SC_ERR_ENROLLMENT:
        return "enrollment";
    case SC_ERR_UTF8:
        return "utf8";
    case SC_ERR_CRYPTO:
        return "crypto";
    default:
        return "unknown_error";
    }
}

#ifdef SC_ENABLE_TESTING
/* This symbol is absent from production core builds. It seeds a fresh fixture,
 * never moves an existing live stream backward, and persists through providers. */
sc_status sc_test_seed_revision(sc_context *ctx, uint64_t revision) {
    sc_state next;
    if (!ctx || !ctx->initialized) {
        return SC_ERR_ARGUMENT;
    }
    if (ctx->state.registered || ctx->state.reported_revision) {
        return SC_ERR_CONFLICT;
    }
    next = ctx->state;
    next.data.groups[0].local_revision = revision;
    if (ctx->config.role == SC_SERVER) {
        next.data.groups[0].request_id = revision;
    }
    return save(ctx, &next);
}
#endif
