'use strict';
const { apiOrigin } = require('./runtime');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createExampleModule } = require('../examples/module/server');
const { HttpSource } = require('../src/sources/http');
const { SourceRegistry } = require('../src/sources/registry');
const { LocalSource } = require('../src/sources/local');
const { loadSources } = require('../src/sources/config');
const { LocalCatalog } = require('../src/catalog');
const { LocalMedia } = require('../src/media');
const { Store } = require('../src/database');
const { hashPassword } = require('../src/auth');
const { createApp } = require('../src/app');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doublemusic-modules-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const moduleToken = 'module-only-secret-1234567890';
  const module = await createExampleModule({ token: moduleToken, dataDir: path.join(directory, 'module') });
  const original = module.listeners('request')[0], requests = [];
  const state = { mode: 'normal' };
  module.removeAllListeners('request');
  module.on('request', (req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    res.setHeader('Set-Cookie', 'module-private=never-forward');
    res.setHeader('X-Private-Config', moduleToken);
    if (state.mode === 'down') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: moduleToken, privateOrigin: 'http://private.example.test' })); }
    if (state.mode === 'bad-id' && req.url === '/module/v1/catalog/tracks/track-1') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: 'https://outside.example.test/track', title: 'Invalid' })); }
    if (state.mode === 'redirect' && req.url.startsWith('/module/v1/audio/')) { res.writeHead(302, { Location: 'http://outside.example.test/secret' }); return res.end(); }
    if (state.mode === 'html' && req.url.startsWith('/module/v1/artwork/')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<script>bad()</script>'); }
    if (state.mode === 'slow' && req.url === '/module/v1/catalog/tracks/track-1') { const timer = setTimeout(() => res.end('{}'), 200); res.once('close', () => clearTimeout(timer)); return; }
    return original(req, res);
  });
  await new Promise(resolve => module.listen(0, '127.0.0.1', resolve));
  t.after(async () => { module.closeAllConnections(); await new Promise(resolve => module.close(resolve)); });
  const origin = `http://127.0.0.1:${module.address().port}`;
  const personal = new HttpSource({ id: 'personal', name: 'My module', origin, token: moduleToken });
  const other = new HttpSource({ id: 'other', name: 'Another module', origin, token: moduleToken });
  const music = path.join(directory, 'music'); await fs.mkdir(music);
  const catalog = await new LocalCatalog({ root: music, dataDir: path.join(directory, 'index') }).init();
  const media = await new LocalMedia(catalog).init();
  const sources = new SourceRegistry([new LocalSource(catalog, media), personal, other], 'local');
  const store = new Store(path.join(directory, 'core.sqlite')), hash = await hashPassword('module-client-password');
  store.createUser('alice', hash); store.createUser('bobby', hash);
  const server = createApp({ store, catalog, sources, publicUrl: 'https://music.example.test', logger: { error() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.connect.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = await apiOrigin(t, server, store, 'https://music.example.test');
  const request = (route, { token, method = 'GET', body, headers = {} } = {}) => fetch(base + route, { method, headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = async username => { const res = await request('/api/v1/auth/login', { method: 'POST', body: { username, password: 'module-client-password', transport: 'bearer' } }); assert.equal(res.status, 200); return (await res.json()).session.token; };
  return { directory, sources, catalog, personal, origin, moduleToken, state, requests, request, login };
}

test('module contract: platform-independent HTTP example and core', async t => {
  const f = await fixture(t), token = await f.login('alice'), other = await f.login('bobby');
  const get = route => f.request(route, { token });
  const send = (route, method, body) => f.request(route, { token, method, body });
  await t.test('public discovery and OpenAPI without private module data', async () => {
    const root = await (await f.request('/api/v1')).json(); assert.equal(root.capabilities.modularSources, true); assert.deepEqual(root.providers, ['local', 'personal', 'other']);
    assert.equal(root.defaultSource, 'local');
    for (const route of ['/api/v1/openapi.json', '/api/v1/modules/openapi.json']) {
      const res = await f.request(route); assert.equal(res.status, 200);
      const spec = await res.json(); assert.equal(spec.openapi, '3.0.3'); assert.ok(Object.keys(spec.paths).length >= 15);
      const walk = value => { if (!value || typeof value !== 'object') return; if (value.$ref) assert.ok(spec.components.schemas[value.$ref.split('/').at(-1)]); Object.values(value).forEach(walk); }; walk(spec);
    }
    const res = await get('/api/v1/sources'), body = await res.text();
    assert.ok(!body.includes(f.moduleToken)); assert.ok(!body.includes(f.origin));
    const sources = JSON.parse(body); assert.equal(sources.items.personal.available, true); assert.equal(sources.items.personal.capabilities.audio, true);
  });
  await t.test('per-source catalogs and collision-free IDs', async () => {
    const local = await (await get('/api/v1/catalog/tracks')).json(); assert.equal(local.total, 0);
    const page = await (await get('/api/v1/catalog/tracks?source=personal&limit=1')).json(); assert.equal(page.total, 1); assert.equal(page.tracks[0].id, 'personal:track-1');
    const search = await (await get('/api/v1/catalog/search?q=sample&source=all')).json(); assert.deepEqual(search.tracks.map(t => t.id).sort(), ['other:track-1', 'personal:track-1']);
    const selected = await (await get('/api/v1/catalog/search?q=sample&source=personal')).json(); assert.equal(selected.tracks.length, 1);
    assert.equal((await get('/api/v1/catalog/tracks?source=unconfigured')).status, 404);
    assert.equal((await get('/api/v1/catalog/tracks?source=all')).status, 400);
    for (const [kind, id] of [['tracks', 'track-1'], ['albums', 'album-1'], ['artists', 'artist-1'], ['playlists', 'playlist-1']]) {
      const res = await get(`/api/v1/catalog/${kind}/personal%3A${id}`); assert.equal(res.status, 200);
      const data = await res.json(); assert.equal((data.artist && kind === 'artists' ? data.artist : data).id, 'personal:' + id);
    }
    const artist = await (await get('/api/v1/catalog/artists/personal%3Aartist-1/tracks')).json(); assert.equal(artist.tracks[0].id, 'personal:track-1');
  });
  await t.test('local browsing and search do not query configured modules', async () => {
    const before = f.requests.length;
    for (const route of ['/api/v1/catalog/search?q=sample', '/api/v1/catalog/featured', '/api/v1/catalog/daily', '/api/v1/catalog/discovery']) {
      const res = await get(route); assert.equal(res.status, 200);
      const data = await res.json(); assert.deepEqual(data.sources.map(source => source.id), ['local']);
      if (data.tracks) assert.deepEqual(data.tracks, []);
    }
    assert.equal(f.requests.length, before, 'Configuring modules must not add calls to local browsing');
    const ordered = new SourceRegistry([f.personal, f.sources.source('local')]);
    assert.equal(ordered.defaultSource, 'local', 'The local library must be the default even when configured after a module');
    const explicit = new SourceRegistry([f.sources.source('local'), f.personal], 'personal');
    assert.equal(explicit.defaultSource, 'personal', 'An explicit administrator configuration remains valid');
  });
  await t.test('favorites and playlists mix sources with per-account permissions', async () => {
    const res = await send('/api/v1/library/favorites/personal%3Atrack-1', 'PUT', { track: { id: 'personal:track-1', title: 'Injected', coverUrl: 'https://outside.example.test' } }); assert.equal(res.status, 200);
    const created = await (await send('/api/v1/library/playlists', 'POST', { name: 'Two sources', tracks: [{ id: 'personal:track-1' }, { id: 'other:track-1' }] })).json();
    assert.equal(created.playlist.tracks.length, 2); assert.equal(created.playlist.tracks[0].track.provider, 'personal');
    assert.equal((await f.request('/api/v1/library/playlists/' + created.playlist.id, { token: other })).status, 404);
    const library = await (await get('/api/v1/library')).json(); assert.equal(library.favorites[0].track.title, 'Sample audio'); assert.match(library.favorites[0].track.coverUrl, /^https:\/\/music\.example\.test\/api\/v1\/catalog\/artwork\/personal%3A/);
    assert.equal((await send('/api/v1/library/saved-albums/personal%3Aalbum-1', 'PUT', {})).status, 200);
    assert.equal((await send('/api/v1/library/saved-playlists/personal%3Aplaylist-1', 'PUT', {})).status, 200);
    assert.equal((await send('/api/v1/following/personal%3Aartist-1', 'PUT', {})).status, 200);
    const updated = await (await get('/api/v1/library')).json(); assert.equal(updated.savedPlaylists[0].available, true);
  });
  await t.test('audio, HEAD, ranges, and If-Range pass through the module without user credentials', async () => {
    const route = '/api/v1/audio/personal%3Atrack-1?quality=128&layout=2';
    const res = await f.request(route, { token, headers: { Range: 'bytes=0-4095', Cookie: 'private-client-cookie=never-forward', 'X-Playback-Access': 'never-forward', 'X-Arbitrary': 'never-forward' } });
    assert.equal(res.status, 206); assert.equal(res.headers.get('content-type'), 'audio/mp4'); assert.equal(res.headers.get('set-cookie'), null); assert.equal(res.headers.get('x-private-config'), null);
    const bytes = Buffer.from(await res.arrayBuffer()); assert.ok(bytes.includes(Buffer.from('sidx'))); const etag = res.headers.get('etag');
    const next = await f.request(route, { token, headers: { Range: 'bytes=4096-8191', 'If-Range': etag } }); assert.equal(next.status, 206); assert.equal(next.headers.get('etag'), etag); await next.arrayBuffer();
    const head = await f.request(route, { token, method: 'HEAD' }); assert.equal(head.status, 200); assert.ok(Number(head.headers.get('content-length')) > 0);
    const upstream = f.requests.find(r => r.path.startsWith('/module/v1/audio/')); assert.equal(upstream.headers.authorization, 'Bearer ' + f.moduleToken);
    for (const key of ['cookie', 'x-playback-access', 'x-arbitrary']) assert.equal(upstream.headers[key], undefined);
    assert.ok(!JSON.stringify(f.requests).includes(token));
    const before = f.requests.length; assert.equal((await f.request(route)).status, 401); assert.equal(f.requests.length, before);
  });
  await t.test('artwork and lyrics pass through the core without infrastructure URLs', async () => {
    const art = await f.request('/api/v1/catalog/artwork/personal%3Acover-1'); assert.equal(art.status, 200); assert.equal(art.headers.get('content-type'), 'image/png'); assert.equal(art.headers.get('set-cookie'), null); await art.arrayBuffer();
    const lyrics = await get('/api/v1/lyrics/personal%3Atrack-1'); assert.equal(lyrics.status, 200); assert.equal(lyrics.headers.get('x-lyrics-source'), 'personal'); assert.match(await lyrics.text(), /Sample audio/);
    const descriptor = await (await send('/api/v1/playback', 'POST', { trackId: 'personal:track-1', quality: '128', layout: 2 })).json(); assert.equal(descriptor.info.provider, 'personal'); assert.match(descriptor.audioUrl, /^https:\/\/music\.example\.test\/api\/v1\/audio\/personal%3A/);
  });
  await t.test('module outages preserve the local catalog and session', async () => {
    f.state.mode = 'down';
    try {
      const res = await get('/api/v1/catalog/tracks/personal%3Atrack-1'); assert.equal(res.status, 503); assert.ok(!(await res.text()).includes(f.moduleToken));
      const before = f.requests.length;
      const local = await (await get('/api/v1/catalog/featured')).json(); assert.deepEqual(local.sources, [{ id: 'local', available: true }]); assert.equal(f.requests.length, before);
      const featured = await (await get('/api/v1/catalog/featured?source=all')).json(); assert.equal(featured.sources.find(s => s.id === 'local').available, true); assert.equal(featured.sources.find(s => s.id === 'personal').available, false);
      const library = await (await get('/api/v1/library')).json(); assert.equal(library.savedPlaylists[0].available, false); assert.equal(library.favorites.length, 1);
      assert.equal((await get('/api/v1/auth/me')).status, 200);
    } finally { f.state.mode = 'normal'; }
  });
  await t.test('invalid responses, redirects, and HTML images are rejected', async () => {
    for (const [mode, route, status] of [['bad-id', '/api/v1/catalog/tracks/personal%3Atrack-1', 502], ['redirect', '/api/v1/audio/personal%3Atrack-1', 503], ['html', '/api/v1/catalog/artwork/personal%3Acover-1', 502]]) {
      f.state.mode = mode;
      try { const res = await get(route); assert.equal(res.status, status); const body = await res.text(); assert.ok(!body.includes('outside.example.test')); assert.ok(!body.includes(f.moduleToken)); }
      finally { f.state.mode = 'normal'; }
    }
    f.state.mode = 'slow'; const oldTimeout = f.personal.timeoutMs; f.personal.timeoutMs = 20;
    try { assert.equal((await get('/api/v1/catalog/tracks/personal%3Atrack-1')).status, 503); }
    finally { f.state.mode = 'normal'; f.personal.timeoutMs = oldTimeout; }
  });
  await t.test('explicit configuration supports modules without a local library', async () => {
    const tokenPath = path.join(f.directory, 'module-token'); await fs.writeFile(tokenPath, f.moduleToken, { mode: 0o600 });
    const configPath = path.join(f.directory, 'sources.json');
    const entry = { id: 'personal', type: 'http', name: 'Private', origin: f.origin, tokenFile: 'module-token' };
    const settings = { version: 1, library: { enabled: false }, external: { enabled: true } };
    await fs.writeFile(configPath, JSON.stringify({ ...settings, defaultSource: 'personal', sources: [entry] }));
    const loaded = await loadSources(configPath); assert.equal(loaded.catalog, null); assert.equal(loaded.sources.defaultSource, 'personal'); assert.equal((await loaded.sources.track('personal:track-1')).id, 'personal:track-1');
    for (const entries of [[entry, entry], [{ ...entry, id: 'local' }], [{ ...entry, id: 'all' }], [{ ...entry, origin: f.origin + '/path' }], [{ ...entry, type: 'bundled-platform' }]]) {
      await fs.writeFile(configPath, JSON.stringify({ ...settings, sources: entries })); await assert.rejects(loadSources(configPath));
    }
  });
  const moduleEntry = { id: 'personal', type: 'http', origin: f.origin, tokenFile: 'module-token' };
  const loadSettings = async settings => {
    const config = { version: 1, ...settings, library: { musicDir: f.catalog.root, ...settings.library } };
    const configPath = path.join(f.directory, 'switches.json');
    await fs.writeFile(configPath, JSON.stringify(config));
    const previous = process.env.DATA_DIR; process.env.DATA_DIR = path.join(f.directory, 'switches-data');
    try { return await loadSources(configPath); }
    finally { if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous; }
  };
  await t.test('library enabled and external connections disabled by default without reading their secrets', async () => {
    const before = f.requests.length;
    const loaded = await loadSettings({ defaultSource: 'personal', sources: [{ ...moduleEntry, origin: 'invalid-origin', tokenFile: 'does-not-exist' }] });
    assert.ok(loaded.catalog); assert.deepEqual(loaded.sources.info().map(s => s.id), ['local']);
    assert.deepEqual(loaded.sources.configuration, { library: { enabled: true }, external: { enabled: false } });
    assert.equal(loaded.sources.defaultSource, 'local', 'Disabling the default source falls back to the local library');
    await loaded.sources.health(); assert.equal(f.requests.length, before);
    await assert.rejects(async () => loaded.sources.track('personal:track-1'), { code: 'SOURCE_NOT_FOUND' });
  });
  await t.test('library and external connections can be enabled together', async () => {
    const loaded = await loadSettings({ library: { enabled: true }, external: { enabled: true }, sources: [moduleEntry] });
    assert.ok(loaded.catalog); assert.equal(loaded.sources.defaultSource, 'local');
    assert.deepEqual(loaded.sources.info().map(s => s.id), ['local', 'personal']);
    assert.equal((await loaded.sources.track('personal:track-1')).provider, 'personal');
    assert.deepEqual(loaded.sources.configuration, { library: { enabled: true }, external: { enabled: true } });
  });
  await t.test('disabling the library prevents opening the music folder', async () => {
    const loaded = await loadSettings({ library: { enabled: false, musicDir: '/nonexistent-library' }, external: { enabled: true }, sources: [moduleEntry] });
    assert.equal(loaded.catalog, null); assert.equal(loaded.sources.defaultSource, 'personal');
    assert.deepEqual(loaded.sources.info().map(s => s.id), ['personal']);
    assert.equal((await loaded.sources.track('personal:track-1')).id, 'personal:track-1');
  });
  await t.test('individual modules can be disabled even when external connections are allowed', async () => {
    const off = { ...moduleEntry, id: 'disabled', enabled: false, tokenFile: 'does-not-exist', origin: 'invalid-origin' };
    const loaded = await loadSettings({ library: { enabled: false }, external: { enabled: true }, sources: [moduleEntry, off] });
    assert.deepEqual(loaded.sources.info().map(s => s.id), ['personal']);
    await assert.rejects(async () => loaded.sources.track('disabled:track-1'), { code: 'SOURCE_NOT_FOUND' });
  });
  await t.test('disabling both features preserves accounts and the API with an empty catalog', async () => {
    const before = f.requests.length;
    const loaded = await loadSettings({ library: { enabled: false, musicDir: '/nonexistent-library' }, external: { enabled: false }, defaultSource: 'personal', sources: [{ ...moduleEntry, tokenFile: 'does-not-exist', origin: 'invalid-origin' }] });
    assert.equal(loaded.catalog, null); assert.equal(loaded.sources.defaultSource, null); assert.deepEqual(await loaded.sources.health(), {});
    const store = new Store(path.join(f.directory, 'disabled-core.sqlite')); store.createUser('admin', await hashPassword('switches-test-password'), 'admin');
    const server = createApp({ store, catalog: loaded.catalog, sources: loaded.sources, logger: { error() {} } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.connect.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
    const base = await apiOrigin(t, server, store, 'https://music.example.test');
    const login = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'switches-test-password', transport: 'bearer' }) });
    assert.equal(login.status, 200); const headers = { Authorization: 'Bearer ' + (await login.json()).session.token };
    for (const route of ['/api/v1/catalog/tracks', '/api/v1/catalog/albums']) { const res = await fetch(base + route, { headers }); assert.equal(res.status, 200); assert.equal((await res.json()).total, 0); }
    for (const route of ['/api/v1/catalog/search?q=test', '/api/v1/catalog/featured']) { const res = await fetch(base + route, { headers }); assert.equal(res.status, 200); assert.deepEqual((await res.json()).sources, []); }
    assert.equal((await fetch(base + '/api/v1/library', { headers })).status, 200);
    assert.equal((await fetch(base + '/api/v1/admin/scan', { headers })).status, 404);
    for (const route of ['/api/v1/audio/personal%3Atrack-1', '/api/v1/catalog/artwork/personal%3Acover-1', '/api/v1/audio/local%3At_test']) assert.equal((await fetch(base + route, { headers })).status, 404);
    const info = await (await fetch(base + '/api/v1')).json(); assert.equal(info.defaultSource, null); assert.deepEqual(info.providers, []);
    assert.deepEqual(info.configuration, { library: { enabled: false }, external: { enabled: false } });
    assert.equal(f.requests.length, before);
  });
  await t.test('configuration switches require actual booleans', async () => {
    for (const settings of [{ library: { enabled: 'false' } }, { external: { enabled: 1 } }, { modules: { enabled: true } }, { sources: [{ ...moduleEntry, enabled: 'false' }] }]) await assert.rejects(loadSettings(settings));
  });
});
