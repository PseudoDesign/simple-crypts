#include "app.h"
size_t qt_cobs_encode(const uint8_t *src, size_t n, uint8_t *dst, size_t cap) {
    size_t at = 1, mark = 0;
    uint8_t code = 1;
    if (cap < n + n / 254 + 2) {
        return 0;
    }
    for (size_t i = 0; i < n; ++i) {
        if (!src[i]) {
            dst[mark] = code;
            mark = at++;
            code = 1;
        } else {
            dst[at++] = src[i];
            if (++code == 255) {
                dst[mark] = code;
                mark = at++;
                code = 1;
            }
        }
    }
    dst[mark] = code;
    dst[at++] = 0;
    return at;
}
size_t qt_cobs_decode(const uint8_t *src, size_t n, uint8_t *dst, size_t cap) {
    size_t at = 0, out = 0;
    while (at < n) {
        uint8_t code = src[at++];
        if (!code || at + code - 1 > n || out + code - 1 > cap) {
            return 0;
        }
        for (unsigned i = 1; i < code; ++i) {
            if (!src[at]) {
                return 0;
            }
            dst[out++] = src[at++];
        }
        if (code != 255 && at < n) {
            if (out >= cap) {
                return 0;
            }
            dst[out++] = 0;
        }
    }
    return out;
}
static uint32_t get32(const uint8_t *p) {
    return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
}
static void put32(uint8_t *p, uint32_t n) {
    p[0] = (uint8_t)(n >> 24);
    p[1] = (uint8_t)(n >> 16);
    p[2] = (uint8_t)(n >> 8);
    p[3] = (uint8_t)n;
}
size_t qt_rpc(qt_app *a, uint8_t *in, size_t n, uint8_t *out, size_t cap) {
    if (n < 12 || n > QT_MESSAGE_MAX || cap < 16 || in[0] != 'Q' || in[1] != 'T' || in[2] != 1 ||
        get32(in + n - 4) != qt_crc(in, n - 4)) {
        return 0;
    }
    out[0] = 'Q';
    out[1] = 'R';
    out[2] = 1;
    out[3] = in[3];
    for (unsigned i = 4; i < 8; ++i) {
        out[i] = in[i];
    }
    size_t length = 0;
    int rc = qt_app_command(a, in[3], in + 8, n - 12, out + 12, cap - 16, &length);
    put32(out + 8, (uint32_t)rc);
    put32(out + 12 + length, qt_crc(out, 12 + length));
    return 16 + length;
}
