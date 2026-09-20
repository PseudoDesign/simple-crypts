"""Doxygen output is an explicit Bazel tree artifact, never a source mutation."""

def _api_impl(ctx):
    out = ctx.actions.declare_directory(ctx.label.name)
    ctx.actions.run(
        executable = "/usr/bin/python3",
        arguments = [ctx.file.driver.path, "--output", out.path],
        inputs = depset(ctx.files.srcs + [ctx.file.driver, ctx.file._dependency_paths]),
        outputs = [out],
        use_default_shell_env = True,
        env = {"SC_DEPENDENCY_PATHS": ctx.file._dependency_paths.path},
        mnemonic = "GenerateAPI",
    )
    return [DefaultInfo(files = depset([out]), runfiles = ctx.runfiles(files = [out]))]

api_docs = rule(implementation = _api_impl, attrs = {
    "_dependency_paths": attr.label(default = "//build:dependency_paths", allow_single_file = True),
    "srcs": attr.label_list(allow_files = True),
    "driver": attr.label(default = "//docs:build_api.py", allow_single_file = True),
})
