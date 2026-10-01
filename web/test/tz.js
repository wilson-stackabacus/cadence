// Server importer (explicit time zone) must produce the same task fields as devices (local time zone).
import { toTask } from '../server/importer.js';
import * as M from '../public/js/model.js';
const tz = process.env.TZ;
const events = [
  { id: 'primary|evt1', calendarID: 'primary', title: 'Standup', start: '2026-10-05T16:30:00Z', end: '2026-10-05T17:00:00Z', isAllDay: false, location: null, link: 'https://g.co/x' },
  { id: 'primary|evt2', calendarID: 'primary', title: 'Late call', start: '2026-10-06T05:15:00Z', end: '2026-10-06T06:00:00Z', isAllDay: false, location: 'Zoom', link: null },
  { id: 'primary|evt3', calendarID: 'primary', title: 'Holiday', start: '2026-10-12', end: '2026-10-13', isAllDay: true, location: null, link: null },
  { id: 'primary|evt4', calendarID: 'primary', title: 'DST day', start: '2026-11-01T18:00:00Z', end: '2026-11-01T19:30:00Z', isAllDay: false, location: null, link: null },
];
const device = async e => {
  const st = e.isAllDay ? M.parseKey(e.start) : new Date(e.start), en = e.isAllDay ? M.parseKey(e.end) : new Date(e.end);
  return { id: await M.stableUUID(`google:${e.id.slice(e.id.indexOf('|') + 1)}`), startDate: M.iso(M.startOfDay(st)),
    timeMinutes: e.isAllDay ? undefined : M.minutesOf(st), durationMinutes: e.isAllDay ? 30 : Math.max(5, Math.floor((en - st) / 60_000)) };
};
let ok = true;
for (const e of events) {
  const s = await toTask(e, tz), d = await device(e);
  const same = s.id === d.id && s.startDate === d.startDate && s.timeMinutes === d.timeMinutes && s.durationMinutes === d.durationMinutes;
  ok &&= same;
  console.log(same ? 'PASS' : 'FAIL', tz, e.title, s.startDate, s.timeMinutes, same ? '' : JSON.stringify(d));
}
process.exit(ok ? 0 : 1);
