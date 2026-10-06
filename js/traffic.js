// Traffico: rallentamenti lungo il percorso (dalle sezioni della rotta TomTom con traffico
// in tempo reale) e incidenti/lavori/chiusure (TomTom Traffic Incidents) nei prossimi km.
// Annuncia solo eventi reali, una volta sola, e innesca la ricerca di alternative.

import { CONFIG } from './config.js';
import { Persona } from './persona.js';
import { Priority } from './voice.js';
import {
  bus as defaultBus, angDiff, bearing, bboxOf, nearestOnPolyline, pointAtDistance, headingAtDistance,
} from './util.js';

// ------------------------------------------------------------------ parsing

const ICON_KIND = { 1: 'accident', 6: 'jam', 7: 'works', 8: 'closed', 9: 'works', 14: 'breakdown', 2: 'hazard', 3: 'hazard', 4: 'hazard', 5: 'hazard', 10: 'hazard', 11: 'hazard' };

export function parseIncidents(json) {
  const out = [];
  for (const f of json?.incidents ?? []) {
    const g = f.geometry;
    if (!g?.coordinates) continue;
    const coords = g.type === 'Point' ? [g.coordinates] : g.coordinates;
    const geometry = coords.map((c) => ({ lat: c[1], lon: c[0] }));
    if (!geometry.length) continue;
    const p = f.properties ?? {};
    out.push({
      id: p.id || `${geometry[0].lat.toFixed(5)},${geometry[0].lon.toFixed(5)}:${p.iconCategory}`,
      kind: ICON_KIND[p.iconCategory] || 'other',
      magnitude: p.magnitudeOfDelay ?? 0,
      delayS: p.delay ?? 0,
      lengthM: p.length ?? 0,
      from: p.from || '',
      to: p.to || '',
      description: p.events?.[0]?.description || '',
      roadNumbers: p.roadNumbers || [],
      geometry,
      isPoint: g.type === 'Point',
    });
  }
  return out;
}

// -------------------------------------------------------- calcoli sulla rotta

/**
 * Rallentamenti davanti: sezioni TRAFFIC della rotta con ritardo rilevante,
 * accorpate se vicine. Restituisce distanza dall'attuale posizione.
 */
export function jamsAhead(route, alongM, horizonM) {
  if (!route?.traffic?.length) return [];
  const raw = route.traffic
    .filter((s) => s.endM > alongM && s.startM < alongM + horizonM)
    .filter((s) => s.category === 'ROAD_CLOSURE' || s.magnitude >= 2 || s.delayS >= 120)
    .sort((a, b) => a.startM - b.startM);
  const merged = [];
  for (const s of raw) {
    const last = merged[merged.length - 1];
    if (last && s.startM - last.endM < 300) {
      last.endM = Math.max(last.endM, s.endM);
      last.delayS += s.delayS;
      last.magnitude = Math.max(last.magnitude, s.magnitude);
      if (s.category === 'ROAD_CLOSURE') last.category = s.category;
    } else merged.push({ ...s });
  }
  return merged.map((s) => ({
    startM: s.startM, endM: s.endM,
    distM: Math.max(0, s.startM - alongM),
    inside: s.startM <= alongM,
    lengthM: s.endM - s.startM,
    delayS: s.delayS, magnitude: s.magnitude, category: s.category, speedKmh: s.speedKmh,
  }));
}

/** Incidenti che stanno sulla rotta e davanti a noi. */
export function incidentsOnRoute(incidents, route, alongM, horizonM) {
  const res = [];
  for (const inc of incidents) {
    const first = inc.geometry[0];
    const np = nearestOnPolyline(route.points, route.cum, first);
    const maxOff = inc.isPoint ? 35 : 60;
    if (np.distM > maxOff) continue;
    // direzione: un incidente con geometria orientata nel verso opposto riguarda l'altra carreggiata
    if (inc.geometry.length >= 2) {
      const last = inc.geometry[inc.geometry.length - 1];
      const incBrg = bearing(first, last);
      const routeBrg = headingAtDistance(route.points, route.cum, np.alongM);
      if (angDiff(incBrg, routeBrg) > 100) continue;
    }
    const distM = np.alongM - alongM;
    if (distM < -50 || distM > horizonM) continue;
    res.push({ ...inc, alongM: np.alongM, distM: Math.max(0, distM) });
  }
  return res.sort((a, b) => a.distM - b.distM);
}

// ------------------------------------------------------------------- monitor

export class TrafficMonitor {
  constructor({ api, voice, bus = defaultBus, navigator, now = () => Date.now(), cfg = CONFIG.traffic }) {
    this.api = api; this.voice = voice; this.bus = bus; this.navigator = navigator; this.now = now; this.cfg = cfg;
    this.incidents = [];
    this.pollTimer = null;
    this.polling = false;
    this.baselineDelayS = null;
    this.lastEval = 0;
    this.available = null;        // null = non ancora noto, true/false
    this.lastError = '';
    this._off = [];
  }

  start() {
    this._off.push(this.bus.on('nav:route', (e) => this.onRoute(e)));
    this._off.push(this.bus.on('nav:progress', (p) => this.onProgress(p)));
    this.pollTimer = setInterval(() => this.pollIncidents(), this.cfg.incidentPollMs);
  }
  stop() {
    this._off.forEach((f) => f());
    this._off = [];
    clearInterval(this.pollTimer);
    this.incidents = [];
    this.baselineDelayS = null;
  }

  onRoute({ route, source }) {
    if (!route) { this.incidents = []; this.baselineDelayS = null; this.bus.emit('traffic:incidents', []); return; }
    if (source === 'plan') { this.baselineDelayS = route.delayS; this.incidents = []; this.pollIncidents(); return; }
    if (this.baselineDelayS == null) this.baselineDelayS = route.delayS;
    const jump = route.delayS - this.baselineDelayS;
    if (source === 'check' && jump >= this.cfg.delayJumpS) {
      this.voice.announce({
        key: 'traffic:increased',
        text: Persona.trafficIncreasedNow(jump),
        priority: Priority.IMPORTANT,
        cooldownMs: 5 * 60000,
      });
    }
    // dopo ogni rotta (anche quando il traffico cala) la base si riallinea
    this.baselineDelayS = source === 'check' ? Math.min(route.delayS, Math.max(this.baselineDelayS, route.delayS)) : route.delayS;
    if (source === 'check' && jump < 0) this.baselineDelayS = route.delayS;
  }

  onProgress(p) {
    const t = this.now();
    if (t - this.lastEval < 4000) return;
    this.lastEval = t;
    const nav = this.navigator;
    if (!nav.active) return;
    const route = nav.route;
    const jams = jamsAhead(route, p.alongM, this.cfg.jamAnnounceHorizonM);
    for (const j of jams) {
      if (j.inside) continue;
      const at = pointAtDistance(route.points, route.cum, j.startM);
      const key = `jam:${at.lat.toFixed(3)},${at.lon.toFixed(3)}`;
      const major = j.magnitude >= 3 || j.delayS >= 240 || j.category === 'ROAD_CLOSURE';
      const text = j.category === 'ROAD_CLOSURE'
        ? Persona.incidentAhead('closed', j.distM)
        : Persona.jamAhead(j.distM, j.delayS);
      const status = this.voice.announce({
        key, text, priority: major ? Priority.IMPORTANT : Priority.INFO,
        ttlMs: 20000, cooldownMs: 10 * 60000, source: 'traffic',
      });
      if (status === 'spoken' && major) {
        // un rallentamento importante: verifico subito se esiste una via migliore
        this.voice.announce({ key: 'nav:checking-alt', text: Persona.checkingAlternative(), priority: Priority.IMPORTANT, cooldownMs: 3 * 60000, ttlMs: 15000 });
        nav.checkAlternatives({ reason: 'jam', announceNoAlternative: true });
      }
    }

    // incidenti noti
    if (this.incidents.length) {
      const near = incidentsOnRoute(this.incidents, route, p.alongM, 6000);
      for (const inc of near) {
        if (inc.kind === 'jam' && jams.some((j) => Math.abs(j.startM - inc.alongM) < 400)) continue; // già coperto
        const important = inc.kind === 'accident' || inc.kind === 'closed' || inc.kind === 'hazard' || inc.kind === 'breakdown';
        this.voice.announce({
          key: `inc:${inc.id}`,
          text: Persona.incidentAhead(inc.kind, inc.distM),
          priority: important ? Priority.IMPORTANT : Priority.INFO,
          ttlMs: 20000, cooldownMs: 15 * 60000, source: 'traffic',
        });
      }
    }
  }

  async pollIncidents() {
    const nav = this.navigator;
    if (this.polling || !nav.active || !nav.progress) return;
    this.polling = true;
    try {
      const route = nav.route;
      const from = nav.progress.alongM;
      const to = Math.min(route.lengthM, from + this.cfg.incidentHorizonM);
      const chunk = 8000;
      const reqs = [];
      for (let a = from; a < to; a += chunk) {
        const pts = [];
        for (let d = a; d <= Math.min(to, a + chunk); d += 500) pts.push(pointAtDistance(route.points, route.cum, d));
        pts.push(pointAtDistance(route.points, route.cum, Math.min(to, a + chunk)));
        reqs.push(this.api.incidents(bboxOf(pts, 400)));
      }
      const results = await Promise.all(reqs);
      const all = new Map();
      for (const r of results) for (const i of parseIncidents(r)) all.set(i.id, i);
      this.incidents = [...all.values()];
      this.available = true;
      this.lastError = '';
      this.bus.emit('traffic:incidents', incidentsOnRoute(this.incidents, route, from, this.cfg.incidentHorizonM));
    } catch (e) {
      this.available = false;
      this.lastError = e?.code || e?.message || 'errore';
    } finally {
      this.polling = false;
    }
  }

  snapshot() {
    const nav = this.navigator;
    if (!nav.active) return { level: null, jams: [], incidents: [] };
    const along = nav.progress?.alongM ?? 0;
    return {
      level: nav.snapshot().level,
      delayS: nav.route.delayS,
      jams: jamsAhead(nav.route, along, 8000).slice(0, 3),
      incidents: incidentsOnRoute(this.incidents, nav.route, along, 8000).slice(0, 3),
      available: this.available,
    };
  }
}
