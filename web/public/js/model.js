// Data model shared with the Mac app. Records use the exact JSON the Swift app encodes:
//   PlanTask   { id, title, notes, startDate (ISO, start of local day), timeMinutes?, durationMinutes,
//                recurrence: { frequency, interval, weekdays[1=Sun..7], end: {never:{}} | {onDate:{_0:ISO}} | {afterCount:{_0:n}} },
//                reminderOffsets[], channels[], color, completions{ 'yyyy-MM-dd': ISO }, skipped[], googleEventID?, createdAt, updatedAt? }
//   Reflection { id, taskID, taskTitle, occurrenceKey, text, createdAt }
// Dates are ISO-8601 *without* milliseconds, because Swift's .iso8601 decoder rejects them.

export const iso = d => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const uuid = () => crypto.randomUUID().toUpperCase();

/** Same key → same UUID as the Mac app's stableUUID (SHA-256, v5-style bits). Used for imported events. */
export async function stableUUID(key) {
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const isSilent = task => !(task.channels && task.channels.length);
/** Events live on the calendars only: never on the checklist, no check-off, no reflection.
 *  Imported items (Google, Calendly) are events unless you explicitly make them a task. */
export const isEvent = task => task.kind === 'event' || (task.kind !== 'task' && Boolean(task.source));

// ---------- dates ----------
export const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };
export const addMinutes = (d, n) => new Date(new Date(d).getTime() + n * 60_000);
export const startOfWeek = d => addDays(startOfDay(d), -new Date(d).getDay()); // weeks start Sunday
export const startOfMonth = d => { const x = startOfDay(d); x.setDate(1); return x; };
export const weekday = d => new Date(d).getDay() + 1; // 1 = Sunday … 7 = Saturday (Swift Calendar)
export const sameDay = (a, b) => dateKey(a) === dateKey(b);
export const isToday = d => sameDay(d, new Date());
export const minutesOf = d => new Date(d).getHours() * 60 + new Date(d).getMinutes();
export const dayAt = (day, minutes) => { const x = startOfDay(day); x.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0); return x; };
export const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86_400_000);

export function dateKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
export function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// ---------- formatting ----------
const fmt = (opts) => new Intl.DateTimeFormat(undefined, opts);
export const fmtTime = d => fmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(d));
export const fmtTimeMinutes = m => fmtTime(dayAt(new Date(), m));
export const fmtDay = (d, opts = { weekday: 'long', month: 'long', day: 'numeric' }) => fmt(opts).format(new Date(d));
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function offsetLabel(m) {
  if (m < 0) { const a = -m; return a % 60 === 0 ? `${a / 60} hr into task` : `${a} min into task`; }
  if (m === 0) return 'At start';
  if (m % 1440 === 0) return m === 1440 ? '1 day before' : `${m / 1440} days before`;
  if (m % 60 === 0) return m === 60 ? '1 hour before' : `${m / 60} hours before`;
  return `${m} min before`;
}

export function countWords(text) {
  return String(text).split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
}

// ---------- recurrence ----------
export const FREQUENCIES = [
  ['none', 'Does not repeat', ''], ['daily', 'Daily', 'day'], ['weekly', 'Weekly', 'week'],
  ['monthly', 'Monthly', 'month'], ['yearly', 'Yearly', 'year'],
];

export function endOf(rec) {
  const e = rec.end || { never: {} };
  if (e.onDate) return { type: 'onDate', date: new Date(e.onDate._0) };
  if (e.afterCount) return { type: 'afterCount', count: e.afterCount._0 };
  return { type: 'never' };
}

export const effectiveWeekdays = (rec, start) =>
  (rec.weekdays && rec.weekdays.length ? [...rec.weekdays].sort((a, b) => a - b) : [weekday(start)]);

function matches(task, d, s) {
  const r = task.recurrence;
  const n = Math.max(1, r.interval || 1);
  switch (r.frequency) {
    case 'none': return daysBetween(s, d) === 0;
    case 'daily': return daysBetween(s, d) % n === 0;
    case 'weekly':
      if (!effectiveWeekdays(r, s).includes(weekday(d))) return false;
      return Math.floor(daysBetween(startOfWeek(s), startOfWeek(d)) / 7) % n === 0;
    case 'monthly': {
      if (d.getDate() !== s.getDate()) return false;
      const months = (d.getFullYear() - s.getFullYear()) * 12 + d.getMonth() - s.getMonth();
      return months % n === 0;
    }
    case 'yearly':
      if (d.getDate() !== s.getDate() || d.getMonth() !== s.getMonth()) return false;
      return (d.getFullYear() - s.getFullYear()) % n === 0;
    default: return false;
  }
}

function patternIndex(task, d, s) {
  let count = 0;
  for (let c = s, i = 0; c < d && i < 20000; c = addDays(c, 1), i++) if (matches(task, c, s)) count++;
  return count;
}

export function occurs(task, day) {
  if (task.archived) return false;
  const d = startOfDay(day);
  const s = startOfDay(task.startDate);
  if (d < s) return false;
  const repeating = task.recurrence.frequency !== 'none';
  const end = endOf(task.recurrence);
  if (repeating && end.type === 'onDate' && d > startOfDay(end.date)) return false;
  if (!matches(task, d, s)) return false;
  if (repeating && end.type === 'afterCount' && patternIndex(task, d, s) >= end.count) return false;
  return !(task.skipped || []).includes(dateKey(d));
}

export function nextOccurrence(task, from = new Date()) {
  let day = startOfDay(Math.max(startOfDay(from), startOfDay(task.startDate)));
  for (let i = 0; i < 400; i++) {
    if (occurs(task, day)) return day;
    if (task.recurrence.frequency === 'none') return null;
    day = addDays(day, 1);
  }
  return null;
}

export function recurrenceSummary(rec, start) {
  const n = Math.max(1, rec.interval || 1);
  let s;
  switch (rec.frequency) {
    case 'none': return 'Once';
    case 'daily': s = n === 1 ? 'Every day' : `Every ${n} days`; break;
    case 'weekly': {
      const days = effectiveWeekdays(rec, start);
      if (n === 1 && days.join() === '2,3,4,5,6') s = 'Every weekday';
      else if (n === 1 && days.length === 7) s = 'Every day';
      else s = `${n === 1 ? 'Weekly' : `Every ${n} weeks`} on ${days.map(w => WEEKDAY_SHORT[w - 1]).join(', ')}`;
      break;
    }
    case 'monthly': s = `${n === 1 ? 'Monthly' : `Every ${n} months`} on day ${new Date(start).getDate()}`; break;
    case 'yearly': s = `${n === 1 ? 'Yearly' : `Every ${n} years`} on ${fmtDay(start, { month: 'short', day: 'numeric' })}`; break;
  }
  const e = endOf(rec);
  if (e.type === 'onDate') s += `, until ${fmtDay(e.date, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  if (e.type === 'afterCount') s += `, ${e.count} times`;
  return s;
}

export function rrule(rec, start) {
  if (rec.frequency === 'none') return null;
  const parts = [`FREQ=${rec.frequency.toUpperCase()}`];
  if ((rec.interval || 1) > 1) parts.push(`INTERVAL=${rec.interval}`);
  if (rec.frequency === 'weekly') {
    const codes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    parts.push(`BYDAY=${effectiveWeekdays(rec, start).map(w => codes[w - 1]).join(',')}`);
  }
  const e = endOf(rec);
  if (e.type === 'onDate') {
    const eod = new Date(addDays(startOfDay(e.date), 1) - 1000);
    parts.push(`UNTIL=${iso(eod).replace(/[-:]/g, '')}`);
  }
  if (e.type === 'afterCount') parts.push(`COUNT=${e.count}`);
  return `RRULE:${parts.join(';')}`;
}

// ---------- occurrences ----------
export function makeOccurrence(task, day) {
  const d = startOfDay(day);
  const key = dateKey(d);
  const start = task.timeMinutes != null ? dayAt(d, task.timeMinutes) : null;
  return {
    task, day: d, key,
    id: `${task.id}|${key}`,
    start,
    end: start ? addMinutes(start, Math.max(5, task.durationMinutes || 30)) : null,
    event: isEvent(task),
    done: !isEvent(task) && Boolean(task.completions && task.completions[key]),
    overdue: !isEvent(task) && !(task.completions && task.completions[key]) && d < startOfDay(new Date()),
  };
}

export function sortOccurrences(a, b) {
  const x = a.task.timeMinutes, y = b.task.timeMinutes;
  if (x != null && y != null) return x === y ? a.task.title.localeCompare(b.task.title) : x - y;
  if (x == null && y != null) return 1;
  if (x != null && y == null) return -1;
  return String(a.task.createdAt).localeCompare(String(b.task.createdAt));
}

export function newTask(fields = {}) {
  const now = iso(new Date());
  return {
    id: uuid(), title: '', notes: '', startDate: iso(startOfDay(new Date())),
    durationMinutes: 30,
    recurrence: { frequency: 'none', interval: 1, weekdays: [], end: { never: {} } },
    reminderOffsets: [0], channels: ['notification', 'banner'], color: 'blue',
    completions: {}, skipped: [], createdAt: now,
    ...fields,
  };
}

// ---------- settings (the synced subset; device-only settings live in localStorage) ----------
export const DEFAULT_SETTINGS = {
  nudgeEnabled: true, nudgeIntervalMinutes: 30, nudgeChannels: ['notification', 'banner'], nudgeOnlyWhenIncomplete: true,
  checkInOnLaunch: true, checkInOnWake: true, checkInOnUnlock: true, checkInOnlyWhenIncomplete: false,
  checkInChannels: ['checkIn', 'sound'],
  defaultChannels: ['notification', 'banner'], untimedReminderMinutes: 540, bannerAutoDismissSeconds: 0,
  minReflectionWords: 20, showGoogleEvents: true, googleEventReminderMinutes: 0,
  autoImportCalendars: true, importDaysAhead: 14,
  availability: { weekdays: [2, 3, 4, 5, 6], startMinutes: 540, endMinutes: 1020, bufferMinutes: 10, minNoticeHours: 4, daysAhead: 14 },
  meetingTypes: [
    { id: 'A1B2C3D4-0000-4000-8000-000000000015', name: 'Quick chat', minutes: 15, details: 'A short check-in.', addMeetLink: true },
    { id: 'A1B2C3D4-0000-4000-8000-000000000030', name: 'Meeting', minutes: 30, details: 'A regular 30-minute meeting.', addMeetLink: true },
    { id: 'A1B2C3D4-0000-4000-8000-000000000060', name: 'Deep dive', minutes: 60, details: 'An hour to work through something in depth.', addMeetLink: true },
  ],
};

export const CHANNELS = [
  ['notification', 'Notification', 'Browser / system notification'],
  ['banner', 'On-screen banner', 'A Cadence banner that stays until dismissed'],
  ['sound', 'Sound', 'Play a chime'],
  ['checkIn', 'Checklist window', 'Pop open the daily checklist'],
];

export const COLORS = {
  blue: '#0a84ff', teal: '#30b0c7', green: '#30d158', yellow: '#ffd60a', orange: '#ff9f0a',
  red: '#ff453a', pink: '#ff375f', purple: '#bf5af2', gray: '#8e8e93',
};
