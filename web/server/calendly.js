// Calendly through a per-user Personal Access Token (Calendly › Integrations › API & Webhooks).
// The token is stored server-side; the browser never talks to Calendly directly (no CORS there).
import { db } from './db.js';

const API = 'https://api.calendly.com';

async function ensureTable() {
  await db.execute(`CREATE TABLE IF NOT EXISTS calendly_tokens (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL, user_uri TEXT NOT NULL, name TEXT, scheduling_url TEXT
  )`);
}
let ready;
const init = () => (ready ??= ensureTable());

async function call(token, url) {
  const r = await fetch(url.startsWith('http') ? url : API + url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await r.json().catch(() => ({}));
  if (r.status === 401) throw Object.assign(new Error('Calendly rejected the token. Create a new Personal Access Token and connect again.'), { status: 400 });
  if (!r.ok) throw Object.assign(new Error(json.message || `Calendly returned ${r.status}`), { status: 502 });
  return json;
}

async function row(userId) {
  await init();
  const r = await db.execute({ sql: 'SELECT * FROM calendly_tokens WHERE user_id = ?', args: [userId] });
  return r.rows[0] ?? null;
}

export async function status(userId) {
  const r = await row(userId);
  return r ? { connected: true, name: r.name, schedulingUrl: r.scheduling_url } : { connected: false };
}

export async function connect(userId, token) {
  token = String(token || '').trim();
  if (!token) throw Object.assign(new Error('Paste your Calendly Personal Access Token.'), { status: 400 });
  const me = (await call(token, '/users/me')).resource;
  await init();
  await db.execute({
    sql: `INSERT INTO calendly_tokens (user_id, token, user_uri, name, scheduling_url) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (user_id) DO UPDATE SET token = excluded.token, user_uri = excluded.user_uri,
            name = excluded.name, scheduling_url = excluded.scheduling_url`,
    args: [userId, token, me.uri, me.name ?? null, me.scheduling_url ?? null],
  });
  return { connected: true, name: me.name, schedulingUrl: me.scheduling_url };
}

export async function disconnect(userId) {
  await init();
  await db.execute({ sql: 'DELETE FROM calendly_tokens WHERE user_id = ?', args: [userId] });
}

async function need(userId) {
  const r = await row(userId);
  if (!r) throw Object.assign(new Error('Calendly is not connected.'), { status: 409 });
  return r;
}

export async function eventTypes(userId) {
  const r = await need(userId);
  const out = [];
  let next = `/event_types?user=${encodeURIComponent(r.user_uri)}&count=100`;
  while (next) {
    const page = await call(r.token, next);
    for (const t of page.collection ?? []) {
      if (t.active === false) continue;
      out.push({ id: t.uri, name: t.name, minutes: t.duration, url: t.scheduling_url, color: t.color ?? null });
    }
    next = page.pagination?.next_page ?? null;
  }
  return out;
}

/** Active meetings in [from, to) with invitee names (fetched in parallel). */
export async function meetings(userId, from, to) {
  const r = await need(userId);
  const events = [];
  let next = `/scheduled_events?user=${encodeURIComponent(r.user_uri)}&status=active&count=100&sort=start_time:asc`
    + `&min_start_time=${encodeURIComponent(from)}&max_start_time=${encodeURIComponent(to)}`;
  while (next && events.length < 200) {
    const page = await call(r.token, next);
    events.push(...(page.collection ?? []));
    next = page.pagination?.next_page ?? null;
  }
  return Promise.all(events.map(async e => {
    let invitees = [];
    try { invitees = ((await call(r.token, `${e.uri}/invitees?count=10`)).collection ?? []).map(i => i.name).filter(Boolean); }
    catch { /* names are a nicety */ }
    return {
      uri: e.uri, name: e.name, start: e.start_time, end: e.end_time,
      joinURL: e.location?.join_url ?? null, location: e.location?.location ?? null, invitees,
    };
  }));
}
