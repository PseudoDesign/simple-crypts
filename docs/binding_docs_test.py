"""Reject undocumented binding APIs and compare complete generated reference trees."""

import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from binding_docs import build_bindings, javascript_entries, python_entries
from repository_quality import sdk


class BindingDocumentationTest(unittest.TestCase):
    def test_missing_python_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "binding.py"
            source.write_text('"""Fixture module."""\ndef undocumented():\n    pass\n')
            with self.assertRaisesRegex(ValueError, "Undocumented Python API"):
                python_entries(source)

    def test_missing_go_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "binding.go"
            source.write_text(
                "// Package fixture exercises missing docs.\npackage fixture\nfunc Undocumented() {}\n"
            )
            # Build the AST validator separately so go run does not interpret the fixture as source.
            env = dict(
                os.environ,
                GOROOT=str(sdk("go").resolve()),
                GOTOOLCHAIN="local",
                GOCACHE=str(root / "cache"),
                GOPROXY="off",
                GOSUMDB="off",
            )
            validator = root / "go-docs"
            subprocess.run(
                [str(sdk("go") / "bin/go"), "build", "-o", str(validator), "docs/go_docs.go"],
                check=True,
                env=env,
            )
            result = subprocess.run([str(validator), str(source)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Undocumented Go API: Undocumented", result.stderr)

    def test_javascript_export_forms(self):
        entries = {entry["name"]: entry for entry in javascript_entries()}
        for name in (
            "module:web/endpoint.hex",
            "module:examples/common/storage.rows",
            "module:examples/common/storage.saveRow",
            "module:web/lab.MAX_QUEUE",
            "module:web/lab.MAX_EVENTS",
            "module:web/lab.DEVICE_SERIAL",
        ):
            self.assertIn(name, entries)
        self.assertTrue(entries["module:web/endpoint.hex"]["signature"].endswith("(bytes)"))
        self.assertEqual(
            entries["module:web/lab.MAX_EVENTS"]["signature"], "module:web/lab.MAX_EVENTS"
        )

    def test_reproducible_bindings(self):
        inventories = []
        for _ in range(2):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                build_bindings(root)
                inventories.append(
                    {
                        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
                        for path in root.rglob("*")
                        if path.is_file()
                    }
                )
        self.assertEqual(inventories[0], inventories[1])


if __name__ == "__main__":
    unittest.main()
