// Username + password accounts with long-lived sessions.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';

const scrypt = promisify(scryptCb);
const DAY = 86_400_000;
export const REMEMBER_DAYS = 365;      // "Keep me signed in" (and the Mac app)
export const SHORT_DAYS = 1;           // browser session without "keep me signed in"

export const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

const sha256 = s => createHash('sha256').update(s).digest('hex');

export async function createUser(username, password) {
  const id = randomUUID();
  await db.execute({
    sql: 'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
    args: [id, username, await hashPassword(password), Date.now()],
  });
  return { id, username };
}

export async function findUser(username) {
  const r = await db.execute({ sql: 'SELECT id, username, password_hash FROM users WHERE username = ?', args: [username] });
  return r.rows[0] ?? null;
}

export async function createSession(userId, { remember, device }) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expires = now + (remember ? REMEMBER_DAYS : SHORT_DAYS) * DAY;
  await db.execute({
    sql: 'INSERT INTO sessions (token_hash, user_id, device, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    args: [sha256(token), userId, String(device || 'web').slice(0, 60), now, now, expires],
  });
  return { token, expires };
}

/** Resolves a raw token to its user, sliding the expiry forward for remembered sessions. */
export async function userForToken(token) {
  if (!token) return null;
  const h = sha256(token);
  const r = await db.execute({
    sql: `SELECT s.user_id, s.expires_at, s.created_at, s.last_seen, u.username
          FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    args: [h],
  });
  const row = r.rows[0];
  if (!row) return null;
  const now = Date.now();
  if (Number(row.expires_at) < now) {
    await db.execute({ sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [h] });
    return null;
  }
  // Touch at most once an hour; long sessions keep rolling while in use.
  if (now - Number(row.last_seen) > 3_600_000) {
    const long = Number(row.expires_at) - Number(row.created_at) > 2 * DAY;
    const expires = long ? now + REMEMBER_DAYS * DAY : Number(row.expires_at);
    await db.execute({ sql: 'UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?', args: [now, expires, h] });
  }
  return { id: row.user_id, username: row.username };
}

export async function deleteSession(token) {
  if (token) await db.execute({ sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [sha256(token)] });
}

// --- Brute-force protection: 10 failed attempts per username+IP per 15 minutes (stored in the DB). ---
const WINDOW = 15 * 60_000;
export async function tooManyAttempts(key) {
  const r = await db.execute({ sql: 'SELECT first_at, count FROM login_failures WHERE key = ?', args: [key] });
  const f = r.rows[0];
  if (!f) return false;
  if (Date.now() - Number(f.first_at) > WINDOW) {
    await db.execute({ sql: 'DELETE FROM login_failures WHERE key = ?', args: [key] });
    return false;
  }
  return Number(f.count) >= 10;
}
export async function recordFailure(key) {
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO login_failures (key, first_at, count) VALUES (?, ?, 1)
          ON CONFLICT (key) DO UPDATE SET
            count = CASE WHEN ? - first_at > ? THEN 1 ELSE count + 1 END,
            first_at = CASE WHEN ? - first_at > ? THEN ? ELSE first_at END`,
    args: [key, now, now, WINDOW, now, WINDOW, now],
  });
}
export async function clearFailures(key) {
  await db.execute({ sql: 'DELETE FROM login_failures WHERE key = ?', args: [key] });
}
