#!/usr/bin/env python3
"""Import an operator-pinned map pair downloaded from this repository's Actions.

The two digests must come from an independent operator review, not from files
inside the downloaded artifact. This helper performs no network requests.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile

from mbtiles import checked_manifest, sha256

ROOT = Path(__file__).resolve().parents[2]
FILES = {'palestine.mbtiles': 8 * 1024**3, 'palestine.manifest.json': 262144}


def directory_without_symlinks(path: Path) -> Path:
    path = path.absolute()
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError('Artifact and destination paths must not traverse symbolic links')
    if not path.is_dir():
        raise ValueError('Artifact and destination directories must already exist')
    return path


def regular_file(path: Path, maximum: int) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= maximum:
        raise ValueError('Expected a nonempty regular file within its size limit: ' + path.name)
    return info


def existing_identical(path: Path, expected: str, size: int, maximum: int) -> bool:
    if not os.path.lexists(path):
        return False
    info = regular_file(path, maximum)
    if info.st_size != size or sha256(path) != expected:
        raise ValueError('Preserving different existing destination: ' + path.name)
    return True


def snapshot(source: Path, target: Path, expected: str, maximum: int) -> int:
    # O_NOFOLLOW closes the ordinary symlink-swap window after the directory
    # inspection. Only copied, digest-checked bytes reach the SQLite validator.
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as original, target.open('xb') as copied:
        before = os.fstat(original.fileno())
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= maximum:
            raise ValueError('Artifact changed or exceeds its size limit: ' + source.name)
        digest, size = hashlib.sha256(), 0
        while chunk := original.read(1024 * 1024):
            size += len(chunk)
            if size > maximum:
                raise ValueError('Artifact exceeds its size limit: ' + source.name)
            digest.update(chunk)
            copied.write(chunk)
        copied.flush()
        os.fsync(copied.fileno())
        after = os.fstat(original.fileno())
        if size != before.st_size or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('Artifact changed during import: ' + source.name)
        if digest.hexdigest() != expected:
            raise ValueError('Operator SHA-256 mismatch: ' + source.name)
    return size


def provision(artifact: Path, destination: Path, map_sha256: str, manifest_sha256: str) -> dict:
    expected = dict(zip(FILES, (map_sha256, manifest_sha256)))
    if any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value) for value in expected.values()):
        raise ValueError('Both independently reviewed lowercase SHA-256 digests are required')
    artifact = directory_without_symlinks(artifact)
    destination = directory_without_symlinks(destination)
    if {entry.name for entry in artifact.iterdir()} != set(FILES):
        raise ValueError('Artifact must contain exactly palestine.mbtiles and palestine.manifest.json')
    sizes = {name: regular_file(artifact / name, maximum).st_size for name, maximum in FILES.items()}
    for suffix in ('-wal', '-shm', '-journal'):
        if os.path.lexists(destination / ('palestine.mbtiles' + suffix)):
            raise ValueError('Preserving existing SQLite sidecar; close/checkpoint before import')
    # Check both destinations before creating either output. In particular, a
    # conflicting tracked manifest must never replace or introduce the map.
    for name, maximum in FILES.items():
        existing_identical(destination / name, expected[name], sizes[name], maximum)
    created: list[tuple[Path, int, int]] = []
    with tempfile.TemporaryDirectory(prefix='.palmesh-import-', dir=destination) as temporary:
        staging = Path(temporary)
        for name, maximum in FILES.items():
            copied_size = snapshot(artifact / name, staging / name, expected[name], maximum)
            if copied_size != sizes[name]:
                raise ValueError('Artifact changed before import: ' + name)
        checked_manifest(staging / 'palestine.manifest.json', staging / 'palestine.mbtiles')
        # Recheck after provenance/coverage validation; a validator result is not
        # permission to publish changed bytes or overwrite an existing asset.
        for name, maximum in FILES.items():
            if sha256(staging / name) != expected[name]:
                raise ValueError('Validated snapshot changed: ' + name)
            existing_identical(destination / name, expected[name], sizes[name], maximum)
        try:
            for name, maximum in FILES.items():
                target = destination / name
                if existing_identical(target, expected[name], sizes[name], maximum):
                    continue
                try:
                    # A hard link publishes the validated snapshot atomically
                    # and fails if a file appeared; replace() would overwrite it.
                    os.link(staging / name, target, follow_symlinks=False)
                except FileExistsError as error:
                    raise ValueError('Destination appeared during import; no overwrite attempted: ' + name) from error
                info = target.lstat()
                created.append((target, info.st_dev, info.st_ino))
            for name, maximum in FILES.items():
                if not existing_identical(destination / name, expected[name], sizes[name], maximum):
                    raise ValueError('Destination disappeared during import: ' + name)
        except BaseException:
            # Roll back only links created by this invocation, never a changed
            # or pre-existing operator file. An interrupted pair fails release.
            for target, device, inode in reversed(created):
                if os.path.lexists(target):
                    current = target.lstat()
                    if (current.st_dev, current.st_ino) == (device, inode):
                        target.unlink()
            raise
    return {'mapSha256': map_sha256, 'manifestSha256': manifest_sha256,
            'mapBytes': sizes['palestine.mbtiles'], 'manifestBytes': sizes['palestine.manifest.json']}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact-directory', required=True, type=Path)
    parser.add_argument('--map-sha256', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    args = parser.parse_args()
    provision(args.artifact_directory, ROOT / 'mapdata', args.map_sha256, args.manifest_sha256)
    print('Operator-pinned map pair imported after full provenance and coverage validation.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, sqlite3.Error) as error:
        raise SystemExit('Reviewed map import failed: ' + str(error))
