#!/usr/bin/env python3
"""Generate deterministic API HTML/XML and reject incomplete public contracts."""

import argparse
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from quality import tool


def validate_xml(root):
    """Doxygen warns on missing docs; additionally require every parameter by name."""
    for path in sorted((root / "xml").glob("*.xml")):
        tree = ET.parse(path)
        for member in tree.findall(".//memberdef"):
            if member.get("kind") != "function":
                continue
            expected = {
                p.findtext("declname")
                for p in member.findall("param")
                if p.findtext("type") != "void"
            }
            documented = {
                p.text for p in member.findall(".//parameterlist[@kind='param']//parametername")
            }
            if None in expected or expected - documented:
                raise ValueError(
                    f"Incomplete parameter documentation: {member.findtext('name')}: {expected - documented}"
                )


class Links(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.targets = set()
        self.links = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.targets.update(attrs[key] for key in ("id", "name") if key in attrs)
        self.links.extend(attrs[key] for key in ("href", "src") if key in attrs)


def validate_links(root):
    html = (root / "html").resolve()
    pages = {p.resolve(): Links(p.read_text()) for p in html.rglob("*.html")}
    site_links = {
        (html.parent / "index.html").resolve(),
        (html.parent / "examples/fleet_manager/index.html").resolve(),
    }
    for page, parsed in pages.items():
        for link in parsed.links:
            url = urlsplit(link)
            if url.scheme or url.netloc:
                continue
            target = (page.parent / unquote(url.path)).resolve() if url.path else page
            if target in site_links:
                continue  # Checked in assembled-site browser acceptance.
            if not target.is_relative_to(html) or not target.is_file():
                raise ValueError(f"Broken API link: {page.name}: {link}")
            if url.fragment and target in pages:
                fragment = unquote(url.fragment)
                # Rustdoc's source viewer interprets numeric ranges dynamically.
                if target.is_relative_to(html / "rust/src") and re.fullmatch(
                    r"[0-9]+-[0-9]+", fragment
                ):
                    first, last = map(int, fragment.split("-"))
                    valid = first <= last and all(
                        str(n) in pages[target].targets for n in range(first, last + 1)
                    )
                else:
                    valid = (
                        fragment in pages[target].targets or url.fragment in pages[target].targets
                    )
                if not valid:
                    raise ValueError(f"Broken API anchor: {page.name}: {link}")


def build(output, c_only=False):
    doxygen = tool("doxygen", "1.9.8")
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    config = Path("docs/Doxyfile").read_text() + f'\nOUTPUT_DIRECTORY = "{output}"\n'
    subprocess.run([doxygen, "-"], input=config, text=True, check=True)
    # Doxygen records its output path in metadata even when source paths are relative.
    # Normalize that one configuration value so artifacts do not depend on the build root.
    metadata = output / "xml/Doxyfile.xml"
    metadata.write_text(
        re.sub(
            r"(<option\s+id='OUTPUT_DIRECTORY'[^>]*><value><!\[CDATA\[).*?(\]\]></value>)",
            r"\g<1>api\g<2>",
            metadata.read_text(),
        )
    )
    validate_xml(output)
    if c_only:
        (output / "html/bindings.html").write_text("<!doctype html><title>Bindings fixture</title>")
    if not c_only:
        from binding_docs import build_bindings

        build_bindings(output)
    validate_links(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output")
    parser.add_argument("--c-only", action="store_true", help="Isolate C documentation fixtures")
    args = parser.parse_args()
    if args.output:
        build(args.output, args.c_only)
    else:
        with tempfile.TemporaryDirectory(prefix="sc-api-") as directory:
            build(directory, args.c_only)


if __name__ == "__main__":
    main()
