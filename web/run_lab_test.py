#!/usr/bin/env python3
import subprocess
subprocess.run(['/usr/bin/node','web/lab_test.mjs'],check=True,timeout=30)
