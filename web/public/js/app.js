// Cadence web app: renders every screen as HTML strings and handles events by delegation.
import * as M from './model.js';
import { store } from './store.js';
import { Reminders, chime } from './reminders.js';

// ---------- tiny helpers ----------
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#${name}"/></svg>`;
const color = c => M.COLORS[c] || c || '#0a84ff';
const tint = (hex, a) => `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const HOUR = 48;

const SCREENS = [
  ['home', 'Home', 'house', ''],
  ['today', 'Today', 'sun', 'Plan'], ['week', 'Week', 'week', 'Plan'], ['month', 'Month', 'month', 'Plan'],
  ['todo', 'To-Do List', 'list', 'Plan'], ['reflections', 'Reflections', 'quote', 'Grow'],
  ['booking', 'Booking', 'people', 'Connect'], ['settings', 'Settings', 'gear', ''],
];

const ui = {
  route: 'home',
  weekStart: M.startOfWeek(new Date()),
  month: M.startOfMonth(new Date()),
  selectedDay: M.startOfDay(new Date()),
  todo: { mode: 'checklist', range: 7, showCompleted: true, search: '' },
  reflSearch: '',
  booking: { busy: [], loading: false, message: null, loadedFor: null, week: [] },
  modal: null,
  auth: { mode: 'login', error: null, busy: false },
  flash: null,
  weekScrolled: false,
  justDone: new Set(),     // occurrence ids that were just checked off (pop animation)
  lastRoute: null,
  modalFresh: false,
};

const ringPrev = new Map(); // ring key -> last drawn fraction, so rings animate between values

const reminders = new Reminders({
  banner: content => showBanner(content),
  checkIn: title => openModal({ type: 'checkin', title, reflecting: null }),
  openChecklist: occ => {
    if (occ && !occ.done) beginReflection(occ);
    else navigate('today');
  },
});

// ---------- routing ----------
// Clean URLs: /app/<screen>. Old #screen links are upgraded in place.
function readRoute() {
  const legacy = location.hash.replace(/^#/, '').split('?')[0];
  if (legacy && SCREENS.some(s => s[0] === legacy)) history.replaceState(null, '', `/app/${legacy}`);
  const route = (location.pathname.match(/^\/app\/?([^/]*)/) || [])[1] || 'home';
  ui.route = SCREENS.some(s => s[0] === route) ? route : 'home';
  const params = new URLSearchParams(location.search);
  const google = params.get('google');
  if (google) {
    ui.flash = google === 'connected' ? 'Google Calendar connected.' : `Google: ${google}`;
    history.replaceState(null, '', '/app/settings');
    store.refreshGoogle();
  }
  if (params.get('mode') === 'register') { ui.auth.mode = 'register'; history.replaceState(null, '', location.pathname); }
}

function navigate(route) {
  const path = route === 'home' ? '/app' : `/app/${route}`;
  if (location.pathname !== path) history.pushState(null, '', path);
  readRoute();
  render();
}
addEventListener('popstate', () => { readRoute(); render(); });

// ---------- rendering ----------
let booted = false;

// Never swap the DOM between mouse-down and mouse-up: the browser would drop the click.
// Updates that arrive mid-click (e.g. a sync kicked off by the window regaining focus) wait until it's done.
let pointerDown = false, renderPending = false;
addEventListener('pointerdown', () => { pointerDown = true; }, true);
const releasePointer = () => {
  pointerDown = false;
  if (renderPending) { renderPending = false; setTimeout(render, 0); }
};
addEventListener('pointerup', releasePointer, true);
addEventListener('pointercancel', releasePointer, true);

function render() {
  const app = $('#app');
  if (!booted) return;
  if (pointerDown) { renderPending = true; return; }
  if (!store.user) { app.innerHTML = authView(); return; }

  const active = document.activeElement;
  const focusId = active?.id;
  const sel = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const scroll = $('#main')?.scrollTop ?? 0;
  const weekScroll = $('#weekScroll')?.scrollTop;

  const routeChanged = ui.lastRoute !== ui.route;
  ui.lastRoute = ui.route;
  app.innerHTML = `<div class="shell">${sidebar()}<main id="main" class="${routeChanged ? 'enter' : ''}">${view()}</main></div>`;
  updateSyncUI();
  animateRings();

  if (ui.route !== 'week') $('#main').scrollTop = scroll;
  const ws = $('#weekScroll');
  if (ws) ws.scrollTop = weekScroll ?? (ui.weekScrolled ? ws.scrollTop : 7 * HOUR);
  ui.weekScrolled = Boolean(ws);
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) { el.focus(); if (sel) try { el.setSelectionRange(...sel); } catch { /* not a text input */ } }
  }
  if (ui.modal && ['checkin', 'detail'].includes(ui.modal.type) && !ui.modal.reflecting) renderModal();
}

function sidebar() {
  let lastSection = null;
  const items = SCREENS.map(([id, label, icon, section]) => {
    let head = '';
    if (section !== lastSection) { head = section ? `<div class="nav-section">${section}</div>` : id === 'home' ? '' : '<div class="nav-section"></div>'; lastSection = section; }
    const badge = id === 'today' ? store.remainingToday() : id === 'reflections' ? store.reflections.size : '';
    return `${head}<a class="nav-item ${ui.route === id ? 'on' : ''}" href="${id === 'home' ? '/app' : `/app/${id}`}" title="${label} (${SHORTCUT_FOR[id]})">${ic(icon)}<span class="lbl">${label}</span>${badge ? `<span class="badge">${badge}</span>` : ''}</a>`;
  }).join('');
  return `<nav class="sidebar">
    <div class="brand"><img src="/icon-192.png" alt=""><span>Cadence</span></div>
    ${items}
    <div class="spacer"></div>
    <div class="new-btns"><button class="btn primary" data-act="new-task" title="New task (N)">${ic('plus')} New Task</button>
      <button class="btn" data-act="new-event" title="New event (E)">${ic('cal')} New Event</button></div>
    <div class="account">
      <div class="row"><b class="grow ellipsis">${esc(store.user.username)}</b>
        <button class="btn ghost sm icon" data-act="sign-out" title="Sign out">${ic('logout')}</button></div>
      ${syncControl()}
    </div>
  </nav>`;
}

function view() {
  switch (ui.route) {
    case 'week': return weekView();
    case 'month': return monthView();
    case 'todo': return todoView();
    case 'reflections': return reflectionsView();
    case 'booking': return bookingView();
    case 'settings': return settingsView();
    case 'today': return todayView();
    default: return homeView();
  }
}

// ---------- shared bits ----------
function ring(done, total, size = 72, width = 8, key = `ring${size}`) {
  const r = (size - width) / 2, c = 2 * Math.PI * r;
  const f = total ? done / total : 1;
  const from = ringPrev.has(key) ? ringPrev.get(key) : f;
  ringPrev.set(key, f);
  return `<div class="ring" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--line-strong)" stroke-width="${width}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${f >= 1 ? 'var(--green)' : 'var(--accent)'}" stroke-width="${width}" stroke-linecap="round"
      stroke-dasharray="${c}" class="ring-arc" style="stroke-dashoffset:${c * (1 - from)}" data-to="${c * (1 - f)}"/></svg>
    ${size >= 44 ? `<div class="lbl" style="font-size:${size * 0.24}px">${total ? `${done}/${total}` : '–'}</div>` : ''}</div>`;
}

function crow(o, { compact = false, showDate = false, ctx = '' } = {}) {
  const t = o.task;
  const meta = [];
  if (showDate || o.overdue) meta.push(`<span class="${o.overdue ? 'red' : ''}">${M.fmtDay(o.day, { weekday: 'short', month: 'short', day: 'numeric' })}</span>`);
  meta.push(o.start ? `<span>${ic('clock')}${M.fmtTime(o.start)}</span>` : compact ? '' : `<span>${ic('sun')}Any time</span>`);
  if (t.recurrence.frequency !== 'none' && !compact) meta.push(`<span>${ic('repeat')}${esc(M.recurrenceSummary(t.recurrence, t.startDate))}</span>`);
  if (o.overdue) meta.push('<span class="red"><b>Overdue</b></span>');
  if (t.source === 'calendly') meta.push(`<span>${ic('people')}Calendly</span>`);
  if (t.source === 'google') meta.push(`<span>${ic('cal')}Google</span>`);
  if (M.isSilent(t)) meta.push(`<span title="No notifications">${ic('bell-off')}</span>`);
  if (t.externalURL && !compact) meta.push(`<a href="${esc(t.externalURL)}" target="_blank" rel="noopener" title="Open meeting link">${ic('link')}</a>`);
  const hasRefl = o.done && store.reflectionFor(o);
  return `<div class="crow ${o.done ? 'done' : ''} ${ui.justDone.has(o.id) ? 'just-done' : ''}">
    <button class="checkbtn" style="${o.done ? `color:${color(t.color)}` : ''}" data-act="toggle" data-occ="${esc(o.id)}" data-ctx="${ctx}"
      title="${o.done ? 'Mark as not done' : 'Complete — you’ll write a short reflection first'}">${ic(o.done ? 'checked' : 'circle')}</button>
    ${compact ? '' : `<span class="bar" style="background:${color(t.color)}"></span>`}
    <div class="grow"><div class="title ellipsis">${esc(t.title)}</div><div class="meta">${meta.join('')}</div></div>
    ${hasRefl ? `<span class="muted" title="Reflection saved">${ic('quote')}</span>` : ''}
    ${ctx === 'checkin' ? '' : `<div class="actions">
      <button class="btn ghost sm" data-act="edit" data-task="${t.id}">Edit</button>
      ${t.recurrence.frequency !== 'none' ? `<button class="btn ghost sm" data-act="skip" data-occ="${esc(o.id)}" title="Skip this occurrence">Skip</button>` : ''}
    </div>`}
  </div>`;
}

function findOcc(id) {
  const [taskId, key] = id.split('|');
  const t = store.tasks.get(taskId);
  return t ? M.makeOccurrence(t, M.parseKey(key)) : null;
}

function empty(icon, title, text) {
  return `<div style="text-align:center;padding:48px 16px" class="muted">
    <div style="font-size:36px">${ic(icon)}</div><div style="font-size:17px;font-weight:650;color:var(--text);margin:6px 0">${esc(title)}</div>${esc(text)}</div>`;
}

// ---------- Home (in-app dashboard) ----------
function homeView() {
  const now = new Date();
  const all = store.todayChecklist();
  const done = all.filter(o => o.done).length;
  const open = all.filter(o => !o.done);
  const hour = now.getHours();
  const greet = hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 17 ? 'Good afternoon' : 'Good evening';
  const weekStart = M.startOfWeek(now);
  const weekCount = [...Array(7)].reduce((n, _, i) => n + store.tasksOn(M.addDays(weekStart, i)).length, 0);
  const overdue = store.overdue().length;
  const latest = store.sortedReflections()[0];
  const nextTimed = [...store.occurrencesOn(now), ...store.occurrencesOn(M.addDays(now, 1))]
    .filter(o => !o.done && o.start && o.start > now).sort((a, b) => a.start - b.start)[0];
  const nextEvent = store.googleEventsOn(now).find(e => !e.isAllDay && e.startDate > now);
  const upNext = [nextTimed && { title: nextTimed.task.title, at: nextTimed.start, color: color(nextTimed.task.color) },
    nextEvent && { title: nextEvent.title, at: nextEvent.startDate, color: nextEvent.colorHex || '#0a84ff' }]
    .filter(Boolean).sort((a, b) => a.at - b.at)[0];
  const ss = store.syncState;
  const tile = (route, icon, title, value, sub, hue) => `<a class="tile" href="/app/${route}" style="--hue:${hue}">
    <span class="tile-ic">${ic(icon)}</span><span class="tile-title">${title}</span>
    <span class="tile-value">${value}</span><span class="tile-sub">${sub}</span></a>`;
  return `<div class="page stack" style="padding-top:28px;max-width:980px">
    <div class="hero"><div class="grow">
      <div class="muted" style="font-size:17px">${greet}${store.user ? `, ${esc(store.user.username)}` : ''}</div>
      <h2>${M.fmtDay(now)}</h2>
      <div class="muted">${!all.length ? 'Nothing on your checklist today.' : done === all.length ? 'Everything is checked off. Nice work.' : `${open.length} thing${open.length === 1 ? '' : 's'} left today.`}</div></div>
      <div class="row"><button class="btn" data-act="check-in">${ic('sun')} Check in</button><button class="btn" data-act="new-event">${ic('cal')} New event</button><button class="btn primary" data-act="new-task">${ic('plus')} New task</button></div></div>

    <div class="home-grid">
      <a class="card pad home-today" href="/app/today">
        <div class="row" style="gap:16px">${ring(done, all.length, 76, 9, 'home')}
          <div class="grow"><div class="section-title" style="margin:0">${ic('sun')}Today</div>
          <div class="muted small">${all.length ? `${done} of ${all.length} done` : 'A clear day'}${overdue ? ` · <span class="red">${overdue} overdue</span>` : ''}</div></div>
          <span class="muted">${ic('right')}</span></div>
        ${open.length ? `<div class="home-list">${open.slice(0, 4).map(o => `<div class="row small"><span style="width:7px;height:7px;border-radius:50%;background:${color(o.task.color)}"></span>
          <span class="grow ellipsis">${esc(o.task.title)}</span><span class="muted">${o.start ? M.fmtTime(o.start) : o.overdue ? 'overdue' : 'any time'}</span></div>`).join('')}
          ${open.length > 4 ? `<div class="small muted">+${open.length - 4} more</div>` : ''}</div>` : ''}
      </a>
      <div class="card pad home-next">
        <div class="section-title" style="margin:0 0 6px">${ic('clock')}Up next</div>
        ${upNext ? `<div class="row"><span style="width:4px;align-self:stretch;border-radius:2px;background:${upNext.color}"></span>
          <div><div style="font-weight:600">${esc(upNext.title)}</div><div class="muted small">${M.isToday(upNext.at) ? '' : 'Tomorrow · '}${M.fmtTime(upNext.at)}</div></div></div>`
          : '<div class="muted small">Nothing else scheduled with a time.</div>'}
        <div class="section-title" style="margin:14px 0 6px">${ic('quote')}Latest reflection</div>
        ${latest ? `<div class="small" style="font-style:italic">“${esc(latest.text.length > 140 ? latest.text.slice(0, 140) + '…' : latest.text)}”</div>
          <div class="tiny muted" style="margin-top:4px">${esc(latest.taskTitle)}</div>` : '<div class="muted small">Check something off to write your first one.</div>'}
      </div>
    </div>

    <div class="tiles">
      ${tile('week', 'week', 'Week', weekCount, 'tasks this week', '#0a84ff')}
      ${tile('month', 'month', 'Month', M.fmtDay(now, { month: 'short' }), 'see the whole month', '#30b0c7')}
      ${tile('todo', 'list', 'To-Do List', store.tasks.size ? [...store.tasks.values()].filter(t => !t.archived).length : 0, overdue ? `${overdue} overdue` : 'all your tasks', '#ff9f0a')}
      ${tile('reflections', 'quote', 'Reflections', store.reflections.size, store.reflectionStreak ? `${store.reflectionStreak}-day streak` : 'your record', '#5e5ce6')}
      ${tile('booking', 'people', 'Open time', durLabel(openTimeDays().reduce((n, d) => n + d.total, 0)), 'free in the next 7 days', '#30d158')}
      ${tile('settings', 'gear', 'Settings', ss.status === 'synced' ? 'Synced' : ss.status === 'offline' ? 'Offline' : '—', store.google.connected ? 'Google connected' : 'reminders & sync', '#8e8e93')}
    </div>
  </div>`;
}

// ---------- Events (calendar-only items: your own + imported + Google) ----------
function scheduleOn(day) {
  const list = [
    ...store.eventsOn(day).map(o => ({ id: `t|${o.id}`, title: o.task.title, start: o.start, end: o.end, allDay: !o.start,
      color: color(o.task.color), source: o.task.source, link: o.task.externalURL, notes: o.task.notes, silent: M.isSilent(o.task), busy: o.busy })),
    ...store.googleEventsOn(day).map(e => ({ id: `g|${e.id}`, title: e.title, start: e.isAllDay ? null : e.startDate, end: e.isAllDay ? null : e.endDate,
      allDay: e.isAllDay, color: e.colorHex || '#0a84ff', source: 'google', link: e.link, notes: e.location, busy: !e.transparent })),
  ];
  return list.sort((a, b) => (a.allDay === b.allDay ? (a.start || 0) - (b.start || 0) : a.allDay ? -1 : 1));
}

function eventRow(ev) {
  const src = ev.source === 'calendly' ? `<span>${ic('people')}Calendly</span>` : ev.source === 'google' ? `<span>${ic('cal')}Google</span>` : '';
  return `<div class="crow erow" data-act="detail" data-item="${esc(ev.id)}">
    <span class="evt-time">${ev.allDay ? 'All day' : `${M.fmtTime(ev.start)}<small>${M.fmtTime(ev.end)}</small>`}</span>
    <span class="bar ${ev.busy === false ? 'free' : ''}" style="--hue:${ev.color};background:${ev.color}"></span>
    <div class="grow"><div class="title ellipsis">${esc(ev.title)}</div><div class="meta">${src}${ev.busy === false ? `<span title="Open: just for info">${ic('eye')}Open</span>` : ''}${ev.notes ? `<span class="ellipsis">${esc(ev.notes)}</span>` : ''}${ev.silent === false ? `<span title="Reminds you">${ic('bell')}</span>` : ''}</div></div>
    ${ev.link ? `<a href="${esc(ev.link)}" target="_blank" rel="noopener" title="Open">${ic('link')}</a>` : ''}
  </div>`;
}

// ---------- Today ----------
function todayView() {
  const today = new Date();
  const items = store.tasksOn(today), overdue = store.overdue(), all = [...overdue, ...items];
  const done = all.filter(o => o.done).length;
  const hour = today.getHours();
  const greet = hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 17 ? 'Good afternoon' : 'Good evening';
  const status = !all.length ? 'A clear day.' : done === all.length ? 'Everything is checked off. Nice work.' : `${all.length - done} of ${all.length} left to check off.`;
  const events = scheduleOn(today);
  const s = store.settings;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  return `<div class="page stack" style="padding-top:28px">
    <div class="hero"><div class="grow">
      <div class="muted" style="font-size:17px">${greet}</div>
      <h2>${M.fmtDay(today)}</h2><div class="muted">${status}</div></div>${ring(done, all.length, 80, 9)}</div>
    ${perm === 'default' && reminders.enabled ? `<div class="callout warn"><span class="big">${ic('bell')}</span>
      <div class="grow"><b>Turn on notifications</b><div class="small muted">So reminders reach you even when this tab is in the background.</div></div>
      <button class="btn primary" data-act="ask-notify">Allow</button></div>` : ''}
    <form class="quickadd" data-form="quick">${ic('plus')}<input id="quickAdd" placeholder="Quick add to today — press Return" autocomplete="off"></form>
    ${overdue.length ? `<div><div class="section-title">${ic('alert')}Overdue <span class="count">${overdue.length}</span></div>
      <div class="card">${overdue.map(o => crow(o)).join('')}</div></div>` : ''}
    <div><div class="section-title">${ic('list')}Today’s checklist <span class="count">${items.length}</span></div>
      <div class="card">${items.length ? items.map(o => crow(o)).join('')
        : `<div class="crow"><span style="font-size:22px;color:var(--orange)">${ic('sun')}</span><div><div>Nothing scheduled for today.</div><div class="small muted">Add a task above, or use New Task for one with a time and repeat schedule.</div></div></div>`}</div>
      <div class="small muted" style="margin-top:6px">Checking an item off asks for a reflection of at least ${s.minReflectionWords} words. They’re saved under Reflections.</div></div>
    <div><div class="section-title">${ic('cal')}Schedule <span class="count">${events.length}</span><span class="grow"></span>
      <button class="btn sm" data-act="new-event">${ic('plus')} New event</button></div>
      <div class="card">${events.length ? events.map(eventRow).join('') : '<div class="crow muted">No events today. Events show on your calendars but never on the checklist.</div>'}</div></div>
    <div class="callout"><span class="big">${ic('bell')}</span><div class="grow">
      <b>${s.nudgeEnabled ? `Checklist reminder every ${s.nudgeIntervalMinutes} min while this page is open` : 'Recurring checklist reminders are off'}</b>
      <div class="small muted">${!reminders.enabled ? 'Browser reminders are off on this device (Settings).' : s.nudgeEnabled ? `Next one around ${M.fmtTime(reminders.nextNudge)}. You’ll also get a check-in when you come back to your computer.` : 'Turn them on in Settings.'}</div></div>
      <button class="btn" data-act="check-in">Check in now</button></div>
  </div>`;
}

// ---------- Week ----------
function calItemsTimed(day) {
  const items = [];
  for (const o of store.occurrencesOn(day)) if (o.start) items.push({ kind: o.event ? 'event' : 'task', o, start: o.start, end: o.end, title: o.task.title, color: color(o.task.color), done: o.done, id: `t|${o.id}` });
  for (const e of store.googleEventsOn(day)) if (!e.isAllDay) items.push({ kind: 'google', e, start: e.startDate, end: e.endDate, title: e.title, color: e.colorHex || '#0a84ff', done: false, id: `g|${e.id}` });
  items.sort((a, b) => a.start - b.start || b.end - a.end);
  // Greedy lanes inside clusters of overlapping items.
  const out = []; let cluster = [], laneEnds = [], clusterEnd = 0;
  const flush = () => { for (const p of cluster) p.lanes = Math.max(1, laneEnds.length); out.push(...cluster); cluster = []; laneEnds = []; };
  for (const p of items) {
    if (p.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex(e => e <= p.start);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(p.end); } else laneEnds[lane] = p.end;
    p.lane = lane; cluster.push(p); clusterEnd = Math.max(clusterEnd, +p.end);
  }
  flush();
  return out;
}

const chipFor = it => `<div class="chip ${it.done ? 'done' : ''}" style="background:${tint(it.color, it.kind === 'task' ? .18 : .12)}" data-act="detail" data-item="${esc(it.id)}">
  ${it.kind !== 'task' ? `<span style="color:${it.color}">${ic('cal')}</span>` : `<span class="dot" style="border-color:${it.color};background:${it.done ? it.color : 'transparent'}"></span>`}
  <span>${it.start && it.kind !== 'allday' ? `<span class="muted">${M.fmtTime(it.start)}</span> ` : ''}${esc(it.title)}</span></div>`;

function allDayItems(day) {
  return [
    ...store.occurrencesOn(day).filter(o => !o.start).map(o => ({ kind: o.event ? 'event' : 'task', o, title: o.task.title, color: color(o.task.color), done: o.done, id: `t|${o.id}` })),
    ...store.googleEventsOn(day).filter(e => e.isAllDay).map(e => ({ kind: 'google', e, title: e.title, color: e.colorHex || '#0a84ff', id: `g|${e.id}` })),
  ];
}

function weekView() {
  const days = [...Array(7)].map((_, i) => M.addDays(ui.weekStart, i));
  store.ensureGoogle(days[0], M.addDays(days[6], 1));
  const end = days[6];
  const title = `${M.fmtDay(days[0], { month: 'short', day: 'numeric' })} – ${M.fmtDay(end, { month: days[0].getMonth() === end.getMonth() ? undefined : 'short', day: 'numeric' })}, ${end.getFullYear()}`;
  const now = new Date();
  return `<div class="week">
    <div class="header"><div class="grow"><h1>${title}</h1><div class="sub">Double-click an empty slot — or inside an existing block — to add a task at that time.</div></div>
      <div class="row"><button class="btn" data-act="new-event">${ic('cal')} New event</button><button class="btn icon" data-act="week-prev" title="Previous week">${ic('left')}</button>
      <button class="btn" data-act="week-today">Today</button><button class="btn icon" data-act="week-next" title="Next week">${ic('right')}</button></div></div>
    <div class="week-head"><div></div>${days.map(d => {
      const open = store.tasksOn(d).filter(o => !o.done).length;
      return `<div class="d ${M.isToday(d) ? 'today' : ''}"><div class="dow">${M.WEEKDAY_SHORT[d.getDay()].toUpperCase()}</div><div class="num">${d.getDate()}</div><div class="open">${open ? `${open} open` : ''}</div></div>`;
    }).join('')}</div>
    <div class="week-allday"><div class="lab">any<br>time</div>${days.map(d => {
      const items = allDayItems(d);
      return `<div class="cell">${items.slice(0, items.length > 4 ? 3 : 4).map(chipFor).join('')}${items.length > 4 ? `<div class="more">+${items.length - 3} more</div>` : ''}</div>`;
    }).join('')}</div>
    <div class="week-scroll" id="weekScroll"><div class="week-grid" style="height:${24 * HOUR}px">
      <div class="hours">${[...Array(24)].map((_, h) => `<div class="h">${h ? M.fmtTimeMinutes(h * 60) : ''}</div>`).join('')}</div>
      ${days.map(d => `<div class="wcol ${M.isToday(d) ? 'today' : ''}" data-day="${M.dateKey(d)}">
        ${calItemsTimed(d).map(p => {
          const dayStart = M.startOfDay(d);
          const top = Math.max(0, (p.start - dayStart) / 3_600_000) * HOUR;
          const bottom = Math.min(24, (p.end - dayStart) / 3_600_000) * HOUR;
          return `<div class="block ${p.done ? 'done' : ''} ${p.kind !== 'task' ? 'evt' : ''} ${busyOf(p) ? '' : 'free'}" data-item="${esc(p.id)}" data-start="${+p.start}" data-end="${+p.end}"
            title="${busyOf(p) ? 'Closed' : 'Open (just for info)'} · click for details · double-click to add a task at this time"
            style="top:${top}px;height:${Math.max(20, bottom - top - 1)}px;left:calc(${(p.lane * 100) / p.lanes}% + 2px);width:calc(${100 / p.lanes}% - 4px);
            background:${tint(p.color, p.done ? .1 : p.kind !== 'task' ? .14 : .24)};border-color:${p.color}">
            <b>${p.kind !== 'task' ? `${ic('cal')} ` : ''}${esc(p.title)}</b>${M.fmtTime(p.start)}</div>`;
        }).join('')}
        ${M.isToday(d) ? `<div class="nowline" style="top:${M.minutesOf(now) / 60 * HOUR}px"></div>` : ''}
      </div>`).join('')}
    </div></div>
  </div>`;
}

// ---------- Month ----------
function monthView() {
  const first = M.startOfWeek(ui.month);
  const days = [...Array(42)].map((_, i) => M.addDays(first, i));
  store.ensureGoogle(days[0], M.addDays(days[41], 1));
  const cells = days.map(d => {
    const items = [
      ...store.occurrencesOn(d).map(o => ({ kind: o.event ? 'event' : 'task', title: o.task.title, color: color(o.task.color), done: o.done, id: `t|${o.id}` })),
      ...store.googleEventsOn(d).map(e => ({ kind: 'google', title: e.title, color: e.colorHex || '#0a84ff', id: `g|${e.id}` })),
    ];
    const max = 4, shown = items.length > max ? max - 1 : max;
    const tasks = store.tasksOn(d);
    const allDone = tasks.length && tasks.every(o => o.done);
    return `<div class="mcell ${d.getMonth() !== ui.month.getMonth() ? 'out' : ''} ${M.isToday(d) ? 'today' : ''} ${M.sameDay(d, ui.selectedDay) ? 'sel' : ''}" data-act="select-day" data-day="${M.dateKey(d)}">
      <div class="row"><span class="n">${d.getDate()}</span><span class="grow"></span>${allDone ? `<span class="green small" title="Everything done">${ic('check')}</span>` : ''}</div>
      ${items.slice(0, shown).map(it => `<div class="chip ${it.done ? 'done' : ''}" style="background:${tint(it.color, .13)}">
        ${it.kind !== 'task' ? `<span style="color:${it.color}">${ic('cal')}</span>` : `<span class="dot" style="border-color:${it.color};background:${it.done ? 'transparent' : it.color}"></span>`}<span>${esc(it.title)}</span></div>`).join('')}
      ${items.length > shown ? `<div class="more">+${items.length - shown} more</div>` : ''}</div>`;
  }).join('');
  const sel = ui.selectedDay;
  const tasks = store.tasksOn(sel), events = scheduleOn(sel);
  return `<div class="month"><div class="month-main">
    <div class="header"><div class="grow"><h1>${M.fmtDay(ui.month, { month: 'long', year: 'numeric' })}</h1><div class="sub">Click a day to see it, double-click to add a task.</div></div>
      <div class="row"><button class="btn icon" data-act="month-prev">${ic('left')}</button><button class="btn" data-act="month-today">Today</button><button class="btn icon" data-act="month-next">${ic('right')}</button></div></div>
    <div class="dows">${M.WEEKDAY_SHORT.map(w => `<div>${w.toUpperCase()}</div>`).join('')}</div>
    <div class="mgrid">${cells}</div></div>
    <aside class="daypanel stack" style="gap:12px">
      <div><div class="muted">${M.fmtDay(sel, { weekday: 'long' })}</div><h2 style="margin:0">${M.fmtDay(sel, { month: 'long', day: 'numeric' })}</h2></div>
      <div class="row"><button class="btn" data-act="new-task" data-day="${M.dateKey(sel)}">${ic('plus')} Task</button>
        <button class="btn" data-act="new-event" data-day="${M.dateKey(sel)}">${ic('cal')} Event</button></div>
      ${!tasks.length && !events.length ? '<div class="muted">Nothing planned.</div>' : ''}
      ${tasks.length ? `<div><div class="section-title">Checklist <span class="count">${tasks.length}</span></div>${tasks.map(o => crow(o, { compact: true })).join('')}</div>` : ''}
      ${events.length ? `<div><div class="section-title">Events <span class="count">${events.length}</span></div>
        <div>${events.map(eventRow).join('')}</div></div>` : ''}
    </aside></div>`;
}

// ---------- To-Do ----------
function todoView() {
  const t = ui.todo;
  const match = title => !t.search || title.toLowerCase().includes(t.search.toLowerCase());
  let body = '';
  if (t.mode === 'checklist') {
    const overdue = store.overdue().filter(o => match(o.task.title));
    const groups = [...Array(t.range)].map((_, i) => M.addDays(M.startOfDay(new Date()), i))
      .map(d => [d, store.tasksOn(d).filter(o => match(o.task.title) && (t.showCompleted || !o.done))])
      .filter(([, list]) => list.length);
    const group = (title, icon, list, showDate) => `<div><div class="section-title">${ic(icon)}${title}
      <span class="small muted" style="font-weight:400">${list.filter(o => o.done).length}/${list.length} done</span></div>
      <div class="card">${list.map(o => crow(o, { showDate })).join('')}</div></div>`;
    if (overdue.length) body += group('Overdue', 'alert', overdue, true);
    for (const [d, list] of groups) {
      const title = M.isToday(d) ? 'Today' : M.daysBetween(new Date(), d) === 1 ? 'Tomorrow' : M.fmtDay(d, { weekday: 'long', month: 'short', day: 'numeric' });
      body += group(title, M.isToday(d) ? 'sun' : 'cal', list, false);
    }
    if (!body) body = empty('list', t.search ? 'No matches' : 'No tasks yet', t.search ? '' : 'Create a task with New Task. Tasks can repeat daily, on certain weekdays, monthly or yearly.');
  } else if (t.mode === 'events') {
    const days = [...Array(t.range)].map((_, i) => M.addDays(M.startOfDay(new Date()), i));
    for (const d of days) {
      const list = scheduleOn(d).filter(ev => match(ev.title));
      if (!list.length) continue;
      const title = M.isToday(d) ? 'Today' : M.daysBetween(new Date(), d) === 1 ? 'Tomorrow' : M.fmtDay(d, { weekday: 'long', month: 'short', day: 'numeric' });
      body += `<div><div class="section-title">${ic(M.isToday(d) ? 'sun' : 'cal')}${title}<span class="count">${list.length}</span></div><div class="card">${list.map(eventRow).join('')}</div></div>`;
    }
    if (!body) body = empty('cal', t.search ? 'No matches' : 'No upcoming events', t.search ? '' : 'Create one with New event, or connect Google Calendar or Calendly in Settings.');
  } else {
    const tasks = [...store.tasks.values()].filter(x => !x.archived && !M.isEvent(x) && match(x.title));
    const repeating = tasks.filter(x => x.recurrence.frequency !== 'none').sort((a, b) => a.title.localeCompare(b.title));
    const once = tasks.filter(x => x.recurrence.frequency === 'none').sort((a, b) => b.startDate.localeCompare(a.startDate));
    const row = x => {
      const next = M.nextOccurrence(x);
      const doneCount = Object.keys(x.completions || {}).length;
      const status = next ? `<span>${ic('right')}Next: ${M.fmtDay(next, { weekday: 'short', month: 'short', day: 'numeric' })}</span>`
        : x.recurrence.frequency === 'none' && !doneCount && M.startOfDay(x.startDate) < M.startOfDay(new Date()) ? `<span class="red">${ic('alert')}Overdue</span>`
        : doneCount ? `<span class="green">${ic('check')}Done</span>` : '';
      return `<div class="crow"><span class="dot" style="width:10px;height:10px;border-radius:50%;background:${color(x.color)}"></span>
        <div class="grow"><div class="title">${esc(x.title)}</div><div class="meta">
          <span>${ic('repeat')}${esc(M.recurrenceSummary(x.recurrence, x.startDate))}</span>
          <span>${ic('clock')}${x.timeMinutes != null ? M.fmtTimeMinutes(x.timeMinutes) : 'Any time'}</span>${status}
          ${x.recurrence.frequency !== 'none' ? `<span>${doneCount} done</span>` : ''}</div></div>
        <button class="btn sm" data-act="edit" data-task="${x.id}">Edit</button>
        <button class="btn ghost sm icon danger" data-act="delete-task" data-task="${x.id}" title="Delete task">${ic('trash')}</button></div>`;
    };
    if (repeating.length) body += `<div><div class="section-title">${ic('repeat')}Recurring <span class="count">${repeating.length}</span></div><div class="card">${repeating.map(row).join('')}</div></div>`;
    if (once.length) body += `<div><div class="section-title">${ic('check')}One-time <span class="count">${once.length}</span></div><div class="card">${once.map(row).join('')}</div></div>`;
    if (!body) body = empty('list', t.search ? 'No matches' : 'No tasks yet', '');
  }
  return `<div class="header"><div class="grow"><h1>To-Do List</h1><div class="sub">Every task in one place, including each repeat.</div></div>
    <div class="seg"><button class="${t.mode === 'checklist' ? 'on' : ''}" data-act="todo-mode" data-mode="checklist">Upcoming checklist</button>
    <button class="${t.mode === 'tasks' ? 'on' : ''}" data-act="todo-mode" data-mode="tasks">All tasks</button>
    <button class="${t.mode === 'events' ? 'on' : ''}" data-act="todo-mode" data-mode="events">Events</button></div></div>
    <div class="page stack">
      <div class="row" style="flex-wrap:wrap">
        <input id="todoSearch" class="input" style="max-width:260px" placeholder="Search" value="${esc(t.search)}" data-bind="todoSearch">
        ${t.mode !== 'tasks' ? `<select class="input" style="width:auto" data-bind="todoRange">
          ${[7, 14, 31].map(n => `<option value="${n}" ${t.range === n ? 'selected' : ''}>Next ${n} days</option>`).join('')}</select>
          ${t.mode === 'checklist' ? `<label class="check"><input type="checkbox" data-bind="todoCompleted" ${t.showCompleted ? 'checked' : ''}>Show completed</label>` : ''}` : ''}
        <span class="grow"></span>${t.mode === 'events' ? `<button class="btn" data-act="new-event">${ic('plus')} New event</button>` : `<button class="btn" data-act="new-task">${ic('plus')} New Task</button>`}</div>
      ${body}</div>`;
}

// ---------- Reflections ----------
function reflectionsView() {
  const all = store.sortedReflections();
  const q = ui.reflSearch.toLowerCase();
  const list = all.filter(r => !q || r.text.toLowerCase().includes(q) || r.taskTitle.toLowerCase().includes(q));
  const words = all.reduce((n, r) => n + M.countWords(r.text), 0);
  const groups = new Map();
  for (const r of list) { const k = M.dateKey(r.createdAt); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const stat = (v, l, icon, c) => `<div class="stat" style="background:${tint(c, .1)}"><span style="color:${c}">${ic(icon)}</span><div><b>${v}</b><span class="small muted">${l}</span></div></div>`;
  return `<div class="header"><div class="grow"><h1>Reflections</h1><div class="sub">A record of what you wrote each time you checked something off.</div></div>
      <button class="btn" data-act="export-refl" ${all.length ? '' : 'disabled'}>${ic('copy')} Export</button></div>
    <div class="page stack">
      <div class="stats">${stat(all.length, 'reflections', 'quote', '#5e5ce6')}${stat(words, 'words written', 'text', '#30b0c7')}
        ${stat(store.reflectionStreak, store.reflectionStreak === 1 ? 'day streak' : 'days streak', 'flame', '#ff9f0a')}
        ${stat(new Set(all.map(r => r.taskID)).size, 'different tasks', 'stack', '#30d158')}</div>
      <input id="reflSearch" class="input" placeholder="Search reflections" value="${esc(ui.reflSearch)}" data-bind="reflSearch">
      ${!all.length ? empty('quote', 'No reflections yet', `Each time you check off a task you’ll write a short reflection (at least ${store.settings.minReflectionWords} words). They collect here.`) : ''}
      ${[...groups].map(([k, rs]) => `<div><div class="section-title">${M.isToday(M.parseKey(k)) ? 'Today' : M.fmtDay(M.parseKey(k), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
        <div class="stack" style="gap:8px">${rs.map(r => {
          const t = store.tasks.get(r.taskID);
          const forDay = r.occurrenceKey !== M.dateKey(r.createdAt) ? `<span class="small muted">for ${M.fmtDay(M.parseKey(r.occurrenceKey), { month: 'short', day: 'numeric' })}</span>` : '';
          return `<div class="card refl"><div class="row"><span style="width:8px;height:8px;border-radius:50%;background:${color(t?.color ?? 'gray')}"></span>
            <b>${esc(r.taskTitle)}</b>${forDay}<span class="grow"></span>
            <span class="small muted">${M.countWords(r.text)} words · ${M.fmtTime(r.createdAt)}</span>
            <button class="btn ghost sm icon" data-act="copy-refl" data-id="${r.id}" title="Copy">${ic('copy')}</button>
            <button class="btn ghost sm icon danger" data-act="delete-refl" data-id="${r.id}" title="Delete">${ic('trash')}</button></div>
            <p>${esc(r.text)}</p></div>`;
        }).join('')}</div></div>`).join('')}
    </div>`;
}

// ---------- Booking: your open time over the next 7 days ----------
const OT_HOUR = 40;
const durLabel = ms => { const m = Math.round(ms / 60_000), h = Math.floor(m / 60); return h ? (m % 60 ? `${h}h ${m % 60}m` : `${h}h`) : `${m}m`; };
const busyOf = it => it.kind === 'google' ? !it.e.transparent : it.o.busy;

/** Each of the next 7 days: its items (closed or open), Google-only busy times, and the open time left. */
function openTimeDays() {
  const a = store.settings.availability, today = M.startOfDay(new Date());
  const days = [...Array(7)].map((_, i) => M.addDays(today, i));
  store.ensureGoogle(days[0], M.addDays(days[6], 1));
  const fb = ui.booking.busy.map(b => [+new Date(b.start), +new Date(b.end)]);
  return days.map(day => {
    const from = +day, to = +M.addDays(day, 1);
    const timed = calItemsTimed(day).map(p => ({ ...p, busy: busyOf(p) }));
    const allDay = allDayItems(day).map(it => ({ ...it, busy: busyOf(it) }));
    const blocked = timed.filter(p => p.busy).map(p => [+p.start, +p.end]);
    if (allDay.some(it => it.busy)) blocked.push([from, to]);
    // Google's free/busy also covers calendars and events Cadence doesn't show. Skip anything you've
    // marked open here (Google catches up a moment later) and anything already drawn.
    const openHere = new Set(timed.filter(p => !p.busy).map(p => `${+p.start}|${+p.end}`));
    const extra = [];
    for (const [bs, be] of fb) {
      const s = Math.max(bs, from), e = Math.min(be, to);
      if (e <= s || openHere.has(`${bs}|${be}`) || blocked.some(([x, y]) => x <= s && y >= e)) continue;
      extra.push([s, e]);
    }
    blocked.push(...extra);
    const open = M.openRanges(day, a, blocked);
    return { day, timed, allDay, extra, open, total: open.reduce((n, [s, e]) => n + e - s, 0) };
  });
}

async function loadBusy() {
  const b = ui.booking;
  if (!store.google.connected) { b.busy = []; return; }
  b.loading = true; render();
  try { b.busy = await store.freeBusy(new Date(), M.addDays(M.startOfDay(new Date()), 8)); }
  catch (e) { b.message = e.message; }
  b.loading = false; b.loadedFor = Date.now(); render();
}

function bookingView() {
  const b = ui.booking, a = store.settings.availability;
  if (store.google.connected && (!b.loadedFor || Date.now() - b.loadedFor > 120_000) && !b.loading) setTimeout(loadBusy);
  const week = openTimeDays();
  ui.booking.week = week;
  const total = week.reduce((n, d) => n + d.total, 0);
  // Hours shown: your open hours, stretched to fit anything scheduled outside them.
  let lo = a.startMinutes, hi = a.endMinutes;
  for (const d of week) for (const p of d.timed) {
    lo = Math.min(lo, M.minutesOf(p.start));
    hi = Math.max(hi, M.sameDay(p.end, d.day) ? M.minutesOf(p.end) : 1440);
  }
  const h0 = Math.floor(lo / 60), h1 = Math.max(h0 + 1, Math.ceil(hi / 60));
  const y = (day, t) => ((t - +day) / 3_600_000 - h0) * OT_HOUR;
  const clip = (day, s, e) => { const top = Math.max(0, y(day, s)), bot = Math.min((h1 - h0) * OT_HOUR, y(day, e)); return bot > top ? `top:${top}px;height:${Math.max(16, bot - top - 1)}px` : null; };
  const now = Date.now();
  const col = d => {
    const off = !a.weekdays.includes(M.weekday(d.day));
    const parts = [];
    if (off) parts.push(`<div class="ot-off" style="top:0;bottom:0"></div>`);
    else {
      const s = clip(d.day, +M.dayAt(d.day, h0 * 60), +M.dayAt(d.day, a.startMinutes)), e = clip(d.day, +M.dayAt(d.day, a.endMinutes), +M.addDays(d.day, 1));
      if (s) parts.push(`<div class="ot-off" style="${s}"></div>`);
      if (e) parts.push(`<div class="ot-off" style="${e}"></div>`);
    }
    if (M.isToday(d.day)) { const p = clip(d.day, +M.dayAt(d.day, h0 * 60), now); if (p) parts.push(`<div class="ot-past" style="${p}"></div>`); }
    for (const [s, e] of d.open) {
      const pos = clip(d.day, s, e);
      if (pos) parts.push(`<button class="ot-open" data-act="ot-book" data-s="${s}" data-e="${e}" style="${pos}" title="Open ${M.fmtTime(s)}–${M.fmtTime(e)} · click to book a time in it">
        <b>${M.fmtTime(s)}–${M.fmtTime(e)}</b><span>${durLabel(e - s)} open</span></button>`);
    }
    for (const [s, e] of d.extra) { const pos = clip(d.day, s, e); if (pos) parts.push(`<div class="ot-item closed gbusy" style="${pos};left:2px;right:2px" title="Busy in Google Calendar">Busy</div>`); }
    for (const p of d.timed) {
      const pos = clip(d.day, +p.start, +p.end);
      if (pos) parts.push(`<div class="ot-item ${p.busy ? 'closed' : 'open'}" data-act="detail" data-item="${esc(p.id)}" title="${esc(p.title)} · ${p.busy ? 'closed: blocks this time' : 'open: just for info'}"
        style="${pos};left:calc(${(p.lane * 100) / p.lanes}% + 2px);width:calc(${100 / p.lanes}% - 4px);--hue:${p.color}"><b>${esc(p.title)}</b>${M.fmtTime(p.start)}</div>`);
    }
    if (M.isToday(d.day)) { const t = y(d.day, now); if (t > 0 && t < (h1 - h0) * OT_HOUR) parts.push(`<div class="nowline" style="top:${t}px"></div>`); }
    return `<div class="ot-col ${M.isToday(d.day) ? 'today' : ''}" style="height:${(h1 - h0) * OT_HOUR}px">${parts.join('')}</div>`;
  };
  return `<div class="header"><div class="grow"><h1>Booking</h1><div class="sub">Your open time for the next 7 days. Click any green stretch to book it.</div></div>
      <button class="btn" data-act="busy-refresh" ${b.loading ? 'disabled' : ''}>${ic('refresh', b.loading ? 'spinning' : '')} Refresh</button>
      <button class="btn" data-act="copy-avail" ${total ? '' : 'disabled'}>${ic('copy')} Copy open times</button></div>
    <div class="page stack" style="max-width:1200px">
      ${!store.google.connected ? `<div class="callout warn"><span class="big">${ic('cal')}</span><div class="grow"><b>Google Calendar isn’t connected</b>
        <div class="small muted">Open time only accounts for what’s in Cadence, and bookings are saved as Cadence events without sending invites.</div></div>
        <a class="btn" href="/app/settings">Connect in Settings</a></div>` : ''}
      ${b.message ? `<div class="callout" style="background:${tint('#30d158', .12)}"><span class="big green">${ic('check')}</span><div class="grow">${esc(b.message)}</div></div>` : ''}
      <div class="ot-summary"><div><span class="ot-big">${durLabel(total)}</span> open this week</div><span class="grow"></span>
        <span class="small muted">Open hours: ${a.weekdays.map(w => M.WEEKDAY_SHORT[w - 1]).join(' ')} · ${M.fmtTimeMinutes(a.startMinutes)}–${M.fmtTimeMinutes(a.endMinutes)}</span>
        <a class="btn sm" href="/app/settings#open-hours">Edit hours</a></div>
      <div class="ot-legend"><span><i class="sw open-time"></i>Open time</span><span><i class="sw closed"></i>Closed — blocks time</span>
        <span><i class="sw open"></i>Open — just for info</span><span><i class="sw off"></i>Outside your open hours</span></div>
      <div class="ot-wrap"><div class="ot">
        <div></div>${week.map(d => `<div class="ot-head ${M.isToday(d.day) ? 'today' : ''}"><div class="dow">${M.isToday(d.day) ? 'TODAY' : M.WEEKDAY_SHORT[d.day.getDay()].toUpperCase()}</div>
          <div class="num">${d.day.getDate()}</div><div class="small ${d.total ? 'green' : 'muted'}">${d.total ? `${durLabel(d.total)} open` : 'no open time'}</div></div>`).join('')}
        <div class="ot-lab">all<br>day</div>${week.map(d => `<div class="ot-allday">${d.allDay.map(it => `<div class="ot-chip ${it.busy ? 'closed' : 'open'}" style="--hue:${it.color}" data-act="detail" data-item="${esc(it.id)}" title="${it.busy ? 'Closed: blocks the whole day' : 'Open: just for info'}">${esc(it.title)}</div>`).join('')}</div>`).join('')}
        <div class="ot-hours">${[...Array(h1 - h0)].map((_, i) => `<div style="height:${OT_HOUR}px">${M.fmtTimeMinutes((h0 + i) * 60)}</div>`).join('')}</div>
        ${week.map(col).join('')}
      </div></div>
      ${store.calendly.connected && store.calendly.eventTypes.length ? `<div><div class="section-title">${ic('link')}Your Calendly links</div>
        <div class="small muted" style="margin:-4px 0 8px">Public links anyone can book from. Booked meetings land on your calendar automatically.</div>
        <div class="card">${store.calendly.eventTypes.map(t => `<div class="crow"><span style="width:10px;height:10px;border-radius:50%;background:${esc(t.color || '#bf5af2')}"></span>
          <div class="grow"><div class="title">${esc(t.name)}</div><div class="meta"><span>${t.minutes} min</span><span class="ellipsis">${esc(t.url)}</span></div></div>
          <button class="btn sm" data-act="copy-text" data-text="${esc(t.url)}">${ic('copy')} Copy link</button>
          <a class="btn sm icon" href="${esc(t.url)}" target="_blank" rel="noopener" title="Open">${ic('link')}</a></div>`).join('')}</div></div>` : ''}
      <div class="small muted">Closed items take their time out of your open time; open ones are just for info. Events you make in Cadence start out closed and tasks start out open — change it in any item’s editor. “Copy open times” puts the list on your clipboard to paste into an email.</div>
    </div>`;
}

// ---------- Settings ----------
function settingsView() {
  const s = store.settings, g = store.google;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const sel = (key, options, value) => `<select class="input" data-setting="${key}">${options.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const tog = (key, label, value) => `<label class="check"><input type="checkbox" data-setting="${key}" data-type="bool" ${value ? 'checked' : ''}>${label}</label>`;
  const chans = key => `<div class="chans">${M.CHANNELS.map(([c, l, d]) => `<label class="check" title="${esc(d)}"><input type="checkbox" data-setting-set="${key}" value="${c}" ${s[key].includes(c) ? 'checked' : ''}>${l}</label>`).join('')}</div>`;
  const times = (from, to) => { const o = []; for (let m = from; m <= to; m += 30) o.push([m, M.fmtTimeMinutes(m)]); return o; };
  const a = s.availability;
  return `<div class="header"><div class="grow"><h1>Settings</h1><div class="sub">Settings marked “this device” stay on this browser; everything else syncs with the Mac app.</div></div></div>
  <div class="page settings">
    ${ui.flash ? `<div class="callout"><span class="big">${ic('check')}</span><div class="grow">${esc(ui.flash)}</div><button class="btn ghost sm" data-act="clear-flash">${ic('x')}</button></div>` : ''}
    <div><h3>Account & sync</h3><div class="card">
      <div class="srow"><div>Signed in as <b>${esc(store.user.username)}</b><div class="small muted">You stay signed in on this browser until you sign out.</div></div><button class="btn" data-act="sign-out">${ic('logout')} Sign out</button></div>
      <div class="srow"><div>Sync<div class="small muted">Changes sync a moment after you make them, and every 20 seconds.</div></div>${syncControl('big')}</div>
      <div class="srow"><div>Your data<div class="small muted">Download everything Cadence stores for your account, as a JSON file.</div></div>
        <a class="btn" href="/api/account/export" download>${ic('copy')} Download my data</a></div>
      <div class="srow"><div>Delete account<div class="small muted">Permanently removes your account, tasks, reflections and connections from our servers.</div></div>
        <button class="btn danger" data-act="delete-account">${ic('trash')} Delete account…</button></div>
      <div class="srow"><div>Desktop apps<div class="small muted">Cadence for Mac, Windows and Linux keeps reminders running in the background.</div></div>
        <div class="row" style="flex-wrap:wrap;justify-content:flex-end">${downloadButtons()}</div></div>
      <div class="srow"><div>Mac app<div class="small muted">In Cadence for Mac, open Settings › Sync with Cadence Web and sign in with this same username and password. That's all — it finds this site automatically.</div></div></div>
    </div></div>

    <div><h3>Reminders on this device</h3><div class="card">
      <div class="srow"><label class="check"><input type="checkbox" data-act-change="browser-reminders" ${reminders.enabled ? 'checked' : ''}>Show reminders in this browser</label>
        <span class="small muted">Turn off if the Mac app already reminds you on this computer.</span></div>
      <div class="srow"><div>Browser notifications: <b>${{ granted: 'allowed', denied: 'blocked', default: 'not asked yet', unsupported: 'not supported' }[perm]}</b>
        ${perm === 'denied' ? '<div class="small muted">Allow them in your browser’s site settings. On-screen banners are used meanwhile.</div>' : ''}</div>
        ${perm === 'default' ? '<button class="btn primary" data-act="ask-notify">Allow notifications</button>' : ''}</div>
      <div class="srow"><div class="row"><button class="btn" data-act="test-reminder">${ic('bell')} Send a test reminder</button><button class="btn" data-act="check-in">Show check-in window</button></div></div>
    </div></div>

    <div><h3>Notifications</h3><div class="card">
      <div class="srow"><div class="grow">Default alert style for new tasks${chans('defaultChannels')}</div></div>
      <div class="srow"><span>Tasks without a time remind at</span>${sel('untimedReminderMinutes', times(300, 1320), s.untimedReminderMinutes)}</div>
      <div class="srow"><span>On-screen banners</span>${sel('bannerAutoDismissSeconds', [[0, 'Stay until dismissed'], [10, 'Hide after 10 seconds'], [30, 'Hide after 30 seconds'], [120, 'Hide after 2 minutes']], s.bannerAutoDismissSeconds)}</div>
    </div></div>

    <div><h3>Recurring checklist reminder</h3><div class="card">
      <div class="srow">${tog('nudgeEnabled', 'Remind me to check my checklist while I’m at the computer', s.nudgeEnabled)}</div>
      <div class="srow"><span>Every</span>${sel('nudgeIntervalMinutes', [15, 20, 30, 45, 60, 90, 120].map(n => [n, `${n} minutes`]), s.nudgeIntervalMinutes)}</div>
      <div class="srow">${tog('nudgeOnlyWhenIncomplete', 'Skip when everything is already done', s.nudgeOnlyWhenIncomplete)}</div>
      <div class="srow"><div class="grow">Alert style${chans('nudgeChannels')}</div></div>
    </div></div>

    <div><h3>Check-in when you open your computer</h3><div class="card">
      <div class="srow">${tog('checkInOnLaunch', 'When Cadence opens (app launch / page load)', s.checkInOnLaunch)}</div>
      <div class="srow">${tog('checkInOnWake', 'When the computer wakes from sleep', s.checkInOnWake)}</div>
      <div class="srow">${tog('checkInOnUnlock', 'When I unlock the Mac / come back to this tab after 10+ minutes', s.checkInOnUnlock)}</div>
      <div class="srow">${tog('checkInOnlyWhenIncomplete', 'Only if something is still unchecked', s.checkInOnlyWhenIncomplete)}</div>
      <div class="srow"><div class="grow">Alert style${chans('checkInChannels')}</div></div>
    </div></div>

    <div><h3>Reflections</h3><div class="card">
      <div class="srow"><span>Minimum reflection length</span>${sel('minReflectionWords', [20, 25, 30, 40, 50, 75, 100, 150, 200].map(n => [n, `${n} words`]), s.minReflectionWords)}</div>
      <div class="small muted" style="padding-bottom:8px">Every checklist item needs a reflection before it can be checked off. The minimum can’t go below 20 words.</div>
    </div></div>

    <div><h3>Google Calendar</h3><div class="card">
      ${!g.configured ? `<div class="srow"><div class="muted">Google isn’t set up on this server yet. The server owner adds <span class="mono">GOOGLE_CLIENT_ID</span> and <span class="mono">GOOGLE_CLIENT_SECRET</span> (see the README).</div></div>`
        : g.connected ? `${g.error ? `<div class="srow"><div class="callout warn" style="width:100%"><span class="big">${ic('alert')}</span>
            <div class="grow"><b>Google isn't returning your events</b><div class="small">${esc(g.error)}</div></div></div></div>` : ''}
          <div class="srow"><div class="green">${ic('check')} Connected${g.email ? ` as ${esc(g.email)}` : ''}</div>
            <div class="row"><button class="btn" data-act="google-refresh">${ic('refresh')} Refresh</button><button class="btn danger" data-act="google-disconnect">Disconnect</button></div></div>
          <div class="srow">${tog('showGoogleEvents', 'Show Google events in Cadence calendars', s.showGoogleEvents)}</div>
          <div class="srow"><span>Remind me before Google events</span>${sel('googleEventReminderMinutes', [[0, 'Off'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes']], s.googleEventReminderMinutes)}</div>
          ${g.calendars.length ? `<div class="srow"><div class="grow">Calendars to show and check for busy times (this device)
            <div class="chans" style="margin-top:6px">${g.calendars.map(c => `<label class="check"><input type="checkbox" data-act-change="gcal" value="${esc(c.id)}"
              ${(store.googleCalendarIDs.length ? store.googleCalendarIDs.includes(c.id) : c.primary) ? 'checked' : ''}>
              <span style="width:9px;height:9px;border-radius:50%;background:${c.colorHex || '#0a84ff'}"></span>${esc(c.summary)}</label>`).join('')}</div></div></div>` : ''}`
        : `<div class="srow"><div>Show your Google events here, get reminders for them, and book meetings that send invites.</div><a class="btn primary" href="/api/google/connect">Connect Google Calendar</a></div>`}
    </div></div>

    <div><h3>Calendly</h3><div class="card">
      ${store.calendly.connected ? `<div class="srow"><div class="green">${ic('check')} Connected${store.calendly.name ? ` as ${esc(store.calendly.name)}` : ''}</div>
          <div class="row"><button class="btn" data-act="calendly-refresh">${ic('refresh')} Refresh</button><button class="btn danger" data-act="calendly-disconnect">Disconnect</button></div></div>
        ${store.calendly.schedulingUrl ? `<div class="srow"><span class="mono muted ellipsis">${esc(store.calendly.schedulingUrl)}</span><button class="btn" data-act="copy-text" data-text="${esc(store.calendly.schedulingUrl)}">${ic('copy')} Copy booking page link</button></div>` : ''}`
      : `<div class="srow"><div class="small">In Calendly, open <b>Integrations › API &amp; Webhooks</b>, generate a <b>Personal Access Token</b>, and paste it here. Booked meetings show up on your checklist (without notifications), and your booking links appear on the Booking page.
          <div style="margin-top:4px"><a href="https://calendly.com/integrations/api_webhooks" target="_blank" rel="noopener">Open Calendly API settings ${ic('link')}</a></div></div></div>
        <form class="srow" data-form="calendly"><input class="input grow" name="token" type="password" placeholder="Personal Access Token" autocomplete="off" required>
          <button class="btn primary" ${ui.calendlyBusy ? 'disabled' : ''}>${ui.calendlyBusy ? 'Connecting…' : 'Connect'}</button></form>`}
    </div></div>

    <div><h3>Calendar imports</h3><div class="card">
      <div class="srow">${tog('autoImportCalendars', 'Import Google Calendar events and Calendly meetings onto my checklist', s.autoImportCalendars)}</div>
      <div class="srow"><span>Import the next</span>${sel('importDaysAhead', [3, 7, 14, 21, 30, 60].map(n => [n, `${n} days`]), s.importDaysAhead)}</div>
      <div class="srow"><div class="small muted grow">${ui.importSummary ? esc(ui.importSummary) : `Imported items never notify you — turn notifications on for any single one in its editor. Deleting one hides it for good. Google Calendar is re-checked every 2 minutes while this page is open${store.google.push ? ' and pushes changes instantly' : ''}; Calendly every 30 minutes.`}</div>
        <button class="btn ${ui.importing ? 'busy' : ''}" data-act="import-now" ${ui.importing || !(store.google.connected || store.calendly.connected) ? 'disabled' : ''}>${ic('sync', ui.importing ? 'spinning' : '')} ${ui.importing ? 'Importing…' : 'Import now'}</button></div>
    </div></div>

    <div id="open-hours"><h3>Open hours</h3><div class="card">
      <div class="srow small muted">When you’re normally free to be booked. Booking shows what’s left of these hours after your closed tasks and events.</div>
      <div class="srow"><span>Days</span><div class="wd">${[1, 2, 3, 4, 5, 6, 7].map(w => `<button class="${a.weekdays.includes(w) ? 'on' : ''}" data-act="avail-day" data-w="${w}" title="${M.WEEKDAY_SHORT[w - 1]}">${M.WEEKDAY_LETTER[w - 1]}</button>`).join('')}</div></div>
      <div class="srow"><span>From</span>${sel('availability.startMinutes', times(360, 1200), a.startMinutes)}</div>
      <div class="srow"><span>Until</span>${sel('availability.endMinutes', times(480, 1380), a.endMinutes)}</div>
      <div class="srow"><span>Breathing room around closed items</span>${sel('availability.bufferMinutes', [[0, 'None'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes']], a.bufferMinutes)}</div>
    </div></div>

    <div class="small muted" style="order:99">Read our <a href="/privacy" target="_blank">Privacy Policy</a> and <a href="/terms" target="_blank">Terms of Service</a>.</div>

  </div>`;
}

// ---------- Desktop downloads (GitHub release assets, fixed names) ----------
const RELEASE = 'https://github.com/wilsonwilson49/cadence/releases/latest/download';
const DOWNLOADS = [
  ['mac', 'Mac', 'Cadence-mac.zip'], ['windows', 'Windows', 'Cadence-Setup.exe'],
  ['linux', 'Linux (AppImage)', 'Cadence.AppImage'], ['deb', 'Linux (.deb)', 'Cadence.deb'],
];
function downloadButtons() {
  const ua = navigator.userAgent;
  const mine = /Mac/.test(ua) ? 'mac' : /Win/.test(ua) ? 'windows' : /Linux|X11/.test(ua) ? 'linux' : null;
  const sorted = [...DOWNLOADS].sort((a, b) => (b[0] === mine) - (a[0] === mine));
  return sorted.map(([os, label, file]) => `<a class="btn ${os === mine ? 'primary' : 'sm'}" href="${RELEASE}/${file}" download>${ic('copy')} ${os === mine ? `Download for ${label}` : label}</a>`).join('');
}

// ---------- Auth ----------
function authView() {
  const a = ui.auth, create = a.mode === 'register';
  return `<div class="auth"><form class="auth-card" data-form="auth">
    <a href="/" class="small muted" style="text-decoration:none">← Back to home</a>
    <div class="logo"><img src="/icon-192.png" alt=""><div><h1>Cadence</h1><div class="muted small">Your checklist, calendars and reflections — on the web and on your Mac.</div></div></div>
    <div class="seg" style="align-self:flex-start"><button type="button" class="${!create ? 'on' : ''}" data-act="auth-mode" data-mode="login">Sign in</button>
      <button type="button" class="${create ? 'on' : ''}" data-act="auth-mode" data-mode="register">Create account</button></div>
    <label class="field"><span>Username</span><input class="input" name="username" autocomplete="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_.\\-]+" autofocus></label>
    <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="${create ? 'new-password' : 'current-password'}" required minlength="${create ? 8 : 1}"></label>
    ${create ? '<div class="small muted">Usernames: 3–32 letters, numbers, dots, dashes or underscores. Passwords: at least 8 characters.</div>' : ''}
    <label class="check"><input type="checkbox" name="remember" checked>Keep me signed in</label>
    ${a.error ? `<div class="error">${esc(a.error)}</div>` : ''}
    <button class="btn primary" style="min-height:38px" ${a.busy ? 'disabled' : ''}>${create ? 'Create account' : 'Sign in'}</button>
    <div class="small muted" style="text-align:center">${create ? 'By creating an account you agree to the' : 'See our'}
      <a href="/terms" target="_blank">Terms of Service</a> and <a href="/privacy" target="_blank">Privacy Policy</a>.</div>
  </form></div>`;
}

// ---------- modals ----------
function openModal(m) { ui.modal = m; ui.modalFresh = true; renderModal(); }
function closeModal() { ui.modal = null; renderModal(); render(); }

function renderModal() {
  const root = $('#modal');
  const m = ui.modal;
  if (!m) { root.innerHTML = ''; return; }
  let html = '';
  if (m.type === 'reflection') html = reflectionDialog(m.occ, 'reflection');
  else if (m.type === 'checkin') html = m.reflecting ? reflectionDialog(m.reflecting, 'checkin') : checkInDialog(m);
  else if (m.type === 'editor') html = editorDialog(m);
  else if (m.type === 'detail') html = detailDialog(m);
  else if (m.type === 'booking') html = bookingDialog(m);
  else if (m.type === 'delete-account') html = `<form class="dialog sm" data-form="delete-account"><div class="body">
    <div class="row" style="gap:12px"><span class="badge-icon" style="background:var(--red)">${ic('trash')}</span><h2>Delete your account?</h2></div>
    <div>This permanently deletes <b>${esc(store.user.username)}</b> and everything in it — tasks, reflections, settings, and your Google and Calendly connections — for every device. It can’t be undone.</div>
    <div class="small muted">Tip: <a href="/api/account/export" download>download your data</a> first. The Mac app keeps its own copy on your Mac until you delete it there.</div>
    <label class="field"><span>Type your password to confirm</span><input class="input" name="password" type="password" autocomplete="current-password" required autofocus></label>
    ${m.error ? `<div class="error">${esc(m.error)}</div>` : ''}
    </div><div class="foot"><span class="grow"></span><button type="button" class="btn" data-act="close">Cancel</button>
      <button class="btn primary" style="background:var(--red)" ${m.working ? 'disabled' : ''}>${m.working ? 'Deleting…' : 'Delete forever'}</button></div></form>`;
  else if (m.type === 'delete-google') html = `<div class="dialog sm"><div class="body">
    <h2>Remove “${esc(m.task.title)}”?</h2>
    <div class="muted">This event is synced with Google Calendar.</div>
    ${m.error ? `<div class="error">${esc(m.error)}</div>` : ''}</div>
    <div class="foot" style="flex-wrap:wrap"><button class="btn" data-act="close">Cancel</button><span class="grow"></span>
      <button class="btn" data-act="google-hide">Hide in Cadence</button>
      <button class="btn primary" style="background:var(--red)" data-act="google-delete" ${m.working ? 'disabled' : ''}>${m.working ? 'Deleting…' : 'Delete from Google too'}</button></div></div>`;
  else if (m.type === 'confirm') html = `<div class="dialog sm"><div class="body"><h2>${esc(m.title)}</h2><div class="muted">${esc(m.text)}</div></div>
    <div class="foot"><span class="grow"></span><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="confirm-yes">${esc(m.yes)}</button></div></div>`;
  root.innerHTML = `<div class="overlay ${ui.modalFresh ? 'opening' : ''}" data-act="overlay">${html}</div>`;
  ui.modalFresh = false;
  animateRings();
  const focus = root.querySelector('[autofocus]');
  if (focus) setTimeout(() => focus.focus(), 0);
}

const PROMPTS = ['What went well, and why?', 'What got in the way or felt harder than expected?', 'What will you do differently next time?',
  'How did this move you toward a bigger goal?', 'What did you learn about how you work?'];

function reflectionDialog(o, ctx) {
  const min = store.settings.minReflectionWords;
  const seed = [...(o.task.id + o.key)].reduce((n, c) => n + c.charCodeAt(0), 0);
  const prompts = [0, 1, 2].map(i => PROMPTS[(seed + i) % PROMPTS.length]);
  return `<form class="dialog" data-form="reflection" data-occ="${esc(o.id)}" data-ctx="${ctx}"><div class="body">
    <div class="row" style="gap:12px"><span class="badge-icon" style="background:${color(o.task.color)}">${ic('quote')}</span>
      <div class="grow"><h2>Reflect to complete</h2><div class="muted ellipsis">${esc(o.task.title)} · ${M.fmtDay(o.day, { weekday: 'long', month: 'short', day: 'numeric' })}</div></div></div>
    <div>Write at least ${min} words before checking this off. Some prompts:<ul class="prompts">${prompts.map(p => `<li>${p}</li>`).join('')}</ul></div>
    <textarea class="input" id="reflText" rows="7" placeholder="How did it go?" autofocus data-min="${min}"></textarea></div>
    <div class="foot"><div class="progress" id="reflBar"><div style="width:0"></div></div><span class="small muted" id="reflCount">0 / ${min} words</span><span class="grow"></span>
      <button type="button" class="btn" data-act="${ctx === 'checkin' ? 'checkin-back' : 'close'}">Cancel</button>
      <button class="btn primary" id="reflSubmit" disabled title="Ctrl/⌘ + Enter">${ic('check')} Submit & complete</button></div></form>`;
}

function checkInDialog(m) {
  const items = store.todayChecklist(), done = items.filter(o => o.done).length;
  const upcoming = scheduleOn(new Date()).filter(e => !e.allDay && e.end > new Date()).map(e => ({ title: e.title, startDate: e.start, colorHex: e.color }));
  return `<div class="dialog"><div class="body">
    <div class="row" style="gap:14px"><span class="badge-icon" style="width:46px;height:46px;background:linear-gradient(135deg,#ffb340,#ff7a00)">${ic('sun')}</span>
      <div class="grow"><h2>${esc(m.title)}</h2><div class="muted">${M.fmtDay(new Date())} · ${!items.length ? 'nothing scheduled' : done === items.length ? 'all done' : `${items.length - done} left`}</div></div>
      ${ring(done, items.length, 54, 6, 'checkin')}</div>
    ${done && done === items.length ? `<div class="green">${ic('check')} Everything is checked off. Nice work.</div>` : ''}
    <div class="card" style="max-height:340px;overflow:auto">${items.length ? items.map(o => crow(o, { ctx: 'checkin' })).join('') : '<div class="crow muted">Nothing on today’s checklist. Add something so future-you knows the plan.</div>'}</div>
    ${upcoming.length ? `<div><b>Still ahead on your calendar</b>${upcoming.slice(0, 4).map(e => `<div class="row small" style="margin-top:4px">
      <span style="width:3px;height:16px;background:${e.colorHex || '#0a84ff'};border-radius:2px"></span><span class="muted" style="width:72px">${M.fmtTime(e.startDate)}</span>${esc(e.title)}</div>`).join('')}</div>` : ''}
    </div><div class="foot"><button class="btn" data-act="new-task">${ic('plus')} Add task</button><span class="grow"></span>
      <button class="btn" data-act="close" data-then="today">Open Today</button><button class="btn primary" data-act="close" autofocus>Done for now</button></div></div>`;
}

function itemById(id) {
  const [kind, ...rest] = id.split('|');
  const tail = rest.join('|');
  if (kind === 't') { const o = findOcc(tail); return o && { kind: 'task', o, title: o.task.title, start: o.start, end: o.end, color: color(o.task.color) }; }
  const e = store.google.events.get(tail);
  if (!e) return null;
  const ev = { ...e, startDate: e.isAllDay ? M.parseKey(e.start) : new Date(e.start), endDate: e.isAllDay ? M.parseKey(e.end) : new Date(e.end) };
  return { kind: 'google', e: ev, title: e.title, start: e.isAllDay ? null : ev.startDate, end: e.isAllDay ? null : ev.endDate, color: e.colorHex || '#0a84ff' };
}

function detailDialog(m) {
  const it = itemById(m.item);
  if (!it) return `<div class="dialog sm"><div class="body">This item no longer exists.</div><div class="foot"><span class="grow"></span><button class="btn" data-act="close">Close</button></div></div>`;
  const during = it.start && it.end ? (() => {
    const len = it.end - it.start;
    const opts = [['At its start', it.start]];
    if (len >= 30 * 60_000) opts.push(['Halfway through', new Date(+it.start + len / 2)], ['15 min before it ends', M.addMinutes(it.end, -15)]);
    return `<div class="fieldset"><div class="legend">${ic('layers')} Add task during this</div><div class="row" style="flex-wrap:wrap">
      ${opts.map(([l, d]) => `<button class="btn sm" data-act="new-at" data-at="${+d}">${l} (${M.fmtTime(d)})</button>`).join('')}</div></div>`;
  })() : '';
  let body = '', buttons = '';
  if (it.kind === 'task' && it.o.event) {
    const o = it.o, t = o.task;
    const from = t.source === 'calendly' ? 'From Calendly' : t.source === 'google' ? 'From Google Calendar' : 'Event';
    body = `<div class="muted">${ic('cal')} ${M.fmtDay(o.day)}</div>
      <div class="muted">${ic('clock')} ${o.start ? `${M.fmtTime(o.start)} – ${M.fmtTime(o.end)}` : 'All day'}</div>
      ${t.recurrence.frequency !== 'none' ? `<div class="muted">${ic('repeat')} ${esc(M.recurrenceSummary(t.recurrence, t.startDate))}</div>` : ''}
      ${t.notes ? `<div>${esc(t.notes)}</div>` : ''}
      <div class="small muted">${from} · ${M.isBusy(t) ? 'closed: blocks this time' : 'open: just for info'} · ${M.isSilent(t) ? 'no reminders' : 'reminds you'} · not on your checklist</div>`;
    buttons = `${t.externalURL ? `<a class="btn" href="${esc(t.externalURL)}" target="_blank" rel="noopener">${ic('link')} Open</a>` : ''}
      <button class="btn" data-act="edit" data-task="${t.id}">Edit…</button>
      <button class="btn" data-act="make-kind" data-task="${t.id}" data-kind="task" title="Put it on your checklist">${ic('list')} Make it a task</button>
      <button class="btn danger" data-act="delete-task" data-task="${t.id}">${t.source ? 'Hide' : 'Delete'}</button>`;
  } else if (it.kind === 'task') {
    const o = it.o, t = o.task, r = store.reflectionFor(o);
    body = `<div class="muted">${ic('cal')} ${M.fmtDay(o.day)}</div>
      <div class="muted">${ic('clock')} ${o.start ? `${M.fmtTime(o.start)} – ${M.fmtTime(o.end)}` : 'Any time'}</div>
      ${t.recurrence.frequency !== 'none' ? `<div class="muted">${ic('repeat')} ${esc(M.recurrenceSummary(t.recurrence, t.startDate))}</div>` : ''}
      ${t.notes ? `<div>${esc(t.notes)}</div>` : ''}<div class="small muted">${M.isBusy(t) ? 'Closed: blocks this time' : 'Open: just for info, you’re still free then'}</div>${r ? `<div class="muted" style="font-style:italic">“${esc(r.text)}”</div>` : ''}`;
    buttons = `${o.done ? `<button class="btn" data-act="toggle" data-occ="${esc(o.id)}">Mark not done</button>` : `<button class="btn primary" data-act="toggle" data-occ="${esc(o.id)}">Complete…</button>`}
      <button class="btn" data-act="edit" data-task="${t.id}">Edit…</button>
      ${t.recurrence.frequency !== 'none' ? `<button class="btn" data-act="skip" data-occ="${esc(o.id)}">Skip</button>` : ''}
      ${t.source ? `<button class="btn" data-act="make-kind" data-task="${t.id}" data-kind="event" title="Take it off your checklist">${ic('cal')} Make it an event</button>` : ''}`;
  } else {
    const e = it.e;
    body = `<div class="muted">${ic('cal')} ${M.fmtDay(e.startDate)}</div>${!e.isAllDay ? `<div class="muted">${ic('clock')} ${M.fmtTime(e.startDate)} – ${M.fmtTime(e.endDate)}</div>` : ''}
      ${e.location ? `<div class="muted">${esc(e.location)}</div>` : ''}<div class="small muted">From Google Calendar · ${e.transparent ? 'shown as free (open)' : 'busy (closed)'}</div>`;
    buttons = e.link ? `<a class="btn" href="${esc(e.link)}" target="_blank" rel="noopener">${ic('link')} Open in Google Calendar</a>` : '';
  }
  return `<div class="dialog sm"><div class="body"><div class="row"><span style="width:10px;height:10px;border-radius:50%;background:${it.color}"></span><h2 class="grow">${esc(it.title)}</h2></div>
    ${body}${during}</div><div class="foot" style="flex-wrap:wrap">${buttons}<span class="grow"></span><button class="btn" data-act="close">Close</button></div></div>`;
}

// --- task editor ---
const DURATIONS = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240];
const BEFORE = [0, 5, 10, 15, 30, 60, 120, 1440];
const DURING = [-10, -15, -30, -45, -60, -90];

function openEditor(task, isNew) {
  const end = M.endOf(task.recurrence);
  openModal({
    type: 'editor', isNew, error: null, saving: false, addToGoogle: false,
    // New events sync with Google Calendar by default when it's connected.
    syncGoogle: isNew && M.isEvent(task) && store.google.connected,
    draft: structuredClone(task),
    date: M.dateKey(task.startDate),
    hasTime: task.timeMinutes != null,
    time: `${String(Math.floor((task.timeMinutes ?? 540) / 60)).padStart(2, '0')}:${String((task.timeMinutes ?? 540) % 60).padStart(2, '0')}`,
    endMode: end.type, endDate: M.dateKey(end.date ?? M.addMonths(M.parseKey(M.dateKey(task.startDate)), 3)), endCount: end.count ?? 10,
  });
}

function editorStartMinutes(m) { const [h, mi] = m.time.split(':').map(Number); return h * 60 + mi; }

function editorOverlaps(m) {
  if (!m.hasTime) return [];
  const day = M.parseKey(m.date), start = M.dayAt(day, editorStartMinutes(m)), end = M.addMinutes(start, m.draft.durationMinutes);
  const out = [];
  for (const o of store.occurrencesOn(day)) if (o.task.id !== m.draft.id && o.start && o.start < end && o.end > start) out.push(`${o.task.title} · ${M.fmtTime(o.start)}–${M.fmtTime(o.end)}`);
  for (const e of store.googleEventsOn(day)) if (!e.isAllDay && e.startDate < end && e.endDate > start) out.push(`${e.title} · ${M.fmtTime(e.startDate)}–${M.fmtTime(e.endDate)} (Google)`);
  return out;
}

function editorDialog(m) {
  const d = m.draft, r = d.recurrence;
  const unit = M.FREQUENCIES.find(f => f[0] === r.frequency)[2];
  const overlaps = editorOverlaps(m);
  const preview = { ...r, end: m.endMode === 'onDate' ? { onDate: { _0: M.iso(M.parseKey(m.endDate)) } } : m.endMode === 'afterCount' ? { afterCount: { _0: m.endCount } } : { never: {} } };
  const offCheck = o => `<label class="check"><input type="checkbox" data-edit="offset" value="${o}" ${d.reminderOffsets.includes(o) ? 'checked' : ''}>${M.offsetLabel(o)}</label>`;
  return `<form class="dialog" data-form="editor"><div class="body">
    <div class="row"><h2 class="grow">${m.isNew ? (M.isEvent(d) ? 'New Event' : 'New Task') : (M.isEvent(d) ? 'Edit Event' : 'Edit Task')}</h2>
      <div class="seg"><button type="button" class="${M.isEvent(d) ? '' : 'on'}" data-act="edit-kind" data-kind="task">${ic('list')} Task</button>
      <button type="button" class="${M.isEvent(d) ? 'on' : ''}" data-act="edit-kind" data-kind="event">${ic('cal')} Event</button></div></div>
    <div class="small muted" style="margin-top:-6px">${M.isEvent(d) ? 'Events show on your calendars only: no checkbox, no reflection.' : 'Tasks go on your checklist; checking one off asks for a short reflection.'}</div>
    <label class="field"><span>Title</span><input class="input" data-edit="title" value="${esc(d.title)}" placeholder="What do you need to do?" autofocus required></label>
    <label class="field"><span>Notes</span><textarea class="input" data-edit="notes" rows="2" placeholder="Optional details">${esc(d.notes)}</textarea></label>
    <div class="fieldset"><div class="legend">When</div>
      <div class="grid2"><label class="field"><span>Date</span><input class="input" type="date" data-edit="date" data-rerender value="${m.date}"></label>
        <label class="field"><span>&nbsp;</span><label class="check"><input type="checkbox" data-edit="hasTime" data-rerender ${m.hasTime ? 'checked' : ''}>At a specific time</label></label></div>
      ${m.hasTime ? `<div class="grid2"><label class="field"><span>Time</span><input class="input" type="time" data-edit="time" data-rerender value="${m.time}"></label>
        <label class="field"><span>Duration</span><select class="input" data-edit="duration" data-rerender>${DURATIONS.map(n => `<option value="${n}" ${d.durationMinutes === n ? 'selected' : ''}>${n < 60 ? `${n} min` : n % 60 ? `${Math.floor(n / 60)} hr ${n % 60} min` : `${n / 60} hr`}</option>`).join('')}</select></label></div>` : ''}
    </div>
    <div class="fieldset"><div class="legend">Your time</div>
      <div class="seg wide"><button type="button" class="${M.isBusy(d) ? 'on' : ''}" data-act="edit-busy" data-busy="1">${ic('lock')} Closed</button>
        <button type="button" class="${M.isBusy(d) ? '' : 'on'}" data-act="edit-busy" data-busy="0">${ic('eye')} Open</button></div>
      <div class="small muted">${M.isBusy(d) ? `Blocks this time: it’s taken out of your open time on Booking${d.source === 'google' || m.syncGoogle ? ', and shows as busy in Google Calendar' : ''}.` : 'Just for info: it shows on your calendars, but you’re still free to be booked then.'}</div></div>
    ${overlaps.length ? `<div class="fieldset"><div class="legend">${ic('layers')} Overlaps with</div>${overlaps.map(l => `<div class="small">${esc(l)}</div>`).join('')}
      <div class="small muted">That’s fine: this task’s reminders will still fire on time, even in the middle of the other one.</div></div>` : ''}
    ${d.source === 'google' && !m.isNew ? `<div class="fieldset"><div class="legend">${ic('sync')} Synced with Google Calendar</div>
      <div class="small muted">Changes you save here update the event in Google Calendar, and changes made in Google show up here. Repeats are managed in Google Calendar.</div>
      ${d.externalURL ? `<a class="small" href="${esc(d.externalURL)}" target="_blank" rel="noopener">${ic('link')} Open in Google Calendar</a>` : ''}</div>` : `
    <div class="fieldset"><div class="legend">Repeat</div>
      <div class="grid2"><label class="field"><span>Repeats</span><select class="input" data-edit="frequency" data-rerender>${M.FREQUENCIES.map(([v, l]) => `<option value="${v}" ${r.frequency === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${r.frequency !== 'none' ? `<label class="field"><span>Every</span><div class="row"><input class="input" type="number" min="1" max="99" style="width:80px" data-edit="interval" data-rerender value="${r.interval}"><span>${unit}${r.interval > 1 ? 's' : ''}</span></div></label>` : ''}</div>
      ${r.frequency === 'weekly' ? `<div class="row" style="flex-wrap:wrap"><div class="wd">${[1, 2, 3, 4, 5, 6, 7].map(w => `<button type="button" class="${M.effectiveWeekdays(r, M.parseKey(m.date)).includes(w) ? 'on' : ''}" data-act="edit-weekday" data-w="${w}">${M.WEEKDAY_LETTER[w - 1]}</button>`).join('')}</div>
        <button type="button" class="btn sm" data-act="edit-weekdays">Weekdays</button></div>` : ''}
      ${r.frequency !== 'none' ? `<div class="grid2"><label class="field"><span>Ends</span><select class="input" data-edit="endMode" data-rerender>
          <option value="never" ${m.endMode === 'never' ? 'selected' : ''}>Never</option><option value="onDate" ${m.endMode === 'onDate' ? 'selected' : ''}>On a date</option>
          <option value="afterCount" ${m.endMode === 'afterCount' ? 'selected' : ''}>After a number of times</option></select></label>
        ${m.endMode === 'onDate' ? `<label class="field"><span>End date</span><input class="input" type="date" data-edit="endDate" data-rerender value="${m.endDate}" min="${m.date}"></label>` : ''}
        ${m.endMode === 'afterCount' ? `<label class="field"><span>Times</span><input class="input" type="number" min="1" max="999" data-edit="endCount" data-rerender value="${m.endCount}"></label>` : ''}</div>
        <div class="small muted">${esc(M.recurrenceSummary(preview, M.parseKey(m.date)))}</div>` : ''}
    </div>
    `}
    <div class="fieldset"><div class="legend">Reminders</div>
      <label class="check"><input type="checkbox" data-edit="notify" data-rerender ${d.channels.length ? 'checked' : ''}>
        ${d.channels.length ? `${ic('bell')} Notify me about this task` : `${ic('bell-off')} No notifications — stays on the checklist quietly`}</label>
      ${d.channels.length ? `
      <div class="checks">${BEFORE.map(offCheck).join('')}</div>
      ${m.hasTime ? `<div class="small" style="font-weight:600">During the task</div><div class="checks">${DURING.filter(o => -o < d.durationMinutes).map(offCheck).join('')}</div>` : ''}
      <div class="chans">${M.CHANNELS.map(([c, l, desc]) => `<label class="check" title="${esc(desc)}"><input type="checkbox" data-edit="channel" value="${c}" ${d.channels.includes(c) ? 'checked' : ''}>${l}</label>`).join('')}</div>
      ${!m.hasTime ? `<div class="small muted">Tasks without a time remind at ${M.fmtTimeMinutes(store.settings.untimedReminderMinutes)} on the day.</div>` : ''}` : ''}
      ${d.source ? `<div class="small muted">Imported from ${d.source === 'calendly' ? 'Calendly' : 'Google Calendar'}. Its title and time update on each import.</div>` : ''}
    </div>
    <div class="fieldset"><div class="legend">Color</div><div class="swatches">${Object.entries(M.COLORS).map(([k, v]) => `<button type="button" class="swatch ${d.color === k ? 'on' : ''}" style="background:${v}" data-act="edit-color" data-color="${k}" title="${k}"></button>`).join('')}</div></div>
    ${!store.google.connected || d.googleEventID || d.source ? '' : M.isEvent(d)
      ? `<label class="check"><input type="checkbox" data-edit="syncGoogle" data-rerender ${m.syncGoogle ? 'checked' : ''}>${ic('sync')} Sync with Google Calendar</label>
         <div class="small muted" style="margin-top:-8px">${m.syncGoogle ? `Creates it in your Google Calendar${r.frequency !== 'none' ? ' (with the repeat schedule)' : ''}; edits stay in sync both ways.` : 'Keep this event in Cadence only.'}</div>`
      : `<label class="check"><input type="checkbox" data-edit="addToGoogle" ${m.addToGoogle ? 'checked' : ''}>Also add to Google Calendar${r.frequency !== 'none' ? ' (with the repeat schedule)' : ''}</label>`}
    ${m.error ? `<div class="error">${esc(m.error)}</div>` : ''}
    </div><div class="foot">${!m.isNew ? `<button type="button" class="btn danger" data-act="delete-task" data-task="${d.id}">Delete</button>` : ''}<span class="grow"></span>
      <button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary" ${m.saving ? 'disabled' : ''}>${m.isNew ? (M.isEvent(d) ? 'Add Event' : 'Add Task') : 'Save'}</button></div></form>`;
}

function readEditorInputs() {
  const m = ui.modal;
  if (m?.type !== 'editor') return;
  const root = $('#modal');
  const val = k => root.querySelector(`[data-edit="${k}"]`);
  if (val('title')) m.draft.title = val('title').value;
  if (val('notes')) m.draft.notes = val('notes').value;
  if (val('date')?.value) m.date = val('date').value;
  if (val('hasTime')) m.hasTime = val('hasTime').checked;
  if (val('time')?.value) m.time = val('time').value;
  if (val('duration')) m.draft.durationMinutes = Number(val('duration').value);
  if (val('frequency')) {
    const f = val('frequency').value;
    if (f === 'weekly' && m.draft.recurrence.frequency !== 'weekly' && !m.draft.recurrence.weekdays.length) m.draft.recurrence.weekdays = [M.weekday(M.parseKey(m.date))];
    m.draft.recurrence.frequency = f;
  }
  if (val('interval')) m.draft.recurrence.interval = Math.min(99, Math.max(1, Number(val('interval').value) || 1));
  if (val('endMode')) m.endMode = val('endMode').value;
  if (val('endDate')?.value) m.endDate = val('endDate').value;
  if (val('endCount')) m.endCount = Math.min(999, Math.max(1, Number(val('endCount').value) || 1));
  const notify = val('notify');
  if (root.querySelector('[data-edit="offset"]')) m.draft.reminderOffsets = [...root.querySelectorAll('[data-edit="offset"]:checked')].map(e => Number(e.value));
  if (notify && !notify.checked) m.draft.channels = [];
  else if (root.querySelector('[data-edit="channel"]')) m.draft.channels = [...root.querySelectorAll('[data-edit="channel"]:checked')].map(e => e.value);
  else if (notify?.checked) m.draft.channels = [...store.settings.defaultChannels];
  if (val('addToGoogle')) m.addToGoogle = val('addToGoogle').checked;
  if (val('syncGoogle')) m.syncGoogle = val('syncGoogle').checked;
}

async function saveEditor() {
  readEditorInputs();
  const m = ui.modal, t = structuredClone(m.draft);
  t.title = t.title.trim();
  if (!t.title) { m.error = 'Give the task a title.'; renderModal(); return; }
  t.startDate = M.iso(M.parseKey(m.date));
  if (m.hasTime) t.timeMinutes = editorStartMinutes(m); else delete t.timeMinutes;
  t.recurrence.end = m.endMode === 'onDate' ? { onDate: { _0: M.iso(M.parseKey(m.endDate)) } } : m.endMode === 'afterCount' ? { afterCount: { _0: m.endCount } } : { never: {} };
  if (t.recurrence.frequency === 'weekly' && !t.recurrence.weekdays.length) t.recurrence.weekdays = [M.weekday(M.parseKey(m.date))];
  if (t.recurrence.frequency !== 'weekly') t.recurrence.weekdays = [];
  t.reminderOffsets = t.reminderOffsets.filter(o => o >= 0 || (t.timeMinutes != null && -o < t.durationMinutes));
  if (!t.reminderOffsets.length) t.reminderOffsets = [0];
  const day0 = M.parseKey(m.date);
  const start0 = t.timeMinutes != null ? M.dayAt(day0, t.timeMinutes) : day0;
  const googleFields = {
    title: t.title, details: t.notes, allDay: t.timeMinutes == null, busy: M.isBusy(t),
    start: M.iso(start0), end: M.iso(M.addMinutes(start0, t.durationMinutes)),
    startDate: M.dateKey(day0), endDate: M.dateKey(M.addDays(day0, 1)),
  };

  // Editing an event that's synced with Google: save here, then push the change to Google.
  if (!m.isNew && t.source === 'google' && t.googleEventID) {
    store.upsertTask(t);
    closeModal();
    store.updateGoogleEvent({ ...googleFields, calendarID: t.sourceCalendar || 'primary', eventId: t.googleEventID })
      .then(() => toast('Updated in Google Calendar too', { icon: 'sync', tone: 'good' }))
      .catch(e => toast(`Saved in Cadence, but Google Calendar didn't update: ${e.message}`, { icon: 'alert', tone: 'bad' }));
    return;
  }

  // A new event that syncs with Google: create it in Google first, then keep it as the synced copy.
  if (m.isNew && M.isEvent(t) && m.syncGoogle && store.google.connected) {
    m.saving = true; renderModal();
    try {
      const ev = await store.createGoogleEvent({ ...googleFields, rrule: M.rrule(t.recurrence, day0) });
      if (t.recurrence.frequency === 'none') {
        // Same ID the importer would give it, so it's never imported twice.
        store.upsertTask({ ...t, id: await M.stableUUID(`google:${ev.id}`), kind: 'event', source: 'google', googleEventID: ev.id,
          sourceCalendar: ev.calendarID || 'primary', ...(ev.link ? { externalURL: ev.link } : {}) });
      }
      closeModal();
      toast(t.recurrence.frequency === 'none' ? 'Event added to Cadence and Google Calendar' : 'Repeating event created in Google Calendar; its dates appear here in a moment',
        { icon: 'sync', tone: 'good' });
      if (t.recurrence.frequency !== 'none') runImport();
    } catch (e) {
      store.upsertTask(t);
      m.saving = false; m.error = `Saved in Cadence only — Google Calendar failed: ${e.message}`; renderModal();
    }
    return;
  }

  store.upsertTask(t);
  if (!m.addToGoogle) { closeModal(); return; }
  m.saving = true; renderModal();
  try {
    const day = M.parseKey(m.date);
    const start = t.timeMinutes != null ? M.dayAt(day, t.timeMinutes) : day;
    const ev = await store.createGoogleEvent({
      title: t.title, details: t.notes, allDay: t.timeMinutes == null, busy: M.isBusy(t),
      start: M.iso(start), end: M.iso(M.addMinutes(start, t.durationMinutes)),
      startDate: M.dateKey(day), endDate: M.dateKey(M.addDays(day, 1)),
      rrule: M.rrule(t.recurrence, day),
    });
    const latest = store.tasks.get(t.id);
    if (latest) store.upsertTask({ ...latest, googleEventID: ev.id });
    closeModal();
  } catch (e) {
    m.saving = false; m.error = `Saved in Cadence, but Google Calendar failed: ${e.message}`; renderModal();
  }
}

// --- booking dialog (book a time inside an open stretch) ---
const BOOK_MINUTES = [15, 30, 45, 60, 90, 120];
function bookingDialog(m) {
  const g = store.google.connected;
  const t = `${String(m.start.getHours()).padStart(2, '0')}:${String(m.start.getMinutes()).padStart(2, '0')}`;
  return `<form class="dialog sm" data-form="booking"><div class="body">
    <h2>Book open time</h2><div class="muted">${M.fmtDay(m.start)} · open ${M.fmtTime(m.start)}–${M.fmtTime(m.rangeEnd)}</div>
    <label class="field"><span>Title</span><input class="input" name="title" placeholder="Meeting" autofocus></label>
    <div class="grid2"><label class="field"><span>Starts</span><input class="input" type="time" name="time" value="${t}" step="300" required></label>
      <label class="field"><span>Length</span><select class="input" name="minutes">${BOOK_MINUTES.map(n => `<option value="${n}" ${n === m.minutes ? 'selected' : ''}>${n < 60 ? `${n} min` : n % 60 ? `${Math.floor(n / 60)} hr ${n % 60} min` : `${n / 60} hr`}</option>`).join('')}</select></label></div>
    <div class="grid2"><label class="field"><span>Invitee name <span class="muted">(optional)</span></span><input class="input" name="name"></label>
      <label class="field"><span>Invitee email <span class="muted">(optional)</span></span><input class="input" name="email" type="email"></label></div>
    <label class="field"><span>Notes</span><textarea class="input" name="notes" rows="2"></textarea></label>
    ${g ? `<label class="check"><input type="checkbox" name="meet" checked>Add a Google Meet link</label>
      <div class="small muted">Saved to Google Calendar as a closed event. If you add an email, Google sends them an invitation.</div>`
      : '<div class="small muted">Google Calendar isn’t connected, so this is saved as a Cadence event only (no invitation).</div>'}
    ${m.error ? `<div class="error">${esc(m.error)}</div>` : ''}
    </div><div class="foot"><span class="grow"></span><button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary" ${m.working ? 'disabled' : ''}>Book</button></div></form>`;
}

// ---------- banners ----------
function showBanner(c) {
  const el = document.createElement('div');
  el.className = 'banner';
  el.innerHTML = `<span class="badge-icon" style="background:${c.tint || 'var(--accent)'}">${ic(c.kind === 'event' ? 'cal' : c.kind === 'checkIn' ? 'sun' : c.kind === 'nudge' ? 'list' : 'check')}</span>
    <div class="grow"><div class="row"><span class="k grow">CADENCE</span><span class="k">${M.fmtTime(new Date())}</span></div>
    <div class="t ellipsis">${esc(c.title)}</div><div class="b">${esc(c.body)}</div>
    <div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn sm" data-x>Dismiss</button>
    <button class="btn sm primary" data-open>${c.occurrence && !c.occurrence.done ? 'Complete…' : 'Open checklist'}</button></div></div>`;
  const remove = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 200); };
  el.querySelector('[data-x]').onclick = remove;
  el.querySelector('[data-open]').onclick = () => {
    remove();
    const occ = c.occurrence && findOcc(c.occurrence.id);
    if (occ && !occ.done) beginReflection(occ); else navigate('today');
  };
  const box = $('#banners');
  box.prepend(el);
  while (box.children.length > 4) box.lastElementChild.remove();
  const secs = store.settings.bannerAutoDismissSeconds;
  if (secs > 0) setTimeout(remove, secs * 1000);
}

// ---------- actions ----------
function beginReflection(o) {
  const fresh = findOcc(o.id) ?? o;
  openModal({ type: 'reflection', occ: fresh });
}

function newTaskAt(day, minutes) {
  openEditor(M.newTask({ busy: false, startDate: M.iso(M.startOfDay(day)), ...(minutes != null ? { timeMinutes: minutes } : {}), channels: [...store.settings.defaultChannels] }), true);
}

/** A new event defaults to the next whole hour, one hour long, with a 10-minute heads-up. */
function newEventAt(day, minutes) {
  const now = new Date();
  const m = minutes ?? (M.sameDay(day, now) ? Math.min(23 * 60, (now.getHours() + 1) * 60) : 9 * 60);
  openEditor(M.newTask({ kind: 'event', busy: true, color: 'teal', startDate: M.iso(M.startOfDay(day)), timeMinutes: m, durationMinutes: 60,
    reminderOffsets: [10], channels: [...store.settings.defaultChannels] }), true);
}

function toggleOcc(id, ctx) {
  const o = findOcc(id);
  if (!o) return;
  if (o.done) {
    store.uncomplete(o);
    if (ui.modal?.type === 'detail') closeModal();
    toast(`Unchecked ${o.task.title} — the reflection stays saved`, { icon: 'circle' });
    return;
  }
  if (ctx === 'checkin' && ui.modal?.type === 'checkin') { ui.modal.reflecting = o; renderModal(); return; }
  beginReflection(o);
}

function confirmThen(title, text, yes, fn) { openModal({ type: 'confirm', title, text, yes, fn }); }

const actions = {
  'new-task': el => newTaskAt(el.dataset.day ? M.parseKey(el.dataset.day) : new Date()),
  'new-event': el => newEventAt(el.dataset.day ? M.parseKey(el.dataset.day) : new Date()),
  'make-kind': el => {
    const t = store.tasks.get(el.dataset.task);
    if (!t) return;
    store.upsertTask({ ...t, kind: el.dataset.kind });
    if (ui.modal) closeModal();
    toast(el.dataset.kind === 'task' ? `“${t.title}” is now on your checklist` : `“${t.title}” is now an event`, { icon: el.dataset.kind === 'task' ? 'list' : 'cal',
      undo: () => store.upsertTask({ ...store.tasks.get(t.id), kind: t.kind }) });
  },
  'edit-kind': el => {
    readEditorInputs();
    const m = ui.modal, k = el.dataset.kind;
    m.draft.kind = k;
    if (!m.busyChosen) m.draft.busy = k === 'event';   // events start closed, tasks open
    if (k === 'event' && m.isNew) {
      if (!m.hasTime) { m.hasTime = true; m.time = '09:00'; }
      if (m.draft.durationMinutes === 30) m.draft.durationMinutes = 60;
      m.draft.reminderOffsets = [10];
    }
    renderModal();
  },
  'edit-busy': el => { readEditorInputs(); ui.modal.draft.busy = el.dataset.busy === '1'; ui.modal.busyChosen = true; renderModal(); },
  'new-at': el => { const d = new Date(Number(el.dataset.at)); newTaskAt(d, Math.min(1435, Math.floor(M.minutesOf(d) / 5) * 5)); },
  edit: el => { const t = store.tasks.get(el.dataset.task); if (t) openEditor(t, false); },
  toggle: el => toggleOcc(el.dataset.occ, el.dataset.ctx),
  skip: el => {
    const o = findOcc(el.dataset.occ);
    if (!o) return;
    const before = structuredClone(o.task);
    store.skip(o);
    if (ui.modal?.type === 'detail') closeModal();
    toast(`Skipped ${o.task.title} for ${M.fmtDay(o.day, { weekday: 'short', month: 'short', day: 'numeric' })}`, { icon: 'right', undo: () => store.upsertTask({ ...before, skipped: (store.tasks.get(before.id)?.skipped || []).filter(k => k !== o.key) }) });
  },
  'delete-task': el => {
    const t = store.tasks.get(el.dataset.task);
    if (!t) return;
    if (t.source === 'google' && t.googleEventID && store.google.connected) { openModal({ type: 'delete-google', task: t }); return; }
    const copy = structuredClone(t);
    store.deleteTask(t.id);
    if (ui.modal) closeModal();
    toast(`Deleted “${t.title}”`, { icon: 'trash', undo: () => { store.restoreTask(copy); toast('Task restored', { icon: 'check' }); } });
  },
  'confirm-yes': () => { const fn = ui.modal.fn; closeModal(); fn(); },
  close: el => { const then = el.dataset.then; closeModal(); if (then) navigate(then); },
  overlay: (el, e) => { if (e.target === el && ui.modal?.type !== 'editor') closeModal(); },
  'checkin-back': () => { ui.modal.reflecting = null; renderModal(); },
  'check-in': () => reminders.checkIn('Daily check-in', { manual: true }),
  detail: el => openModal({ type: 'detail', item: el.dataset.item }),
  'sign-out': () => confirmThen('Sign out?', 'You’ll need your username and password to sign back in on this browser.', 'Sign out', () => store.signOut()),
  'auth-mode': el => { ui.auth = { mode: el.dataset.mode, error: null, busy: false }; render(); },
  'week-prev': () => { ui.weekStart = M.addDays(ui.weekStart, -7); render(); },
  'week-next': () => { ui.weekStart = M.addDays(ui.weekStart, 7); render(); },
  'week-today': () => { ui.weekStart = M.startOfWeek(new Date()); ui.weekScrolled = false; render(); },
  'month-prev': () => { ui.month = M.addMonths(ui.month, -1); render(); },
  'month-next': () => { ui.month = M.addMonths(ui.month, 1); render(); },
  'month-today': () => { ui.month = M.startOfMonth(new Date()); ui.selectedDay = M.startOfDay(new Date()); render(); },
  'select-day': (el, e) => {
    if (e.detail === 2) { newTaskAt(M.parseKey(el.dataset.day)); return; }
    ui.selectedDay = M.parseKey(el.dataset.day); render();
  },
  'todo-mode': el => { ui.todo.mode = el.dataset.mode; render(); },
  'export-refl': () => {
    let md = '# Cadence Reflections\n\n', last = '';
    for (const r of store.sortedReflections()) {
      const k = M.dateKey(r.createdAt);
      if (k !== last) { md += `## ${M.fmtDay(r.createdAt, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}\n\n`; last = k; }
      md += `### ${r.taskTitle} — ${M.fmtTime(r.createdAt)}\n\n${r.text}\n\n`;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    a.download = `Cadence Reflections ${M.dateKey(new Date())}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  'copy-refl': el => { navigator.clipboard?.writeText(store.reflections.get(el.dataset.id)?.text ?? ''); toast('Copied to clipboard', { icon: 'copy' }); },
  'delete-refl': el => {
    const r = store.reflections.get(el.dataset.id);
    if (!r) return;
    const copy = structuredClone(r);
    store.deleteReflection(r.id);
    toast('Reflection deleted', { icon: 'trash', undo: () => store.restoreReflection(copy) });
  },
  'busy-refresh': () => { ui.booking.loadedFor = null; loadBusy(); },
  'copy-avail': () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let text = `Here’s when I’m free over the next week (${tz}):\n\n`;
    for (const d of ui.booking.week || []) if (d.open.length) {
      text += `• ${M.fmtDay(d.day, { weekday: 'long', month: 'short', day: 'numeric' })}: ${d.open.map(([s, e]) => `${M.fmtTime(s)}–${M.fmtTime(e)}`).join(', ')}\n`;
    }
    text += '\nLet me know what works and I’ll send an invite.';
    navigator.clipboard?.writeText(text);
    ui.booking.message = 'Open times copied to the clipboard.'; render();
  },
  'ot-book': (el, e) => {
    // Start where you clicked (rounded down to 15 minutes), kept inside the open stretch.
    const s = Number(el.dataset.s), end = Number(el.dataset.e);
    const r = el.getBoundingClientRect();
    const at = s + ((e?.clientY ?? r.top) - r.top) / r.height * (end - s);
    const q = 15 * 60_000, latest = Math.max(s, end - q);
    let start = Math.min(latest, Math.max(s, Math.floor(at / q) * q));
    if (start < s) start = s;
    openModal({ type: 'booking', start: new Date(start), rangeEnd: new Date(end), minutes: Math.min(30, Math.max(15, Math.round((end - start) / 60_000))) });
  },
  'sync-now': () => { syncUI.manual = true; store.sync(); },
  'copy-origin': () => { navigator.clipboard?.writeText(location.origin); toast('Address copied', { icon: 'copy' }); },
  'clear-flash': () => { ui.flash = null; render(); },
  'ask-notify': async () => { if ('Notification' in window) await Notification.requestPermission(); render(); },
  'test-reminder': () => reminders.deliver({ kind: 'test', title: 'Test reminder', body: 'This is how Cadence reminders will look.', tint: '#0a84ff' }, store.settings.defaultChannels),
  'google-refresh': () => store.refreshGoogle(),
  'delete-account': () => openModal({ type: 'delete-account' }),
  'google-hide': () => {
    const t = ui.modal.task;
    store.deleteTask(t.id);   // imported items are hidden, not deleted
    closeModal();
    toast(`Hid “${t.title}” in Cadence`, { icon: 'trash', undo: () => store.upsertTask({ ...store.tasks.get(t.id), archived: false }) });
  },
  'google-delete': async () => {
    const m = ui.modal, t = m.task;
    m.working = true; renderModal();
    try {
      await store.deleteGoogleEvent(t.sourceCalendar || 'primary', t.googleEventID);
      store.deleteTask(t.id);
      closeModal();
      toast(`Deleted “${t.title}” from Cadence and Google Calendar`, { icon: 'trash' });
    } catch (e) {
      m.working = false; m.error = `Google Calendar didn't delete it: ${e.message}`; renderModal();
    }
  },
  'calendly-refresh': () => store.refreshCalendly(),
  'calendly-disconnect': () => confirmThen('Disconnect Calendly?', 'Meetings already on your checklist stay; new ones won’t be imported.', 'Disconnect', () => store.disconnectCalendly()),
  'import-now': () => runImport({ manual: true }),
  'copy-text': el => { navigator.clipboard?.writeText(el.dataset.text); toast('Link copied', { icon: 'copy' }); },
  'google-disconnect': () => confirmThen('Disconnect Google Calendar?', 'Cadence will stop showing your Google events on the web.', 'Disconnect', () => store.disconnectGoogle()),
  'avail-day': el => {
    const w = Number(el.dataset.w), a = store.settings.availability;
    const days = a.weekdays.includes(w) ? a.weekdays.filter(x => x !== w) : [...a.weekdays, w].sort();
    if (days.length) store.updateSettings({ availability: { ...a, weekdays: days } });
  },
  'edit-weekday': el => {
    readEditorInputs();
    const r = ui.modal.draft.recurrence, w = Number(el.dataset.w);
    const cur = M.effectiveWeekdays(r, M.parseKey(ui.modal.date));
    r.weekdays = cur.includes(w) ? (cur.length > 1 ? cur.filter(x => x !== w) : cur) : [...cur, w].sort();
    renderModal();
  },
  'edit-weekdays': () => { readEditorInputs(); ui.modal.draft.recurrence.weekdays = [2, 3, 4, 5, 6]; renderModal(); },
  'edit-color': el => { readEditorInputs(); ui.modal.draft.color = el.dataset.color; renderModal(); },
};

// Single click on a week block opens details; double click adds a task at that moment.
let blockClickTimer = null;
document.addEventListener('click', e => {
  const block = e.target.closest('.block');
  if (block) {
    clearTimeout(blockClickTimer);
    if (e.detail === 1) blockClickTimer = setTimeout(() => openModal({ type: 'detail', item: block.dataset.item }), 220);
    return;
  }
  const link = e.target.closest('a[href^="/app"]');
  if (link && !link.target && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    const href = link.getAttribute('href');
    navigate(href === '/app' ? 'home' : href.replace(/^\/app\//, ''));
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (fn) { if (el.tagName === 'BUTTON' && el.type !== 'submit') e.preventDefault(); fn(el, e); }
});

document.addEventListener('dblclick', e => {
  const col = e.target.closest('.wcol');
  if (!col) return;
  clearTimeout(blockClickTimer);
  const day = M.parseKey(col.dataset.day);
  const y = e.clientY - col.getBoundingClientRect().top;
  const block = e.target.closest('.block');
  // Inside an existing block: exact time (5-minute steps) so the new task's reminder lands mid-task.
  const step = block ? 5 : 30;
  const minutes = Math.min(1435, Math.max(0, Math.floor((y / HOUR) * 60 / step) * step));
  newTaskAt(day, minutes);
});

document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'reflText') {
    const min = Number(el.dataset.min), n = M.countWords(el.value);
    $('#reflCount').textContent = `${n} / ${min} words`;
    $('#reflCount').className = `small ${n >= min ? 'green' : 'muted'}`;
    $('#reflBar').className = `progress ${n >= min ? 'ok' : ''}`;
    $('#reflBar').firstElementChild.style.width = `${Math.min(100, (n / min) * 100)}%`;
    $('#reflSubmit').disabled = n < min;
    return;
  }
  const bind = el.dataset.bind;
  if (bind === 'todoSearch') { ui.todo.search = el.value; render(); }
  if (bind === 'reflSearch') { ui.reflSearch = el.value; render(); }
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.bind === 'todoRange') { ui.todo.range = Number(el.value); render(); return; }
  if (el.dataset.bind === 'todoCompleted') { ui.todo.showCompleted = el.checked; render(); return; }
  if (el.closest('[data-form="editor"]')) {
    if ('rerender' in el.dataset) { readEditorInputs(); renderModal(); }
    return;
  }
  if (el.dataset.setting) {
    const key = el.dataset.setting;
    const v = el.dataset.type === 'bool' ? el.checked : Number.isNaN(Number(el.value)) ? el.value : Number(el.value);
    if (key.startsWith('availability.')) store.updateSettings({ availability: { ...store.settings.availability, [key.split('.')[1]]: v } });
    else store.updateSettings({ [key]: v });
    return;
  }
  if (el.dataset.settingSet) {
    const key = el.dataset.settingSet;
    const set = new Set(store.settings[key]);
    if (el.checked) set.add(el.value); else set.delete(el.value);
    store.updateSettings({ [key]: [...set] });
    return;
  }
  if (el.dataset.actChange === 'browser-reminders') { store.setDevice('browserReminders', el.checked); render(); return; }
  if (el.dataset.actChange === 'gcal') {
    const ids = [...document.querySelectorAll('[data-act-change="gcal"]:checked')].map(x => x.value);
    store.setDevice('googleCalendarIDs', ids);
    store.refreshGoogle();
  }
});

document.addEventListener('submit', async e => {
  const form = e.target;
  e.preventDefault();
  const kind = form.dataset.form;
  if (kind === 'quick') {
    const input = form.querySelector('input');
    const title = input.value.trim();
    if (title) {
      store.upsertTask(M.newTask({ title, channels: [...store.settings.defaultChannels] }));
      toast(`Added “${title}” to today`, { icon: 'plus' });
    }
    input.value = '';
  } else if (kind === 'auth') {
    const fd = new FormData(form);
    ui.auth.busy = true; ui.auth.error = null; render();
    try {
      await store.signIn(String(fd.get('username')).trim(), String(fd.get('password')), { create: ui.auth.mode === 'register', remember: fd.get('remember') === 'on' });
      ui.auth = { mode: 'login', error: null, busy: false };
      navigate('home');
      reminders.checkIn('Time to check in');
    } catch (err) {
      ui.auth.busy = false; ui.auth.error = err.message; render();
    }
  } else if (kind === 'reflection') {
    const text = $('#reflText').value.trim();
    const o = findOcc(form.dataset.occ);
    if (!o || !store.complete(o, text)) return;
    ui.justDone.add(o.id);
    setTimeout(() => { ui.justDone.delete(o.id); }, 1200);
    toast(`Checked off ${o.task.title} · reflection saved`, { icon: 'check', tone: 'good' });
    if (form.dataset.ctx === 'checkin') { ui.modal.reflecting = null; renderModal(); render(); } else closeModal();
  } else if (kind === 'delete-account') {
    const m = ui.modal;
    m.working = true; m.error = null; renderModal();
    try {
      await store.deleteAccount(String(new FormData(form).get('password')));
      ui.modal = null; renderModal();
      ui.auth = { mode: 'login', error: null, busy: false };
      render();
      toast('Your account and data were deleted', { icon: 'check' });
    } catch (err) {
      m.working = false; m.error = err.message; renderModal();
    }
  } else if (kind === 'calendly') {
    const token = String(new FormData(form).get('token') || '').trim();
    ui.calendlyBusy = true; render();
    try {
      await store.connectCalendly(token);
      toast(`Calendly connected${store.calendly.name ? ` as ${store.calendly.name}` : ''}`, { icon: 'check', tone: 'good' });
      runImport({ manual: true });
    } catch (err) {
      toast(err.message, { icon: 'alert', tone: 'bad' });
    }
    ui.calendlyBusy = false; render();
  } else if (kind === 'editor') {
    saveEditor();
  } else if (kind === 'booking') {
    const m = ui.modal, fd = new FormData(form);
    const name = String(fd.get('name') || '').trim(), email = String(fd.get('email') || '').trim();
    const title = String(fd.get('title') || '').trim() || (name ? `Meeting with ${name}` : 'Meeting');
    const [hh, mm] = String(fd.get('time')).split(':').map(Number);
    const minutes = Number(fd.get('minutes')) || 30, notes = String(fd.get('notes') || '');
    const start = M.dayAt(m.start, hh * 60 + mm), end = M.addMinutes(start, minutes);
    const local = M.newTask({ kind: 'event', busy: true, color: 'purple', title, notes, startDate: M.iso(M.startOfDay(start)),
      timeMinutes: hh * 60 + mm, durationMinutes: minutes, reminderOffsets: [10], channels: [...store.settings.defaultChannels] });
    m.working = true; m.error = null; renderModal();
    try {
      if (store.google.connected) {
        const ev = await store.createGoogleEvent({ title, details: notes, start: M.iso(start), end: M.iso(end), busy: true,
          ...(email ? { attendees: [{ email, name }] } : {}), addMeetLink: fd.get('meet') === 'on' });
        // Keep the synced copy right away (same ID the importer gives it) so open time updates at once.
        store.upsertTask({ ...local, id: await M.stableUUID(`google:${ev.id}`), source: 'google', googleEventID: ev.id,
          sourceCalendar: ev.calendarID || 'primary', ...(ev.link ? { externalURL: ev.link } : {}) });
        ui.booking.message = email ? `Booked “${title}” — invitation sent to ${email}.` : `Booked “${title}” in Cadence and Google Calendar.`;
      } else {
        store.upsertTask(local);
        ui.booking.message = `Booked “${title}” on your Cadence calendar.`;
      }
      ui.booking.loadedFor = null;
      closeModal();
    } catch (err) {
      m.working = false; m.error = err.message; renderModal();
    }
  }
});

const SHORTCUT_FOR = { home: 'H', today: 'T', week: 'W', month: 'M', todo: 'L', reflections: 'R', booking: 'B', settings: ',' };
document.addEventListener('keydown', e => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (!typing && !ui.modal && store.user && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const k = e.key.toLowerCase();
    const route = Object.entries(SHORTCUT_FOR).find(([, key]) => key.toLowerCase() === k)?.[0];
    if (route) { e.preventDefault(); navigate(route); return; }
    if (k === 'n') { e.preventDefault(); newTaskAt(new Date()); return; }
    if (k === 'e') { e.preventDefault(); newEventAt(new Date()); return; }
    if (k === 'c') { e.preventDefault(); reminders.checkIn('Daily check-in', { manual: true }); return; }
    if (k === 's') { e.preventDefault(); syncUI.manual = true; store.sync(); return; }
  }
  if (e.key === 'Escape' && ui.modal && ui.modal.type !== 'editor') closeModal();
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.id === 'reflText' && !$('#reflSubmit').disabled) $('#reflSubmit').click();
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.closest('[data-form="editor"]')) { e.preventDefault(); saveEditor(); }
});

// Keep "now" lines, greetings and day boundaries fresh.
setInterval(() => { if (!ui.modal || ['checkin', 'detail'].includes(ui.modal.type)) render(); }, 60_000);

// ---------- calendar imports (Google + Calendly → silent checklist items) ----------
// IDs match the Mac app (stableUUID of "google:<event id>" / "calendly:<uri>"), so either device can import.
async function runImport({ manual = false } = {}) {
  if (ui.importing || !store.user) return;
  const s = store.settings;
  if (!manual && !s.autoImportCalendars) return;
  if (!store.google.connected && !store.calendly.connected) {
    if (manual) toast('Connect Google Calendar or Calendly first', { icon: 'alert', tone: 'bad' });
    return;
  }
  ui.importing = true; render();
  const from = M.startOfDay(new Date()), to = M.addDays(from, Math.max(1, s.importDaysAhead));
  const parts = [];
  const summary = (name, r) => `${name}: ${r.added} new, ${r.updated} updated, ${r.removed} removed`;
  if (store.google.connected) {
    try {
      const { events, cancelled } = await store.googleImportWindow(from, to);
      const items = await Promise.all(events.map(googleTask));
      const archiveIds = new Set(await Promise.all(cancelled.map(id => M.stableUUID(`google:${id}`))));
      // Imported earlier but no longer in the window: moved or deleted. Ask Google about each.
      const seen = new Set([...items.map(i => i.id), ...archiveIds]);
      const stale = [...store.tasks.values()].filter(t => t.source === 'google' && !t.archived && !Object.keys(t.completions || {}).length
        && !seen.has(t.id) && new Date(t.startDate) >= from && new Date(t.startDate) < to && t.googleEventID).slice(0, 25);
      for (const t of stale) {
        const ev = await store.googleEvent(t.sourceCalendar || 'primary', t.googleEventID).catch(() => undefined);
        if (ev) items.push(await googleTask(ev)); else if (ev === null) archiveIds.add(t.id);
      }
      parts.push(summary('Google', store.applyImport('google', items, from, to, { archiveMissing: false, archiveIds })));
      store.refreshGoogleView();
    } catch (e) { parts.push(`Google failed: ${e.message}`); }
  }
  if (store.calendly.connected && (manual || Date.now() - ui.lastCalendlyImport > 30 * 60_000)) {
    ui.lastCalendlyImport = Date.now();
    try {
      const meetings = await store.calendlyMeetings(from, to);
      const items = await Promise.all(meetings.map(async m => {
        const st = new Date(m.start), en = new Date(m.end);
        return M.newTask({
          id: await M.stableUUID(`calendly:${m.uri}`), title: m.name + (m.invitees.length ? ` with ${m.invitees.join(', ')}` : ''),
          notes: m.location || '', startDate: M.iso(M.startOfDay(st)), timeMinutes: M.minutesOf(st),
          durationMinutes: Math.max(5, Math.floor((en - st) / 60_000)),
          channels: [], color: 'purple', source: 'calendly', ...(m.joinURL ? { externalURL: m.joinURL } : {}),
        });
      }));
      parts.push(summary('Calendly', store.applyImport('calendly', items, from, to)));
    } catch (e) { parts.push(`Calendly failed: ${e.message}`); }
  }
  ui.importing = false;
  ui.importSummary = `${parts.join(' · ')} — ${M.fmtTime(new Date())}`;
  if (manual) toast(parts.join(' · '), { icon: parts.some(p => p.includes('failed')) ? 'alert' : 'check' });
  render();
}
// Google is re-checked every 2 minutes and whenever you come back to the tab; Calendly every 30.
ui.lastCalendlyImport = 0;
setInterval(() => { if (!document.hidden) runImport(); }, 2 * 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) runImport(); });

/** A Google event as a silent checklist task — field-for-field the same as the Mac and server importers. */
async function googleTask(e) {
  const raw = e.id.slice(e.id.indexOf('|') + 1);
  const st = e.isAllDay ? M.parseKey(e.start) : new Date(e.start);
  const en = e.isAllDay ? M.parseKey(e.end) : new Date(e.end);
  return M.newTask({
    id: await M.stableUUID(`google:${raw}`), title: e.title, notes: M.eventNotes(e.description, e.location),
    startDate: M.iso(M.startOfDay(st)), ...(e.isAllDay ? {} : { timeMinutes: M.minutesOf(st) }),
    durationMinutes: e.isAllDay ? 30 : Math.max(5, Math.floor((en - st) / 60_000)),
    channels: [], color: 'blue', source: 'google', googleEventID: raw, sourceCalendar: e.calendarID,
    ...(e.link ? { externalURL: e.link } : {}), busy: !e.transparent,
  });
}

// ---------- sync indicator ----------
const syncUI = { manual: false, spinUntil: 0, flashUntil: 0 };

function relTime(d) {
  const sec = (Date.now() - new Date(d)) / 1000;
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  return `at ${M.fmtTime(d)}`;
}

function syncControl(size = '') {
  return `<button class="syncbtn ${size}" data-act="sync-now" data-sync-ui title="Sync now (S)">
    <span class="sync-icon">${ic('sync', 'spin')}${ic('check', 'done')}</span><span class="sync-label">Sync</span></button>`;
}

function updateSyncUI() {
  const now = Date.now();
  const spinning = now < syncUI.spinUntil;
  const s = store.syncState;
  let label, state;
  if (spinning) { label = 'Syncing…'; state = 'syncing'; }
  else if (s.status === 'offline') { label = s.error || 'Offline'; state = 'offline'; }
  else if (s.lastSynced) { label = `Synced ${relTime(s.lastSynced)}`; state = now < syncUI.flashUntil ? 'synced flash' : 'synced'; }
  else { label = 'Not synced yet'; state = ''; }
  if (store.pending.size && !spinning) label += ` · ${store.pending.size} waiting`;
  for (const el of document.querySelectorAll('[data-sync-ui]')) {
    el.className = `syncbtn ${el.classList.contains('big') ? 'big' : ''} ${state}`;
    el.querySelector('.sync-label').textContent = label;
    el.title = s.status === 'offline' ? `${label} — click to retry` : 'Sync now (S)';
  }
}

store.onSync(() => {
  if (store.syncing) {
    // Show motion for anything the user caused (a button press or a local edit being pushed);
    // quiet background polls don't flicker the icon.
    if (syncUI.manual || store.pending.size) syncUI.spinUntil = Math.max(syncUI.spinUntil, Date.now() + 750);
    updateSyncUI();
    return;
  }
  const visible = syncUI.spinUntil > Date.now() - 50;
  const finish = () => {
    if (visible && store.syncState.status === 'synced') syncUI.flashUntil = Date.now() + 1400;
    if (syncUI.manual && store.syncState.status === 'offline') toast(store.syncState.error || 'Couldn’t reach the server', { icon: 'alert', tone: 'bad' });
    syncUI.manual = false;
    updateSyncUI();
    setTimeout(updateSyncUI, 1500);
  };
  setTimeout(finish, Math.max(0, syncUI.spinUntil - Date.now()));
});
setInterval(updateSyncUI, 30_000);
addEventListener('offline', updateSyncUI);

// ---------- progress rings animate from their previous value ----------
function animateRings() {
  const arcs = document.querySelectorAll('.ring-arc[data-to]');
  if (!arcs.length) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const a of arcs) a.style.strokeDashoffset = a.dataset.to;
  }));
}

// ---------- toasts ----------
function toast(text, { icon = 'check', undo, tone } = {}) {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.append(box); }
  const el = document.createElement('div');
  el.className = `toast ${tone || ''}`;
  el.innerHTML = `${ic(icon)}<span class="grow">${esc(text)}</span>${undo ? '<button class="btn sm">Undo</button>' : ''}`;
  const close = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 200); };
  if (undo) el.querySelector('button').onclick = () => { undo(); close(); };
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(close, undo ? 6000 : 2800);
}

// ---------- desktop app (Windows/Linux) ----------
// The desktop wrapper exposes window.cadenceDesktop: wake/unlock events, tray commands, a tray badge.
if (window.cadenceDesktop) {
  window.cadenceDesktop.onWake(() => reminders.checkIn('Welcome back — check your list'));
  window.cadenceDesktop.onCommand(cmd => {
    if (cmd === 'check-in') reminders.checkIn('Daily check-in', { manual: true });
    if (cmd === 'new-task') newTaskAt(new Date());
  });
  store.subscribe(() => window.cadenceDesktop.setBadge(store.user ? store.remainingToday() : 0));
}

// ---------- start ----------
readRoute();
store.subscribe(render);
store.boot().then(() => {
  booted = true;
  render();
  if (store.user) reminders.start();
  else store.subscribe(function startOnce() { if (store.user && !reminders.started) { reminders.started = true; reminders.start(); } });
  if (store.user) reminders.started = true;
  setTimeout(() => runImport(), 4000);
});
