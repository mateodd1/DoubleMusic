'use strict';
const { invalid } = require('./errors');
const LIMITS = Object.freeze({ favorites: 5000, playlists: 200, savedPlaylists: 200, savedAlbums: 200, playlistTracks: 5000, following: 100 });
function reference(value) {
  if (typeof value !== 'string' || !/^local:[A-Za-z0-9_-]{1,120}$/.test(value)) throw invalid('El id debe pertenecer al catálogo local, por ejemplo local:t_0123456789.');
  return { provider: 'local', sourceId: value.slice(6) };
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Se espera un objeto JSON.');
  return value;
}
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw invalid('El nombre debe tener de 1 a 100 caracteres.');
  return value.trim();
}
function localImage(value) {
  if (!value) return '';
  if (typeof value !== 'string' || !/^\/api\/v1\/catalog\/artwork\/local%3A[a-zA-Z0-9_-]+$/.test(value)) throw invalid('La portada debe pertenecer al catálogo local.');
  return value;
}
function track(value) {
  object(value); reference(value.id);
  if (typeof value.title !== 'string' || !value.title.trim()) throw invalid('La pista necesita título.');
  const out = { id: value.id, provider: 'local', title: value.title.trim().slice(0, 300), duration: 0 };
  if (value.duration !== undefined) {
    if (typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration < 0) throw invalid('Duración inválida.');
    out.duration = value.duration;
  }
  for (const key of ['artist', 'album']) if (typeof value[key] === 'string') out[key] = value[key].trim().slice(0, 300);
  for (const key of ['artistId', 'albumId']) if (value[key]) { reference(value[key]); out[key] = value[key]; }
  for (const key of ['coverUrl', 'coverUrlHi']) if (value[key]) out[key] = localImage(value[key]);
  if (value.artists !== undefined) {
    if (!Array.isArray(value.artists) || value.artists.length > 10) throw invalid('Hasta 10 artistas por pista.');
    out.artists = value.artists.map(a => { object(a); if (a.id) reference(a.id); return { id: a.id || '', name: String(a.name || '').trim().slice(0, 300) }; });
  }
  return out;
}
function tracks(values = []) {
  if (!Array.isArray(values)) throw invalid('tracks/favorites debe ser un array.');
  return [...new Map(values.map(value => { const t = track(value); return [t.id, t]; })).values()];
}
module.exports = { LIMITS, reference, object, name, track, tracks, localImage };
