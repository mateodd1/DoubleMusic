'use strict';
const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');
const { reference } = require('../models');
const { ApiError } = require('../errors');
const RAW_ID = /^[A-Za-z0-9_-]{1,120}$/;
const unavailable = () => new ApiError(503, 'SOURCE_UNAVAILABLE', 'El módulo no está disponible.');
const malformed = () => new ApiError(502, 'SOURCE_INVALID_RESPONSE', 'El módulo no cumple el contrato de la API.');
const failed = status => status === 404 ? new ApiError(404, 'NOT_FOUND', 'No existe ese recurso.') : status === 422 ? new ApiError(422, 'AUDIO_NOT_SUPPORTED', 'El módulo no admite ese formato de audio.') : unavailable();
const text = (value, fallback = '') => typeof value === 'string' ? value.trim().slice(0, 300) : fallback;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const array = (value, max = 5000) => { if (!Array.isArray(value) || value.length > max) throw malformed(); return value; };

class HttpSource {
  constructor({ id, name = id, origin, token, timeoutMs = 15000 }) {
    this.id = id; this.name = name; this.type = 'http'; this.origin = new URL(origin); this.token = token; this.timeoutMs = timeoutMs;
    if (!['http:', 'https:'].includes(this.origin.protocol) || this.origin.username || this.origin.password || this.origin.pathname !== '/' || this.origin.search || this.origin.hash) throw new Error('El origen del módulo debe ser HTTP(S), sin rutas ni credenciales.');
    if (!/^[A-Za-z0-9._~-]{16,512}$/.test(token)) throw new Error('El token del módulo debe tener entre 16 y 512 caracteres seguros.');
  }
  full(id) { if (typeof id !== 'string' || !RAW_ID.test(id)) throw malformed(); return `${this.id}:${id}`; }
  raw(id) { const ref = reference(id); if (ref.provider !== this.id) throw malformed(); return ref.sourceId; }
  image(id) { return id ? `/api/v1/catalog/artwork/${encodeURIComponent(this.full(id))}` : ''; }
  artistModel(raw) {
    if (!raw || !text(raw.name)) throw malformed();
    return { id: this.full(raw.id), provider: this.id, name: text(raw.name), imageUrl: this.image(raw.imageId) };
  }
  trackModel(raw) {
    if (!raw || !text(raw.title)) throw malformed();
    return { id: this.full(raw.id), provider: this.id, title: text(raw.title), duration: number(raw.duration), artist: text(raw.artist), artistId: raw.artistId ? this.full(raw.artistId) : '',
      album: text(raw.album), albumId: raw.albumId ? this.full(raw.albumId) : '', track: number(raw.track), disc: number(raw.disc), coverUrl: this.image(raw.coverId),
      artists: raw.artists === undefined ? [] : array(raw.artists, 10).map(a => this.artistModel(a)),
      codec: text(raw.codec), bitrate: number(raw.bitrate), sampleRate: number(raw.sampleRate) };
  }
  albumModel(raw) {
    if (!raw || !text(raw.title)) throw malformed();
    return { id: this.full(raw.id), provider: this.id, title: text(raw.title), artist: text(raw.artist), artistId: raw.artistId ? this.full(raw.artistId) : '',
      year: number(raw.year), trackCount: number(raw.trackCount), coverUrl: this.image(raw.coverId),
      ...(raw.tracks === undefined ? {} : { tracks: array(raw.tracks).map(t => this.trackModel(t)) }) };
  }
  playlistModel(raw) {
    if (!raw || !text(raw.title)) throw malformed();
    return { id: this.full(raw.id), provider: this.id, title: text(raw.title), trackCount: number(raw.trackCount), coverUrl: this.image(raw.coverId),
      ...(raw.tracks === undefined ? {} : { tracks: array(raw.tracks).map(t => this.trackModel(t)) }) };
  }
  model(kind, raw) { return this[`${{ tracks: 'track', albums: 'album', artists: 'artist', playlists: 'playlist' }[kind]}Model`](raw); }
  url(route, params = {}) {
    const url = new URL('/module/v1' + route, this.origin);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    return url;
  }
  async request(route, params, { timeoutMs = this.timeoutMs, maxBytes = 8 * 1024 * 1024, binary = false } = {}) {
    if (route !== '/') await this.manifest();
    let response;
    try { response = await fetch(this.url(route, params), { headers: { Authorization: `Bearer ${this.token}` }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw unavailable(); }
    if (response.status === 204) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw failed(response.status); }
    const chunks = []; let size = 0;
    try {
      for await (const chunk of response.body) { size += chunk.length; if (size > maxBytes) throw malformed(); chunks.push(chunk); }
    } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(); }
    const bytes = Buffer.concat(chunks);
    if (binary) return bytes.toString('utf8');
    try { const data = JSON.parse(bytes.toString('utf8')); if (!data || typeof data !== 'object' || Array.isArray(data)) throw malformed(); return data; }
    catch { throw malformed(); }
  }
  async manifest(refresh = false) {
    if (!refresh && this.manifestCache && this.manifestCache.expires > Date.now()) return this.manifestCache.data;
    if (this.manifestPending) return this.manifestPending;
    const pending = (async () => {
      const data = await this.request('/', {}, { timeoutMs: 5000, maxBytes: 16384 });
      if (data?.apiVersion !== 1 || !text(data.name) || !data.capabilities || typeof data.capabilities !== 'object'
        || ['browse', 'search', 'audio', 'artwork', 'lyrics'].some(key => typeof data.capabilities[key] !== 'boolean')) throw malformed();
      const capabilities = Object.fromEntries(['browse', 'search', 'audio', 'artwork', 'lyrics'].map(key => [key, data.capabilities[key] === true]));
      const result = { available: true, capabilities };
      this.manifestCache = { data: result, expires: Date.now() + 30000 };
      return result;
    })().finally(() => { this.manifestPending = null; });
    this.manifestPending = pending;
    return pending;
  }
  async health() { return this.manifest(true); }
  async list(kind, paging) {
    const data = await this.request(`/catalog/${kind}`, paging);
    const items = array(data?.items, paging.limit).map(item => this.model(kind, item));
    if (!Number.isSafeInteger(data.total) || data.total < 0 || data.total < paging.offset + items.length && items.length) throw malformed();
    return { items, total: data.total, ...paging };
  }
  async search(q) {
    const data = await this.request('/catalog/search', { q });
    return Object.fromEntries(['tracks', 'albums', 'artists', 'playlists'].map(kind => [kind, array(data?.[kind] || [], 200).map(item => this.model(kind, item))]));
  }
  async featured() {
    const data = await this.request('/catalog/featured');
    return Object.fromEntries(['albums', 'artists', 'playlists'].map(kind => [kind, { title: this.name, items: array(data?.[kind] || [], 200).map(item => this.model(kind, item)) }]));
  }
  async track(id) { const data = this.trackModel(await this.request(`/catalog/tracks/${this.raw(id)}`)); if (data.id !== id) throw malformed(); return data; }
  async album(id) { const data = this.albumModel(await this.request(`/catalog/albums/${this.raw(id)}`)); if (data.id !== id || !data.tracks) throw malformed(); return data; }
  async playlist(id) { const data = this.playlistModel(await this.request(`/catalog/playlists/${this.raw(id)}`)); if (data.id !== id || !data.tracks) throw malformed(); return data; }
  async artist(id) {
    const data = await this.request(`/catalog/artists/${this.raw(id)}`), artist = this.artistModel(data?.artist);
    if (artist.id !== id) throw malformed();
    return { artist, albums: array(data.albums || []).map(a => this.albumModel(a)), singles: [], tracks: array(data.tracks || []).map(t => this.trackModel(t)), playlists: [], playlistsStatus: 'empty' };
  }
  async artistTracks(id, paging) {
    const data = await this.request(`/catalog/artists/${this.raw(id)}/tracks`, paging);
    if (!Number.isSafeInteger(data?.total) || data.total < 0) throw malformed();
    return { items: array(data.items, paging.limit).map(t => this.trackModel(t)), total: data.total, ...paging };
  }
  async artistPlaylists(id) { await this.artist(id); return { artistId: id, status: 'empty', playlists: [] }; }
  async motion(id) { await this.track(id); return { id }; }
  async lyrics(id) { return this.request(`/lyrics/${this.raw(id)}`, {}, { binary: true, maxBytes: 2 * 1024 * 1024 }); }
  audio(req, res, id, params) {
    const allowed = {};
    for (const key of ['quality', 'format', 'layout', 'spatial']) if (params.has(key)) allowed[key] = params.get(key);
    return this.stream(req, res, `/audio/${this.raw(id)}`, allowed, false);
  }
  artwork(req, res, id) { return this.stream(req, res, `/artwork/${this.raw(id)}`, {}, true); }
  async stream(req, res, route, params, artwork) {
    await this.manifest();
    const url = this.url(route, params), client = url.protocol === 'https:' ? https : http;
    const headers = { Authorization: `Bearer ${this.token}`, 'Accept-Encoding': 'identity' };
    for (const key of ['range', 'if-range', 'if-none-match', 'if-modified-since']) if (req.headers[key]) headers[key] = req.headers[key];
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => { if (settled) return; settled = true; req.removeListener('aborted', abort); res.removeListener('close', abort); error ? reject(error) : resolve(); };
      const upstream = client.request(url, { method: req.method, headers }, response => {
        const status = response.statusCode;
        if (![200, 206, 304, 416].includes(status)) { response.destroy(); finish(failed(status)); return; }
        const type = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
        if ([200, 206].includes(status) && !(artwork ? /^image\/(jpeg|png|webp|gif|avif)$/.test(type) : /^audio\//.test(type) || type === 'application/ogg' || type === 'video/mp4')) {
          response.destroy(); finish(malformed()); return;
        }
        res.statusCode = status;
        const allowed = new Set(['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'x-audio-codec', 'x-audio-bitrate', 'x-audio-sample-rate', 'x-audio-duration']);
        for (const [name, value] of Object.entries(response.headers)) if (allowed.has(name) && value !== undefined) res.setHeader(name, value);
        pipeline(response, res).then(() => finish(), () => { if (res.headersSent) res.destroy(); finish(unavailable()); });
      });
      const abort = () => { upstream.destroy(); finish(); };
      req.once('aborted', abort); res.once('close', abort);
      upstream.setTimeout(300000, () => upstream.destroy());
      upstream.once('error', () => finish(unavailable()));
      upstream.end();
    });
  }
}
module.exports = { HttpSource };
