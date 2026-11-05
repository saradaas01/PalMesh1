#!/usr/bin/env python3
"""Verify APK packaging, application ID, embedded JS, signing and 16 KiB alignment."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import zipfile
import tempfile
import sys


def has_signing_material(apk: Path, archive: zipfile.ZipFile) -> bool:
    """Unsigned inspection rejects v1 entries and the v2/v3 APK signing block.

    A failed cryptographic verification alone cannot distinguish a truly unsigned
    file from a damaged signature, so do not treat verifier failure as proof.
    """
    if any(name.upper().startswith('META-INF/') and name.upper().endswith(('.SF', '.RSA', '.DSA', '.EC'))
           for name in archive.namelist()):
        return True
    # APK Signature Scheme v2/v3 places this footer immediately before the ZIP
    # central directory. ZipFile has already located and parsed that directory.
    if archive.start_dir >= 16:
        with apk.open('rb') as stream:
            stream.seek(archive.start_dir - 16)
            if stream.read(16) == b'APK Sig Block 42': return True
    return False


def elf_load_alignment(data: bytes) -> int:
    """Require native LOAD segments usable with 16 KiB memory pages."""
    if len(data) < 16 or data[:4] != b'\x7fELF' or data[4] not in (1, 2) or data[5] not in (1, 2):
        raise ValueError('Invalid ELF identification')
    endian = '<' if data[5] == 1 else '>'
    is64 = data[4] == 2
    header_size, program_size = (64, 56) if is64 else (52, 32)
    if len(data) < header_size: raise ValueError('Truncated ELF header')
    offset = struct.unpack_from(endian + ('Q' if is64 else 'I'), data, 32 if is64 else 28)[0]
    size, count = struct.unpack_from(endian + 'HH', data, 54 if is64 else 42)
    if size < program_size or not 1 <= count <= 1024 or offset < header_size or offset + size * count > len(data):
        raise ValueError('Invalid ELF program table')
    alignments = []
    for index in range(count):
        values = struct.unpack_from(endian + ('IIQQQQQQ' if is64 else 'IIIIIIII'), data, offset + index * size)
        if values[0] != 1: continue
        if is64:
            _, _, file_offset, virtual, _, file_size, memory_size, alignment = values
        else:
            _, file_offset, virtual, _, file_size, memory_size, _, alignment = values
        if alignment < 16384 or alignment & (alignment - 1) or file_offset % 16384 != virtual % 16384:
            raise ValueError('ELF LOAD segment lacks 16 KiB alignment')
        if file_size > memory_size or file_offset + file_size > len(data):
            raise ValueError('Invalid ELF LOAD segment bounds')
        alignments.append(alignment)
    if not alignments: raise ValueError('ELF has no LOAD segments')
    return min(alignments)


def apk_diagnostics(apk: Path, tools: Path) -> bool:
    tree = subprocess.check_output([str(tools/'aapt2'),'dump','xmltree',str(apk),'--file','AndroidManifest.xml'],text=True)
    for block in tree.split('E: meta-data'):
        if '\"com.palmesh.MAP_DIAGNOSTICS\"' not in block: continue
        match=re.search(r'android:value[^\n]*?=(?:\(type 0x12\)(0x[0-9a-fA-F]+)|(true|false))(?=\s|$)',block)
        if match:return int(match[1],16)!=0 if match[1] else match[2]=='true'
        raise ValueError('Invalid APK map diagnostics metadata')
    raise ValueError('Missing explicit APK map diagnostics metadata')

def validate_aqaba_assets(archive: zipfile.ZipFile) -> dict:
    """Inspect the actual installed resources, with a pinned map and source glyph atlas."""
    scripts=Path(__file__).resolve().parents[1]/'maps'
    sys.path.insert(0,str(scripts))
    from mbtiles import checked_manifest, validate
    from package import checked_fonts, MAP_LICENSE_SHA256
    manifest=json.loads(archive.read('assets/palmesh/jordan.manifest.json'))
    if manifest.get('sha256')!='4a291b601e85628eea7e0d51595c027044c078eee89ec5ff39866d49ec106ba2':raise ValueError('Aqaba demo requires the pinned genuine Jordan map')
    source_fonts=json.loads((Path(__file__).resolve().parents[2]/'assets/map-fonts/manifest.json').read_text())
    packaged_fonts=json.loads(archive.read('assets/palmesh/fonts/manifest.json'))
    if packaged_fonts!=source_fonts:raise ValueError('Packaged glyph manifest differs from validated source')
    expected={'Klokantech Noto Sans Regular/%d-%d.pbf'%(low,low+255) for low in range(0,65536,256)}
    if set(packaged_fonts.get('ranges',{}))!=expected:raise ValueError('Aqaba demo requires all 256 glyph pages')
    with tempfile.TemporaryDirectory(prefix='palmesh-aqaba-verify-') as folder:
        root=Path(folder)
        (root/'jordan.mbtiles').write_bytes(archive.read('assets/palmesh/jordan.mbtiles'))
        (root/'jordan.manifest.json').write_text(json.dumps(manifest))
        fonts=root/'fonts';fonts.mkdir()
        (fonts/'manifest.json').write_text(json.dumps(packaged_fonts))
        for relative in [*sorted(expected),'LICENSE-OFL.txt']:
            entry='assets/palmesh/fonts/'+relative
            if archive.getinfo(entry).file_size>512*1024:raise ValueError('Oversized packaged glyph resource')
            path=fonts/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(archive.read(entry))
        checked_fonts(fonts)
        checked_manifest(root/'jordan.manifest.json',root/'jordan.mbtiles')
        report=validate(root/'jordan.mbtiles',manifest['sha256'])
    if hashlib.sha256(archive.read('assets/palmesh/licenses/LICENSE-ODbL-1.0.txt')).hexdigest()!=MAP_LICENSE_SHA256:raise ValueError('Missing or changed packaged map license')
    if not archive.read('assets/palmesh/licenses/OSM-ATTRIBUTION.txt').strip():raise ValueError('Missing packaged map attribution')
    return {'glyphRangeCount':256,'mapSha256':manifest['sha256'],'coverage':report}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk', type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--release', action='store_true')
    mode.add_argument('--unsigned-preview', action='store_true', help='Inspect unsigned nondebuggable packaging; never install or distribute this artifact')
    mode.add_argument('--isolated-aqaba-demo',action='store_true',help='Separate Aqaba demo, never a release')
    mode.add_argument('--isolated-emergency-test',action='store_true',help='Separate Emergency Map test app, never a release')
    mode.add_argument('--isolated-ux-test',action='store_true',help='Separate redesign test app; never a release')
    mode.add_argument('--isolated-contacts-test', action='store_true', help='Separate contact test app; never a release')
    mode.add_argument('--isolated-map-test', action='store_true', help='Verify the separately identified, debuggable map-test app; never a release')
    mode.add_argument('--isolated-map-performance-test', action='store_true', help='Separate map performance app, never a release')
    parser.add_argument('--synthetic-emergency-fixture',action='store_true',help='Emulator-only alternate entry, refused in human/release APKs')
    parser.add_argument('--allow-map-diagnostics',action='store_true',help='Explicit Aqaba x86 acceptance diagnostics only')
    parser.add_argument('--require-bundle', action='store_true')
    parser.add_argument('--architectures', help='Expected comma-separated ABI set')
    parser.add_argument('--version-name')
    parser.add_argument('--version-code')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    is_test = args.isolated_aqaba_demo or args.isolated_emergency_test or args.isolated_ux_test or args.isolated_contacts_test or args.isolated_map_test or args.isolated_map_performance_test
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
        if args.unsigned_preview and has_signing_material(apk, archive):
            raise ValueError('Unsigned preview must not contain APK signing material')
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
        native_alignment = {name: elf_load_alignment(archive.read(name)) for name in libraries}
        bundled = 'assets/index.android.bundle' in entries and archive.getinfo('assets/index.android.bundle').file_size > 0
        if (args.release or args.unsigned_preview or is_test or args.require_bundle) and not bundled: raise ValueError('Missing embedded JavaScript bundle')
        fixture = bundled and b'PALMESH_SYNTHETIC_EMERGENCY_ONLY' in archive.read('assets/index.android.bundle')
        if fixture != args.synthetic_emergency_fixture: raise ValueError('Unexpected synthetic fixture in APK')
        if args.synthetic_emergency_fixture and (not (args.isolated_emergency_test or args.isolated_aqaba_demo) or architectures != ['x86_64']): raise ValueError('Synthetic fixture requires isolated x86_64 emergency test APK')
        has_map = 'assets/palmesh/jordan.mbtiles' in entries
        if args.release and not has_map: raise ValueError('Release APK is missing the reviewed Jordan map pack')
        if is_test and not has_map: raise ValueError('Isolated map test APK is missing its map pack')
        if args.release or is_test:
            manifest_path = 'assets/palmesh/jordan.manifest.json'
            if manifest_path not in entries or archive.getinfo(manifest_path).file_size > 262144:
                raise ValueError('Missing or oversized bundled map provenance manifest')
            map_manifest = json.loads(archive.read(manifest_path))
            with archive.open('assets/palmesh/jordan.mbtiles') as map_stream:
                packaged_digest = hashlib.file_digest(map_stream, 'sha256').hexdigest()
            if map_manifest.get('sha256') != packaged_digest:
                raise ValueError('Packaged map differs from its provenance manifest')
        aqaba_assets = validate_aqaba_assets(archive) if args.isolated_aqaba_demo else None
    badging = subprocess.check_output([str(tools / 'aapt2'), 'dump', 'badging', str(apk)], text=True)
    package_line = next((line for line in badging.splitlines() if line.startswith('package: ')), '')
    package_fields = dict(re.findall(r"([A-Za-z][A-Za-z0-9]*)='([^']*)'", package_line))
    expected_package = 'org.palmesh.aqabademo' if args.isolated_aqaba_demo else 'org.palmesh.emergencytest' if args.isolated_emergency_test else 'org.palmesh.uxtest' if args.isolated_ux_test else 'org.palmesh.contacttest' if args.isolated_contacts_test else 'org.palmesh.mapperftest' if args.isolated_map_performance_test else 'org.palmesh.maptest' if is_test else 'org.palmesh'
    if package_fields.get('name') != expected_package: raise ValueError('Unexpected application ID')
    for expected, field in [(args.version_name, 'versionName'), (args.version_code, 'versionCode')]:
        if expected is not None and package_fields.get(field) != expected:
            raise ValueError('Unexpected Android ' + field)
    if "launchable-activity: name='org.palmesh.MainActivity'" not in badging: raise ValueError('Missing launcher activity')
    debuggable = 'application-debuggable' in badging
    expected_label = "PalMesh Aqaba Demo" if args.isolated_aqaba_demo else "PalMesh Emergency Map Test" if args.isolated_emergency_test else "PalMesh UX Test" if args.isolated_ux_test else "PalMesh Contacts Test" if args.isolated_contacts_test else "PalMesh Map Performance Test" if args.isolated_map_performance_test else "PalMesh Map Test"
    if is_test and (not debuggable or f"application-label:'{expected_label}'" not in badging):
        raise ValueError('Isolated map test must be debuggable and clearly labelled')
    if (args.release or args.unsigned_preview) and debuggable: raise ValueError('Release or unsigned preview APK must not be debuggable')
    if args.allow_map_diagnostics and (not args.isolated_aqaba_demo or architectures != ['x86_64']): raise ValueError('Diagnostics allowance is only for isolated Aqaba x86 acceptance')
    if args.isolated_aqaba_demo:
        diagnostics = apk_diagnostics(apk, tools)
        if diagnostics != args.allow_map_diagnostics: raise ValueError('Aqaba APK diagnostics differ from intended mode')
    java_value = os.environ.get('JAVA_HOME')
    java = str(Path(java_value) / 'bin/java') if java_value else 'java'
    fingerprints = []
    if not args.unsigned_preview:
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
              'embeddedJavaScriptBundle': bundled, 'bundledMap': has_map, 'debuggable': debuggable,
              'signingCertificateSha256': fingerprints, 'zipAlignment16KiB': True, 'elfAlignment16KiB': True, 'nativeLibraryLoadAlignment': native_alignment, 'deviceInstallationTested': False,
              'verificationMode': 'unsigned-preview' if args.unsigned_preview else 'release' if args.release else 'isolated-aqaba-demo' if args.isolated_aqaba_demo else 'isolated-emergency-test' if args.isolated_emergency_test else 'isolated-ux-test' if args.isolated_ux_test else 'isolated-contacts-test' if args.isolated_contacts_test else 'isolated-map-performance-test' if args.isolated_map_performance_test else 'isolated-map-test' if is_test else 'development',
              'signatureVerified': not args.unsigned_preview, 'installable': not args.unsigned_preview,
              'releaseEligible': args.release}
    if aqaba_assets is not None: report.update(aqabaAssets=aqaba_assets, mapDiagnosticsEnabled=args.allow_map_diagnostics)
    if is_test:
        report.update(isolatedFromPrimaryApp=True, existingIdentityMigrated=False)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
