"""Independent UF2 layout and transport boundary tests."""

import struct
import unittest

from cli import decode, encode
from flash import validate
from image import BASE, LIMIT, uf2, validate_boot


class ImageTest(unittest.TestCase):
    """Check payload round trips, fixed format fields, and flash partition boundaries."""

    def test_layout(self):
        for length in (1, 255, 256, 257, 4096):
            source = bytes(i % 256 for i in range(length))
            image = uf2(source)
            count = validate(image)
            self.assertEqual(count, (length + 255) // 256)
            restored = b"".join(image[at + 32 : at + 288] for at in range(0, len(image), 512))
            self.assertEqual(restored[:length], source)
            self.assertEqual(restored[length:], bytes(len(restored) - length))
            self.assertEqual(uf2(source), image)
        self.assertEqual(validate(uf2(bytes(LIMIT - BASE))), (LIMIT - BASE) // 256)
        for source in (b"", bytes(LIMIT - BASE + 1)):
            with self.assertRaises(ValueError):
                uf2(source)

    def test_reject_unsafe_images(self):
        original = uf2(bytes(512))
        for offset, value in ((8, 0), (12, LIMIT), (16, 512), (20, 1), (24, 3), (28, 0), (508, 0)):
            image = bytearray(original)
            struct.pack_into("<I", image, offset, value)
            with self.assertRaises(ValueError):
                validate(image)
        for image in (b"", original[:-1], original[512:] + original[:512]):
            with self.assertRaises(ValueError):
                validate(image)

    def test_boot_validation(self):
        # CRC for 252 zero bytes, computed independently with the SDK's bit-reversal form.
        import zlib

        binary = bytearray(512)
        crc = zlib.crc32(bytes(252)) ^ 0xFFFFFFFF
        reversed_crc = int(f"{crc:032b}"[::-1], 2)
        struct.pack_into("<I", binary, 252, reversed_crc)
        struct.pack_into("<2I", binary, 256, 0x20040000, BASE + 301)
        validate_boot(binary)
        for offset in (0, 252, 256, 260):
            invalid = bytearray(binary)
            invalid[offset] ^= 1
            with self.assertRaises(ValueError):
                validate_boot(invalid)
        with self.assertRaises(ValueError):
            validate_boot(binary[:256])

    def test_cobs(self):
        for source in (b"", bytes(1024), bytes(range(256)) * 4, bytes([255]) * 1024):
            encoded = encode(source)
            self.assertEqual(encoded[-1:], b"\0")
            self.assertNotIn(0, encoded[:-1])
            self.assertLessEqual(len(encoded), 1030)
            self.assertEqual(decode(encoded[:-1]), source)
        for frame in (b"\0", b"\3a", b"\2\0", encode(bytes(1025))[:-1]):
            with self.assertRaises(ValueError):
                decode(frame)


if __name__ == "__main__":
    unittest.main()
