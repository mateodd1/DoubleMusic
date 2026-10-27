'use strict';
const { ApiError, invalid } = require('./errors');

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(status === 304 ? undefined : JSON.stringify(data));
}
function readJson(req, limit = 256 * 1024) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return Promise.reject(invalid('Content-Type: application/json is required.'));
  if (Number(req.headers['content-length']) > limit) { req.resume(); return Promise.reject(new ApiError(413, 'TOO_LARGE', 'Request body is too large.')); }
  return new Promise((resolve, reject) => {
    const parts = []; let bytes = 0, done = false;
    req.on('data', chunk => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > limit) { done = true; parts.length = 0; reject(new ApiError(413, 'TOO_LARGE', 'Request body is too large.')); return; }
      parts.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
        resolve(data);
      } catch { reject(invalid('A valid JSON object is required.')); }
    });
    req.on('aborted', () => { if (!done) { done = true; reject(new ApiError(400, 'REQUEST_ABORTED')); } });
    req.on('error', error => { if (!done) { done = true; reject(error); } });
  });
}
module.exports = { json, readJson };
