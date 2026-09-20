"""Explicit Wasm build inputs, including the checksum-pinned SDK and sysroot."""
def _wasm_impl(ctx):
    output = ctx.actions.declare_file(ctx.attr.output)
    outputs = [output]
    if ctx.attr.kind == "module":
        outputs.append(ctx.actions.declare_file(ctx.attr.output.removesuffix(".mjs") + ".wasm"))
    cfg = {"kind": ctx.attr.kind, "output": output.path, "sdk": ctx.file.sdk_marker.dirname.rsplit("/", 1)[0], "sources": [f.path for f in ctx.files.sources], "sodium": ctx.file.sodium.path if ctx.file.sodium else "", "testing": ctx.attr.testing, "persistent": ctx.attr.persistent}
    ctx.actions.run(executable = "/usr/bin/python3", arguments = [ctx.file.driver.path, json.encode(cfg)], inputs = depset(ctx.files.inputs + ctx.files.sources + ctx.files.sdk + [ctx.file.driver] + ([ctx.file.sodium] if ctx.file.sodium else [])), outputs = outputs, mnemonic = "BuildWebAssembly")
    return [DefaultInfo(files = depset(outputs))]
wasm_build = rule(implementation = _wasm_impl, attrs = {"output": attr.string(), "kind": attr.string(), "sources": attr.label_list(allow_files = True), "inputs": attr.label_list(allow_files = True), "sodium": attr.label(allow_single_file = True), "testing": attr.bool(), "persistent": attr.bool(), "sdk": attr.label(default = "@emscripten_sdk//:files"), "sdk_marker": attr.label(default = "@emscripten_sdk//:bin/clang", allow_single_file = True), "driver": attr.label(default = "//web:build.py", allow_single_file = True)})

def _site_impl(ctx):
    out = ctx.actions.declare_directory(ctx.label.name)
    module = [f for f in ctx.attr.module[DefaultInfo].files.to_list() if f.extension == "mjs"][0]
    ctx.actions.run(executable = "/usr/bin/python3", arguments = [ctx.file.driver.path, "--output", out.path, "--module", module.path, "--fleet", ctx.files.fleet[0].path, "--api", ctx.files.api[0].path], inputs = depset(ctx.files.inputs + ctx.files.fleet + ctx.files.api + [ctx.file.driver], transitive = [ctx.attr.module[DefaultInfo].files]), outputs = [out], mnemonic = "AssembleDemoSite")
    return [DefaultInfo(files = depset([out]), runfiles = ctx.runfiles(files = [out]))]
demo_site = rule(implementation = _site_impl, attrs = {"inputs": attr.label_list(allow_files = True), "module": attr.label(default = "//web:module"), "fleet": attr.label(default = "//examples/fleet_manager:site"), "api": attr.label(default = "//docs:api"), "driver": attr.label(default = "//web:site.py", allow_single_file = True)})
