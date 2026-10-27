#!/usr/bin/env python3
"""Exercise the shipped non-instrumented map, offline; retain OS CPU/frame evidence."""
import json
import time
from pathlib import Path
import smoke
from map_smoke import MapSmoke

BaseSmoke = smoke.Smoke

class PerformanceSmoke(MapSmoke):
    def launch(self, name):
        xml = BaseSmoke.launch(self, name)
        self.tap('Map')
        self.wait_ui(lambda value: smoke.has_text(value, 'Offline map ready'), 'local map readiness', name+'-map-ready.xml')
        time.sleep(2)
        self.evidence()
        initial_log = self.output.joinpath('map-network.txt').read_text()
        if 'render_evidence ' in initial_log:
            raise RuntimeError('Acceptance diagnostics were accidentally enabled in the shipped APK')
        polls = initial_log.count('readiness_poll')
        if not 1 <= polls <= 12: raise RuntimeError('Invalid bounded native readiness budget')
        self.command('shell', 'dumpsys', 'gfxinfo', smoke.PACKAGE, 'reset')
        first = self.screenshot(name+'-map-rendered')
        latencies = []
        for i in range(6):
            started = time.monotonic()
            self.tap('Zoom in' if i % 2 == 0 else 'Zoom out')
            current = self.dump(name+'-interaction-'+str(i)+'.xml')
            if not smoke.has_text(current, 'Offline map ready'): raise RuntimeError('Map lost readiness during gestures')
            latencies.append(time.monotonic()-started)
        # Force a map-visible zoom and vertical drag, not a parent-list scroll.
        self.tap('Zoom in')
        time.sleep(1)
        zoomed = self.screenshot(name+'-map-zoomed')
        frame = next(node for node in smoke.nodes(self.last_xml) if node.get('content-desc') == 'Offline map of bundled coverage')
        l,t,r,b = map(int, smoke.BOUNDS.fullmatch(frame.get('bounds','')).groups())
        self.command('shell','input','swipe',str((l+r)//2),str((t+b)//2+70),str((l+r)//2),str((t+b)//2-70),'500')
        time.sleep(2)
        final = self.screenshot(name+'-map-pan-zoom')
        if zoomed['mapPixelsSha256'] == final['mapPixelsSha256']: raise RuntimeError('No rendered detail changed after map interaction')
        self.evidence()
        final_log = self.output.joinpath('map-network.txt').read_text()
        if final_log.count('readiness_poll') != polls or 'render_evidence ' in final_log:
            raise RuntimeError('Post-readiness diagnostic/query work ran during ordinary map interaction')
        self.output.joinpath(name+'-gfxinfo.txt').write_text(self.command('shell','dumpsys','gfxinfo',smoke.PACKAGE))
        self.output.joinpath(name+'-cpuinfo.txt').write_text(self.command('shell','dumpsys','cpuinfo'))
        pid = self.command('shell','pidof',smoke.PACKAGE).split()[0]
        self.output.joinpath(name+'-threads.txt').write_text(self.command('shell','top','-H','-b','-n','1','-p',pid))
        layers = self.command('shell','dumpsys','SurfaceFlinger','--list')
        layer = next((line for line in layers.splitlines() if smoke.PACKAGE in line and 'SurfaceView' in line), None)
        if layer:
            self.output.joinpath(name+'-surface-latency.txt').write_text(self.command('shell','dumpsys','SurfaceFlinger','--latency',layer,check=False))
        if max(latencies) > 15: raise RuntimeError('UI interaction exceeded bounded automation responsiveness budget')
        report = dict(passed=True, apkMode='ordinary-debug-no-map-diagnostics', readinessPolls=polls,
                      postReadyPolls=0, diagnosticFeatureRecords=0, uiInteractionSeconds=latencies,
                      includesAdbAutomationOverhead=True, physicalDeviceTested=False,
                      cpuFrameEvidence='OS gfxinfo/cpuinfo and available SurfaceFlinger timestamps; not physical-phone FPS', before=first, after=final)
        self.output.joinpath(name+'-performance.json').write_text(json.dumps(report,indent=2)+'\n')
        print('MAP_PERFORMANCE '+json.dumps(report),flush=True)
        return xml

if __name__ == '__main__':
    smoke.Smoke = PerformanceSmoke
    smoke.main()
