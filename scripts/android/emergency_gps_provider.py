"""Controlled, synthetic OS location for disposable API 35 emulator replays.

This is harness-only evidence, never a physical GNSS test. Android's test
providers replace the real providers and remain empty until inject_fix().
Command syntax and dumpsys markers are pinned to the official AOSP API 35 source:
https://github.com/aosp-mirror/platform_frameworks_base/blob/android-15.0.0_r1/services/core/java/com/android/server/location/LocationShellCommand.java
https://github.com/aosp-mirror/platform_frameworks_base/blob/android-15.0.0_r1/services/core/java/com/android/server/location/provider/LocationProviderManager.java
"""
import json
import re


PROVIDERS = ('gps', 'network')
SYNTHETIC_LOCATION = '31.5,34.47'
SYNTHETIC_ACCURACY_METERS = '8'


def provider_section(dump, provider):
    """Select one exact mocked provider; another provider cannot satisfy checks."""
    lines = dump.splitlines()
    for index, line in enumerate(lines):
        if line.strip() != provider + ' provider [mock]:':
            continue
        indent = len(line) - len(line.lstrip())
        section = []
        for following in lines[index + 1:]:
            if following.strip() and len(following) - len(following.lstrip()) <= indent:
                break
            section.append(following.strip())
        return section
    raise RuntimeError('Controlled emulator ' + provider + ' provider was not installed')


def require_empty_provider(dump, provider):
    section = provider_section(dump, provider)
    last_locations = [line for line in section if line.startswith('last location=')]
    if not last_locations or any(line != 'last location=null' for line in last_locations):
        raise RuntimeError('Controlled emulator ' + provider + ' provider retained a location')
    if any(marker not in section for marker in ('enabled=true', 'allowed=true', 'last mock location=null')):
        raise RuntimeError('Controlled emulator ' + provider + ' provider is not empty and enabled')


class EmulatorGpsProvider:
    """Use a smoke runner's serial-bound command API; never grant app permissions."""
    def __init__(self, runner):
        self.runner = runner
        self.installed = False
        self.injections = 0

    def guard(self):
        if not re.fullmatch(r'emulator-[0-9]+', self.runner.serial):
            raise RuntimeError('Synthetic GPS accepts emulator serials only')
        emulated = any(self.runner.command('shell', 'getprop', key) == '1'
                       for key in ('ro.kernel.qemu', 'ro.boot.qemu'))
        if not emulated:
            raise RuntimeError('Refusing synthetic GPS on a non-emulator device')
        if self.runner.command('shell', 'getprop', 'ro.build.version.sdk') != '35':
            raise RuntimeError('Controlled synthetic GPS requires the pinned API 35 emulator')

    def record(self):
        self.runner.output.joinpath('emulated-gps-provider.json').write_text(json.dumps({
            'emulatorOnly': True,
            'physicalGpsTested': False,
            'source': 'Android API 35 OS test providers',
            'controlledProviders': list(PROVIDERS),
            'syntheticLatitude': 31.5,
            'syntheticLongitude': 34.47,
            'syntheticAccuracyMeters': 8,
            'explicitInjections': self.injections,
        }, indent=2) + '\n')

    def install(self):
        self.guard()
        # MapSmoke has already installed the root-only guest firewall. Keep it
        # in place while restoring normal ADB shell identity for mock AppOps.
        uid = self.runner.command('shell', 'id', '-u')
        if uid == '0':
            self.runner.command('unroot')
            self.runner.command('wait-for-device')
            self.guard()
            uid = self.runner.command('shell', 'id', '-u')
        if uid != '2000':
            raise RuntimeError('Controlled emulator GPS requires the Android shell UID')
        self.runner.command('shell', 'appops', 'set', '2000', 'android:mock_location', 'allow')
        self.runner.command('shell', 'cmd', 'location', 'set-location-enabled', 'true')
        for provider in PROVIDERS:
            self.runner.command('shell', 'cmd', 'location', 'providers', 'add-test-provider', provider)
            # Disabling clears ordinary last-known caches before pending tests.
            self.runner.command('shell', 'cmd', 'location', 'providers', 'set-test-provider-enabled', provider, 'false')
            self.runner.command('shell', 'cmd', 'location', 'providers', 'set-test-provider-enabled', provider, 'true')
        dump = self.runner.command('shell', 'dumpsys', 'location')
        try:
            for provider in PROVIDERS:
                require_empty_provider(dump, provider)
        except RuntimeError:
            for provider in PROVIDERS:
                try:
                    state = self.runner.command('shell', 'dumpsys', 'location', provider)
                except RuntimeError:
                    state = dump
                self.runner.output.joinpath('emulated-' + provider + '-provider-failure.txt').write_text(state + '\n')
                print('EMULATED_GPS_PROVIDER_FAILURE ' + json.dumps({
                    'provider': provider, 'state': state[-8000:],
                }), flush=True)
            raise
        self.installed = True
        self.record()

    def inject_fix(self):
        if not self.installed:
            raise RuntimeError('Install controlled emulator GPS before injecting a synthetic fix')
        self.guard()
        # The AOSP parser supplies current wallclock and monotonic timestamps.
        # No initial location or emulator-console GNSS fix is ever emitted.
        self.runner.command('shell', 'cmd', 'location', 'providers', 'set-test-provider-location',
                            'gps', '--location', SYNTHETIC_LOCATION, '--accuracy', SYNTHETIC_ACCURACY_METERS)
        self.injections += 1
        self.record()
