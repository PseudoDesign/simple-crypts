"""Use the firmware's real CcInfo headers and definitions in the existing C lint gate."""

load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("//build:defs.bzl", "AnalysisInfo")

_SETTINGS = {
    "//command_line_option:platforms": "@pico-sdk//bazel/platform:rp2040",
    "@pico-sdk//bazel/config:PICO_BOARD": "adafruit_qtpy_rp2040",
    "@pico-sdk//bazel/config:PICO_STDIO_USB": True,
    "@pico-sdk//bazel/config:PICO_STDIO_UART": False,
    "@pico-sdk//bazel/config:PICO_TINYUSB_LIB": "@qtpy_tinyusb//:tinyusb",
}

def _transition_impl(_settings, _attr):
    return _SETTINGS

_board = transition(implementation = _transition_impl, inputs = [], outputs = _SETTINGS.keys())

def _impl(ctx):
    compilation = ctx.attr.firmware[0][CcInfo].compilation_context
    headers = compilation.headers.to_list()
    includes = compilation.includes.to_list() + compilation.system_includes.to_list() + compilation.quote_includes.to_list()
    commands = [dict(
        file = ctx.file.source.short_path,
        includes = includes,
        copts = ["-D" + value for value in compilation.defines.to_list()] + [
            "-std=gnu17",
            "-DPICO_STACK_SIZE=32768",
            "-DPICO_CORE1_STACK_SIZE=0",
            "-DPICO_FLASH_ASSUME_CORE1_SAFE=1",
            "-DPICO_STDIO_USB_DEFAULT_CRLF=0",
            "-DPICO_ENABLE_USB_RESET_VIA_BAUD_RATE=0",
            "-DPICO_ENABLE_USB_RESET_VIA_VENDOR_INTERFACE=0",
        ],
        profile = "rp2040",
    )]
    return [
        AnalysisInfo(commands = commands),
        DefaultInfo(files = depset(headers), runfiles = ctx.runfiles(symlinks = {f.path: f for f in headers})),
    ]

board_analysis = rule(
    implementation = _impl,
    attrs = {
        "source": attr.label(allow_single_file = [".c"]),
        "firmware": attr.label(cfg = _board, providers = [CcInfo]),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)
