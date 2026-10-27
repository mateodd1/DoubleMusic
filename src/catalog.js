'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { fs, path, inside, localFile, probe } = require('./files');
const { missing } = require('./errors');
const AUDIO = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.aiff', '.aif', '.wma', '.ape', '.alac', '.m4b', '.wv']);
const id = (kind, key) => `local:${kind}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
const art = value => `/api/v1/catalog/artwork/${encodeURIComponent(value)}`;
const fold = text => String(text).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const sort = (a, b) => String(a.title || a.name).localeCompare(String(b.title || b.name), 'es', { numeric: true });
const metadataText = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : fallback;

class LocalCatalog {
  constructor({ root = process.env.MUSIC_DIR || './music', dataDir = process.env.DATA_DIR || './data', logger = console } = {}) {
    this.root = path.resolve(root); this.dataDir = path.resolve(dataDir); this.logger = logger;
    this.entries = new Map(); this.tracks = new Map(); this.albums = new Map(); this.artists = new Map(); this.playlists = new Map();
    this.generatedAt = 0; this.scanning = null; this.lastScan = null;
  }
  async init() {
    this.root = await fs.realpath(this.root);
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    this.dataDir = await fs.realpath(this.dataDir);
    if (this.dataDir === this.root || inside(this.root, this.dataDir)) throw new Error('DATA_DIR debe estar fuera de MUSIC_DIR.');
    try {
      const cache = JSON.parse(await fs.readFile(path.join(this.dataDir, 'catalog.json'), 'utf8'));
      if (cache.version === 1 && cache.root === this.root) this.entries = new Map(cache.entries.map(e => [e.relative, e]));
    } catch { /* Primera indexación o caché incompleta. */ }
    await this.scan();
    return this;
  }
  scan() {
    if (this.scanning) return this.scanning;
    this.scanning = this.scanFiles().finally(() => { this.scanning = null; });
    return this.scanning;
  }
  async scanFiles() {
    const audio = [], lists = [];
    const walk = async directory => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (AUDIO.has(ext)) audio.push(file);
          else if (['.m3u', '.m3u8'].includes(ext)) lists.push(file);
        }
      }
    };
    await walk(this.root); audio.sort();
    const entries = new Map(), covers = new Map(); let cursor = 0, skipped = 0;
    const worker = async () => {
      while (cursor < audio.length) {
        const file = audio[cursor++];
        try {
          await localFile(this.root, file);
          const stat = await fs.stat(file), relative = path.relative(this.root, file);
          let entry = this.entries.get(relative);
          if (!entry || entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs) {
            const data = await probe(file), stream = data.streams?.find(s => s.codec_type === 'audio');
            if (!stream) { skipped++; continue; }
            const tags = Object.fromEntries(Object.entries({ ...data.format?.tags, ...stream.tags }).map(([k, v]) => [k.toLowerCase(), v]));
            const parent = path.dirname(relative), folders = parent.split(path.sep);
            entry = {
              relative, size: stat.size, mtimeMs: stat.mtimeMs,
              title: metadataText(tags.title, path.basename(file, path.extname(file))),
              artist: metadataText(tags.artist, folders.length > 1 ? folders.at(-2) : 'Artista desconocido'),
              albumArtist: metadataText(tags.album_artist || tags.albumartist, metadataText(tags.artist, folders.length > 1 ? folders.at(-2) : 'Artista desconocido')),
              album: metadataText(tags.album, parent === '.' ? 'Sin álbum' : folders.at(-1)),
              year: Number(String(tags.date || tags.year || '').slice(0, 4)) || 0,
              track: parseInt(tags.track, 10) || 0, disc: parseInt(tags.disc, 10) || 1,
              duration: Number(data.format?.duration || stream.duration) || 0,
              codec: String(stream.codec_name || ''), sampleRate: Number(stream.sample_rate) || 0,
              bitrate: Math.round(Number(stream.bit_rate || data.format?.bit_rate || 0) / 1000),
              embeddedCover: data.streams.some(s => s.codec_type === 'video' && s.disposition?.attached_pic),
            };
          }
          const directory = path.dirname(file);
          if (!covers.has(directory)) covers.set(directory, this.findCover(file));
          entries.set(relative, { ...entry, coverFile: await covers.get(directory) });
        } catch { skipped++; this.logger.warn('[Catalog] Se ha omitido un archivo no legible.'); }
      }
    };
    await Promise.all([worker(), worker()]);
    const tracks = new Map(), albums = new Map(), artists = new Map(), playlists = new Map();
    for (const entry of entries.values()) {
      const trackId = id('t', entry.relative);
      const artistId = id('r', fold(entry.artist));
      const albumArtistId = id('r', fold(entry.albumArtist));
      const albumId = id('a', `${fold(entry.albumArtist)}\0${fold(entry.album)}`);
      const coverUrl = entry.coverFile || entry.embeddedCover ? art(trackId) : '';
      const track = { id: trackId, provider: 'local', title: entry.title, artist: entry.artist, artistId, album: entry.album, albumId,
        artists: [{ id: artistId, name: entry.artist }], track: entry.track, disc: entry.disc, duration: entry.duration, coverUrl,
        codec: entry.codec, bitrate: entry.bitrate, sampleRate: entry.sampleRate };
      tracks.set(trackId, { ...entry, public: track });
      if (!artists.has(artistId)) artists.set(artistId, { id: artistId, provider: 'local', name: entry.artist, imageUrl: coverUrl });
      if (!artists.has(albumArtistId)) artists.set(albumArtistId, { id: albumArtistId, provider: 'local', name: entry.albumArtist, imageUrl: coverUrl });
      if (!albums.has(albumId)) albums.set(albumId, { id: albumId, provider: 'local', title: entry.album, artist: entry.albumArtist, artistId: albumArtistId, year: entry.year, coverUrl, tracks: [] });
      const album = albums.get(albumId); album.tracks.push(track);
      if (!album.coverUrl && coverUrl) album.coverUrl = coverUrl;
    }
    for (const album of albums.values()) { album.tracks.sort((a, b) => a.disc - b.disc || a.track - b.track || sort(a, b)); album.trackCount = album.tracks.length; }
    for (const file of lists) {
      try {
        await localFile(this.root, file);
        if ((await fs.stat(file)).size > 2 * 1024 * 1024) continue;
        const content = await fs.readFile(file, 'utf8'), values = new Map();
        for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim())) {
          if (!line || line.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(line)) continue;
          const target = path.resolve(path.dirname(file), line);
          const track = tracks.get(id('t', path.relative(this.root, target)))?.public;
          if (track) values.set(track.id, track);
        }
        const playlistId = id('p', path.relative(this.root, file)), items = [...values.values()];
        playlists.set(playlistId, { id: playlistId, provider: 'local', title: path.basename(file, path.extname(file)), tracks: items, trackCount: items.length, coverUrl: items.find(t => t.coverUrl)?.coverUrl || '' });
      } catch { skipped++; }
    }
    const generatedAt = Date.now();
    const temp = path.join(this.dataDir, `catalog-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, JSON.stringify({ version: 1, root: this.root, entries: [...entries.values()] }), { mode: 0o600 });
      await fs.rename(temp, path.join(this.dataDir, 'catalog.json'));
    } finally { await fs.rm(temp, { force: true }); }
    // Se publica una instantánea completa; las peticiones en curso conservan el índice anterior.
    Object.assign(this, { entries, tracks, albums, artists, playlists, generatedAt });
    this.lastScan = { tracks: tracks.size, albums: albums.size, artists: artists.size, playlists: playlists.size, skipped, generatedAt };
    return this.lastScan;
  }
  async findCover(file) {
    const directory = path.dirname(file);
    const names = new Map((await fs.readdir(directory)).map(name => [name.toLowerCase(), name]));
    for (const name of ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'front.png']) {
      if (!names.has(name)) continue;
      try { const cover = await localFile(this.root, path.join(directory, names.get(name))); return path.relative(this.root, cover); } catch { /* Se omiten enlaces fuera de la biblioteca. */ }
    }
    return '';
  }
  track(value) { const result = this.tracks.get(value); if (!result) throw missing(); return result; }
  album(value) { const result = this.albums.get(value); if (!result) throw missing(); return result; }
  playlist(value) { const result = this.playlists.get(value); if (!result) throw missing(); return result; }
  albumRows() { return [...this.albums.values()].map(({ tracks, ...album }) => album).sort(sort); }
  playlistRows() { return [...this.playlists.values()].map(({ tracks, ...playlist }) => playlist).sort(sort); }
  artist(value) {
    const artist = this.artists.get(value); if (!artist) throw missing();
    const tracks = [...this.tracks.values()].map(e => e.public).filter(t => t.artistId === value);
    const albums = this.albumRows().filter(a => a.artistId === value || tracks.some(t => t.albumId === a.id));
    return { artist, albums, singles: [], tracks, playlists: [], playlistsStatus: 'empty' };
  }
  search(query) {
    const terms = fold(query).trim().split(/\s+/).filter(Boolean);
    const matches = value => terms.every(term => fold(value).includes(term));
    if (!terms.length) return { tracks: [], albums: [], artists: [], playlists: [] };
    return {
      tracks: [...this.tracks.values()].map(e => e.public).filter(t => matches(`${t.title} ${t.artist} ${t.album}`)).slice(0, 200),
      albums: this.albumRows().filter(a => matches(`${a.title} ${a.artist}`)).slice(0, 200),
      artists: [...this.artists.values()].filter(a => matches(a.name)).sort(sort).slice(0, 200),
      playlists: this.playlistRows().filter(p => matches(p.title)).slice(0, 200),
    };
  }
  featured(following = []) {
    const followed = new Set(following.map(a => a.id)), albums = this.albumRows();
    return { albums: { title: 'Tu música', items: albums.slice(0, 200) }, artists: { title: 'Artistas locales', items: [...this.artists.values()].sort(sort).slice(0, 200) },
      playlists: { title: 'Playlists locales', items: this.playlistRows() }, pools: { title: 'Playlists locales', items: this.playlistRows() },
      followed: { title: 'Tus artistas', items: albums.filter(a => followed.has(a.artistId)) } };
  }
  async file(value) { return localFile(this.root, path.join(this.root, this.track(value).relative)); }
}
module.exports = { LocalCatalog, id };
