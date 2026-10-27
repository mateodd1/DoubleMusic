'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { fs, path, run, probe } = require('../src/files');
const { Store } = require('../src/database');
const { Auth, hashPassword } = require('../src/auth');
const { LocalCatalog } = require('../src/catalog');
const { LocalMedia } = require('../src/media');
const { createApp } = require('../src/app');

async function fixture(t, { empty = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doublemusic-'));
  const root = path.join(directory, 'music'), dataDir = path.join(directory, 'data'), albumDir = path.join(root, 'Artista', 'Disco');
  await fs.mkdir(albumDir, { recursive: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  if (!empty) {
    await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=13', '-c:a', 'flac', '-metadata', 'title=Canción uno', '-metadata', 'artist=Músico', '-metadata', 'album=Álbum local', '-metadata', 'date=2026', '-metadata', 'track=1/2', path.join(albumDir, '01.flac')]);
    await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-c:a', 'libmp3lame', '-metadata', 'title=Segundo tema', '-metadata', 'artist=Músico', '-metadata', 'album=Álbum local', '-metadata', 'track=2/2', path.join(albumDir, '02.mp3')]);
    await fs.writeFile(path.join(root, 'Selección.m3u8'), '#EXTM3U\nArtista/Disco/01.flac\nArtista/Disco/02.mp3\nhttps://unreachable.example.test/audio\n../../outside.flac\n');
    await fs.writeFile(path.join(albumDir, '01.lrc'), '[offset:100]\n[00:00.00]Primera & línea\n[00:04.00][00:08.00]Estribillo\n');
    await fs.writeFile(path.join(albumDir, 'cover.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64'));
    await fs.writeFile(path.join(directory, 'secret.txt'), 'private-outside-library');
    await fs.symlink(directory, path.join(root, 'outside-dir'));
    await fs.symlink(path.join(directory, 'secret.txt'), path.join(albumDir, 'outside.mp3'));
    await fs.writeFile(path.join(albumDir, 'fake.mp3'), '#EXTM3U\nhttps://unreachable.example.test/audio');
  }
  const logger = { warn() {}, error() {} };
  const catalog = await new LocalCatalog({ root, dataDir, logger }).init();
  const media = await new LocalMedia(catalog).init();
  const store = new Store(path.join(dataDir, 'test.sqlite'));
  const hash = await hashPassword('local-test-password');
  store.createUser('alice', hash, 'admin'); store.createUser('bobby', hash);
  const auth = new Auth(store);
  const server = createApp({ store, catalog, media, auth, logger, publicUrl: 'https://music.example.test' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.connect.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { token, method = 'GET', body, headers = {} } = {}) => fetch(base + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = async username => { const res = await request('/api/v1/auth/login', { method: 'POST', body: { username, password: 'local-test-password', transport: 'bearer' } }); assert.equal(res.status, 200); return (await res.json()).session.token; };
  return { directory, root, dataDir, albumDir, catalog, media, store, server, request, login };
}

test('API local completa, con archivos reales y sin servicios de red', async t => {
  const f = await fixture(t), token = await f.login('alice'), other = await f.login('bobby');
  const tracks = [...f.catalog.tracks.values()].map(e => e.public).sort((a, b) => a.track - b.track), [song, second] = tracks;
  const audio = `/api/v1/audio/${encodeURIComponent(song.id)}`;
  const get = route => f.request(route, { token });
  const send = (route, method, body, who = token) => f.request(route, { method, body, token: who });

  await t.test('indexa tags, ids estables y playlists locales; omite enlaces y falsos audios', async () => {
    assert.equal(tracks.length, 2); assert.equal(f.catalog.albums.size, 1); assert.equal(song.title, 'Canción uno');
    assert.equal(song.artist, 'Músico'); assert.equal(song.duration, 13); assert.match(song.id, /^local:t_/);
    assert.equal(f.catalog.lastScan.skipped, 1);
    const list = [...f.catalog.playlists.values()][0]; assert.equal(list.tracks.length, 2);
    const fresh = await new LocalCatalog({ root: f.root, dataDir: f.dataDir, logger: { warn() {} } }).init();
    assert.deepEqual([...fresh.tracks.keys()].sort(), tracks.map(t => t.id).sort());
  });
  await t.test('catálogo móvil, búsquedas sin tildes y URLs del servidor configurado', async () => {
    const result = await (await get('/api/v1/catalog/search?q=cancion%20musico')).json(); assert.equal(result.tracks.length, 1);
    assert.equal(result.tracks[0].id, song.id); assert.match(result.tracks[0].coverUrl, /^https:\/\/music\.example\.test\/api\/v1\/catalog\/artwork\//);
    const album = await (await get(`/api/v1/catalog/albums/${encodeURIComponent(song.albumId)}`)).json(); assert.deepEqual(album.tracks.map(t => t.id), tracks.map(t => t.id));
    const artist = await (await get(`/api/v1/catalog/artists/${encodeURIComponent(song.artistId)}`)).json(); assert.equal(artist.tracks.length, 2);
    const rows = await (await get('/api/v1/catalog/tracks?limit=1&offset=1')).json(); assert.equal(rows.total, 2); assert.equal(rows.tracks.length, 1);
    assert.equal((await get('/api/v1/catalog/tracks?limit=0')).status, 400);
    const featured = await (await get('/api/v1/catalog/featured')).json(); assert.equal(featured.albums.items.length, 1);
    assert.equal((await get(`/api/v1/catalog/tracks/${encodeURIComponent(song.id)}/motion`)).status, 200);
  });
  await t.test('exige sesión en catálogo, audio y letras', async () => {
    for (const route of ['/api/v1/catalog/featured', audio, `/api/v1/lyrics/${encodeURIComponent(song.id)}`]) assert.equal((await f.request(route)).status, 401);
    assert.equal((await f.request('/health')).status, 200);
    const login = await f.request('/api/v1/auth/login', { method: 'POST', body: { username: 'alice', password: 'bad-password' } }); assert.equal(login.status, 401);
  });
  await t.test('sirve archivo original idéntico y rangos de bytes para seek', async () => {
    const expected = await fs.readFile(path.join(f.albumDir, '01.flac'));
    const full = await get(audio); assert.equal(full.status, 200); assert.equal(full.headers.get('content-type'), 'audio/flac'); assert.deepEqual(Buffer.from(await full.arrayBuffer()), expected);
    const partial = await f.request(audio, { token, headers: { Range: 'bytes=40-139' } }); assert.equal(partial.status, 206); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), expected.subarray(40, 140));
    const tail = await f.request(audio, { token, headers: { Range: 'bytes=-10' } }); assert.equal(tail.status, 206); assert.deepEqual(Buffer.from(await tail.arrayBuffer()), expected.subarray(-10));
    for (const range of ['bytes=999999999-', 'bytes=10-2', 'bytes=-0', 'bytes=0-1,2-3', 'bytes=-']) {
      const res = await f.request(audio, { token, headers: { Range: range } }); assert.equal(res.status, 416); assert.equal(res.headers.get('content-range'), `bytes */${expected.length}`);
    }
    const head = await f.request(audio, { token, method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(expected.length)); assert.equal((await head.text()).length, 0);
  });
  await t.test('genera fMP4 AAC con índice sidx, duración y seek coherente', async () => {
    const route = audio + '?quality=192&layout=2';
    const res = await get(route); assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'audio/mp4'); assert.equal(res.headers.get('x-audio-codec'), 'aac');
    const data = Buffer.from(await res.arrayBuffer()); assert.ok(data.includes(Buffer.from('sidx'))); assert.ok(data.includes(Buffer.from('moof')));
    const file = path.join(f.directory, 'output.mp4'); await fs.writeFile(file, data);
    const parsed = await probe(file); assert.equal(parsed.streams[0].codec_name, 'aac'); assert.ok(Number(parsed.format.duration) >= 13);
    const head = await f.request(route, { token, method: 'HEAD' }); const etag = head.headers.get('etag');
    const partial = await f.request(route, { token, headers: { Range: 'bytes=200-399', 'If-Range': etag } }); assert.equal(partial.status, 206); assert.equal(partial.headers.get('etag'), etag); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), data.subarray(200, 400));
    const conditional = await f.request(route, { token, headers: { 'If-None-Match': etag } }); assert.equal(conditional.status, 304);
    const descriptor = await (await send('/api/v1/playback', 'POST', { trackId: song.id, quality: '192', layout: 2 })).json(); assert.equal(descriptor.info.codec, 'aac'); assert.match(descriptor.audioUrl, /^https:\/\/music\.example\.test\/api\/v1\/audio\//);
  });
  await t.test('preserva FLAC en fMP4 original y convierte MP3 para clientes fMP4', async () => {
    for (const [track, codec] of [[song, 'flac'], [second, 'aac']]) {
      const res = await get(`/api/v1/audio/${encodeURIComponent(track.id)}?quality=original&layout=2`); assert.equal(res.status, 200);
      const file = path.join(f.directory, `${codec}.mp4`); await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
      const data = await probe(file); assert.equal(data.streams[0].codec_name, codec);
      const bytes = await fs.readFile(file); assert.ok(bytes.includes(Buffer.from('sidx')));
    }
  });
  await t.test('ofrece MP3 convertido y rechaza opciones inválidas', async () => {
    const res = await get(audio + '?quality=128&format=mp3'); assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    const file = path.join(f.directory, 'output.mp3'); await fs.writeFile(file, Buffer.from(await res.arrayBuffer())); assert.equal((await probe(file)).streams[0].codec_name, 'mp3');
    for (const query of ['quality=bogus', 'layout=3', 'format=http', 'quality=128&format=original']) assert.equal((await get(audio + '?' + query)).status, 400);
  });
  await t.test('portadas públicas locales y letras LRC convertidas a TTML', async () => {
    const cover = await f.request(song.coverUrl); assert.equal(cover.status, 200); assert.equal(cover.headers.get('content-type'), 'image/png');
    const res = await get(`/api/v1/lyrics/${encodeURIComponent(song.id)}`); assert.equal(res.status, 200); assert.equal(res.headers.get('x-lyrics-source'), 'local');
    const lyrics = await res.text(); assert.match(lyrics, /Primera &amp; línea/); assert.match(lyrics, /begin="0.1s"/); assert.match(lyrics, /begin="8.1s"/);
    assert.equal((await get(`/api/v1/lyrics/${encodeURIComponent(second.id)}`)).status, 204);
  });
  await t.test('favoritos canónicos, aislamiento entre usuarios y revisiones idempotentes', async () => {
    const route = `/api/v1/library/favorites/${encodeURIComponent(song.id)}`;
    const first = await (await send(route, 'PUT', { track: { id: song.id, title: 'Texto inyectado', coverUrl: 'https://outside.example.test/pixel' } })).json();
    const duplicate = await (await send(route, 'PUT', { track: song })).json(); assert.equal(first.rev, duplicate.rev);
    const library = await (await get('/api/v1/library')).json(); assert.equal(library.favorites[0].track.title, song.title);
    const isolated = await (await f.request('/api/v1/library', { token: other })).json(); assert.deepEqual(isolated.favorites, []);
    assert.equal((await get(`/api/v1/library?rev=${library.rev}`)).status, 304);
    const reopened = new Store(path.join(f.dataDir, 'test.sqlite'));
    assert.equal(reopened.library(f.store.adminUser('alice').id).favorites[0].track.id, song.id); reopened.close();
  });
  await t.test('playlists propias, orden, ownership y guardado de álbumes y M3U', async () => {
    const created = await (await send('/api/v1/library/playlists', 'POST', { name: 'Mis canciones', tracks })).json(), playlist = created.playlist;
    const route = `/api/v1/library/playlists/${playlist.id}`;
    assert.equal((await f.request(route, { token: other })).status, 404);
    const conflict = await send(route + '/order', 'PUT', { trackIds: [song.id] }); assert.equal(conflict.status, 409);
    assert.equal((await send(route + '/order', 'PUT', { trackIds: [second.id, song.id] })).status, 200);
    assert.equal((await (await get(route)).json()).playlist.tracks[0].track.id, second.id);
    assert.equal((await send(route, 'PATCH', { name: 'Renombrada' })).status, 200);
    assert.equal((await send(`/api/v1/library/saved-albums/${encodeURIComponent(song.albumId)}`, 'PUT', {})).status, 200);
    const localList = [...f.catalog.playlists.keys()][0]; assert.equal((await send(`/api/v1/library/saved-playlists/${encodeURIComponent(localList)}`, 'PUT', {})).status, 200);
    const library = await (await get('/api/v1/library')).json(); assert.equal(library.savedAlbums.length, 1); assert.equal(library.savedPlaylists[0].available, true);
    assert.equal((await send(route + '/tracks/' + encodeURIComponent(song.id), 'DELETE')).status, 200);
    assert.equal((await send(route, 'DELETE')).status, 200);
  });
  await t.test('seguidos y administración sin aceptar imágenes remotas', async () => {
    assert.equal((await send(`/api/v1/following/${encodeURIComponent(song.artistId)}`, 'PUT', { name: 'injected', imageUrl: 'https://outside.example.test/pixel' })).status, 200);
    const result = await (await get('/api/v1/following')).json(); assert.equal(result.items[0].name, song.artist);
    assert.equal((await f.request('/api/v1/admin/users', { token: other })).status, 403);
    assert.equal((await get('/api/v1/admin/users')).status, 200);
    assert.equal((await send('/api/v1/admin/scan', 'POST', undefined, other)).status, 403);
    assert.equal((await get('/api/v1/admin/scan')).status, 200);
  });
  await t.test('entradas de biblioteca inválidas devuelven 400 y el import es idempotente', async () => {
    for (const body of [{ name: 'Inválida', tracks: 'no-array' }, { name: 'Inválida', tracks: null }]) assert.equal((await send('/api/v1/library/playlists', 'POST', body)).status, 400);
    assert.equal((await send('/api/v1/library/import', 'POST', { source: 'ios', deviceId: 'test-device', playlists: [null] })).status, 400);
    const body = { source: 'ios', deviceId: 'test-device', favorites: [{ id: second.id }], playlists: [{ id: 'old-list', name: 'Importada', tracks: [{ id: song.id }] }] };
    const first = await (await send('/api/v1/library/import', 'POST', body)).json(); assert.equal(first.favoritesAdded, 1); assert.equal(first.playlistsCreated, 1);
    const duplicate = await (await send('/api/v1/library/import', 'POST', body)).json(); assert.equal(duplicate.alreadyImported, true); assert.equal(duplicate.rev, first.rev);
  });
  await t.test('crear cuentas, cambiar contraseña y revocar sesiones por API', async () => {
    const created = await send('/api/v1/admin/users', 'POST', { username: 'carol', password: 'new-local-password' }); assert.equal(created.status, 201);
    const login = await f.request('/api/v1/auth/login', { method: 'POST', body: { username: 'carol', password: 'new-local-password', transport: 'bearer' } });
    const carol = (await login.json()).session.token;
    assert.equal((await send('/api/v1/auth/password', 'PUT', { currentPassword: 'wrong-password', newPassword: 'changed-local-password' }, carol)).status, 403);
    assert.equal((await send('/api/v1/auth/password', 'PUT', { currentPassword: 'new-local-password', newPassword: 'changed-local-password' }, carol)).status, 200);
    assert.equal((await f.request('/api/v1/auth/me', { token: carol })).status, 401);
    assert.equal((await send('/api/v1/admin/users/carol', 'DELETE', { confirm: 'carol' })).status, 200);
    assert.equal((await send('/api/v1/admin/users/alice', 'DELETE', { confirm: 'alice' })).status, 400);
  });
  await t.test('escaneo atómico, cambios de tags y eliminación de archivos', async () => {
    const before = song.id;
    await fs.unlink(path.join(f.albumDir, '02.mp3'));
    await f.catalog.scan(); assert.equal(f.catalog.tracks.size, 1); assert.equal(f.catalog.track(before).public.title, song.title);
    assert.equal((await get(`/api/v1/audio/${encodeURIComponent(second.id)}`)).status, 404);
    assert.equal([...f.catalog.playlists.values()][0].trackCount, 1);
  });
  await t.test('bloquea traversal y sustitución por un enlace a un archivo externo', async () => {
    for (const route of ['/api/v1/audio/local%3A..%2Fsecret', '/api/v1/audio/https%3A%2F%2Foutside.example.test', '/api/v1/catalog/albums/local%3A..%2Fsecret']) assert.equal((await get(route)).status, 400);
    await fs.unlink(path.join(f.albumDir, '01.flac')); await fs.symlink(path.join(f.directory, 'secret.txt'), path.join(f.albumDir, '01.flac'));
    const res = await get(audio); assert.equal(res.status, 404); assert.ok(!(await res.text()).includes('private-outside-library'));
  });
  await t.test('logout revoca el token también para audio', async () => {
    assert.equal((await send('/api/v1/auth/logout', 'POST')).status, 200); assert.equal((await get('/api/v1/library')).status, 401);
  });
});

test('biblioteca vacía utilizable y persistencia de cuentas', async t => {
  const f = await fixture(t, { empty: true }), token = await f.login('alice');
  assert.equal(f.catalog.tracks.size, 0); assert.equal((await f.request('/api/v1/catalog/featured', { token })).status, 200);
  const data = await (await f.request('/api/v1/catalog/daily', { token })).json(); assert.deepEqual(data.shelves, []);
  const reopened = new Store(path.join(f.dataDir, 'test.sqlite'));
  assert.equal(reopened.get('SELECT count(*) AS n FROM users').n, 2); reopened.close();
});

test('portadas incrustadas, letras TTML y texto, y escaneo administrativo asíncrono', async t => {
  const f = await fixture(t, { empty: true });
  await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'mjpeg', '-frames:v', '1', '-disposition:v', 'attached_pic', '-t', '1', path.join(f.root, 'embedded.mp3')]);
  await f.catalog.scan();
  const entry = [...f.catalog.tracks.values()][0], token = await f.login('alice');
  assert.equal(entry.embeddedCover, true);
  const image = await f.request(entry.public.coverUrl); assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.ok((await image.arrayBuffer()).byteLength > 0);
  await fs.writeFile(path.join(f.root, 'embedded.txt'), 'Texto sin tiempo & símbolos');
  let lyrics = await (await f.request(`/api/v1/lyrics/${encodeURIComponent(entry.public.id)}`, { token })).text(); assert.match(lyrics, /Texto sin tiempo &amp; símbolos/); assert.ok(!lyrics.includes('begin='));
  const ttml = '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="1s">Local</p></div></body></tt>';
  await fs.writeFile(path.join(f.root, 'embedded.ttml'), ttml);
  lyrics = await (await f.request(`/api/v1/lyrics/${encodeURIComponent(entry.public.id)}`, { token })).text(); assert.equal(lyrics, ttml);
  const scan = await f.request('/api/v1/admin/scan', { method: 'POST', token }); assert.equal(scan.status, 202);
  if (f.catalog.scanning) await f.catalog.scanning;
  const status = await (await f.request('/api/v1/admin/scan', { token })).json(); assert.equal(status.scanning, false); assert.equal(status.lastScan.tracks, 1);
});
