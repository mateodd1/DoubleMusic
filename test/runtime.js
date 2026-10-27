'use strict';
const { spawn } = require('node:child_process');
const net = require('node:net');

// Reuse the actual API contracts against either runtime, with isolated SQLite files.
async function apiOrigin(t, server, store, publicUrl = '') {
  const worker = `http://127.0.0.1:${server.address().port}`;
  if (!process.env.RUST_CORE_BIN) return worker;
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const database = store.get('PRAGMA database_list').file;
  if (!database) throw Error('Rust contract tests require an on-disk SQLite database.');
  const child = spawn(process.env.RUST_CORE_BIN, [], {
    env: { ...process.env, CORE_LISTEN: `127.0.0.1:${port}`, CORE_DB: database,
      CATALOG_ORIGIN: worker, PUBLIC_URL: publicUrl, ALLOWED_ORIGINS: 'https://music.example.test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill('SIGTERM'); await exited; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw Error(`Rust core exited: ${logs}`);
    try {
      const res = await fetch(base + '/health');
      if (res.ok) {
        if (res.headers.get('x-core-runtime') !== 'rust') throw Error('Expected native Rust response');
        return base;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(`Rust core did not become ready: ${logs}`);
}
module.exports = { apiOrigin };
