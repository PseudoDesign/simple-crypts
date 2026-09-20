#!/usr/bin/env python3
"""Explicit browser acceptance target; requires pinned npm/browser installation."""

import os, subprocess

os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", "/tmp/simple-crypts-browsers")
subprocess.run(["/usr/bin/node", "web/browser_test.mjs", "web/site"], check=True, timeout=420)
