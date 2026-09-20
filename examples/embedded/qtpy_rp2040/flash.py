"""Validate and copy this demo's UF2 to an explicitly selected RP2040 BOOTSEL mount."""

import argparse
import os
from pathlib import Path
import struct

from image import BASE, FAMILY, LIMIT, MAGIC, validate_boot


def validate(data):
    """Reject malformed, incomplete, reordered, or NVM-touching UF2 files."""
    if not data or len(data) % 512:
        raise ValueError("UF2 must contain complete 512-byte blocks")
    count = len(data) // 512
    for index in range(count):
        block = data[index * 512 : (index + 1) * 512]
        a, b, flags, address, size, number, total, family = struct.unpack_from("<8I", block)
        end = struct.unpack_from("<I", block, 508)[0]
        if (a, b, end) != MAGIC or flags != 0x2000 or family != FAMILY:
            raise ValueError("not an RP2040 firmware UF2")
        if size != 256 or number != index or total != count or address != BASE + index * 256:
            raise ValueError("UF2 must contain a complete contiguous application")
        if not BASE <= address < address + size <= LIMIT:
            raise ValueError("UF2 touches the reserved NVM partition")
    # LIMIT is erase-sector aligned: even a partial final sector remains below NVM.
    return count


def main():
    """Validate before opening the target volume for writing."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mount", type=Path, required=True)
    parser.add_argument("uf2", type=Path)
    args = parser.parse_args()
    data = args.uf2.read_bytes()
    count = validate(data)
    validate_boot(b"".join(data[at + 32 : at + 288] for at in range(0, len(data), 512)))
    info = (args.mount / "INFO_UF2.TXT").read_text(encoding="ascii")
    if "Board-ID: RPI-RP2" not in info:
        parser.error("selected mount is not an RP2040 ROM BOOTSEL volume")
    with (args.mount / "SIMPLE.UF2").open("wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    print(f"Wrote {count} application blocks; reconnect using the CDC port.")


if __name__ == "__main__":
    main()
