# Emergency reception and human response

`EmergencyService` is a React-independent external store. Construct it with an authenticated engine's local projection and `SqliteEmergencyRepository`, then start it before enabling mesh acceptance. The application owns the engine and SQLite connection. Stop this service before closing that connection.

`EmergencyInbox` is an inline navigation route. `EmergencyBanner` exposes the newest unreviewed incoming SOS. Keep the application's global SOS action visible on this route and next to the banner; these components do not open a modal or request location.

A response is a direct `sos-response` packet with `{sosId, status: 'responding'}` and a 15-hop budget. It has emergency routing priority. The authenticated source records a person's stated intent; it is not a delivery/read receipt, a verified responder qualification, a commitment by an emergency organization, or proof that assistance will arrive. Responses include no responder location. Public SOS/response packets can expose their signed contents to mesh participants; pairwise encrypted chat is a separate capability.

The archive accepts responses only for an existing SOS belonging to or answered by the local device. It checks the response's destination against the original source, excludes self claims, and keeps one response per responder/SOS. Relay packets, ordinary chat and transport hop acknowledgments cannot create a human response. Chat archives hide control packets.

SOS UUIDs are durable, first-payload-wins rows; reviewed state and responder statements survive restart. By default the archive retains 200 SOS and 32 responders per SOS. The event coalescing buffer holds at most 1,000 UUIDs; `refresh()` recovers from up to 1,000 retained DTN history records after transient storage errors. Archive expiry ends response eligibility and urgent alerting; it never claims an emergency was resolved.

Native notification delivery is best effort. Notification claims commit before side effects to ensure at most one attempt per retained UUID across restarts. A process crash after a claim can miss that notification, while the SOS remains in the durable inbox. A history batch attempts at most four native notifications to bound alert storms. Native adapters must display generic private text, avoid coordinates/source/message content, and honor notification permission without prompting automatically. Denied alerts do not remove or resolve inbox entries.

DTN schema v2 widens the stored kind constraint for `sos-response`. Its transaction preserves version-one queued packets, sequence, UUID tombstones, retry state and custody receipts.
