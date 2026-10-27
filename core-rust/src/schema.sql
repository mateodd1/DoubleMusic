-- Compatible with the Node core schema v1; additive initialization only.
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','user')), rev INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions (
        digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS favorites (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, track_id TEXT NOT NULL,
        snapshot TEXT NOT NULL, added_at INTEGER NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY(user_id, track_id));
      CREATE INDEX IF NOT EXISTS favorites_order ON favorites(user_id, position);
      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS playlists_user ON playlists(user_id);
      CREATE TABLE IF NOT EXISTS saved_playlists (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        playlist_id TEXT NOT NULL, snapshot TEXT NOT NULL, added_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, playlist_id));
      CREATE INDEX IF NOT EXISTS saved_playlists_catalog ON saved_playlists(playlist_id);
      CREATE TABLE IF NOT EXISTS saved_albums (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        album_id TEXT NOT NULL, snapshot TEXT NOT NULL, added_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, album_id));
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, track_id TEXT NOT NULL,
        snapshot TEXT NOT NULL, added_at INTEGER NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY(playlist_id, track_id));
      CREATE INDEX IF NOT EXISTS playlist_tracks_order ON playlist_tracks(playlist_id, position);
      CREATE TABLE IF NOT EXISTS follows (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, artist_id TEXT NOT NULL,
        name TEXT NOT NULL, image_url TEXT NOT NULL, added_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, artist_id));
      CREATE TABLE IF NOT EXISTS imports (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, source TEXT NOT NULL,
        device_id TEXT NOT NULL, PRIMARY KEY(user_id, source, device_id));
      CREATE TABLE IF NOT EXISTS playlist_imports (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, source TEXT NOT NULL,
        local_id TEXT NOT NULL, playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        PRIMARY KEY(user_id, source, local_id));
      INSERT OR IGNORE INTO metadata VALUES ('schema_version', '1');
