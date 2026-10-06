// Agenda: appuntamenti locali + calendario iCal (es. "indirizzo segreto in formato iCal"
// di Google Calendar, passato dal Worker per aggirare il CORS) + import di file .ics.
// Gli appuntamenti con un luogo permettono i consigli "parta entro le…".
//
// Limiti dichiarati: espansione RRULE per DAILY/WEEKLY/MONTHLY/YEARLY (INTERVAL, BYDAY,
// COUNT, UNTIL, EXDATE, RECURRENCE-ID); regole più esotiche vengono ignorate.

import { store, uid } from './util.js';

// ------------------------------------------------------------------- iCal

const WIN_TZ = {
  'W. Europe Standard Time': 'Europe/Rome', 'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris', 'GMT Standard Time': 'Europe/London', UTC: 'UTC',
};

function tzOffsetMs(tz, utcMs) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

/** Ora "a muro" in un fuso -> istante UTC (ms). tz null = fuso del dispositivo. */
export function wallToEpoch({ y, mo, d, h, mi, s }, tz) {
  if (!tz) return new Date(y, mo - 1, d, h, mi, s).getTime();
  if (tz === 'Z') return Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const guess = Date.UTC(y, mo - 1, d, h, mi, s);
    const off = tzOffsetMs(tz, guess);
    let t = guess - off;
    const off2 = tzOffsetMs(tz, t);
    if (off2 !== off) t = guess - off2;
    return t;
  } catch {
    return new Date(y, mo - 1, d, h, mi, s).getTime();
  }
}

function parseDateValue(value, params) {
  const m = String(value).trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const wall = { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
  const allDay = m[4] == null;
  let tz = null;
  if (m[7]) tz = 'Z';
  else if (params.TZID) tz = WIN_TZ[params.TZID] || params.TZID.replace(/^"|"$/g, '');
  return { wall, tz, allDay, epoch: wallToEpoch(wall, tz) };
}

function unescapeText(s) {
  return String(s || '').replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();
}

/** Estrae gli eventi grezzi (con eventuale RRULE) da un testo iCal. */
export function parseICS(text) {
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur?.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const [name, ...rest] = line.slice(0, idx).split(';');
    const params = Object.fromEntries(rest.map((p) => { const [k, ...v] = p.split('='); return [k.toUpperCase(), v.join('=')]; }));
    const value = line.slice(idx + 1);
    switch (name.toUpperCase()) {
      case 'UID': cur.uid = value; break;
      case 'SUMMARY': cur.title = unescapeText(value); break;
      case 'LOCATION': cur.place = unescapeText(value); break;
      case 'STATUS': cur.status = value.toUpperCase(); break;
      case 'DTSTART': cur.start = parseDateValue(value, params); break;
      case 'DTEND': cur.end = parseDateValue(value, params); break;
      case 'RRULE': cur.rrule = value; break;
      case 'EXDATE': for (const v of value.split(',')) { const d = parseDateValue(v, params); if (d) cur.exdates.push(d.epoch); } break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDateValue(value, params)?.epoch ?? null; break;
      default: break;
    }
  }
  return events.filter((e) => e.status !== 'CANCELLED');
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function parseRRule(rule) {
  const o = {};
  for (const part of rule.split(';')) { const [k, v] = part.split('='); o[k.toUpperCase()] = v; }
  return {
    freq: o.FREQ, interval: Math.max(1, parseInt(o.INTERVAL || '1', 10)),
    count: o.COUNT ? parseInt(o.COUNT, 10) : null,
    until: o.UNTIL ? parseDateValue(o.UNTIL, {})?.epoch ?? null : null,
    byday: o.BYDAY ? o.BYDAY.split(',').map((d) => DAYS.indexOf(d.slice(-2))).filter((i) => i >= 0) : null,
    bymonthday: o.BYMONTHDAY ? parseInt(o.BYMONTHDAY, 10) : null,
  };
}

/** Espande eventi (anche ricorrenti) in occorrenze comprese in [fromMs, toMs]. */
export function expandEvents(events, fromMs, toMs) {
  const out = [];
  const overrides = new Map();   // uid -> epoch delle istanze spostate/modificate
  for (const e of events) if (e.recurrenceId != null) { (overrides.get(e.uid) ?? overrides.set(e.uid, new Set()).get(e.uid)).add(e.recurrenceId); }

  for (const e of events) {
    const durMs = e.end ? e.end.epoch - e.start.epoch : 0;
    const push = (startMs) => {
      if (startMs + durMs < fromMs || startMs > toMs) return;
      out.push({
        id: `ics:${e.uid || e.title}:${startMs}`, title: e.title || 'Appuntamento', start: startMs,
        end: durMs ? startMs + durMs : null, place: e.place || '', allDay: e.start.allDay, source: 'ics',
      });
    };
    if (!e.rrule || e.recurrenceId != null) { push(e.start.epoch); continue; }

    const r = parseRRule(e.rrule);
    const skip = new Set([...e.exdates, ...(overrides.get(e.uid) ?? [])]);
    const w = e.start.wall;
    const startDow = new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
    let produced = 0;
    const emit = (y, mo, d) => {
      const wall = { ...w, y, mo, d };
      const t = wallToEpoch(wall, e.start.tz);
      if (t < e.start.epoch) return true;
      if (r.until != null && t > r.until) return false;
      produced++;
      if (r.count != null && produced > r.count) return false;
      if (!skip.has(t)) push(t);
      return true;
    };
    let guard = 0;
    if (r.freq === 'DAILY') {
      for (let k = 0; guard++ < 4000; k++) {
        const dt = new Date(Date.UTC(w.y, w.mo - 1, w.d + k * r.interval));
        if (Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) - 86400000 > toMs) break;
        if (!emit(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())) break;
      }
    } else if (r.freq === 'WEEKLY') {
      const days = r.byday?.length ? r.byday : [startDow];
      const mondayOffset = (startDow + 6) % 7;                 // giorni dal lunedì della settimana di partenza
      for (let k = 0; guard++ < 1500; k++) {
        let stop = false;
        for (const dow of [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))) {
          const delta = -mondayOffset + k * 7 * r.interval + ((dow + 6) % 7);
          const dt = new Date(Date.UTC(w.y, w.mo - 1, w.d + delta));
          if (dt.getTime() - 86400000 > toMs) { stop = true; break; }
          if (!emit(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())) { stop = true; break; }
        }
        if (stop) break;
      }
    } else if (r.freq === 'MONTHLY') {
      const dom = r.bymonthday ?? w.d;
      for (let k = 0; guard++ < 600; k++) {
        const dt = new Date(Date.UTC(w.y, w.mo - 1 + k * r.interval, 1));
        const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1;
        if (Date.UTC(y, mo - 1, 1) - 31 * 86400000 > toMs) break;
        if (dom > new Date(Date.UTC(y, mo, 0)).getUTCDate()) continue;
        if (!emit(y, mo, dom)) break;
      }
    } else if (r.freq === 'YEARLY') {
      for (let k = 0; guard++ < 100; k++) {
        const y = w.y + k * r.interval;
        if (Date.UTC(y, 0, 1) - 366 * 86400000 > toMs) break;
        if (!emit(y, w.mo, w.d)) break;
      }
    } else push(e.start.epoch);
  }
  return out.sort((a, b) => a.start - b.start);
}

// ------------------------------------------------------------------ agenda

export class Agenda {
  constructor({ api, now = () => Date.now() } = {}) {
    this.api = api; this.now = now;
    this.local = store.get('agenda', []) || [];
    const cached = store.get('agenda_ics', null);
    this.ics = cached?.items || [];
    this.syncedAt = cached?.syncedAt || 0;
    this.lastError = '';
    this.geocache = store.get('geocache', {}) || {};
  }

  all() {
    return [...this.local, ...this.ics].filter((i) => !i.allDay).sort((a, b) => a.start - b.start);
  }

  add({ title, start, place = '' }) {
    const item = { id: uid(), title: title || 'Appuntamento', start, end: null, place, allDay: false, source: 'local' };
    this.local.push(item);
    store.set('agenda', this.local);
    return item;
  }

  remove(id) {
    this.local = this.local.filter((i) => i.id !== id);
    store.set('agenda', this.local);
  }

  /** Prossimo appuntamento (non concluso da più di 15 minuti), entro withinMs. */
  next(withinMs = 12 * 3600000) {
    const t = this.now();
    return this.all().find((i) => i.start > t - 15 * 60000 && i.start < t + withinMs) ?? null;
  }

  today() {
    const d = new Date(this.now());
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    return this.all().filter((i) => i.start >= this.now() - 15 * 60000 && i.start < end);
  }

  importText(text) {
    const from = this.now() - 86400000, to = this.now() + 14 * 86400000;
    const items = expandEvents(parseICS(text), from, to);
    this.ics = items;
    this.syncedAt = this.now();
    store.set('agenda_ics', { items, syncedAt: this.syncedAt });
    return items.length;
  }

  async sync(url) {
    if (!url) return 0;
    try {
      const text = await this.api.icsText(url);
      const n = this.importText(text);
      this.lastError = '';
      return n;
    } catch (e) {
      this.lastError = e?.code || e?.message || 'errore';
      throw e;
    }
  }

  /** Coordinate del luogo dell'appuntamento (cache per ridurre le ricerche). */
  async coordsFor(item, search) {
    if (item.coords) return item.coords;
    if (!item.place) return null;
    const key = item.place.toLowerCase();
    if (this.geocache[key]) return this.geocache[key];
    const res = await search(item.place);
    if (!res?.length) return null;
    const c = { lat: res[0].lat, lon: res[0].lon };
    this.geocache[key] = c;
    store.set('geocache', this.geocache);
    return c;
  }
}
