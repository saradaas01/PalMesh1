# Aqaba demo: two-phone acceptance

Use only the human ARM64 `PalMesh Aqaba Demo` APK from a successful exact-source
workflow. Keep all original PalMesh apps and data. This separate app creates its
own identity; it does not import or replace an installed identity. Record both
phone models/OS versions, APK SHA-256, source commit, map data time, permission
choices and observations. Emulator-injected GPS and signed simulated reports
are regression evidence, not physical GNSS or two-phone proof.

1. **Names and trust:** Save different profile names on both phones. Leave name
   sharing off and send a public message: the other phone must not learn the
   local-only name. Read the public-sharing explanation, opt in, exchange over
   the offline mesh, and confirm the received name is labeled self-declared.
   Open the sender's full fingerprint from chat and SOS/map details. Add/import
   the public identity and choose a local nickname; it must take precedence.
   Compare fingerprints explicitly. Rename the sender and restart both phones:
   the receiver's nickname and comparison state must survive. With another
   identity using the same name, fingerprints must remain distinct. Turn sharing
   off and reconnect; withdrawal must not remove a receiver-chosen nickname.
   Copies already delivered cannot be remotely erased. Replayed/stale updates
   and key substitutions are covered by automation; do not assume a familiar
   name proves a person's identity.
2. **Delayed times and privacy:** Disconnect the phones, send a message, record
   its displayed sender time, wait, then reconnect. The receiving bubble and
   preview must retain the original sender time; optional receipt details must
   show the later local storage time. Restart and verify unchanged times and
   content. Check English/Arabic and device timezone/12–24-hour preferences.
   Deliberately incorrect sender clocks must be treated as unverified, not
   silently corrected. Test a private conversation only after exchanging the
   verified public identity; preserve encryption and local draft on failure.
3. **Risk suggestions:** Without internet, try Arabic and English bleeding,
   breathing, trapped/fire, essential supplies, negated/resolved/quoted and
   figurative examples from the committed evaluation. Compare actual outcomes
   with the published errors, including false positives. Change priority
   manually and keep an urgent draft as ordinary chat. A suggestion must never
   publish SOS automatically. SOS and response cooldowns remain enforced.
4. **Offline map:** Disable Wi-Fi internet and mobile data before cold launch.
   Aqaba streets/buildings/Arabic names must render with pan/zoom and after a
   force-stop/reopen. Bluetooth/Wi-Fi Direct may stay available for the mesh.
   Confirm no old Palestine pack or remote map fallback is used. Out-of-coverage
   reports must display the coverage warning.
5. **Real GPS and exact SOS:** Outdoors, with device Location on, explicitly
   grant precise location and request My location. A successful physical fix
   should produce a blue marker with age/accuracy. Test approximate permission,
   permission denial, disabled Location and cancel separately; retain the last
   actual fix. While acquisition is pending, SOS must queue immediately with
   the latest valid cached fix, or no coordinates. On the other phone, verify
   original ID/message/name/report time and exact red-marker coordinates; tap
   marker, inbox View on map and notification, then restart and repeat. Receive
   two reports from different positions without combining them. A report with
   no coordinates must remain Location unavailable. Explicit voluntary location
   sharing should create distinct amber markers, never live-tracking claims.
   Read the public location/SOS privacy warning before sending any real data.
6. **Radio recovery:** With a queued message, toggle radios, deny a permission
   and restore it, separate/rejoin phones and background/foreground the app.
   Generic transient errors should not create repeated dismiss banners. Passive
   status must distinguish available radios from actually connected peers.
   Confirm bounded recovery and eventual deduplicated delivery. A failed local
   write, encryption or SOS admission must remain a truthful actionable error;
   never count a local queue indicator as confirmed remote delivery or rescue.

Keep failed observations, logs sanitized of message contents/keys and exact
reproduction steps. Real radio range, OS process death/battery restrictions,
location quality and two-phone interoperability still require these observations.
