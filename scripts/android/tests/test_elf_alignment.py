"""ELF fixtures exercise malformed/4 KiB native library rejection, not APK builds."""
import importlib.util
from pathlib import Path
import struct
import unittest

spec = importlib.util.spec_from_file_location('verify_apk', Path(__file__).resolve().parents[1] / 'verify-apk.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


def elf(bits=64, endian='<', alignment=16384, virtual=0, file_offset=0):
    data = bytearray(256)
    data[:6] = b'\x7fELF' + bytes([2 if bits == 64 else 1, 1 if endian == '<' else 2])
    header, size = (64, 56) if bits == 64 else (52, 32)
    struct.pack_into(endian + ('Q' if bits == 64 else 'I'), data, 32 if bits == 64 else 28, header)
    struct.pack_into(endian + 'HH', data, 54 if bits == 64 else 42, size, 1)
    values = (1, 5, file_offset, virtual, 0, 256, 256, alignment) if bits == 64 else (1, file_offset, virtual, 0, 256, 256, 5, alignment)
    struct.pack_into(endian + ('IIQQQQQQ' if bits == 64 else 'IIIIIIII'), data, header, *values)
    return data


class ElfAlignmentTests(unittest.TestCase):
    def test_32_64_bit_and_byte_order(self):
        for bits in (32, 64):
            for order in ('<', '>'):
                self.assertEqual(verify.elf_load_alignment(elf(bits, order)), 16384)

    def test_large_alignment_is_accepted(self):
        self.assertEqual(verify.elf_load_alignment(elf(alignment=65536)), 65536)

    def test_4k_and_non_power_of_two_alignment_are_rejected(self):
        for value in (0, 4096, 12288, 24576):
            with self.assertRaisesRegex(ValueError, '16 KiB'):
                verify.elf_load_alignment(elf(alignment=value))

    def test_congruence_is_required_even_with_large_p_align(self):
        with self.assertRaisesRegex(ValueError, '16 KiB'):
            verify.elf_load_alignment(elf(virtual=1))

    def test_truncated_and_invalid_identification_never_pass(self):
        for blob in (b'not elf', elf()[:16], elf()[:90], bytes(256)):
            with self.assertRaises(ValueError): verify.elf_load_alignment(blob)

    def test_missing_load_table_and_invalid_segment_bounds_are_rejected(self):
        no_load = elf(); struct.pack_into('<I', no_load, 64, 4)
        with self.assertRaisesRegex(ValueError, 'no LOAD'): verify.elf_load_alignment(no_load)
        for position, value in ((54, 1), (56, 0), (56, 1025)):
            malformed = elf(); struct.pack_into('<H', malformed, position, value)
            with self.assertRaises(ValueError): verify.elf_load_alignment(malformed)
        beyond = elf(); struct.pack_into('<Q', beyond, 64 + 32, 257)
        with self.assertRaisesRegex(ValueError, 'bounds'): verify.elf_load_alignment(beyond)


if __name__ == '__main__': unittest.main()
