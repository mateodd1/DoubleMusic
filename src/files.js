'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { missing, ApiError } = require('./errors');
const exec = promisify(execFile);
const INPUT_FORMATS = 'aac,aiff,ape,asf,flac,matroska,webm,mov,mp3,ogg,wav,wv';

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
async function localFile(root, file) {
  let resolved;
  try {
    resolved = await fs.realpath(file);
    if (!inside(root, resolved) || !(await fs.stat(resolved)).isFile()) throw missing();
  } catch { throw missing(); }
  return resolved;
}
async function run(binary, args, { timeout = 30000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  try { return await exec(binary, args, { timeout, maxBuffer, windowsHide: true, encoding: 'utf8' }); }
  catch { throw new ApiError(422, 'MEDIA_PROCESS_FAILED', 'No se pudo procesar el archivo de audio.'); }
}
async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS, '-show_format', '-show_streams', '-of', 'json', file]);
  return JSON.parse(stdout);
}
function limiter(concurrency = 2, capacity = 64) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || !queue.length) return;
    const { fn, resolve, reject } = queue.shift(); active++;
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => {
    if (queue.length >= capacity) return Promise.reject(new ApiError(503, 'MEDIA_BUSY', 'El servidor está ocupado. Reintenta en unos segundos.'));
    return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
  };
}
module.exports = { fs, path, inside, localFile, run, probe, limiter, INPUT_FORMATS };
