#!/usr/bin/env python3
"""Disposable offline Android: signed simulated SOS archive, map pixels, real OS GPS provider injection."""
import json,re,time
import smoke
from map_smoke import MapSmoke,map_pixels
from ux_smoke import UxSmoke
BaseSmoke=smoke.Smoke
def scroll_surface(xml):
 surfaces=[]
 for node in smoke.nodes(xml):
  match=smoke.BOUNDS.fullmatch(node.get('bounds',''))
  if node.get('scrollable')=='true' and match:
   left,top,right,bottom=map(int,match.groups())
   if right>left and bottom>top:surfaces.append((left,top,right,bottom))
 if not surfaces:raise RuntimeError('No visible scrollable surface')
 return max(surfaces,key=lambda b:(b[2]-b[0])*(b[3]-b[1]))

class EmergencySmoke(MapSmoke):
 capture=UxSmoke.capture
 def press(self,label):
  for _ in range(18):
   xml=self.dump();node=smoke.find_control(xml,label)
   if node is not None:
    try:
     x,y=smoke.center(node)
     if 100<y<1080:self.command('shell','input','tap',str(x),str(y));return
    except RuntimeError:pass
   left,top,right,bottom=scroll_surface(xml);x=right-6
   self.command('shell','input','swipe',str(x),str(bottom-45),str(x),str(top+(bottom-top)//3),'200')
  raise RuntimeError('Emergency control missing: '+label)
 def top(self):
  left,top,right,bottom=scroll_surface(self.dump());x=right-6
  for _ in range(5):self.command('shell','input','swipe',str(x),str(top+(bottom-top)//4),str(x),str(bottom-30),'100')
 def map_image(self,name,red=False,blue=False):
  from PIL import Image
  self.capture(name);xml=self.last_xml
  frame=next(n for n in smoke.nodes(xml) if n.get('content-desc')=='Offline map of bundled coverage')
  area=tuple(map(int,smoke.BOUNDS.fullmatch(frame.get('bounds')).groups()))
  with Image.open(self.output/(name+'.png')) as image:
   pixels=map_pixels(image,area);crop=image.convert('RGB').crop(area)
   colors=crop.getcolors(crop.width*crop.height) or []
   red_count=sum(c for c,(r,g,b) in colors if r>150 and g<100 and b<140)
   blue_count=sum(c for c,(r,g,b) in colors if b>140 and r<80 and g<150)
   if red and red_count<30:raise RuntimeError('SOS red marker pixels absent')
   if blue and blue_count<30:raise RuntimeError('My-location blue marker pixels absent')
   if red:self.red_pixel=next((area[0]+x,area[1]+y) for y in range(crop.height) for x in range(crop.width) if (lambda c:c[0]>150 and c[1]<100 and c[2]<140)(crop.getpixel((x,y))))
   self.output.joinpath(name+'-pixels.json').write_text(json.dumps(dict(**pixels,redMarkerPixels=red_count,blueMarkerPixels=blue_count)))
   print('EMERGENCY_MAP_PIXELS '+json.dumps(dict(**pixels,redMarkerPixels=red_count,blueMarkerPixels=blue_count)),flush=True)
 def diagnostics(self):
  try:
   self.capture('emergency-final');print('EMERGENCY_LAST_UI '+json.dumps([dict(text=n.get('text','')[:200],label=n.get('content-desc',''),bounds=n.get('bounds','')) for n in smoke.nodes(self.last_xml) if n.get('text') or n.get('content-desc')][:80]),flush=True)
   print('EMERGENCY_GPS_LOG '+self.command('logcat','-d','-v','brief','PalMeshGps:I','AndroidRuntime:E','ReactNativeJS:E','*:S')[-8000:],flush=True)
  finally:super().diagnostics()
 def launch(self,name):
  if name=='first':self.command('shell','pm','grant',smoke.PACKAGE,'android.permission.POST_NOTIFICATIONS')
  xml=BaseSmoke.launch(self,name)
  self.wait_ui(lambda x:smoke.has_text(x,'SIMULATED EMERGENCY ACCEPTANCE'),'explicit synthetic-only banner','synthetic-banner.xml')
  if name=='first':
   # Exercise the actual PendingIntent after process death, not a hand-built ACTION_VIEW.
   self.command('shell','input','keyevent','KEYCODE_HOME');self.command('shell','am','kill',smoke.PACKAGE)
   for _ in range(5):
    if not self.command('shell','pidof',smoke.PACKAGE,check=False):break
    time.sleep(1);self.command('shell','am','kill',smoke.PACKAGE)
   else:raise RuntimeError('Application process was not killed before notification acceptance')
   self.command('shell','cmd','statusbar','expand-notifications')
   tray=self.wait_ui(lambda x:smoke.has_text(x,'Emergency SOS received'),'native emergency notification','notification-tray.xml')
   title=next(n for n in smoke.nodes(tray) if n.get('text')=='Emergency SOS received');x,y=smoke.center(title);self.command('shell','input','tap',str(x),str(y))
   self.wait_ui(lambda x:smoke.has_text(x,'SOS inbox'),'actual cold notification inbox route','cold-notification-inbox.xml')
   # Review reports explicitly so the global urgent banner does not obscure the viewport.
   for _ in range(3):self.press('Mark reviewed')
   self.top();self.wait_ui(lambda x:smoke.has_text(x,'Location unavailable'),'SOS without coordinates','sos-no-location.xml');self.capture('inbox-no-location')
   self.tap('Map');self.wait_ui(lambda x:smoke.has_text(x,'Offline map ready'),'offline marker overview','marker-overview-ready.xml');self.top();self.map_image('marker-overview',red=True)
   records=self.evidence()
   if not records:raise RuntimeError('Native camera evidence absent before marker tap')
   initial_zoom=records[-1]['zoom'];x,y=self.red_pixel;self.command('shell','input','tap',str(x),str(y))
   end=time.monotonic()+20
   while time.monotonic()<end:
    if any(r.get('zoom',0)>initial_zoom+0.5 for r in self.evidence()):break
    time.sleep(1)
   else:raise RuntimeError('Actual SOS marker tap did not focus native camera')
   print('EMERGENCY_MARKER_TAP native zoom increased from '+str(initial_zoom),flush=True)
   self.map_image('marker-tap-focused',red=True)
   self.open_inbox();self.top()
   # Oldest report is lower in the original-ID inbox; scroll to its View action.
   self.press('View on map')
   self.wait_ui(lambda x:smoke.has_text(x,'Offline map ready'),'local offline renderer','map-ready.xml')
   self.top();self.map_image('red-sos-map',red=True)
   # Native notification deep-link opens the inbox; it cannot supply coordinates or a trusted identity.
   self.command('shell','am','start','-W','-n',smoke.PACKAGE+'/org.palmesh.MainActivity','-a','android.intent.action.VIEW','-d','palmesh://emergencies')
   self.wait_ui(lambda x:smoke.has_text(x,'SOS inbox'),'notification inbox route','notification-inbox.xml')
   self.tap('Map');self.top()
   self.press('My location')
   permission=self.wait_ui(lambda x:any(n.get('resource-id','').endswith('permission_deny_button') for n in smoke.nodes(x)),'on-demand location permission','gps-permission.xml')
   denial=next(n for n in smoke.nodes(permission) if n.get('resource-id','').endswith('permission_deny_button'));x,y=smoke.center(denial);self.command('shell','input','tap',str(x),str(y))
   self.wait_ui(lambda x:smoke.has_text(x,'Location access was denied. Allow it in device settings to update GPS.'),'location permission denial','gps-denied.xml');self.press('Dismiss map error')
   self.command('shell','pm','grant',smoke.PACKAGE,'android.permission.ACCESS_COARSE_LOCATION');self.command('shell','pm','grant',smoke.PACKAGE,'android.permission.ACCESS_FINE_LOCATION')
   self.command('shell','cmd','location','set-location-enabled','false')
   self.press('My location');self.wait_ui(lambda x:smoke.has_text(x,'Device location is off. Turn on Location in Android settings, then try again. Your last fix is kept.'),'device-location disabled error','gps-disabled.xml');self.press('Dismiss map error')
   self.command('shell','cmd','location','set-location-enabled','true');self.top();self.press('My location')
   self.wait_ui(lambda x:smoke.find_control(x,'Cancel GPS request') is not None,'bounded cancellable GPS','gps-waiting.xml')
   # SOS must queue while the real native request is still waiting for a fix.
   self.tap(smoke.SOS);self.wait_ui(lambda x:smoke.has_text(x,smoke.QUEUED),'SOS independent of GPS','gps-waiting-sos.xml');self.tap('Dismiss SOS notice');self.press('Cancel GPS request')
   self.wait_ui(lambda x:smoke.find_control(x,'My location') is not None,'cancelled GPS','gps-cancelled.xml')
   self.top();self.press('My location')
   for _ in range(3):self.command('emu','geo','fix','34.47','31.5');time.sleep(1)
   self.wait_ui(lambda x:any(n.get('text','').startswith('Reported accuracy:') for n in smoke.nodes(x)) and smoke.find_control(x,'My location') is not None,'native offline GPS fix','gps-fixed.xml')
   self.top();self.map_image('blue-local-map',blue=True)
   self.press('Location & sharing');self.press('Share location once')
   for _ in range(3):self.command('emu','geo','fix','34.47','31.5');time.sleep(1)
   self.wait_ui(lambda x:smoke.has_text(x,'Location report queued locally. Delivery is not confirmed.'),'explicit one-time share','shared-once.xml');self.press('Dismiss map notice')
  else:
   self.tap('Map');self.top();self.wait_ui(lambda x:any(n.get('text','').startswith('Reported accuracy:') for n in smoke.nodes(x)),'GPS quality after restart','retained-gps.xml')
   self.press('Coordinates (optional)');self.wait_ui(lambda x:smoke.has_text(x,'Latitude 31.50000, longitude 34.47000'),'original persisted GPS coordinates','retained-gps-coordinates.xml')
   self.open_inbox();self.top();self.wait_ui(lambda x:smoke.has_text(x,'Location unavailable'),'retained no-location SOS','retained-missing-location.xml');self.press('View on map')
   self.wait_ui(lambda x:smoke.has_text(x,'SIMULATED SOS new location') or smoke.has_text(x,'SIMULATED SOS old location'),'original SOS focused after restart','retained-sos-focus.xml');self.top();self.map_image('restart-sos-map',red=True)
   self.output.joinpath('emergency-acceptance.json').write_text(json.dumps(dict(passed=True,syntheticSignedSos=True,physicalGpsTested=False,externalNetworkBlocked=True,nativeGpsInjected=True,actualNotificationTapAfterProcessDeath=True,actualMarkerTapFocusedCamera=True,permissionDenialHandled=True,disabledGpsHandled=True,cancelledGps=True,sosQueuedWhileWaitingForGps=True,redAndBlueMarkerPixels=True,originalSosAndNoLocationPersisted=True),indent=2))
   print('EMERGENCY_ACCEPTANCE offline signed SOS, original-ID focus/red pixels, no-location/restart, native GPS/disabled/cancel/blue pixels and nonblocking SOS passed',flush=True)
  return xml
if __name__=='__main__':smoke.Smoke=EmergencySmoke;smoke.main()
