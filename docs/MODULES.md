# Building a DoubleMusic module

DoubleMusic centers on your local music files. A module is an optional extension: an HTTP server that provides a catalog and serves audio when a client explicitly queries it. Modules can use any language and maintain their own credentials, files, or caches. DoubleMusic manages accounts, sessions, favorites, personal playlists, playback permissions, and mobile client connections.

A normal installation enables `library.enabled` and leaves `external.enabled` disabled. External connections are optional extensions for content and services you are authorized to use; the [project scope](USAGE.md) describes this approach. Administrators connect their own modules through a configuration file. Configured sources are shared by accounts on that instance; each account keeps its own personal library.

## Two separate contracts

| Contract | Implemented by | HTTP base | OpenAPI |
| --- | --- | --- | --- |
| Client API | DoubleMusic | `/api/v1` | [openapi.json](openapi.json), also served at `/api/v1/openapi.json`. |
| Module API | The user's module | `/module/v1` | [module-openapi.json](module-openapi.json), served by the core at `/api/v1/modules/openapi.json`. |

Mobile clients communicate with DoubleMusic, which calls the module. Clients receive audio, artwork, and lyrics URLs on the DoubleMusic origin, without seeing the module's private URL or token. Modules do not need to implement login, accounts, personal libraries, or WebSocket support.

## Trying the reference module

The repository includes [examples/module/server.js](../examples/module/server.js). It generates four seconds of sample audio and publishes a track, album, artist, playlist, image, and lyrics. It does not use a platform. It is a runnable implementation of the contract and participates in integration tests.

From the repository root:

```bash
mkdir -p music secrets
chmod 700 secrets
openssl rand -hex 32 > secrets/module-token
chmod 444 secrets/module-token
docker compose -f docker-compose.yml -f compose.modules.example.yml up -d --build
```

The `secrets` directory protects the file on the host. Only that file is mounted read-only inside the containers so the unprivileged process can read it. `secrets/` is excluded from Git and the Docker build context.

The optional overlay configures the local library and the `example` source, and starts the reference module without publishing its port on the host. Using a core account, query `GET /api/v1/sources` and search for `sample` at `/api/v1/catalog/search?q=sample&source=example`.

To stop the example and return to the local service:

```bash
docker compose -f docker-compose.yml -f compose.modules.example.yml stop example-module
docker compose -f docker-compose.yml up -d --build --remove-orphans
```

## Connecting your module

Set `SOURCES_FILE` to a JSON file mounted in the core container:

```json
{
  "version": 1,
  "library": { "enabled": true },
  "external": { "enabled": true },
  "defaultSource": "local",
  "sources": [
    {"id":"local","type":"local"},
    {
      "id":"personal",
      "name":"My module",
      "type":"http",
      "origin":"http://my-module:4000",
      "tokenFile":"/run/secrets/module-token"
    }
  ]
}
```

`library.enabled` defaults to `true` and controls scanning and access to the local folder. `external.enabled` defaults to `false`: HTTP entries in `sources` are loaded only when it is enabled. An entry with `enabled: false` remains disabled even when external connections are allowed. Disabled entries do not require reading their tokens or contacting their servers, and do not appear in `/api/v1/sources`.

The core preserves accounts, sessions, favorites, and playlists when these switches change. With both features disabled, it starts normally with an empty catalog and `defaultSource: null`. If the configured default source is disabled, it selects `local` when active or the first active source; it does not attempt to contact a disabled source. The external switch governs DoubleMusic's calls; the module process is managed separately.

Restart the core after changing configuration. `origin` must be an HTTP or HTTPS origin without a path, query, fragment, or credentials. HTTP is suitable for a private Docker network; a module on another machine can use HTTPS. Redirects are not followed.

`tokenFile` contains a token of 16 to 512 characters from `A-Za-z0-9._~-`. The path can be absolute or relative to the JSON file. DoubleMusic reads it on startup and sends `Authorization: Bearer MODULE_TOKEN` with module requests, including artwork and audio. The module must validate the token on every route.

This token is independent of core sessions. DoubleMusic does not forward a mobile client's Bearer, cookies, passwords, or arbitrary headers to modules. It also does not expose the module secret or private address through the client API. To rotate the token, update the file for both services and restart them.

Up to 16 active sources are supported, with unique IDs of 1 to 32 lowercase letters, digits, or hyphens, starting with a letter. The ID `local` is reserved for `type: local`; it accepts `musicDir` to specify a container folder. `all` is reserved for aggregate queries. Other IDs use `type: http`. `defaultSource` must identify a configured source; if omitted, `local` is preferred regardless of entry order. Without a local source, the first active source is used.

As an advanced configuration, set `library.enabled: false` and `external.enabled: true` to use only external connections: the server will not open or scan a music folder. Accounts and libraries remain in `DATA_DIR`. If `local` is absent from `sources`, it is added automatically when `library.enabled` is enabled. Omit `sources` entirely when using only the local library. The configuration file belongs to the operator; clients cannot register module URLs through the API.

## Identity and models

Inside a module, every ID is a stable string of 1 to 120 characters from `A-Za-z0-9_-`, without `:` or a path. For example, `track-123`. IDs must be unique within each resource type and remain stable across restarts. Do not put credentials or temporary URLs in IDs.

The core adds the source namespace: `personal:track-123`. Two sources can each contain `track-123` without a collision. Clients must preserve and send the complete ID. DoubleMusic removes the namespace before calling the module.

For v1 compatibility, the client API's `provider` field contains the source ID. It is not the name of a predefined platform.

Example track returned by a module:

```json
{
  "id":"track-123",
  "title":"My song",
  "duration":180.5,
  "artist":"My artist",
  "artistId":"artist-7",
  "artists":[{"id":"artist-7","name":"My artist"}],
  "album":"My album",
  "albumId":"album-4",
  "track":1,
  "disc":1,
  "coverId":"cover-4",
  "codec":"flac",
  "bitrate":850,
  "sampleRate":44100
}
```

Required track fields are `id`, `title`, and `duration`. Duration is measured in seconds, bitrate in kbps, and sample rate in Hz. Omit `artistId`, `albumId`, `coverId`, or `imageId` when unavailable; when present, they must be valid IDs.

Complete models and required fields are defined in OpenAPI. Albums use `{id,title,artist?,artistId?,year?,trackCount?,coverId?}`; playlists use `{id,title,trackCount?,coverId?}`; artists use `{id,name,imageId?}`.

`coverId` and `imageId` identify binary resources at `/artwork/{id}`. DoubleMusic generates public URLs on the core origin. The contract does not use `coverUrl`, `streamUrl`, or redirects to providers: platform references stay inside the module.

## Module routes

All routes below are relative to `/module/v1` and require the module token. JSON bodies use UTF-8 and `Content-Type: application/json`.

| Method | Route | Response |
| --- | --- | --- |
| GET | `/` | `{apiVersion:1,name,capabilities:{browse,search,audio,artwork,lyrics}}`. |
| GET | `/catalog/featured` | `{albums:[Album],artists:[Artist],playlists:[Playlist]}`, up to 200 items per type. |
| GET | `/catalog/search?q=text` | `{tracks:[Track],albums:[Album],artists:[Artist],playlists:[Playlist]}`, up to 200 per type. |
| GET | `/catalog/albums` | Page `{items:[Album],total,limit,offset}`. |
| GET | `/catalog/artists` | Page `{items:[Artist],total,limit,offset}`. |
| GET | `/catalog/tracks` | Page `{items:[Track],total,limit,offset}`. |
| GET | `/catalog/playlists` | Page `{items:[Playlist],total,limit,offset}`. |
| GET | `/catalog/tracks/{id}` | Canonical track with that ID. |
| GET | `/catalog/albums/{id}` | Album with `tracks:[Track]`. |
| GET | `/catalog/artists/{id}` | `{artist:Artist,albums:[Album],tracks:[Track]}`. |
| GET | `/catalog/artists/{id}/tracks` | Page `{items:[Track],total,limit,offset}`. |
| GET | `/catalog/playlists/{id}` | Playlist with `tracks:[Track]`. |
| GET / HEAD | `/audio/{id}` | Audio bytes prepared by the module. |
| GET / HEAD | `/artwork/{id}` | Binary image with the correct `Content-Type`. |
| GET | `/lyrics/{id}` | UTF-8 TTML, or `204` when no lyrics exist. |

`limit` ranges from 1 to 500, defaulting to 200. `offset` is a nonnegative integer, defaulting to 0. An out-of-range page returns `items: []` while preserving the real total. Resource details may contain up to 5000 tracks. Return empty arrays when no featured content or playlists are available.

Capabilities are booleans describing the module's features. Unavailable resources return `404`; missing lyrics return `204`. The core does not require animations or automatic artist playlists: it preserves compatibility with static artwork and an empty artist playlist collection.

Before using a module, DoubleMusic checks its manifest and `apiVersion: 1`. This check is cached for 30 seconds; `/api/v1/sources` forces a refresh. A temporary module outage does not prevent the core from starting or the local library from working.

## Audio, preloading, and seeking

Modules return audio the native player can consume directly. Obtaining, preparing, and caching the file are the module's responsibility. Modules may use their own code or FFmpeg; DoubleMusic streams bytes with backpressure and cancels the request when the client disconnects.

| Parameter | Meaning |
| --- | --- |
| `quality=original` | Original quality; the default. |
| `quality=320`, `192`, `128` | Requested bitrate in kbps. |
| `layout=2` | fMP4 with a `sidx` index for mobile clients that use it. |
| `format=original` | Original file bytes; only with original quality. |
| `format=mp4` | Audio in an MP4 container. |
| `format=mp3` | MP3 audio. |
| `spatial` | A client option the module may interpret; fall back to the regular variant if unsupported. |

When `format` is omitted, the contract selects `original` for original quality and a layout other than 2, and `mp4` otherwise. The reference module produces AAC in MP4 for numeric quality values. If your module does not support a combination, return `422`; do not silently return JSON or a URL as audio.

Support the formats and options your clients need. The core validates option names, but does not convert audio received from a module or guarantee device support for its codec.

DoubleMusic forwards `Range`, `If-Range`, `If-None-Match`, and `If-Modified-Since`, along with the GET or HEAD method. It sends `Accept-Encoding: identity`. The module must return sizes and ranges for a stable audio representation:

```http
GET /module/v1/audio/track-123?quality=192&layout=2
Authorization: Bearer MODULE_TOKEN
Range: bytes=0-65535
```

```http
HTTP/1.1 206 Partial Content
Content-Type: audio/mp4
Accept-Ranges: bytes
Content-Length: 65536
Content-Range: bytes 0-65535/6000000
ETag: "stable-representation"
X-Audio-Codec: aac
X-Audio-Bitrate: 192
X-Audio-Sample-Rate: 48000
X-Audio-Duration: 180.5
```

HEAD returns the same headers as GET without a body. An impossible range returns `416` with `Content-Range: bytes */SIZE`. `If-Range` with the representation's ETag enables seeking; do not change the ETag when only updating cache access time.

The core preserves `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag`, `Last-Modified`, and the four `X-Audio-*` headers shown above. It does not propagate cookies, redirect locations, or other private module headers. Supported audio content types are `audio/*`, `application/ogg`, and `video/mp4`; images may be JPEG, PNG, WebP, GIF, or AVIF.

## Selecting sources from a client

`GET /api/v1/sources` returns the effective settings in `configuration.library.enabled` and `configuration.external.enabled`, along with the default source and active sources' availability and capabilities. Paginated lists use `?source=personal`, or `defaultSource` when omitted. To enumerate everything, paginate each source separately.

Search, featured content, and shelves use the default source, normally the local library. Connecting modules does not automatically include them in those queries or add network calls to local browsing. Use `source=personal` to query a module, or `source=all` to combine sources for search and featured content. Responses include `sources:[{id,available,error?}]` so clients can display partial results during an outage. Resource and audio IDs already identify their source and do not need another parameter.

Favorites, saved albums, and personal playlists accept IDs from any configured source. A playlist can mix local tracks and tracks from multiple modules. DoubleMusic resolves canonical source metadata before saving; it does not trust URLs or titles sent by mobile clients. Disconnecting a module does not delete existing favorites or personal snapshots.

## Errors and limits

A module error uses its HTTP status and an object such as `{"error":"NOT_FOUND"}`. Do not include credentials or private links in messages. The core does not forward module error bodies: `404` remains a missing resource, `422` indicates unsupported audio, and other failures appear as `503 SOURCE_UNAVAILABLE`. A JSON response, ID, or content type that violates the contract produces `502 SOURCE_INVALID_RESPONSE`.

Module JSON documents are limited to 8 MiB, manifests to 16 KiB, and lyrics to 2 MiB. Manifest requests have a 5-second timeout; JSON and lyrics requests have a 15-second timeout. Audio uses a 5-minute inactivity timeout and is streamed without loading the whole file into memory.

## Validating your implementation

1. Check the manifest using the module token and validate your responses against [module-openapi.json](module-openapi.json).
2. Connect the module through `SOURCES_FILE` and confirm availability in `/api/v1/sources` using a core session.
3. Query search, album, artist, and track endpoints; check that public IDs include your namespace.
4. Save a favorite and a playlist, then test GET, HEAD, Range, and If-Range playback through DoubleMusic.
5. Stop your module: the core should continue authenticating users and serving other sources.

`npm test` runs the reference module and checks these flows, credential isolation, errors, redirects, access boundaries, and compatibility with the local library. Use [test/modules.test.js](../test/modules.test.js) as a guide for testing your own HTTP server.

When upgrading from a connection configuration older than 1.2.0, add `external: { "enabled": true }` to explicitly permit activation. Without it, the server uses only the enabled local library.
