'use strict';

class LocalSource {
  constructor(catalog, media) {
    this.id = 'local'; this.name = 'Biblioteca local'; this.type = 'local';
    this.catalog = catalog; this.media = media;
  }
  async health() { return { available: true, capabilities: { browse: true, search: true, audio: true, artwork: true, lyrics: true } }; }
  async list(kind, { limit, offset }) {
    const items = kind === 'albums' ? this.catalog.albumRows()
      : kind === 'artists' ? [...this.catalog.artists.values()].sort((a, b) => a.name.localeCompare(b.name))
      : kind === 'tracks' ? [...this.catalog.tracks.values()].map(e => e.public) : this.catalog.playlistRows();
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  }
  async search(query) { return this.catalog.search(query); }
  async featured() { return this.catalog.featured(); }
  async track(id) { return this.catalog.track(id).public; }
  async album(id) { return this.catalog.album(id); }
  async artist(id) { return this.catalog.artist(id); }
  async artistTracks(id, { limit, offset }) {
    const data = this.catalog.artist(id);
    return { artist: data.artist, items: data.tracks.slice(offset, offset + limit), total: data.tracks.length, limit, offset };
  }
  async artistPlaylists(id) { this.catalog.artist(id); return { artistId: id, status: 'empty', playlists: [] }; }
  async playlist(id) { return this.catalog.playlist(id); }
  async motion(id) { this.catalog.track(id); return { id }; }
  audio(req, res, id, params) { return this.media.audio(req, res, id, params); }
  artwork(req, res, id) { return this.media.artwork(req, res, id); }
  lyrics(id) { return this.media.lyrics(id); }
}
module.exports = { LocalSource };
