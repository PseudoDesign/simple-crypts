/* Host integration fixture for the exact application, storage and framing code. */
#include "app.h"
#include "entropy.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static uint8_t memory[QT_NVM_BYTES];
static FILE *disk;
static qt_app app;
static unsigned operations;
static int sync_disk(void) {
    if (fseek(disk, 0, SEEK_SET) || fwrite(memory, 1, sizeof memory, disk) != sizeof memory ||
        fflush(disk) || fsync(fileno(disk))) {
        return -1;
    }
    return 0;
}
static int finish_operation(void) {
    int rc = sync_disk();
    /* Kill immediately after the first identity commit marker reaches durable media. */
    if (!rc && ++operations == 17 && getenv("QT_SIM_CUT_AFTER_IDENTITY")) {
        _Exit(43);
    }
    return rc;
}
static int read_flash(void *u, uint32_t at, void *out, size_t n) {
    (void)u;
    if (at > sizeof memory || n > sizeof memory - at) {
        return -1;
    }
    memcpy(out, memory + at, n);
    return 0;
}
static int erase(void *u, uint32_t at) {
    (void)u;
    if (at % QT_SECTOR || at >= sizeof memory) {
        return -1;
    }
    memset(memory + at, 255, QT_SECTOR);
    return finish_operation();
}
static int program(void *u, uint32_t at, const void *p, size_t n) {
    (void)u;
    if (at % QT_PAGE || n != QT_PAGE || at + n > sizeof memory) {
        return -1;
    }
    for (size_t i = 0; i < n; ++i) {
        if (memory[at + i] != 255) {
            return -1;
        }
        memory[at + i] = ((const uint8_t *)p)[i];
    }
    return finish_operation();
}
void qt_entropy_fault(void) {
    _Exit(42);
}
int main(int argc, char **argv) {
    if (argc != 2) {
        return 2;
    }
    memset(memory, 255, sizeof memory);
    disk = fopen(argv[1], "r+b");
    if (!disk) {
        disk = fopen(argv[1], "w+b");
        if (!disk || sync_disk()) {
            return 2;
        }
    }
    if (fread(memory, 1, sizeof memory, disk) != sizeof memory) {
        if (fseek(disk, 0, SEEK_SET) || fread(memory, 1, sizeof memory, disk) != sizeof memory) {
            return 2;
        }
    }
    qt_flash flash = {NULL, read_flash, erase, program};
    qt_app_open(&app, &flash, "qtpy-simulator");
    uint8_t input[1030], plain[1024], response[1024], encoded[1030];
    size_t used = 0;
    int overflow = 0, ch;
    while ((ch = getchar()) != EOF) {
        if (ch) {
            if (!overflow && used < sizeof input) {
                input[used++] = (uint8_t)ch;
            } else {
                overflow = 1;
            }
        } else {
            size_t n = overflow ? 0 : qt_cobs_decode(input, used, plain, sizeof plain);
            n = qt_rpc(&app, plain, n, response, sizeof response);
            sodium_memzero(plain, sizeof plain);
            sodium_memzero(input, sizeof input);
            used = 0;
            overflow = 0;
            if (n) {
                n = qt_cobs_encode(response, n, encoded, sizeof encoded);
                fwrite(encoded, 1, n, stdout);
                fflush(stdout);
            }
            if (app.reboot) {
                break;
            }
        }
    }
    sodium_memzero(&app, sizeof app);
    fclose(disk);
    return 0;
}
