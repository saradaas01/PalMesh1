#!/usr/bin/env python3
"""Actual camera frames, explicit contact preview, RTL/small-screen UX and persistence."""
import json,os,time,subprocess,base64,io
from pathlib import Path
import smoke
from map_smoke import MapSmoke
from contacts_smoke import public_qr_item
BaseSmoke=smoke.Smoke
class UxSmoke(MapSmoke):
 skip_onboarding=False
 def diagnostics(self):
  try:
   self.capture('final-diagnostic')
   print('UX_LAST_UI '+json.dumps([dict(text=n.get('text','')[:200],label=n.get('content-desc','')[:200],bounds=n.get('bounds','')) for n in smoke.nodes(self.last_xml) if n.get('text') or n.get('content-desc')][:70],ensure_ascii=False),flush=True)
   print('UX_CAMERA_LOG '+self.command('logcat','-d','-v','brief','PalMeshQrCamera:I','CameraBase:W','AndroidRuntime:E','ReactNativeJS:E','*:S')[-12000:],flush=True)
  finally:super().diagnostics()
 def isolate(self):
  super().isolate();self.command('shell','settings','put','secure','show_ime_with_hard_keyboard','1')
 def press(self,label):
  for _ in range(12):
   xml=self.dump();node=smoke.find_control(xml,label)
   if node is not None:
    try:
     x,y=smoke.center(node)
     if 80<y<1080:self.command('shell','input','tap',str(x),str(y));return
    except RuntimeError:pass
   self.command('shell','input','swipe','350','900','350','400','250')
  raise RuntimeError('Visible UX control missing: '+label)
 def fill(self,label,value):
  self.press(label);self.command('shell','input','keyevent','KEYCODE_MOVE_END');self.command('shell','input','keycombination','113','29',check=False);self.command('shell','input','text',value.replace(' ','%s'));self.command('shell','input','keyevent','KEYCODE_BACK')
 def capture(self,name):
  self.dump(name+'.xml');data=subprocess.check_output([str(self.adb),'-s',self.serial,'exec-out','screencap','-p'],timeout=30);self.output.joinpath(name+'.png').write_bytes(data)
  from PIL import Image
  image=Image.open(io.BytesIO(data)).convert('RGB');image.thumbnail((540,960));stream=io.BytesIO();image.save(stream,format='JPEG',quality=60);encoded=base64.b64encode(stream.getvalue()).decode()
  for i in range(0,min(len(encoded),120000),4000):print('UX_IMAGE_CHUNK '+name+' '+encoded[i:i+4000],flush=True)
 def permission(self,allow):
  suffix='permission_allow_foreground_only_button' if allow else 'permission_deny_button'
  xml=self.wait_ui(lambda x:any(n.get('resource-id','').endswith(suffix) for n in smoke.nodes(x)),'on-demand camera permission','camera-permission.xml')
  node=next(n for n in smoke.nodes(xml) if n.get('resource-id','').endswith(suffix));x,y=smoke.center(node);self.command('shell','input','tap',str(x),str(y))
 def launch(self,name):
  xml=BaseSmoke.launch(self,name)
  if name=='first':
   if smoke.find_control(xml,'Skip for now') is None:raise RuntimeError('First launch did not offer skippable onboarding')
   self.capture('welcome');self.tap('Next');self.fill('Display name (optional)','Sara UX');self.tap('Next');self.tap('Get started')
   self.tap('Contacts');self.tap('Add contact');self.tap('Scan QR code');self.permission(False)
   self.wait_ui(lambda x:smoke.has_text(x,'Camera access is off. Allow it in Android/iOS settings, or import a QR image.'),'honest camera denial','camera-denied.xml')
   self.tap('Scan QR code');self.permission(True)
   budget=self.ui_timeout;self.ui_timeout=60
   try:self.wait_ui(lambda x:smoke.has_text(x,'Add this contact?'),'decoded live-camera public QR preview','camera-public-preview.xml')
   finally:self.ui_timeout=budget
   fixture=Path(os.environ['PALMESH_CONTACT_FIXTURE']);expected=json.loads((fixture/'public-identity.json').read_text())['id']
   self.tap('Show fingerprint');self.wait_ui(lambda x:smoke.has_text(x,expected),'derived camera QR fingerprint','camera-fingerprint.xml')
   self.fill('Contact name','Camera Friend');self.press('Save')
   self.wait_ui(lambda x:smoke.has_text(x,'Camera Friend'),'explicitly saved camera contact','contact-saved.xml')
   self.capture('contacts');self.tap('Message Camera Friend')
   self.wait_ui(lambda x:smoke.has_text(x,'Camera Friend'),'private header using saved name','named-thread.xml')
   self.tap('Message');self.capture('keyboard-composer');self.command('shell','input','text','PalMesh-UX-private-Hello');self.command('shell','input','keyevent','KEYCODE_BACK');self.tap('Send message')
   self.wait_ui(lambda x:smoke.has_text(x,smoke.CHAT_QUEUED),'private offline queue','private-queued.xml');self.tap('Dismiss notice');self.capture('private-thread');self.command('shell','input','keyevent','KEYCODE_BACK')
   logs=self.command('logcat','-d','-v','brief','PalMeshQrCamera:I','*:S');self.output.joinpath('native-camera.txt').write_text(logs)
   if 'preview_started' not in logs or 'decoded_qr' not in logs:raise RuntimeError('Camera preview/decode pipeline not confirmed')
   self.tap('Map');self.wait_ui(lambda x:smoke.has_text(x,'Offline map ready'),'preserved offline map','offline-map.xml');self.capture('map')
  else:
   if smoke.find_control(xml,'Skip for now') is not None:raise RuntimeError('Onboarding preference was lost')
   self.tap('Contacts');self.tap('Message Camera Friend');self.wait_ui(lambda x:smoke.has_text(x,'PalMesh-UX-private-Hello'),'private message after restart','retained-private.xml');self.command('shell','input','keyevent','KEYCODE_BACK')
   self.tap('More');self.tap('My profile');self.wait_ui(lambda x:smoke.has_text(x,'Sara UX'),'profile after restart','retained-profile.xml');self.capture('profile')
   self.tap('More');self.tap('Settings');self.tap('العربية');self.capture('arabic-settings');self.tap('الرسائل');self.capture('arabic-messages')
   self.command('shell','wm','size','480x800');self.command('shell','settings','put','system','font_scale','1.3');self.capture('arabic-small-screen');self.command('shell','wm','size','reset');self.command('shell','settings','put','system','font_scale','1.0')
   self.wait_ui(lambda x:smoke.find_control(x,'المزيد') is not None,'Arabic navigation after display/font recreation','layout-restored.xml')
   self.tap('المزيد');self.tap('الإعدادات');self.tap('English')
   self.output.joinpath('ux-acceptance.json').write_text(json.dumps(dict(passed=True,actualCameraFrames=True,syntheticCameraImage=True,physicalCameraTested=False,permissionDeniedHandled=True,explicitQrSave=True,privateMessagePersisted=True,onboardingPersisted=True,profilePersisted=True,rtlAndSmallScreenExercised=True),indent=2)+'\n')
   print('UX_ACCEPTANCE camera QR, permission denial, private queue/restart, onboarding, Arabic and small-screen passed',flush=True)
  return xml
if __name__=='__main__':smoke.Smoke=UxSmoke;smoke.main()
