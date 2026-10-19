#!/usr/bin/env python3
"""Verify APK packaging, application ID, embedded JS, signing and 16 KiB alignment."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk', type=Path)
    parser.add_argument('--release', action='store_true')
    parser.add_argument('--require-bundle', action='store_true')
    parser.add_argument('--architectures', help='Expected comma-separated ABI set')
    parser.add_argument('--version-name')
    parser.add_argument('--version-code')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    sdk_value = os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT')
    sdk = Path(sdk_value) if sdk_value else Path('/workspace/.palmesh-tools/android-sdk')
    tools = sdk / 'build-tools/37.0.0'
    for executable in ['aapt2', 'zipalign', 'lib/apksigner.jar']:
        if not (tools / executable).is_file(): parser.error('Android build-tools 37.0.0 are required')
    apk = args.apk.resolve(strict=True)
    with zipfile.ZipFile(apk) as archive:
        corrupt = archive.testzip()
        if corrupt is not None: raise ValueError('Corrupt APK entry: ' + corrupt)
        entries = set(archive.namelist())
        if len(entries) != len(archive.namelist()): raise ValueError('Ambiguous APK with duplicate entry names')
        required = {'AndroidManifest.xml', 'classes.dex', 'resources.arsc'}
        if not required <= entries: raise ValueError('Missing required APK metadata')
        libraries = sorted(name for name in entries if name.startswith('lib/') and name.endswith('.so'))
        architectures = sorted({name.split('/')[1] for name in libraries})
        if not architectures: raise ValueError('No native runtime libraries')
        if args.architectures and set(architectures) != set(args.architectures.split(',')):
            raise ValueError('APK architecture set differs from the requested build')
        for architecture in architectures:
            runtimes = {f'lib/{architecture}/{name}' for name in ['libreactnative.so', 'libhermesvm.so', 'libmaplibre.so', 'libop-sqlite.so']}
            if not runtimes <= entries: raise ValueError('Missing native runtime libraries for ' + architecture)
        bundled = 'assets/index.android.bundle' in entries and archive.getinfo('assets/index.android.bundle').file_size > 0
        if (args.release or args.require_bundle) and not bundled: raise ValueError('Missing embedded JavaScript bundle')
        has_map = 'assets/palmesh/palestine.mbtiles' in entries
        if args.release and not has_map: raise ValueError('Release APK is missing the reviewed Palestine map pack')
        if args.release:
            manifest_path = 'assets/palmesh/palestine.manifest.json'
            if manifest_path not in entries or archive.getinfo(manifest_path).file_size > 262144:
                raise ValueError('Missing or oversized bundled map provenance manifest')
            map_manifest = json.loads(archive.read(manifest_path))
            with archive.open('assets/palmesh/palestine.mbtiles') as map_stream:
                packaged_digest = hashlib.file_digest(map_stream, 'sha256').hexdigest()
            if map_manifest.get('sha256') != packaged_digest:
                raise ValueError('Packaged map differs from its provenance manifest')
    badging = subprocess.check_output([str(tools / 'aapt2'), 'dump', 'badging', str(apk)], text=True)
    package_line = next((line for line in badging.splitlines() if line.startswith('package: ')), '')
    package_fields = dict(re.findall(r"([A-Za-z][A-Za-z0-9]*)='([^']*)'", package_line))
    if package_fields.get('name') != 'org.palmesh': raise ValueError('Unexpected application ID')
    for expected, field in [(args.version_name, 'versionName'), (args.version_code, 'versionCode')]:
        if expected is not None and package_fields.get(field) != expected:
            raise ValueError('Unexpected Android ' + field)
    if "launchable-activity: name='org.palmesh.MainActivity'" not in badging: raise ValueError('Missing launcher activity')
    debuggable = 'application-debuggable' in badging
    if args.release and debuggable: raise ValueError('Release APK must not be debuggable')
    java_value = os.environ.get('JAVA_HOME')
    java = str(Path(java_value) / 'bin/java') if java_value else 'java'
    signature = subprocess.check_output([java, '-jar', str(tools / 'lib/apksigner.jar'), 'verify', '--verbose', '--print-certs', str(apk)], text=True)
    if args.release and re.search(r'Android Debug', signature, re.IGNORECASE): raise ValueError('Release APK uses a development signing identity')
    fingerprints = re.findall(r'certificate SHA-256 digest: ([0-9a-fA-F]+)', signature)
    if not fingerprints: raise ValueError('No signing certificate fingerprint was reported')
    expected = os.environ.get('PALMESH_RELEASE_CERT_SHA256')
    if args.release and not expected: raise ValueError('Release verification requires PALMESH_RELEASE_CERT_SHA256')
    if expected and not re.fullmatch(r'[0-9a-fA-F]{64}', expected.replace(':', '')):
        raise ValueError('PALMESH_RELEASE_CERT_SHA256 is not a SHA-256 fingerprint')
    if expected and expected.lower().replace(':', '') not in [value.lower() for value in fingerprints]:
        raise ValueError('Signing certificate does not match PALMESH_RELEASE_CERT_SHA256')
    subprocess.run([str(tools / 'zipalign'), '-c', '-P', '16', '4', str(apk)], check=True)
    with apk.open('rb') as stream: digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    report = {'apk': str(apk), 'bytes': apk.stat().st_size, 'sha256': digest, 'architectures': architectures,
              'applicationId': package_fields['name'], 'versionName': package_fields.get('versionName'), 'versionCode': package_fields.get('versionCode'),
              'embeddedJavaScriptBundle': bundled, 'bundledPalestineMap': has_map, 'debuggable': debuggable,
              'signingCertificateSha256': fingerprints, 'zipAlignment16KiB': True, 'deviceInstallationTested': False}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
