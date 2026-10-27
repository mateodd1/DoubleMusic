'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { ApiError, invalid, missing } = require('./errors');
const { json, readJson } = require('./http');
const { Auth } = require('./auth');
const { reference, object, LIMITS } = require('./models');
const { attachConnect } = require('./connect');
const PREFIX = '/api/v1';

function createApp({ store, catalog, media, auth = new Auth(store), logger = console, publicUrl = process.env.PUBLIC_URL || '', connectOptions }) {
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PUBLIC_URL debe ser un origen HTTP(S), sin ruta ni credenciales.');
    publicUrl = url.origin;
  }
  const expose = value => {
    if (Array.isArray(value)) return value.map(expose);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      ['coverUrl', 'coverUrlHi', 'imageUrl', 'audioUrl'].includes(key) && typeof item === 'string' && item.startsWith('/api/v1/') ? publicUrl + item : expose(item)]));
  };
  const canonicalTrack = raw => { reference(raw?.id); return catalog.track(raw.id).public; };
  const canonicalTracks = values => { if (!Array.isArray(values)) throw invalid('tracks debe ser un array.'); return values.map(canonicalTrack); };
  const canonicalPlaylist = body => { object(body); return { ...body, tracks: canonicalTracks(body.tracks === undefined ? [] : body.tracks) }; };
  const canonicalImport = body => ({ ...body, favorites: canonicalTracks(body.favorites === undefined ? [] : body.favorites),
    playlists: body.playlists === undefined ? [] : Array.isArray(body.playlists) ? body.playlists.map(canonicalPlaylist) : (() => { throw invalid('playlists debe ser un array.'); })() });
  const page = (items, url) => {
    const limit = Number(url.searchParams.get('limit') || 200), offset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0) throw invalid('limit: 1–500; offset: entero no negativo.');
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  };
  const server = http.createServer({ requestTimeout: 60000, headersTimeout: 15000 }, async (req, res) => {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'private, no-store');
    try {
      const url = new URL(req.url, 'http://localhost'), path = url.pathname;
      const send = (data, status = 200) => json(res, status, expose(data));
      const method = expected => { if (!expected.includes(req.method)) { res.setHeader('Allow', expected.join(', ')); throw new ApiError(405, 'METHOD_NOT_ALLOWED'); } };
      if (path === '/health') { method(['GET']); store.get('SELECT 1'); return send({ status: 'ok', apiVersion: 1, catalog: catalog.lastScan }); }
      if (path === PREFIX || path === `${PREFIX}/`) {
        method(['GET']); return send({ name: 'DoubleMusic', version: '1.0.0', apiVersion: 1, providers: ['local'], authentication: ['bearer', 'cookie'], limits: LIMITS,
          capabilities: { localFiles: true, serverSideAudio: true, byteRanges: true, connect: true, lyrics: true, audioFormats: ['original', 'mp4', 'mp3'] } });
      }
      if (path === `${PREFIX}/auth/login`) { method(['POST']); return send(await auth.login(req, res, await readJson(req, 4096))); }
      if (path === `${PREFIX}/auth/logout`) { method(['POST']); return send(auth.logout(req, res)); }
      const artwork = new RegExp(`^${PREFIX}/catalog/artwork/([^/]+)$`).exec(path);
      // Los clientes cargan portadas sin su cabecera de sesión, como imágenes públicas.
      if (artwork) { method(['GET', 'HEAD']); return await media.artwork(req, res, decodeURIComponent(artwork[1])); }
      if (!path.startsWith(`${PREFIX}/`)) throw missing();
      const user = auth.authenticate(req);
      if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Inicia sesión para usar DoubleMusic.');
      const userId = user.id;
      const playlistIndex = async () => ({ playlists: catalog.playlistRows() });
      const catalogPlaylist = async value => catalog.playlist(value);
      if (path === `${PREFIX}/auth/me`) { method(['GET']); return send({ user: { id: user.id, username: user.username, role: user.role }, session: { expiresAt: user.expiresAt } }); }
      if (path === `${PREFIX}/auth/password`) {
        method(['PUT']);
        const body = await readJson(req, 4096);
        const { verifyPassword, hashPassword } = require('./auth');
        const row = store.get('SELECT hash FROM users WHERE id=?', userId);
        if (!await verifyPassword(body.currentPassword, row.hash)) throw new ApiError(403, 'INVALID_PASSWORD');
        const hash = await hashPassword(body.newPassword);
        store.transaction(() => {
          const current = store.get('SELECT hash FROM users WHERE id=?', userId);
          if (!current || current.hash !== row.hash) throw new ApiError(409, 'REVISION_CONFLICT');
          store.run('UPDATE users SET hash=? WHERE id=?', hash, userId);
          store.run('DELETE FROM sessions WHERE user_id=?', userId);
        });
        auth.cookie(req, res, '', 0);
        return send({ ok: true, loginRequired: true });
      }
      // ---- Administración de cuentas: solo el rol admin, Bearer o cookie.
      if (path === `${PREFIX}/admin/users` || path.startsWith(`${PREFIX}/admin/users/`)) {
        if (user.role !== 'admin') throw new ApiError(403, 'ADMIN_REQUIRED', 'Sección de administración.');
        if (path === `${PREFIX}/admin/users`) {
          if (req.method === 'GET') { method(['GET']); return send(store.adminList()); }
          method(['POST']);
          const body = await readJson(req, 4096);
          if (typeof body.username !== 'string') throw invalid('Falta el nombre de usuario.');
          const role = body.role ?? 'user';
          if (!['user', 'admin'].includes(role)) throw invalid('El rol debe ser "user" o "admin".');
          const { hashPassword } = require('./auth');
          const hash = await hashPassword(body.password);      // valida 8–1024 → 400
          return send(store.adminCreate(body.username, hash, role), 201);
        }
        const segs = path.slice(`${PREFIX}/admin/users/`.length).split('/');
        if (segs.length > 2 || !segs[0]) throw missing();
        const username = decodeURIComponent(segs[0]);
        const action = segs[1];
        const target = store.adminUser(username);
        if (!target) throw missing();
        if (action === 'password') {
          method(['POST']);
          const body = await readJson(req, 4096);
          const { hashPassword } = require('./auth');
          const hash = await hashPassword(body.password);
          return send(store.adminSetPassword(target.id, hash));
        }
        if (action === 'revoke') { method(['POST']); return send(store.adminRevoke(target.id)); }
        if (!action) {
          method(['DELETE']);
          const body = await readJson(req, 1024);
          if (body.confirm !== username) throw new ApiError(400, 'CONFIRM_REQUIRED', `Envía {"confirm":"${username}"} para confirmar.`);
          if (target.id === userId) throw invalid('Un administrador no puede borrar su propia cuenta desde la API.');
          if (!store.adminDelete(target.id).ok) throw missing();
          return send({ ok: true, deleted: username });
        }
        throw missing();
      }
      if (path === `${PREFIX}/library`) {
        method(['GET']);
        const rev = store.rev(userId), known = url.searchParams.get('rev');
        if (known !== null && !/^\d+$/.test(known)) throw invalid('rev debe ser un entero no negativo.');
        const saved = store.savedPlaylists(userId);
        const catalog = saved.length ? new Map((await playlistIndex()).playlists.map(p => [p.id, p])) : new Map();
        const savedPlaylists = saved.map(p => ({ ...p, ...(catalog.get(p.id) || {}), available: catalog.has(p.id) }));
        const catalogRev = crypto.createHash('sha256').update(JSON.stringify(savedPlaylists)).digest('hex').slice(0, 16);
        res.setHeader('ETag', `"${userId}:${rev}:${catalogRev}"`);
        if (known !== null && Number(known) === rev && (!saved.length || url.searchParams.get('catalogRev') === catalogRev)) return send(null, 304);
        return send({ ...store.library(userId), savedPlaylists, catalogRev });
      }
      const albumSave = new RegExp(`^${PREFIX}/library/saved-albums/([^/]+)$`).exec(path);
      if (albumSave) {
        method(['PUT', 'DELETE']); const id = decodeURIComponent(albumSave[1]);
        reference(id);
        if (req.method === 'DELETE') return send(store.unsaveAlbum(userId, id));
        if (req.headers['content-length'] || req.headers['transfer-encoding']) await readJson(req, 1024);
        if (store.get('SELECT 1 FROM saved_albums WHERE user_id=? AND album_id=?', userId, id)) return send({ rev: store.rev(userId) });
        const data = catalog.album(id);
        const trackCount = Array.isArray(data.tracks) ? data.tracks.length : data.trackCount || 0;
        return send(store.saveAlbum(userId, { ...data, trackCount }));
      }
      const catalogSave = new RegExp(`^${PREFIX}/library/saved-playlists/([^/]+)$`).exec(path);
      if (catalogSave) {
        method(['PUT', 'DELETE']); const id = decodeURIComponent(catalogSave[1]);
        reference(id);
        if (req.method === 'DELETE') return send(store.unsaveCatalogPlaylist(userId, id));
        if (req.headers['content-length'] || req.headers['transfer-encoding']) await readJson(req, 1024);
        if (store.get('SELECT 1 FROM saved_playlists WHERE user_id=? AND playlist_id=?', userId, id)) return send({ rev: store.rev(userId) });
        const p = await catalogPlaylist(id);
        return send(store.saveCatalogPlaylist(userId, { ...p, trackCount: p.tracks.length }));
      }
      if (path === `${PREFIX}/library/import`) { method(['POST']); return send(store.importLibrary(userId, canonicalImport(await readJson(req, 5 * 1024 * 1024)))); }
      const favorite = new RegExp(`^${PREFIX}/library/favorites/([^/]+)$`).exec(path);
      if (favorite) {
        method(['PUT', 'DELETE']); const id = decodeURIComponent(favorite[1]);
        if (req.method === 'DELETE') return send(store.removeFavorite(userId, id));
        const body = await readJson(req);
        if (body.track?.id !== id) throw invalid('track.id debe coincidir con la ruta.');
        return send(store.addFavorite(userId, canonicalTrack(body.track)));
      }
      if (path === `${PREFIX}/library/playlists`) { method(['POST']); return send(store.createPlaylist(userId, canonicalPlaylist(await readJson(req, 5 * 1024 * 1024))), 201); }
      const playlist = new RegExp(`^${PREFIX}/library/playlists/(u[A-Za-z0-9_-]{1,63})(?:/(tracks|order)(?:/([^/]+))?)?$`).exec(path);
      if (playlist) {
        const [, id, action, trackId] = playlist;
        if (!action) {
          method(['GET', 'PATCH', 'DELETE']);
          if (req.method === 'GET') return send({ rev: store.rev(userId), playlist: store.playlist(userId, id) });
          if (req.method === 'DELETE') return send(store.deletePlaylist(userId, id));
          return send(store.renamePlaylist(userId, id, await readJson(req, 4096)));
        }
        if (action === 'order' && !trackId) { method(['PUT']); return send(store.reorder(userId, id, await readJson(req))); }
        if (trackId) { method(['DELETE']); return send(store.removeTrack(userId, id, decodeURIComponent(trackId))); }
        method(['POST']); const body = await readJson(req, 5 * 1024 * 1024); return send(store.addTracks(userId, id, canonicalTracks(body.tracks)));
      }
      if (path === `${PREFIX}/following`) { method(['GET']); return send({ rev: store.rev(userId), items: store.following(userId) }); }
      const followed = new RegExp(`^${PREFIX}/following/([^/]+)$`).exec(path);
      if (followed) {
        method(['PUT', 'DELETE']); const id = decodeURIComponent(followed[1]);
        if (req.method === 'DELETE') return send(store.unfollow(userId, id));
        await readJson(req, 8192);
        const artist = catalog.artist(id).artist;
        return send(store.follow(userId, id, { name: artist.name, imageUrl: artist.imageUrl }));
      }
      if (path === `${PREFIX}/providers`) { method(['GET']); return send({ items: { local: { available: true } } }); }
      if (path === `${PREFIX}/admin/scan`) {
        if (user.role !== 'admin') throw new ApiError(403, 'ADMIN_REQUIRED');
        method(['GET', 'POST']);
        if (req.method === 'POST' && !catalog.scanning) {
          server.scanError = null;
          catalog.scan().catch(() => { server.scanError = 'No se pudo completar el escaneo.'; logger.error('[Catalog] Error al actualizar el índice.'); });
        }
        return send({ scanning: !!catalog.scanning, lastScan: catalog.lastScan, error: server.scanError || null }, req.method === 'POST' ? 202 : 200);
      }
      if (path === `${PREFIX}/catalog/search`) { method(['GET']); const query = url.searchParams.get('q') || ''; if (query.length > 300) throw invalid('Búsqueda demasiado larga.'); return send(catalog.search(query)); }
      if (path === `${PREFIX}/catalog/featured`) { method(['GET']); return send(catalog.featured(store.following(userId))); }
      if (path === `${PREFIX}/catalog/daily` || path === `${PREFIX}/catalog/discovery`) {
        method(['GET']); const items = catalog.playlistRows(); return send({ generatedAt: catalog.generatedAt, shelves: items.length ? [{ title: 'Playlists locales', items }] : [] });
      }
      if (path === `${PREFIX}/catalog/albums`) { method(['GET']); const data = page(catalog.albumRows(), url); return send({ ...data, albums: data.items }); }
      if (path === `${PREFIX}/catalog/artists`) { method(['GET']); const data = page([...catalog.artists.values()].sort((a, b) => a.name.localeCompare(b.name)), url); return send({ ...data, artists: data.items }); }
      if (path === `${PREFIX}/catalog/tracks`) { method(['GET']); const data = page([...catalog.tracks.values()].map(e => e.public), url); return send({ ...data, tracks: data.items }); }
      if (path === `${PREFIX}/catalog/playlists`) { method(['GET']); return send({ playlists: catalog.playlistRows() }); }
      const resource = new RegExp(`^${PREFIX}/catalog/(albums|artists|playlists|tracks)/([^/]+)(?:/(tracks|motion|playlists))?$`).exec(path);
      if (resource) {
        method(['GET']); const [, kind, encoded, action] = resource, value = decodeURIComponent(encoded); reference(value);
        if (kind === 'albums' && !action) return send(catalog.album(value));
        if (kind === 'playlists' && !action) return send(catalog.playlist(value));
        if (kind === 'tracks') { catalog.track(value); if (action === 'motion') return send({ id: value }); if (!action) return send(catalog.track(value).public); }
        if (kind === 'artists') {
          const data = catalog.artist(value);
          if (!action) return send(data);
          if (action === 'tracks') { const paged = page(data.tracks, url); return send({ ...paged, artist: data.artist, tracks: paged.items }); }
          if (action === 'playlists') return send({ artistId: value, status: 'empty', playlists: [] });
        }
        throw missing();
      }
      if (path === `${PREFIX}/playback`) {
        method(['POST']); const body = await readJson(req, 8192); reference(body.trackId);
        const entry = catalog.track(body.trackId);
        const params = new URLSearchParams({ quality: body.quality || 'original', ...(body.format ? { format: body.format } : {}), ...(body.layout ? { layout: String(body.layout) } : {}) });
        const options = media.options(params);
        return send({ trackId: body.trackId, audioUrl: `${PREFIX}/audio/${encodeURIComponent(body.trackId)}?${params}`, format: options.format,
          info: { codec: options.format === 'original' || (options.format === 'mp4' && options.quality === 'original' && ['aac', 'alac', 'flac', 'opus'].includes(entry.codec)) ? entry.codec : options.format === 'mp3' ? 'mp3' : 'aac', duration: entry.duration, provider: 'local' } });
      }
      const audioOrLyrics = new RegExp(`^${PREFIX}/(audio|lyrics)/([^/]+)$`).exec(path);
      if (audioOrLyrics) {
        method(['GET', 'HEAD']); const value = decodeURIComponent(audioOrLyrics[2]); reference(value);
        if (audioOrLyrics[1] === 'audio') return await media.audio(req, res, value, url.searchParams);
        const lyrics = await media.lyrics(value);
        if (lyrics === null) { res.statusCode = 204; return res.end(); }
        res.setHeader('Content-Type', 'application/ttml+xml; charset=utf-8'); res.setHeader('X-Lyrics-Source', 'local');
        res.setHeader('Content-Length', Buffer.byteLength(lyrics)); return res.end(req.method === 'HEAD' ? undefined : lyrics);
      }
      throw missing();
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof ApiError ? error.status : error instanceof URIError ? 400 : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500;
      if (status >= 500) logger.error(`[API] ${requestId} ${error.code || error.name}`);
      if (status === 413) res.setHeader('Connection', 'close');
      json(res, status, { error: error instanceof ApiError ? error.code : status === 400 ? 'INVALID_PATH' : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR',
        message: error instanceof ApiError ? error.message : 'No se pudo completar la solicitud.', requestId, ...(error instanceof ApiError && error.details ? error.details : {}) });
    }
  });
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  const origins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(value => new URL(value.trim()).origin) : publicUrl ? [publicUrl] : [];
  server.connect = attachConnect(server, auth, { origins, publicUrl, ...connectOptions });
  return server;
}
module.exports = { createApp };
