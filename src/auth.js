'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { ApiError, invalid } = require('./errors');
const derive = promisify(crypto.scrypt);
const COOKIE = 'doublemusic_session';
const TTL = 30 * 24 * 3600 * 1000;
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) throw invalid('The password must contain 8 to 1024 characters.');
  const salt = crypto.randomBytes(16);
  const key = await derive(password, salt, 64, OPTIONS);
  return `scrypt$${OPTIONS.N}$${OPTIONS.r}$${OPTIONS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(password, hash) {
  try {
    const [scheme, n, r, p, salt, stored] = hash.split('$');
    if (scheme !== 'scrypt' || Number(n) !== OPTIONS.N || Number(r) !== 8 || Number(p) !== 1) return false;
    const expected = Buffer.from(stored, 'base64');
    if (expected.length !== 64) return false;
    const actual = await derive(String(password || ''), Buffer.from(salt, 'base64'), 64, OPTIONS);
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

class Auth {
  constructor(store, { secureCookies = false, trustProxy = false, now = Date.now } = {}) {
    this.store = store; this.secureCookies = secureCookies; this.trustProxy = trustProxy; this.now = now;
    this.attempts = new Map(); this.inflight = 0;
    this.dummy = hashPassword(crypto.randomBytes(32).toString('hex'));
  }
  token(req) {
    const authorization = String(req.headers.authorization || '');
    if (authorization) return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)?.[1] || '';
    return /(?:^|;\s*)doublemusic_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(String(req.headers.cookie || ''))?.[1] || '';
  }
  authenticate(req) {
    const token = this.token(req);
    if (!token) return null;
    return this.authenticateDigest(hashToken(token));
  }
  authenticateDigest(digest) {
    const row = this.store.get(`SELECT u.id,u.username,u.role,s.expires_at FROM sessions s
      JOIN users u ON u.id=s.user_id WHERE s.digest=? AND s.expires_at>?`, digest, this.now());
    return row ? { ...this.store.publicUser(row), expiresAt: row.expires_at } : null;
  }
  cookie(req, res, token, expiresAt) {
    const secure = this.secureCookies || !!req.socket?.encrypted || (this.trustProxy && req.headers['x-forwarded-proto'] === 'https');
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? Math.max(0, Math.floor((expiresAt - this.now()) / 1000)) : 0}${secure ? '; Secure' : ''}`);
  }
  async login(req, res, body) {
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username) || typeof body.password !== 'string' || body.password.length > 1024 || !['cookie', 'bearer'].includes(body.transport || 'cookie')) throw invalid('Invalid credentials or transport.');
    const now = this.now();
    // Account scope prevents one browser behind the reverse proxy from
    // blocking every other account. Bounded KDF concurrency protects Node.
    const key = username.toLowerCase();
    const hit = this.attempts.get(key);
    if ((hit && hit.until > now && hit.count >= 8) || this.inflight >= 8) {
      res.setHeader('Retry-After', '60');
      throw new ApiError(429, 'LOGIN_BLOCKED', 'Too many attempts. Wait one minute.');
    }
    const counter = hit && hit.until > now ? hit : { count: 0, until: now + 60000 };
    counter.count++; this.attempts.set(key, counter);
    for (const [id, item] of this.attempts) if (item.until <= now) this.attempts.delete(id);
    if (this.attempts.size > 4096) this.attempts.delete(this.attempts.keys().next().value);
    this.inflight++;
    try {
      const user = this.store.get('SELECT * FROM users WHERE username=?', username);
      const valid = await verifyPassword(body.password, user?.hash || await this.dummy);
      // Password changes or deletion while scrypt was running revoke this login too.
      const current = user && this.store.get('SELECT * FROM users WHERE id=?', user.id);
      if (!valid || !current || current.hash !== user.hash) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password.');
      this.attempts.delete(key);
      const token = crypto.randomBytes(32).toString('base64url'), expiresAt = this.now() + TTL;
      this.store.transaction(() => {
        this.store.run('DELETE FROM sessions WHERE expires_at<=?', this.now());
        // Bound long-lived session storage per account, keeping the newest 50.
        this.store.run('DELETE FROM sessions WHERE digest IN (SELECT digest FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 49)', user.id);
        this.store.run('INSERT INTO sessions VALUES (?,?,?,?)', hashToken(token), user.id, expiresAt, this.now());
      });
      if ((body.transport || 'cookie') === 'cookie') this.cookie(req, res, token, expiresAt);
      return { user: this.store.publicUser(current), session: { expiresAt, ...(body.transport === 'bearer' ? { token, tokenType: 'Bearer' } : {}) } };
    } finally { this.inflight--; }
  }
  logout(req, res) {
    const token = this.token(req);
    if (token) this.store.run('DELETE FROM sessions WHERE digest=?', hashToken(token));
    this.cookie(req, res, '', 0);
    return { ok: true };
  }
}
module.exports = { Auth, hashPassword, verifyPassword, hashToken, TTL };
