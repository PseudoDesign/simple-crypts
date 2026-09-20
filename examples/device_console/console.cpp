// This application is compiled only to WebAssembly. The browser supplies a
// line of text; all command parsing and device operations happen here in C++.
#include "examples/common/endpoint.h"
#include <emscripten/emscripten.h>
#include <cstdint>
#include <cstring>
#include <limits>
#include <sstream>
#include <string>

namespace {
char line[4097];
std::string output;
constexpr const char *help =
    "help | status | consume <amount> | rx <hex> | tx | reboot | quit";

bool amount(const std::string &text, uint64_t &value) {
    value = 0;
    if (text.empty() || text.size() > 20) return false;
    for (char c : text) {
        if (c < '0' || c > '9' ||
            value > (std::numeric_limits<uint64_t>::max() - (c - '0')) / 10)
            return false;
        value = value * 10 + (c - '0');
    }
    return true;
}

int nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}
}

extern "C" {
EMSCRIPTEN_KEEPALIVE char *device_line() { return line; }
EMSCRIPTEN_KEEPALIVE const char *device_output() { return output.c_str(); }

// Return 1 only for quit. The owner then discards this instance while retaining
// its saved identity. Output is read only after the awaited call completes.
EMSCRIPTEN_KEEPALIVE int device_command(void) {
    output.clear();
    std::istringstream stream(line);
    std::string command, argument, extra;
    stream >> command;
    if (command.empty()) return 0;
    stream >> argument;
    stream >> extra;
    const bool unary = command == "consume" || command == "rx";
    if (!extra.empty() || (unary ? argument.empty() : !argument.empty())) {
        output = std::string("error: ") + help;
        return 0;
    }
    int status = 0;
    if (command == "help") output = help;
    else if (command == "status") output = ex_state();
    else if (command == "quit") {
        output = "Stopped. Saved device state retained.";
        return 1;
    } else if (command == "reboot") status = ex_reboot();
    else if (command == "consume") {
        uint64_t value;
        if (!amount(argument, value)) {
            output = "error: Expected an unsigned decimal uint64";
            return 0;
        }
        status = ex_consume(value);
    } else if (command == "rx") {
        if (argument.size() > 1024 || argument.size() % 2) {
            output = "error: Expected 1–512 bytes of contiguous hexadecimal text";
            return 0;
        }
        for (size_t i = 0; i < argument.size(); i += 2) {
            int high = nibble(argument[i]), low = nibble(argument[i + 1]);
            if (high < 0 || low < 0) {
                output = "error: Invalid hexadecimal frame";
                return 0;
            }
            ex_input()[i / 2] = static_cast<uint8_t>((high << 4) | low);
        }
        status = ex_receive(argument.size() / 2);
    } else if (command == "tx") {
        status = ex_outbound();
        if (status == 1) output = "No output.";
        else if (status == 0) {
            const char *digits = "0123456789abcdef";
            for (size_t i = 0; i < ex_frame_length(); ++i) {
                output += digits[ex_frame()[i] >> 4];
                output += digits[ex_frame()[i] & 15];
            }
        }
    } else output = std::string("error: ") + help;
    if (status < 0) output = std::string("error: ") + ex_status(status);
    else if (output.empty()) output = "ok";
    return 0;
}
}
