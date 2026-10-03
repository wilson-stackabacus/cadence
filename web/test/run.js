// Mirrors the Mac app's recurrence checks so both platforms agree.
import { occurs, countWords, rrule, newTask, parseKey, iso, startOfDay, recurrenceSummary, openRanges, isBusy, dayAt } from '../public/js/model.js';
let fail = 0;
const check = (ok, msg) => { console.log(ok ? 'PASS' : 'FAIL', msg); if (!ok) fail++; };
const d = parseKey;
const task = (start, recurrence) => newTask({ startDate: iso(startOfDay(d(start))), recurrence: { interval: 1, weekdays: [], end: { never: {} }, ...recurrence } });

let t = task('2026-09-02', { frequency: 'weekly', weekdays: [2, 4, 6] });
check(occurs(t, d('2026-09-30')), 'weekly Wed');
check(!occurs(t, d('2026-09-29')), 'weekly not Tue');
check(!occurs(t, d('2026-08-31')), 'not before start');
t.recurrence.interval = 2;
check(!occurs(t, d('2026-09-09')) && !occurs(t, d('2026-09-07')) && occurs(t, d('2026-09-14')) && occurs(t, d('2026-09-16')), 'biweekly week parity');
const u = task('2026-09-01', { frequency: 'daily', interval: 3, end: { afterCount: { _0: 4 } } });
check(occurs(u, d('2026-09-10')) && !occurs(u, d('2026-09-13')) && !occurs(u, d('2026-09-11')), 'daily/3 count 4');
const m = task('2026-01-31', { frequency: 'monthly' });
check(occurs(m, d('2026-03-31')) && !occurs(m, d('2026-02-28')), 'monthly 31st');
m.recurrence.end = { onDate: { _0: iso(d('2026-05-01')) } };
check(!occurs(m, d('2026-05-31')), 'until date');
const s = task('2026-09-01', { frequency: 'daily' }); s.skipped = ['2026-09-05'];
check(!occurs(s, d('2026-09-05')) && occurs(s, d('2026-09-06')), 'skip');
check(countWords('Hello, world -- this is 3 words? ...') === 6, 'word count');
check(rrule(t.recurrence, t.startDate) === 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR', 'rrule weekly');
check(rrule(u.recurrence, u.startDate) === 'RRULE:FREQ=DAILY;INTERVAL=3;COUNT=4', 'rrule count');
check(recurrenceSummary({ frequency: 'weekly', interval: 1, weekdays: [2, 3, 4, 5, 6], end: { never: {} } }, new Date()) === 'Every weekday', 'summary');
check(!iso(new Date()).includes('.'), 'ISO has no milliseconds (Swift-compatible)');
check(isBusy({ kind: 'event' }) && !isBusy({}) && isBusy({ source: 'google' }) && !isBusy({ kind: 'event', busy: false }) && isBusy({ busy: true }), 'open/closed defaults');
// Open time: Thu 2026-10-01, open 9–17, 10-minute buffer, a closed 10:00–11:00 and an all-past morning cut at 12:02.
const thu = d('2026-10-01'), hrs = { weekdays: [2, 3, 4, 5, 6], startMinutes: 540, endMinutes: 1020, bufferMinutes: 10 };
const fmtR = r => r.map(([a, b]) => `${new Date(a).getHours()}:${new Date(a).getMinutes()}-${new Date(b).getHours()}:${new Date(b).getMinutes()}`).join(',');
check(fmtR(openRanges(thu, hrs, [[+dayAt(thu, 600), +dayAt(thu, 660)]], 0)) === '9:0-9:50,11:10-17:0', 'open ranges with buffer');
check(fmtR(openRanges(thu, hrs, [], +dayAt(thu, 722))) === '12:5-17:0', 'open ranges skip the past');
check(openRanges(d('2026-10-03'), hrs, [], 0).length === 0, 'no open time on days off');
check(openRanges(thu, hrs, [[+thu, +dayAt(thu, 1440)]], 0).length === 0, 'closed all-day blocks the day');
console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
