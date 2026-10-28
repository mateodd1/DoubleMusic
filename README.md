# DoubleMusic

[Español](README-es.md)

A server for organizing and playing your music file library from your mobile clients. DoubleMusic indexes a local folder, reads its metadata, and streams audio from your server. You can enable optional external connections through a documented HTTP API.

Features include user accounts with revocable sessions, favorites, personal playlists, saved albums, followed artists, M3U playlists, local artwork and lyrics, byte-range streaming and seeking, and cross-device control through Connect, with synchronized queues and optional remote queue editing, shuffle, repeat, volume, and mute.

The local library is the center of the server: browsing, featured content, and search use your files by default and work without Internet access after installation. External connections are optional, disabled by default, and queried explicitly through the API. The project is intended for your own or authorized music and services used with the appropriate permissions; see the [usage scope](docs/USAGE.md). The public core uses Rust with Axum/Tokio and SQLite. A private Node.js 22.13+ worker handles the local catalog, FFmpeg/FFprobe audio processing, and optional external connections. Accounts, sessions, personal libraries, and Connect run natively in Rust. Both processes run in the same Docker container; only the Rust API is exposed. See [runtime architecture and migration](docs/RUNTIME.md).

## Getting started with Docker

```bash
git clone https://github.com/mateodd1/DoubleMusic.git
cd DoubleMusic
cp .env.example .env
mkdir -p music
```

Edit `.env`: `MUSIC_DIR` is the host folder containing your music, and `PUBLIC_URL` is the origin your mobile client can reach, such as `https://music.example.com`. Place your files in that folder and start the server:

```bash
docker compose up -d --build
```

Create the first account by entering a password in your terminal:

```bash
read -r -s -p 'Password: ' MUSIC_PASSWORD; printf '\n'
printf '%s\n' "$MUSIC_PASSWORD" | docker compose exec -T doublemusic node cli.js add admin --admin --password-stdin
unset MUSIC_PASSWORD
```

In your mobile client, configure **the same URL as `PUBLIC_URL`, without adding `/api/v1`**, and sign in with that account. Your HTTPS proxy must forward all routes to this service, including WebSocket connections. For local network testing, use `http://SERVER_IP:3000` if your client allows HTTP.

Music is mounted read-only. The `library-data` Docker volume stores accounts, personal libraries, the index, and the audio cache. The Rust core starts its catalog worker on loopback port 3001; the initial scan finishes before the public port opens; large libraries may take some time. The index then refreshes every five minutes, reusing metadata for unchanged files.

## Library

The scanner reads title, artist, album artist, album, year, disc, and track-number tags. When tags are missing, it falls back to the filename and the `Artist/Album/file` folder structure.

- Audio: MP3, FLAC, M4A, AAC, OGG, Opus, WAV, AIFF, WMA, APE, ALAC, M4B, and WavPack, provided FFmpeg recognizes the file.
- Artwork: `cover.jpg`, `cover.jpeg`, `cover.png`, `folder.jpg`, `folder.png`, `front.jpg`, `front.png`, or an image embedded in the track.
- Lyrics: `.ttml`, `.lrc`, or `.txt` files next to the audio file, with the same base filename. LRC and plain text are served as TTML.
- Playlists: `.m3u` and `.m3u8` files with paths relative to the playlist location. Entries must point to tracks already indexed in the library.

Hidden folders, symbolic links, and unreadable files are skipped. IDs are opaque and use the `local:` prefix. A track keeps its ID when its tags change; moving or renaming the file creates a new ID. Your files' metadata is preserved as stored.

## Playback and clients

The API uses `/api/v1`. Clients must keep complete IDs and send `Authorization: Bearer TOKEN` with audio requests, including HEAD and Range requests. The catalog, session, and audio share the same origin.

For the local source, `GET /api/v1/audio/{id}` serves the original file. With `layout=2`, it serves fMP4 with a `sidx` index for mobile clients that use this format. Quality values `320`, `192`, and `128` convert audio to AAC on the server; `format=mp3` requests MP3 instead. Converted files are reused from the cache. For an external source, the module prepares the requested audio and the core streams it to the client.

In fMP4, `original` quality preserves AAC, ALAC, FLAC, and Opus. Other codecs are converted to AAC at 320 kbps. To always obtain the original bytes, use `quality=original&format=original`. Codec support ultimately depends on the mobile player's capabilities.

This server implements the DuoMusic v1 contract. Clients must allow a configurable service origin and preserve complete `source:id` values; the local library uses `local:`. See [docs/API.md](docs/API.md) and the [Connect protocol](docs/CONNECT.md) for integration details. HTTP tests validate the contract and audio files; they do not replace testing each mobile app version on actual devices.

## Enabling and disabling features

In the JSON file selected by `SOURCES_FILE`:

```json
{
  "version": 1,
  "library": { "enabled": true },
  "external": { "enabled": false }
}
```

| `library.enabled` | `external.enabled` | Result |
| --- | --- | --- |
| `true` | `false` | Local library; the default configuration. |
| `true` | `true` | Local library with optional external connections. |
| `false` | `true` | Only the external connections you configured. |
| `false` | `false` | Accounts and API remain available with an empty catalog. |

Configuration takes effect when the service restarts. Disabling the library prevents scanning; disabling external connections prevents DoubleMusic from loading their credentials or calling them. Files, accounts, and personal libraries are preserved. `GET /api/v1/sources` reports the effective configuration and active sources.

To mount your configuration with Compose, create `compose.config.yml`:

```yaml
services:
  doublemusic:
    environment:
      SOURCES_FILE: /config/settings.json
    volumes:
      - ./settings.json:/config/settings.json:ro
```

Save the JSON as `settings.json` and apply it with `docker compose -f docker-compose.yml -f compose.config.yml up -d --force-recreate doublemusic`. For an external connection, add its definition to `sources` and enable `external.enabled`. Each entry also accepts `enabled: false` to disable it individually. The [extension guide](docs/MODULES.md) describes the contract and configuration.

## External connections through the API

- [Mobile client API](docs/API.md) and [OpenAPI contract](docs/openapi.json).
- [Module development guide](docs/MODULES.md) and [module OpenAPI contract](docs/module-openapi.json).
- [Runnable reference module](examples/module/server.js), with locally generated sample audio.

Connecting a module keeps normal browsing focused on your local library. Use `source=ID` to query an extension; `source=all` searches or displays content across all sources. Modules do not automatically copy or download their catalogs into the local folder.

Each module implements `/module/v1`: catalog, search, tracks, audio, artwork, and lyrics. DoubleMusic manages accounts, permissions, favorites, and playlists; clients continue to use `/api/v1`. Operators configure connections through `SOURCES_FILE` and enable them with `external.enabled`. There is no need to modify the core or add platform-specific dependencies to the server.

The contracts are also served at `/api/v1/openapi.json` and `/api/v1/modules/openapi.json`. The optional example and its configuration are explained in [MODULES.md](docs/MODULES.md).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SOURCES_FILE` | empty | Source configuration JSON. Without it, only the local library is loaded. See [modules](docs/MODULES.md). |
| `MUSIC_DIR` | `./music` | Host music folder in Compose. |
| `PORT` | `3000` | Port published on the host in Compose. |
| `BIND_ADDRESS` | `0.0.0.0` | Host address on which to publish the port. |
| `PUBLIC_URL` | `http://localhost:3000` | Public origin without a path, used to generate artwork and audio URLs. |
| `SCAN_INTERVAL_SECONDS` | `300` | Scan interval; `0` disables periodic scanning. |
| `CACHE_MAX_MB` | `2048` | Approximate cache limit; least-used variants are removed. |
| `TRUST_PROXY` | `false` | Trust the protocol forwarded by a trusted proxy when setting cookies. |
| `SECURE_COOKIES` | `false` | Require HTTPS for the session cookie. |
| `ALLOWED_ORIGINS` | `PUBLIC_URL` | Comma-separated allowed origins for web Connect controllers. |

A conversion finishes before it is served, making its size known and allowing exact byte-range seeking. The first request may take some time; subsequent requests use the prepared file. At most two conversions run concurrently. A newly generated file may exceed the cache limit on its own and is kept until a later cleanup.

## Accounts and maintenance

```bash
docker compose exec doublemusic node cli.js list
docker compose exec doublemusic node cli.js revoke username
# add and passwd read the password from stdin, as in the initial example.
docker compose exec -T doublemusic node cli.js passwd username --password-stdin
docker compose exec doublemusic node cli.js del username
docker compose logs --tail=100 doublemusic
```

Sources are configured for the instance. Accounts are independent, with their favorites, playlists, and sessions stored per user. Playlists can combine tracks from different sources. Changing a password revokes that account's sessions. Administrators can manage accounts and trigger scans through the API. For a consistent backup, stop the container and back up the `library-data` volume; back up your music folder separately.

## Running directly and testing

With Rust 1.98 (pinned in `rust-toolchain.toml`), Node.js 22.13+, and FFmpeg/FFprobe installed:

```bash
npm ci --ignore-scripts
cargo build --manifest-path core-rust/Cargo.toml --release --locked
MUSIC_DIR=/path/to/music DATA_DIR=/path/to/data PUBLIC_URL=http://localhost:3000 npm start
npm test
cargo test --manifest-path core-rust/Cargo.toml --locked
RUST_CORE_BIN="$PWD/core-rust/target/release/doublemusic-core" CONNECT_DISABLED=true npm test
```

`DATA_DIR` must be outside the library. When creating accounts directly, use the same `DATA_DIR` with `node cli.js`. Tests generate their own audio and temporary accounts, and check the catalog, sessions, libraries, Connect, ranges, fMP4, conversions, and filesystem access boundaries.

You can also run tests against the Docker image with networking disabled:

```bash
docker build -t doublemusic:test .
docker run --rm --network none -v "$PWD/test:/app/test:ro" doublemusic:test npm test
docker run --rm --network none -e RUST_CORE_BIN=/usr/local/bin/doublemusic-core \
  -e CONNECT_DISABLED=true -v "$PWD/test:/app/test:ro" doublemusic:test npm test
```
