"""Release checks preserve existing assets when a copy fails validation."""
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mbtiles import sha256
from package import checked_fonts, stage

ROOT = Path(__file__).resolve().parents[3]


class StagingTest(unittest.TestCase):
    def test_changed_source_does_not_replace_previously_validated_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / 'source', root / 'target'
            source.write_bytes(b'validated bytes')
            trusted = sha256(source)
            source.write_bytes(b'changed after validation')
            target.write_bytes(b'previous good asset')
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                stage(source, target, trusted)
            self.assertEqual(target.read_bytes(), b'previous good asset')
            self.assertEqual(sorted(path.name for path in root.iterdir()), ['source', 'target'])

    def test_successful_copy_is_identical_and_leaves_no_temporary_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / 'source', root / 'platform/asset'
            source.write_bytes(b'license-preserving offline resource')
            stage(source, target, sha256(source))
            self.assertEqual(target.read_bytes(), source.read_bytes())
            self.assertEqual(list(target.parent.iterdir()), [target])


class FontReleaseTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name) / 'fonts'
        shutil.copytree(ROOT / 'assets/map-fonts', self.root)

    def tearDown(self):
        self.directory.cleanup()

    def mutate_manifest(self, edit):
        path = self.root / 'manifest.json'
        manifest = json.loads(path.read_text())
        edit(manifest)
        path.write_text(json.dumps(manifest))

    def test_real_bundled_glyph_pages_match_upstream_manifest(self):
        self.assertEqual(checked_fonts(self.root)['rangeCount'], 256)

    def test_missing_arabic_presentation_forms_page_blocks_packaging(self):
        (self.root / 'Klokantech Noto Sans Regular/65024-65279.pbf').unlink()
        with self.assertRaisesRegex(ValueError, '65024-65279'):
            checked_fonts(self.root)

    def test_manifest_cannot_supply_an_arbitrary_asset_path(self):
        def change(manifest):
            value = manifest['ranges'].pop('Klokantech Noto Sans Regular/0-255.pbf')
            manifest['ranges']['../../private-file'] = value
        self.mutate_manifest(change)
        with self.assertRaisesRegex(ValueError, 'complete BMP'):
            checked_fonts(self.root)

    def test_tampered_glyph_page_blocks_packaging(self):
        (self.root / 'Klokantech Noto Sans Regular/1536-1791.pbf').write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            checked_fonts(self.root)

    def test_removing_license_blocks_packaging(self):
        (self.root / 'LICENSE-OFL.txt').unlink()
        with self.assertRaisesRegex(ValueError, 'License'):
            checked_fonts(self.root)


if __name__ == '__main__':
    unittest.main()
