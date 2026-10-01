// Server-side Google Calendar for the web app. Needs a "Web application" OAuth client:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and PUBLIC_URL (e.g. https://cadence.example.com)
// with redirect URI  {PUBLIC_URL}/api/google/callback  registered in Google Cloud Console.
import { randomBytes } from 'node:crypto';
import { db } from './db.js';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'email',
].join(' ');

export const googleConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const redirectUri = origin => `${process.env.PUBLIC_URL || origin}/api/google/callback`;

export async function authUrl(userId, origin) {
  const state = randomBytes(16).toString('base64url');
  await db.execute({ sql: 'DELETE FROM oauth_states WHERE created_at < ?', args: [Date.now() - 10 * 60_000] });
  await db.execute({ sql: 'INSERT INTO oauth_states (state, user_id, created_at) VALUES (?, ?, ?)', args: [state, userId, Date.now()] });
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function postForm(url, form) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(json.error_description || json.error || `HTTP ${r.status}`), { status: r.status });
  return json;
}

export async function handleCallback(params, origin) {
  const state = params.get('state') || '';
  const r = await db.execute({ sql: 'SELECT user_id, created_at FROM oauth_states WHERE state = ?', args: [state] });
  await db.execute({ sql: 'DELETE FROM oauth_states WHERE state = ?', args: [state] });
  const row = r.rows[0];
  if (!row || Date.now() - Number(row.created_at) > 10 * 60_000) throw new Error('Sign-in expired. Try again.');
  const pending = { userId: row.user_id };
  if (params.get('error')) throw new Error(params.get('error'));
  const tok = await postForm('https://oauth2.googleapis.com/token', {
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    code: params.get('code'),
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(origin),
  });
  if (!tok.refresh_token) throw new Error('Google did not return a refresh token.');
  let email = null;
  try {
    const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } });
    email = (await info.json()).email ?? null;
  } catch { /* optional */ }
  await db.execute({
    sql: `INSERT INTO google_tokens (user_id, refresh_token, access_token, expires_at, email) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (user_id) DO UPDATE SET refresh_token = excluded.refresh_token,
            access_token = excluded.access_token, expires_at = excluded.expires_at, email = excluded.email`,
    args: [pending.userId, tok.refresh_token, tok.access_token, Date.now() + (tok.expires_in ?? 3600) * 1000, email],
  });
}

export async function status(userId) {
  const r = await db.execute({ sql: 'SELECT email FROM google_tokens WHERE user_id = ?', args: [userId] });
  return { configured: googleConfigured(), connected: r.rows.length > 0, email: r.rows[0]?.email ?? null };
}

export async function disconnect(userId) {
  const r = await db.execute({ sql: 'SELECT refresh_token FROM google_tokens WHERE user_id = ?', args: [userId] });
  if (r.rows[0]) {
    fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: r.rows[0].refresh_token }),
    }).catch(() => {});
  }
  await db.execute({ sql: 'DELETE FROM google_tokens WHERE user_id = ?', args: [userId] });
}

async function accessToken(userId) {
  const r = await db.execute({ sql: 'SELECT * FROM google_tokens WHERE user_id = ?', args: [userId] });
  const t = r.rows[0];
  if (!t) throw Object.assign(new Error('Google Calendar is not connected.'), { status: 409 });
  if (t.access_token && Number(t.expires_at) > Date.now() + 60_000) return t.access_token;
  try {
    const tok = await postForm('https://oauth2.googleapis.com/token', {
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: t.refresh_token,
      grant_type: 'refresh_token',
    });
    await db.execute({
      sql: 'UPDATE google_tokens SET access_token = ?, expires_at = ? WHERE user_id = ?',
      args: [tok.access_token, Date.now() + (tok.expires_in ?? 3600) * 1000, userId],
    });
    return tok.access_token;
  } catch (e) {
    if (e.status === 400 || e.status === 401) await disconnect(userId);
    throw Object.assign(new Error('Google access was revoked. Connect again in Settings.'), { status: 409 });
  }
}

async function api(userId, method, path, { query, body } = {}) {
  const token = await accessToken(userId);
  const url = new URL(`https://www.googleapis.com/calendar/v3${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(json.error?.message || `Google returned ${r.status}`), { status: 502 });
  return json;
}

const enc = encodeURIComponent;

export async function calendars(userId) {
  const j = await api(userId, 'GET', '/users/me/calendarList');
  return (j.items ?? []).map(c => ({
    id: c.id, summary: c.summaryOverride || c.summary || c.id, primary: Boolean(c.primary),
    colorHex: c.backgroundColor ?? null, canWrite: c.accessRole === 'owner' || c.accessRole === 'writer',
  }));
}

export async function events(userId, calendarIds, timeMin, timeMax) {
  const ids = calendarIds.length ? calendarIds : ['primary'];
  const cals = await calendars(userId).catch(() => []);
  const color = id => cals.find(c => c.id === id || (id === 'primary' && c.primary))?.colorHex ?? null;
  const out = [];
  for (const calId of ids) {
    let pageToken;
    do {
      const j = await api(userId, 'GET', `/calendars/${enc(calId)}/events`, {
        query: { timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', ...(pageToken ? { pageToken } : {}) },
      });
      for (const e of j.items ?? []) {
        if (e.status === 'cancelled' || !e.start) continue;
        const allDay = Boolean(e.start.date);
        out.push({
          id: `${calId}|${e.id}`, calendarID: calId, title: e.summary || '(No title)',
          start: e.start.dateTime || e.start.date, end: e.end?.dateTime || e.end?.date,
          isAllDay: allDay, location: e.location ?? null, link: e.htmlLink ?? null, colorHex: color(calId),
        });
      }
      pageToken = j.nextPageToken;
    } while (pageToken);
  }
  return out;
}

export async function freeBusy(userId, calendarIds, timeMin, timeMax) {
  const ids = calendarIds.length ? calendarIds : ['primary'];
  const j = await api(userId, 'POST', '/freeBusy', { body: { timeMin, timeMax, items: ids.map(id => ({ id })) } });
  return Object.values(j.calendars ?? {}).flatMap(c => c.busy ?? []);
}

export async function createEvent(userId, e) {
  const tz = e.timeZone || 'UTC';
  const body = { summary: e.title, description: e.details ?? '' };
  if (e.allDay) {
    body.start = { date: e.startDate };
    body.end = { date: e.endDate };
  } else {
    body.start = { dateTime: e.start, timeZone: tz };
    body.end = { dateTime: e.end, timeZone: tz };
  }
  if (e.attendees?.length) body.attendees = e.attendees.map(a => ({ email: a.email, displayName: a.name }));
  if (e.rrule) body.recurrence = [e.rrule];
  const query = { sendUpdates: e.attendees?.length ? 'all' : 'none' };
  if (e.addMeetLink) {
    body.conferenceData = { createRequest: { requestId: randomBytes(8).toString('hex'), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    query.conferenceDataVersion = '1';
  }
  const j = await api(userId, 'POST', `/calendars/${enc(e.calendarID || 'primary')}/events`, { query, body });
  return { id: j.id, link: j.htmlLink };
}
