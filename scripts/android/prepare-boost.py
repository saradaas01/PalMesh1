#!/usr/bin/env python3
"""Reproduce the local Boost 1.83 headers used by the React Native source build.

The SHA-256 below is a recorded pin of the archive downloaded directly from
boostorg's official GitHub release over certificate-verified HTTPS. It is not a
publisher signature or an independently verified, publisher-issued checksum.
All downloads retain normal TLS verification; no alternate mirrors are used.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(os.environ.get("PALMESH_SOURCE_CACHE", Path.home() / ".cache/palmesh/source-deps"))
DOWNLOADS = ROOT / "downloads"
SOURCE = ROOT / "boost_1_83_0"
FLAT_ROOT = ROOT / "boost-flat"
FLAT = FLAT_ROOT / "boost_1_83_0" / "boost"
URL = "https://github.com/boostorg/boost/releases/download/boost-1.83.0/boost-1.83.0.tar.gz"
ARCHIVE = DOWNLOADS / "boost-1.83.0.tar.gz"
SIZE = 123695390
PIN = "0c6049764e80aa32754acd7d4f179fd5551d8172a83b71532ae093e7384e98da"
ARCHIVE_PREFIX = "boost-1.83.0"
EXPECTED_HEADERS = 15177


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def archive_matches() -> bool:
    return (ARCHIVE.is_file() and not ARCHIVE.is_symlink()
            and ARCHIVE.stat().st_size == SIZE and digest(ARCHIVE) == PIN)


class HttpsRedirectsOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, target):
        if not target.startswith("https://"):
            raise RuntimeError("Refusing an archive redirect that downgrades HTTPS")
        return super().redirect_request(request, response, code, message, headers, target)


def fetch() -> None:
    if archive_matches():
        print("Verified cached official archive against the recorded SHA-256 pin", flush=True)
        return
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    temporary = DOWNLOADS / f".boost-download-{os.getpid()}"
    try:
        opener = urllib.request.build_opener(HttpsRedirectsOnly())
        with opener.open(URL, timeout=60) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
        if temporary.stat().st_size != SIZE or digest(temporary) != PIN:
            raise RuntimeError("Official Boost archive differs from its recorded size/SHA-256 pin")
        temporary.replace(ARCHIVE)
    finally:
        temporary.unlink(missing_ok=True)
    print("Downloaded official archive and verified its recorded SHA-256 pin", flush=True)


def member_relative(member: tarfile.TarInfo) -> Path:
    path = PurePosixPath(member.name)
    if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != ARCHIVE_PREFIX:
        raise RuntimeError(f"Unsafe/unexpected archive path: {member.name}")
    return Path(*path.parts[1:])


def source_matches() -> bool:
    """Check original source files against the pinned archive, allowing build outputs."""
    if not SOURCE.is_dir() or SOURCE.is_symlink():
        return False
    source_root = SOURCE.resolve()
    with tarfile.open(ARCHIVE, "r:gz") as archive:
        for member in archive:
            target = SOURCE / member_relative(member)
            if not target.resolve().is_relative_to(source_root):
                return False
            if member.isdir():
                if not target.is_dir() or target.is_symlink():
                    return False
            elif member.isfile():
                if (not target.is_file() or target.is_symlink()
                        or target.stat().st_size != member.size):
                    return False
                content = archive.extractfile(member)
                assert content is not None
                with content:
                    expected = hashlib.file_digest(content, "sha256").hexdigest()
                if digest(target) != expected:
                    return False
            elif member.issym():
                if not target.is_symlink() or os.readlink(target) != member.linkname:
                    return False
            else:
                raise RuntimeError(f"Unexpected archive member type: {member.name}")
    return True


def replace_directory(staging: Path, destination: Path) -> None:
    """Install a complete tree without truncating files another build may have open."""
    backup = destination.with_name(destination.name + f".previous-{os.getpid()}")
    if destination.exists() or destination.is_symlink():
        destination.rename(backup)
    try:
        staging.rename(destination)
    except BaseException:
        if backup.exists() or backup.is_symlink():
            backup.rename(destination)
        raise
    if backup.is_symlink():
        backup.unlink()
    elif backup.exists():
        shutil.rmtree(backup)


def prepare_source() -> None:
    if source_matches():
        print("Verified existing source files against the pinned archive", flush=True)
    else:
        with tempfile.TemporaryDirectory(prefix=".boost-extract-", dir=ROOT) as temporary:
            with tarfile.open(ARCHIVE, "r:gz") as archive:
                members = archive.getmembers()
                for member in members:
                    member_relative(member)
                archive.extractall(temporary, members=members, filter="data")
            replace_directory(Path(temporary) / ARCHIVE_PREFIX, SOURCE)
        if not source_matches():
            raise RuntimeError("Post-extraction source verification failed")
    if not (SOURCE / "b2").is_file():
        subprocess.run(["./bootstrap.sh"], cwd=SOURCE, check=True)
    subprocess.run(["./b2", "-q", "-j2", "headers"], cwd=SOURCE, check=True)


def union_files() -> dict[Path, Path]:
    """Follow Boost's generated header links, rejecting links outside its source tree."""
    union = SOURCE / "boost"
    if not union.is_dir():
        raise RuntimeError("Boost's header union has not been generated")
    files: dict[Path, Path] = {}
    root = SOURCE.resolve()
    visited: set[Path] = set()
    for folder, directories, names in os.walk(union, followlinks=True):
        current = Path(folder)
        resolved = current.resolve()
        if not resolved.is_relative_to(root) or resolved in visited:
            raise RuntimeError(f"Unsafe or cyclic Boost header directory: {current}")
        visited.add(resolved)
        for name in directories + names:
            path = current / name
            if not path.exists() or not path.resolve().is_relative_to(root):
                raise RuntimeError(f"Broken or escaping Boost header link: {path}")
        for name in names:
            path = current / name
            if not path.is_file():
                raise RuntimeError(f"Unexpected Boost header entry: {path}")
            files[path.relative_to(union)] = path
    version = (union / "version.hpp").read_text()
    if (not re.search(r"^#define BOOST_VERSION 108300$", version, re.M)
            or not re.search(r'^#define BOOST_LIB_VERSION "1_83"$', version, re.M)):
        raise RuntimeError("Boost version header does not identify 1.83.0")
    if sum(path.suffix == ".hpp" for path in files) != EXPECTED_HEADERS:
        raise RuntimeError("Boost's generated header union has an unexpected header count")
    return files


def flat_matches(files: dict[Path, Path]) -> bool:
    if not FLAT.is_dir() or FLAT.is_symlink():
        return False
    actual = set()
    for path in FLAT.rglob("*"):
        if path.is_symlink():
            return False
        if path.is_file():
            actual.add(path.relative_to(FLAT))
    if actual != set(files):
        return False
    return all((FLAT / relative).stat().st_size == source.stat().st_size
               and digest(FLAT / relative) == digest(source)
               for relative, source in files.items())


def materialize(files: dict[Path, Path]) -> None:
    if flat_matches(files):
        print("Verified existing regular header tree; no files replaced", flush=True)
        return
    FLAT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".boost-flat-", dir=FLAT.parent) as temporary:
        staging = Path(temporary) / "boost"
        shutil.copytree(SOURCE / "boost", staging, symlinks=False)
        replace_directory(staging, FLAT)
    if not flat_matches(files):
        raise RuntimeError("Materialized header verification failed")


def main() -> None:
    global ROOT, DOWNLOADS, SOURCE, FLAT_ROOT, FLAT, ARCHIVE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=ROOT, help="Source dependency cache outside the checkout")
    parser.add_argument("--verify-only", action="store_true",
                        help="verify cached archive, source and regular headers without downloading/building")
    arguments = parser.parse_args()
    ROOT = arguments.cache.expanduser().resolve()
    DOWNLOADS = ROOT / "downloads"
    SOURCE = ROOT / "boost_1_83_0"
    FLAT_ROOT = ROOT / "boost-flat"
    FLAT = FLAT_ROOT / "boost_1_83_0" / "boost"
    ARCHIVE = DOWNLOADS / "boost-1.83.0.tar.gz"
    if arguments.verify_only:
        if not archive_matches() or not source_matches():
            raise RuntimeError("Cached Boost archive/source verification failed")
        files = union_files()
        if not flat_matches(files):
            raise RuntimeError("Materialized regular Boost headers differ from verified source")
    else:
        ROOT.mkdir(parents=True, exist_ok=True)
        fetch()
        prepare_source()
        files = union_files()
        materialize(files)
        provenance = {
            "source_url": URL, "bytes": SIZE, "sha256_recorded_pin": PIN,
            "pin_basis": "Recorded from the official boostorg GitHub release over verified HTTPS; not a publisher signature or independently verified publisher checksum",
            "external_published_digest_verified": False,
            "boost_version": 108300, "boost_lib_version": "1_83",
            "regular_hpp_count": EXPECTED_HEADERS,
            "regular_files_total": len(files), "override_root": str(FLAT_ROOT),
        }
        (DOWNLOADS / "boost-1.83.0.provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(f"Boost 1.83.0 verified: {EXPECTED_HEADERS} regular .hpp headers, zero symlinks", flush=True)
    print(f"REACT_NATIVE_BOOST_PATH={FLAT_ROOT}", flush=True)


if __name__ == "__main__":
    main()
