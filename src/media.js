'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { fs, path, localFile, run, limiter, INPUT_FORMATS } = require('./files');
const { invalid, missing } = require('./errors');

const MIME = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.wma': 'audio/x-ms-wma', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const hash = value => createHash('sha256').update(value).digest('hex');
const xml = text => String(text).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

async function serveFile(req, res, file, type, { publicCache = false } = {}) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat(), size = stat.size;
    // La actualización de acceso de la caché conserva mtime con precisión de
    // Date (milisegundos). Normalizar aquí evita cambiar el ETag por perder
    // fracciones de milisegundo tras la primera petición de una conversión.
    const etag = `"${hash(`${stat.ino}:${size}:${stat.mtime.getTime()}`).slice(0, 32)}"`;
    res.setHeader('Content-Type', type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('Cache-Control', publicCache ? 'public, max-age=300' : 'private, no-store');
    if (req.headers['if-none-match'] === etag && !req.headers.range) { res.statusCode = 304; res.end(); return; }
    let start = 0, end = size - 1;
    const ifRange = req.headers['if-range'];
    const useRange = req.headers.range && (!ifRange || ifRange === etag || Date.parse(ifRange) >= Math.floor(stat.mtimeMs / 1000) * 1000);
    if (useRange) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      let valid = match && (match[1] || match[2]) && size > 0;
      if (valid) {
        if (!match[1]) { const suffix = Number(match[2]); valid = Number.isSafeInteger(suffix) && suffix > 0; start = Math.max(0, size - suffix); }
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        valid = valid && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size;
      }
      if (!valid) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${size}`); res.setHeader('Content-Length', '0'); res.end(); return; }
      res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    } else res.statusCode = 200;
    res.setHeader('Content-Length', Math.max(0, end - start + 1));
    if (req.method === 'HEAD' || size === 0) { res.end(); return; }
    await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
  } finally { await handle.close(); }
}

function audioOptions(params) {
  const quality = params.get('quality') || 'original';
  if (!['original', '320', '192', '128'].includes(quality)) throw invalid('Calidad inválida.');
  const layout = params.get('layout');
  if (layout && !['1', '2'].includes(layout)) throw invalid('Layout inválido.');
  const format = params.get('format') || (layout === '2' || quality !== 'original' ? 'mp4' : 'original');
  if (!['original', 'mp4', 'mp3'].includes(format) || (format === 'original' && quality !== 'original')) throw invalid('Formato incompatible con la calidad.');
  return { quality, format };
}

class LocalMedia {
  constructor(catalog, { cacheDir = path.join(catalog.dataDir, 'cache'), maxBytes = Number(process.env.CACHE_MAX_MB || 2048) * 1024 * 1024 } = {}) {
    this.catalog = catalog; this.cacheDir = path.resolve(cacheDir); this.maxBytes = maxBytes;
    if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new Error('CACHE_MAX_MB debe ser un número no negativo.');
    this.pending = new Map(); this.work = limiter(2, 32);
  }
  async init() {
    await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    for (const name of await fs.readdir(this.cacheDir)) if (name.endsWith('.tmp')) await fs.rm(path.join(this.cacheDir, name), { force: true });
    return this;
  }
  async cached(key, extension, generate) {
    const file = path.join(this.cacheDir, `${key}${extension}`);
    try { const stat = await fs.stat(file); await fs.utimes(file, new Date(), stat.mtime); return file; } catch { /* Se genera la variante. */ }
    if (this.pending.has(file)) return this.pending.get(file);
    const promise = this.work(async () => {
      const temp = path.join(this.cacheDir, `${key}-${randomUUID()}.tmp`);
      try {
        await generate(temp); await fs.rename(temp, file);
        await this.prune(file); return file;
      } finally { await fs.rm(temp, { force: true }); }
    }).finally(() => this.pending.delete(file));
    this.pending.set(file, promise);
    return promise;
  }
  async prune(keep) {
    const files = [];
    for (const name of await fs.readdir(this.cacheDir)) {
      if (name.endsWith('.tmp')) continue;
      const file = path.join(this.cacheDir, name);
      try { const stat = await fs.stat(file); if (stat.isFile()) files.push({ file, size: stat.size, time: stat.atimeMs }); } catch { /* Otra petición puede haberlo retirado. */ }
    }
    let size = files.reduce((sum, f) => sum + f.size, 0);
    for (const entry of files.sort((a, b) => a.time - b.time)) {
      if (size <= this.maxBytes) break;
      if (entry.file === keep || this.pending.has(entry.file)) continue;
      await fs.rm(entry.file, { force: true }); size -= entry.size;
    }
  }
  options(params) { return audioOptions(params); }
  async audio(req, res, value, params) {
    const { quality, format } = this.options(params);
    const entry = this.catalog.track(value), source = await this.catalog.file(value), stat = await fs.stat(source);
    let file = source, codec = entry.codec, bitrate = entry.bitrate, sampleRate = entry.sampleRate;
    if (format !== 'original') {
      const copy = quality === 'original' && format === 'mp4' && ['aac', 'alac', 'flac', 'opus'].includes(entry.codec);
      const targetBitrate = quality === 'original' ? '320' : quality;
      codec = copy ? entry.codec : format === 'mp3' ? 'mp3' : 'aac'; bitrate = copy ? entry.bitrate : Number(targetBitrate);
      if (!copy) sampleRate = 48000;
      const key = hash(`audio-v1:${value}:${stat.size}:${stat.mtimeMs}:${quality}:${format}`);
      file = await this.cached(key, format === 'mp3' ? '.mp3' : '.mp4', async temp => {
        const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS, '-i', source, '-map', '0:a:0', '-vn', '-map_metadata', '-1', '-threads', '1'];
        if (copy) args.push('-c:a', 'copy', '-strict', '-2');
        else args.push('-c:a', format === 'mp3' ? 'libmp3lame' : 'aac', '-b:a', `${targetBitrate}k`, '-ac', '2', '-ar', '48000');
        if (format === 'mp3') args.push('-f', 'mp3');
        else args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof+global_sidx', '-frag_duration', '6000000', '-f', 'mp4');
        args.push(temp); await run('ffmpeg', args, { timeout: 600000 });
      });
    }
    res.setHeader('X-Audio-Codec', codec); res.setHeader('X-Audio-Bitrate', String(bitrate));
    res.setHeader('X-Audio-Sample-Rate', String(sampleRate)); res.setHeader('X-Audio-Duration', String(entry.duration));
    return serveFile(req, res, file, format === 'mp4' ? 'audio/mp4' : format === 'mp3' ? 'audio/mpeg' : undefined);
  }
  async artwork(req, res, value) {
    const entry = this.catalog.track(value);
    if (entry.coverFile) return serveFile(req, res, await localFile(this.catalog.root, path.join(this.catalog.root, entry.coverFile)), undefined, { publicCache: true });
    if (!entry.embeddedCover) throw missing();
    const source = await this.catalog.file(value), stat = await fs.stat(source);
    const key = hash(`art-v1:${value}:${stat.size}:${stat.mtimeMs}`);
    const file = await this.cached(key, '.jpg', temp => run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS, '-i', source, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=800:800:force_original_aspect_ratio=decrease', '-f', 'image2', '-c:v', 'mjpeg', temp]));
    return serveFile(req, res, file, 'image/jpeg', { publicCache: true });
  }
  async lyrics(value) {
    const entry = this.catalog.track(value), source = await this.catalog.file(value);
    const stem = source.slice(0, -path.extname(source).length);
    for (const ext of ['.ttml', '.lrc', '.txt']) {
      let file;
      try { file = await localFile(this.catalog.root, stem + ext); } catch { continue; }
      if ((await fs.stat(file)).size > 2 * 1024 * 1024) continue;
      const content = await fs.readFile(file, 'utf8');
      if (ext === '.ttml') return content;
      const lines = [];
      if (ext === '.lrc') {
        const offset = Number(/\[offset:([+-]?\d+)\]/i.exec(content)?.[1] || 0) / 1000;
        for (const line of content.split(/\r?\n/)) {
          const text = line.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim();
          if (!text) continue;
          for (const match of line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)) lines.push({ begin: Math.max(0, Number(match[1]) * 60 + Number(match[2]) + offset), text });
        }
        lines.sort((a, b) => a.begin - b.begin);
      } else for (const text of content.split(/\r?\n/)) if (text.trim()) lines.push({ text: text.trim() });
      return `<?xml version="1.0" encoding="UTF-8"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div>${lines.map((line, i) => `<p${line.begin === undefined ? '' : ` begin="${line.begin}s" end="${Math.max(line.begin, lines[i + 1]?.begin ?? entry.duration)}s"`}>${xml(line.text)}</p>`).join('')}</div></body></tt>`;
    }
    return null;
  }
}
module.exports = { LocalMedia, serveFile, audioOptions };
