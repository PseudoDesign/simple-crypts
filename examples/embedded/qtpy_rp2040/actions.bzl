"""Direct hermetic Python actions, without platform launcher binaries."""

def _runtime_impl(ctx):
    return [ctx.toolchains["@rules_python//python:toolchain_type"]]

runtime_tool = rule(implementation = _runtime_impl, toolchains = ["@rules_python//python:toolchain_type"])

def _python_impl(ctx):
    runtime = ctx.attr._runtime[platform_common.ToolchainInfo].py3_runtime
    args = [ctx.file.script.path] + [ctx.expand_location(a, targets = ctx.attr.srcs) for a in ctx.attr.args]
    ctx.actions.run(executable = runtime.interpreter, arguments = args, inputs = depset([ctx.file.script] + ctx.files.srcs, transitive = [runtime.files]), outputs = ctx.outputs.outs, mnemonic = "FirmwarePython")
    return [DefaultInfo(files = depset(ctx.outputs.outs))]

python_action = rule(implementation = _python_impl, attrs = {"script": attr.label(allow_single_file = True), "srcs": attr.label_list(allow_files = True), "outs": attr.output_list(), "args": attr.string_list(), "_runtime": attr.label(default = Label("//examples/embedded/qtpy_rp2040:python_runtime"), cfg = "exec")})

def _empty_impl(ctx):
    ctx.actions.write(ctx.outputs.out, "")

empty_file = rule(implementation = _empty_impl, attrs = {"out": attr.output()})
