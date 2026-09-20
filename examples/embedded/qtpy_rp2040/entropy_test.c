/* Fault hooks are nonreturning, including unexpected RNG use after startup. */
#include "entropy.h"
#include <assert.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

void qt_entropy_fault(void) {
    _Exit(42);
}
int main(void) {
    for (unsigned initialized = 0; initialized < 2; ++initialized) {
        pid_t pid = fork();
        assert(pid >= 0);
        if (!pid) {
            uint8_t seed[32] = {1}, byte;
            if (initialized) {
                assert(qt_crypto_start(seed, 31) == -1);
                assert(qt_crypto_start(seed, sizeof seed) == 0);
                randombytes_buf(&byte, 1);
            } else {
                qtpy_random.buf(&byte, 1);
            }
            _Exit(1);
        }
        int status;
        assert(waitpid(pid, &status, 0) == pid);
        assert(WIFEXITED(status) && WEXITSTATUS(status) == 42);
    }
    return 0;
}
