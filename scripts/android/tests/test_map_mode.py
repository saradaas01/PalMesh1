import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('map_mode',Path(__file__).resolve().parents[1]/'verify-map-mode.py')
mode=importlib.util.module_from_spec(spec);spec.loader.exec_module(mode)
class MapModeTests(unittest.TestCase):
    def test_boolean_modes(self):
        prefix='E: meta-data\n  A: android:name="com.palmesh.MAP_DIAGNOSTICS"\n  A: android:value(0x01010024)=(type 0x12)'
        self.assertFalse(mode.diagnostics_flag(prefix+'0x0'))
        self.assertTrue(mode.diagnostics_flag(prefix+'0xffffffff'))
    def test_modern_aapt_literal_booleans(self):
        p='E: meta-data\n A: http://schemas.android.com/apk/res/android:name="com.palmesh.MAP_DIAGNOSTICS"\n A: http://schemas.android.com/apk/res/android:value(0x01010024)='
        self.assertFalse(mode.diagnostics_flag(p+'false'))
        self.assertTrue(mode.diagnostics_flag(p+'true'))
    def test_missing_or_string_mode_cannot_disguise_old_diagnostic_apks(self):
        for text in ('E: meta-data android:name="other"', 'E: meta-data android:name="com.palmesh.MAP_DIAGNOSTICS"\n A: android:value="false"'):
            with self.assertRaises(ValueError): mode.diagnostics_flag(text)
