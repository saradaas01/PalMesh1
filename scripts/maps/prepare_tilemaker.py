#!/usr/bin/env python3
"""Build pinned official tilemaker source using preinstalled system dependencies."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import urllib.request

COMMIT = 'c7d1dbfaf87baa9e0bc9b2e984e0dae90dcf00c5'
SOURCE_URL = 'https://codeload.github.com/systemed/tilemaker/tar.gz/' + COMMIT
SOURCE_BYTES = 43874629
SOURCE_SHA256 = '44e96b89a08bba091d864ad9e5058b25189269b2412ccfbcd61a32e51b287133'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, required=True, help='New directory; existing files are never overwritten')
    args = parser.parse_args()
    root = args.workspace.resolve()
    root.mkdir(parents=True, exist_ok=False)
    archive = root / 'tilemaker.tar.gz'
    digest = hashlib.sha256()
    count = 0
    with urllib.request.urlopen(SOURCE_URL, timeout=60) as response, archive.open('xb') as target:
        for chunk in iter(lambda: response.read(1024 * 1024), b''):
            count += len(chunk)
            if count > SOURCE_BYTES: raise ValueError('Official tilemaker archive exceeds pinned size')
            digest.update(chunk)
            target.write(chunk)
    if count != SOURCE_BYTES or digest.hexdigest() != SOURCE_SHA256:
        raise ValueError('Official tilemaker source size/hash mismatch')
    with tarfile.open(archive) as source:
        source.extractall(root / 'source', filter='data')
    source_dir = root / 'source' / ('tilemaker-' + COMMIT)
    subprocess.run(['cmake', '-S', str(source_dir), '-B', str(root / 'build'),
                    '-DCMAKE_BUILD_TYPE=Release', '-DTM_VERSION=v3.2.0'], check=True)
    subprocess.run(['cmake', '--build', str(root / 'build'), '--parallel', '2'], check=True)
    binary = root / 'build/tilemaker'
    subprocess.run([str(binary), '--help'], check=True)
    (root / 'source-provenance.json').write_text(json.dumps({
        'sourceUrl': SOURCE_URL, 'sourceCommit': COMMIT, 'sourceSha256': SOURCE_SHA256,
        'sourceBytes': count, 'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
        'note': 'Repository-maintained source pin, not an independent publisher signature or security audit.'
    }, indent=2) + '\n')


if __name__ == '__main__':
    main()
