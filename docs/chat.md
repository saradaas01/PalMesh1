# Chat & Messaging

The chat feature supplies a React Native inbox, direct and nearby-broadcast
conversations, reactive hooks and a persistent conversation archive. It publishes
through the existing DTN engine and observes mesh peers; screens contain no
SQLite, native radio or routing logic.

## Source layout

```text
src/features/chat/
  domain/                         Visibility, delivery states and archive ports
  application/ChatService.ts       Reactive state and messaging use cases
  infrastructure/SqliteChatRepository.ts
  ui/                             ChatProvider, useChat, PalMeshChatApp
```

`features/chat/index.ts` exports application/domain/storage APIs without loading
React Native. Import screens/hooks from `features/chat/ui`. This keeps core
tests and non-UI consumers independent of the native runtime.

## Mobile host integration

The UI uses React Native 0.88.0, React 19.3.1 and
`react-native-safe-area-context` 5.10.1. Dependencies are pinned in the lockfile.
The host must link native safe-area/SQLite/radio packages, run in a native app
and start the mesh node before mounting the chat UI.

The native composition root is [`createNativeResources`](../src/app/infrastructure/createNativeResources.ts).
It initializes the security vault and SQLCipher before opening the chat archive,
then supplies one `ChatService` shared by the tabs. Reuse that boundary when
creating another host; opening an unencrypted SQLite handle is not the production
configuration. [Android](android-app.md) and [iOS](ios-app.md) hosts are included.

`ChatProvider` starts/stops only chat subscriptions. It never closes the routing
database or stops radios when a screen unmounts. Keep one shared `ChatService`
per device/runtime. Mount only one lifecycle-owning provider for that service.
The host controls foreground/background policy and refreshes after resuming.
The provider observes `AppState`: background arrivals continue to be archived
but remain unread, even if their conversation was selected. Returning to the
foreground marks the visible thread read. If a host navigation system keeps the
chat route mounted while hidden, pass its focus state with
`<PalMeshChatApp service={service} visible={isFocused} />` (or the same `visible`
prop on `ChatProvider`). Visibility requires both an active app and a focused
route; resuming the app cannot consume unread messages on a hidden route.
Non-React hosts can call `service.setVisible(...)` themselves.

Android should use `adjustResize` for the keyboard. Safe-area insets protect the
bottom SOS control from system navigation. Screen readers, dynamic font sizes,
Arabic/emoji content and RTL writing are supported by the components; system
keyboard/inset behavior still needs physical-device validation.

## Conversations and offline behavior

An offline recipient can be entered manually using its stable peer ID. A direct
conversation does not require a currently connected recipient or a known route.
Nearby broadcasts (`*`) are shared with mesh participants and collect SOS history.
Unicast packets carried for other devices and standalone GPS packets never appear
as local chat conversations. In the integrated app direct messages are signed
and end-to-end encrypted; recipient public keys must already be known from an
authenticated contact or imported identity. An arbitrary peer ID alone is not
sufficient to encrypt a first message. Discovery authenticates a cryptographic
address, not the person holding that phone. See [security](security.md).

The inbox shows unread counts and last-message previews. Opening a conversation
marks incoming messages read through their local archive sequence; timestamps
from another device cannot reorder history or skip a same-millisecond arrival.
The latest 50 messages load initially, with older pages up to 1,000 visible
messages per conversation. The archive can retain more than that display window.

Drafts remain in memory across conversation navigation (up to 32 draft threads).
They are capped at 4,096 UTF-16 code units and cleared only after the DTN database
accepts the message. A full queue or failed routing write retains the draft.
New typing in another thread cannot be erased by completion of an older send.
Unsent drafts do not survive process death; accepted messages do.

## Delivery labels

| Label | Meaning |
| --- | --- |
| Queued locally | The routing database accepted this outgoing packet. |
| Stored by a peer | At least one peer previously acknowledged durable custody. |
| Received on this device | This device stored an incoming message. |
| Forwarding ended | The local forwarding-retention deadline passed without a known peer ACK. |
| Saved on this device | A self-addressed local message requires no forwarding. |

A peer may be an intermediary or the destination. Custody is never presented as
a human read receipt or a promise of assistance. Known custody remains a
historical fact after forwarding expires. A connected mesh-peer count is not a
recipient-presence indicator.

`historyWithCustody()` reads the durable routing ledger so the archive can
recover acknowledgments received while the UI was closed. Archive updates merge
custody monotonically; a stale initial snapshot cannot erase a newer ACK. The
service subscribes before reading the initial snapshot and serializes archive
writes to avoid message/load races.

## Archive retention and failure handling

The archive has a dedicated SQLite schema and identity binding. It retains the
latest 5,000 visible message bodies by default (configurable 1–20,000), separate
from the DTN queue's 24-hour forwarding retention. Oldest bodies are evicted at
capacity. UUID tombstones prevent immediate resurrection from repeated routing
snapshots; at most `max(10,000, 2 * maxMessages)` retired IDs are kept, in addition
to IDs of retained bodies. After that bounded dedup window, an old UUID can be
archived again. There is no indefinite-history guarantee.

Local sequence, read flags and custody survive a database reopen. The archive
rejects another device identity rather than displaying a previous identity's
conversations. It cannot yet migrate a user's identity or implement secure
deletion/backup; those require a separate design.

Incoming archive events are coalesced in bounded maps (1,000 message IDs and
1,000 custody IDs), written in batches of 100 and reconciled against routing
history on refresh. A prolonged archive outage or retention/overflow can leave
gaps; a successful routing write remains queued even if history is unavailable.
Errors are surfaced and retries are bounded rather than accumulating unlimited
background promises.

SOS publishes directly to the durable routing use case, with the engine's
15-hop emergency priority. It does not wait behind archive initialization or a
stalled history write. The large red control takes one tap from the inbox or
conversation; the new-recipient dialog takes Close then SOS, at most two taps.
While its routing write is pending, repeat presses are suppressed. Success says
"SOS queued on this device"; queue failures are visible and never reported as sent.
The standalone chat control does not attach GPS. In the integrated Android app,
one shared SOS control on both routes uses the maps service's timestamped stored
fix when available; see [maps integration](maps.md).
The [emergency inbox](../src/features/emergency/README.md) supplies urgent incoming
SOS review and authenticated **responding** statements tied to the original SOS.
Those are separate from chat custody labels. A statement is a person's intent,
not proof of receipt by an emergency organization or guaranteed assistance.

## Verification and remaining work

Run `npm run check` for strict types, core/SQLite/service tests, React Native
interaction tests and the declaration build. Core tests use real SQLite and
cover disk reopen, unread sequence boundaries, visibility filtering, archive
eviction/rollback, offline sends, draft races, subscription/snapshot races,
custody rehydration, error recovery, event bursts and SOS during archive failure.
UI tests render the actual RN components with an application-boundary service
double and native safe-area mocks.

This does not establish physical Android/iOS layout, keyboard, accessibility,
radio or background behavior. An earlier Android development APK compiled and
passed packaging checks; later native integrations need a fresh build. Follow
[device acceptance](device-acceptance.md), including Arabic/RTL, screen readers,
unknown recipient keys, encrypted storage, native map/GPS and interrupted radios.
No physical-phone or iOS compilation result is claimed by these JavaScript tests.
