#include "app.h"
#include "controls.h"
#include "hardware/clocks.h"
#include "hardware/pio.h"
#include "entropy.h"
#include "hardware/flash.h"
#include "hardware/watchdog.h"
#include "pico/flash.h"
#include "pico/stdio.h"
#include "pico/stdio_usb.h"
#include "pico/stdlib.h"
#include "pico/unique_id.h"
#include <string.h>

static qt_app app;
static int supported;
static qt_controls controls;
static uint led_sm;
static uint32_t led_color = UINT32_MAX;
static uint64_t led_next_write;
static uint8_t rx[1030], decoded[QT_MESSAGE_MAX], reply[QT_MESSAGE_MAX], tx[1030];
typedef struct {
    uint32_t offset;
    const uint8_t *bytes;
    unsigned op;
    uint8_t id[4];
} flash_job;
static void __not_in_flash_func(flash_run)(void *arg) {
    flash_job *job = arg;
    if (job->op == 0) {
        flash_range_erase(QT_NVM_OFFSET + job->offset, QT_SECTOR);
    } else if (job->op == 1) {
        flash_range_program(QT_NVM_OFFSET + job->offset, job->bytes, QT_PAGE);
    } else {
        uint8_t command[4] = {0x9f, 0, 0, 0};
        flash_do_cmd(command, job->id, 4);
    }
}
static int read_flash(void *u, uint32_t at, void *out, size_t n) {
    (void)u;
    if (!supported || at > 3 * QT_SECTOR || n > 3 * QT_SECTOR - at) {
        return -1;
    }
    const volatile uint8_t *source = (const volatile uint8_t *)(XIP_BASE + QT_NVM_OFFSET + at);
    uint8_t *destination = out;
    for (size_t i = 0; i < n; ++i) {
        destination[i] = source[i];
    }
    return 0;
}
static int erase_flash(void *u, uint32_t at) {
    (void)u;
    if (!supported || at % QT_SECTOR || at >= 3 * QT_SECTOR) {
        return -1;
    }
    flash_job job = {.offset = at, .op = 0};
    return flash_safe_execute(flash_run, &job, 1000);
}
static int program_flash(void *u, uint32_t at, const void *bytes, size_t n) {
    (void)u;
    if (!supported || at % QT_PAGE || n != QT_PAGE || at > 3 * QT_SECTOR - n) {
        return -1;
    }
    flash_job job = {.offset = at, .bytes = bytes, .op = 1};
    return flash_safe_execute(flash_run, &job, 1000);
}
void qt_entropy_fault(void) {
    sodium_memzero(&app, sizeof app);
    sodium_memzero(decoded, sizeof decoded);
    sodium_memzero(rx, sizeof rx);
    sodium_memzero(reply, sizeof reply);
    sodium_memzero(tx, sizeof tx);
    watchdog_reboot(0, 0, 1);
    for (;;) {
        tight_loop_contents();
    }
}
/* Same four-instruction waveform as Raspberry Pi's BSD-3-Clause ws2812 example.
 * Encode with SDK helpers so this firmware still needs no host pioasm executable.
 * T1=3, T2=3, T3=4 at 8 MHz: 800 kbit/s, MSB-first GRB, 24 bits per pixel. */
static void led_init(void) {
    const uint16_t instructions[] = {
        pio_encode_out(pio_x, 1) | pio_encode_sideset(1, 0) | pio_encode_delay(3),
        pio_encode_jmp_not_x(3) | pio_encode_sideset(1, 1) | pio_encode_delay(2),
        pio_encode_jmp(0) | pio_encode_sideset(1, 1) | pio_encode_delay(2),
        pio_encode_nop() | pio_encode_sideset(1, 0) | pio_encode_delay(2),
    };
    const struct pio_program program = {.instructions = instructions, .length = 4, .origin = -1};
    uint offset = pio_add_program(pio0, &program);
    led_sm = (uint)pio_claim_unused_sm(pio0, true);
    gpio_init(PICO_DEFAULT_WS2812_POWER_PIN);
    gpio_set_dir(PICO_DEFAULT_WS2812_POWER_PIN, GPIO_OUT);
    gpio_put(PICO_DEFAULT_WS2812_POWER_PIN, true);
    pio_gpio_init(pio0, PICO_DEFAULT_WS2812_PIN);
    pio_sm_set_consecutive_pindirs(pio0, led_sm, PICO_DEFAULT_WS2812_PIN, 1, true);
    pio_sm_config config = pio_get_default_sm_config();
    sm_config_set_wrap(&config, offset, offset + 3);
    sm_config_set_sideset(&config, 1, false, false);
    sm_config_set_sideset_pins(&config, PICO_DEFAULT_WS2812_PIN);
    sm_config_set_out_shift(&config, false, true, 24);
    sm_config_set_fifo_join(&config, PIO_FIFO_JOIN_TX);
    uint32_t divider = (uint32_t)((uint64_t)clock_get_hz(clk_sys) * 256 / 8000000);
    sm_config_set_clkdiv_int_frac(&config, divider >> 8, divider & 255);
    pio_sm_init(pio0, led_sm, offset, &config);
    pio_sm_set_enabled(pio0, led_sm, true);
    led_next_write = time_us_64() + 1000; /* Power-up settling before the first frame. */
}
static void led_poll(void) {
    uint64_t now = time_us_64();
    uint32_t color = qt_controls_color(&controls, now / 1000);
    if (color != led_color && now >= led_next_write && !pio_sm_is_tx_fifo_full(pio0, led_sm)) {
        pio_sm_put(pio0, led_sm, color << 8);
        led_color = color;
        /* 30us data plus at least 300us low latch time, including fast result changes. */
        led_next_write = now + 1000;
    }
}
static void button_poll(void) {
    qt_button_event event = qt_controls_poll(&controls, !gpio_get(21), time_us_64() / 1000);
    if (event == QT_BUTTON_NONE) {
        return;
    }
    uint8_t amount[8] = {0, 0, 0, 0, 0, 0, 0, 1}, unused;
    size_t length;
    int rc = qt_app_command(&app, event == QT_BUTTON_RESET ? QT_RESET : QT_CONSUME, amount,
                            event == QT_BUTTON_RESET ? 0 : sizeof amount, &unused, sizeof unused,
                            &length);
    qt_controls_result(&controls, rc == SC_OK, time_us_64() / 1000);
    if (rc == SC_OK && event == QT_BUTTON_RESET) {
        qt_entropy_fault();
    }
}
extern uint32_t __StackBottom, __StackTop;
static void stack_mark(void) {
    uintptr_t sp;
    __asm volatile("mrs %0, msp" : "=r"(sp));
    volatile uint32_t *p = &__StackBottom;
    while ((uintptr_t)p + 256 < sp) {
        *p++ = 0xa55ac33cu;
    }
}
static uint32_t stack_used(void) {
    const volatile uint32_t *p = &__StackBottom;
    while (p < &__StackTop && *p == 0xa55ac33cu) {
        ++p;
    }
    return (uint32_t)((uintptr_t)&__StackTop - (uintptr_t)p);
}
static void message(size_t n) {
    app.stack_high_water = stack_used();
    n = qt_cobs_decode(rx, n, decoded, sizeof decoded);
    size_t length = qt_rpc(&app, decoded, n, reply, sizeof reply);
    sodium_memzero(decoded, sizeof decoded);
    if (!length) {
        return;
    }
    size_t encoded = qt_cobs_encode(reply, length, tx, sizeof tx);
    stdio_put_string((const char *)tx, (int)encoded, false, false);
    if (app.reboot) {
        stdio_flush();
        sleep_ms(100);
        sodium_memzero(&app, sizeof app);
        watchdog_reboot(0, 0, 1);
        for (;;) {
            tight_loop_contents();
        }
    }
}
int main(void) {
    stack_mark();
    stdio_init_all();
    stdio_set_translate_crlf(&stdio_usb, false);
    gpio_init(21);
    gpio_set_dir(21, GPIO_IN);
    gpio_pull_up(21);
    qt_controls_init(&controls, !gpio_get(21), time_us_64() / 1000);
    led_init();
    flash_job identify = {.op = 2};
    int rc = flash_safe_execute(flash_run, &identify, 1000);
    supported = !rc && (identify.id[1] == 0xef || identify.id[1] == 0xc8) &&
                identify.id[2] == 0x40 && identify.id[3] == 0x17;
    char serial[33] = "qtpy-";
    pico_get_unique_board_id_string(serial + 5, sizeof serial - 5);
    qt_flash flash = {NULL, read_flash, erase_flash, program_flash};
    qt_app_open(&app, &flash, serial);
    app.flash_jedec =
        (uint32_t)identify.id[1] << 16 | (uint32_t)identify.id[2] << 8 | identify.id[3];
    size_t used = 0;
    int overflow = 0;
    for (;;) {
        int ch = getchar_timeout_us(0);
        if (ch >= 0) {
            if (!ch) {
                if (!overflow && used) {
                    message(used);
                }
                sodium_memzero(rx, sizeof rx);
                used = 0;
                overflow = 0;
            } else if (used < sizeof rx && !overflow) {
                rx[used++] = (uint8_t)ch;
            } else {
                overflow = 1;
            }
        }
        button_poll();
        led_poll();
        tight_loop_contents();
    }
}
