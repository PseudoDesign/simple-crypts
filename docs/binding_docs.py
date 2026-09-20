"""Build public binding references from language parsers, without opening endpoints."""

import ast
import html
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile

from build_action import sdk_binary
from repository_quality import sdk


def python_entries(path):
    """Read signatures and docstrings without importing a binding or loading its FFI."""
    tree = ast.parse(path.read_text())
    if not ast.get_docstring(tree):
        raise ValueError(f"Undocumented Python module: {path}")
    entries = []

    def visit(body, prefix=""):
        for node in body:
            if not isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                continue
            if node.name.startswith("_") and node.name != "__init__":
                continue
            name = prefix + node.name
            description = ast.get_docstring(node)
            if not description:
                raise ValueError(f"Undocumented Python API: {name}")
            signature = name
            if isinstance(node, ast.FunctionDef):
                parameters = node.args.posonlyargs + node.args.args + node.args.kwonlyargs
                missing = [
                    arg.arg
                    for arg in parameters
                    if arg.arg not in ("self", "cls")
                    and not re.search(r"\b" + re.escape(arg.arg) + r"\b", description)
                ]
                if missing:
                    raise ValueError(f"Undocumented Python parameters: {name}: {missing}")
                signature += "(" + ast.unparse(node.args) + ")"
            entries.append(dict(name=name, signature=signature, description=description))
            if isinstance(node, ast.ClassDef):
                visit(node.body, name + ".")

    visit(tree.body)
    return entries


def render(output, language, entries):
    """Write deterministic, searchable HTML and JSON; escape all source text."""
    folder = output / "html" / language
    folder.mkdir(parents=True, exist_ok=True)
    entries.sort(key=lambda entry: entry["name"])
    (folder / "api.json").write_text(json.dumps(entries, indent=2, sort_keys=True) + "\n")
    parts = [
        '<!doctype html><html lang="en"><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        f"<title>Simple Crypts {language} API</title>",
        "<style>body{max-width:70rem;margin:2rem auto;padding:0 1rem;font:1rem/1.6 system-ui}"
        "pre{white-space:pre-wrap;overflow-wrap:anywhere}article{border-top:1px solid #ccc;"
        "padding:1rem 0}input{font:inherit;padding:.5rem;width:90%}</style>",
        '<nav><a href="../index.html">C API and demos</a> · '
        '<a href="../bindings.html">All bindings</a></nav>',
        f"<h1>{html.escape(language.title())} API</h1>",
        "<p>Endpoints have one owner. Mutations persist through the host or browser provider; "
        "transport remains application-owned. Fixture helpers are for testing only.</p>",
        '<label>Filter declarations <input type="search" id="search"></label>',
    ]
    for index, entry in enumerate(entries):
        parts.append(
            f'<article id="entry-{index}"><h2>{html.escape(entry["name"])}</h2>'
            f"<pre>{html.escape(entry['signature'])}</pre>"
            f"<p>{html.escape(entry['description'])}</p></article>"
        )
    parts.append(
        '<script>document.querySelector("#search").addEventListener("input",event=>{'
        'const query=event.target.value.toLowerCase();document.querySelectorAll("article")'
        ".forEach(entry=>entry.hidden=!entry.textContent.toLowerCase().includes(query))});</script></html>"
    )
    (folder / "index.html").write_text("\n".join(parts) + "\n")


def javascript_entries():
    """JSDoc parses exported browser interfaces; private implementation details stay out."""
    paths = [
        "web/endpoint.mjs",
        "web/lab.mjs",
        "examples/common/endpoint.mjs",
        "examples/common/storage.mjs",
        "examples/fleet_manager/transport.mjs",
    ]
    subprocess.run(
        ["web/node_modules/.bin/eslint", "--config", "web/eslint.config.mjs", *paths],
        check=True,
    )
    records = json.loads(
        subprocess.check_output(
            ["web/node_modules/.bin/jsdoc", "-c", "docs/jsdoc.json", "-X", *paths], text=True
        )
    )
    entries = []
    for record in records:
        if record.get("undocumented") or record.get("access") == "private":
            continue
        if record.get("kind") not in ("class", "function", "module", "constant", "member"):
            continue
        description = record.get("description") or record.get("classdesc")
        if not description:
            continue
        params = record.get("params", [])
        signature = record["longname"]
        if record["kind"] in ("class", "function") or params or record.get("returns"):
            signature += "(" + ", ".join(p["name"] for p in params) + ")"
        for param in params:
            description += "\n" + param["name"] + ": " + param.get("description", "")
        for result in record.get("returns", []):
            description += "\nReturns: " + result.get("description", "")
        entries.append(dict(name=record["longname"], signature=signature, description=description))
    if not entries:
        raise ValueError("No JavaScript API documentation was generated")
    return entries


def build_bindings(output):
    """Generate Python/Go/JS reference data and compiler-checked Rust documentation."""
    render(output, "python", python_entries(Path("bindings/python/simplecrypts.py")))
    with tempfile.TemporaryDirectory(prefix="sc-go-docs-") as directory:
        env = dict(
            os.environ,
            GOROOT=str(sdk("go").resolve()),
            GOTOOLCHAIN="local",
            GOCACHE=directory,
            GOPROXY="off",
            GOSUMDB="off",
        )
        entries = json.loads(
            subprocess.check_output(
                [str(sdk("go") / "bin/go"), "run", "docs/go_docs.go"], env=env, text=True
            )
        )
    render(output, "go", entries)
    render(output, "javascript", javascript_entries())
    rust_sources = [
        str(path)
        for root in ("bindings/rust", "third_party/rust_crates")
        for path in Path(root).rglob("*")
        if path.is_file()
    ]
    sdk_binary(
        dict(
            output=str(output / "html/rust"),
            sdk=str(sdk("rust")),
            shared=None,
            sources=rust_sources,
            kind="rust",
            module="bindings/rust",
            documentation=True,
        )
    )
    (output / "html/rust/index.html").write_text(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Rust API</title>'
        '<h1>Rust API</h1><p><a href="simplecrypts/index.html">Simple Crypts crate</a> · '
        '<a href="../bindings.html">All bindings</a> · <a href="../index.html">C API and demos</a></p></html>\n'
    )
    (output / "html/bindings.html").write_text(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Binding APIs</title>'
        '<h1>Simple Crypts binding APIs</h1><p><a href="index.html">C API and demos</a></p>'
        '<ul><li><a href="python/index.html">Python</a></li>'
        '<li><a href="go/index.html">Go</a></li>'
        '<li><a href="javascript/index.html">JavaScript browser interfaces</a></li>'
        '<li><a href="rust/simplecrypts/index.html">Rust</a></li></ul></html>\n'
    )
