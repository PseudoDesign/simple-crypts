"""Fetch locked language sources through Bazel; compiler actions remain offline."""

def _language_sources_impl(ctx):
    lock = json.decode(ctx.read(ctx.attr.lock))
    for crate in lock["crates"]:
        directory = "rust/" + crate["name"] + "-" + crate["version"]
        ctx.download_and_extract(
            url = "https://static.crates.io/crates/{name}/{name}-{version}.crate".format(**crate),
            sha256 = crate["checksum"],
            type = "tar.gz",
            stripPrefix = crate["name"] + "-" + crate["version"],
            output = directory,
        )

        # Cargo's directory source requires this metadata. Bazel verifies the
        # complete upstream archive against Cargo.lock before extracting it.
        ctx.file(directory + "/.cargo-checksum.json", json.encode({"files": {}, "package": crate["checksum"]}))
    for module in lock["go_modules"]:
        for suffix, checksum in module["sha256"].items():
            path = module["name"] + "/@v/" + module["version"] + "." + suffix
            ctx.download(
                url = "https://proxy.golang.org/" + path,
                output = "go/" + path,
                sha256 = checksum,
            )
    ctx.file("rust/ROOT", "")
    ctx.file("go/ROOT", "")
    ctx.file("BUILD.bazel", """package(default_visibility = ["//visibility:public"])
filegroup(name = "rust", srcs = glob(["rust/**"]))
filegroup(name = "go", srcs = glob(["go/**"]))
exports_files(["rust/ROOT", "go/ROOT"])
""")

language_sources = repository_rule(
    implementation = _language_sources_impl,
    attrs = {"lock": attr.label(mandatory = True, allow_single_file = True)},
)

def _dependency_paths_impl(ctx):
    out = ctx.actions.declare_file(ctx.label.name + ".json")
    paths = {}
    for target, name in ctx.attr.markers.items():
        marker = target[DefaultInfo].files.to_list()[0]
        paths[name] = {"exec": marker.dirname, "runfiles": marker.short_path.rsplit("/", 1)[0]}
    ctx.actions.write(out, json.encode(paths))
    return [DefaultInfo(files = depset([out]))]

dependency_paths = rule(
    implementation = _dependency_paths_impl,
    attrs = {"markers": attr.label_keyed_string_dict(allow_files = True)},
)
