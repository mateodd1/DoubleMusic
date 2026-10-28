# Connect v1: playback and remote queues

DoubleMusic 1.4 adds optional `queueControl` support without changing protocol version 1. Players remain responsible for playback. The core authenticates, validates and forwards commands; it never plays a remote queue on another device by itself.

## Connection and account boundaries

Use the server origin with WebSocket scheme and `/api/v1/connect`, without query parameters. Native clients send their session token in `Authorization: Bearer TOKEN`. Browser controllers use the HttpOnly `doublemusic_session` cookie and an `Origin` permitted by `ALLOWED_ORIGINS`. Device IDs, presence, queues and commands belong to the authenticated account.

Send a hello within five seconds of connecting:

```json
{"type":"hello","version":1,"role":"player","platform":"android","deviceKey":"stable-installation-id","name":"My phone","capabilities":["playQueue","queueControl"]}
```

Controllers send `{"type":"hello","version":1,"role":"controller"}`. The server replies with `{"type":"ready","version":1,"deviceId":"ephemeral-id","serverTime":1793174400000}`. A player uses `platform: "ios"` or `"android"`; `deviceKey` contains 8–128 characters from `A-Za-z0-9_-`. Reconnecting the same installation replaces its old socket. The account-scoped `instanceId` lets a controller recognize that installation after replacement; it is not an access credential.

Capabilities are optional. Advertise `playQueue` only if complete queue replacement is implemented, and `queueControl` only when all operations below are implemented. Controllers must inspect each live device's capabilities. Older players continue to support their existing controls; unsupported queue commands return `UNSUPPORTED_COMMAND`.

## Player state

Publish state after `ready`, after local or remote changes, and approximately every five seconds while connected. Positions and durations use seconds; `serverTime`, `updatedAt` and `expiresAt` use Unix milliseconds.

```json
{
  "type":"state",
  "state":{
    "track":{"id":"local:t_song","title":"Song","duration":180},
    "position":42.5,"duration":180,"playing":true,"buffering":false,"canNext":true,
    "queueRevision":"revision-1","queueIndex":0,
    "shuffle":false,"repeat":"off","volume":0.7,"muted":false,
    "queue":[
      {"id":"local:t_song","title":"Song","duration":180},
      {"id":"local:t_next","title":"Next song","duration":200},
      {"id":"local:t_song","title":"Song","duration":180}
    ]
  }
}
```

Without `queueControl`, publish the basic fields through `canNext` and omit queue fields. A capable player can also fall back to basic state when its complete queue cannot fit within the limits. To hide a player that has no current track, publish `{"type":"state","state":null}`.

`queue` is the effective playback order, including history, duplicates and the order chosen by shuffle. `queueIndex` is an array index, not a lookup by track ID. Its entry must match `track.id`. `queueRevision` is an opaque 1–64 character `A-Za-z0-9_-` identifier for this queue state. Issue a new revision when contents, order, current index, shuffle or repeat changes; do not change it merely because playback time advanced. Never reuse one revision for different contents.

Send the full array after every connection and whenever the revision changes. Periodic progress reports omit the array while retaining the revision, index and playback controls. A reconnect must resend the full array even if the revision has not changed. `repeat` is `off`, `all` or `one`; `volume` is a finite number from 0 to 1 and controls player gain; `muted` and `shuffle` are booleans.

Only catalog track metadata is relayed: IDs, title, artist, album, artist/album IDs, cover URL and duration. Keep complete `local:` or configured source IDs. Artwork must belong to this DoubleMusic server's catalog. Audio URLs, session tokens, private module credentials and arbitrary metadata are discarded.

## Controller events

Controllers receive `devices` with live account devices and their compact states. Each state includes a monotonically increasing player `sequence` and its measured `updatedAt`. Full queues are separate events:

```json
{"type":"queue","deviceId":"ephemeral-id","revision":"revision-1","queue":[{"id":"local:t_song","title":"Song","duration":180}]}
```

The server sends these events when a queue revision changes and when a controller connects. Periodic position updates do not resend full arrays. Use an event only when its device is live and its revision matches `device.state.queueRevision`. Discard cached queues after disconnect or account change. A paused player remains visible while it publishes fresh state.

## Commands and confirmations

Controllers send an account-local command ID of 1–64 `A-Za-z0-9_-` characters. The server generates a separate ID for the forwarded player command and sets a five-second `expiresAt`. Players must validate expiration, current track, revision and account/socket generation immediately before applying a command.

Basic actions are `play`, `pause`, `next`, `previous`, `seek` and `transfer`; include `trackId` for the current song, plus `position` for seek. `playQueue` starts another complete selection and takes `queue`, `index` and boolean `shuffle`; it requires the `playQueue` capability and is independent of an earlier current-track snapshot.

After applying an operation, publish the actual resulting state before `{"type":"ack","id":"forwarded-command-id","ok":true}`. On failure, acknowledge with `ok:false`. For asynchronous seek, wait for the playback engine's completion and publish its measured position; do not fabricate the requested position. Discard a late completion if the song, session or command changed.

The controller receives `{"type":"result","id":"controller-command-id","ok":true,...}`. Successful seek, queue replacement and queue edits include the measured `device` and `serverTime`. A queue edit acknowledged without a newer player state returns `COMMAND_FAILED`. A transfer additionally requires a snapshot with `queue`, `index`, `position` and `repeat`, and confirmation that the source player has paused.

## Incremental queue controls

Use `queueEdit` to change the existing remote queue or playback preferences:

```json
{"type":"command","id":"append-1","deviceId":"ephemeral-id","action":"queueEdit","trackId":"local:t_song","queueRevision":"revision-1","operation":"append","track":{"id":"local:t_next","title":"Next song","duration":200}}
```

| Operation | Additional fields | Player behavior |
| --- | --- | --- |
| `append` | `track` | Append to effective playback order without interrupting audio. |
| `next` | `track` | Insert immediately after the current index, including in shuffle. |
| `remove` | `from` | Remove a pending entry; its index must be greater than `queueIndex`. |
| `move` | `from`, `to` | Move to the final index indicated; both indices must be after the current entry. |
| `clear` | none | Remove only entries after the current entry. |
| `jump` | `from` | Start the selected array entry from its beginning. |
| `shuffle` | boolean `value` | Set shuffle while preserving the current track and position. |
| `repeat` | `value`: `off`, `all`, `one` | Set repeat mode. |
| `volume` | numeric `value`: 0–1 | Set player gain, rather than system volume. |
| `mute` | boolean `value` | Mute or restore the previous gain. |

The core checks live presence, account, capability, current track and queue revision. `QUEUE_CHANGED` means the supplied revision is stale; `TRACK_CHANGED` means the song changed. Invalid indices, operations, values, track IDs or queue lengths return `INVALID_QUEUE`. While a queue edit or transfer is pending, conflicting commands return `DEVICE_BUSY`.

Serialize rapid append/next actions and use the latest confirmed revision for each. Index operations stay bound to the revision on which the user selected them. Stop pending edits after rejection, timeout, account or output changes. Do not automatically replay an operation after losing an ACK: the player may already have applied it. Queue edits should use the playback engine's incremental operations and preserve current audio; complete replacement is reserved for `playQueue`.

## Limits and recovery

- At most 1,000 queue entries; duplicate IDs are allowed and meaningful.
- State containing a queue must fit within 2 MiB minus 1,024 bytes. Basic state is limited to 16 KiB. WebSocket messages and per-connection outbound buffering are capped at 2 MiB.
- All retained queue JSON shares a 16 MiB global budget. Exceeding it closes the publishing connection. A player with a larger queue should publish basic state rather than truncate the queue or stop playback.
- At most 512 connections globally, 16 per account, 40 messages per second per connection and eight pending commands per controller.
- Missing hello, stale state and missing pong expire presence; successful ping/pong alone does not prove current playback state. Presence and queues are in memory and disappear after a server restart.
- `4001` means an expired/revoked session. `4000` means a replacement connection. `1008` means an invalid message or limits violation. `1012` requests reconnection after maintenance; preserve the session and reconnect with backoff, then resend full state.
- Network failures, `429` and HTTP `5xx` are recoverable errors, not proof of an expired session. Preserve tokens and the account's library mirror, respect `Retry-After`, and retry appropriately. A genuine authentication `401` invalidates the session.

Tests exercise this contract against both Rust and Node, including duplicate entries, late controllers, incremental commands, stale revisions, metadata sanitization and account isolation. Playback-engine behavior, background operation and system interruptions still require testing each mobile client on its devices.
