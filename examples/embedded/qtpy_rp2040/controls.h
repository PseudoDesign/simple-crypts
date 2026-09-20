/* Private demo button and feedback timing, independent of GPIO and flash drivers. */
#ifndef QT_CONTROLS_H
#define QT_CONTROLS_H
#include <stdbool.h>
#include <stdint.h>

typedef enum { QT_BUTTON_NONE, QT_BUTTON_CONSUME, QT_BUTTON_RESET } qt_button_event;
typedef struct {
    uint64_t changed_at, pressed_at, feedback_at;
    bool raw_down, down, armed, handled, feedback, success;
} qt_controls;

void qt_controls_init(qt_controls *controls, bool down, uint64_t now_ms);
qt_button_event qt_controls_poll(qt_controls *controls, bool down, uint64_t now_ms);
void qt_controls_result(qt_controls *controls, bool success, uint64_t now_ms);
/* Packed GRB, with low brightness; zero means off. */
uint32_t qt_controls_color(const qt_controls *controls, uint64_t now_ms);
#endif
