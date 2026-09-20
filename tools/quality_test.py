#!/usr/bin/env python3
"""Exercise failure gates with isolated fixtures, never by modifying real headers."""

from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from quality import tool


class QualityTest(unittest.TestCase):
    def test_bad_format_fails(self):
        result = subprocess.run(
            [
                tool("clang-format-18", "18.1.3"),
                "--dry-run",
                "--Werror",
                "--assume-filename=core/bad.c",
            ],
            input="int bad( ){return 1;}\n",
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("clang-format", result.stderr)

    def test_analyzer_finding_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "bad.c"
            source.write_text("int bad(void) { int *p = 0; return *p; }\n")
            result = subprocess.run(
                [
                    tool("clang-tidy-18", "18.1.3"),
                    "--config-file=.clang-tidy",
                    str(source),
                    "--",
                    "-std=c99",
                ],
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("clang-analyzer-core.NullDereference", result.stdout)

    @contextmanager
    def documentation_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in (
                "core/sc.h",
                "core/data.h",
                "providers/host/sc_host.h",
                "providers/sodium/sc_sodium.h",
                "docs/Doxyfile",
                "docs/api.dox",
                "docs/api.css",
                "docs/api_example.c",
            ):
                destination = root / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(name, destination)
            yield root

    def docs(self, root, output):
        return subprocess.run(
            [
                "/usr/bin/python3",
                str(Path("docs/build_api.py").resolve()),
                "--output",
                str(root / output),
            ],
            cwd=root,
            text=True,
            capture_output=True,
        )

    def test_documentation_failures(self):
        declarations = [
            "int undocumented(int value);",
            "/** @brief Missing parameter contract. @return The input value. */\n"
            "int incomplete(int value);",
            "/** @brief See @ref nonexistent_api_symbol. */\nint broken(void);",
        ]
        for declaration in declarations:
            with self.subTest(declaration=declaration), self.documentation_fixture() as root:
                with (root / "core/sc.h").open("a") as stream:
                    stream.write("\n" + declaration + "\n")
                result = self.docs(root, "output")
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertTrue(
                    "not documented" in result.stderr
                    or "Incomplete parameter" in result.stderr
                    or "unable to resolve" in result.stderr,
                    result.stderr,
                )

    def test_reproducible_documentation(self):
        inventories = []
        # Different source AND output paths exercise location-independent output.
        for _ in range(2):
            with self.documentation_fixture() as root:
                result = self.docs(root, "output")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                inventories.append(
                    {
                        str(p.relative_to(root / "output")): hashlib.sha256(
                            p.read_bytes()
                        ).hexdigest()
                        for p in (root / "output").rglob("*")
                        if p.is_file()
                    }
                )
        self.assertEqual(inventories[0], inventories[1])


if __name__ == "__main__":
    unittest.main()
