// Browser version of the Mac app's ReminderEngine:
// task reminders, Google event reminders, the every-N-minutes checklist nudge,
// and a check-in when the computer is "opened" (page load, wake from sleep, return after being away).
import * as M from './model.js';
import { store } from './store.js';

export class Reminders {
  constructor(ui) {
    this.ui = ui;                 // { banner(content), checkIn(title), openChecklist() }
    this.lastTick = Date.now() - 60_000;
    this.lastNudge = Date.now();
    this.lastCheckIn = 0;
    this.fired = new Set(JSON.parse(sessionStorage.getItem('cadence:fired') || '[]'));
    this.hiddenSince = document.hidden ? Date.now() : null;
  }

  get enabled() { return store.device('browserReminders', true); }
  get nextNudge() { return new Date(this.lastNudge + store.settings.nudgeIntervalMinutes * 60_000); }

  start() {
    setInterval(() => this.tick(), 15_000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.hiddenSince = Date.now(); return; }
      const away = this.hiddenSince ? Date.now() - this.hiddenSince : 0;
      this.hiddenSince = null;
      // Coming back to the tab after a while is the browser's version of "unlocking the computer".
      if (away > 10 * 60_000 && store.settings.checkInOnUnlock) this.checkIn('Welcome back — check your list');
    });
    if (store.settings.checkInOnLaunch) setTimeout(() => this.checkIn('Time to check in'), 800);
    this.tick();
  }

  checkIn(title, { manual = false } = {}) {
    if (!store.user) return;
    const now = Date.now();
    if (!manual && (!this.enabled || now - this.lastCheckIn < 90_000)) return;
    const remaining = store.remainingToday();
    if (!manual && store.settings.checkInOnlyWhenIncomplete && remaining === 0) return;
    this.lastCheckIn = now;
    this.lastNudge = now;
    const channels = new Set(store.settings.checkInChannels);
    if (manual) channels.add('checkIn');
    this.deliver({
      kind: 'checkIn', title,
      body: remaining === 0 ? "Everything on today's checklist is done." : `${remaining} item${remaining === 1 ? '' : 's'} left on today's checklist.`,
      tint: '#ff9f0a',
    }, channels);
  }

  deliver(content, channels) {
    channels = new Set(channels);
    const canNotify = 'Notification' in window && Notification.permission === 'granted';
    if (channels.has('notification') && !canNotify) channels.add('banner');
    if (channels.has('notification') && canNotify) {
      const n = new Notification(content.title, { body: content.body, icon: '/icon-192.png', tag: content.tag, silent: !channels.has('sound') });
      n.onclick = () => { window.focus(); this.ui.openChecklist(content.occurrence); n.close(); };
    }
    if (channels.has('sound')) chime();
    if (channels.has('banner')) this.ui.banner(content);
    if (channels.has('checkIn')) this.ui.checkIn(content.title);
  }

  tick() {
    const now = Date.now();
    // Timers stop while the computer sleeps; a big gap means it just woke up.
    if (now - this.lastTick > 3 * 60_000 && store.settings.checkInOnWake) {
      this.lastNudge = now;
      setTimeout(() => this.checkIn('Welcome back — check your list'), 1500);
    }
    const windowStart = Math.max(this.lastTick, now - 15 * 60_000);
    this.lastTick = now;
    if (!store.user || !this.enabled) return;
    const s = store.settings;
    const due = (at, key) => {
      const t = +at;
      if (t <= windowStart || t > now || this.fired.has(key)) return false;
      this.fired.add(key);
      sessionStorage.setItem('cadence:fired', JSON.stringify([...this.fired].slice(-500)));
      return true;
    };

    for (const off of [-1, 0, 1]) {
      const day = M.addDays(M.startOfDay(new Date()), off);
      for (const occ of store.occurrencesOn(day)) {
        if (occ.done || M.isSilent(occ.task)) continue;
        const base = occ.start ?? M.dayAt(day, s.untimedReminderMinutes);
        for (const o of [...(occ.task.reminderOffsets || [])].sort((a, b) => a - b)) {
          if (!due(M.addMinutes(base, -o), `${occ.id}|${o}`)) continue;
          this.deliver(reminderContent(occ, o), occ.task.channels);
        }
      }
    }

    if (s.googleEventReminderMinutes > 0) {
      for (const ev of store.googleEventsOn(new Date())) {
        if (ev.isAllDay) continue;
        if (due(M.addMinutes(ev.startDate, -s.googleEventReminderMinutes), `g|${ev.id}|${+ev.startDate}`)) {
          this.deliver({ kind: 'event', title: ev.title, body: `Starts at ${M.fmtTime(ev.startDate)}${ev.location ? ` · ${ev.location}` : ''}`, tint: '#0a84ff' }, s.defaultChannels);
        }
      }
    }

    if (s.nudgeEnabled && now - this.lastNudge >= s.nudgeIntervalMinutes * 60_000) {
      this.lastNudge = now;
      const open = store.todayChecklist().filter(o => !o.done && !M.isSilent(o.task));
      if (open.length || !s.nudgeOnlyWhenIncomplete) {
        const names = open.slice(0, 3).map(o => o.task.title).join(', ') + (open.length > 3 ? ` +${open.length - 3} more` : '');
        this.deliver(open.length
          ? { kind: 'nudge', title: `Checklist check — ${open.length} left`, body: names, tint: '#5e5ce6', tag: 'nudge' }
          : { kind: 'nudge', title: 'Checklist check', body: 'All done for today. Nice work.', tint: '#30d158', tag: 'nudge' },
        s.nudgeChannels);
      }
    }
  }
}

function reminderContent(occ, offset) {
  let body;
  if (occ.start) {
    body = offset < 0 ? `Check-in: ${M.offsetLabel(offset)} (until ${M.fmtTime(occ.end)})`
      : offset === 0 ? `Starting now (${M.fmtTime(occ.start)})` : `At ${M.fmtTime(occ.start)} — ${M.offsetLabel(offset)}`;
  } else {
    body = offset >= 1440 ? `Coming up ${M.fmtDay(occ.day, { weekday: 'long' })}` : "On today's checklist";
  }
  return { kind: 'task', title: occ.task.title, body: `${body}. Check it off with a reflection when you're done.`,
    tint: M.COLORS[occ.task.color] || '#0a84ff', occurrence: occ, tag: occ.id };
}

let audio;
export function chime() {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    for (const [i, f] of [880, 1320].entries()) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.6);
      o.connect(g).connect(audio.destination);
      o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.65);
    }
  } catch { /* audio unavailable until the user interacts with the page */ }
}
