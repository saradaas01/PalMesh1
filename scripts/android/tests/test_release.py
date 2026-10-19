"""Exercise release safety gates without Gradle, network access or private keys."""
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SCRIPTS = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ApkVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.sdk = self.root / 'sdk'
        for executable in ['aapt2', 'zipalign', 'lib/apksigner.jar']:
            path = self.sdk / 'build-tools/37.0.0' / executable
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        self.module = load('verify-apk')
        self.fingerprint = 'ab' * 32
        self.badging = "package: name='org.palmesh' versionCode='1' versionName='0.1.0'\nlaunchable-activity: name='org.palmesh.MainActivity'\n"

    def apk(self, *, bundle=True, map_data=False):
        path = self.root / 'app.apk'
        with zipfile.ZipFile(path, 'w') as archive:
            for entry in ['AndroidManifest.xml', 'classes.dex', 'resources.arsc']:
                archive.writestr(entry, b'fixture')
            for library in ['libreactnative.so', 'libhermesvm.so', 'libmaplibre.so', 'libop-sqlite.so']:
                archive.writestr('lib/arm64-v8a/' + library, b'fixture')
            if bundle: archive.writestr('assets/index.android.bundle', b'fixture-js')
            if map_data:
                archive.writestr('assets/palmesh/palestine.mbtiles', b'fixture-map')
                archive.writestr('assets/palmesh/palestine.manifest.json', json.dumps({'sha256': hashlib.sha256(b'fixture-map').hexdigest()}))
        return path

    def verify(self, apk, *options, pin=True, certificate='CN=Operator'):
        environment = {'ANDROID_HOME': str(self.sdk)}
        if pin: environment['PALMESH_RELEASE_CERT_SHA256'] = self.fingerprint
        signature = f'Signer #1 certificate DN: {certificate}\nSigner #1 certificate SHA-256 digest: {self.fingerprint}\n'
        with patch.dict(os.environ, environment, clear=True), patch.object(sys, 'argv', ['verify', str(apk), *options]), \
                patch.object(self.module.subprocess, 'check_output', side_effect=[self.badging, signature]), \
                patch.object(self.module.subprocess, 'run') as alignment, redirect_stdout(io.StringIO()) as output:
            self.module.main()
            self.assertEqual(alignment.call_count, 1)
            return json.loads(output.getvalue())

    def test_bundled_development_apk_reports_limits(self):
        report = self.verify(self.apk(), '--require-bundle', '--architectures', 'arm64-v8a')
        self.assertTrue(report['embeddedJavaScriptBundle'])
        self.assertFalse(report['bundledPalestineMap'])
        self.assertFalse(report['deviceInstallationTested'])

    def test_release_checks_packaged_map_and_operator_certificate(self):
        report = self.verify(self.apk(map_data=True), '--release', '--version-code', '1', '--version-name', '0.1.0')
        self.assertTrue(report['bundledPalestineMap'])
        self.assertEqual(report['signingCertificateSha256'], [self.fingerprint])

    def test_missing_javascript_fails(self):
        with self.assertRaisesRegex(ValueError, 'JavaScript'):
            self.verify(self.apk(bundle=False), '--require-bundle')

    def test_release_without_map_fails(self):
        with self.assertRaisesRegex(ValueError, 'map pack'):
            self.verify(self.apk(), '--release')

    def test_release_without_certificate_pin_fails(self):
        with self.assertRaisesRegex(ValueError, 'requires PALMESH_RELEASE_CERT_SHA256'):
            self.verify(self.apk(map_data=True), '--release', pin=False)

    def test_debug_signing_identity_fails_release(self):
        with self.assertRaisesRegex(ValueError, 'development signing'):
            self.verify(self.apk(map_data=True), '--release', certificate='CN=Android Debug')

    def test_unexpected_abi_and_version_fail(self):
        with self.assertRaisesRegex(ValueError, 'architecture'):
            self.verify(self.apk(), '--architectures', 'x86_64')
        with self.assertRaisesRegex(ValueError, 'versionCode'):
            self.verify(self.apk(), '--version-code', '42')

    def test_tampered_packaged_map_fails(self):
        apk = self.apk(map_data=True)
        with zipfile.ZipFile(apk) as archive:
            contents = {entry: archive.read(entry) for entry in archive.namelist()}
        contents['assets/palmesh/palestine.mbtiles'] = b'changed-map'
        with zipfile.ZipFile(apk, 'w') as archive:
            for entry, value in contents.items(): archive.writestr(entry, value)
        with self.assertRaisesRegex(ValueError, 'provenance manifest'):
            self.verify(apk, '--release')


class SourceArchiveTests(unittest.TestCase):
    def test_boost_archive_rejects_path_traversal(self):
        module = load('prepare-boost')
        for name in ['/tmp/injected', 'boost-1.83.0/../../injected', 'other-release/file']:
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'archive path'):
                module.member_relative(tarfile.TarInfo(name))
        self.assertEqual(module.member_relative(tarfile.TarInfo('boost-1.83.0/boost/version.hpp')), Path('boost/version.hpp'))

    def test_boost_download_rejects_plain_http_redirect(self):
        module = load('prepare-boost')
        with self.assertRaisesRegex(RuntimeError, 'downgrades HTTPS'):
            module.HttpsRedirectsOnly().redirect_request(None, None, 302, '', {}, 'http://invalid.example/archive')


class GradleWrapperTests(unittest.TestCase):
    def test_source_build_uses_portable_cache_and_daemon_cpu_limit(self):
        module = load('gradle')
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary)
            (cache / 'boost-flat').mkdir()
            environment = {'PALMESH_TOOLS_ROOT': str(cache / 'absent-tool-cache')}
            with patch.dict(os.environ, environment, clear=True), \
                    patch.object(sys, 'argv', ['gradle', '--source-build', '--bundle-debug', '--dependency-cache', str(cache), ':app:assembleDebug']), \
                    patch.object(module.subprocess, 'call', return_value=0) as gradle:
                self.assertEqual(module.main(), 0)
                command = gradle.call_args.args[0]
                actual = gradle.call_args.kwargs['env']
                self.assertNotIn('JDK_JAVA_OPTIONS', actual)
                self.assertNotIn('ICU_ROOT', actual)  # System ICU remains usable.
                self.assertEqual(actual['REACT_NATIVE_BOOST_PATH'], str(cache / 'boost-flat'))
                self.assertEqual(actual['PALMESH_BUNDLE_DEBUG'], '1')
                self.assertTrue(any(arg.startswith('-Dorg.gradle.jvmargs=') and 'ActiveProcessorCount=2' in arg for arg in command))
                self.assertIn(str(SCRIPTS / 'hermes-source.init.gradle'), command)

    def test_inherited_java_launcher_options_fail_before_prefab(self):
        module = load('gradle')
        with patch.dict(os.environ, {'JDK_JAVA_OPTIONS': '-Xmx1g'}, clear=True), \
                patch.object(sys, 'argv', ['gradle']), patch.object(module.subprocess, 'call') as gradle, \
                patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
            module.main()
        gradle.assert_not_called()

    def test_proxy_credentials_never_reach_java_command(self):
        module = load('gradle')
        with patch.dict(os.environ, {'HTTPS_PROXY': 'https://user:private-value@proxy.example:443'}, clear=True), \
                patch.object(sys, 'argv', ['gradle']), patch.object(module.subprocess, 'call') as gradle, \
                patch('sys.stderr', io.StringIO()) as error, self.assertRaises(SystemExit):
            module.main()
        gradle.assert_not_called()
        self.assertNotIn('private-value', error.getvalue())


if __name__ == '__main__':
    unittest.main()
