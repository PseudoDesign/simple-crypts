// WebAssembly-only application. The browser supplies a line of text; command
// parsing and local device operations run here in C++. The return value tells
// the owning worker when to synchronize the simulated transport or stop.
#include "examples/common/endpoint.h"
#include <emscripten/emscripten.h>
#include <cstdint>
#include <limits>
#include <sstream>
#include <string>

namespace {
char line[4097];
std::string output;
constexpr const char *help =
    "help                Show commands\n"
    "status              Show identity and credit balance\n"
    "consume <amount>    Spend credits on this device\n"
    "sync                Exchange pending messages with the server\n"
    "reboot              Restart with saved identity and credits\n"
    "quit                Stop this device";

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
}

extern "C" {
EMSCRIPTEN_KEEPALIVE char *device_line() { return line; }
EMSCRIPTEN_KEEPALIVE const char *device_output() { return output.c_str(); }

// 0=local result, 1=quit, 2=error, 3=synchronize. The worker reads output only
// after this awaited call returns, including any durable storage operations.
EMSCRIPTEN_KEEPALIVE int device_command(void) {
    output.clear();
    std::istringstream stream(line);
    std::string command, argument, extra;
    stream >> command;
    if (command.empty()) return 0;
    stream >> argument >> extra;
    if (!extra.empty() || (command == "consume" ? argument.empty() : !argument.empty())) {
        output = std::string("error: Usage\n") + help;
        return 2;
    }
    int status = 0;
    if (command == "help") output = help;
    else if (command == "status") output = ex_device_summary();
    else if (command == "sync") {
        output = "Synchronizing with server...";
        return 3;
    } else if (command == "quit") {
        output = "Stopped. Saved device state retained.";
        return 1;
    } else if (command == "reboot") {
        status = ex_reboot();
        if (status == 0) {
            output = "Rebooted. Identity and credits restored.";
            return 3;
        }
    } else if (command == "consume") {
        uint64_t value;
        if (!amount(argument, value)) {
            output = "error: Expected an unsigned decimal uint64";
            return 2;
        }
        status = ex_consume(value);
        if (status == 0)
            output = "Consumed " + std::to_string(value) + " credits. Server learns this on its next report request.";
    } else {
        output = "error: Unknown command. Type help for available commands.";
        return 2;
    }
    if (status < 0) {
        output = std::string("error: ") + ex_status(status);
        return 2;
    }
    return 0;
}
}
