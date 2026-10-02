// Cadence API: one request handler used by the Vercel function (api/index.js)
// and by the local dev server (server/dev.js).
import { ready, sync, usingTurso } from './db.js';
import * as auth from './auth.js';
import * as google from './google.js';
import * as calendly from './calendly.js';
import { importGoogle } from './importer.js';
import { db } from './db.js';

const COOKIE = 'cadence_session';

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket?.encrypted);
const originOf = req => `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;

function sessionCookie(req, token, maxAgeDays) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (isHttps(req)) parts.push('Secure');
  if (maxAgeDays != null) parts.push(`Max-Age=${maxAgeDays * 86400}`);
  return parts.join('; ');
}

function tokenOf(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return { token: h.slice(7), viaCookie: false };
  return { token: cookies(req)[COOKIE], viaCookie: true };
}

async function readJson(req) {
  // Requiring a JSON content type blocks cross-site form posts (they can't set it without CORS).
  if (!(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'Expected JSON');
  // Vercel pre-parses JSON bodies.
  if (req.body !== undefined) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); } }
    if (Buffer.isBuffer(req.body)) { try { return JSON.parse(req.body.toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); } }
    return req.body ?? {};
  }
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 5_000_000) throw new HttpError(413, 'Request too large');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

async function requireUser(req) {
  const { token, viaCookie } = tokenOf(req);
  // Cookie-authenticated writes must come from our own origin.
  if (viaCookie && req.method !== 'GET' && req.headers.origin && req.headers.origin !== originOf(req)) {
    throw new HttpError(403, 'Cross-origin request blocked');
  }
  const user = await auth.userForToken(token);
  if (!user) throw new HttpError(401, 'Not signed in');
  return user;
}

// ---------- routes ----------

async function signIn(req, res, { create }) {
  const body = await readJson(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const remember = body.remember !== false;
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const key = `${username.toLowerCase()}|${ip}`;
  if (await auth.tooManyAttempts(key)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');

  let user;
  if (create) {
    if (!auth.USERNAME_RE.test(username)) throw new HttpError(400, 'Usernames are 3–32 letters, numbers, dots, dashes or underscores.');
    if (password.length < 8) throw new HttpError(400, 'Passwords need at least 8 characters.');
    if (await auth.findUser(username)) throw new HttpError(409, 'That username is taken.');
    user = await auth.createUser(username, password);
  } else {
    const row = await auth.findUser(username);
    if (!row || !(await auth.verifyPassword(password, row.password_hash))) {
      await auth.recordFailure(key);
      throw new HttpError(401, 'Wrong username or password.');
    }
    await auth.clearFailures(key);
    user = { id: row.id, username: row.username };
  }
  const { token, expires } = await auth.createSession(user.id, { remember, device: body.device });
  // Browsers get an HttpOnly cookie; the Mac app uses the returned token as a Bearer token.
  send(res, 200, { user: { username: user.username }, token, expires },
    { 'Set-Cookie': sessionCookie(req, token, remember ? auth.REMEMBER_DAYS : null) });
}

async function route(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/health') return send(res, 200, { ok: true, database: usingTurso ? 'turso' : 'local-file' });
  if (p === '/api/register' && m === 'POST') return signIn(req, res, { create: true });
  if (p === '/api/login' && m === 'POST') return signIn(req, res, { create: false });
  if (p === '/api/logout' && m === 'POST') {
    await auth.deleteSession(tokenOf(req).token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }
  if (p === '/api/me' && m === 'GET') {
    const user = await requireUser(req);
    return send(res, 200, { user: { username: user.username } });
  }
  if (p === '/api/sync' && m === 'POST') {
    const user = await requireUser(req);
    const body = await readJson(req);
    const changes = Array.isArray(body.changes) ? body.changes.slice(0, 5000) : [];
    return send(res, 200, await sync(user.id, body.since, changes));
  }

  // --- Google Calendar (web) ---
  if (p === '/api/google/status' && m === 'GET') return send(res, 200, await google.status((await requireUser(req)).id));
  if (p === '/api/google/connect' && m === 'GET') {
    const user = await requireUser(req);
    if (!google.googleConfigured()) throw new HttpError(501, 'Google is not configured on this server.');
    res.writeHead(302, { Location: await google.authUrl(user.id, originOf(req)) });
    return res.end();
  }
  if (p === '/api/google/callback' && m === 'GET') {
    try {
      await google.handleCallback(url.searchParams, originOf(req));
      res.writeHead(302, { Location: '/app/settings?google=connected' });
    } catch (e) {
      res.writeHead(302, { Location: `/app/settings?google=${encodeURIComponent(e.message)}` });
    }
    return res.end();
  }
  if (p === '/api/google/disconnect' && m === 'POST') {
    await google.disconnect((await requireUser(req)).id);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/google/calendars' && m === 'GET') return send(res, 200, await google.calendars((await requireUser(req)).id));
  if (p === '/api/google/events' && m === 'GET') {
    const user = await requireUser(req);
    const ids = (url.searchParams.get('calendars') || '').split(',').filter(Boolean);
    return send(res, 200, await google.events(user.id, ids, url.searchParams.get('from'), url.searchParams.get('to')));
  }
  if (p === '/api/google/import-window' && m === 'GET') {
    const user = await requireUser(req);
    const ids = (url.searchParams.get('calendars') || '').split(',').filter(Boolean);
    return send(res, 200, await google.eventsWithCancelled(user.id, ids, url.searchParams.get('from'), url.searchParams.get('to')));
  }
  if (p === '/api/google/event' && m === 'GET') {
    const user = await requireUser(req);
    return send(res, 200, { event: await google.eventById(user.id, url.searchParams.get('calendar') || 'primary', url.searchParams.get('id')) });
  }
  // Client tells the server which calendars + time zone to use, then we subscribe to push updates.
  if (p === '/api/google/watch' && m === 'POST') {
    const user = await requireUser(req);
    await google.setPreferences(user.id, await readJson(req));
    let watched = 0, error = null;
    try { watched = await google.watch(user.id); } catch (e) { error = e.message; }
    return send(res, 200, { watched, push: watched > 0, error });
  }
  // Google calls this the moment a watched calendar changes.
  if (p === '/api/google/webhook' && m === 'POST') {
    const ch = await google.channelFor(String(req.headers['x-goog-channel-id'] || ''));
    if (!ch || ch.token !== req.headers['x-goog-channel-token']) return send(res, 404, { error: 'Unknown channel' });
    if (req.headers['x-goog-resource-state'] !== 'sync') await importGoogle(ch.user_id).catch(e => console.error('push import', e));
    return send(res, 200, { ok: true });
  }
  // Daily (vercel.json cron): renew subscriptions before they expire and catch up imports.
  if (p === '/api/cron/google' && m === 'GET') {
    if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) throw new HttpError(401, 'Unauthorized');
    const users = (await db.execute('SELECT user_id FROM google_tokens')).rows.map(r => r.user_id);
    const soon = Date.now() + 2 * 86_400_000;
    let renewed = 0, imported = 0;
    for (const u of users) {
      const ch = (await db.execute({ sql: 'SELECT MIN(expiration) AS e FROM google_channels WHERE user_id = ?', args: [u] })).rows[0];
      if (!ch?.e || Number(ch.e) < soon) { try { if (await google.watch(u)) renewed++; } catch { /* token revoked etc. */ } }
      try { await importGoogle(u); imported++; } catch { /* keep going */ }
    }
    return send(res, 200, { users: users.length, renewed, imported });
  }
  if (p === '/api/google/freebusy' && m === 'POST') {
    const user = await requireUser(req);
    const b = await readJson(req);
    return send(res, 200, await google.freeBusy(user.id, b.calendars ?? [], b.from, b.to));
  }
  if (p === '/api/google/events/update' && m === 'POST') {
    const user = await requireUser(req);
    return send(res, 200, await google.updateEvent(user.id, await readJson(req)));
  }
  if (p === '/api/google/events/delete' && m === 'POST') {
    const user = await requireUser(req);
    return send(res, 200, await google.deleteEvent(user.id, await readJson(req)));
  }
  if (p === '/api/google/events' && m === 'POST') {
    const user = await requireUser(req);
    return send(res, 200, await google.createEvent(user.id, await readJson(req)));
  }

  // --- Your data: export and account deletion (promised in the privacy policy) ---
  if (p === '/api/account/export' && m === 'GET') {
    const user = await requireUser(req);
    const u = (await db.execute({ sql: 'SELECT username, created_at FROM users WHERE id = ?', args: [user.id] })).rows[0];
    const rows = (await db.execute({ sql: 'SELECT kind, id, data, updated_at, deleted FROM records WHERE user_id = ? ORDER BY kind, updated_at', args: [user.id] })).rows;
    const live = rows.filter(r => !r.deleted && r.data)
      .map(r => ({ kind: r.kind, value: { ...JSON.parse(r.data), _updatedAt: new Date(Number(r.updated_at)).toISOString() } }));
    const of = kind => live.filter(r => r.kind === kind).map(r => r.value);
    const g = (await db.execute({ sql: 'SELECT email, time_zone, calendar_ids FROM google_tokens WHERE user_id = ?', args: [user.id] })).rows[0];
    const c = await calendly.status(user.id);
    const out = {
      exportedAt: new Date().toISOString(),
      account: { username: u.username, createdAt: new Date(Number(u.created_at)).toISOString() },
      tasks: of('task'),
      reflections: of('reflection'),
      settings: of('settings')[0] ?? null,
      connections: {
        google: g ? { email: g.email, timeZone: g.time_zone, calendars: JSON.parse(g.calendar_ids || '[]') } : null,
        calendly: c.connected ? { name: c.name, schedulingUrl: c.schedulingUrl } : null,
      },
    };
    return send(res, 200, out, { 'Content-Disposition': `attachment; filename="cadence-${u.username}-${new Date().toISOString().slice(0, 10)}.json"` });
  }
  if (p === '/api/account/delete' && m === 'POST') {
    const user = await requireUser(req);
    const { password } = await readJson(req);
    const row = await auth.findUser(user.username);
    if (!row || !(await auth.verifyPassword(String(password || ''), row.password_hash))) throw new HttpError(401, 'Wrong password.');
    await google.disconnect(user.id).catch(() => {});      // revokes Google access + stops push channels
    await calendly.disconnect(user.id).catch(() => {});
    await db.batch([
      { sql: 'DELETE FROM google_channels WHERE user_id = ?', args: [user.id] },
      { sql: 'DELETE FROM google_tokens WHERE user_id = ?', args: [user.id] },
      { sql: 'DELETE FROM oauth_states WHERE user_id = ?', args: [user.id] },
      { sql: 'DELETE FROM records WHERE user_id = ?', args: [user.id] },
      { sql: 'DELETE FROM sessions WHERE user_id = ?', args: [user.id] },
      { sql: 'DELETE FROM login_failures WHERE key LIKE ?', args: [`${row.username.toLowerCase()}|%`] },
      { sql: 'DELETE FROM users WHERE id = ?', args: [user.id] },
    ], 'write');
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  // --- Calendly ---
  if (p === '/api/calendly/status' && m === 'GET') return send(res, 200, await calendly.status((await requireUser(req)).id));
  if (p === '/api/calendly/connect' && m === 'POST') {
    const user = await requireUser(req);
    return send(res, 200, await calendly.connect(user.id, (await readJson(req)).token));
  }
  if (p === '/api/calendly/disconnect' && m === 'POST') {
    await calendly.disconnect((await requireUser(req)).id);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/calendly/event-types' && m === 'GET') return send(res, 200, await calendly.eventTypes((await requireUser(req)).id));
  if (p === '/api/calendly/meetings' && m === 'GET') {
    const user = await requireUser(req);
    return send(res, 200, await calendly.meetings(user.id, url.searchParams.get('from'), url.searchParams.get('to')));
  }

  throw new HttpError(404, 'Not found');
}

/** Handles one API request. `pathname` is the /api/... path. */
export async function handleApi(req, res, pathname) {
  const url = new URL(req.url, 'http://localhost');
  url.pathname = pathname;
  try {
    await ready();
    await route(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status >= 500 && !e.status ? 'Server error' : e.message });
  }
}
