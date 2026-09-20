#ifndef EXAMPLE_CONSOLE_H
#define EXAMPLE_CONSOLE_H
/** @file
 * @brief WebAssembly command interface; one worker owns and serializes each instance.
 * @ingroup examples
 */
#ifdef __cplusplus
extern "C" {
#endif
/** @brief Borrow input space for one NUL-terminated UTF-8 command.
 * @return Non-null instance-owned 4097-byte buffer; at most 4096 command bytes.
 */
char *device_line(void);
/** @brief Read output after awaiting device_command().
 * @return Borrowed NUL-terminated text, invalidated by the next command; do not free.
 */
const char *device_output(void);
/** @brief Parse the input line and execute a local command on the initialized device.
 * The worker must await durable storage completion before inspecting output.
 * A sync result requests transport from the worker; this call never transfers frames.
 * @return 0 local success, 1 quit, 2 error with output text, or 3 transport requested.
 */
int device_command(void);
#ifdef __cplusplus
}
#endif
#endif
