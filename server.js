'use strict';
const { Store } = require('./src/database');
const { Auth } = require('./src/auth');
const { loadSources } = require('./src/sources/config');
const { createApp } = require('./src/app');

async function start() {
  process.umask(0o077);
  const interval = Number(process.env.SCAN_INTERVAL_SECONDS || 300), port = Number(process.env.PORT || 3000);
  if (!Number.isFinite(interval) || interval < 0 || interval > 2147483) throw new Error('SCAN_INTERVAL_SECONDS must be between 0 and 2147483.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const { sources, catalog } = await loadSources();
  const store = new Store();
  const auth = new Auth(store, { trustProxy: process.env.TRUST_PROXY === 'true', secureCookies: process.env.SECURE_COOKIES === 'true' });
  const server = createApp({ store, catalog, sources, auth });
  let timer;
  if (interval && catalog) {
    timer = setInterval(() => catalog.scan().catch(() => console.error('[Catalog] Could not update the index.')), interval * 1000);
    timer.unref();
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, process.env.HOST || '0.0.0.0', resolve); });
  console.log(`[DoubleMusic] API v1 on :${port}; ${sources.info().length} sources; ${catalog?.tracks.size || 0} local tracks.`);
  const close = () => {
    clearInterval(timer); server.connect.close();
    server.close(() => { store.close(); process.exit(0); });
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 15000).unref();
  };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  return server;
}
if (require.main === module) start().catch(error => { console.error(`[DoubleMusic] ${error.code || error.message}`); process.exitCode = 1; });
module.exports = { start };
