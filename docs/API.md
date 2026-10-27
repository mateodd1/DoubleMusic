# DoubleMusic API v1

Complete contract and models: [client OpenAPI](openapi.json), also available at `/api/v1/openapi.json`. The interface for developing modules is documented separately in [MODULES.md](MODULES.md) and [module-openapi.json](module-openapi.json).

Clients configure the server origin, such as `https://music.example.com`, and append `/api/v1` to API routes. Use the same origin for JSON, artwork, lyrics, audio, and Connect. Clients do not connect directly to modules. Deploy the service at the domain root.

## Sessions

`POST /api/v1/auth/login`, with `Content-Type: application/json`:

```json
{"username":"username","password":"password","transport":"bearer"}
```

Response:

```json
{
  "user": {"id":"uuid","username":"username","role":"user"},
  "session": {"token":"TOKEN","tokenType":"Bearer","expiresAt":1790000000000}
}
```

Send `Authorization: Bearer TOKEN` with subsequent requests, including audio HEAD and Range requests. Sessions last 30 days and can be revoked. `transport: "cookie"` sets an HttpOnly cookie for clients that support it; the token is omitted from the JSON response.

| Method | Route under `/api/v1` | Result |
| --- | --- | --- |
| GET | `/` | Version, capabilities, and limits; public. |
| POST | `/auth/login` | Sign in. |
| GET | `/auth/me` | User identity and session expiration. |
| POST | `/auth/logout` | Revoke the current session. |
| PUT | `/auth/password` | `{currentPassword,newPassword}`; revoke all sessions for the account. |

`GET /health` is public and returns status and information about the last local scan. API discovery and both OpenAPI documents are public. Artwork is also public because clients load it as images without credentials. Catalog, library, lyrics, and audio routes require a session. Tokens are not accepted in URL parameters.

## Models and catalog

IDs are opaque, complete strings in the form `source:id`. The local source uses `local:t_...` for tracks, `local:a_...` for albums, `local:r_...` for artists, and `local:p_...` for file playlists. Configured modules use their own namespaces, such as `personal:track-123`. Encode an ID as a single path segment when building URLs; do not shorten or replace it.

A track:

```json
{
  "id":"local:t_0123456789abcdef0123456789abcdef",
  "provider":"local",
  "title":"Song",
  "artist":"Artist",
  "artistId":"local:r_0123456789abcdef0123456789abcdef",
  "artists":[{"id":"local:r_0123456789abcdef0123456789abcdef","name":"Artist"}],
  "album":"Album",
  "albumId":"local:a_0123456789abcdef0123456789abcdef",
  "track":1,
  "disc":1,
  "duration":180.5,
  "coverUrl":"https://music.example.com/api/v1/catalog/artwork/local%3At_0123456789abcdef0123456789abcdef",
  "codec":"flac",
  "bitrate":850,
  "sampleRate":44100
}
```

Duration is measured in seconds, bitrate in kbps, and sample rate in Hz. Library and session timestamps are Unix milliseconds. Actual filesystem paths remain inside the server.

| GET under `/api/v1` | Response |
| --- | --- |
| `/catalog/featured` | Shelves named `albums`, `artists`, `playlists`, `pools`, and `followed`, each with `title` and `items`. |
| `/catalog/search?q=text` | `{tracks,albums,artists,playlists}`, up to 200 per type; case-insensitive and accent-insensitive. |
| `/catalog/albums` | `{albums,items,total,limit,offset}`. |
| `/catalog/artists` | `{artists,items,total,limit,offset}`. |
| `/catalog/tracks` | `{tracks,items,total,limit,offset}`. |
| `/catalog/albums/{id}` | Album with `id,title,artist,artistId,year,coverUrl,trackCount,tracks`. |
| `/catalog/artists/{id}` | `{artist,albums,singles,tracks,playlists,playlistsStatus}`. |
| `/catalog/artists/{id}/tracks` | `{artist,tracks,items,total,limit,offset}`. |
| `/catalog/artists/{id}/playlists` | `{artistId,status:"empty",playlists:[]}`. |
| `/catalog/tracks/{id}` | Track. |
| `/catalog/tracks/{id}/motion` | `{id}`; clients use the static artwork. |
| `/catalog/playlists` | `{playlists,items,total,limit,offset}`, with playlist summaries from the selected source. |
| `/catalog/playlists/{id}` | Playlist with its `tracks`. |
| `/catalog/daily`, `/catalog/discovery` | `{generatedAt,shelves:[{title,items}]}` containing playlists from the selected source. |
| `/catalog/artwork/{id}` | Artwork image; also supports HEAD. |
| `/sources`, `/providers` | `{defaultSource,configuration:{library:{enabled},external:{enabled}},items:{id:{id,name,type,available,capabilities?,error?}}}`. Lists active sources only. |

Paginated lists accept `limit` from 1 to 500, defaulting to 200, and a nonnegative `offset`, defaulting to 0. They accept `source=ID` and use the default source when omitted. To enumerate all sources, paginate each one separately. Search, featured content, and shelves also use the default source, which is the local library when configured unless explicitly overridden. Connecting modules does not add network calls to local browsing. `source=ID` selects an extension; `source=all` combines sources for search and featured content, with per-source availability in `sources`. `provider` is accepted as an alias for `source`. `featured` includes up to 200 albums and artists; use paginated endpoints for larger libraries.

Local albums are grouped by album artist and title; individual track artists are preserved separately. Albums with the same album artist and title share a catalog entry. Tracks are sorted by disc and track number.

## Server-side audio

`GET` or `HEAD /api/v1/audio/{id}`. The ID selects the source: the local library processes the file with FFmpeg, while modules prepare their own audio and DoubleMusic streams it with the same authentication, HEAD, and range behavior. Responses contain audio bytes and support a single `Range: bytes=start-end`, open-ended ranges, and suffix ranges. They return `206` with `Content-Range`, or `416` for an invalid range. `Content-Length`, `Accept-Ranges`, `ETag`, and `If-Range` support preloading and seeking without scanning the entire track.

| Parameter | Values | Behavior |
| --- | --- | --- |
| `quality` | `original`, `320`, `192`, `128` | Defaults to `original`. Numeric values request server-side conversion to that bitrate. |
| `layout` | `1`, `2` | `2` selects fMP4 with a `sidx` index unless `format` is explicitly set. |
| `format` | `original`, `mp4`, `mp3` | When omitted: original for original quality and a layout other than 2; MP4 otherwise. |

For local audio, `format=original` requires `quality=original` and returns the file unchanged. MP4 at original quality preserves AAC, ALAC, FLAC, and Opus; other codecs are converted to AAC at 320 kbps. Numeric MP4 qualities always produce stereo AAC at 48 kHz. MP3 is converted to the requested bitrate, or 320 kbps for `original` quality.

Additional presentation options sent by a client do not change local file selection. The actual format and codec are reported in `Content-Type`, `X-Audio-Codec`, `X-Audio-Bitrate`, `X-Audio-Sample-Rate`, and `X-Audio-Duration`. Clients may need to read these headers to display playback quality. External modules implement the requested combinations themselves or return `422` when unsupported.

Mobile client example:

```http
GET /api/v1/audio/local%3At_0123456789abcdef0123456789abcdef?quality=192&layout=2
Authorization: Bearer TOKEN
Range: bytes=0-65535
```

For the local source, conversion finishes on disk before the response is served; a HEAD request can also prepare a variant. Allow enough proxy response time for the first conversion. Later requests reuse the cache. The selected codec must be supported by the client's native player.

Optionally, `POST /playback` with `{trackId,quality?,format?,layout?}` returns `{trackId,audioUrl,format,info}`. The URL uses the same session and contains no credentials. Clients using `/audio/{id}` directly do not need this call.

## Lyrics

`GET` or `HEAD /lyrics/{id}` returns TTML with `Content-Type: application/ttml+xml` and `X-Lyrics-Source: local` for the local source. Missing lyrics return `204`. Local sidecar priority is `.ttml`, then `.lrc`, then `.txt`, next to the track with the same base filename. For modules, the module's lyrics route provides the content and `X-Lyrics-Source` contains the source ID. LRC retains its timestamps and `offset`; plain text has no timing information.

## Per-account library

| Method | Route under `/api/v1` | Body / result |
| --- | --- | --- |
| GET | `/library` | `{rev,favorites,playlists,savedAlbums,savedPlaylists,following,catalogRev}`. |
| PUT | `/library/favorites/{id}` | `{track:{id}}`. |
| DELETE | `/library/favorites/{id}` | Remove a favorite. |
| POST | `/library/playlists` | `{name,tracks:[{id}]}`; returns `{rev,playlist}`. |
| GET | `/library/playlists/{id}` | `{rev,playlist:{id,name,createdAt,updatedAt,tracks}}`. |
| PATCH | `/library/playlists/{id}` | `{name}`. |
| DELETE | `/library/playlists/{id}` | Delete a playlist. |
| POST | `/library/playlists/{id}/tracks` | `{tracks:[{id}]}`; returns `{rev,added}`. |
| DELETE | `/library/playlists/{id}/tracks/{trackId}` | Remove a track. |
| PUT | `/library/playlists/{id}/order` | `{trackIds:[...],expectedRev?}`; a complete permutation. |
| PUT / DELETE | `/library/saved-albums/{id}` | Save or remove an album. |
| PUT / DELETE | `/library/saved-playlists/{id}` | Save or remove a catalog playlist. |
| GET | `/following` | `{rev,items}`. |
| PUT | `/following/{artistId}` | `{}`; the server loads the artist's canonical metadata from its source. |
| DELETE | `/following/{artistId}` | Unfollow an artist. |
| POST | `/library/import` | `{source,deviceId,favorites:[{id}],playlists:[{id,name,tracks:[{id}]}]}`. |

Metadata received in write requests is replaced by canonical metadata from the relevant source. Favorites and personal playlists can combine tracks from configured sources. Clients may send complete snapshots. Saved tracks are returned as `{track,addedAt}`. Personal playlists use `u...` IDs and belong exclusively to their account. Imports accept `source` values `ios`, `android`, or `web` and are idempotent per account, source, and device; all IDs must exist in a configured source.

Writes return `rev`; idempotent operations do not increment it. `GET /library?rev=N&catalogRev=HASH` returns `304` when nothing has changed. `catalogRev` detects changes in saved catalog playlists. Limits are published at the API root. Favorites and personal playlists keep their snapshots if a track later disappears; playback returns `404` until it becomes available again with that ID.

## Administration

Requires `role: admin`:

| Method | Route under `/api/v1` | Purpose |
| --- | --- | --- |
| GET | `/admin/users` | Accounts and item counts. |
| POST | `/admin/users` | `{username,password,role?}`. |
| POST | `/admin/users/{username}/password` | `{password}`; revokes sessions. |
| POST | `/admin/users/{username}/revoke` | Revoke all sessions. |
| DELETE | `/admin/users/{username}` | `{confirm:username}`; cannot delete the current account. |
| POST | `/admin/scan` | Start a local scan; returns `202` without waiting for completion. Returns `404 LOCAL_SOURCE_DISABLED` when the local source is disabled. |
| GET | `/admin/scan` | `{scanning,lastScan,error}`. |

Usernames contain 4 to 64 characters from `A-Za-z0-9_.-`; passwords contain 8 to 1024 characters. Library updates are atomic in SQLite. Scans publish a complete new catalog snapshot.

## Connect

WebSocket at `/api/v1/connect`, using the same Bearer and origin. Clients first send `{type:"hello",version:1,role:"player",platform:"ios"|"android",deviceKey:"stable-device-key",name:"My phone",capabilities:["playQueue"]}`. The device key contains 8 to 128 characters from `A-Za-z0-9_-`.

The server responds with `ready`. Players publish `{type:"state",state:{track,position,duration,playing,buffering,canNext}}`. Here, `track` contains `{id,title,artist,album,artistId,albumId,coverUrl,duration}`. Times are measured in seconds.

Controllers start with `{type:"hello",version:1,role:"controller"}` and receive `devices`. They send `{type:"command",id:"command-id",deviceId,action,trackId?,position?}`. Actions are `play`, `pause`, `next`, `previous`, `seek`, `transfer`, and `playQueue`. The last action includes `{queue:[track],index,shuffle}`. The player executes the command and acknowledges it with `{type:"ack",id,ok}`; a transfer also includes `snapshot:{queue,index,position,repeat}` after pausing. The controller receives `result`.

Presence is kept only in memory and is scoped to each account. Web controllers sending `Origin` must be allowed by `ALLOWED_ORIGINS`; native clients use Bearer authentication. Connect tests cover reconnection, expiration, acknowledgements, and queue transfers.

## Errors

```json
{"error":"NOT_FOUND","message":"Resource not found.","requestId":"uuid"}
```

Main statuses: `400` invalid request, `401` invalid session, `403` insufficient permissions, `404` missing resource, `409` order or revision conflict, `413` limit exceeded, `416` invalid range, `422` unsupported file or format, `429` rate limit, and `503` a full conversion queue.

Unavailable modules produce `503 SOURCE_UNAVAILABLE`; module responses that violate the contract produce `502 SOURCE_INVALID_RESPONSE`. The core does not forward private module errors or credentials. See [MODULES.md](MODULES.md) to configure sources and develop modules.

Configuration independently controls `library.enabled` (default `true`) and `external.enabled` (default `false`). Changes take effect on restart. Disabling a feature preserves user data but removes that feature's sources from catalog and audio routing; inactive source IDs return `404 SOURCE_NOT_FOUND`. With both disabled, the core keeps accounts and personal libraries available, returns empty catalog lists, and publishes `defaultSource: null`. Contracts and `/health` remain available.
