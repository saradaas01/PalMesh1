"""Isolated import-boundary fixtures; no fixture is packaged as Palestine data."""
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mbtiles import sha256
from provision_artifact import FILES, provision


class ReviewedArtifactTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.artifact, self.destination = self.root / 'artifact', self.root / 'mapdata'
        self.artifact.mkdir()
        self.destination.mkdir()
        (self.artifact / 'palestine.mbtiles').write_bytes(b'Import boundary fixture, not geographic map data')
        (self.artifact / 'palestine.manifest.json').write_text('{"fixture":"not a production manifest"}')
        self.expected = {name: sha256(self.artifact / name) for name in FILES}

    def tearDown(self):
        self.directory.cleanup()

    def import_pair(self):
        return provision(self.artifact, self.destination,
                         self.expected['palestine.mbtiles'], self.expected['palestine.manifest.json'])

    def assert_empty(self):
        self.assertEqual(list(self.destination.iterdir()), [])

    def validator_boundary(self, manifest, database):
        # Only the full geographic validator is replaced in success tests.
        # The importer must pass its private, digest-checked copies, never the
        # artifact or published targets. Real invalid-map tests do not mock it.
        self.assertEqual(manifest.parent, database.parent)
        self.assertNotEqual(database.parent, self.artifact)
        self.assertNotEqual(database.parent, self.destination)
        self.assertEqual(database.read_bytes(), (self.artifact / database.name).read_bytes())
        self.assertEqual(manifest.read_bytes(), (self.artifact / manifest.name).read_bytes())
        self.assertFalse((self.destination / database.name).exists())
        self.assertFalse((self.destination / manifest.name).exists())
        return {}

    def test_checked_snapshot_is_staged_and_revalidated_before_publication(self):
        with patch('provision_artifact.checked_manifest', side_effect=self.validator_boundary) as validator:
            report = self.import_pair()
        validator.assert_called_once()
        self.assertEqual(report['mapSha256'], self.expected['palestine.mbtiles'])
        self.assertEqual(set(path.name for path in self.destination.iterdir()), set(FILES))
        for name in FILES:
            self.assertEqual((self.destination / name).read_bytes(), (self.artifact / name).read_bytes())

    def test_both_independent_hashes_are_required_before_import(self):
        for invalid in ('', '1' * 63, 'A' * 64, 'g' * 64, '0' * 64 + '\n'):
            for index in (0, 1):
                digests = list(self.expected.values())
                digests[index] = invalid
                with self.subTest(invalid=invalid, index=index), self.assertRaisesRegex(ValueError, 'independently reviewed'):
                    provision(self.artifact, self.destination, *digests)
        self.assert_empty()

    def test_map_or_manifest_tampering_blocks_validation_and_publication(self):
        for name in FILES:
            original = (self.artifact / name).read_bytes()
            (self.artifact / name).write_bytes(original + b'changed')
            with self.subTest(name=name), patch('provision_artifact.checked_manifest') as validator:
                with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
                    self.import_pair()
                validator.assert_not_called()
                self.assert_empty()
            (self.artifact / name).write_bytes(original)

    def test_extra_nested_and_sqlite_sidecar_entries_are_rejected(self):
        for name, directory in [('unexpected.txt', False), ('nested', True), ('palestine.mbtiles-wal', False)]:
            extra = self.artifact / name
            extra.mkdir() if directory else extra.write_bytes(b'not part of approved pair')
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'exactly'):
                self.import_pair()
            extra.rmdir() if directory else extra.unlink()
        self.assert_empty()

    def test_each_artifact_file_must_be_regular_not_a_symlink(self):
        for name in FILES:
            path = self.artifact / name
            saved = self.root / ('original-' + name)
            path.rename(saved)
            path.symlink_to(saved)
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'regular file'):
                self.import_pair()
            path.unlink()
            saved.rename(path)
        self.assert_empty()

    def test_artifact_or_destination_may_not_traverse_symlinked_parent(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        for source, target in [(alias / 'artifact', self.destination), (self.artifact, alias / 'mapdata')]:
            with self.subTest(source=source, target=target), self.assertRaisesRegex(ValueError, 'traverse symbolic links'):
                provision(source, target, *self.expected.values())
        self.assert_empty()

    def test_oversized_or_empty_files_are_rejected_before_hashing(self):
        for name, maximum in FILES.items():
            path = self.artifact / name
            original = path.read_bytes()
            for size in (0, maximum + 1):
                with path.open('wb') as output:
                    output.truncate(size)  # Sparse size fixture, not a large allocation.
                with self.subTest(name=name, size=size), patch('provision_artifact.sha256') as digest:
                    with self.assertRaisesRegex(ValueError, 'size limit'):
                        self.import_pair()
                    digest.assert_not_called()
            path.write_bytes(original)
        self.assert_empty()

    def test_conflicting_tracked_manifest_preserves_every_existing_byte(self):
        manifest = self.destination / 'palestine.manifest.json'
        manifest.write_text('Existing reviewed operator work')
        with patch('provision_artifact.checked_manifest') as validator:
            with self.assertRaisesRegex(ValueError, 'Preserving different existing destination'):
                self.import_pair()
            validator.assert_not_called()
        self.assertEqual(manifest.read_text(), 'Existing reviewed operator work')
        self.assertEqual(list(self.destination.iterdir()), [manifest])

    def test_conflicting_existing_map_is_never_overwritten(self):
        target = self.destination / 'palestine.mbtiles'
        target.write_bytes(b'Existing operator database')
        with self.assertRaisesRegex(ValueError, 'Preserving different existing destination'):
            self.import_pair()
        self.assertEqual(target.read_bytes(), b'Existing operator database')
        self.assertEqual(list(self.destination.iterdir()), [target])

    def test_identical_existing_files_keep_their_inodes_and_timestamps(self):
        before = {}
        for name in FILES:
            target = self.destination / name
            target.write_bytes((self.artifact / name).read_bytes())
            info = target.stat()
            before[name] = info.st_ino, info.st_mtime_ns
        with patch('provision_artifact.checked_manifest') as validator:
            self.import_pair()
        validator.assert_called_once()
        for name in FILES:
            info = (self.destination / name).stat()
            self.assertEqual((info.st_ino, info.st_mtime_ns), before[name])

    def test_existing_destination_symlink_is_preserved_and_rejected(self):
        target = self.destination / 'palestine.manifest.json'
        target.symlink_to(self.artifact / target.name)
        with self.assertRaisesRegex(ValueError, 'regular file'):
            self.import_pair()
        self.assertTrue(target.is_symlink())
        self.assertFalse((self.destination / 'palestine.mbtiles').exists())

    def test_existing_destination_sqlite_sidecar_blocks_import(self):
        sidecar = self.destination / 'palestine.mbtiles-wal'
        sidecar.write_bytes(b'Existing uncheckpointed database work')
        with self.assertRaisesRegex(ValueError, 'existing SQLite sidecar'):
            self.import_pair()
        self.assertEqual(list(self.destination.iterdir()), [sidecar])
        self.assertEqual(sidecar.read_bytes(), b'Existing uncheckpointed database work')

    def test_real_manifest_validator_rejects_unapproved_fixture(self):
        with self.assertRaisesRegex(ValueError, 'Unsupported map manifest'):
            self.import_pair()
        self.assert_empty()

    def test_real_map_validator_rejects_non_database_even_with_matching_pins(self):
        manifest = {'schemaVersion': 1, 'file': 'palestine.mbtiles', 'sha256': self.expected['palestine.mbtiles'],
                    'dataTimestamp': '2026-01-01T00:00:00Z', 'sourceUrl': 'https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf',
                    'license': 'ODbL-1.0', 'licenseUrl': 'https://opendatacommons.org/licenses/odbl/1-0/',
                    'sourceSha256': '1' * 64, 'generatorSha256': '2' * 64,
                    'configurationSha256': '3' * 64, 'profileSha256': '4' * 64}
        path = self.artifact / 'palestine.manifest.json'
        path.write_text(json.dumps(manifest))
        self.expected[path.name] = sha256(path)
        with self.assertRaises(sqlite3.DatabaseError):
            self.import_pair()
        self.assert_empty()

    def test_mutation_of_validated_snapshot_is_rejected_before_publication(self):
        def change_snapshot(manifest, database):
            database.write_bytes(b'changed after validation')
        with patch('provision_artifact.checked_manifest', side_effect=change_snapshot):
            with self.assertRaisesRegex(ValueError, 'snapshot changed'):
                self.import_pair()
        self.assert_empty()

    def test_concurrent_destination_is_not_overwritten_and_own_link_is_rolled_back(self):
        real_link = os.link

        def concurrent_target(source, target, **options):
            if target.name == 'palestine.manifest.json':
                target.write_bytes(b'Concurrent operator work')
                raise FileExistsError('Another operation published a file')
            real_link(source, target, **options)

        with patch('provision_artifact.checked_manifest'), patch('provision_artifact.os.link', side_effect=concurrent_target):
            with self.assertRaisesRegex(ValueError, 'no overwrite attempted'):
                self.import_pair()
        self.assertFalse((self.destination / 'palestine.mbtiles').exists())
        manifest = self.destination / 'palestine.manifest.json'
        self.assertEqual(manifest.read_bytes(), b'Concurrent operator work')
        self.assertEqual(list(self.destination.iterdir()), [manifest])

    def test_missing_published_output_cannot_report_success(self):
        real_link = os.link

        def remove_map_during_publication(source, target, **options):
            real_link(source, target, **options)
            if target.name == 'palestine.manifest.json':
                (self.destination / 'palestine.mbtiles').unlink()

        with patch('provision_artifact.checked_manifest'), patch('provision_artifact.os.link', side_effect=remove_map_during_publication):
            with self.assertRaisesRegex(ValueError, 'Destination disappeared'):
                self.import_pair()
        self.assert_empty()


if __name__ == '__main__':
    unittest.main()
