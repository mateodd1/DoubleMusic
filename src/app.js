'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { ApiError, invalid, missing } = require('./errors');
const { json, readJson } = require('./http');
const { Auth } = require('./auth');
const { reference, object, LIMITS } = require('./models');
const { attachConnect } = require('./connect');
const { SourceRegistry, mapAsync } = require('./sources/registry');
const { LocalSource } = require('./sources/local');
const { audioOptions } = require('./media');
const version = require('../package.json').version;
const clientSpec = require('../docs/openapi.json');
const moduleSpec = require('../docs/module-openapi.json');
const PREFIX = '/api/v1';

function createApp({ store, catalog, media, sources = new SourceRegistry([new LocalSource(catalog, media)]), auth = new Auth(store), logger = console, publicUrl = process.env.PUBLIC_URL || '', connectOptions }) {
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PUBLIC_URL must be an HTTP(S) origin without a path or credentials.');
    publicUrl = url.origin;
  }
  const expose = value => {
    if (Array.isArray(value)) return value.map(expose);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      ['coverUrl', 'coverUrlHi', 'imageUrl', 'audioUrl'].includes(key) && typeof item === 'string' && item.startsWith('/api/v1/') ? publicUrl + item : expose(item)]));
  };
  const canonicalTrack = async raw => { reference(raw?.id); return sources.track(raw.id); };
  const canonicalTracks = async values => { if (!Array.isArray(values)) throw invalid('tracks must be an array.'); return mapAsync(values, canonicalTrack); };
  const canonicalPlaylist = async body => { object(body); return { ...body, tracks: await canonicalTracks(body.tracks === undefined ? [] : body.tracks) }; };
  const canonicalImport = async body => {
    if (body.playlists !== undefined && !Array.isArray(body.playlists)) throw invalid('playlists must be an array.');
    return { ...body, favorites: await canonicalTracks(body.favorites === undefined ? [] : body.favorites), playlists: await mapAsync(body.playlists || [], canonicalPlaylist) };
  };
  const paging = url => {
    const limit = Number(url.searchParams.get('limit') || 200), offset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0) throw invalid('limit: 1-500; offset: a nonnegative integer.');
    return { limit, offset };
  };
  const server = http.createServer({ requestTimeout: 60000, headersTimeout: 15000 }, async (req, res) => {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'private, no-store');
    try {
      const url = new URL(req.url, 'http://localhost'), path = url.pathname;
      const sourceId = url.searchParams.get('source') || url.searchParams.get('provider') || undefined;
      const send = (data, status = 200) => json(res, status, expose(data));
      const method = expected => { if (!expected.includes(req.method)) { res.setHeader('Allow', expected.join(', ')); throw new ApiError(405, 'METHOD_NOT_ALLOWED'); } };
      if (path === '/health') { method(['GET']); store.get('SELECT 1'); return send({ status: 'ok', apiVersion: 1, catalog: catalog?.lastScan || null }); }
      if (path === PREFIX || path === `${PREFIX}/`) {
        method(['GET']); return send({ name: 'DoubleMusic', version, apiVersion: 1, providers: sources.info().map(source => source.id), sources: sources.info(), defaultSource: sources.defaultSource, configuration: sources.configuration, authentication: ['bearer', 'cookie'], limits: LIMITS,
          capabilities: { modularSources: true, moduleApiVersion: 1, localFiles: sources.sources.has('local'), serverSideAudio: true, byteRanges: true, connect: true, lyrics: true, audioFormats: ['original', 'mp4', 'mp3'] },
          documentation: { client: publicUrl + `${PREFIX}/openapi.json`, modules: publicUrl + `${PREFIX}/modules/openapi.json` } });
      }
      if (path === `${PREFIX}/openapi.json` || path === `${PREFIX}/modules/openapi.json`) { method(['GET']); return send(path.endsWith('/modules/openapi.json') ? moduleSpec : clientSpec); }
      if (path === `${PREFIX}/auth/login`) { method(['POST']); return send(await auth.login(req, res, await readJson(req, 4096))); }
      if (path === `${PREFIX}/auth/logout`) { method(['POST']); return send(auth.logout(req, res)); }
      const artwork = new RegExp(`^${PREFIX}/catalog/artwork/([^/]+)$`).exec(path);
      // Clients load artwork as public images without session headers.
      if (artwork) { method(['GET', 'HEAD']); return await sources.artwork(req, res, decodeURIComponent(artwork[1])); }
      if (!path.startsWith(`${PREFIX}/`)) throw missing();
      const user = auth.authenticate(req);
      if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to use DoubleMusic.');
      const userId = user.id;
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
      // ---- Account administration: admin role only, using Bearer or cookie authentication.
      if (path === `${PREFIX}/admin/users` || path.startsWith(`${PREFIX}/admin/users/`)) {
        if (user.role !== 'admin') throw new ApiError(403, 'ADMIN_REQUIRED', 'Administrator access required.');
        if (path === `${PREFIX}/admin/users`) {
          if (req.method === 'GET') { method(['GET']); return send(store.adminList()); }
          method(['POST']);
          const body = await readJson(req, 4096);
          if (typeof body.username !== 'string') throw invalid('Username is required.');
          const role = body.role ?? 'user';
          if (!['user', 'admin'].includes(role)) throw invalid('The role must be "user" or "admin".');
          const { hashPassword } = require('./auth');
          const hash = await hashPassword(body.password);      // validate 8-1024 characters; otherwise return 400
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
          if (body.confirm !== username) throw new ApiError(400, 'CONFIRM_REQUIRED', `Send {"confirm":"${username}"} to confirm.`);
          if (target.id === userId) throw invalid('Administrators cannot delete their own accounts through the API.');
          if (!store.adminDelete(target.id).ok) throw missing();
          return send({ ok: true, deleted: username });
        }
        throw missing();
      }
      if (path === `${PREFIX}/library`) {
        method(['GET']);
        const rev = store.rev(userId), known = url.searchParams.get('rev');
        if (known !== null && !/^\d+$/.test(known)) throw invalid('rev must be a nonnegative integer.');
        const saved = store.savedPlaylists(userId);
        const savedPlaylists = await mapAsync(saved, async p => {
          try { const { tracks, ...current } = await sources.playlist(p.id); return { ...p, ...current, trackCount: tracks.length, available: true }; }
          catch { return { ...p, available: false }; }
        });
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
        const data = await sources.album(id);
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
        const p = await sources.playlist(id);
        return send(store.saveCatalogPlaylist(userId, { ...p, trackCount: p.tracks.length }));
      }
      if (path === `${PREFIX}/library/import`) { method(['POST']); return send(store.importLibrary(userId, await canonicalImport(await readJson(req, 5 * 1024 * 1024)))); }
      const favorite = new RegExp(`^${PREFIX}/library/favorites/([^/]+)$`).exec(path);
      if (favorite) {
        method(['PUT', 'DELETE']); const id = decodeURIComponent(favorite[1]);
        if (req.method === 'DELETE') return send(store.removeFavorite(userId, id));
        const body = await readJson(req);
        if (body.track?.id !== id) throw invalid('track.id must match the route.');
        return send(store.addFavorite(userId, await canonicalTrack(body.track)));
      }
      if (path === `${PREFIX}/library/playlists`) { method(['POST']); return send(store.createPlaylist(userId, await canonicalPlaylist(await readJson(req, 5 * 1024 * 1024))), 201); }
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
        method(['POST']); const body = await readJson(req, 5 * 1024 * 1024); return send(store.addTracks(userId, id, await canonicalTracks(body.tracks)));
      }
      if (path === `${PREFIX}/following`) { method(['GET']); return send({ rev: store.rev(userId), items: store.following(userId) }); }
      const followed = new RegExp(`^${PREFIX}/following/([^/]+)$`).exec(path);
      if (followed) {
        method(['PUT', 'DELETE']); const id = decodeURIComponent(followed[1]);
        if (req.method === 'DELETE') return send(store.unfollow(userId, id));
        await readJson(req, 8192);
        const artist = (await sources.artist(id)).artist;
        return send(store.follow(userId, id, { name: artist.name, imageUrl: artist.imageUrl }));
      }
      if (path === `${PREFIX}/sources` || path === `${PREFIX}/providers`) { method(['GET']); return send({ defaultSource: sources.defaultSource, configuration: sources.configuration, items: await sources.health() }); }
      if (path === `${PREFIX}/admin/scan`) {
        if (!catalog) throw new ApiError(404, 'LOCAL_SOURCE_DISABLED', 'No local library is configured.');
        if (user.role !== 'admin') throw new ApiError(403, 'ADMIN_REQUIRED');
        method(['GET', 'POST']);
        if (req.method === 'POST' && !catalog.scanning) {
          server.scanError = null;
          catalog.scan().catch(() => { server.scanError = 'Could not complete the scan.'; logger.error('[Catalog] Failed to update the index.'); });
        }
        return send({ scanning: !!catalog.scanning, lastScan: catalog.lastScan, error: server.scanError || null }, req.method === 'POST' ? 202 : 200);
      }
      if (path === `${PREFIX}/catalog/search`) { method(['GET']); const query = url.searchParams.get('q') || ''; if (query.length > 300) throw invalid('Search query is too long.'); return send(await sources.search(query, sourceId)); }
      if (path === `${PREFIX}/catalog/featured`) { method(['GET']); return send(await sources.featured(store.following(userId), sourceId)); }
      if (path === `${PREFIX}/catalog/daily` || path === `${PREFIX}/catalog/discovery`) { method(['GET']); return send(await sources.shelves(sourceId)); }
      const listing = new RegExp(`^${PREFIX}/catalog/(albums|artists|tracks|playlists)$`).exec(path);
      if (listing) { method(['GET']); const kind = listing[1], data = await sources.list(kind, paging(url), sourceId); return send({ ...data, [kind]: data.items }); }
      const resource = new RegExp(`^${PREFIX}/catalog/(albums|artists|playlists|tracks)/([^/]+)(?:/(tracks|motion|playlists))?$`).exec(path);
      if (resource) {
        method(['GET']); const [, kind, encoded, action] = resource, value = decodeURIComponent(encoded); reference(value);
        if (kind === 'albums' && !action) return send(await sources.album(value));
        if (kind === 'playlists' && !action) return send(await sources.playlist(value));
        if (kind === 'tracks') { if (action === 'motion') return send(await sources.motion(value)); if (!action) return send(await sources.track(value)); }
        if (kind === 'artists') {
          if (!action) return send(await sources.artist(value));
          if (action === 'tracks') { const data = await sources.artistTracks(value, paging(url)); return send({ ...data, tracks: data.items }); }
          if (action === 'playlists') return send(await sources.artistPlaylists(value));
        }
        throw missing();
      }
      if (path === `${PREFIX}/playback`) {
        method(['POST']); const body = await readJson(req, 8192); reference(body.trackId);
        const entry = await sources.track(body.trackId);
        const params = new URLSearchParams({ quality: body.quality || 'original', ...(body.format !== undefined ? { format: String(body.format) } : {}), ...(body.layout !== undefined ? { layout: String(body.layout) } : {}) });
        const options = audioOptions(params);
        return send({ trackId: body.trackId, audioUrl: `${PREFIX}/audio/${encodeURIComponent(body.trackId)}?${params}`, format: options.format,
          info: { codec: options.format === 'original' || (options.format === 'mp4' && options.quality === 'original' && ['aac', 'alac', 'flac', 'opus'].includes(entry.codec)) ? entry.codec : options.format === 'mp3' ? 'mp3' : 'aac', duration: entry.duration, provider: reference(body.trackId).provider } });
      }
      const audioOrLyrics = new RegExp(`^${PREFIX}/(audio|lyrics)/([^/]+)$`).exec(path);
      if (audioOrLyrics) {
        method(['GET', 'HEAD']); const value = decodeURIComponent(audioOrLyrics[2]); reference(value);
        if (audioOrLyrics[1] === 'audio') { audioOptions(url.searchParams); return await sources.audio(req, res, value, url.searchParams); }
        const lyrics = await sources.lyrics(value);
        if (lyrics === null) { res.statusCode = 204; return res.end(); }
        res.setHeader('Content-Type', 'application/ttml+xml; charset=utf-8'); res.setHeader('X-Lyrics-Source', reference(value).provider);
        res.setHeader('Content-Length', Buffer.byteLength(lyrics)); return res.end(req.method === 'HEAD' ? undefined : lyrics);
      }
      throw missing();
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof ApiError ? error.status : error instanceof URIError ? 400 : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500;
      if (status >= 500) logger.error(`[API] ${requestId} ${error.code || error.name}`);
      if (status === 413) res.setHeader('Connection', 'close');
      json(res, status, { error: error instanceof ApiError ? error.code : status === 400 ? 'INVALID_PATH' : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR',
        message: error instanceof ApiError ? error.message : 'Could not complete the request.', requestId, ...(error instanceof ApiError && error.details ? error.details : {}) });
    }
  });
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  const origins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(value => new URL(value.trim()).origin) : publicUrl ? [publicUrl] : [];
  server.connect = attachConnect(server, auth, { origins, publicUrl, ...connectOptions });
  return server;
}
module.exports = { createApp };
