#ifndef SIMPLE_CRYPTS_SC_TEST_H
#define SIMPLE_CRYPTS_SC_TEST_H
#include "core/sc.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Available only in explicitly SC_ENABLE_TESTING builds. Seeds a new test
 * fixture near large uint64 boundaries without a trillions-of-updates loop. */
sc_status sc_test_seed_revision(sc_context *ctx, uint64_t revision);
#ifdef __cplusplus
}
#endif
#endif
