'use strict';
const { reference } = require('../models');
const { ApiError, invalid } = require('../errors');

class SourceRegistry {
  constructor(sources, defaultSource = sources.some(source => source.id === 'local') ? 'local' : sources[0]?.id) {
    if (!sources.length || sources.length > 16 || new Set(sources.map(s => s.id)).size !== sources.length) throw new Error('Configura entre 1 y 16 fuentes con ids únicos.');
    if (sources.some(source => source.id === 'all')) throw new Error('El id all se reserva para consultas agregadas.');
    this.sources = new Map(sources.map(source => [source.id, source]));
    if (!this.sources.has(defaultSource)) throw new Error('La fuente predeterminada no está configurada.');
    this.defaultSource = defaultSource;
  }
  info() { return [...this.sources.values()].map(({ id, name, type }) => ({ id, name, type })); }
  source(id) { const source = this.sources.get(id); if (!source) throw new ApiError(404, 'SOURCE_NOT_FOUND', 'La fuente no está configurada.'); return source; }
  resource(id) { return this.source(reference(id).provider); }
  selection(id) { return id === 'all' ? [...this.sources.values()] : [this.source(id || this.defaultSource)]; }
  async health() {
    return Object.fromEntries(await Promise.all([...this.sources.values()].map(async source => {
      try { return [source.id, { ...await source.health(), id: source.id, name: source.name, type: source.type }]; }
      catch { return [source.id, { id: source.id, name: source.name, type: source.type, available: false, error: 'SOURCE_UNAVAILABLE' }]; }
    })));
  }
  list(kind, paging, sourceId) {
    if (sourceId === 'all') throw invalid('Las listas paginadas requieren una fuente concreta; usa /sources para enumerarlas.');
    return this.source(sourceId || this.defaultSource).list(kind, paging);
  }
  async search(query, sourceId) {
    const result = { tracks: [], albums: [], artists: [], playlists: [], sources: [] };
    const responses = await Promise.all(this.selection(sourceId).map(async source => {
      try {
        return { source, data: await source.search(query) };
      } catch { return { source, data: null }; }
    }));
    for (const { source, data } of responses) {
      if (data) {
        for (const kind of ['tracks', 'albums', 'artists', 'playlists']) result[kind].push(...(data[kind] || []));
        result.sources.push({ id: source.id, available: true });
      } else result.sources.push({ id: source.id, available: false, error: 'SOURCE_UNAVAILABLE' });
    }
    for (const kind of ['tracks', 'albums', 'artists', 'playlists']) result[kind] = result[kind].slice(0, 200);
    return result;
  }
  async featured(following = [], sourceId) {
    const result = { albums: { title: 'Tu música', items: [] }, artists: { title: 'Artistas', items: [] }, playlists: { title: 'Playlists', items: [] }, sources: [] };
    const responses = await Promise.all(this.selection(sourceId).map(async source => {
      try { return { source, data: await source.featured() }; }
      catch { return { source, data: null }; }
    }));
    for (const { source, data } of responses) {
      if (data) {
        for (const kind of ['albums', 'artists', 'playlists']) result[kind].items.push(...(data[kind]?.items || []));
        result.sources.push({ id: source.id, available: true });
      } else result.sources.push({ id: source.id, available: false, error: 'SOURCE_UNAVAILABLE' });
    }
    for (const kind of ['albums', 'artists', 'playlists']) result[kind].items = result[kind].items.slice(0, 200);
    result.pools = result.playlists;
    const ids = new Set(following.map(artist => artist.id));
    result.followed = { title: 'Tus artistas', items: result.albums.items.filter(album => ids.has(album.artistId)) };
    return result;
  }
  async shelves(sourceId) {
    const data = await this.featured([], sourceId);
    return { generatedAt: Date.now(), shelves: data.playlists.items.length ? [{ title: 'Playlists', items: data.playlists.items }] : [], sources: data.sources };
  }
  track(id) { return this.resource(id).track(id); }
  album(id) { return this.resource(id).album(id); }
  artist(id) { return this.resource(id).artist(id); }
  artistTracks(id, paging) { return this.resource(id).artistTracks(id, paging); }
  artistPlaylists(id) { return this.resource(id).artistPlaylists(id); }
  playlist(id) { return this.resource(id).playlist(id); }
  motion(id) { return this.resource(id).motion(id); }
  audio(req, res, id, params) { return this.resource(id).audio(req, res, id, params); }
  artwork(req, res, id) { return this.resource(id).artwork(req, res, id); }
  lyrics(id) { return this.resource(id).lyrics(id); }
}

async function mapAsync(values, fn, concurrency = 4) {
  const result = new Array(values.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) { const index = cursor++; result[index] = await fn(values[index]); }
  }));
  return result;
}
module.exports = { SourceRegistry, mapAsync };
