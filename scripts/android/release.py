#!/usr/bin/env python3
"""Build and verify an operator-signed, map-complete Android production artifact."""
from __future__ import annotations
import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SIGNING = ['PALMESH_RELEASE_STORE_FILE', 'PALMESH_RELEASE_STORE_PASSWORD', 'PALMESH_RELEASE_KEY_ALIAS', 'PALMESH_RELEASE_KEY_PASSWORD', 'PALMESH_RELEASE_CERT_SHA256']


def run(command: list[str]) -> None:
    # Commands contain variable names and public paths, never signing passwords.
    subprocess.run(command, cwd=ROOT, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-build', action='store_true')
    parser.add_argument('--architectures', default='arm64-v8a')
    parser.add_argument('--skip-checks', action='store_true', help='Use only after the exact sources have passed npm run check')
    args = parser.parse_args()
    if any(not os.environ.get(key) for key in SIGNING):
        parser.error('Configure the four PALMESH_RELEASE_* signing credentials and PALMESH_RELEASE_CERT_SHA256; releases require an operator identity')
    fingerprint = os.environ[SIGNING[4]].replace(':', '')
    if not re.fullmatch(r'[0-9a-fA-F]{64}', fingerprint): parser.error('PALMESH_RELEASE_CERT_SHA256 must be a SHA-256 certificate fingerprint')
    key = Path(os.environ[SIGNING[0]]).expanduser()
    if not key.is_absolute() or not key.is_file(): parser.error('PALMESH_RELEASE_STORE_FILE must be an existing absolute keystore path')
    version = os.environ.get('PALMESH_VERSION_NAME', '0.1.0')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?', version): parser.error('Invalid PALMESH_VERSION_NAME')
    if not re.fullmatch(r'[1-9][0-9]{0,8}', os.environ.get('PALMESH_VERSION_CODE', '1')): parser.error('Invalid PALMESH_VERSION_CODE')
    # Staging enforces checksums, bounds, license/provenance and local glyphs.
    # A demo or absent map must never silently become a field release.
    run([sys.executable, 'scripts/maps/package.py'])
    if not args.skip_checks: run(['npm', 'run', 'check'])
    command = [sys.executable, 'scripts/android/gradle.py', '--architectures', args.architectures]
    if args.source_build: command.append('--source-build')
    run([*command, ':app:assembleRelease'])
    original = ROOT / 'android/app/build/outputs/apk/release/app-release.apk'
    if not original.is_file(): raise SystemExit('Signed APK was not produced; unsigned artifacts are not distributed')
    output = ROOT / f'dist/android/PalMesh-{version}-{args.architectures.replace(",", "_")}-release.apk'
    output.parent.mkdir(parents=True, exist_ok=True)
    report = output.with_suffix('.verification.json')
    # Verify before copying, so a stale or wrong variant cannot be distributed.
    verification = ['--release', '--architectures', args.architectures, '--version-name', version,
                    '--version-code', os.environ.get('PALMESH_VERSION_CODE', '1')]
    run([sys.executable, 'scripts/android/verify-apk.py', str(original), *verification])
    shutil.copyfile(original, output)
    run([sys.executable, 'scripts/android/verify-apk.py', str(output), *verification, '--report', str(report)])
    with output.open('rb') as stream: digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    output.with_suffix('.apk.sha256').write_text(digest + '  ' + output.name + '\n')
    print('Signed release and verification report: ' + str(output.parent))


if __name__ == '__main__':
    main()
