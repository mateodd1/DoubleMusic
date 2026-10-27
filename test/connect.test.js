'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { Store } = require('../src/database');
const { Auth, hashPassword, hashToken } = require('../src/auth');
const { createApp } = require('../src/app');
let hash;
const song = { id: 'local:t_test_001', title: 'Canción', artist: 'Artista', duration: 180, albumId: '', artistId: '', album: '', coverUrl: '/api/v1/catalog/artwork/local%3At_test' };
const state = (playing = true) => ({ track: song, position: 42, duration: 180, playing, canNext: true });
async function fixture(t, { publicUrl = '' } = {}) {
  hash ||= await hashPassword('connect-test-only');
  const store = new Store(':memory:');
  store.createUser('alice', hash); store.createUser('bobby', hash);
  let clock = Date.now();
  const auth = new Auth(store, { now: () => clock });
  await auth.dummy;
  const server = createApp({ store, auth, catalog: {}, media: {}, publicUrl, connectOptions: { origins: ['https://music.example.test'], now: () => clock, interval: 60000 } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.connect.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); });
  async function login(username = 'alice') {
    const r = await fetch(base + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'connect-test-only', transport: 'bearer' }) });
    assert.equal(r.status, 200); return (await r.json()).session.token;
  }
  async function open(token, hello, cookie = false) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/v1/connect', { headers: cookie ? { Origin: 'https://music.example.test', Cookie: `doublemusic_session=${token}` } : { Authorization: `Bearer ${token}` } });
    const messages = [], waiters = [];
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString()); messages.push(m);
      for (const w of [...waiters]) { const i = messages.findIndex(w.match); if (i >= 0) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(messages.splice(i, 1)[0]); } }
    });
    const next = match => {
      const i = messages.findIndex(match); if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
      return new Promise((resolve, reject) => { const w = { match, resolve }; w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(Error('Timed out awaiting connect message')); }, 2000); waiters.push(w); });
    };
    const closed = new Promise(resolve => ws.once('close', (code) => resolve(code)));
    await new Promise((r, reject) => { ws.once('open', r); ws.once('error', reject); });
    const send = m => ws.send(JSON.stringify(m));
    send({ type: 'hello', version: 1, ...hello });
    const ready = await next(m => m.type === 'ready');
    return { ws, next, send, closed, id: ready.deviceId };
  }
  const controller = token => open(token, { role: 'controller' }, true);
  const player = (token, key = 'device-test-key', capabilities = ['playQueue']) => open(token, { role: 'player', platform: 'android', name: 'Mi móvil', deviceKey: key, capabilities });
  return { store, auth, server, base, login, open, controller, player, advance: ms => { clock += ms; server.connect.sweep(); } };
}

test('Connect: browser cookie origin guards, native Bearer, no credentials in query', async t => {
  const f = await fixture(t), token = await f.login();
  async function rejected(path, headers) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(f.base.replace('http:', 'ws:') + path, { headers });
      ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
      ws.on('error', () => {}); ws.on('open', () => { ws.terminate(); reject(Error('Unexpected upgrade')); });
    });
  }
  assert.equal(await rejected('/api/v1/connect', {}), 403);
  assert.equal(await rejected('/api/v1/connect', { Origin: 'https://music.example.test' }), 401);
  assert.equal(await rejected('/api/v1/connect', { Origin: 'https://evil.example', Cookie: `doublemusic_session=${token}` }), 403);
  assert.equal(await rejected('/api/v1/connect?token=forbidden', { Authorization: `Bearer ${token}` }), 404);
  const p = await f.player(token), c = await f.controller(token);
  assert.deepEqual((await c.next(m => m.type === 'devices')).items, []); // no song: invisible
  p.send({ type: 'state', state: state() });
  assert.equal((await c.next(m => m.type === 'devices')).items[0].id, p.id);
});

test('Connect: conserva portadas del origen configurado y descarta URLs ajenas', async t => {
  const f = await fixture(t, { publicUrl: 'https://music.example.test/' }), token = await f.login();
  const p = await f.player(token), c = await f.controller(token);
  await c.next(m => m.type === 'devices');
  const coverUrl = 'https://music.example.test' + song.coverUrl;
  p.send({ type: 'state', state: { ...state(), track: { ...song, coverUrl } } });
  assert.equal((await c.next(m => m.type === 'devices')).items[0].state.track.coverUrl, coverUrl);
  p.send({ type: 'state', state: { ...state(), track: { ...song, coverUrl: 'https://outside.example.test' + song.coverUrl } } });
  assert.equal((await c.next(m => m.type === 'devices')).items[0].state.track.coverUrl, '');
});

test('Connect: per-account isolation, confirmed commands, invalid seek and track changes', async t => {
  const f = await fixture(t), token = await f.login(), other = await f.login('bobby');
  const p = await f.player(token), c = await f.controller(token), stranger = await f.controller(other);
  await c.next(m => m.type === 'devices'); await stranger.next(m => m.type === 'devices');
  p.send({ type: 'state', state: state() }); await c.next(m => m.type === 'devices');
  const cmd = (who, id, extra = {}) => who.send({ type: 'command', id, deviceId: p.id, trackId: song.id, action: 'pause', ...extra });
  cmd(stranger, 'foreign'); assert.equal((await stranger.next(m => m.type === 'result')).error, 'DEVICE_OFFLINE');
  cmd(c, 'wrong-track', { trackId: 'local:OTHER' }); assert.equal((await c.next(m => m.type === 'result')).error, 'TRACK_CHANGED');
  cmd(c, 'bad-seek', { action: 'seek', position: 999 }); assert.equal((await c.next(m => m.type === 'result')).error, 'INVALID_POSITION');
  cmd(c, 'pause'); const command = await p.next(m => m.type === 'command');
  assert.equal(command.action, 'pause');
  p.send({ type: 'state', state: state(false) }); p.send({ type: 'ack', id: command.id, ok: true });
  const result = await c.next(m => m.type === 'result'); assert.equal(result.ok, true); assert.equal(result.id, 'pause');
  cmd(c, 'pause'); assert.equal((await c.next(m => m.type === 'result')).error, 'DUPLICATE_COMMAND');
});

test('Connect: seek result carries the current measured state and a sequence per player', async t => {
  const f = await fixture(t), token = await f.login(), p = await f.player(token), c = await f.controller(token);
  await c.next(m => m.type === 'devices'); p.send({ type: 'state', state: state() });
  const first = await c.next(m => m.type === 'devices'); assert.equal(first.items[0].state.sequence, 1);
  assert.equal(typeof first.serverTime, 'number');
  c.send({ type: 'command', id: 'seek-with-state', deviceId: p.id, trackId: song.id, action: 'seek', position: 80 });
  const command = await p.next(m => m.type === 'command');
  p.send({ type: 'state', state: { ...state(), position: 79.75 } }); p.send({ type: 'ack', id: command.id, ok: true });
  const result = await c.next(m => m.type === 'result');
  assert.equal(result.ok, true); assert.equal(result.device.id, p.id);
  assert.equal(result.device.state.position, 79.75); assert.equal(result.device.state.sequence, 2);
  assert.ok(result.serverTime >= result.device.state.updatedAt);
});

test('Connect: handoff confirms source paused and preserves queue/order/index/position/repeat', async t => {
  const f = await fixture(t), token = await f.login(), p = await f.player(token), c = await f.controller(token);
  await c.next(m => m.type === 'devices'); p.send({ type: 'state', state: state() }); await c.next(m => m.type === 'devices');
  c.send({ type: 'command', id: 'handoff', deviceId: p.id, trackId: song.id, action: 'transfer' });
  const command = await p.next(m => m.type === 'command');
  const snapshot = { queue: [{ ...song, id: 'local:PREVIOUS' }, song, { ...song, id: 'local:NEXT' }], index: 1, position: 43.25, repeat: 'all' };
  p.send({ type: 'state', state: { ...state(false), position: 43.25 } });
  p.send({ type: 'ack', id: command.id, ok: true, snapshot });
  const result = await c.next(m => m.type === 'result');
  assert.equal(result.ok, true); assert.deepEqual(result.snapshot, snapshot);
});

test('Connect: catalog queues replace the mobile queue across track changes, with no audio URLs or credentials', async t => {
  const f = await fixture(t), token = await f.login(), p = await f.player(token), c = await f.controller(token);
  await c.next(m => m.type === 'devices'); p.send({ type: 'state', state: state() });
  assert.deepEqual((await c.next(m => m.type === 'devices')).items[0].capabilities, ['playQueue']);
  // Large enough to exceed the old 2 KiB limit for ordinary controls.
  const queue = Array.from({ length: 50 }, (_, i) => ({ ...song, id: `local:CATALOG_${i}`, title: `Catálogo ${i}`, streamUrl: 'https://ignored.example/audio?ticket=never-forward', token: 'never-forward' }));
  p.send({ type: 'state', state: { ...state(), track: { ...song, id: 'local:AUTO_TRANSITION' } } });
  await c.next(m => m.type === 'devices');
  c.send({ type: 'command', id: 'album', deviceId: p.id, action: 'playQueue', queue, index: 7, shuffle: true, trackId: song.id });
  const command = await p.next(m => m.type === 'command');
  assert.equal(command.action, 'playQueue'); assert.equal(command.queue.length, 50); assert.equal(command.index, 7); assert.equal(command.shuffle, true);
  assert.equal(command.trackId, undefined); assert.equal(command.queue[0].streamUrl, undefined); assert.equal(command.queue[0].token, undefined);
  p.send({ type: 'state', state: { ...state(), track: command.queue[7], position: 0 } });
  p.send({ type: 'ack', id: command.id, ok: true });
  assert.equal((await c.next(m => m.type === 'result')).ok, true);
  const stranger = await f.controller(await f.login('bobby'));
  await stranger.next(m => m.type === 'devices');
  stranger.send({ type: 'command', id: 'foreign-queue', deviceId: p.id, action: 'playQueue', queue, index: 0, shuffle: false });
  assert.equal((await stranger.next(m => m.type === 'result')).error, 'DEVICE_OFFLINE');
});

test('Connect: malformed and oversized queues are rejected without disconnecting the device', async t => {
  const f = await fixture(t), token = await f.login(), p = await f.player(token), c = await f.controller(token);
  await c.next(m => m.type === 'devices'); p.send({ type: 'state', state: state() }); await c.next(m => m.type === 'devices');
  const cases = [{ queue: [] }, { queue: Array(1001).fill(song) }, { index: -1 }, { index: 1 }, { shuffle: 'yes' }, { queue: [{ ...song, id: 'https://arbitrary.example/audio' }] }];
  for (const [i, extra] of cases.entries()) {
    c.send({ type: 'command', id: `invalid-${i}`, deviceId: p.id, action: 'playQueue', queue: [song], index: 0, shuffle: false, ...extra });
    assert.equal((await c.next(m => m.type === 'result')).error, 'INVALID_QUEUE');
  }
  c.send({ type: 'command', id: 'no-state-change', deviceId: p.id, action: 'playQueue', queue: [{ ...song, id: 'local:NEW_TRACK' }], index: 0, shuffle: false });
  const command = await p.next(m => m.type === 'command'); p.send({ type: 'ack', id: command.id, ok: true });
  assert.equal((await c.next(m => m.type === 'result')).error, 'COMMAND_FAILED');
  assert.equal(p.ws.readyState, WebSocket.OPEN);
});

test('Connect: basic-control clients reject catalog playback explicitly but still accept pause', async t => {
  const f = await fixture(t), token = await f.login(), p = await f.player(token, 'old-client-device', []), c = await f.controller(token);
  await c.next(m => m.type === 'devices'); p.send({ type: 'state', state: state() }); await c.next(m => m.type === 'devices');
  c.send({ type: 'command', id: 'old-app', deviceId: p.id, action: 'playQueue', queue: [song], index: 0, shuffle: false });
  assert.equal((await c.next(m => m.type === 'result')).error, 'UNSUPPORTED_COMMAND');
  c.send({ type: 'command', id: 'still-pause', deviceId: p.id, action: 'pause', trackId: song.id });
  const command = await p.next(m => m.type === 'command'); p.send({ type: 'state', state: state(false) }); p.send({ type: 'ack', id: command.id, ok: true });
  assert.equal((await c.next(m => m.type === 'result')).ok, true);
});

test('Connect: unpaused handoff is rejected, never claimed successful', async t => {
  const f = await fixture(t), token = await f.login(), p = await f.player(token), c = await f.controller(token);
  await c.next(m => m.type === 'devices'); p.send({ type: 'state', state: state() }); await c.next(m => m.type === 'devices');
  c.send({ type: 'command', id: 'handoff', deviceId: p.id, trackId: song.id, action: 'transfer' });
  const command = await p.next(m => m.type === 'command');
  p.send({ type: 'ack', id: command.id, ok: true, snapshot: { queue: [song], index: 0, position: 42, repeat: 'off' } });
  assert.equal((await c.next(m => m.type === 'result')).error, 'DEVICE_OFFLINE');
});

test('Connect: disconnect removes device immediately; reconnect replaces installation', async t => {
  const f = await fixture(t), token = await f.login(), p = await f.player(token), c = await f.controller(token);
  await c.next(m => m.type === 'devices'); p.send({ type: 'state', state: state() });
  const original = (await c.next(m => m.type === 'devices')).items[0];
  assert.match(original.instanceId, /^[a-f0-9]{64}$/);
  const replacement = await f.player(token);
  await p.closed;
  const removed = await c.next(m => m.type === 'devices' && m.items.length === 0); assert.equal(removed.items.length, 0);
  replacement.send({ type: 'state', state: state() });
  const reconnected = (await c.next(m => m.type === 'devices' && m.items.length === 1)).items[0];
  assert.equal(reconnected.id, replacement.id); assert.notEqual(reconnected.id, original.id);
  assert.equal(reconnected.instanceId, original.instanceId);
  replacement.ws.close(); assert.equal((await c.next(m => m.type === 'devices' && !m.items.length)).items.length, 0);
});

test('Connect: silent device expires, queued commands time out, session revoke closes socket', async t => {
  const f = await fixture(t), token = await f.login(), p = await f.player(token), c = await f.controller(token);
  await c.next(m => m.type === 'devices'); p.send({ type: 'state', state: state() }); await c.next(m => m.type === 'devices');
  c.send({ type: 'command', id: 'no-ack', deviceId: p.id, trackId: song.id, action: 'pause' });
  await p.next(m => m.type === 'command'); f.advance(6000);
  assert.equal((await c.next(m => m.type === 'result')).error, 'DEVICE_TIMEOUT');
  // Let ping/pong round trips complete before advancing the fake clock again.
  await new Promise(resolve => setTimeout(resolve, 20));
  f.advance(15000); assert.equal((await c.next(m => m.type === 'devices' && !m.items.length)).items.length, 0);
  const newToken = await f.login(), live = await f.player(newToken, 'other-installation');
  f.store.run('DELETE FROM sessions WHERE digest=?', hashToken(newToken)); f.advance(1);
  assert.equal(await live.closed, 4001);
});
