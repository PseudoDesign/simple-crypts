#ifndef EXAMPLE_ENDPOINT_H
#define EXAMPLE_ENDPOINT_H
/** @file
 * @brief Persistent browser bridge, owned by one worker and one Wasm instance.
 * @ingroup examples
 * All mutating calls require successful initialization and exclusive access.
 * Await Asyncify completion: storage success follows IndexedDB commit. Failures
 * leave the instance closed to further mutation when durability is uncertain.
 */
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
/** @brief Borrow the 4096-byte input buffer until instance disposal.
 * @return Non-null instance-owned buffer; do not free it.
 */
uint8_t *ex_input(void);
/** @brief Create or restore the endpoint using input key bytes 0..31 and a NUL-terminated serial
 * at 32.
 * @param role 1 for device or 2 for server.
 * @param fresh Nonzero creates an identity; zero requires a compatible saved store.
 * @return SC_OK or an argument, crypto, random, or storage failure. Never replaces corrupt stores.
 */
int ex_init(int role, int fresh);
/** @brief Reinitialize through saved protocol records, discarding runtime nonce cursors.
 * @return SC_OK or an initialization/storage failure; requires a ready instance.
 */
int ex_reboot(void);
/** @brief Authorize enrollment on the server; input offsets 2048/2056 hold big-endian now/expiry
 * seconds.
 * @return Core enrollment status; commits the session before success.
 */
int ex_begin(void);
/** @brief Approve server candidate; input holds 32-byte challenge/key at 0/32 and trusted time at
 * 2048.
 * @return Core approval status, rejecting stale or expired bindings; commits approval.
 */
int ex_approve(void);
/** @brief Cancel a pending server session without revoking enrolled peers.
 * @return Core cancellation status; successful cancellation persists.
 */
int ex_cancel(void);
/** @brief Set server cumulative issued credits from the uint64 at input offset 2048.
 * @return Core update status; decreasing totals fail, accepted totals persist without delivery.
 */
int ex_issue(void);
/** @brief Queue and persist an enrolled server consumption report request.
 * @return Core request status; transport remains pending.
 */
int ex_request(void);
/** @brief Spend local credits on an enrolled device and persist the new total.
 * @param amount Positive credit count; cannot exceed the remaining balance.
 * @return Core consumption status; overflow and insufficient balance fail without consumption.
 */
int ex_consume(uint64_t amount);
/** @brief Inspect public device counters without protocol or storage mutation.
 * @param issued Non-null output for cumulative credits issued.
 * @param consumed Non-null output for cumulative credits consumed.
 * @return SC_OK or inspection failure; outputs are written only on success.
 */
int ex_device_credits(uint64_t *issued, uint64_t *consumed);
/** @brief Receive input bytes using trusted server time from offset 2048.
 * @param length Number of frame bytes at input offset zero, at most 512.
 * @return Core receive status; accepted state changes persist and responses remain pending.
 */
int ex_receive(size_t length);
/** @brief Generate one pending frame, reserving nonces durably before use.
 * @return SC_OK with frame bytes, SC_NO_OUTPUT if no work, or a core/storage failure. Never
 * delivers bytes.
 */
int ex_outbound(void);
/** @brief Borrow the most recently generated frame until the next outbound call or reboot.
 * @return Non-null instance-owned bytes, limited by ex_frame_length(); do not free.
 */
const uint8_t *ex_frame(void);
/** @brief Inspect the current frame length in bytes.
 * @return Number of valid bytes in ex_frame(), zero on idle or failure.
 */
size_t ex_frame_length(void);
/** @brief Inspect JSON public state; uint64 counters are decimal strings.
 * @return Borrowed NUL-terminated text, or "null" on failure; overwritten by either inspection
 * function.
 */
const char *ex_state(void);
/** @brief Inspect human-readable device identity and balances.
 * @return Borrowed NUL-terminated text; overwritten by either inspection function. Do not free.
 */
const char *ex_device_summary(void);
/** @brief Translate a library status without accessing endpoint state.
 * @param status Core status code.
 * @return Static non-null status token; never free it.
 */
const char *ex_status(int status);
#ifdef __cplusplus
}
#endif
#endif
