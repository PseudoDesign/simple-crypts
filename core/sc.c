#include "core/sc.h"
#include "schema/sc.pb.h"
#include "pb_decode.h"
#include "pb_encode.h"

#include <string.h>

#define SC_HEADER 62u
#define SC_REPORT 1u
#define SC_DESIRED 2u

/* Fail the build if schema evolution exceeds the declared MCU buffers. */
typedef char sc_packet_fits_frame[(simplecrypts_Packet_size + SC_HEADER + SC_TAG_BYTES <= SC_MAX_FRAME) ? 1 : -1];
typedef char sc_record_fits_storage[(simplecrypts_Record_size <= SC_MAX_RECORD) ? 1 : -1];
typedef char sc_serial_bound_matches[(sizeof(((simplecrypts_Packet *)0)->serial.bytes) == SC_MAX_SERIAL) ? 1 : -1];
typedef char sc_name_bound_matches[(sizeof(((simplecrypts_Packet *)0)->name.bytes) == SC_MAX_NAME) ? 1 : -1];

static void wipe(void *p, size_t n) {
    volatile uint8_t *v = (volatile uint8_t *)p;
    while (n--) *v++ = 0;
}

static int equal_secret(const uint8_t *a, const uint8_t *b, size_t n) {
    uint8_t diff = 0;
    size_t i;
    for (i = 0; i < n; ++i) diff |= (uint8_t)(a[i] ^ b[i]);
    return diff == 0;
}

static int zero_key(const uint8_t *key) {
    static const uint8_t zero[SC_KEY_BYTES] = {0};
    return equal_secret(key, zero, SC_KEY_BYTES);
}

static size_t bounded_length(const char *s, size_t max) {
    size_t n;
    for (n = 0; n <= max && s[n] != '\0'; ++n) {}
    return n;
}

/* Strict UTF-8: no embedded NUL, overlong form, surrogate, or > U+10FFFF. */
static int valid_utf8(const uint8_t *s, size_t n) {
    size_t i = 0;
    while (i < n) {
        uint32_t cp, min;
        unsigned follow, j;
        uint8_t c = s[i++];
        if (c == 0) return 0;
        if (c < 0x80) continue;
        if (c >= 0xc2 && c <= 0xdf) { cp = c & 31u; follow = 1; min = 0x80; }
        else if (c >= 0xe0 && c <= 0xef) { cp = c & 15u; follow = 2; min = 0x800; }
        else if (c >= 0xf0 && c <= 0xf4) { cp = c & 7u; follow = 3; min = 0x10000; }
        else return 0;
        if (n - i < follow) return 0;
        for (j = 0; j < follow; ++j) {
            c = s[i++];
            if ((c & 0xc0u) != 0x80u) return 0;
            cp = (cp << 6) | (c & 63u);
        }
        if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return 0;
    }
    return 1;
}

static int valid_serial(const char *s) {
    size_t i, n = bounded_length(s, SC_MAX_SERIAL);
    if (n == 0 || n > SC_MAX_SERIAL) return 0;
    for (i = 0; i < n; ++i) if ((uint8_t)s[i] < 0x21 || (uint8_t)s[i] > 0x7e) return 0;
    return 1;
}

static void refresh_pending(sc_context *ctx) {
    if (ctx->config.role == SC_DEVICE)
        ctx->state.pending = (uint8_t)(ctx->state.reported_revision > ctx->state.acked_reported_revision);
    else
        ctx->state.pending = (uint8_t)(ctx->state.desired_revision > ctx->state.processed_desired_revision);
}

#define SET_BYTES(field, ptr, len) do { \
    (field).size = (pb_size_t)(len); \
    memcpy((field).bytes, (ptr), (len)); \
} while (0)

static sc_status save(sc_context *ctx, const sc_state *next) {
    simplecrypts_Record record = simplecrypts_Record_init_zero;
    uint8_t bytes[SC_MAX_RECORD];
    pb_ostream_t stream = pb_ostream_from_buffer(bytes, sizeof bytes);
    sc_status status;
    if (ctx->state.storage_generation == UINT64_MAX) return SC_ERR_EXHAUSTED;
    record.version = SC_VERSION;
    record.role = (uint32_t)next->role;
    SET_BYTES(record.serial, next->serial, strlen(next->serial));
    SET_BYTES(record.local_key, ctx->local_public_key, SC_KEY_BYTES);
    SET_BYTES(record.peer_key, next->peer_public_key, SC_KEY_BYTES);
    record.registered = next->registered != 0;
    SET_BYTES(record.desired_name, next->desired_name, strlen(next->desired_name));
    SET_BYTES(record.actual_name, next->actual_name, strlen(next->actual_name));
    record.has_temperature_mC = next->has_temperature != 0;
    record.temperature_mC = next->temperature_mC;
    record.desired_revision = next->desired_revision;
    record.reported_revision = next->reported_revision;
    record.processed_desired_revision = next->processed_desired_revision;
    record.applied_desired_revision = next->applied_desired_revision;
    record.acked_reported_revision = next->acked_reported_revision;
    record.last_sent_reported_revision = next->last_sent_reported_revision;
    record.last_sent_desired_revision = next->last_sent_desired_revision;
    record.apply_status = next->apply_status;
    if (!pb_encode(&stream, simplecrypts_Record_fields, &record)) return SC_ERR_BOUNDS;
    status = ctx->provider.commit(ctx->provider.user, ctx->state.storage_generation, bytes, stream.bytes_written);
    wipe(bytes, sizeof bytes);
    if (status != SC_OK) return status < 0 ? status : SC_ERR_STORAGE;
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
        !valid_utf8(r.desired_name.bytes, r.desired_name.size) ||
        !valid_utf8(r.actual_name.bytes, r.actual_name.size) ||
        r.apply_status > SC_APPLY_REJECTED ||
        r.applied_desired_revision > r.processed_desired_revision ||
        r.processed_desired_revision > r.desired_revision ||
        r.last_sent_reported_revision > r.reported_revision ||
        r.last_sent_desired_revision > r.desired_revision ||
        r.acked_reported_revision > r.last_sent_reported_revision ||
        (r.registered && zero_key(r.peer_key.bytes))) return SC_ERR_STORAGE;
    memset(s, 0, sizeof *s);
    s->role = ctx->config.role;
    memcpy(s->serial, r.serial.bytes, r.serial.size);
    memcpy(s->desired_name, r.desired_name.bytes, r.desired_name.size);
    memcpy(s->actual_name, r.actual_name.bytes, r.actual_name.size);
    memcpy(s->peer_public_key, r.peer_key.bytes, SC_KEY_BYTES);
    s->registered = (uint8_t)r.registered;
    s->has_temperature = (uint8_t)r.has_temperature_mC;
    s->temperature_mC = r.has_temperature_mC ? r.temperature_mC : 0;
    s->desired_revision = r.desired_revision;
    s->reported_revision = r.reported_revision;
    s->processed_desired_revision = r.processed_desired_revision;
    s->applied_desired_revision = r.applied_desired_revision;
    s->acked_reported_revision = r.acked_reported_revision;
    s->last_sent_reported_revision = r.last_sent_reported_revision;
    s->last_sent_desired_revision = r.last_sent_desired_revision;
    s->apply_status = (uint8_t)r.apply_status;
    s->storage_generation = generation;
    return SC_OK;
}

sc_status sc_init(sc_context *ctx, const sc_config *config, const sc_provider *provider) {
    sc_status status;
    size_t length = 0;
    uint64_t generation = 0;
    if (!ctx || !config || !provider || !valid_serial(config->serial) ||
        (config->role != SC_DEVICE && config->role != SC_SERVER) ||
        !provider->public_key || !provider->seal || !provider->open ||
        !provider->load || !provider->commit || !provider->reserve ||
        !provider->enrollment_secret ||
        (config->role == SC_DEVICE && zero_key(config->peer_public_key))) return SC_ERR_ARGUMENT;
    memset(ctx, 0, sizeof *ctx);
    ctx->provider = *provider;
    ctx->config = *config;
    status = provider->public_key(provider->user, config->identity_key, ctx->local_public_key);
    if (status != SC_OK) return status < 0 ? status : SC_ERR_CRYPTO;
    if (zero_key(ctx->local_public_key)) return SC_ERR_ARGUMENT;
    status = provider->load(provider->user, ctx->work, sizeof ctx->work, &length, &generation);
    if (status == SC_NOT_FOUND) {
        sc_state next;
        memset(&next, 0, sizeof next);
        next.role = config->role;
        memcpy(next.serial, config->serial, strlen(config->serial) + 1u);
        memcpy(next.peer_public_key, config->peer_public_key, SC_KEY_BYTES);
        status = save(ctx, &next);
    } else if (status == SC_OK) {
        if (length > sizeof ctx->work) status = SC_ERR_STORAGE;
        else status = restore(ctx, ctx->work, length, generation);
    }
    wipe(ctx->work, sizeof ctx->work);
    if (status != SC_OK) return status < 0 ? status : SC_ERR_STORAGE;
    ctx->initialized = 1;
    refresh_pending(ctx);
    return SC_OK;
}

sc_status sc_set_name(sc_context *ctx, const char *name) {
    sc_state next;
    size_t n;
    if (!ctx || !ctx->initialized || !name) return SC_ERR_ARGUMENT;
    if (ctx->config.role != SC_SERVER) return SC_ERR_ROLE;
    n = bounded_length(name, SC_MAX_NAME);
    if (n > SC_MAX_NAME) return SC_ERR_BOUNDS;
    if (!valid_utf8((const uint8_t *)name, n)) return SC_ERR_UTF8;
    if (ctx->state.desired_revision != 0 && strcmp(name, ctx->state.desired_name) == 0) return SC_OK;
    if (ctx->state.desired_revision == UINT64_MAX) return SC_ERR_EXHAUSTED;
    next = ctx->state;
    memset(next.desired_name, 0, sizeof next.desired_name);
    memcpy(next.desired_name, name, n);
    ++next.desired_revision;
    return save(ctx, &next);
}

sc_status sc_report_temperature(sc_context *ctx, int32_t temperature_mC) {
    sc_state next;
    if (!ctx || !ctx->initialized) return SC_ERR_ARGUMENT;
    if (ctx->config.role != SC_DEVICE) return SC_ERR_ROLE;
    if (ctx->state.has_temperature && ctx->state.temperature_mC == temperature_mC) return SC_OK;
    if (ctx->state.reported_revision == UINT64_MAX) return SC_ERR_EXHAUSTED;
    next = ctx->state;
    next.has_temperature = 1;
    next.temperature_mC = temperature_mC;
    ++next.reported_revision;
    return save(ctx, &next);
}

static sc_status make_packet(sc_context *ctx, simplecrypts_Packet *p) {
    const sc_state *s = &ctx->state;
    sc_status status;
    *p = (simplecrypts_Packet)simplecrypts_Packet_init_zero;
    p->version = SC_VERSION;
    p->profile = SC_PROFILE_NACL_BOX;
    p->direction = (uint32_t)ctx->config.role;
    p->kind = ctx->config.role == SC_DEVICE ? SC_REPORT : SC_DESIRED;
    p->key_generation = 1;
    SET_BYTES(p->serial, s->serial, strlen(s->serial));
    SET_BYTES(p->sender_key, ctx->local_public_key, SC_KEY_BYTES);
    SET_BYTES(p->recipient_key, s->peer_public_key, SC_KEY_BYTES);
    if (ctx->config.role == SC_DEVICE) {
        p->revision = s->reported_revision;
        SET_BYTES(p->name, s->actual_name, strlen(s->actual_name));
        p->has_temperature_mC = s->has_temperature != 0;
        p->temperature_mC = s->temperature_mC;
        p->has_processed_desired_revision = true;
        p->processed_desired_revision = s->processed_desired_revision;
        p->has_applied_desired_revision = true;
        p->applied_desired_revision = s->applied_desired_revision;
        p->has_apply_status = true;
        p->apply_status = s->apply_status;
        if (!s->registered) {
            p->has_enrollment_token = true;
            p->enrollment_token.size = SC_TOKEN_BYTES;
            status = ctx->provider.enrollment_secret(ctx->provider.user, p->enrollment_token.bytes);
            if (status != SC_OK) { wipe(p->enrollment_token.bytes, SC_TOKEN_BYTES); return status < 0 ? status : SC_ERR_ENROLLMENT; }
        }
    } else {
        p->revision = s->desired_revision;
        SET_BYTES(p->name, s->desired_name, strlen(s->desired_name));
        p->has_acked_reported_revision = true;
        p->acked_reported_revision = s->reported_revision;
        p->has_enrollment_confirmed = true;
        p->enrollment_confirmed = true;
    }
    return SC_OK;
}

static sc_status next_nonce(sc_context *ctx, uint8_t out[SC_NONCE_BYTES]) {
    unsigned i;
    uint64_t value;
    sc_status status;
    if (ctx->nonce_next == ctx->nonce_limit) {
        uint64_t first;
        status = ctx->provider.reserve(ctx->provider.user, (uint32_t)ctx->config.role,
                                       SC_NONCE_RESERVATION, &first);
        if (status != SC_OK) return status < 0 ? status : SC_ERR_STORAGE;
        if (first > UINT64_MAX - SC_NONCE_RESERVATION) return SC_ERR_EXHAUSTED;
        ctx->nonce_next = first;
        ctx->nonce_limit = first + SC_NONCE_RESERVATION;
    }
    value = ctx->nonce_next++;
    memset(out, 0, SC_NONCE_BYTES);
    out[0] = (uint8_t)ctx->config.role;
    for (i = 0; i < 8; ++i) out[SC_NONCE_BYTES - 1u - i] = (uint8_t)(value >> (i * 8u));
    return SC_OK;
}

sc_status sc_outbound(sc_context *ctx, size_t byte_budget, uint8_t *frame,
                      size_t capacity, size_t *length) {
    simplecrypts_Packet packet;
    pb_ostream_t stream;
    sc_status status;
    size_t total;
    sc_state next;
    uint8_t nonce[SC_NONCE_BYTES];
    if (length) *length = 0;
    if (!ctx || !ctx->initialized || !frame || !length) return SC_ERR_ARGUMENT;
    refresh_pending(ctx);
    if (ctx->config.role == SC_DEVICE && !ctx->state.pending) return SC_NO_OUTPUT;
    if (ctx->config.role == SC_SERVER && (!ctx->state.registered ||
        (!ctx->state.pending && !ctx->receipt_pending))) return SC_NO_OUTPUT;
    status = make_packet(ctx, &packet);
    if (status != SC_OK) return status;
    stream = pb_ostream_from_buffer(ctx->work, sizeof ctx->work - SC_HEADER - SC_TAG_BYTES);
    if (!pb_encode(&stream, simplecrypts_Packet_fields, &packet)) status = SC_ERR_BOUNDS;
    wipe(&packet, sizeof packet);
    total = SC_HEADER + stream.bytes_written + SC_TAG_BYTES;
    if (status == SC_OK && (total > capacity || total > byte_budget || total > SC_MAX_FRAME)) status = SC_ERR_BOUNDS;
    if (status == SC_OK) status = next_nonce(ctx, nonce);
    if (status == SC_OK) {
        status = ctx->provider.seal(ctx->provider.user, ctx->config.identity_key,
            ctx->state.peer_public_key, nonce, ctx->work, stream.bytes_written,
            frame + SC_HEADER, capacity - SC_HEADER);
        if (status > 0) status = SC_ERR_CRYPTO;
    }
    if (status == SC_OK) {
        next = ctx->state;
        if (ctx->config.role == SC_DEVICE) next.last_sent_reported_revision = next.reported_revision;
        else next.last_sent_desired_revision = next.desired_revision;
        /* A frame must not leave this function before sent revision state is
         * durable. Failed commits burn only the independently reserved nonce. */
        if (next.last_sent_reported_revision != ctx->state.last_sent_reported_revision ||
            next.last_sent_desired_revision != ctx->state.last_sent_desired_revision)
            status = save(ctx, &next);
    }
    if (status == SC_OK) {
        frame[0] = 'S'; frame[1] = 'C'; frame[2] = SC_VERSION;
        frame[3] = SC_PROFILE_NACL_BOX; frame[4] = (uint8_t)ctx->config.role;
        frame[5] = ctx->config.role == SC_DEVICE ? SC_REPORT : SC_DESIRED;
        memcpy(frame + 6, ctx->local_public_key, SC_KEY_BYTES);
        memcpy(frame + 38, nonce, SC_NONCE_BYTES);
        *length = total;
        ctx->receipt_pending = 0;
        refresh_pending(ctx);
    } else if (capacity) {
        wipe(frame, capacity < SC_MAX_FRAME ? capacity : SC_MAX_FRAME);
    }
    wipe(nonce, sizeof nonce);
    wipe(ctx->work, sizeof ctx->work);
    return status;
}

static int report_agrees(const sc_state *s, const simplecrypts_Packet *p) {
    return s->has_temperature == (uint8_t)p->has_temperature_mC &&
        (!s->has_temperature || s->temperature_mC == p->temperature_mC) &&
        s->processed_desired_revision == p->processed_desired_revision &&
        s->applied_desired_revision == p->applied_desired_revision &&
        s->apply_status == p->apply_status && strlen(s->actual_name) == p->name.size &&
        memcmp(s->actual_name, p->name.bytes, p->name.size) == 0;
}

static sc_status receive_report(sc_context *ctx, const simplecrypts_Packet *p) {
    sc_state next = ctx->state;
    sc_status status;
    uint8_t token[SC_TOKEN_BYTES];
    int changed = 0;
    if (p->revision == 0 || !p->has_processed_desired_revision ||
        !p->has_applied_desired_revision || !p->has_apply_status ||
        p->has_acked_reported_revision || p->has_enrollment_confirmed ||
        p->apply_status > SC_APPLY_REJECTED ||
        p->applied_desired_revision > p->processed_desired_revision ||
        p->processed_desired_revision > next.last_sent_desired_revision ||
        (p->apply_status == SC_APPLY_OK && (!p->processed_desired_revision ||
            p->applied_desired_revision != p->processed_desired_revision)) ||
        (p->apply_status == SC_APPLY_REJECTED &&
            p->applied_desired_revision >= p->processed_desired_revision) ||
        (p->apply_status == SC_APPLY_NONE && (p->applied_desired_revision || p->processed_desired_revision)))
        return SC_ERR_PROTOCOL;
    if (!next.registered) {
        if (!p->has_enrollment_token || p->enrollment_token.size != SC_TOKEN_BYTES) return SC_ERR_ENROLLMENT;
        if (!zero_key(next.peer_public_key) && !equal_secret(next.peer_public_key, p->sender_key.bytes, SC_KEY_BYTES))
            return SC_ERR_ENROLLMENT;
        status = ctx->provider.enrollment_secret(ctx->provider.user, token);
        if (status != SC_OK) { wipe(token, sizeof token); return status < 0 ? status : SC_ERR_ENROLLMENT; }
        changed = equal_secret(token, p->enrollment_token.bytes, SC_TOKEN_BYTES);
        wipe(token, sizeof token);
        if (!changed) return SC_ERR_ENROLLMENT;
        next.registered = 1;
        memcpy(next.peer_public_key, p->sender_key.bytes, SC_KEY_BYTES);
    } else if (!equal_secret(next.peer_public_key, p->sender_key.bytes, SC_KEY_BYTES)) return SC_ERR_ENROLLMENT;
    if (p->revision == next.reported_revision && !report_agrees(&next, p)) return SC_ERR_CONFLICT;
    if (p->revision > next.reported_revision) {
        if (p->processed_desired_revision < next.processed_desired_revision ||
            p->applied_desired_revision < next.applied_desired_revision) return SC_ERR_PROTOCOL;
        next.reported_revision = p->revision;
        next.has_temperature = (uint8_t)p->has_temperature_mC;
        next.temperature_mC = p->has_temperature_mC ? p->temperature_mC : 0;
        memset(next.actual_name, 0, sizeof next.actual_name);
        memcpy(next.actual_name, p->name.bytes, p->name.size);
        next.processed_desired_revision = p->processed_desired_revision;
        next.applied_desired_revision = p->applied_desired_revision;
        next.apply_status = (uint8_t)p->apply_status;
        changed = 1;
    }
    if (changed) {
        status = save(ctx, &next);
        if (status != SC_OK) return status;
    }
    ctx->receipt_pending = 1;
    refresh_pending(ctx);
    return SC_OK;
}

static sc_status receive_desired(sc_context *ctx, const simplecrypts_Packet *p) {
    sc_state next = ctx->state;
    int changed = 0;
    if (p->has_enrollment_token || p->has_temperature_mC ||
        p->has_processed_desired_revision || p->has_applied_desired_revision ||
        p->has_apply_status || !p->has_acked_reported_revision ||
        !p->has_enrollment_confirmed || !p->enrollment_confirmed ||
        p->acked_reported_revision > next.last_sent_reported_revision ||
        (p->revision == 0 && p->name.size != 0)) return SC_ERR_PROTOCOL;
    if (p->revision == next.desired_revision &&
        (strlen(next.desired_name) != p->name.size || memcmp(next.desired_name, p->name.bytes, p->name.size)))
        return SC_ERR_CONFLICT;
    if (!next.registered) { next.registered = 1; changed = 1; }
    if (p->acked_reported_revision > next.acked_reported_revision) {
        next.acked_reported_revision = p->acked_reported_revision;
        changed = 1;
    }
    if (p->revision > next.desired_revision) {
        if (next.reported_revision == UINT64_MAX) return SC_ERR_EXHAUSTED;
        next.desired_revision = p->revision;
        next.processed_desired_revision = p->revision;
        memset(next.desired_name, 0, sizeof next.desired_name);
        memcpy(next.desired_name, p->name.bytes, p->name.size);
        if (p->name.size != 0) {
            memcpy(next.actual_name, next.desired_name, sizeof next.actual_name);
            next.applied_desired_revision = p->revision;
            next.apply_status = SC_APPLY_OK;
        } else next.apply_status = SC_APPLY_REJECTED;
        ++next.reported_revision;
        changed = 1;
    }
    return changed ? save(ctx, &next) : SC_OK;
}

sc_status sc_receive(sc_context *ctx, const uint8_t *frame, size_t length) {
    simplecrypts_Packet packet = simplecrypts_Packet_init_zero;
    pb_istream_t stream;
    sc_status status;
    uint8_t direction;
    size_t i, plain_len;
    if (!ctx || !ctx->initialized || !frame) return SC_ERR_ARGUMENT;
    if (length < SC_HEADER + SC_TAG_BYTES || length > SC_MAX_FRAME) return SC_ERR_BOUNDS;
    direction = ctx->config.role == SC_DEVICE ? SC_SERVER : SC_DEVICE;
    if (frame[0] != 'S' || frame[1] != 'C' || frame[2] != SC_VERSION ||
        frame[3] != SC_PROFILE_NACL_BOX || frame[4] != direction ||
        frame[5] != (direction == SC_DEVICE ? SC_REPORT : SC_DESIRED) || frame[38] != direction)
        return SC_ERR_PROTOCOL;
    for (i = 39; i < 54; ++i) if (frame[i] != 0) return SC_ERR_PROTOCOL;
    if (!zero_key(ctx->state.peer_public_key) &&
        !equal_secret(frame + 6, ctx->state.peer_public_key, SC_KEY_BYTES)) return SC_ERR_AUTH;
    status = ctx->provider.open(ctx->provider.user, ctx->config.identity_key, frame + 6,
        frame + 38, frame + SC_HEADER, length - SC_HEADER, ctx->work, sizeof ctx->work);
    if (status != SC_OK) {
        wipe(ctx->work, sizeof ctx->work);
        return status < 0 ? status : SC_ERR_AUTH;
    }
    plain_len = length - SC_HEADER - SC_TAG_BYTES;
    stream = pb_istream_from_buffer(ctx->work, plain_len);
    if (!pb_decode(&stream, simplecrypts_Packet_fields, &packet)) status = SC_ERR_PROTOCOL;
    else if (packet.version != SC_VERSION || packet.profile != SC_PROFILE_NACL_BOX ||
        packet.direction != direction || packet.kind != frame[5] || packet.key_generation != 1 ||
        packet.serial.size != strlen(ctx->state.serial) ||
        memcmp(packet.serial.bytes, ctx->state.serial, packet.serial.size) ||
        packet.sender_key.size != SC_KEY_BYTES || packet.recipient_key.size != SC_KEY_BYTES ||
        !equal_secret(packet.sender_key.bytes, frame + 6, SC_KEY_BYTES) ||
        !equal_secret(packet.recipient_key.bytes, ctx->local_public_key, SC_KEY_BYTES)) status = SC_ERR_PROTOCOL;
    else if (!valid_utf8(packet.name.bytes, packet.name.size)) status = SC_ERR_UTF8;
    else status = ctx->config.role == SC_DEVICE ? receive_desired(ctx, &packet) : receive_report(ctx, &packet);
    wipe(&packet, sizeof packet);
    wipe(ctx->work, sizeof ctx->work);
    return status;
}

sc_status sc_inspect(const sc_context *ctx, sc_state *out) {
    if (!ctx || !ctx->initialized || !out) return SC_ERR_ARGUMENT;
    *out = ctx->state;
    return SC_OK;
}

const char *sc_status_string(sc_status status) {
    switch (status) {
    case SC_OK: return "ok";
    case SC_NO_OUTPUT: return "no_output";
    case SC_NOT_FOUND: return "not_found";
    case SC_ERR_ARGUMENT: return "argument";
    case SC_ERR_BOUNDS: return "bounds";
    case SC_ERR_AUTH: return "authentication";
    case SC_ERR_PROTOCOL: return "protocol";
    case SC_ERR_STORAGE: return "storage";
    case SC_ERR_RANDOM: return "random_unavailable";
    case SC_ERR_CONFLICT: return "conflict";
    case SC_ERR_EXHAUSTED: return "exhausted";
    case SC_ERR_ROLE: return "role";
    case SC_ERR_ENROLLMENT: return "enrollment";
    case SC_ERR_UTF8: return "utf8";
    case SC_ERR_CRYPTO: return "crypto";
    default: return "unknown_error";
    }
}

#ifdef SC_ENABLE_TESTING
/* This symbol is absent from production core builds. It seeds a fresh fixture,
 * never moves an existing live stream backward, and persists through providers. */
sc_status sc_test_seed_revision(sc_context *ctx, uint64_t revision) {
    sc_state next;
    if (!ctx || !ctx->initialized) return SC_ERR_ARGUMENT;
    if (ctx->state.registered || ctx->state.desired_revision || ctx->state.reported_revision)
        return SC_ERR_CONFLICT;
    next = ctx->state;
    if (ctx->config.role == SC_DEVICE) {
        next.reported_revision = revision;
        next.last_sent_reported_revision = revision;
        next.acked_reported_revision = revision;
    } else {
        next.desired_revision = revision;
        next.last_sent_desired_revision = revision;
    }
    return save(ctx, &next);
}
#endif
