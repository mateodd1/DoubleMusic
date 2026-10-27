# Rust core and catalog worker

DoubleMusic 1.3 runs a Rust HTTP and WebSocket core with Axum/Tokio. The migration follows the identity, library, and Connect implementation in the source server and adapts it to DoubleMusic's local catalog and generic extension contract.

| Responsibility | Runtime |
| --- | --- |
| Login, cookies, Bearer sessions, password changes, account administration | Rust |
| Favorites, personal playlists, saved albums/playlists, followed artists, imports | Rust |
| Connect presence, commands, acknowledgements, queues, transfer, revocation | Rust |
| Local scanning, metadata, artwork, lyrics, catalog search | Private Node worker |
| FFmpeg conversion/cache, audio bytes, byte ranges and HEAD | Private Node worker |
| Optional HTTP extensions, source configuration, OpenAPI documents | Private Node worker |

This is an incremental migration. Node remains a required runtime for catalog and media processing. There are no bundled platform integrations. The public routes remain `/api/v1`; mobile clients and extension authors use the existing contracts.

## Default Docker runtime

`doublemusic-core` starts `node server.js` on `127.0.0.1:3001`, disables the worker's Connect coordinator, and opens the public listener after the worker finishes its initial scan. The worker's port is not published or bound to the container network. The core streams catalog/audio responses without buffering audio, keeps Range and HEAD semantics, strips hop-by-hop headers, and refuses redirects to other origins.

The Rust process monitors the worker. If the worker exits, the container exits with an error and the Compose restart policy restarts it. Readiness checks both SQLite and the worker. Termination closes Connect and HTTP before stopping the worker; the container's init process reaps children.

The existing `docker-compose.yml`, `.env`, `SOURCES_FILE`, read-only music mount, and `library-data` volume continue to work. `library.enabled` and `external.enabled` keep their existing meanings. Disabling external connections still prevents credential loading and module calls. All catalog lookups used to save favorites, playlists, imports, albums, or followed artists use canonical metadata from the selected source, rather than trusting client-supplied metadata. Artwork stays on the configured DoubleMusic origin.

Administrative commands remain available through `docker compose exec doublemusic node cli.js ...`. The CLI and worker read the same SQLite file as Rust.

## Existing installations

Before upgrading, stop the service and back up its complete data volume and current image/configuration. Do not copy an active SQLite database without its WAL state. Then run:

```bash
git pull --ff-only
docker compose up -d --build
docker compose exec doublemusic doublemusic-core --healthcheck
```

The schema version stays at 1. Rust reads and writes the same users, scrypt password hashes, SHA-256 session digests, expiry timestamps, revisions, and personal libraries. Existing Bearer tokens and `doublemusic_session` cookies remain valid. Connect clients reconnect and republish their state; presence is intentionally ephemeral.

For a code rollback, start the retained Node image with the current data volume, or override the new image's command with `node server.js`. Restart the service to keep every Connect client on the same coordinator. Do not restore the pre-upgrade database merely to switch runtimes: doing so would discard later library edits and password changes. A data restore is a separate disaster-recovery operation.

## Development and checks

The repository pins Rust 1.98.0; Cargo.lock pins dependencies. Node 22.13+ and FFmpeg/FFprobe are also required.

```bash
npm ci --ignore-scripts
cargo fmt --manifest-path core-rust/Cargo.toml --check
cargo clippy --manifest-path core-rust/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path core-rust/Cargo.toml --locked
cargo build --manifest-path core-rust/Cargo.toml --release --locked
npm test
RUST_CORE_BIN="$PWD/core-rust/target/release/doublemusic-core" CONNECT_DISABLED=true npm test
```

The HTTP/WebSocket contract tests can run against either runtime using isolated temporary SQLite files and generated audio. One Node test uses its injected clock; Rust's native tests cover timeouts, stale presence, session revocation, admission limits, bounded message queues, and slow consumers with a controlled clock. No real music accounts or external platforms are needed. After `docker build -t doublemusic:test .`, `npm run test:container` checks managed startup, loopback isolation, read-only execution, account/session persistence, graceful shutdown, and worker failure handling. Docker contract tests run with networking disabled, permitting only loopback communication between the test processes.

Rust performs SQLite work on a dedicated thread with a bounded queue and scrypt work on blocking threads with bounded concurrency. Write transactions use `BEGIN IMMEDIATE`; the shared database uses WAL and a five-second busy timeout. Internal catalog JSON responses are limited to 16 MiB. Connect limits connections to 512 globally and 16 per account, queues to 1,000 tracks, messages and outbound buffering to 2 MiB, and commands to eight pending requests per controller.

## Advanced runtime settings

Normal installations only need the settings documented in the main README. For development or a separately managed private worker:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CORE_DB` | `DATA_DIR/core.sqlite` | Shared SQLite file; the managed worker receives this exact path. |
| `CORE_LISTEN` | `HOST:PORT` | Rust listener, normally `0.0.0.0:3000`. |
| `CATALOG_ORIGIN` | managed `http://127.0.0.1:3001` | Explicitly setting a trusted private HTTP origin disables managed worker startup. No path, credentials, query or fragment allowed. |
| `HOST` | `0.0.0.0` | Public bind address when `CORE_LISTEN` is absent. |
| `CONNECT_DISABLED` | `false` | Worker/development setting; the Rust launcher sets it on its private Node worker. |

A separately managed worker must share the same database and source/public URL configuration and must disable its own Connect coordinator. Keep its origin private. `X-Core-Runtime: rust` identifies native responses; `rust-catalog` identifies responses streamed from the worker. The discovery response also contains `runtime: { "core": "rust", "catalog": "node" }`.
