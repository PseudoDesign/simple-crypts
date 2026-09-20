#ifndef EXAMPLE_ENDPOINT_H
#define EXAMPLE_ENDPOINT_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Example bridge, not a new SDK. Each Wasm instance owns one endpoint.
 * Input layout for init: pinned key at 0, NUL-terminated serial at 32.
 * Exact uint64 arguments occupy big-endian slots at input offsets 2048/2056.
 * All mutating calls may suspend for storage and must be awaited by the worker.
 */
uint8_t *ex_input(void);
int ex_init(int role, int fresh);
int ex_reboot(void);
int ex_begin(void);
int ex_approve(void);
int ex_cancel(void);
int ex_issue(void);
int ex_request(void);
int ex_consume(uint64_t amount);
int ex_receive(size_t length);
int ex_outbound(void);
const uint8_t *ex_frame(void);
size_t ex_frame_length(void);
const char *ex_state(void);
const char *ex_status(int status);
#ifdef __cplusplus
}
#endif
#endif
