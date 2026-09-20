"""Prove the added language gates reject defects and respect source ownership."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from repository_quality import sdk
from source_policy import sources


class RepositoryQualityTest(unittest.TestCase):
    def reject(self, command, source=None, diagnostic=None, env=None):
        result = subprocess.run(
            list(map(str, command)), input=source, text=True, capture_output=True, env=env
        )
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        if diagnostic:
            self.assertIn(diagnostic, result.stdout + result.stderr)

    def test_owned_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in (
                "tests/test.py",
                "examples/app.cpp",
                "web/main.mjs",
                "vendor/library.c",
                "external/library.c",
                "third_party/BUILD.bazel",
                "site/app.mjs",
                "bazel-bin/output.c",
                "schema/sc.pb.c",
                "bindings/rust/src/resources.rs",
            ):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("")
            self.assertEqual(
                {str(p) for p in sources(root)},
                {"tests/test.py", "examples/app.cpp", "web/main.mjs", "third_party/BUILD.bazel"},
            )

    def test_python_analysis_and_format(self):
        ruff = sdk("quality") / "ruff-x86_64-unknown-linux-gnu/ruff"
        self.reject(
            [ruff, "check", "--stdin-filename", "bad.py", "-"], "print(missing_name)\n", "F821"
        )
        self.reject([ruff, "format", "--check", "--stdin-filename", "bad.py", "-"], "x=  1\n")
        self.reject(
            [ruff, "check", "--select", "D103", "--stdin-filename", "bad.py", "-"],
            "def public():\n    pass\n",
            "D103",
        )

    def test_javascript_analysis_and_docs(self):
        command = [
            "web/node_modules/.bin/eslint",
            "--config",
            "web/eslint.config.mjs",
            "--stdin",
            "--stdin-filename",
            "web/bad.mjs",
        ]
        self.reject(command, "missingName();\n", "no-undef")
        self.reject(command, "export function publicAPI() {}\n", "jsdoc/require-jsdoc")

    def test_markup_and_styles(self):
        self.reject(
            ["web/node_modules/.bin/html-validate", "--stdin"],
            '<!doctype html><html lang="en"><title>Fixture</title>'
            '<body><input id="same"><input id="same"></body></html>',
            "no-dup-id",
        )
        self.reject(
            ["web/node_modules/.bin/stylelint", "--config", "web/stylelint.config.mjs"],
            "a { color: #notacolor; }",
            "color-no-invalid-hex",
        )
        self.reject(
            ["web/node_modules/.bin/prettier", "--check", "--stdin-filepath", "web/bad.mjs"],
            "const x=1\n",
        )

    def test_bazel_lint(self):
        self.reject(
            [sdk("quality") / "buildifier", "-lint=warn", "-mode=check", "-type=build"],
            'filegroup(name = "bad", srcs = glob(["fixed.c"]))\n',
            "constant-glob",
        )

    def test_go_and_rust_analysis(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            go = root / "bad.go"
            go.write_text('package main\nimport "fmt"\nfunc main() { fmt.Printf("%d", "text") }\n')
            env = dict(
                os.environ,
                GOROOT=str(sdk("go").resolve()),
                GOTOOLCHAIN="local",
                GOCACHE=str(root / "cache"),
                GOPROXY="off",
                GOSUMDB="off",
            )
            self.reject([sdk("go") / "bin/go", "vet", go], diagnostic="wrong type", env=env)
            rust = root / "bad.rs"
            rust.write_text("pub fn bad() -> bool { let x = 1; x == x }\n")
            self.reject(
                [
                    sdk("rust") / "bin/clippy-driver",
                    "--crate-type=lib",
                    "--emit=metadata",
                    "--out-dir",
                    root,
                    "-Dwarnings",
                    rust,
                ],
                diagnostic="eq_op",
            )
            rust.write_text("#![deny(missing_docs)]\npub fn undocumented() {}\n")
            self.reject(
                [sdk("rust") / "bin/rustdoc", "--out-dir", root / "docs", rust],
                diagnostic="missing documentation",
            )


if __name__ == "__main__":
    unittest.main()
