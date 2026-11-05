# Passive connection feedback

The runtime previously mapped every mesh error and radio start/stop exception to
the global `radio-error` issue. That repeatedly displayed an intrusive banner and
could replace feedback about a rejected SOS. Transport availability does not mean
an authenticated peer is connected.

Transient transport failures now update a small, in-memory diagnostics counter.
The counter is capped at 1,000, resets when a runtime starts, and stores no native
error message, operation, endpoint, fingerprint, message body, or key. Settings
offers a collapsed Connection diagnostics section. The app header quietly shows
Waiting to connect or the count of authenticated connected mesh sessions. Existing
radio readiness and permission guidance remain in Settings.

MeshCoordinator's bounded discovery/reconnect/fallback behavior is unchanged.
There is no new retry button, background-location permission, network request or
change to DTN/security/message storage. Legacy `radio-error` snapshots are also
suppressed by the shell, so they cannot resurrect a main-screen dismiss loop.

Action failures remain explicit: permission access, queue capacity, rejected or
rate-limited SOS, alert/background authorization and feature-level encryption or
storage errors retain their existing feedback. An aggregated failure while closing
services is now classified as `shutdown-failed`, rather than incorrectly hidden
as a transient radio interruption. Local queue confirmations still require the
feature's successful durable publication result.

Regression coverage exercises transient errors during a rejected SOS and after a
successful queue, sanitized bounded/reset diagnostics, stale callback rejection,
availability-versus-connected display, optional diagnostics and critical feedback.
Physical Bluetooth/Wi-Fi Direct interruptions and recovery still require a real
two-phone acceptance check; UI/core tests do not establish radio delivery.
