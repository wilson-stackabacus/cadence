// A stand-in for the Google Calendar API, for local end-to-end tests without a real Google account.
//   node test/google-mock.js            (listens on 8140)
// Run the dev server with GOOGLE_API_BASE=http://127.0.0.1:8140/calendar/v3 (launch config
// "cadence-web-mockgoogle") and give a test user a fake google_tokens row. Production ignores it.
import { createServer } from 'node:http';
const day = n => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const at = (n, h, m = 0) => { const d = day(n); d.setHours(h, m); return d.toISOString(); };
const ymd = d => d.toISOString().slice(0, 10);
const events = [
  { id: 'mockevt1', status: 'confirmed', summary: 'Dentist (from Google)', start: { dateTime: at(0, 15) }, end: { dateTime: at(0, 16) }, location: 'Main St', htmlLink: 'https://calendar.google.com/x1' },
  { id: 'mockevt2', status: 'confirmed', summary: 'Team sync (from Google)', start: { dateTime: at(1, 10, 30) }, end: { dateTime: at(1, 11) }, htmlLink: 'https://calendar.google.com/x2' },
  { id: 'mockevt3', status: 'confirmed', summary: 'Field trip (from Google)', start: { date: ymd(day(2)) }, end: { date: ymd(day(3)) } },
  { id: 'mockgone', status: 'cancelled' },
];
let nextId = 1;
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = j => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH') { let raw = ''; for await (const c of req) raw += c; try { body = JSON.parse(raw || '{}'); } catch {} }
  // Writes (create / edit / delete), so Cadence → Google sync can be tested too.
  if (req.method === 'POST' && /\/calendars\/[^/]+\/events$/.test(url.pathname)) {
    const e = { id: `created${nextId++}`, status: 'confirmed', summary: body.summary, description: body.description, start: body.start, end: body.end, htmlLink: 'https://calendar.google.com/new' };
    if (body.recurrence) e.recurrence = body.recurrence;
    events.push(e); console.log('CREATE', e.id, e.summary); return send(e);
  }
  const target = url.pathname.match(/\/calendars\/[^/]+\/events\/([^/]+)$/);
  if (target && req.method === 'PATCH') {
    const e = events.find(x => x.id === target[1]); if (!e) { res.writeHead(404); return res.end('{}'); }
    for (const k of ['summary', 'description']) if (k in body) e[k] = body[k];
    if (body.start) e.start = Object.fromEntries(Object.entries(body.start).filter(([, v]) => v != null));
    if (body.end) e.end = Object.fromEntries(Object.entries(body.end).filter(([, v]) => v != null));
    console.log('PATCH', e.id, e.summary); return send(e);
  }
  if (target && req.method === 'DELETE') {
    const e = events.find(x => x.id === target[1]); if (e) { e.status = 'cancelled'; console.log('DELETE', e.id); }
    res.writeHead(204); return res.end();
  }
  if (url.pathname.endsWith('/users/me/calendarList')) return send({ items: [{ id: 'mock@example.com', summary: 'Mock Calendar', primary: true, backgroundColor: '#4285f4', accessRole: 'owner' }] });
  if (/\/calendars\/[^/]+\/events$/.test(url.pathname)) {
    const showDeleted = url.searchParams.get('showDeleted') === 'true';
    return send({ items: events.filter(e => showDeleted || e.status !== 'cancelled') });
  }
  const one = url.pathname.match(/\/calendars\/[^/]+\/events\/([^/]+)$/);
  if (one) { const e = events.find(x => x.id === one[1]); if (e) return send(e); res.writeHead(404); return res.end('{}'); }
  if (url.pathname.endsWith('/freeBusy')) return send({ calendars: { primary: { busy: [{ start: at(0, 15), end: at(0, 16) }] } } });
  res.writeHead(404); res.end('{}');
}).listen(8140, () => console.log('google mock on 8140'));
