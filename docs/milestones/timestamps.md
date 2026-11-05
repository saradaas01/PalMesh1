# Original message timestamps

The audit starts from `feat/ai-message-priority` at `714fff7`. Chat projection,
the routing queue, and the persistent chat archive already preserve the original
`createdAt` independently of the receiving phone's `receivedAt`. The visible
defect was the message bubble formatting `receivedAt`; conversation previews
also lacked a sending timestamp.

Message history and previews use the shared `MessageTimestamp` component to show
the sender-assigned `createdAt`. For example, a message created at 10:00 and first
stored by another phone at 10:25 continues to show its original 10:00 time.
The receiving phone's first storage time remains separate metadata and is
described separately in the timestamp's accessibility label.

Formatting uses the device's local timezone and locale through `Intl`. An
optional native display-preference read applies Android's explicit 12/24-hour
setting (and the corresponding iOS locale preference), refreshed on foreground
return. Native absence/failure falls back to Intl's locale default. The app does
not force Jordan time, UTC, English date formatting, or a particular hour cycle. A timezone or locale change
can change the displayed representation; it never changes the stored instant.
The visible date includes its year so old history cannot look like today's
messages merely because the hour is the same.

## Sender clocks and ordering

The timestamp is a sender-assigned claim. A valid signature authenticates which
cryptographic identity supplied it, not the accuracy of that device's clock or
the real-world time an event occurred. The UI labels it as sender time and its
accessibility description explains that the sender's clock may be inaccurate.

A visible advisory appears if the sender time is more than five minutes ahead
of the recorded local receipt time, before 2000, or in year 10000 or later.
These checks do not prove which device has the wrong clock. Old delayed messages
are not automatically considered clock errors. Malformed values and values
outside JavaScript's representable date range show Time unavailable instead of
silently substituting the receipt time. All original values remain unchanged.

History, pagination, unread watermarks, eviction, and conversation recency keep
their existing local archive sequence. Unread SOS/critical/high ordering is also
preserved. A deliberately future-dated message cannot pin a conversation above
later local arrivals, and a delayed older message cannot disappear behind an
already-read sender timestamp. The preview belongs to the latest local arrival
and shows that particular message's original sending time, even if an older
send arrives after a newer one.

## Compatibility and persistence

There is no wire change or archive migration. Signed `createdAt`, TTL forwarding,
encryption, existing identity ownership, and schema version 2 remain intact.
The existing `created_at` and `received_at` columns retain both timestamps across
restart. Duplicate UUIDs and repeated routing snapshots keep the first archived
payload and both original timestamps; custody updates can only advance the
separate peer-storage flag. Relay hops each record their own receipt time while
forwarding the original sender timestamp.

## Verification

Focused core tests exercise the 10:00/10:25 projection; actual three-node DTN
offline queueing, failed-send retry, delayed relay, and duplicate receipt; incoming
message reordering; future-clock conversation sorting; unread watermarks; and a
real SQLite close/reopen. Formatter tests cover New York and Amman, English
12/24-hour locale defaults and explicit OS overrides, Arabic, the device default, clock advisories, malformed
dates, and history restoration. Component tests check original sender time,
separate receipt descriptions, Arabic clock guidance, and unavailable times.

Automated tests do not establish physical phone clock settings or radio delivery.
For two-phone acceptance, queue a message while the receiver is disconnected,
record the sending time, then reconnect at least several minutes later. Confirm
the bubble and conversation preview retain the original time, restart both apps,
and confirm history still shows it. Repeat with different device timezones and
12/24-hour locale settings. Temporarily use an inaccurate test-device clock and
confirm the advisory without changing the message or reordering unread history.
Preserve both installations and restore the test clock afterward.
