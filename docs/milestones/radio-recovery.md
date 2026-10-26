# Inactive radio recovery milestone

Based on consolidated work `7cf854e`. Power-off teardown can remove native
listeners, so the prior mesh never observed power restoration until app resume.
Inactive supported radios now get read-only checks with bounded 1–30 second
exponential backoff and one in-flight startup per radio. Healthy links remain
untouched. Stop prevents further polling. BLE scanner failure now publishes
unavailable status before teardown rather than leaving false active readiness.
No permission prompt, network fallback, key change or queue reset is introduced.

Verification: 50 focused mesh coordinator/radio tests, strict TypeScript and
module build passed. New regressions cover Wi-Fi off/on without resume,
continued BLE delivery, re-handshake, bounded denied-state polling, concurrent
refresh coalescing, no polling after stop and fatal BLE scanner recovery.
The multi-peer exchanges use byte-level simulated radios, not physical phones.
Native Android/iOS build and KVM results are tracked by the feature PR's CI.
