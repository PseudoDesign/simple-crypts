#!/usr/bin/env python3
"""Keep fixture compile flags and symbols out of production build outputs."""

import ctypes
import json
from pathlib import Path
import unittest


class ProductionBoundariesTest(unittest.TestCase):
    def test_production_compilation_disables_test_hooks(self):
        commands = json.loads(Path("tools/production_analysis_database.json").read_text())
        self.assertTrue(commands, "production compilation metadata is empty")
        self.assertEqual({command["profile"] for command in commands}, {"native", "arm", "wasm"})
        for command in commands:
            with self.subTest(file=command["file"], profile=command["profile"]):
                self.assertFalse(
                    any("SC_ENABLE_TESTING" in option for option in command["copts"]),
                    command["copts"],
                )

    def test_production_library_has_no_revision_seed_hook(self):
        library = ctypes.CDLL(str(Path("providers/host/libsimplecrypts.so").resolve()))
        self.assertTrue(hasattr(library, "sc_init"))
        self.assertFalse(hasattr(library, "sc_test_seed_revision"))


if __name__ == "__main__":
    unittest.main()
