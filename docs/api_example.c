/* A complete, compiled Linux example. Uses fresh ephemeral secrets and a private
 * temporary store; applications retain their store and provision secrets securely. */
#include "core/sc.h"
#include "providers/host/sc_host.h"
#include <sodium.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

int main(void) {
    char directory[] = "/tmp/sc-api-example-XXXXXX";
    char filename[128];
    sc_host *server = NULL;
    uint8_t secret[SC_TOKEN_BYTES], frame[SC_MAX_FRAME];
    size_t length = 0;
    uint64_t now = (uint64_t)time(NULL); /* This application uses seconds. */
    int status = SC_ERR_STORAGE;
    if (sodium_init() < 0 || !mkdtemp(directory)) {
        return 1;
    }
    randombytes_buf(secret, sizeof secret);
    status = sc_host_initialize(SC_SERVER, directory, "example-device", secret,
                                NULL, NULL, 0, &server);
    sodium_memzero(secret, sizeof secret);
    if (status == SC_OK) {
        status = sc_host_enrollment_enable(server);
    }
    if (status == SC_OK) {
        status = sc_host_enrollment_begin(server, now, now + 600);
    }
    if (status == SC_OK) {
        status = sc_host_outbound(server, sizeof frame, frame, sizeof frame, &length);
    }
    if (status == SC_OK) {
        printf("Generated %zu invitation bytes; transport sends them separately.\n", length);
    } else {
        fprintf(stderr, "%s\n", sc_host_status(status));
    }
    sc_host_close(server); /* Release the lock and wipe the in-memory identity. */
    snprintf(filename, sizeof filename, "%s/state.bin", directory);
    unlink(filename);
    snprintf(filename, sizeof filename, "%s/state.lock", directory);
    unlink(filename);
    rmdir(directory); /* Only this example deletes its temporary identity. */
    return status == SC_OK ? 0 : 1;
}
