#include "controls.h"
#include <assert.h>

int main(void) {
    qt_controls c;
    qt_controls_init(&c, false, 0);
    /* Contact bounce and sub-30ms pulses cannot spend credits. */
    assert(qt_controls_poll(&c, true, 10) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 20) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 60) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, true, 100) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, true, 130) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 200) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, true, 210) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 220) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 249) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 250) == QT_BUTTON_CONSUME);
    assert(qt_controls_poll(&c, false, 300) == QT_BUTTON_NONE);
    /* A long hold emits only reset, even if reset fails and the user keeps holding. */
    assert(qt_controls_poll(&c, true, 1000) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, true, 1030) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, true, 5999) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, true, 6000) == QT_BUTTON_RESET);
    assert(qt_controls_poll(&c, true, 7000) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 7100) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 7130) == QT_BUTTON_NONE);
    /* Release debounce must not turn a just-short hold into a reset. */
    assert(qt_controls_poll(&c, true, 8000) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, true, 8030) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 12999) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 13029) == QT_BUTTON_CONSUME);
    /* A late release after blocking work must neither reset nor spend a credit. */
    assert(qt_controls_poll(&c, true, 14000) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, true, 14030) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 19500) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 19530) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 19600) == QT_BUTTON_NONE);
    /* A button already held at boot requires a release before any action. */
    qt_controls_init(&c, true, 0);
    assert(qt_controls_poll(&c, true, 6000) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 6100) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 6130) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, true, 6200) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, true, 6230) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 6300) == QT_BUTTON_NONE);
    assert(qt_controls_poll(&c, false, 6330) == QT_BUTTON_CONSUME);
    /* Feedback is nonblocking, bounded, and the latest result replaces the previous one. */
    assert(qt_controls_color(&c, 6400) == 0);
    qt_controls_result(&c, true, 6500);
    assert(qt_controls_color(&c, 6500) == 0x100000u);
    assert(qt_controls_color(&c, 6699) == 0x100000u);
    assert(qt_controls_color(&c, 6700) == 0);
    qt_controls_result(&c, false, 7000);
    for (uint64_t i = 0; i < 6; ++i) {
        assert(qt_controls_color(&c, 7000 + i * 150) == (i % 2 == 0 ? 0x001000u : 0));
    }
    assert(qt_controls_color(&c, 7900) == 0);
    qt_controls_result(&c, true, 7950);
    assert(qt_controls_color(&c, 7950) == 0x100000u);
    return 0;
}
