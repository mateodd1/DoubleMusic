'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { LocalCatalog } = require('../catalog');
const { LocalMedia } = require('../media');
const { LocalSource } = require('./local');
const { HttpSource } = require('./http');
const { SourceRegistry } = require('./registry');

async function loadSources(file = process.env.SOURCES_FILE, { logger = console } = {}) {
  const config = file ? JSON.parse(await fs.readFile(file, 'utf8')) : { version: 1 };
  if (!config || config.version !== 1 || config.sources !== undefined && (!Array.isArray(config.sources) || config.sources.length > 16)) throw new Error('Configuración de fuentes inválida.');
  if ('modules' in config) throw new Error('Usa external.enabled para configurar las conexiones externas.');
  const enabled = (section, fallback) => {
    if (section === undefined) return fallback;
    if (!section || typeof section !== 'object' || Array.isArray(section) || section.enabled !== undefined && typeof section.enabled !== 'boolean') throw new Error('library.enabled y external.enabled deben ser booleanos.');
    return section.enabled ?? fallback;
  };
  const libraryEnabled = enabled(config.library, true), externalEnabled = enabled(config.external, false);
  const entries = [...(config.sources || [])];
  if (!entries.some(entry => entry?.id === 'local')) entries.unshift({ id: 'local', type: 'local' });
  const known = new Set();
  for (const entry of entries) {
    if (!entry || !/^[a-z][a-z0-9-]{0,31}$/.test(entry.id) || entry.id === 'all' || known.has(entry.id)) throw new Error('Cada fuente necesita un id único de 1–32 caracteres; all está reservado.');
    known.add(entry.id);
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error('enabled debe ser un booleano.');
    if (!(entry.type === 'local' && entry.id === 'local' || entry.type === 'http' && entry.id !== 'local')) throw new Error('Tipo de fuente no soportado: usa local con id local, o http con otro id.');
  }
  if (config.defaultSource !== undefined && !known.has(config.defaultSource)) throw new Error('La fuente predeterminada no está configurada.');
  const sources = []; let catalog = null;
  for (const entry of entries) {
    if (entry.enabled === false || entry.type === 'local' && !libraryEnabled || entry.type === 'http' && !externalEnabled) continue;
    if (entry.type === 'local') {
      catalog = await new LocalCatalog({ root: config.library?.musicDir || entry.musicDir, logger }).init();
      const media = await new LocalMedia(catalog).init();
      sources.push(new LocalSource(catalog, media));
    } else {
      if (typeof entry.tokenFile !== 'string' || !entry.tokenFile) throw new Error('El módulo HTTP necesita tokenFile.');
      const tokenPath = path.resolve(file ? path.dirname(path.resolve(file)) : '.', entry.tokenFile);
      const stat = await fs.stat(tokenPath);
      if (!stat.isFile() || stat.size > 1024) throw new Error('Archivo de token de módulo inválido.');
      const token = (await fs.readFile(tokenPath, 'utf8')).trim();
      sources.push(new HttpSource({ id: entry.id, name: entry.name, origin: entry.origin, token }));
    }
  }
  const preferred = sources.some(source => source.id === config.defaultSource) ? config.defaultSource : undefined;
  const configuration = { library: { enabled: !!catalog }, external: { enabled: externalEnabled } };
  return { sources: new SourceRegistry(sources, preferred, configuration), catalog };
}
module.exports = { loadSources };
