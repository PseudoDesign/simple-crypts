#include "controls.h"
#include <string.h>

void qt_controls_init(qt_controls *c, bool down, uint64_t now) {
    memset(c, 0, sizeof *c);
    c->raw_down = down;
    c->down = down;
    c->armed = !down;
    c->changed_at = now;
}
qt_button_event qt_controls_poll(qt_controls *c, bool down, uint64_t now) {
    if (down != c->raw_down) {
        c->raw_down = down;
        c->changed_at = now;
    }
    if (c->raw_down != c->down && now - c->changed_at >= 30) {
        c->down = c->raw_down;
        if (c->down) {
            c->pressed_at = c->changed_at;
            c->handled = false;
        } else {
            bool act = c->armed && !c->handled;
            c->armed = true;
            c->handled = false;
            if (act) {
                /* Never infer a reset from a late release observed after blocking work. */
                return c->changed_at - c->pressed_at >= 5000 ? QT_BUTTON_NONE : QT_BUTTON_CONSUME;
            }
        }
    }
    if (c->armed && c->down && c->raw_down && !c->handled && now - c->pressed_at >= 5000) {
        c->handled = true;
        return QT_BUTTON_RESET;
    }
    return QT_BUTTON_NONE;
}
void qt_controls_result(qt_controls *c, bool success, uint64_t now) {
    c->feedback = true;
    c->success = success;
    c->feedback_at = now;
}
uint32_t qt_controls_color(const qt_controls *c, uint64_t now) {
    if (!c->feedback) {
        return 0;
    }
    uint64_t elapsed = now - c->feedback_at;
    if (c->success) {
        return elapsed < 200 ? 0x100000u : 0;
    }
    return elapsed < 900 && (elapsed / 150) % 2 == 0 ? 0x001000u : 0;
}
