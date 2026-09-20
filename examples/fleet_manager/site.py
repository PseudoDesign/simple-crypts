"""Copy the explicitly declared static assets; no runtime package downloads."""

import shutil
import sys
from pathlib import Path

output = Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
for source in map(Path, sys.argv[2:]):
    shutil.copyfile(source, output / source.name)
