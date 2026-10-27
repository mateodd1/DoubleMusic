'use strict';
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { randomUUID } = require('node:crypto');
const { ApiError, invalid, missing, limit } = require('./errors');
const model = require('./models');

class Store {
  constructor(file = process.env.CORE_DB || require('node:path').join(process.env.DATA_DIR || './data', 'core.sqlite')) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.statements = new Map();
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
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
      INSERT OR IGNORE INTO metadata VALUES ('schema_version', '1');`);
    if (this.get('SELECT value FROM metadata WHERE key=?', 'schema_version').value !== '1') throw new Error('CORE_SCHEMA_UNSUPPORTED');
  }
  statement(sql) {
    if (!this.statements.has(sql)) this.statements.set(sql, this.db.prepare(sql));
    return this.statements.get(sql);
  }
  get(sql, ...args) { return this.statement(sql).get(...args); }
  all(sql, ...args) { return this.statement(sql).all(...args); }
  run(sql, ...args) { return this.statement(sql).run(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) {
      // SQLite can roll back automatically after SQLITE_FULL or an I/O error.
      // Preserve the original failure if no transaction remains to roll back.
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }
  close() { this.db.close(); }
  rev(userId) {
    const user = this.get('SELECT rev FROM users WHERE id=?', userId);
    if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Inicia sesión.');
    return user.rev;
  }
  change(userId, fn) {
    return this.transaction(() => {
      this.rev(userId);
      const { changed = false, ...out } = fn();
      if (changed) this.run('UPDATE users SET rev=rev+1 WHERE id=?', userId);
      return { ...out, rev: this.rev(userId) };
    });
  }
  createUser(username, hash, role = 'user') {
    if (!/^[A-Za-z0-9_.-]{4,64}$/.test(username) || !['user', 'admin'].includes(role)) throw invalid('Usuario inválido: 4–64 caracteres, letras, números, ._-');
    if (this.get('SELECT id FROM users WHERE username=?', username)) throw new ApiError(409, 'USERNAME_TAKEN');
    const id = randomUUID();
    this.run('INSERT INTO users (id, username, hash, role) VALUES (?,?,?,?)', id, username, hash, role);
    return { id, username, role };
  }
  publicUser(user) { return { id: user.id, username: user.username, role: user.role }; }
  following(userId) {
    return this.all('SELECT artist_id AS id, name, image_url AS imageUrl, added_at AS addedAt FROM follows WHERE user_id=? ORDER BY added_at DESC, artist_id', userId)
      .map(row => ({ ...row, provider: model.reference(row.id).provider }));
  }
  rows(userId) {
    return this.all(`SELECT p.id, p.name, p.created_at AS createdAt, p.updated_at AS updatedAt,
      (SELECT count(*) FROM playlist_tracks WHERE playlist_id=p.id) AS trackCount,
      COALESCE((SELECT json_extract(snapshot, '$.coverUrl') FROM playlist_tracks WHERE playlist_id=p.id ORDER BY position LIMIT 1),'') AS coverUrl
      FROM playlists p WHERE user_id=? ORDER BY created_at, p.id`, userId);
  }
  library(userId) {
    return { rev: this.rev(userId),
      favorites: this.all('SELECT snapshot, added_at FROM favorites WHERE user_id=? ORDER BY position', userId).map(this.saved),
      playlists: this.rows(userId), savedPlaylists: this.savedPlaylists(userId), savedAlbums: this.savedAlbums(userId), following: this.following(userId) };
  }
  savedAlbums(userId) {
    return this.all('SELECT snapshot, added_at FROM saved_albums WHERE user_id=? ORDER BY added_at DESC, album_id', userId)
      .map(a => ({ ...JSON.parse(a.snapshot), addedAt: a.added_at }));
  }
  saveAlbum(userId, album) {
    const { id, title, artist, artistId, year, coverUrl, trackCount } = album;
    model.reference(id);
    return this.change(userId, () => {
      if (this.get('SELECT 1 FROM saved_albums WHERE user_id=? AND album_id=?', userId, id)) return {};
      if (this.get('SELECT count(*) AS n FROM saved_albums WHERE user_id=?', userId).n >= model.LIMITS.savedAlbums) throw limit();
      this.run('INSERT INTO saved_albums VALUES (?,?,?,?)', userId, id, JSON.stringify({ id, title, artist, artistId, year, coverUrl, trackCount }), Date.now());
      return { changed: true };
    });
  }
  unsaveAlbum(userId, id) {
    model.reference(id);
    return this.change(userId, () => ({ changed: this.run('DELETE FROM saved_albums WHERE user_id=? AND album_id=?', userId, id).changes > 0 }));
  }
  savedPlaylists(userId) {
    return this.all('SELECT snapshot, added_at FROM saved_playlists WHERE user_id=? ORDER BY added_at DESC, playlist_id', userId)
      .map(p => ({ ...JSON.parse(p.snapshot), addedAt: p.added_at }));
  }
  saveCatalogPlaylist(userId, playlist) {
    const { id, title, coverUrl, trackCount, sourceTrackCount, unavailableTrackCount, indexedAt, collection } = playlist;
    model.reference(id);
    const snapshot = { id, title, coverUrl, trackCount, sourceTrackCount, unavailableTrackCount, indexedAt, collection };
    return this.change(userId, () => {
      if (this.get('SELECT 1 FROM saved_playlists WHERE user_id=? AND playlist_id=?', userId, id)) return {};
      if (this.get('SELECT count(*) AS n FROM saved_playlists WHERE user_id=?', userId).n >= model.LIMITS.savedPlaylists) throw limit();
      this.run('INSERT INTO saved_playlists VALUES (?,?,?,?)', userId, id, JSON.stringify(snapshot), Date.now());
      return { changed: true };
    });
  }
  unsaveCatalogPlaylist(userId, id) {
    model.reference(id);
    return this.change(userId, () => ({ changed: this.run('DELETE FROM saved_playlists WHERE user_id=? AND playlist_id=?', userId, id).changes > 0 }));
  }
  saved(row) { return { track: JSON.parse(row.snapshot), addedAt: row.added_at }; }
  owned(userId, id) {
    const row = this.get('SELECT * FROM playlists WHERE id=? AND user_id=?', id, userId);
    if (!row) throw missing();
    return row;
  }
  playlist(userId, id) {
    const p = this.owned(userId, id);
    return { id: p.id, name: p.name, createdAt: p.created_at, updatedAt: p.updated_at,
      tracks: this.all('SELECT snapshot, added_at FROM playlist_tracks WHERE playlist_id=? ORDER BY position', id).map(this.saved) };
  }
  addFavorite(userId, raw) {
    const t = model.track(raw);
    return this.change(userId, () => {
      const existing = this.get('SELECT added_at FROM favorites WHERE user_id=? AND track_id=?', userId, t.id);
      if (existing) return { addedAt: existing.added_at };
      if (this.get('SELECT count(*) AS n FROM favorites WHERE user_id=?', userId).n >= model.LIMITS.favorites) throw limit();
      const at = Date.now();
      const position = this.get('SELECT COALESCE(min(position),0)-1 AS p FROM favorites WHERE user_id=?', userId).p;
      this.run('INSERT INTO favorites VALUES (?,?,?,?,?)', userId, t.id, JSON.stringify(t), at, position);
      return { changed: true, addedAt: at };
    });
  }
  removeFavorite(userId, id) {
    model.reference(id);
    return this.change(userId, () => ({ changed: this.run('DELETE FROM favorites WHERE user_id=? AND track_id=?', userId, id).changes > 0 }));
  }
  insertTracks(playlistId, values, enforceLimit = true, at = Date.now()) {
    const existing = this.all('SELECT track_id FROM playlist_tracks WHERE playlist_id=?', playlistId);
    const known = new Set(existing.map(row => row.track_id));
    const incoming = values.filter(t => !known.has(t.id));
    if (enforceLimit && incoming.length && existing.length + incoming.length > model.LIMITS.playlistTracks) throw limit();
    let position = this.get('SELECT COALESCE(max(position),-1)+1 AS p FROM playlist_tracks WHERE playlist_id=?', playlistId).p;
    for (const t of incoming) this.run('INSERT INTO playlist_tracks VALUES (?,?,?,?,?)', playlistId, t.id, JSON.stringify(t), at, position++);
    return incoming.length;
  }
  createPlaylist(userId, body) {
    model.object(body);
    const name = model.name(body.name), values = model.tracks(body.tracks);
    if (values.length > model.LIMITS.playlistTracks) throw limit();
    return this.change(userId, () => {
      if (this.get('SELECT count(*) AS n FROM playlists WHERE user_id=?', userId).n >= model.LIMITS.playlists) throw limit();
      const id = `u${randomUUID().replaceAll('-', '')}`, at = Date.now();
      this.run('INSERT INTO playlists VALUES (?,?,?,?,?)', id, userId, name, at, at);
      this.insertTracks(id, values);
      return { changed: true, playlist: this.playlist(userId, id) };
    });
  }
  renamePlaylist(userId, id, body) {
    const name = model.name(body.name);
    return this.change(userId, () => {
      const p = this.owned(userId, id), changed = p.name !== name;
      if (changed) this.run('UPDATE playlists SET name=?, updated_at=? WHERE id=?', name, Math.max(Date.now(), p.updated_at + 1), id);
      return { changed, playlist: this.rows(userId).find(p => p.id === id) };
    });
  }
  deletePlaylist(userId, id) {
    return this.change(userId, () => { this.owned(userId, id); this.run('DELETE FROM playlists WHERE id=?', id); return { changed: true }; });
  }
  addTracks(userId, id, values) {
    if (!Array.isArray(values)) throw invalid('tracks debe ser un array.');
    const incoming = model.tracks(values);
    return this.change(userId, () => {
      this.owned(userId, id);
      const added = this.insertTracks(id, incoming);
      if (added) this.bumpPlaylist(id);
      return { changed: added > 0, added };
    });
  }
  removeTrack(userId, id, trackId) {
    model.reference(trackId);
    return this.change(userId, () => {
      this.owned(userId, id);
      const changed = this.run('DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?', id, trackId).changes > 0;
      if (changed) this.bumpPlaylist(id);
      return { changed };
    });
  }
  bumpPlaylist(id) { this.run('UPDATE playlists SET updated_at=max(?,updated_at+1) WHERE id=?', Date.now(), id); }
  reorder(userId, id, body) {
    return this.change(userId, () => {
      this.owned(userId, id);
      if (body.expectedRev !== undefined && body.expectedRev !== this.rev(userId)) throw new ApiError(409, 'REVISION_CONFLICT', 'Recarga la biblioteca antes de ordenar.', { playlist: this.playlist(userId, id) });
      const current = this.all('SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY position', id).map(row => row.track_id);
      const values = body.trackIds, known = new Set(current);
      if (!Array.isArray(values) || values.length !== current.length || new Set(values).size !== values.length || values.some(id => !known.has(id))) {
        throw new ApiError(409, 'ORDER_MISMATCH', 'La lista de pistas ha cambiado.', { playlist: this.playlist(userId, id) });
      }
      const changed = values.some((id, i) => id !== current[i]);
      if (changed) {
        for (let i = 0; i < values.length; i++) this.run('UPDATE playlist_tracks SET position=? WHERE playlist_id=? AND track_id=?', i, id, values[i]);
        this.bumpPlaylist(id);
      }
      return { changed };
    });
  }
  follow(userId, id, body) {
    model.reference(id); model.object(body);
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 300) throw invalid('El artista necesita nombre.');
    const name = body.name.trim(), image = typeof body.imageUrl === 'string' ? body.imageUrl : '';
    if (image) model.localImage(image);
    return this.change(userId, () => {
      const old = this.get('SELECT * FROM follows WHERE user_id=? AND artist_id=?', userId, id);
      if (!old && this.get('SELECT count(*) AS n FROM follows WHERE user_id=?', userId).n >= model.LIMITS.following) throw limit();
      const changed = !old || old.name !== name || old.image_url !== image;
      if (changed) this.run('INSERT INTO follows VALUES (?,?,?,?,?) ON CONFLICT(user_id,artist_id) DO UPDATE SET name=excluded.name,image_url=excluded.image_url', userId, id, name, image, old?.added_at || Date.now());
      return { changed, entry: this.following(userId).find(a => a.id === id) };
    });
  }
  unfollow(userId, id) {
    model.reference(id);
    return this.change(userId, () => ({ changed: this.run('DELETE FROM follows WHERE user_id=? AND artist_id=?', userId, id).changes > 0 }));
  }
  importLibrary(userId, body) {
    model.object(body);
    if (!['ios', 'android', 'web'].includes(body.source) || typeof body.deviceId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(body.deviceId)) throw invalid('source o deviceId inválidos.');
    if (this.get('SELECT 1 FROM imports WHERE user_id=? AND source=? AND device_id=?', userId, body.source, body.deviceId)) return { rev: this.rev(userId), alreadyImported: true, favoritesAdded: 0, playlistsCreated: 0 };
    const favorites = model.tracks(body.favorites);
    if (body.playlists !== undefined && !Array.isArray(body.playlists)) throw invalid('playlists debe ser un array.');
    const ids = new Set();
    const playlists = (body.playlists || []).map(p => {
      model.object(p);
      if (typeof p.id !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(p.id) || ids.has(p.id)) throw invalid('Ids locales de playlists inválidos o repetidos.');
      ids.add(p.id);
      return { id: p.id, name: model.name(p.name), tracks: model.tracks(p.tracks) };
    });
    return this.change(userId, () => {
      // Rechecked inside the transaction for independent core processes.
      if (this.get('SELECT 1 FROM imports WHERE user_id=? AND source=? AND device_id=?', userId, body.source, body.deviceId)) return { alreadyImported: true, favoritesAdded: 0, playlistsCreated: 0 };
      const known = new Set(this.all('SELECT track_id FROM favorites WHERE user_id=?', userId).map(row => row.track_id));
      const incoming = favorites.filter(t => !known.has(t.id));
      if (incoming.length && known.size + incoming.length > model.LIMITS.favorites) throw limit();
      let position = this.get('SELECT COALESCE(max(position),-1)+1 AS p FROM favorites WHERE user_id=?', userId).p;
      const at = Date.now();
      for (const t of incoming) this.run('INSERT INTO favorites VALUES (?,?,?,?,?)', userId, t.id, JSON.stringify(t), at, position++);
      let created = 0;
      for (const local of playlists) {
        let existing = this.get('SELECT playlist_id FROM playlist_imports WHERE user_id=? AND source=? AND local_id=?', userId, body.source, local.id);
        if (!existing) {
          if (this.get('SELECT count(*) AS n FROM playlists WHERE user_id=?', userId).n >= model.LIMITS.playlists) throw limit();
          const id = `u${randomUUID().replaceAll('-', '')}`;
          this.run('INSERT INTO playlists VALUES (?,?,?,?,?)', id, userId, local.name, at, at);
          this.run('INSERT INTO playlist_imports VALUES (?,?,?,?)', userId, body.source, local.id, id);
          existing = { playlist_id: id }; created++;
        }
        if (this.insertTracks(existing.playlist_id, local.tracks)) this.bumpPlaylist(existing.playlist_id);
      }
      this.run('INSERT INTO imports VALUES (?,?,?)', userId, body.source, body.deviceId);
      return { changed: true, alreadyImported: false, favoritesAdded: incoming.length, playlistsCreated: created };
    });
  }
  // ---- Administración de cuentas (solo rol 'admin'; se comprueba en app.js) ----
  adminList() {
    return { items: this.all(`SELECT u.id, u.username, u.role,
      (SELECT count(*) FROM sessions s WHERE s.user_id=u.id) AS sessions,
      (SELECT count(*) FROM favorites f WHERE f.user_id=u.id) AS favorites,
      (SELECT count(*) FROM playlists p WHERE p.user_id=u.id) AS playlists
      FROM users u ORDER BY u.username COLLATE NOCASE`) };
  }
  adminUser(username) {
    return this.get('SELECT id, username, role FROM users WHERE username=?', username);
  }
  adminCreate(username, hash, role) {
    return { user: this.createUser(username, hash, role) };
  }
  adminSetPassword(userId, hash) {
    return this.transaction(() => {
      const sessionsRevoked = this.run('DELETE FROM sessions WHERE user_id=?', userId).changes;
      this.run('UPDATE users SET hash=? WHERE id=?', hash, userId);
      return { ok: true, sessionsRevoked };
    });
  }
  adminRevoke(userId) {
    return { ok: true, sessionsRevoked: this.run('DELETE FROM sessions WHERE user_id=?', userId).changes };
  }
  adminDelete(userId) {
    // Un solo statement: ON DELETE CASCADE retira sesiones, favoritos,
    // playlists (y sus pistas), seguidos y marcas de importación.
    return { ok: this.run('DELETE FROM users WHERE id=?', userId).changes > 0 };
  }
}
module.exports = { Store };
