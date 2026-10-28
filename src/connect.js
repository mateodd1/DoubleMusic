'use strict';
const { WebSocketServer, WebSocket } = require('ws');
const { randomUUID } = require('node:crypto');
const { hashToken } = require('./auth');

const PATH = '/api/v1/connect';
const ACTIONS = new Set(['play', 'pause', 'next', 'previous', 'seek', 'transfer', 'playQueue', 'queueEdit']);
const seconds = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 86400;
function track(t, publicUrl = '') {
  if (!t || typeof t.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_-]{1,120}$/.test(t.id)) throw Error('INVALID_TRACK');
  const text = (v, n = 256) => typeof v === 'string' ? v.slice(0, n) : '';
  // No playback tickets, credentials or audio URLs cross between devices.
  let coverUrl = '';
  if (typeof t.coverUrl === 'string') {
    const image = publicUrl && t.coverUrl.startsWith(publicUrl + '/') ? t.coverUrl.slice(publicUrl.length) : t.coverUrl;
    if (/^\/api\/v1\/catalog\/artwork\/[a-z][a-z0-9-]{0,31}%3A[A-Za-z0-9_-]{1,120}$/.test(image)) coverUrl = publicUrl + image;
  }
  return { id: t.id, title: text(t.title), artist: text(t.artist), album: text(t.album), artistId: text(t.artistId, 160), albumId: text(t.albumId, 160), coverUrl, duration: seconds(t.duration) ? t.duration : 0 };
}

function queueEdit(m, n, current, localTrack) {
  const edit = { operation: m.operation, queueRevision: m.queueRevision };
  const index = key => { if (!Number.isInteger(m[key]) || m[key] < 0 || m[key] >= n) throw Error(); return m[key]; };
  switch (m.operation) {
    case 'append': case 'next': if (n >= 1000) throw Error(); edit.track = localTrack(m.track); break;
    case 'remove': case 'jump': edit.from = index('from'); if (m.operation === 'remove' && edit.from <= current) throw Error(); break;
    case 'move': edit.from = index('from'); edit.to = index('to'); if (edit.from <= current || edit.to <= current) throw Error(); break;
    case 'clear': break;
    case 'shuffle': case 'mute': if (typeof m.value !== 'boolean') throw Error(); edit.value = m.value; break;
    case 'repeat': if (!['off','all','one'].includes(m.value)) throw Error(); edit.value = m.value; break;
    case 'volume': if (typeof m.value !== 'number' || !Number.isFinite(m.value) || m.value < 0 || m.value > 1) throw Error(); edit.value = m.value; break;
    default: throw Error();
  }
  return edit;
}

/** Ephemeral account-scoped presence. A restart never restores phantom devices. */
function attachConnect(server, auth, { now = Date.now, interval = 5000, staleMs = 20000,
  origins = [], publicUrl = '',
} = {}) {
  const localTrack = value => track(value, publicUrl);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  const peers = new Set(), pending = new Map();
  let closed = false;
  const send = (p, message) => {
    if (p.ws.readyState !== WebSocket.OPEN) return;
    if (p.ws.bufferedAmount > 2 * 1024 * 1024) { p.ws.terminate(); return; }
    p.ws.send(JSON.stringify(message));
  };
  const valid = p => !closed && !!auth.authenticateDigest(p.digest);
  const live = p => p.role === 'player' && p.state && now() - p.updatedAt < staleMs && p.ws.readyState === WebSocket.OPEN && valid(p);
  const devices = userId => [...peers].filter(p => p.userId === userId && live(p)).map(p => ({ id: p.id, instanceId: p.instanceId, name: p.name, platform: p.platform, capabilities: p.capabilities, state: p.state }));
  const broadcast = userId => {
    const items = devices(userId);
    for (const p of peers) if (p.userId === userId && p.role === 'controller' && valid(p)) send(p, { type: 'devices', items, serverTime: now() });
  };
  const finish = (id, result) => {
    const p = pending.get(id); if (!p) return;
    pending.delete(id);
    if (valid(p.controller)) send(p.controller, { type: 'result', id: p.clientId, ...result });
  };
  function sweep() {
    if (closed) return;
    const changed = new Set();
    for (const p of peers) {
      if (!valid(p)) { p.ws.close(4001, 'Session expired'); changed.add(p.userId); continue; }
      if (now() - p.pongAt >= staleMs || (!p.role && now() - p.openedAt >= 5000)) { p.ws.terminate(); changed.add(p.userId); continue; }
      const visible = live(p);
      if (visible !== p.visible) { p.visible = visible; changed.add(p.userId); }
      if (p.role === 'controller') send(p, { type: 'heartbeat' });
      p.ws.ping();
    }
    for (const [id, item] of pending) if (item.expiresAt <= now()) finish(id, { ok: false, error: 'DEVICE_TIMEOUT' });
    for (const id of changed) broadcast(id);
  }
  const timer = setInterval(sweep, interval); timer.unref();
  server.on('upgrade', (req, socket, head) => {
    const reject = status => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`);
    if (req.url !== PATH) return reject('404 Not Found');
    // Browsers must come from an explicit trusted origin; native clients use Bearer.
    const origin = req.headers.origin;
    if (origin ? !origins.includes(origin) : !req.headers.authorization) return reject('403 Forbidden');
    const user = auth.authenticate(req);
    if (!user) return reject('401 Unauthorized');
    if ([...peers].filter(p => p.userId === user.id).length >= 16 || peers.size >= 512) return reject('429 Too Many Requests');
    wss.handleUpgrade(req, socket, head, ws => {
      const p = { ws, userId: user.id, digest: hashToken(auth.token(req)), id: randomUUID(), openedAt: now(), pongAt: now(), rateAt: now(), count: 0, visible: false, seen: new Set() };
      peers.add(p);
      ws.on('error', () => {});
      ws.on('pong', () => { p.pongAt = now(); });
      ws.on('close', () => {
        peers.delete(p);
        for (const [id, item] of pending) {
          if (item.target === p) finish(id, { ok: false, error: 'DEVICE_OFFLINE' });
          else if (item.controller === p) pending.delete(id);
        }
        broadcast(p.userId);
      });
      ws.on('message', (raw, binary) => {
        try {
          if (!valid(p)) return ws.close(4001, 'Session expired');
          if (now() - p.rateAt > 1000) { p.rateAt = now(); p.count = 0; }
          if (++p.count > 40 || binary) return ws.close(1008, 'Rate or format');
          const m = JSON.parse(raw.toString());
          if (!m || typeof m !== 'object' || Array.isArray(m)) throw Error('INVALID_MESSAGE');
          if (!p.role) {
            if (m.type !== 'hello' || m.version !== 1 || !['player', 'controller'].includes(m.role)) throw Error('INVALID_HELLO');
            if (m.role === 'player') {
              if (!['ios', 'android'].includes(m.platform) || typeof m.deviceKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(m.deviceKey)) throw Error('INVALID_DEVICE');
              // Reconnection replaces the previous socket from this installation.
              for (const old of peers) if (old !== p && old.userId === p.userId && old.deviceKey === m.deviceKey) { old.state = null; old.ws.close(4000, 'Replaced'); }
              p.deviceKey = m.deviceKey; p.platform = m.platform;
              // Stable only within this account; it grants no access. Controllers
              // can retain their chosen output across a socket replacement.
              p.instanceId = hashToken(JSON.stringify([p.userId, m.deviceKey]));
              if (m.capabilities !== undefined && (!Array.isArray(m.capabilities) || m.capabilities.length > 16 || m.capabilities.some(c => typeof c !== 'string' || c.length > 64))) throw Error('INVALID_CAPABILITIES');
              p.capabilities = ['playQueue', 'queueControl'].filter(c => m.capabilities?.includes(c));
              p.name = typeof m.name === 'string' ? m.name.slice(0, 64).trim() : '';
              if (!p.name) p.name = m.platform === 'ios' ? 'iPhone / iPad' : 'Android';
            }
            p.role = m.role;
            send(p, { type: 'ready', version: 1, deviceId: p.id, serverTime: now() });
            if (p.role === 'controller') {
              send(p, { type: 'devices', items: devices(p.userId), serverTime: now() });
              for (const peer of peers) if (peer.userId === p.userId && live(peer) && peer.queue) send(p, { type: 'queue', deviceId: peer.id, revision: peer.queue.revision, queue: peer.queue.queue });
            }
            return;
          }
          if (m.type === 'state' && p.role === 'player') {
            if (raw.length > (p.capabilities.includes('queueControl') ? 2 * 1024 * 1024 - 1024 : 16384)) throw Error('INVALID_STATE');
            const s = m.state;
            if (s === null) { p.state = null; p.queue = null; p.queueBytes = 0; p.visible = false; broadcast(p.userId); return; }
            if (!s || !seconds(s.position) || !seconds(s.duration) || typeof s.playing !== 'boolean') throw Error('INVALID_STATE');
            let changed = false, extra = {};
            if (p.capabilities.includes('queueControl') && s.queueRevision != null) {
              if (typeof s.queueRevision !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(s.queueRevision)) throw Error('INVALID_QUEUE');
              if (s.queue !== undefined) {
                if (!Array.isArray(s.queue) || s.queue.length < 1 || s.queue.length > 1000) throw Error('INVALID_QUEUE');
                const q = s.queue.map(localTrack);
                if (p.queue?.revision === s.queueRevision && JSON.stringify(p.queue.queue) !== JSON.stringify(q)) throw Error('INVALID_QUEUE');
                changed = p.queue?.revision !== s.queueRevision;
                const next = { queue: q, revision: s.queueRevision }, bytes = Buffer.byteLength(JSON.stringify(next));
                if ([...peers].reduce((n, peer) => n + (peer.queueBytes || 0), 0) - (p.queueBytes || 0) + bytes > 16 * 1024 * 1024) throw Error('QUEUE_STORAGE_LIMIT');
                p.queue = next; p.queueBytes = bytes;
              }
              if (!p.queue || p.queue.revision !== s.queueRevision || !Number.isInteger(s.queueIndex) || s.queueIndex < 0 || p.queue.queue[s.queueIndex]?.id !== s.track.id ||
                  typeof s.shuffle !== 'boolean' || !['off','all','one'].includes(s.repeat) || typeof s.volume !== 'number' || !Number.isFinite(s.volume) || s.volume < 0 || s.volume > 1 || typeof s.muted !== 'boolean') throw Error('INVALID_QUEUE');
              extra = { queueRevision: s.queueRevision, queueIndex: s.queueIndex, shuffle: s.shuffle, repeat: s.repeat, volume: s.volume, muted: s.muted };
            } else { p.queue = null; p.queueBytes = 0; }
            p.state = { track: localTrack(s.track), position: Math.min(s.position, s.duration || s.position), duration: s.duration,
              playing: s.playing, buffering: s.buffering === true, canNext: s.canNext === true, updatedAt: now(), sequence: p.sequence = (p.sequence || 0) + 1, ...extra };
            p.updatedAt = now(); p.visible = true; broadcast(p.userId);
            if (changed) for (const c of peers) if (c.userId === p.userId && c.role === 'controller' && valid(c)) send(c, { type: 'queue', deviceId: p.id, revision: p.queue.revision, queue: p.queue.queue });
            return;
          }
          if (m.type === 'command' && p.role === 'controller') {
            if (typeof m.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(m.id) || !ACTIONS.has(m.action) || (!['playQueue','queueEdit'].includes(m.action) && raw.length > 2048)) throw Error('INVALID_COMMAND');
            const fail = error => send(p, { type: 'result', id: m.id, ok: false, error });
            if (p.seen.has(m.id)) return fail('DUPLICATE_COMMAND');
            p.seen.add(m.id); if (p.seen.size > 128) p.seen.delete(p.seen.values().next().value);
            if ([...pending.values()].filter(item => item.controller === p).length >= 8) return fail('TOO_MANY_COMMANDS');
            const target = [...peers].find(x => x.id === m.deviceId && x.userId === p.userId && live(x));
            if (!target) return fail('DEVICE_OFFLINE');
            if (m.action !== 'playQueue' && m.trackId !== target.state.track.id) return fail('TRACK_CHANGED');
            let queue, edit;
            if (m.action === 'queueEdit') {
              if (!target.capabilities.includes('queueControl') || !target.queue) return fail('UNSUPPORTED_COMMAND');
              if (m.queueRevision !== target.state.queueRevision) return fail('QUEUE_CHANGED');
              try { edit = queueEdit(m, target.queue.queue.length, target.state.queueIndex, localTrack); } catch { return fail('INVALID_QUEUE'); }
            }
            if (m.action === 'playQueue') {
              if (!target.capabilities.includes('playQueue')) return fail('UNSUPPORTED_COMMAND');
              try {
                if (raw.length > 2 * 1024 * 1024 - 1024 || !Array.isArray(m.queue) || !m.queue.length || m.queue.length > 1000 || !Number.isInteger(m.index) || m.index < 0 || m.index >= m.queue.length || typeof m.shuffle !== 'boolean') throw Error();
                queue = { queue: m.queue.map(localTrack), index: m.index, shuffle: m.shuffle };
              } catch { return fail('INVALID_QUEUE'); }
            }
            if (m.action === 'seek' && (!seconds(m.position) || m.position > target.state.duration)) return fail('INVALID_POSITION');
            if ([...pending.values()].some(item => item.target === target && (item.action === 'transfer' || m.action === 'transfer' || item.action === 'queueEdit' || m.action === 'queueEdit'))) return fail('DEVICE_BUSY');
            const id = randomUUID(), expiresAt = now() + 5000;
            pending.set(id, { controller: p, clientId: m.id, target, action: m.action, trackId: queue ? queue.queue[queue.index].id : m.trackId, sequence: target.sequence, expiresAt });
            send(target, { type: 'command', id, action: m.action, ...(queue || { trackId: m.trackId }), ...edit, ...(m.action === 'seek' ? { position: m.position } : {}), expiresAt });
            return;
          }
          if (m.type === 'ack' && p.role === 'player') {
            const item = pending.get(m.id);
            if (!item || item.target !== p) return;
            if (now() >= item.expiresAt) return finish(m.id, { ok: false, error: 'DEVICE_TIMEOUT' });
            if (m.ok !== true) return finish(m.id, { ok: false, error: 'COMMAND_FAILED' });
            if (item.action === 'playQueue' && p.state?.track.id !== item.trackId) return finish(m.id, { ok: false, error: 'COMMAND_FAILED' });
            if (item.action === 'queueEdit' && p.sequence <= item.sequence) return finish(m.id, { ok: false, error: 'COMMAND_FAILED' });
            let snapshot;
            if (item.action === 'transfer') {
              const s = m.snapshot;
              if (!s || !seconds(s.position) || !Array.isArray(s.queue) || !s.queue.length || s.queue.length > 1000 || !['off', 'all', 'one'].includes(s.repeat)) throw Error('INVALID_SNAPSHOT');
              if (!Number.isInteger(s.index) || s.index < 0 || s.index >= s.queue.length) throw Error('INVALID_SNAPSHOT');
              snapshot = { queue: s.queue.map(localTrack), index: s.index, position: s.position, repeat: s.repeat };
              if (snapshot.queue[snapshot.index].id !== item.trackId) throw Error('TRACK_CHANGED');
              // A handoff is acknowledged only once the source is paused.
              if (!p.state || p.state.playing || p.state.track.id !== item.trackId) throw Error('SOURCE_NOT_PAUSED');
            }
            finish(m.id, { ok: true, ...(snapshot ? { snapshot } : {}), ...(['seek', 'queueEdit', 'playQueue'].includes(item.action) ? { device: devices(p.userId).find(d => d.id === p.id), serverTime: now() } : {}) }); return;
          }
          throw Error('INVALID_MESSAGE');
        } catch { ws.close(1008, 'Invalid connect message'); }
      });
    });
  });
  const close = () => { if (closed) return; closed = true; clearInterval(timer); for (const p of peers) p.ws.terminate(); pending.clear(); wss.close(); };
  server.once('close', close);
  return { close, sweep, devices };
}
module.exports = { attachConnect };
