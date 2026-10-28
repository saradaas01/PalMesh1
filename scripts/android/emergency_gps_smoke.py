#!/usr/bin/env python3
"""Replay foreground GPS on a pinned synthetic x86 APK in a fresh offline guest."""
import json
import time

import smoke
from emergency_smoke import BaseSmoke, EmergencySmoke


APK_SOURCE = '68afa7bb3e5ae9a5362e4e6125b086e58de44ff0'
APK_SHA256 = 'edd60d53fb59844764bc2170248f24c73b6f0bd41d67a58d2ff304a37722292b'


class EmergencyGpsSmoke(EmergencySmoke):
    def progress(self, stage, **results):
        if not hasattr(self, 'gps_report'):
            self.gps_report = {
                'passed': False,
                'scope': 'Foreground GPS and stored local fix only',
                'apkSourceCommit': APK_SOURCE,
                'apkSha256': APK_SHA256,
                'physicalGpsTested': False,
                'freshEmulatorExternalNetworkBlocked': True,
            }
        self.gps_report.update(stage=stage, **results)
        self.output.joinpath('emergency-gps-replay.json').write_text(
            json.dumps(self.gps_report, indent=2) + '\n')

    def inject_fix(self):
        for _ in range(3):
            self.command('emu', 'geo', 'fix', '34.47', '31.5')
            time.sleep(1)

    def launch(self, name):
        self.progress(name + '-launch')
        # Avoid unrelated alert-permission errors from the fixture's three SOSes.
        if name == 'first':
            self.command('shell', 'pm', 'grant', smoke.PACKAGE,
                         'android.permission.POST_NOTIFICATIONS')
        xml = BaseSmoke.launch(self, name)
        self.finish_guide(name)
        self.wait_ui(lambda x: smoke.has_text(x, 'SIMULATED EMERGENCY ACCEPTANCE'),
                     'explicit synthetic-only banner', name + '-synthetic-banner.xml')
        if name == 'first':
            self.open_inbox()
            for _ in range(3):
                self.press('Mark reviewed')
            self.tap('Map')
            self.wait_ui(lambda x: smoke.has_text(x, 'Offline map ready'),
                         'offline map before GPS', 'gps-map-ready.xml')
            self.top()
            self.progress('permission-denial')
            self.press('My location')
            self.wait_ui(lambda x: smoke.has_text(x, 'Location access is needed. Tap Allow location access, or use device settings.'), 'explicit missing-access guidance', 'gps-access-needed.xml')
            self.press('Allow location access')
            permission = self.wait_ui(
                lambda x: any(n.get('resource-id', '').endswith('permission_deny_button')
                              for n in smoke.nodes(x)),
                'on-demand location permission', 'gps-permission.xml')
            denial = next(n for n in smoke.nodes(permission)
                          if n.get('resource-id', '').endswith('permission_deny_button'))
            x, y = smoke.center(denial)
            self.command('shell', 'input', 'tap', str(x), str(y))
            self.wait_ui(lambda x: smoke.has_text(x, 'Location access is needed. Tap Allow location access, or use device settings.'),
                         'location permission denial', 'gps-denied.xml')
            self.press('Dismiss map error')
            self.progress('disabled-provider', permissionDenialHandled=True)
            for permission_name in ('ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION'):
                self.command('shell', 'pm', 'grant', smoke.PACKAGE,
                             'android.permission.' + permission_name)
            self.command('shell', 'cmd', 'location', 'set-location-enabled', 'false')
            self.press('My location')
            self.wait_ui(lambda x: smoke.has_text(x, 'Device location is off. Turn on Location in Android settings, then try again. Your last fix is kept.'),
                         'disabled device location', 'gps-disabled.xml')
            self.press('Dismiss map error')
            self.progress('pending-gps-and-sos', disabledGpsHandled=True)
            self.command('shell', 'cmd', 'location', 'set-location-enabled', 'true')
            self.top()
            self.press('My location')
            self.wait_ui(lambda x: smoke.find_control(x, 'Cancel GPS request') is not None,
                         'GPS before background cancellation', 'gps-before-background.xml')
            self.command('shell', 'input', 'keyevent', 'KEYCODE_HOME')
            self.command('shell', 'am', 'start', '-W', '-n', smoke.PACKAGE + '/org.palmesh.MainActivity')
            self.wait_ui(lambda x: smoke.find_control(x, 'My location') is not None
                         and smoke.find_control(x, 'Cancel GPS request') is None,
                         'GPS stopped after backgrounding', 'gps-background-cancelled.xml')
            self.progress('manual-cancel', backgroundCancellation=True)
            self.top()
            self.press('My location')
            self.wait_ui(lambda x: smoke.find_control(x, 'Cancel GPS request') is not None,
                         'pending cancellable GPS request', 'gps-waiting.xml')
            self.tap(smoke.SOS)
            self.wait_ui(lambda x: smoke.has_text(x, smoke.QUEUED),
                         'SOS queued during GPS acquisition', 'gps-waiting-sos.xml')
            self.tap('Dismiss SOS notice')
            self.press('Cancel GPS request')
            self.wait_ui(lambda x: smoke.find_control(x, 'My location') is not None,
                         'cancelled GPS request', 'gps-cancelled.xml')
            self.progress('native-fix', sosQueuedWhileWaitingForGps=True, cancelledGps=True)
            self.top()
            self.press('My location')
            self.inject_fix()
            self.wait_ui(lambda x: any(n.get('text', '').startswith('Reported accuracy:')
                                      for n in smoke.nodes(x))
                         and smoke.find_control(x, 'My location') is not None,
                         'injected native GPS fix and quality', 'gps-fixed.xml')
            self.top()
            self.map_image('gps-blue-local-map', blue=True)
            self.progress('explicit-share', nativeGpsInjected=True, blueLocalMarkerPixels=True)
            self.press('Location & sharing')
            self.press('Share location once')
            # Sharing may request a fresh fix after screenshots and scrolling.
            self.inject_fix()
            self.wait_ui(lambda x: smoke.has_text(x, 'Location report queued locally. Delivery is not confirmed.'),
                         'explicit one-time location share', 'gps-shared-once.xml')
            self.press('Dismiss map notice')
            self.progress('awaiting-cold-restart', explicitShareQueued=True)
        else:
            self.tap('Map')
            self.top()
            self.wait_ui(lambda x: any(n.get('text', '').startswith('Reported accuracy:')
                                      for n in smoke.nodes(x)),
                         'GPS quality after cold restart', 'gps-retained-quality.xml')
            self.press('Coordinates (optional)')
            self.wait_ui(lambda x: smoke.has_text(x, 'Latitude 31.50000, longitude 34.47000'),
                         'persisted original local GPS coordinates', 'gps-retained-coordinates.xml')
            self.capture('gps-retained-local-fix')
            self.progress('complete', passed=True, localFixAndQualityPersisted=True)
            print('EMERGENCY_GPS_REPLAY foreground denial/disabled/cancel, nonblocking SOS, '
                  'injected native fix/blue pixels, explicit share and retained local fix passed',
                  flush=True)
        return xml


if __name__ == '__main__':
    smoke.Smoke = EmergencyGpsSmoke
    smoke.main()
