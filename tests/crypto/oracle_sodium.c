/* Test-only raw-key oracle. Production protocol APIs use provider handles. */
#include <sodium.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static size_t decode(const char *text, unsigned char *out, size_t capacity) {
    size_t length = 0;
    if (sodium_hex2bin(out, capacity, text, strlen(text), NULL, &length, NULL) != 0) {
        fputs("invalid fixture\n", stderr);
        exit(3);
    }
    return length;
}

int main(int argc, char **argv) {
    unsigned char secret[32], peer[32], nonce[24], data[1024], result[1040];
    char output[2081];
    size_t length, result_length;
    int status;
    if (argc != 6 || sodium_init() < 0) return 3;
    if (decode(argv[2], secret, sizeof secret) != 32 ||
        decode(argv[3], peer, sizeof peer) != 32 ||
        decode(argv[4], nonce, sizeof nonce) != 24) return 3;
    length = decode(argv[5], data, sizeof data);
    if (strcmp(argv[1], "seal") == 0) {
        result_length = length + crypto_box_MACBYTES;
        status = crypto_box_easy(result, data, length, nonce, peer, secret);
    } else if (strcmp(argv[1], "open") == 0) {
        if (length < crypto_box_MACBYTES) return 2;
        result_length = length - crypto_box_MACBYTES;
        status = crypto_box_open_easy(result, data, length, nonce, peer, secret);
    } else return 3;
    sodium_memzero(secret, sizeof secret);
    if (status != 0) { fputs("authentication failed\n", stderr); return 2; }
    sodium_bin2hex(output, sizeof output, result, result_length);
    puts(output);
    return 0;
}
