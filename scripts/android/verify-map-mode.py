#!/usr/bin/env python3
"""Verify the sealed APK's map diagnostics metadata, not a build-time assumption."""
import argparse
import os
from pathlib import Path
import re
import subprocess

def diagnostics_flag(tree: str) -> bool:
    for block in tree.split('E: meta-data'):
        if '"com.palmesh.MAP_DIAGNOSTICS"' not in block: continue
        match = re.search(r'android:value[^\n]*?=(?:\(type 0x12\)(0x[0-9a-fA-F]+)|(true|false))(?=\s|$)', block)
        if match: return int(match[1], 16) != 0 if match[1] else match[2] == 'true'
        raise ValueError('Map diagnostics must be an explicit boolean in the APK')
    raise ValueError('Missing explicit APK diagnostics metadata')

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk',type=Path); parser.add_argument('--enabled',action='store_true')
    args=parser.parse_args()
    sdk=Path(os.environ.get('ANDROID_HOME','/workspace/.palmesh-tools/android-sdk'))
    tree=subprocess.check_output([str(sdk/'build-tools/37.0.0/aapt2'),'dump','xmltree',str(args.apk),'--file','AndroidManifest.xml'],text=True)
    actual=diagnostics_flag(tree)
    if actual != args.enabled: raise ValueError('APK map diagnostics mode differs from intended distribution')
    print('APK map diagnostics: '+('explicit acceptance-only opt-in' if actual else 'disabled; suitable for ordinary interaction testing'))
