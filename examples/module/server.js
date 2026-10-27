'use strict';
// Reference module: generates its own audio and does not connect to a platform.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { LocalCatalog } = require('../../src/catalog');
const { LocalMedia, serveFile } = require('../../src/media');
const { json } = require('../../src/http');

function sampleWav() {
  const rate = 24000, samples = rate * 4, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 2500), 44 + i * 2);
  return bytes;
}
async function createExampleModule({ token, dataDir }) {
  if (!/^[A-Za-z0-9._~-]{16,512}$/.test(token)) throw new Error('Configure a valid module token.');
  const music = path.join(dataDir, 'music'); await fs.mkdir(music, { recursive: true });
  const file = path.join(music, 'demo.wav'); await fs.writeFile(file, sampleWav());
  const image = path.join(dataDir, 'cover.png');
  await fs.writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64'));
  const catalog = await new LocalCatalog({ root: music, dataDir: path.join(dataDir, 'index') }).init();
  const media = await new LocalMedia(catalog).init(), localTrackId = [...catalog.tracks.keys()][0];
  const artist = { id: 'artist-1', name: 'Sample artist', imageId: 'cover-1' };
  const track = { id: 'track-1', title: 'Sample audio', artist: artist.name, artistId: artist.id, artists: [artist], album: 'Sample album', albumId: 'album-1', duration: 4, track: 1, coverId: 'cover-1', codec: 'pcm_s16le', sampleRate: 24000 };
  const album = { id: 'album-1', title: track.album, artist: artist.name, artistId: artist.id, year: 2026, trackCount: 1, coverId: 'cover-1' };
  const playlist = { id: 'playlist-1', title: 'Sample playlist', trackCount: 1, coverId: 'cover-1' };
  const collections = { tracks: [track], albums: [album], artists: [artist], playlists: [playlist] };
  const lyrics = '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="4s">Sample audio</p></div></body></tt>';
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const received = Buffer.from(String(req.headers.authorization || '')), expected = Buffer.from('Bearer ' + token);
      if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return json(res, 401, { error: 'UNAUTHENTICATED' });
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); return json(res, 405, { error: 'METHOD_NOT_ALLOWED' }); }
      const url = new URL(req.url, 'http://localhost'), route = url.pathname.replace(/^\/module\/v1(?=\/|$)/, '');
      if (!url.pathname.startsWith('/module/v1')) return json(res, 404, { error: 'NOT_FOUND' });
      if (!route || route === '/') return json(res, 200, { apiVersion: 1, name: 'Reference module', capabilities: { browse: true, search: true, audio: true, artwork: true, lyrics: true } });
      if (route === '/catalog/featured') return json(res, 200, { albums: [album], artists: [artist], playlists: [playlist] });
      if (route === '/catalog/search') {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        return json(res, 200, Object.fromEntries(Object.entries(collections).map(([kind, items]) => [kind, items.filter(item => JSON.stringify(item).toLowerCase().includes(q))])));
      }
      const listing = /^\/catalog\/(tracks|albums|artists|playlists)$/.exec(route);
      if (listing || route === '/catalog/artists/artist-1/tracks') {
        const limit = Number(url.searchParams.get('limit') || 200), offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) return json(res, 400, { error: 'INVALID_PAGINATION' });
        const items = collections[listing?.[1] || 'tracks'];
        return json(res, 200, { items: items.slice(offset, offset + limit), total: items.length, limit, offset });
      }
      if (route === '/catalog/tracks/track-1') return json(res, 200, track);
      if (route === '/catalog/albums/album-1') return json(res, 200, { ...album, tracks: [track] });
      if (route === '/catalog/artists/artist-1') return json(res, 200, { artist, albums: [album], tracks: [track] });
      if (route === '/catalog/playlists/playlist-1') return json(res, 200, { ...playlist, tracks: [track] });
      if (route === '/audio/track-1') return await media.audio(req, res, localTrackId, url.searchParams);
      if (route === '/artwork/cover-1') return await serveFile(req, res, image, 'image/png');
      if (route === '/lyrics/track-1') {
        res.setHeader('Content-Type', 'application/ttml+xml'); res.setHeader('Content-Length', Buffer.byteLength(lyrics));
        return res.end(req.method === 'HEAD' ? undefined : lyrics);
      }
      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      return json(res, error.status || 500, { error: error.code || 'INTERNAL_ERROR' });
    }
  });
}
async function start() {
  const token = (await fs.readFile(process.env.MODULE_TOKEN_FILE, 'utf8')).trim();
  const server = await createExampleModule({ token, dataDir: process.env.MODULE_DATA_DIR || '/tmp/doublemusic-example-module' });
  server.listen(Number(process.env.MODULE_PORT || 4000), '0.0.0.0', () => console.log('[Reference module] Listening.'));
  const stop = () => server.close(() => process.exit(0)); process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
if (require.main === module) start().catch(() => { console.error('Could not start the reference module.'); process.exitCode = 1; });
module.exports = { createExampleModule };
