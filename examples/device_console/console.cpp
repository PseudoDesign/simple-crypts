// WebAssembly-only application. The browser supplies a line of text; command
// parsing and local device operations run here in C++. The return value tells
// the owning worker when to synchronize the simulated transport or stop.
#include "examples/common/endpoint.h"
#include "examples/device_console/console.h"
#include "core/sc.h"
#include <emscripten/emscripten.h>
#include <cstdint>
#include <limits>
#include <sstream>
#include <string>

namespace {
char line[4097];
std::string output;
constexpr const char *help = "help                Show commands\n"
                             "status              Show identity and credit balance\n"
                             "consume <amount>    Spend credits on this device\n"
                             "sync                Exchange pending messages with the server\n"
                             "reboot              Restart with saved identity and credits\n"
                             "quit                Stop this device";

// These explanations belong to the example application. The public library's
// status codes and its validation/storage behavior remain unchanged.
std::string explain(int status) {
    switch (status) {
    case SC_ERR_ENROLLMENT:
        return "Device enrollment is not confirmed. Authorize enrollment and approve "
               "this device in the fleet table, then connect it or run sync.";
    case SC_ERR_STORAGE:
        return "Could not safely read or save device state. Check that browser storage "
               "is available, then reload the page to reopen saved state.";
    case SC_ERR_EXHAUSTED:
        return "A device counter has reached its maximum (18446744073709551615). "
               "This saved device cannot perform another update with that counter.";
    case SC_ERR_CONFLICT:
        return "The requested update conflicts with saved device state. "
               "Run status to inspect the current values.";
    case SC_ERR_ARGUMENT:
        return "Invalid command argument. Type help for usage and examples.";
    case SC_ERR_BOUNDS:
        return "The command exceeds the supported data size.";
    case SC_ERR_AUTH:
        return "Message authentication failed. Check that the message belongs "
               "to this device and its pinned server identity.";
    case SC_ERR_PROTOCOL:
        return "The message is malformed or incompatible with this protocol.";
    case SC_ERR_RANDOM:
        return "Secure randomness is unavailable. Use a supported browser over HTTPS or localhost.";
    case SC_ERR_ROLE:
        return "This operation is not allowed for a device endpoint.";
    case SC_ERR_UTF8:
        return "The command contains invalid text encoding.";
    case SC_ERR_CRYPTO:
        return "A cryptographic operation failed; the command could not complete.";
    default:
        return std::string("The command failed (") + ex_status(status) + ").";
    }
}

bool amount(const std::string &text, uint64_t &value) {
    value = 0;
    if (text.empty() || text.size() > 20) {
        return false;
    }
    for (char c : text) {
        if (c < '0' || c > '9' || value > (std::numeric_limits<uint64_t>::max() - (c - '0')) / 10) {
            return false;
        }
        value = value * 10 + (c - '0');
    }
    return true;
}
} // namespace

extern "C" {
EMSCRIPTEN_KEEPALIVE char *device_line() {
    return line;
}
EMSCRIPTEN_KEEPALIVE const char *device_output() {
    return output.c_str();
}

// 0=local result, 1=quit, 2=error, 3=synchronize. The worker reads output only
// after this awaited call returns, including any durable storage operations.
EMSCRIPTEN_KEEPALIVE int device_command(void) {
    output.clear();
    std::istringstream stream(line);
    std::string command, argument, extra;
    stream >> command;
    if (command.empty()) {
        return 0;
    }
    stream >> argument >> extra;
    if (!extra.empty() || (command == "consume" ? argument.empty() : !argument.empty())) {
        output = command == "consume"
                     ? "error: Usage: consume <amount>. Enter one positive whole number, for "
                       "example: consume 25."
                     : "error: " + command +
                           " does not accept arguments. Type help for available commands.";
        return 2;
    }
    int status = 0;
    if (command == "help") {
        output = help;
    } else if (command == "status") {
        output = ex_device_summary();
    } else if (command == "sync") {
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
        if (!amount(argument, value) || value == 0) {
            output = "error: Invalid credit amount. Enter a positive whole number from 1 to "
                     "18446744073709551615, without signs, decimals, or separators. Example: "
                     "consume 25.";
            return 2;
        }
        status = ex_consume(value);
        if (status == SC_OK) {
            output = "Consumed " + std::to_string(value) +
                     " credits. Server learns this on its next report request.";
        } else {
            uint64_t issued = 0, consumed = 0;
            // Inspect only after the core rejects the operation. Storage and
            // enrollment failures must not be mislabeled as a low balance.
            if (ex_device_credits(&issued, &consumed) == SC_OK) {
                if (status == SC_ERR_CONFLICT && issued >= consumed && value > issued - consumed) {
                    output = "error: Insufficient credits: requested " + std::to_string(value) +
                             ", available " + std::to_string(issued - consumed) +
                             ". No credits consumed. Increase the cumulative credits issued in the "
                             "fleet table, then connect this device or run sync.";
                    return 2;
                }
                if (status == SC_ERR_EXHAUSTED &&
                    value > std::numeric_limits<uint64_t>::max() - consumed) {
                    output = "error: Cannot consume " + std::to_string(value) +
                             " credits: lifetime consumption is " + std::to_string(consumed) +
                             " and would exceed the maximum of 18446744073709551615. No credits "
                             "consumed.";
                    return 2;
                }
            }
        }
    } else {
        output = "error: Unknown command. Type help for available commands.";
        return 2;
    }
    if (status < 0) {
        output = "error: Cannot complete " + command + ". " + explain(status);
        return 2;
    }
    return 0;
}
}
