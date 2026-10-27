#!/usr/bin/env python3
"""Scoped offline image QR import, local aliases and encrypted queue persistence."""
import json
import os
import time
from pathlib import Path
import smoke
from map_smoke import MapSmoke
BaseSmoke=smoke.Smoke
NAME='PalMesh Friend'
RENAMED='PalMesh Trusted Friend'
PROFILE='PalMesh Owner'
PRIVATE='PalMesh-private-offline-Hello'

class ContactsSmoke(MapSmoke):
    def visible_control(self,xml,label):
        control=smoke.find_control(xml,label)
        if control is None:return None
        try:
            x,y=smoke.center(control)
            if 20 <= x <= 700 and 200 <= y <= 1070:return control
        except RuntimeError:pass
        return None
    def reveal(self,label):
        for _ in range(16):
            xml=self.dump()
            if self.visible_control(xml,label) is not None:return
            self.command('shell','input','swipe','350','900','350','430','300')
        raise RuntimeError('Contact control unavailable: '+label)
    def press(self,label):
        self.reveal(label)
        control=self.visible_control(self.dump(),label)
        if control is None:raise RuntimeError('Contact control moved before tap: '+label)
        x,y=smoke.center(control)
        self.command('shell','input','tap',str(x),str(y))
    def fill(self,label,text):
        self.press(label)
        self.command('shell','input','keyevent','KEYCODE_MOVE_END')
        self.command('shell','input','keyevent','--longpress','KEYCODE_DEL')
        # Select all through the bounded Android key chord rather than typing IDs.
        self.command('shell','input','keycombination','113','29',check=False)
        self.command('shell','input','text',text.replace(' ','%s'))
        self.command('shell','input','keyevent','KEYCODE_BACK')
    def top(self):
        for _ in range(12):self.command('shell','input','swipe','350','400','350','830','120')
    def first_contacts(self):
        self.tap(smoke.CONTACTS)
        self.fill('Optional display name (on this device)',PROFILE)
        self.press('Save display name')
        self.wait_ui(lambda x:smoke.has_text(x,'Saved on this device.'),'saved local profile','profile-saved.xml')
        print('CONTACT_CHECKPOINT profile-saved',flush=True)
        self.press('Show public identity QR');self.dump('public-qr.xml')
        self.command('shell','screencap','-p','/sdcard/public-qr-test.png')
        self.press('Hide public identity QR')
        fixture=Path(os.environ['PALMESH_CONTACT_FIXTURE'])
        image='/sdcard/Pictures/PalMeshPublicContact.gif'
        self.command('shell','mkdir','-p','/sdcard/Pictures')
        self.command('push',str(fixture/'PalMeshPublicContact.gif'),image)
        # A raw adb push is not a MediaStore/Downloads entry. Register the local
        # fixture before opening the scoped picker; no app permission is added.
        self.command('shell','am','broadcast','-a','android.intent.action.MEDIA_SCANNER_SCAN_FILE','-d','file://'+image)
        for _ in range(12):
            indexed=self.command('shell','content','query','--uri','content://media/external/images/media','--projection','_id:_display_name',check=False)
            if 'PalMeshPublicContact.gif' in indexed:break
            time.sleep(1)
        else:raise RuntimeError('Synthetic QR image was not indexed by Android MediaStore')
        print('CONTACT_CHECKPOINT local-image-indexed',flush=True)
        self.press('Scan QR from a local image')
        visited=set()
        for attempt in range(16):
            xml=self.dump('image-picker.xml')
            rows=[dict(text=n.get('text','')[:160],label=n.get('content-desc','')[:160],bounds=n.get('bounds',''),resource=n.get('resource-id','')) for n in smoke.nodes(xml) if n.get('text') or n.get('content-desc')]
            print('CONTACT_PICKER '+json.dumps(rows[:60],ensure_ascii=False),flush=True)
            item=next((n for n in smoke.nodes(xml) if n.get('text','').startswith('PalMeshPublicContact')),None)
            if item is not None:
                x,y=smoke.center(item);self.command('shell','input','tap',str(x),str(y));break
            # Recent and Images expose MediaStore content. Do not repeatedly tap
            # the toolbar title when a root is already open.
            choices=('Recent','Images','Pictures','Downloads','Internal storage')
            root=next((n for choice in choices if choice not in visited for n in smoke.nodes(xml) if n.get('text')==choice),None)
            drawer=smoke.find_control(xml,'Show roots')
            drawer_open=any('roots_list' in n.get('resource-id','') for n in smoke.nodes(xml))
            if drawer_open and root is not None:
                label=root.get('text');visited.add(label)
                x,y=smoke.center(root);self.command('shell','input','tap',str(x),str(y))
            elif drawer is not None:self.tap('Show roots')
            else:time.sleep(1)
        else:raise RuntimeError('Public-only QR fixture absent in scoped image picker')
        print('CONTACT_CHECKPOINT image-selected',flush=True)
        self.wait_ui(lambda x:smoke.has_text(x,'Public identity to save — not verified'),'validated public QR preview','qr-preview.xml')
        print('CONTACT_CHECKPOINT public-payload-previewed',flush=True)
        self.fill('Local contact nickname',NAME);self.press('Save contact identity')
        self.reveal('Start private conversation')
        xml=self.dump('contact-saved.xml')
        if not smoke.has_text(xml,'Public keys saved — fingerprint not compared'):raise RuntimeError('QR import incorrectly claimed verification')
        expected=json.loads((fixture/'public-identity.json').read_text())['id']
        short=expected[:12]+'…'+expected[-8:]
        self.fill('Local contact nickname: '+short,RENAMED)
        self.press('Save nickname');self.press('Start private conversation')
        self.wait_ui(lambda x:smoke.has_text(x,RENAMED),'private thread showing saved nickname','private-thread.xml')
        self.tap('Message');self.command('shell','input','text',PRIVATE);self.command('shell','input','keyevent','KEYCODE_BACK');self.tap('Send message')
        self.wait_ui(lambda x:smoke.has_text(x,smoke.CHAT_QUEUED),'durable encrypted local queue','private-queued.xml')
        print('CONTACT_CHECKPOINT private-message-queued',flush=True)
        self.tap('Dismiss notice');self.dump('private-history.xml')
        self.command('shell','input','keyevent','KEYCODE_BACK')
    def launch(self,name):
        xml=BaseSmoke.launch(self,name)
        if name=='first':self.first_contacts()
        else:
            self.tap(smoke.CONTACTS);self.top()
            self.reveal('Optional display name (on this device)')
            xml=self.dump('retained-profile.xml')
            if not smoke.has_text(xml,PROFILE):raise RuntimeError('Profile did not survive restart')
            self.press('Start private conversation')
            self.wait_ui(lambda x:smoke.has_text(x,RENAMED) and smoke.has_text(x,PRIVATE),'retained private nickname and encrypted message','retained-private.xml')
            self.command('shell','input','keyevent','KEYCODE_BACK')
            self.output.joinpath('contact-acceptance.json').write_text(json.dumps(dict(passed=True,localQrImageDecoded=True,explicitImport=True,automaticVerification=False,profilePersisted=True,nicknamePersisted=True,privateMessagePersisted=True,physicalDeviceTested=False,multiDeviceTested=False),indent=2)+'\n')
            print('CONTACT_ACCEPTANCE: scoped QR image, names, private offline queue and restart passed',flush=True)
        self.tap(smoke.CONTACTS);self.top()
        return xml
if __name__=='__main__':
    smoke.Smoke=ContactsSmoke
    smoke.main()
