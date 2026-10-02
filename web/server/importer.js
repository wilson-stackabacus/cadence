// Server-side Google import, run when Google pings our webhook (and once a day by cron),
// so calendar changes reach Cadence even when no device is open. Produces exactly the same
// task records as the Mac and web importers (same stable IDs, same fields, user's time zone).
import { db, sync } from './db.js';
import * as google from './google.js';
import { stableUUID, iso, eventNotes } from '../public/js/model.js';

function partsIn(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
const offsetMs = (date, tz) => {
  const p = partsIn(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
};
/** The UTC instant of local midnight on y-m-d in `tz` (DST-safe). */
function midnight(y, m, d, tz) {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(new Date(guess), tz);
  return new Date(guess - offsetMs(new Date(first), tz));
}

export async function toTask(e, tz) {
  const raw = e.id.slice(e.id.indexOf('|') + 1);
  let startDate, timeMinutes, duration = 30;
  if (e.isAllDay) {
    const [y, m, d] = e.start.split('-').map(Number);
    startDate = midnight(y, m, d, tz);
  } else {
    const s = new Date(e.start), p = partsIn(s, tz);
    startDate = midnight(p.y, p.m, p.d, tz);
    timeMinutes = p.h * 60 + p.mi;
    duration = Math.max(5, Math.floor((new Date(e.end) - s) / 60_000));
  }
  return {
    id: await stableUUID(`google:${raw}`), title: e.title, notes: eventNotes(e.description, e.location), startDate: iso(startDate),
    ...(timeMinutes != null ? { timeMinutes } : {}), durationMinutes: duration,
    recurrence: { frequency: 'none', interval: 1, weekdays: [], end: { never: {} } },
    reminderOffsets: [0], channels: [], color: 'blue', completions: {}, skipped: [], createdAt: iso(new Date()),
    source: 'google', googleEventID: raw, sourceCalendar: e.calendarID, ...(e.link ? { externalURL: e.link } : {}),
  };
}

const FIELDS = ['title', 'notes', 'startDate', 'timeMinutes', 'durationMinutes', 'externalURL', 'googleEventID', 'sourceCalendar'];

export async function importGoogle(userId) {
  const tok = (await db.execute({ sql: 'SELECT time_zone, calendar_ids FROM google_tokens WHERE user_id = ?', args: [userId] })).rows[0];
  if (!tok) return { skipped: 'not connected' };
  const settingsRow = (await db.execute({ sql: "SELECT data FROM records WHERE user_id = ? AND kind = 'settings' AND id = 'main'", args: [userId] })).rows[0];
  const settings = settingsRow?.data ? JSON.parse(settingsRow.data) : {};
  if (settings.autoImportCalendars === false) return { skipped: 'imports turned off' };
  const tz = tok.time_zone || 'UTC';
  const days = Math.max(1, Number(settings.importDaysAhead) || 14);
  const p = partsIn(new Date(), tz);
  const from = midnight(p.y, p.m, p.d, tz), to = new Date(+from + days * 86_400_000);

  const { events, cancelled } = await google.eventsWithCancelled(userId, JSON.parse(tok.calendar_ids || '[]'), iso(from), iso(to));
  const items = await Promise.all(events.map(e => toTask(e, tz)));
  const archive = new Set(await Promise.all(cancelled.map(id => stableUUID(`google:${id}`))));

  const rows = (await db.execute({ sql: "SELECT id, data FROM records WHERE user_id = ? AND kind = 'task' AND deleted = 0", args: [userId] })).rows;
  const existing = new Map(rows.map(r => [r.id, JSON.parse(r.data)]));
  // Imported earlier but missing from the window now: moved or deleted. Ask Google about each.
  const seen = new Set([...items.map(i => i.id), ...archive]);
  const stale = [...existing.values()].filter(t => t.source === 'google' && !t.archived && !Object.keys(t.completions || {}).length
    && !seen.has(t.id) && new Date(t.startDate) >= from && new Date(t.startDate) < to && t.googleEventID).slice(0, 25);
  for (const t of stale) {
    const e = await google.eventById(userId, t.sourceCalendar || 'primary', t.googleEventID).catch(() => undefined);
    if (e) items.push(await toTask(e, tz)); else if (e === null) archive.add(t.id);
  }

  const now = Date.now(), stamp = iso(new Date(now));
  const changes = [];
  let added = 0, updated = 0, removed = 0;
  for (const item of items) {
    const cur = existing.get(item.id);
    if (!cur) { changes.push({ kind: 'task', id: item.id, updatedAt: now, data: { ...item, updatedAt: stamp } }); added++; continue; }
    if (cur.archived) continue;
    if (FIELDS.some(f => (cur[f] ?? null) !== (item[f] ?? null))) {
      const next = { ...cur };
      for (const f of FIELDS) { if (item[f] == null) delete next[f]; else next[f] = item[f]; }
      changes.push({ kind: 'task', id: item.id, updatedAt: now, data: { ...next, updatedAt: stamp } }); updated++;
    }
  }
  for (const id of archive) {
    const cur = existing.get(id);
    if (cur && !cur.archived && !Object.keys(cur.completions || {}).length) {
      changes.push({ kind: 'task', id, updatedAt: now, data: { ...cur, archived: true, updatedAt: stamp } }); removed++;
    }
  }
  if (changes.length) await sync(userId, Number.MAX_SAFE_INTEGER, changes);
  return { added, updated, removed };
}
