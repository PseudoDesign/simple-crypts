"""Validate an RP2040 ELF and produce deterministic, firmware-only UF2 artifacts."""

import hashlib
import json
from pathlib import Path
import struct
import sys

BASE = 0x10000000
LIMIT = 0x107FD000
FAMILY = 0xE48BFF56
MAGIC = (0x0A324655, 0x9E5D5157, 0x0AB16F30)


def uf2(binary):
    """Encode a contiguous application BIN, rejecting every NVM overlap."""
    count = (len(binary) + 255) // 256
    if not count or BASE + count * 256 > LIMIT:
        raise ValueError("empty firmware or image overlaps NVM")
    output = bytearray()
    for index in range(count):
        header = struct.pack(
            "<8I", *MAGIC[:2], 0x2000, BASE + index * 256, 256, index, count, FAMILY
        )
        payload = binary[index * 256 : (index + 1) * 256].ljust(256, b"\0")
        output += header + payload + bytes(220) + struct.pack("<I", MAGIC[2])
    return bytes(output)


def validate_boot(binary):
    """Check the ROM boot2 CRC and SDK application's initial stack/reset vector."""
    if len(binary) < 512:
        raise ValueError("firmware is missing boot2 or vectors")
    crc = 0xFFFFFFFF
    for byte in binary[:252]:
        crc ^= byte << 24
        for _ in range(8):
            crc = ((crc << 1) ^ (0x04C11DB7 if crc & 0x80000000 else 0)) & 0xFFFFFFFF
    if struct.unpack_from("<I", binary, 252)[0] != crc:
        raise ValueError("invalid boot2 checksum")
    stack, reset = struct.unpack_from("<2I", binary, 256)
    if stack != 0x20040000 or not reset & 1 or not BASE + 256 <= reset < BASE + len(binary):
        raise ValueError("invalid application stack/reset vector")


def inspect_elf(data):
    """Check load addresses and return reproducible section and symbol evidence."""
    if data[:7] != b"\x7fELF\x01\x01\x01":
        raise ValueError("expected a little-endian ELF32")
    header = struct.unpack_from("<16sHHIIIIIHHHHHH", data)
    if header[2] != 40:
        raise ValueError("expected ARM ELF")
    segments = []
    for i in range(header[10]):
        kind, offset, virtual, physical, size, memory, flags, _ = struct.unpack_from(
            "<8I", data, header[5] + i * header[9]
        )
        if kind == 1 and size:
            if not BASE <= physical < physical + size <= LIMIT or offset + size > len(data):
                raise ValueError("loadable segment outside application flash")
            segments.append(
                {
                    "address": physical,
                    "virtual": virtual,
                    "size": size,
                    "memory": memory,
                    "flags": flags,
                }
            )
    table = [
        struct.unpack_from("<10I", data, header[6] + i * header[11]) for i in range(header[12])
    ]
    strings = table[header[13]]
    names = data[strings[4] : strings[4] + strings[5]]
    sections = []
    symbols = {}
    for entry in table:
        name = names[entry[0] :].split(b"\0", 1)[0].decode()
        sections.append({"name": name, "address": entry[3], "size": entry[5], "type": entry[1]})
        if entry[1] == 2:
            strings = table[entry[6]]
            symbol_names = data[strings[4] : strings[4] + strings[5]]
            for at in range(entry[4], entry[4] + entry[5], entry[9]):
                index, value, _, _, _, section = struct.unpack_from("<IIIBBH", data, at)
                symbol = symbol_names[index:].split(b"\0", 1)[0].decode()
                if symbol and section:
                    symbols[symbol] = value
    if any(name.startswith("sc_test_") for name in symbols):
        raise ValueError("test-only library hooks linked into firmware")
    boot = next((s for s in sections if s["name"] == ".boot2"), None)
    if not boot or boot["address"] != BASE or boot["size"] != 256:
        raise ValueError("missing 256-byte boot2 at flash base")
    if symbols.get("__StackTop", 0) - symbols.get("__StackBottom", 0) != 32768:
        raise ValueError("missing reserved 32 KiB stack")
    if not 0x20038000 <= symbols["__StackBottom"] < symbols["__StackTop"] <= 0x20040000:
        raise ValueError("stack outside reserved main SRAM")
    if "__wrap___aeabi_lmul" not in symbols:
        raise ValueError("missing Pico constant-instruction multiply wrapper")
    return {"segments": segments, "sections": sections, "symbols": dict(sorted(symbols.items()))}


def main():
    """Write checked UF2 and its input/section/symbol manifest."""
    elf, binary, destination, report, symbol_map = map(Path, sys.argv[1:])
    evidence = inspect_elf(elf.read_bytes())
    blob = binary.read_bytes()
    validate_boot(blob)
    result = uf2(blob)
    evidence.update(
        {
            "board": "adafruit_qtpy_rp2040",
            "baseline": "2d6581d3dc6cfa9ea1b9b330734ce9fdb21a5a14",
            "pico_sdk": "2.3.1",
            "compiler": "Arm GNU 13.2.Rel1",
            "python": "3.11.14",
            "libsodium": "1.0.20",
            "nanopb": "0.4.9.1.bcr.3",
            "flash_bytes": len(blob),
            "static_ram_bytes": evidence["symbols"]["__bss_end__"] - 0x20000000,
            "reserved_stack_bytes": 32768,
            "nvm_start": LIMIT,
            "binary_sha256": hashlib.sha256(blob).hexdigest(),
            "uf2_sha256": hashlib.sha256(result).hexdigest(),
        }
    )
    symbol_map.write_text(
        "# ELF symbol addresses (not a linker input/cross-reference map)\n"
        + "".join(
            f"{address:08x} {name}\n"
            for name, address in sorted(
                evidence["symbols"].items(), key=lambda item: (item[1], item[0])
            )
        )
    )
    destination.write_bytes(result)
    report.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
