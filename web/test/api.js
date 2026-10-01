// API smoke test against a running dev server (npm run dev).
//   node test/api.js [baseUrl]
// Also (re)creates the local dev account in test/dev-account.json with demo tasks.
import { readFileSync } from 'node:fs';
const BASE = process.argv[2] || 'http://localhost:8132';
const dev = JSON.parse(readFileSync(new URL('./dev-account.json', import.meta.url)));
let fail = 0;
const check = (ok, msg) => { console.log(ok ? 'PASS' : 'FAIL', msg); if (!ok) fail++; };

async function call(path, { method = 'GET', body, token, cookie } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})), cookie: r.headers.get('set-cookie') };
}

const u = `t_${Date.now().toString(36)}`;
const pw = 'correct horse battery';
let r = await call('/api/register', { method: 'POST', body: { username: u, password: pw } });
check(r.status === 200 && r.json.token, 'register');
check(/HttpOnly/.test(r.cookie) && /Max-Age=31536000/.test(r.cookie), 'remembered session cookie (1 year, HttpOnly)');
const tokenA = r.json.token;
check((await call('/api/register', { method: 'POST', body: { username: u.toUpperCase(), password: pw } })).status === 409, 'usernames are unique case-insensitively');
check((await call('/api/register', { method: 'POST', body: { username: 'x', password: pw } })).status === 400, 'short username rejected');
check((await call('/api/register', { method: 'POST', body: { username: u + 'b', password: 'short' } })).status === 400, 'short password rejected');
check((await call('/api/login', { method: 'POST', body: { username: u, password: 'wrong password' } })).status === 401, 'wrong password rejected');
r = await call('/api/login', { method: 'POST', body: { username: u, password: pw, remember: false } });
check(r.status === 200 && !/Max-Age/.test(r.cookie), 'login without "keep me signed in" -> session cookie');
const tokenB = r.json.token;
check((await call('/api/me', { token: tokenA })).json.user?.username === u, '/me with bearer token');
check((await call('/api/me', { cookie: `cadence_session=${tokenB}` })).json.user?.username === u, '/me with cookie');
check((await call('/api/me')).status === 401, '/me without auth -> 401');
check((await call('/api/sync', { method: 'POST', body: { since: 0, changes: [] }, cookie: `cadence_session=${tokenB}` })).status === 200, 'same-origin cookie POST allowed');
const cross = await fetch(BASE + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `cadence_session=${tokenB}`, Origin: 'https://evil.example' }, body: '{}' });
check(cross.status === 403, 'cross-origin cookie POST blocked');

// Sync: device A pushes, device B pulls, LWW conflict.
const task = { id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'From A', startDate: '2026-09-30T07:00:00Z' };
r = await call('/api/sync', { method: 'POST', token: tokenA, body: { since: 0, changes: [{ kind: 'task', id: task.id, updatedAt: 1000, data: task }] } });
check(r.json.cursor === 1 && r.json.changes[0].id === task.id.toUpperCase(), 'push assigns version, id normalised to upper case');
r = await call('/api/sync', { method: 'POST', token: tokenB, body: { since: 0, changes: [] } });
check(r.json.changes.length === 1 && r.json.changes[0].data.title === 'From A', 'other device pulls it');
await call('/api/sync', { method: 'POST', token: tokenB, body: { since: 1, changes: [{ kind: 'task', id: task.id, updatedAt: 500, data: { ...task, title: 'Stale' } }] } });
r = await call('/api/sync', { method: 'POST', token: tokenA, body: { since: 0, changes: [] } });
check(r.json.changes[0].data.title === 'From A', 'older edit loses (last-writer-wins)');
r = await call('/api/sync', { method: 'POST', token: tokenB, body: { since: 1, changes: [{ kind: 'task', id: task.id, updatedAt: 2000, deleted: true }] } });
check(r.json.changes.some(c => c.deleted), 'delete propagates as tombstone');
check((await call('/api/logout', { method: 'POST', body: {}, token: tokenB })).status === 200 && (await call('/api/me', { token: tokenB })).status === 401, 'logout revokes session');

// Dev account with demo data for manual testing.
const login = async () => (await call('/api/login', { method: 'POST', body: dev })).json.token
  ?? (await call('/api/register', { method: 'POST', body: dev })).json.token;
const tok = await login();
const pulled = await call('/api/sync', { method: 'POST', token: tok, body: { since: 0, changes: [] } });
if (!pulled.json.changes.length) {
  const day = n => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); };
  const id = () => crypto.randomUUID().toUpperCase();
  const mk = (title, start, timeMinutes, durationMinutes, color, recurrence = {}) => ({
    id: id(), title, notes: '', startDate: day(start), ...(timeMinutes != null ? { timeMinutes } : {}), durationMinutes,
    recurrence: { frequency: 'none', interval: 1, weekdays: [], end: { never: {} }, ...recurrence },
    reminderOffsets: [0], channels: ['notification', 'banner'], color, completions: {}, skipped: [], createdAt: day(-30),
  });
  const tasks = [
    mk('Morning run', -20, 420, 45, 'green', { frequency: 'weekly', weekdays: [2, 4, 6] }),
    mk('Read 20 pages', -30, null, 30, 'purple', { frequency: 'daily' }),
    mk('Stand-up meeting', -14, 600, 15, 'blue', { frequency: 'weekly', weekdays: [2, 3, 4, 5, 6] }),
    mk('Deep work block', -14, 780, 120, 'teal', { frequency: 'weekly', weekdays: [2, 3, 4, 5, 6] }),
    mk('Weekly review', -9, 990, 45, 'orange', { frequency: 'weekly', weekdays: [6] }),
    mk('Call grandma', 0, 1140, 30, 'pink'),
    mk('Submit expense report', -2, null, 30, 'yellow'),
    mk('Plan next sprint', 1, 840, 60, 'blue'),
  ];
  await call('/api/sync', { method: 'POST', token: tok, body: { since: 0, changes: tasks.map(t => ({ kind: 'task', id: t.id, updatedAt: Date.now(), data: t })) } });
  console.log('seeded dev account');
}
console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
