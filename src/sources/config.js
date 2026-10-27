'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { LocalCatalog } = require('../catalog');
const { LocalMedia } = require('../media');
const { LocalSource } = require('./local');
const { HttpSource } = require('./http');
const { SourceRegistry } = require('./registry');

async function loadSources(file = process.env.SOURCES_FILE, { logger = console } = {}) {
  const config = file ? JSON.parse(await fs.readFile(file, 'utf8')) : { version: 1, sources: [{ id: 'local', type: 'local' }], defaultSource: 'local' };
  if (config.version !== 1 || !Array.isArray(config.sources) || !config.sources.length || config.sources.length > 16) throw new Error('Configuración de fuentes inválida.');
  const sources = []; let catalog = null;
  for (const entry of config.sources) {
    if (!entry || !/^[a-z][a-z0-9-]{0,31}$/.test(entry.id) || sources.some(source => source.id === entry.id)) throw new Error('Cada fuente necesita un id único de 1–32 caracteres: letras minúsculas, números y guiones.');
    if (entry.type === 'local' && entry.id === 'local') {
      catalog = await new LocalCatalog({ root: entry.musicDir, logger }).init();
      const media = await new LocalMedia(catalog).init();
      sources.push(new LocalSource(catalog, media));
    } else if (entry.type === 'http' && entry.id !== 'local') {
      if (typeof entry.tokenFile !== 'string' || !entry.tokenFile) throw new Error('El módulo HTTP necesita tokenFile.');
      const tokenPath = path.resolve(file ? path.dirname(path.resolve(file)) : '.', entry.tokenFile);
      const stat = await fs.stat(tokenPath);
      if (!stat.isFile() || stat.size > 1024) throw new Error('Archivo de token de módulo inválido.');
      const token = (await fs.readFile(tokenPath, 'utf8')).trim();
      sources.push(new HttpSource({ id: entry.id, name: entry.name, origin: entry.origin, token }));
    } else throw new Error('Tipo de fuente no soportado: usa local con id local, o http con otro id.');
  }
  return { sources: new SourceRegistry(sources, config.defaultSource), catalog };
}
module.exports = { loadSources };
