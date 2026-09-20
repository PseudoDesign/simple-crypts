"""Small explicit build rules; system C/Python plus pinned downloaded Go/Rust SDKs.

Every source, library, generator, and SDK file is declared as an action input.
The C and ARM compilers are deliberately system prerequisites, not hermetic.
"""

CLibraryInfo = provider("Compiled C archives, headers, include paths and analysis commands.", fields = ["archives", "headers", "includes", "commands"])

AnalysisInfo = provider("Compilation commands for native, ARM and Wasm analysis.", fields = ["commands"])

def _commands(ctx):
    return [dict(file = f.short_path, includes = _includes(ctx).to_list(), copts = ctx.attr.copts, profile = "native") for f in ctx.files.srcs] + [c for d in ctx.attr.deps for c in d[CLibraryInfo].commands]

def _inputs(ctx):
    return depset(ctx.files.srcs + ctx.files.hdrs, transitive = [d[CLibraryInfo].headers for d in ctx.attr.deps])

def _includes(ctx):
    return depset(["."] + ctx.attr.includes, transitive = [d[CLibraryInfo].includes for d in ctx.attr.deps])

def _compile(ctx, output, mode):
    archives = depset(transitive = [d[CLibraryInfo].archives for d in ctx.attr.deps])
    inputs = depset([ctx.file._driver], transitive = [_inputs(ctx), archives])
    config = {"srcs": [s.path for s in ctx.files.srcs], "includes": _includes(ctx).to_list(), "libraries": [a.path for a in archives.to_list()], "output": output.path, "mode": mode, "copts": ctx.attr.copts, "linkopts": ctx.attr.linkopts}
    ctx.actions.run(executable = "/usr/bin/python3", arguments = [ctx.file._driver.path, "cc", json.encode(config)], inputs = inputs, outputs = [output], mnemonic = "CompileC", progress_message = "Compiling %s" % ctx.label)

def _library_impl(ctx):
    out = ctx.actions.declare_file("lib" + ctx.label.name + ".a")
    _compile(ctx, out, "archive")
    return [DefaultInfo(files = depset([out])), CLibraryInfo(archives = depset([out], transitive = [d[CLibraryInfo].archives for d in ctx.attr.deps]), headers = _inputs(ctx), includes = _includes(ctx), commands = _commands(ctx)), AnalysisInfo(commands = _commands(ctx))]

def _binary_impl(ctx):
    out = ctx.actions.declare_file(ctx.attr.output_name or (ctx.label.name + (".so" if ctx.attr.shared else "")))
    _compile(ctx, out, "shared" if ctx.attr.shared else "binary")
    return [DefaultInfo(files = depset([out]), executable = out, runfiles = ctx.runfiles(files = ctx.files.data)), AnalysisInfo(commands = _commands(ctx))]

_c_attrs = {
    "srcs": attr.label_list(allow_files = [".c"]),
    "hdrs": attr.label_list(allow_files = True),
    "deps": attr.label_list(providers = [CLibraryInfo]),
    "includes": attr.string_list(),
    "copts": attr.string_list(),
    "linkopts": attr.string_list(),
    "_driver": attr.label(default = "//tools:build_action.py", allow_single_file = True),
}
c_library = rule(implementation = _library_impl, attrs = _c_attrs)
c_binary = rule(implementation = _binary_impl, attrs = dict(_c_attrs, shared = attr.bool(), output_name = attr.string(), data = attr.label_list(allow_files = True)), executable = True)
c_test = rule(implementation = _binary_impl, attrs = dict(_c_attrs, shared = attr.bool(), output_name = attr.string(), data = attr.label_list(allow_files = True)), executable = True, test = True)

def _sodium_impl(ctx):
    out = ctx.actions.declare_file("libsodium" + ("_arm" if ctx.attr.arm else "") + ".a")
    stack = ctx.actions.declare_file(ctx.label.name + "_stack.txt")
    config = {"source": ctx.file.configure.dirname, "output": out.path, "stack": stack.path, "arm": ctx.attr.arm}
    ctx.actions.run(executable = "/usr/bin/python3", arguments = [ctx.file._driver.path, "sodium", json.encode(config)], inputs = depset(ctx.files.srcs + [ctx.file._driver]), outputs = [out, stack], mnemonic = "BuildSodium", progress_message = "Building pinned libsodium %s" % ("Cortex-M4" if ctx.attr.arm else "host"))
    return [DefaultInfo(files = depset([out, stack])), CLibraryInfo(archives = depset([out]), headers = depset(ctx.files.hdrs), includes = depset([ctx.file.configure.dirname + "/src/libsodium/include", ctx.file.configure.dirname + "/src/libsodium/include/sodium"]), commands = [])]

sodium_library = rule(implementation = _sodium_impl, attrs = {"srcs": attr.label_list(allow_files = True), "hdrs": attr.label_list(allow_files = True), "configure": attr.label(allow_single_file = True), "arm": attr.bool(), "_driver": attr.label(default = "//tools:build_action.py", allow_single_file = True)})

def _script_impl(ctx):
    out = ctx.actions.declare_file(ctx.label.name)
    main = ctx.file.main.short_path
    python_root = ctx.file._python_marker.short_path.rsplit("/", 2)[0]
    shared = ctx.file.shared.short_path if ctx.file.shared else ""
    code = "#!/usr/bin/python3\nimport os,runpy,sys\nfrom pathlib import Path\nr=Path(os.environ.get('RUNFILES_DIR',str(Path(__file__))+'.runfiles'))/'_main'\np=r/%r\nos.chdir(r)\npaths=[str(p),str(r),str(r/'tests'),str((r/%r).parent),str(r/'bindings/python')]\nsys.path[:0]=paths\nos.environ['PYTHONPATH']=os.pathsep.join(paths+[os.environ.get('PYTHONPATH','')])\nshared=%r\nif shared:\n os.environ['SIMPLECRYPTS_LIB']=str(r/shared)\n os.environ['LD_LIBRARY_PATH']=str((r/shared).parent)+os.pathsep+os.environ.get('LD_LIBRARY_PATH','')\nsys.argv=[str(r/%r)]+%r+sys.argv[1:]\nrunpy.run_path(str(r/%r),run_name='__main__')\n" % (python_root, main, shared, main, ctx.attr.script_args, main)

    # Nested adapters share this executable's declared runfiles. Bazel test
    # supplies RUNFILES_DIR, but bazel run need not; export the resolved root.
    code = code.replace("os.chdir(r)\n", "os.environ['RUNFILES_DIR']=str(r.parent)\nos.chdir(r)\n")
    ctx.actions.write(out, code, is_executable = True)
    runfiles = ctx.runfiles(files = ctx.files.data + [ctx.file.main] + ctx.files._python_packages + ([ctx.file.shared] if ctx.file.shared else []))
    for d in ctx.attr.data:
        runfiles = runfiles.merge(d[DefaultInfo].default_runfiles)
    return [DefaultInfo(executable = out, runfiles = runfiles)]

_script_attrs = {"main": attr.label(allow_single_file = True), "data": attr.label_list(allow_files = True), "script_args": attr.string_list(), "shared": attr.label(allow_single_file = True), "_python_packages": attr.label(default = "@python_packages//:files"), "_python_marker": attr.label(default = "@python_packages//:cffi/__init__.py", allow_single_file = True)}
py_binary = rule(implementation = _script_impl, attrs = _script_attrs, executable = True)
py_test = rule(implementation = _script_impl, attrs = _script_attrs, test = True)

def _sdk_binary_impl(ctx):
    out = ctx.actions.declare_file(ctx.label.name + ".bin")
    launcher = ctx.actions.declare_file(ctx.label.name)
    shared = ctx.file.shared
    config = {
        "kind": ctx.attr.kind,
        "module": ctx.attr.module,
        "output": out.path,
        "sdk": ctx.file.sdk_marker.dirname.rsplit("/", 1)[0],
        "shared": shared.path if shared else "",
        "binary": ctx.attr.binary,
        "test_build": ctx.attr.test_build,
        "quality": ctx.attr.quality,
        "sources": [s.path for s in ctx.files.srcs],
    }
    ctx.actions.run(executable = "/usr/bin/python3", arguments = [ctx.file._driver.path, "sdk_binary", json.encode(config)], inputs = depset(ctx.files.srcs + ctx.files.sdk + [ctx.file._driver] + ([shared] if shared else [])), outputs = [out], mnemonic = "CompileSDK", progress_message = "Compiling %s adapter" % ctx.attr.kind)
    code = "#!/usr/bin/python3\nimport os,sys\nfrom pathlib import Path\nr=Path(os.environ.get('RUNFILES_DIR',str(Path(__file__))+'.runfiles'))/'_main'\ns=%r\nif s: os.environ['LD_LIBRARY_PATH']=str((r/s).parent)+os.pathsep+os.environ.get('LD_LIBRARY_PATH','')\nos.execv(str(r/%r),[str(r/%r)]+sys.argv[1:])\n" % (shared.short_path if shared else "", out.short_path, out.short_path)
    ctx.actions.write(launcher, code, is_executable = True)
    return [DefaultInfo(executable = launcher, runfiles = ctx.runfiles(files = [out] + ([shared] if shared else [])))]

_sdk_attrs = {
    "kind": attr.string(),
    "module": attr.string(),
    "binary": attr.string(),
    "srcs": attr.label_list(allow_files = True),
    "sdk": attr.label(),
    "sdk_marker": attr.label(allow_single_file = True),
    "shared": attr.label(allow_single_file = True),
    "test_build": attr.bool(default = False),
    "quality": attr.bool(default = False),
    "_driver": attr.label(default = "//tools:build_action.py", allow_single_file = True),
}
sdk_binary = rule(implementation = _sdk_binary_impl, executable = True, attrs = _sdk_attrs)
sdk_test = rule(implementation = _sdk_binary_impl, test = True, attrs = _sdk_attrs)

def conformance_matrix(name):
    """Create all cross-language endpoint-pair tests.

    Args:
        name: Prefix for the sixteen pairing target names.
    """
    for device in ["c", "python", "rust", "go"]:
        for server in ["c", "python", "rust", "go"]:
            adapters = ["//adapters/%s:adapter" % device]
            if server != device:
                adapters.append("//adapters/%s:adapter" % server)
            py_test(name = "%s_%s_%s" % (name, device, server), main = "conformance.py", data = ["coordinator.py"] + adapters, script_args = ["--device", "adapters/%s/adapter" % device, "--server", "adapters/%s/adapter" % server])

def _resource_report_impl(ctx):
    outputs = [ctx.actions.declare_file(name) for name in ["resource_report.md", "resource_report.json", "probe.elf", "probe.map", "stack_usage.txt", "size.txt"]]
    archive = ctx.attr.sodium[CLibraryInfo].archives.to_list()[0]
    sodium_files = ctx.attr.sodium[DefaultInfo].files.to_list()
    stack = [f for f in sodium_files if f.basename.endswith("_stack.txt")][0]
    config = {
        "sources": [f.path for f in ctx.files.srcs if f.extension == "c"],
        "archive": archive.path,
        "sodium_stack": stack.path,
        "linker": ctx.file.linker.path,
        "outputs": {f.basename: f.path for f in outputs},
    }
    ctx.actions.run(
        executable = "/usr/bin/python3",
        arguments = [ctx.file._driver.path, "resource_report", json.encode(config)],
        inputs = depset(ctx.files.srcs + ctx.files.headers + sodium_files + [ctx.file.linker, ctx.file._driver]),
        outputs = outputs,
        mnemonic = "CortexResourceReport",
        progress_message = "Linking Cortex-M4 core and reference crypto provider",
    )
    return [DefaultInfo(files = depset(outputs)), AnalysisInfo(commands = [dict(file = f.short_path, includes = [".", "third_party/nanopb", "third_party/libsodium/src/libsodium/include"], copts = [], profile = "arm") for f in ctx.files.srcs if f.extension == "c"])]

cortex_resource_report = rule(implementation = _resource_report_impl, attrs = {
    "srcs": attr.label_list(allow_files = True),
    "headers": attr.label_list(allow_files = True),
    "sodium": attr.label(providers = [CLibraryInfo]),
    "linker": attr.label(allow_single_file = True),
    "_driver": attr.label(default = "//tools:build_action.py", allow_single_file = True),
})

def _analysis_database_impl(ctx):
    out = ctx.actions.declare_file(ctx.label.name + ".json")
    records = {}
    for dep in ctx.attr.deps:
        for command in dep[AnalysisInfo].commands:
            records[json.encode(command)] = command
    ctx.actions.write(out, json.encode(records.values()))
    return [DefaultInfo(files = depset([out]))]

# Compilation metadata is inherited from the same libraries as the normal build.
c_analysis_database = rule(implementation = _analysis_database_impl, attrs = {
    "deps": attr.label_list(providers = [AnalysisInfo]),
})
