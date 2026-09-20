"""Build a standalone static example, also consumed by the main site build."""
def _site_impl(ctx):
    out = ctx.actions.declare_directory(ctx.label.name)
    files = ctx.files.assets + ctx.files.server + ctx.files.device
    ctx.actions.run(
        executable = "/usr/bin/python3",
        arguments = [ctx.file.driver.path, out.path] + [f.path for f in files],
        inputs = files + [ctx.file.driver],
        outputs = [out],
        mnemonic = "AssembleFleetExample",
    )
    return [DefaultInfo(files = depset([out]), runfiles = ctx.runfiles(files = [out]))]

fleet_site = rule(implementation = _site_impl, attrs = {
    "assets": attr.label_list(allow_files = True),
    "server": attr.label(default = "//examples/fleet_manager:module"),
    "device": attr.label(default = "//examples/device_console:module"),
    "driver": attr.label(default = "//examples/fleet_manager:site.py", allow_single_file = True),
})
