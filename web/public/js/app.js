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
  ['today', 'Today', 'sun', 'Plan'], ['week', 'Week', 'week', 'Plan'], ['month', 'Month', 'month', 'Plan'],
  ['todo', 'To-Do List', 'list', 'Plan'], ['reflections', 'Reflections', 'quote', 'Grow'],
  ['booking', 'Booking', 'people', 'Connect'], ['settings', 'Settings', 'gear', ''],
];

const ui = {
  route: 'today',
  weekStart: M.startOfWeek(new Date()),
  month: M.startOfMonth(new Date()),
  selectedDay: M.startOfDay(new Date()),
  todo: { mode: 'checklist', range: 7, showCompleted: true, search: '' },
  reflSearch: '',
  booking: { meetingId: null, busy: [], loading: false, message: null, loadedFor: null },
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
    else { location.hash = 'today'; }
  },
});

// ---------- routing ----------
function readRoute() {
  const [route, query] = location.hash.replace(/^#/, '').split('?');
  ui.route = SCREENS.some(s => s[0] === route) ? route : 'today';
  const google = new URLSearchParams(query || '').get('google');
  if (google) {
    ui.flash = google === 'connected' ? 'Google Calendar connected.' : `Google: ${google}`;
    history.replaceState(null, '', '#settings');
    store.refreshGoogle();
  }
}
addEventListener('hashchange', () => { readRoute(); render(); });

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
    if (section !== lastSection) { head = section ? `<div class="nav-section">${section}</div>` : '<div class="nav-section"></div>'; lastSection = section; }
    const badge = id === 'today' ? store.remainingToday() : id === 'reflections' ? store.reflections.size : '';
    return `${head}<a class="nav-item ${ui.route === id ? 'on' : ''}" href="#${id}" title="${label} (${SHORTCUT_FOR[id]})">${ic(icon)}<span class="lbl">${label}</span>${badge ? `<span class="badge">${badge}</span>` : ''}</a>`;
  }).join('');
  return `<nav class="sidebar">
    <div class="brand"><img src="/icon-192.png" alt=""><span>Cadence</span></div>
    ${items}
    <div class="spacer"></div>
    <button class="btn primary" data-act="new-task" title="New task (N)">${ic('plus')} New Task</button>
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
    default: return todayView();
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

// ---------- Today ----------
function todayView() {
  const today = new Date();
  const items = store.occurrencesOn(today), overdue = store.overdue(), all = [...overdue, ...items];
  const done = all.filter(o => o.done).length;
  const hour = today.getHours();
  const greet = hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 17 ? 'Good afternoon' : 'Good evening';
  const status = !all.length ? 'A clear day.' : done === all.length ? 'Everything is checked off. Nice work.' : `${all.length - done} of ${all.length} left to check off.`;
  const events = store.googleEventsOn(today);
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
    ${store.google.connected && s.showGoogleEvents ? `<div><div class="section-title">${ic('cal')}On your Google Calendar <span class="count">${events.length}</span></div>
      <div class="card">${events.length ? events.map(e => `<div class="crow"><span class="bar" style="background:${e.colorHex || '#0a84ff'}"></span>
        <span class="muted" style="width:150px">${e.isAllDay ? 'All day' : `${M.fmtTime(e.startDate)} – ${M.fmtTime(e.endDate)}`}</span>
        <span class="grow ellipsis">${esc(e.title)}</span>${e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener" title="Open in Google Calendar">${ic('link')}</a>` : ''}</div>`).join('')
        : '<div class="crow muted">No events today.</div>'}</div></div>` : ''}
    <div class="callout"><span class="big">${ic('bell')}</span><div class="grow">
      <b>${s.nudgeEnabled ? `Checklist reminder every ${s.nudgeIntervalMinutes} min while this page is open` : 'Recurring checklist reminders are off'}</b>
      <div class="small muted">${!reminders.enabled ? 'Browser reminders are off on this device (Settings).' : s.nudgeEnabled ? `Next one around ${M.fmtTime(reminders.nextNudge)}. You’ll also get a check-in when you come back to your computer.` : 'Turn them on in Settings.'}</div></div>
      <button class="btn" data-act="check-in">Check in now</button></div>
  </div>`;
}

// ---------- Week ----------
function calItemsTimed(day) {
  const items = [];
  for (const o of store.occurrencesOn(day)) if (o.start) items.push({ kind: 'task', o, start: o.start, end: o.end, title: o.task.title, color: color(o.task.color), done: o.done, id: `t|${o.id}` });
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

const chipFor = it => `<div class="chip ${it.done ? 'done' : ''}" style="background:${tint(it.color, it.kind === 'google' ? .12 : .18)}" data-act="detail" data-item="${esc(it.id)}">
  ${it.kind === 'google' ? `<span style="color:${it.color}">${ic('cal')}</span>` : `<span class="dot" style="border-color:${it.color};background:${it.done ? it.color : 'transparent'}"></span>`}
  <span>${it.start && it.kind !== 'allday' ? `<span class="muted">${M.fmtTime(it.start)}</span> ` : ''}${esc(it.title)}</span></div>`;

function allDayItems(day) {
  return [
    ...store.occurrencesOn(day).filter(o => !o.start).map(o => ({ kind: 'task', o, title: o.task.title, color: color(o.task.color), done: o.done, id: `t|${o.id}` })),
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
      <div class="row"><button class="btn icon" data-act="week-prev" title="Previous week">${ic('left')}</button>
      <button class="btn" data-act="week-today">Today</button><button class="btn icon" data-act="week-next" title="Next week">${ic('right')}</button></div></div>
    <div class="week-head"><div></div>${days.map(d => {
      const open = store.occurrencesOn(d).filter(o => !o.done).length;
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
          return `<div class="block ${p.done ? 'done' : ''}" data-item="${esc(p.id)}" data-start="${+p.start}" data-end="${+p.end}"
            title="Click for details · double-click to add a task at this time"
            style="top:${top}px;height:${Math.max(20, bottom - top - 1)}px;left:calc(${(p.lane * 100) / p.lanes}% + 2px);width:calc(${100 / p.lanes}% - 4px);
            background:${tint(p.color, p.done ? .1 : p.kind === 'google' ? .16 : .24)};border-color:${p.color}">
            <b>${p.kind === 'google' ? `${ic('cal')} ` : ''}${esc(p.title)}</b>${M.fmtTime(p.start)}</div>`;
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
      ...store.occurrencesOn(d).map(o => ({ kind: 'task', title: o.task.title, color: color(o.task.color), done: o.done, id: `t|${o.id}` })),
      ...store.googleEventsOn(d).map(e => ({ kind: 'google', title: e.title, color: e.colorHex || '#0a84ff', id: `g|${e.id}` })),
    ];
    const max = 4, shown = items.length > max ? max - 1 : max;
    const tasks = store.occurrencesOn(d);
    const allDone = tasks.length && tasks.every(o => o.done);
    return `<div class="mcell ${d.getMonth() !== ui.month.getMonth() ? 'out' : ''} ${M.isToday(d) ? 'today' : ''} ${M.sameDay(d, ui.selectedDay) ? 'sel' : ''}" data-act="select-day" data-day="${M.dateKey(d)}">
      <div class="row"><span class="n">${d.getDate()}</span><span class="grow"></span>${allDone ? `<span class="green small" title="Everything done">${ic('check')}</span>` : ''}</div>
      ${items.slice(0, shown).map(it => `<div class="chip ${it.done ? 'done' : ''}" style="background:${tint(it.color, .13)}">
        ${it.kind === 'google' ? `<span style="color:${it.color}">${ic('cal')}</span>` : `<span class="dot" style="border-color:${it.color};background:${it.done ? 'transparent' : it.color}"></span>`}<span>${esc(it.title)}</span></div>`).join('')}
      ${items.length > shown ? `<div class="more">+${items.length - shown} more</div>` : ''}</div>`;
  }).join('');
  const sel = ui.selectedDay;
  const tasks = store.occurrencesOn(sel), events = store.googleEventsOn(sel);
  return `<div class="month"><div class="month-main">
    <div class="header"><div class="grow"><h1>${M.fmtDay(ui.month, { month: 'long', year: 'numeric' })}</h1><div class="sub">Click a day to see it, double-click to add a task.</div></div>
      <div class="row"><button class="btn icon" data-act="month-prev">${ic('left')}</button><button class="btn" data-act="month-today">Today</button><button class="btn icon" data-act="month-next">${ic('right')}</button></div></div>
    <div class="dows">${M.WEEKDAY_SHORT.map(w => `<div>${w.toUpperCase()}</div>`).join('')}</div>
    <div class="mgrid">${cells}</div></div>
    <aside class="daypanel stack" style="gap:12px">
      <div><div class="muted">${M.fmtDay(sel, { weekday: 'long' })}</div><h2 style="margin:0">${M.fmtDay(sel, { month: 'long', day: 'numeric' })}</h2></div>
      <button class="btn" data-act="new-task" data-day="${M.dateKey(sel)}">${ic('plus')} Add task on this day</button>
      ${!tasks.length && !events.length ? '<div class="muted">Nothing planned.</div>' : ''}
      ${tasks.length ? `<div><div class="section-title">Checklist <span class="count">${tasks.length}</span></div>${tasks.map(o => crow(o, { compact: true })).join('')}</div>` : ''}
      ${events.length ? `<div><div class="section-title">Google Calendar <span class="count">${events.length}</span></div>
        <div class="stack" style="gap:4px">${events.map(e => chipFor({ kind: 'google', e, title: e.title, color: e.colorHex || '#0a84ff', id: `g|${e.id}`, start: e.isAllDay ? null : e.startDate })).join('')}</div></div>` : ''}
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
      .map(d => [d, store.occurrencesOn(d).filter(o => match(o.task.title) && (t.showCompleted || !o.done))])
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
  } else {
    const tasks = [...store.tasks.values()].filter(x => match(x.title));
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
    <button class="${t.mode === 'tasks' ? 'on' : ''}" data-act="todo-mode" data-mode="tasks">All tasks</button></div></div>
    <div class="page stack">
      <div class="row" style="flex-wrap:wrap">
        <input id="todoSearch" class="input" style="max-width:260px" placeholder="Search" value="${esc(t.search)}" data-bind="todoSearch">
        ${t.mode === 'checklist' ? `<select class="input" style="width:auto" data-bind="todoRange">
          ${[7, 14, 31].map(n => `<option value="${n}" ${t.range === n ? 'selected' : ''}>Next ${n} days</option>`).join('')}</select>
          <label class="check"><input type="checkbox" data-bind="todoCompleted" ${t.showCompleted ? 'checked' : ''}>Show completed</label>` : ''}
        <span class="grow"></span><button class="btn" data-act="new-task">${ic('plus')} New Task</button></div>
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

// ---------- Booking ----------
function meeting() {
  const types = store.settings.meetingTypes;
  return types.find(m => m.id === ui.booking.meetingId) || types[0] || { name: 'Meeting', minutes: 30, details: '' };
}

function computeSlots() {
  const a = store.settings.availability, mt = meeting();
  const dur = mt.minutes, step = Math.min(dur, 30);
  const earliest = Date.now() + a.minNoticeHours * 3_600_000, buf = a.bufferMinutes * 60_000;
  const out = [];
  for (let i = 0; i < a.daysAhead; i++) {
    const day = M.addDays(M.startOfDay(new Date()), i);
    if (!a.weekdays.includes(M.weekday(day))) continue;
    const blocked = ui.booking.busy.map(b => [+new Date(b.start), +new Date(b.end)]);
    for (const o of store.occurrencesOn(day)) if (o.start) blocked.push([+o.start, +o.end]);
    const slots = [];
    for (let m = a.startMinutes; m + dur <= a.endMinutes; m += step) {
      const s = +M.dayAt(day, m), e = s + dur * 60_000;
      if (s >= earliest && !blocked.some(([bs, be]) => bs < e + buf && be > s - buf)) slots.push({ start: new Date(s), end: new Date(e) });
    }
    if (slots.length) out.push([day, slots]);
  }
  return out;
}

async function loadBusy() {
  const b = ui.booking;
  if (!store.google.connected) { b.busy = []; return; }
  b.loading = true; render();
  try { b.busy = await store.freeBusy(new Date(), M.addDays(M.startOfDay(new Date()), store.settings.availability.daysAhead + 1)); }
  catch (e) { b.message = e.message; }
  b.loading = false; b.loadedFor = Date.now(); render();
}

function bookingView() {
  const b = ui.booking, mt = meeting(), a = store.settings.availability;
  if (store.google.connected && (!b.loadedFor || Date.now() - b.loadedFor > 120_000) && !b.loading) setTimeout(loadBusy);
  const slots = computeSlots();
  ui.booking.slots = slots;
  return `<div class="header"><div class="grow"><h1>Booking</h1><div class="sub">Share open times and book meetings straight into Google Calendar.</div></div>
      <button class="btn" data-act="busy-refresh" ${b.loading ? 'disabled' : ''}>${ic('refresh')} Refresh</button>
      <button class="btn" data-act="copy-avail" ${slots.length ? '' : 'disabled'}>${ic('copy')} Copy availability</button></div>
    <div class="page stack" style="max-width:1100px">
      ${!store.google.connected ? `<div class="callout warn"><span class="big">${ic('cal')}</span><div class="grow"><b>Google Calendar isn’t connected</b>
        <div class="small muted">Slots only account for your Cadence tasks, and bookings are saved as Cadence tasks without sending invites.</div></div>
        <a class="btn" href="#settings">Connect in Settings</a></div>` : ''}
      ${b.message ? `<div class="callout" style="background:${tint('#30d158', .12)}"><span class="big green">${ic('check')}</span><div class="grow">${esc(b.message)}</div></div>` : ''}
      <div><div class="section-title">${ic('people')}Meeting type</div><div class="mtypes">${store.settings.meetingTypes.map(m => `
        <button class="mtype ${m.id === mt.id ? 'on' : ''}" data-act="pick-meeting" data-id="${m.id}"><b>${esc(m.name)}</b>
        <div class="small muted">${ic('clock')} ${m.minutes} min</div><div class="small muted">${esc(m.details)}</div></button>`).join('')}</div></div>
      <div><div class="section-title">${ic('cal')}Open slots ${b.loading ? '<span class="small muted">loading…</span>' : ''}<span class="grow"></span>
        <span class="small muted" style="font-weight:400">${a.weekdays.map(w => M.WEEKDAY_SHORT[w - 1]).join(' ')} · ${M.fmtTimeMinutes(a.startMinutes)}–${M.fmtTimeMinutes(a.endMinutes)}</span>
        <a class="btn sm" href="#settings">Edit hours</a></div>
        ${slots.length ? `<div class="slots">${slots.map(([d, ss], di) => `<div class="slotcol"><div class="hd"><div class="small muted">${M.WEEKDAY_SHORT[d.getDay()]}</div>
          <b>${M.fmtDay(d, { month: 'short', day: 'numeric' })}</b></div>${ss.map((s, si) => `<button class="btn slot" data-act="book" data-d="${di}" data-s="${si}">${M.fmtTime(s.start)}</button>`).join('')}</div>`).join('')}</div>`
          : `<div class="muted" style="padding:20px 0">No open slots in the next ${a.daysAhead} days with your current availability.</div>`}</div>
      <div class="small muted">A public booking link would need people to reach your calendar without signing in; for that, Google Calendar’s Appointment Schedules works alongside this. Here, use “Copy availability” to paste your open times into an email, then book the slot the other person picks.</div>
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
      <div class="srow"><div>Mac app<div class="small muted">In Cadence for Mac › Settings › Sync, enter this server and the same username and password:</div>
        <div class="mono code" style="margin-top:4px;display:inline-block">${esc(location.origin)}</div></div><button class="btn" data-act="copy-origin">${ic('copy')} Copy</button></div>
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
        : g.connected ? `<div class="srow"><div class="green">${ic('check')} Connected${g.email ? ` as ${esc(g.email)}` : ''}</div>
            <div class="row"><button class="btn" data-act="google-refresh">${ic('refresh')} Refresh</button><button class="btn danger" data-act="google-disconnect">Disconnect</button></div></div>
          <div class="srow">${tog('showGoogleEvents', 'Show Google events in Cadence calendars', s.showGoogleEvents)}</div>
          <div class="srow"><span>Remind me before Google events</span>${sel('googleEventReminderMinutes', [[0, 'Off'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes']], s.googleEventReminderMinutes)}</div>
          ${g.calendars.length ? `<div class="srow"><div class="grow">Calendars to show and check for busy times (this device)
            <div class="chans" style="margin-top:6px">${g.calendars.map(c => `<label class="check"><input type="checkbox" data-act-change="gcal" value="${esc(c.id)}"
              ${(store.googleCalendarIDs.length ? store.googleCalendarIDs.includes(c.id) : c.primary) ? 'checked' : ''}>
              <span style="width:9px;height:9px;border-radius:50%;background:${c.colorHex || '#0a84ff'}"></span>${esc(c.summary)}</label>`).join('')}</div></div></div>` : ''}`
        : `<div class="srow"><div>Show your Google events here, get reminders for them, and book meetings that send invites.</div><a class="btn primary" href="/api/google/connect">Connect Google Calendar</a></div>`}
    </div></div>

    <div><h3>Booking availability</h3><div class="card">
      <div class="srow"><span>Days</span><div class="wd">${[1, 2, 3, 4, 5, 6, 7].map(w => `<button class="${a.weekdays.includes(w) ? 'on' : ''}" data-act="avail-day" data-w="${w}" title="${M.WEEKDAY_SHORT[w - 1]}">${M.WEEKDAY_LETTER[w - 1]}</button>`).join('')}</div></div>
      <div class="srow"><span>From</span>${sel('availability.startMinutes', times(360, 1200), a.startMinutes)}</div>
      <div class="srow"><span>Until</span>${sel('availability.endMinutes', times(480, 1380), a.endMinutes)}</div>
      <div class="srow"><span>Buffer around meetings</span>${sel('availability.bufferMinutes', [[0, 'None'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes']], a.bufferMinutes)}</div>
      <div class="srow"><span>Minimum notice</span>${sel('availability.minNoticeHours', [[0, 'None'], ...[1, 2, 4, 12, 24, 48].map(n => [n, `${n} hours`])], a.minNoticeHours)}</div>
      <div class="srow"><span>Look ahead</span>${sel('availability.daysAhead', [7, 14, 21, 30, 45, 60].map(n => [n, `${n} days`]), a.daysAhead)}</div>
    </div></div>

    <div><h3>Meeting types</h3><div class="card">
      ${s.meetingTypes.map((m, i) => `<div class="srow" style="flex-wrap:wrap">
        <input class="input" style="max-width:170px" value="${esc(m.name)}" data-meeting="${i}" data-field="name" placeholder="Name">
        <select class="input" style="width:auto" data-meeting="${i}" data-field="minutes">${[15, 20, 30, 45, 60, 90].map(n => `<option value="${n}" ${m.minutes === n ? 'selected' : ''}>${n} min</option>`).join('')}</select>
        <input class="input grow" value="${esc(m.details)}" data-meeting="${i}" data-field="details" placeholder="Description">
        <label class="check" title="Add a Google Meet link"><input type="checkbox" data-meeting="${i}" data-field="addMeetLink" ${m.addMeetLink ? 'checked' : ''}>Meet</label>
        <button class="btn ghost sm icon danger" data-act="meeting-remove" data-i="${i}" ${s.meetingTypes.length <= 1 ? 'disabled' : ''}>${ic('trash')}</button></div>`).join('')}
      <div class="srow"><button class="btn" data-act="meeting-add">${ic('plus')} Add meeting type</button></div>
    </div></div>
  </div>`;
}

// ---------- Auth ----------
function authView() {
  const a = ui.auth, create = a.mode === 'register';
  return `<div class="auth"><form class="auth-card" data-form="auth">
    <div class="logo"><img src="/icon-192.png" alt=""><div><h1>Cadence</h1><div class="muted small">Your checklist, calendars and reflections — on the web and on your Mac.</div></div></div>
    <div class="seg" style="align-self:flex-start"><button type="button" class="${!create ? 'on' : ''}" data-act="auth-mode" data-mode="login">Sign in</button>
      <button type="button" class="${create ? 'on' : ''}" data-act="auth-mode" data-mode="register">Create account</button></div>
    <label class="field"><span>Username</span><input class="input" name="username" autocomplete="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_.\\-]+" autofocus></label>
    <label class="field"><span>Password</span><input class="input" name="password" type="password" autocomplete="${create ? 'new-password' : 'current-password'}" required minlength="${create ? 8 : 1}"></label>
    ${create ? '<div class="small muted">Usernames: 3–32 letters, numbers, dots, dashes or underscores. Passwords: at least 8 characters.</div>' : ''}
    <label class="check"><input type="checkbox" name="remember" checked>Keep me signed in</label>
    ${a.error ? `<div class="error">${esc(a.error)}</div>` : ''}
    <button class="btn primary" style="min-height:38px" ${a.busy ? 'disabled' : ''}>${create ? 'Create account' : 'Sign in'}</button>
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
  const upcoming = store.googleEventsOn(new Date()).filter(e => !e.isAllDay && e.endDate > new Date());
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
  if (it.kind === 'task') {
    const o = it.o, t = o.task, r = store.reflectionFor(o);
    body = `<div class="muted">${ic('cal')} ${M.fmtDay(o.day)}</div>
      <div class="muted">${ic('clock')} ${o.start ? `${M.fmtTime(o.start)} – ${M.fmtTime(o.end)}` : 'Any time'}</div>
      ${t.recurrence.frequency !== 'none' ? `<div class="muted">${ic('repeat')} ${esc(M.recurrenceSummary(t.recurrence, t.startDate))}</div>` : ''}
      ${t.notes ? `<div>${esc(t.notes)}</div>` : ''}${r ? `<div class="muted" style="font-style:italic">“${esc(r.text)}”</div>` : ''}`;
    buttons = `${o.done ? `<button class="btn" data-act="toggle" data-occ="${esc(o.id)}">Mark not done</button>` : `<button class="btn primary" data-act="toggle" data-occ="${esc(o.id)}">Complete…</button>`}
      <button class="btn" data-act="edit" data-task="${t.id}">Edit…</button>
      ${t.recurrence.frequency !== 'none' ? `<button class="btn" data-act="skip" data-occ="${esc(o.id)}">Skip</button>` : ''}`;
  } else {
    const e = it.e;
    body = `<div class="muted">${ic('cal')} ${M.fmtDay(e.startDate)}</div>${!e.isAllDay ? `<div class="muted">${ic('clock')} ${M.fmtTime(e.startDate)} – ${M.fmtTime(e.endDate)}</div>` : ''}
      ${e.location ? `<div class="muted">${esc(e.location)}</div>` : ''}<div class="small muted">From Google Calendar</div>`;
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
    <h2>${m.isNew ? 'New Task' : 'Edit Task'}</h2>
    <label class="field"><span>Title</span><input class="input" data-edit="title" value="${esc(d.title)}" placeholder="What do you need to do?" autofocus required></label>
    <label class="field"><span>Notes</span><textarea class="input" data-edit="notes" rows="2" placeholder="Optional details">${esc(d.notes)}</textarea></label>
    <div class="fieldset"><div class="legend">When</div>
      <div class="grid2"><label class="field"><span>Date</span><input class="input" type="date" data-edit="date" data-rerender value="${m.date}"></label>
        <label class="field"><span>&nbsp;</span><label class="check"><input type="checkbox" data-edit="hasTime" data-rerender ${m.hasTime ? 'checked' : ''}>At a specific time</label></label></div>
      ${m.hasTime ? `<div class="grid2"><label class="field"><span>Time</span><input class="input" type="time" data-edit="time" data-rerender value="${m.time}"></label>
        <label class="field"><span>Duration</span><select class="input" data-edit="duration" data-rerender>${DURATIONS.map(n => `<option value="${n}" ${d.durationMinutes === n ? 'selected' : ''}>${n < 60 ? `${n} min` : n % 60 ? `${Math.floor(n / 60)} hr ${n % 60} min` : `${n / 60} hr`}</option>`).join('')}</select></label></div>` : ''}
    </div>
    ${overlaps.length ? `<div class="fieldset"><div class="legend">${ic('layers')} Overlaps with</div>${overlaps.map(l => `<div class="small">${esc(l)}</div>`).join('')}
      <div class="small muted">That’s fine: this task’s reminders will still fire on time, even in the middle of the other one.</div></div>` : ''}
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
    <div class="fieldset"><div class="legend">Reminders</div>
      <div class="checks">${BEFORE.map(offCheck).join('')}</div>
      ${m.hasTime ? `<div class="small" style="font-weight:600">During the task</div><div class="checks">${DURING.filter(o => -o < d.durationMinutes).map(offCheck).join('')}</div>` : ''}
      <div class="chans">${M.CHANNELS.map(([c, l, desc]) => `<label class="check" title="${esc(desc)}"><input type="checkbox" data-edit="channel" value="${c}" ${d.channels.includes(c) ? 'checked' : ''}>${l}</label>`).join('')}</div>
      ${!m.hasTime ? `<div class="small muted">Tasks without a time remind at ${M.fmtTimeMinutes(store.settings.untimedReminderMinutes)} on the day.</div>` : ''}
    </div>
    <div class="fieldset"><div class="legend">Color</div><div class="swatches">${Object.entries(M.COLORS).map(([k, v]) => `<button type="button" class="swatch ${d.color === k ? 'on' : ''}" style="background:${v}" data-act="edit-color" data-color="${k}" title="${k}"></button>`).join('')}</div></div>
    ${store.google.connected && !d.googleEventID ? `<label class="check"><input type="checkbox" data-edit="addToGoogle" ${m.addToGoogle ? 'checked' : ''}>Also add to Google Calendar${r.frequency !== 'none' ? ' (with the repeat schedule)' : ''}</label>` : ''}
    ${m.error ? `<div class="error">${esc(m.error)}</div>` : ''}
    </div><div class="foot">${!m.isNew ? `<button type="button" class="btn danger" data-act="delete-task" data-task="${d.id}">Delete</button>` : ''}<span class="grow"></span>
      <button type="button" class="btn" data-act="close">Cancel</button><button class="btn primary" ${m.saving ? 'disabled' : ''}>${m.isNew ? 'Add Task' : 'Save'}</button></div></form>`;
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
  m.draft.reminderOffsets = [...root.querySelectorAll('[data-edit="offset"]:checked')].map(e => Number(e.value));
  m.draft.channels = [...root.querySelectorAll('[data-edit="channel"]:checked')].map(e => e.value);
  if (val('addToGoogle')) m.addToGoogle = val('addToGoogle').checked;
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
  if (!t.reminderOffsets.length && t.channels.length) t.reminderOffsets = [0];
  store.upsertTask(t);
  if (!m.addToGoogle) { closeModal(); return; }
  m.saving = true; renderModal();
  try {
    const day = M.parseKey(m.date);
    const start = t.timeMinutes != null ? M.dayAt(day, t.timeMinutes) : day;
    const ev = await store.createGoogleEvent({
      title: t.title, details: t.notes, allDay: t.timeMinutes == null,
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

// --- booking dialog ---
function bookingDialog(m) {
  const mt = meeting();
  return `<form class="dialog sm" data-form="booking"><div class="body">
    <h2>Book ${esc(mt.name)}</h2><div class="muted">${M.fmtDay(m.slot.start)} · ${M.fmtTime(m.slot.start)}–${M.fmtTime(m.slot.end)}</div>
    <label class="field"><span>Invitee name</span><input class="input" name="name" required autofocus></label>
    <label class="field"><span>Invitee email</span><input class="input" name="email" type="email" ${store.google.connected ? 'required' : ''}></label>
    <label class="field"><span>Event title</span><input class="input" name="title" placeholder="${esc(mt.name)} with …"></label>
    <label class="field"><span>Notes</span><textarea class="input" name="notes" rows="2"></textarea></label>
    ${store.google.connected ? `<label class="check"><input type="checkbox" name="meet" ${mt.addMeetLink ? 'checked' : ''}>Add a Google Meet link</label>
      <div class="small muted">Google emails an invitation to the invitee.</div>` : '<div class="small muted">Not connected to Google: this is saved as a Cadence task only.</div>'}
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
    if (occ && !occ.done) beginReflection(occ); else location.hash = 'today';
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
  openEditor(M.newTask({ startDate: M.iso(M.startOfDay(day)), ...(minutes != null ? { timeMinutes: minutes } : {}), channels: [...store.settings.defaultChannels] }), true);
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
    const copy = structuredClone(t);
    store.deleteTask(t.id);
    if (ui.modal) closeModal();
    toast(`Deleted “${t.title}”`, { icon: 'trash', undo: () => { store.restoreTask(copy); toast('Task restored', { icon: 'check' }); } });
  },
  'confirm-yes': () => { const fn = ui.modal.fn; closeModal(); fn(); },
  close: el => { const then = el.dataset.then; closeModal(); if (then) location.hash = then; },
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
  'pick-meeting': el => { ui.booking.meetingId = el.dataset.id; render(); },
  'busy-refresh': () => { ui.booking.loadedFor = null; loadBusy(); },
  'copy-avail': () => {
    const mt = meeting(), tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let text = `Here are some times that work for a ${mt.minutes}-minute ${mt.name.toLowerCase()} (${tz}):\n\n`;
    for (const [d, ss] of ui.booking.slots.slice(0, 5)) text += `• ${M.fmtDay(d, { weekday: 'long', month: 'short', day: 'numeric' })}: ${ss.slice(0, 8).map(s => M.fmtTime(s.start)).join(', ')}\n`;
    text += '\nLet me know which works and I’ll send an invite.';
    navigator.clipboard?.writeText(text);
    ui.booking.message = 'Availability copied to the clipboard.'; render();
  },
  book: el => { const slot = ui.booking.slots[el.dataset.d][1][el.dataset.s]; openModal({ type: 'booking', slot }); },
  'sync-now': () => { syncUI.manual = true; store.sync(); },
  'copy-origin': () => { navigator.clipboard?.writeText(location.origin); toast('Address copied', { icon: 'copy' }); },
  'clear-flash': () => { ui.flash = null; render(); },
  'ask-notify': async () => { if ('Notification' in window) await Notification.requestPermission(); render(); },
  'test-reminder': () => reminders.deliver({ kind: 'test', title: 'Test reminder', body: 'This is how Cadence reminders will look.', tint: '#0a84ff' }, store.settings.defaultChannels),
  'google-refresh': () => store.refreshGoogle(),
  'google-disconnect': () => confirmThen('Disconnect Google Calendar?', 'Cadence will stop showing your Google events on the web.', 'Disconnect', () => store.disconnectGoogle()),
  'avail-day': el => {
    const w = Number(el.dataset.w), a = store.settings.availability;
    const days = a.weekdays.includes(w) ? a.weekdays.filter(x => x !== w) : [...a.weekdays, w].sort();
    if (days.length) store.updateSettings({ availability: { ...a, weekdays: days } });
  },
  'meeting-add': () => store.updateSettings({ meetingTypes: [...store.settings.meetingTypes, { id: M.uuid(), name: 'New meeting', minutes: 30, details: '', addMeetLink: true }] }),
  'meeting-remove': el => store.updateSettings({ meetingTypes: store.settings.meetingTypes.filter((_, i) => i !== Number(el.dataset.i)) }),
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
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.tagName === 'A' && el.getAttribute('href')?.startsWith('#')) return;
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
  if (el.dataset.meeting != null && el.type !== 'checkbox' && el.tagName === 'INPUT') {
    clearTimeout(el._t);
    el._t = setTimeout(() => updateMeeting(el), 500);
  }
});

function updateMeeting(el) {
  const i = Number(el.dataset.meeting), f = el.dataset.field;
  const types = structuredClone(store.settings.meetingTypes);
  types[i][f] = el.type === 'checkbox' ? el.checked : f === 'minutes' ? Number(el.value) : el.value;
  store.updateSettings({ meetingTypes: types });
}

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
  if (el.dataset.meeting != null) { updateMeeting(el); return; }
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
      location.hash = 'today';
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
  } else if (kind === 'editor') {
    saveEditor();
  } else if (kind === 'booking') {
    const m = ui.modal, fd = new FormData(form), mt = meeting();
    const name = String(fd.get('name')).trim(), email = String(fd.get('email') || '').trim();
    const title = String(fd.get('title')).trim() || `${mt.name} with ${name}`;
    m.working = true; m.error = null; renderModal();
    try {
      if (store.google.connected) {
        await store.createGoogleEvent({ title, details: String(fd.get('notes')), start: M.iso(m.slot.start), end: M.iso(m.slot.end),
          attendees: [{ email, name }], addMeetLink: fd.get('meet') === 'on' });
        ui.booking.message = `Booked “${title}” — invitation sent to ${email}.`;
      } else {
        store.upsertTask(M.newTask({ title, notes: String(fd.get('notes')), startDate: M.iso(M.startOfDay(m.slot.start)),
          timeMinutes: M.minutesOf(m.slot.start), durationMinutes: mt.minutes, reminderOffsets: [10], channels: [...store.settings.defaultChannels], color: 'purple' }));
        ui.booking.message = `Saved “${title}” to your Cadence calendar.`;
      }
      ui.booking.loadedFor = null;
      closeModal();
    } catch (err) {
      m.working = false; m.error = err.message; renderModal();
    }
  }
});

const SHORTCUT_FOR = { today: 'T', week: 'W', month: 'M', todo: 'L', reflections: 'R', booking: 'B', settings: ',' };
document.addEventListener('keydown', e => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (!typing && !ui.modal && store.user && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const k = e.key.toLowerCase();
    const route = Object.entries(SHORTCUT_FOR).find(([, key]) => key.toLowerCase() === k)?.[0];
    if (route) { e.preventDefault(); location.hash = route; return; }
    if (k === 'n') { e.preventDefault(); newTaskAt(new Date()); return; }
    if (k === 'c') { e.preventDefault(); reminders.checkIn('Daily check-in', { manual: true }); return; }
    if (k === 's') { e.preventDefault(); syncUI.manual = true; store.sync(); return; }
  }
  if (e.key === 'Escape' && ui.modal && ui.modal.type !== 'editor') closeModal();
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.id === 'reflText' && !$('#reflSubmit').disabled) $('#reflSubmit').click();
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.closest('[data-form="editor"]')) { e.preventDefault(); saveEditor(); }
});

// Keep "now" lines, greetings and day boundaries fresh.
setInterval(() => { if (!ui.modal || ['checkin', 'detail'].includes(ui.modal.type)) render(); }, 60_000);

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

// ---------- start ----------
readRoute();
store.subscribe(render);
store.boot().then(() => {
  booted = true;
  render();
  if (store.user) reminders.start();
  else store.subscribe(function startOnce() { if (store.user && !reminders.started) { reminders.started = true; reminders.start(); } });
  if (store.user) reminders.started = true;
});
