'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Store } = require('../src/database');
const { hashPassword } = require('../src/auth');
const { createApp } = require('../src/app');
const { SourceRegistry } = require('../src/sources/registry');
const { apiOrigin } = require('./runtime');

test('Rust migration: shared sessions and passwords support rollback; native APIs survive catalog loss',
  { skip: !process.env.RUST_CORE_BIN }, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doublemusic-migration-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = new Store(path.join(directory, 'core.sqlite'));
    store.createUser('admin', await hashPassword('migration-password'), 'admin');
    const server = createApp({ store, sources: new SourceRegistry([]), catalog: null, logger: { error() {} } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let closed = false;
    const stop = async () => { if (closed) return; closed = true; server.connect.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
    t.after(async () => { await stop(); store.close(); });
    const legacy = `http://127.0.0.1:${server.address().port}`;
    const rust = await apiOrigin(t, server, store);
    const send = (origin, route, method = 'GET', body, token) => fetch(origin + '/api/v1' + route, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const login = async (origin, username = 'admin', password = 'migration-password', transport = 'bearer') => {
      const res = await send(origin, '/auth/login', 'POST', { username, password, transport });
      assert.equal(res.status, 200); return { body: await res.json(), cookie: res.headers.get('set-cookie') };
    };
    const nodeToken = (await login(legacy)).body.session.token;
    const rustToken = (await login(rust)).body.session.token;
    assert.equal((await send(rust, '/auth/me', 'GET', undefined, nodeToken)).status, 200);
    assert.equal((await send(legacy, '/auth/me', 'GET', undefined, rustToken)).status, 200);
    const cookie = await login(rust, 'admin', 'migration-password', 'cookie');
    assert.match(cookie.cookie, /^doublemusic_session=/);
    assert.ok(!cookie.body.session.token);
    assert.equal((await fetch(legacy + '/api/v1/auth/me', { headers: { Cookie: cookie.cookie.split(';')[0] } })).status, 200);
    assert.equal((await send(rust, '/admin/users', 'POST', { username: 'rustuser', password: 'created-in-rust' }, rustToken)).status, 201);
    await login(legacy, 'rustuser', 'created-in-rust');
    const changed = await send(rust, '/auth/password', 'PUT', { currentPassword: 'migration-password', newPassword: 'changed-in-rust' }, rustToken);
    assert.equal(changed.status, 200);
    assert.equal((await send(legacy, '/auth/me', 'GET', undefined, nodeToken)).status, 401);
    await login(legacy, 'admin', 'changed-in-rust');
    await stop();
    const native = (await login(rust, 'admin', 'changed-in-rust')).body.session.token;
    for (const route of ['/auth/me', '/library', '/admin/users']) {
      const res = await send(rust, route, 'GET', undefined, native);
      assert.equal(res.status, 200); assert.equal(res.headers.get('x-core-runtime'), 'rust');
    }
    assert.equal((await fetch(rust + '/health')).status, 502);
    assert.equal((await send(rust, '/catalog/tracks', 'GET', undefined, native)).status, 502);
  });
