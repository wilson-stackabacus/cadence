// Client-side data store + sync with the server (and through it, the Mac app).
// Edits apply locally at once, are queued, and pushed; the server answers with everything
// that changed since our cursor. Conflicts resolve last-writer-wins per record.
import * as M from './model.js';

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(json.error || `Request failed (${r.status})`), { status: r.status });
  return json;
}

const device = (key, fallback) => {
  try { const v = localStorage.getItem(`cadence:device:${key}`); return v == null ? fallback : JSON.parse(v); }
  catch { return fallback; }
};
const setDevice = (key, value) => { try { localStorage.setItem(`cadence:device:${key}`, JSON.stringify(value)); } catch { /* storage blocked */ } };

class Store {
  user = null;
  tasks = new Map();
  reflections = new Map();
  settings = structuredClone(M.DEFAULT_SETTINGS);
  stamps = new Map();      // "kind|id" -> updatedAt (ms) of our copy
  pending = new Map();     // "kind|id" -> change waiting to be pushed
  cursor = 0;
  syncState = { status: 'idle', lastSynced: null, error: null };
  google = { configured: false, connected: false, email: null, calendars: [], events: new Map(), months: new Set(), loading: new Set() };
  #listeners = new Set();
  #syncListeners = new Set();
  syncing = false;
  #pushTimer = null;
  #syncing = null;

  // ---------- device-only preferences ----------
  device = device;
  setDevice = setDevice;

  subscribe(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  emit() { for (const fn of this.#listeners) fn(); }
  /** Lightweight channel for the sync indicator, so it can animate without re-rendering the page. */
  onSync(fn) { this.#syncListeners.add(fn); return () => this.#syncListeners.delete(fn); }
  #notifySync() { for (const fn of this.#syncListeners) fn(); }

  // ---------- auth ----------
  async boot() {
    try {
      const { user } = await api('/api/me');
      this.user = user;
      this.#loadCache();
      this.emit();
      await this.sync();
      this.refreshGoogle();
      this.refreshCalendly();
    } catch (e) {
      if (e.status !== 401) this.syncState = { ...this.syncState, status: 'offline', error: e.message };
      this.user = null;
      this.emit();
    }
    setInterval(() => this.user && this.sync(), 20_000);
    addEventListener('focus', () => this.user && this.sync());
    addEventListener('online', () => this.user && this.sync());
  }

  async signIn(username, password, { create, remember }) {
    const { user } = await api(create ? '/api/register' : '/api/login', {
      method: 'POST', body: { username, password, remember, device: 'web' },
    });
    this.user = user;
    this.#resetData();
    this.#loadCache();
    this.emit();
    await this.sync();
    this.refreshGoogle();
    this.refreshCalendly();
  }

  async signOut() {
    await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
    try { localStorage.removeItem(this.#cacheKey()); } catch { /* ignore */ }
    this.user = null;
    this.#resetData();
    this.emit();
  }

  /** Permanently deletes the account on the server, then forgets everything locally. */
  async deleteAccount(password) {
    await api('/api/account/delete', { method: 'POST', body: { password } });
    try { localStorage.removeItem(this.#cacheKey()); } catch { /* ignore */ }
    this.user = null;
    this.#resetData();
    this.emit();
  }

  #resetData() {
    this.tasks = new Map(); this.reflections = new Map(); this.stamps = new Map(); this.pending = new Map();
    this.settings = structuredClone(M.DEFAULT_SETTINGS); this.cursor = 0;
    this.google = { configured: false, connected: false, email: null, calendars: [], events: new Map(), months: new Set(), loading: new Set() };
  }

  // ---------- local cache (fast start + offline edits survive reloads) ----------
  #cacheKey() { return `cadence:data:${this.user?.username?.toLowerCase()}`; }

  #loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem(this.#cacheKey()) || 'null');
      if (!c) return;
      this.tasks = new Map(c.tasks.map(t => [t.id, t]));
      this.reflections = new Map(c.reflections.map(r => [r.id, r]));
      this.settings = { ...structuredClone(M.DEFAULT_SETTINGS), ...c.settings };
      this.stamps = new Map(c.stamps);
      this.pending = new Map(c.pending);
      this.cursor = c.cursor || 0;
    } catch { /* corrupt or blocked cache: start from the server */ }
  }

  #saveCache() {
    if (!this.user) return;
    try {
      localStorage.setItem(this.#cacheKey(), JSON.stringify({
        tasks: [...this.tasks.values()], reflections: [...this.reflections.values()], settings: this.settings,
        stamps: [...this.stamps], pending: [...this.pending], cursor: this.cursor,
      }));
    } catch { /* storage full or blocked */ }
  }

  // ---------- sync ----------
  #queue(kind, id, data, deleted = false) {
    const now = Date.now();
    const key = `${kind}|${id}`;
    this.stamps.set(key, now);
    this.pending.set(key, { kind, id, updatedAt: now, deleted, data: deleted ? null : data });
    this.#saveCache();
    this.emit();
    clearTimeout(this.#pushTimer);
    this.#pushTimer = setTimeout(() => this.sync(), 400);
  }

  sync() {
    if (!this.user) return Promise.resolve();
    if (this.#syncing) return this.#syncing.then(() => (this.pending.size ? this.sync() : undefined));
    this.#syncing = this.#doSync().finally(() => { this.#syncing = null; });
    return this.#syncing;
  }

  async #doSync() {
    const sent = [...this.pending.values()];
    const before = this.syncState.status;
    let changed = false;
    this.syncing = true;
    this.#notifySync();
    try {
      const res = await api('/api/sync', { method: 'POST', body: { since: this.cursor, changes: sent } });
      // Only clear what we sent and haven't edited again since.
      for (const c of sent) {
        const key = `${c.kind}|${c.id}`;
        if (this.pending.get(key)?.updatedAt === c.updatedAt) this.pending.delete(key);
      }
      changed = this.#applyRemote(res.changes) || sent.length > 0;
      this.cursor = res.cursor;
      this.syncState = { status: 'synced', lastSynced: new Date(), error: null };
    } catch (e) {
      if (e.status === 401) { this.user = null; this.emit(); return; }
      this.syncState = { ...this.syncState, status: 'offline', error: navigator.onLine ? e.message : 'Offline — changes will sync later' };
    }
    this.syncing = false;
    this.#notifySync();
    this.#saveCache();
    // Only re-render when something visible changed; a quiet poll shouldn't rebuild the page.
    if (changed || before !== this.syncState.status) this.emit();
  }

  #applyRemote(changes) {
    let applied = false;
    for (const c of changes) {
      const id = c.kind === 'settings' ? 'main' : c.id;
      const key = `${c.kind}|${id}`;
      if (this.pending.has(key) && this.pending.get(key).updatedAt > c.updatedAt) continue;
      if ((this.stamps.get(key) ?? -1) > c.updatedAt) continue;
      if (this.stamps.get(key) === c.updatedAt) continue; // our own change echoed back
      this.stamps.set(key, c.updatedAt);
      applied = true;
      if (c.kind === 'task') {
        if (c.deleted) this.tasks.delete(id); else this.tasks.set(id, { ...c.data, id });
      } else if (c.kind === 'reflection') {
        if (c.deleted) this.reflections.delete(id); else this.reflections.set(id, { ...c.data, id });
      } else if (c.kind === 'settings' && !c.deleted && c.data) {
        this.settings = { ...structuredClone(M.DEFAULT_SETTINGS), ...c.data };
      }
    }
    return applied;
  }

  // ---------- mutations ----------
  upsertTask(task) {
    const t = { ...task, updatedAt: M.iso(new Date()) };
    this.tasks.set(t.id, t);
    this.#queue('task', t.id, t);
  }

  deleteTask(id) {
    const t = this.tasks.get(id);
    // Imported items are archived (hidden) so the next import doesn't bring them back.
    if (t?.source) { this.upsertTask({ ...t, archived: true }); return; }
    this.tasks.delete(id);
    this.#queue('task', id, null, true);
  }

  /** Create/refresh imported tasks for one source in [from, to); archive ones that vanished upstream. */
  applyImport(source, items, from, to, { archiveMissing = true, archiveIds = new Set() } = {}) {
    let added = 0, updated = 0, removed = 0;
    const incoming = new Set(items.map(i => i.id));
    const fields = ['title', 'notes', 'startDate', 'timeMinutes', 'durationMinutes', 'externalURL', 'googleEventID', 'sourceCalendar'];
    for (const item of items) {
      const cur = this.tasks.get(item.id);
      if (!cur) { this.upsertTask(item); added++; continue; }
      if (cur.archived) continue;
      if (fields.some(f => (cur[f] ?? null) !== (item[f] ?? null))) {
        const next = { ...cur };
        for (const f of fields) { if (item[f] == null) delete next[f]; else next[f] = item[f]; }
        this.upsertTask(next); updated++;
      }
    }
    for (const t of [...this.tasks.values()]) {
      if (t.source !== source || t.archived || Object.keys(t.completions || {}).length) continue;
      const s = new Date(t.startDate);
      const missing = archiveMissing && !incoming.has(t.id) && s >= M.startOfDay(from) && s < to;
      if (missing || archiveIds.has(t.id)) { this.upsertTask({ ...t, archived: true }); removed++; }
    }
    return { added, updated, removed };
  }

  complete(occ, text) {
    if (M.countWords(text) < this.settings.minReflectionWords) return false;
    const t = this.tasks.get(occ.task.id);
    if (!t) return false;
    this.upsertTask({ ...t, completions: { ...t.completions, [occ.key]: M.iso(new Date()) } });
    const r = { id: M.uuid(), taskID: t.id, taskTitle: t.title, occurrenceKey: occ.key, text, createdAt: M.iso(new Date()) };
    this.reflections.set(r.id, r);
    this.#queue('reflection', r.id, r);
    return true;
  }

  uncomplete(occ) {
    const t = this.tasks.get(occ.task.id);
    if (!t) return;
    const completions = { ...t.completions };
    delete completions[occ.key];
    this.upsertTask({ ...t, completions });
  }

  skip(occ) {
    const t = this.tasks.get(occ.task.id);
    if (t) this.upsertTask({ ...t, skipped: [...new Set([...(t.skipped || []), occ.key])] });
  }

  /** Put back a deleted task/reflection (Undo). A fresh edit time makes it win over the deletion everywhere. */
  restoreTask(task) { this.upsertTask(task); }
  restoreReflection(r) {
    this.reflections.set(r.id, r);
    this.#queue('reflection', r.id, r);
  }

  deleteReflection(id) {
    this.reflections.delete(id);
    this.#queue('reflection', id, null, true);
  }

  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.#queue('settings', 'main', this.settings);
  }

  // ---------- queries ----------
  occurrencesOn(day) {
    return [...this.tasks.values()].filter(t => M.occurs(t, day)).map(t => M.makeOccurrence(t, day)).sort(M.sortOccurrences);
  }

  overdue() {
    const today = M.startOfDay(new Date());
    return [...this.tasks.values()]
      .filter(t => !t.archived && t.recurrence.frequency === 'none' && M.startOfDay(t.startDate) < today && !Object.keys(t.completions || {}).length)
      .map(t => M.makeOccurrence(t, t.startDate))
      .sort((a, b) => a.day - b.day);
  }

  todayChecklist() { return [...this.overdue(), ...this.occurrencesOn(new Date())]; }
  remainingToday() { return this.todayChecklist().filter(o => !o.done).length; }
  reflectionFor(occ) { return [...this.reflections.values()].find(r => r.taskID === occ.task.id && r.occurrenceKey === occ.key); }

  sortedReflections() { return [...this.reflections.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

  get reflectionStreak() {
    const days = new Set([...this.reflections.values()].map(r => M.dateKey(r.createdAt)));
    let d = M.startOfDay(new Date());
    if (!days.has(M.dateKey(d))) d = M.addDays(d, -1);
    let n = 0;
    while (days.has(M.dateKey(d))) { n++; d = M.addDays(d, -1); }
    return n;
  }

  // ---------- Google Calendar (through the server) ----------
  get googleCalendarIDs() { return device('googleCalendarIDs', []); }

  async refreshGoogle() {
    try {
      Object.assign(this.google, await api('/api/google/status'));
      if (this.google.connected) {
        this.google.calendars = await api('/api/google/calendars').catch(() => []);
        this.google.events = new Map(); this.google.months = new Set();
        this.ensureGoogle(M.addDays(new Date(), -40), M.addDays(new Date(), 75));
        this.watchGoogle();
      }
    } catch { /* not critical */ }
    this.emit();
  }

  ensureGoogle(from, to) {
    if (!this.google.connected) return;
    for (let m = M.startOfMonth(from); m < to; m = M.addMonths(m, 1)) {
      const key = M.dateKey(m);
      if (this.google.months.has(key) || this.google.loading.has(key)) continue;
      this.google.loading.add(key);
      const q = new URLSearchParams({ from: M.iso(m), to: M.iso(M.addMonths(m, 1)), calendars: this.googleCalendarIDs.join(',') });
      api(`/api/google/events?${q}`).then(list => {
        const end = M.addMonths(m, 1);
        for (const [id, e] of this.google.events) {
          const s = e.isAllDay ? M.parseKey(e.start) : new Date(e.start);
          if (s >= m && s < end) this.google.events.delete(id);
        }
        for (const e of list) this.google.events.set(e.id, e);
        this.google.months.add(key);
        this.emit();
      }).catch(() => {}).finally(() => this.google.loading.delete(key));
    }
  }

  googleEventsOn(day) {
    if (!this.google.connected || !this.settings.showGoogleEvents) return [];
    const s = M.startOfDay(day), e = M.addDays(s, 1);
    return [...this.google.events.values()]
      .map(ev => ({
        ...ev,
        startDate: ev.isAllDay ? M.parseKey(ev.start) : new Date(ev.start),
        endDate: ev.isAllDay ? M.parseKey(ev.end) : new Date(ev.end),
      }))
      .filter(ev => ev.startDate < e && ev.endDate > s)
      .sort((a, b) => (a.isAllDay === b.isAllDay ? a.startDate - b.startDate : a.isAllDay ? -1 : 1));
  }

  // ---------- Calendly (through the server) ----------
  calendly = { connected: false, name: null, schedulingUrl: null, eventTypes: [] };
  async refreshCalendly() {
    try {
      this.calendly = { ...this.calendly, ...(await api('/api/calendly/status')) };
      if (this.calendly.connected) this.calendly.eventTypes = await api('/api/calendly/event-types').catch(() => []);
    } catch { /* not critical */ }
    this.emit();
  }
  async connectCalendly(token) {
    this.calendly = { ...this.calendly, ...(await api('/api/calendly/connect', { method: 'POST', body: { token } })) };
    await this.refreshCalendly();
  }
  async disconnectCalendly() {
    await api('/api/calendly/disconnect', { method: 'POST', body: {} });
    this.calendly = { connected: false, name: null, schedulingUrl: null, eventTypes: [] };
    this.emit();
  }
  calendlyMeetings = (from, to) => api(`/api/calendly/meetings?${new URLSearchParams({ from: M.iso(from), to: M.iso(to) })}`);
  googleImportWindow = (from, to) => api(`/api/google/import-window?${new URLSearchParams({ from: M.iso(from), to: M.iso(to), calendars: this.googleCalendarIDs.join(',') })}`);
  googleEvent = (calendar, id) => api(`/api/google/event?${new URLSearchParams({ calendar, id })}`).then(r => r.event);
  /** Tell the server our calendars + time zone and (re)subscribe to Google push updates. */
  watchGoogle = () => api('/api/google/watch', { method: 'POST', body: { calendars: this.googleCalendarIDs, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } })
    .then(r => { this.google.push = r.push; this.emit(); }).catch(() => {});
  /** Re-fetch the months already shown so edits in Google appear on the calendars too. */
  refreshGoogleView() { this.google.months.clear(); this.ensureGoogle(M.addDays(new Date(), -40), M.addDays(new Date(), 75)); }

  disconnectGoogle = () => api('/api/google/disconnect', { method: 'POST', body: {} }).then(() => this.refreshGoogle());
  freeBusy = (from, to) => api('/api/google/freebusy', { method: 'POST', body: { from: M.iso(from), to: M.iso(to), calendars: this.googleCalendarIDs } });
  async createGoogleEvent(e) {
    const r = await api('/api/google/events', { method: 'POST', body: { ...e, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
    this.google.months.clear();
    this.ensureGoogle(M.addDays(new Date(), -40), M.addDays(new Date(), 75));
    return r;
  }
}

export const store = new Store();
