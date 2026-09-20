"""One ownership policy shared by formatters, linters, documentation and tests."""

from pathlib import Path

EXCLUDED_DIRS = {
    ".git",
    ".toolchains",
    ".venv",
    "__pycache__",
    "node_modules",
    "third_party",
    "vendor",
    "site",
    "target",
    ".ruff_cache",
}
GENERATED = {
    "schema/sc.pb.c",
    "schema/sc.pb.h",
    "schema/resources.h",
    "schema/test_resources.h",
    "bindings/python/resources.py",
    "bindings/rust/src/resources.rs",
    "bindings/go/resources.go",
    "web/resources.mjs",
    "web/package-lock.json",
    "MODULE.bazel.lock",
}
CODE_SUFFIXES = {
    ".c",
    ".h",
    ".cpp",
    ".inc",
    ".py",
    ".mjs",
    ".go",
    ".rs",
    ".bzl",
    ".bazel",
    ".html",
    ".css",
    ".json",
    ".yml",
    ".yaml",
    ".toml",
    ".proto",
    ".ld",
}


def owned(path):
    """Whether a repository-relative path is maintained source, not generated output."""
    path = Path(path)
    return (
        not any(part in EXCLUDED_DIRS or part.startswith("bazel-") for part in path.parts)
        and path.as_posix() not in GENERATED
    )


def sources(root=Path(".")):
    """Discover source recursively without traversing SDKs, caches or vendor trees."""
    result = []

    def visit(directory):
        for path in directory.iterdir():
            relative = path.relative_to(root)
            if not owned(relative):
                continue
            if path.is_dir():
                visit(path)
            elif path.suffix in CODE_SUFFIXES:
                result.append(relative)

    visit(root)
    return sorted(result)
