// Navigazione: parsing delle rotte TomTom (con traffico), avanzamento sul percorso,
// annunci vocali di svolte/rotatorie, ricalcolo quando si esce di strada e ricerca
// di alternative quando il traffico cambia.
//
// Nessun dato simulato: tutto proviene da GPS reali e dalle risposte del servizio.

import { CONFIG } from './config.js';
import { Persona } from './persona.js';
import { Priority } from './voice.js';
import {
  bus as defaultBus, store, clamp, nearestOnPolyline, cumulativeDistances,
} from './util.js';

// ------------------------------------------------------------------ parsing

const pt = (p) => (Array.isArray(p) ? { lat: p[0], lon: p[1] } : { lat: p.latitude, lon: p.longitude });
const MAGNITUDE = { UNKNOWN: 0, MINOR: 1, MODERATE: 2, MAJOR: 3, UNDEFINED: 4 };
const normMagnitude = (m) => (typeof m === 'number' ? m : MAGNITUDE[String(m || '').toUpperCase()] ?? 0);

export function parseTomTomRoutes(json) {
  return (json?.routes ?? []).map((r, i) => parseRoute(r, i)).filter((r) => r.points.length >= 2);
}

function parseRoute(r, i) {
  const points = [];
  for (const leg of r.legs ?? []) for (const p of leg.points ?? []) points.push(pt(p));
  const cum = points.length ? cumulativeDistances(points) : [];
  const s = r.summary ?? {};
  const lengthM = s.lengthInMeters ?? cum[cum.length - 1] ?? 0;

  const instructions = (r.guidance?.instructions ?? []).map((ins, k) => ({
    idx: k,
    pointIdx: ins.pointIndex ?? 0,
    offsetM: ins.routeOffsetInMeters ?? cum[ins.pointIndex ?? 0] ?? 0,
    travelS: ins.travelTimeInSeconds ?? null,
    type: ins.instructionType ?? '',
    maneuver: ins.maneuver ?? '',
    street: ins.street ?? '',
    roundaboutExit: ins.roundaboutExitNumber ?? null,
    signpost: ins.signpostText ?? '',
    message: ins.message ?? '',
    point: ins.point ? pt(ins.point) : points[ins.pointIndex ?? 0],
  }));

  const traffic = (r.sections ?? [])
    .filter((x) => String(x.sectionType).toUpperCase() === 'TRAFFIC')
    .map((x) => ({
      startIdx: x.startPointIndex,
      endIdx: x.endPointIndex,
      startM: cum[x.startPointIndex] ?? 0,
      endM: cum[x.endPointIndex] ?? 0,
      category: String(x.simpleCategory || 'JAM').toUpperCase(),   // JAM | ROAD_WORK | ROAD_CLOSURE | OTHER
      magnitude: normMagnitude(x.magnitudeOfDelay),                // 0..4
      delayS: x.delayInSeconds ?? 0,
      speedKmh: x.effectiveSpeedInKmh ?? null,
    }));

  const timeS = s.travelTimeInSeconds ?? 0;
  return {
    id: `r${Date.now().toString(36)}${i}`,
    points, cum,
    lengthM,
    timeS,
    delayS: s.trafficDelayInSeconds ?? 0,
    noTrafficS: s.noTrafficTravelTimeInSeconds ?? timeS - (s.trafficDelayInSeconds ?? 0),
    departure: s.departureTime ? new Date(s.departureTime) : null,
    arrival: s.arrivalTime ? new Date(s.arrivalTime) : null,
    instructions,
    traffic,
  };
}

/** Etichetta del traffico in base al rapporto tra tempo con traffico e tempo libero. */
export function trafficLevel(route) {
  const base = Math.max(1, route.noTrafficS || route.timeS - route.delayS);
  const ratio = route.timeS / base;
  if (route.delayS < 60 || ratio < 1.1) return 'scorrevole';
  if (ratio < 1.3) return 'moderato';
  if (ratio < 1.6) return 'intenso';
  return 'molto intenso';
}

/** Tempo di viaggio residuo alla distanza d (m) lungo la rotta, interpolando le istruzioni. */
export function timeRemainingAt(route, alongM) {
  const marks = [{ d: 0, t: 0 }];
  for (const ins of route.instructions) {
    if (ins.travelS != null && ins.offsetM >= marks[marks.length - 1].d) marks.push({ d: ins.offsetM, t: ins.travelS });
  }
  const last = marks[marks.length - 1];
  if (last.d < route.lengthM) marks.push({ d: route.lengthM, t: route.timeS });
  for (let i = 1; i < marks.length; i++) {
    if (alongM <= marks[i].d) {
      const a = marks[i - 1], b = marks[i];
      const f = b.d === a.d ? 0 : (alongM - a.d) / (b.d - a.d);
      return Math.max(0, route.timeS - (a.t + f * (b.t - a.t)));
    }
  }
  return 0;
}

/** Quanto una rotta candidata somiglia alla rotta attuale nei primi chilometri (m medi di scarto). */
export function routeDivergence(candidate, current, alongM, lookAheadM = 3000) {
  let sum = 0, n = 0;
  const lo = Math.max(0, alongM - 200);
  const startIdx = Math.max(0, current.cum.findIndex((c) => c >= lo) - 1);
  for (let d = 0; d <= Math.min(lookAheadM, candidate.lengthM); d += 150) {
    let i = 0;
    while (i < candidate.cum.length - 2 && candidate.cum[i + 1] < d) i++;
    const p = candidate.points[i];
    const np = nearestOnPolyline(current.points, current.cum, p, { fromIdx: startIdx, toIdx: current.points.length - 2 });
    sum += np.distM; n++;
  }
  return n ? sum / n : Infinity;
}

const SKIP_MANEUVERS = new Set(['DEPART', 'FOLLOW', 'STRAIGHT', 'WAYPOINT_REACHED', 'WAYPOINT_LEFT', 'WAYPOINT_RIGHT', '']);
const STAGE = { far: 0, mid: 1, near: 2 };

/** Soglie (metri) degli annunci in funzione della velocità: ~40 s, ~17 s, ~5 s prima della manovra. */
export function stageThresholds(speedMs) {
  const v = Math.max(speedMs || 0, 8);
  return { far: clamp(v * 40, 500, 1600), mid: clamp(v * 17, 200, 600), near: clamp(v * 5, 50, 150) };
}

export function parsePlaces(json) {
  return (json?.results ?? [])
    .filter((r) => r?.position)
    .map((r) => ({
      name: r.poi?.name || r.address?.freeformAddress || 'Luogo',
      address: r.address?.freeformAddress || '',
      lat: r.position.lat,
      lon: r.position.lon,
      category: r.poi?.categories?.[0] || r.type || '',
      distM: r.dist ?? null,
      score: r.score ?? 0,
    }));
}

// ----------------------------------------------------------------- navigator

export class RouteNavigator {
  constructor({ api, voice, bus = defaultBus, settings, now = () => Date.now(), cfg = CONFIG.nav }) {
    this.api = api; this.voice = voice; this.bus = bus; this.settings = settings; this.now = now; this.cfg = cfg;
    this.state = 'idle';            // idle | navigating | arrived
    this.destination = null;        // { name, lat, lon }
    this.route = null;
    this.alternatives = [];
    this.previousRoute = null;
    this.pending = null;            // alternativa proposta e non ancora accettata
    this.progress = null;
    this.lastFix = null;
    this.offCount = 0;
    this.rerouting = false;
    this.checking = false;
    this.lastCheckAt = 0;
    this.lastSwitchAt = 0;
    this.altBlockedUntil = 0;
    this.announced = new Map();     // chiave geografica della manovra -> stadio massimo annunciato
  }

  get active() { return this.state === 'navigating' && !!this.route; }

  avoidList() {
    const a = [];
    if (this.settings.get('avoidTolls')) a.push('tollRoads');
    if (this.settings.get('avoidMotorways')) a.push('motorways');
    return a;
  }

  // ------------------------------------------------------------ ricerca / piano
  async searchPlaces(query, near) {
    const json = await this.api.searchPlaces(query, { near });
    return parsePlaces(json);
  }

  /** Stima di viaggio (senza cambiare stato): serve all'agenda per "parta entro le…". */
  async estimate(from, to) {
    const json = await this.api.routeRaw({ from, to, avoid: this.avoidList(), alternatives: 0 });
    const r = parseTomTomRoutes(json)[0];
    if (!r) return null;
    return { timeS: r.timeS, delayS: r.delayS, noTrafficS: r.noTrafficS, lengthM: r.lengthM, level: trafficLevel(r) };
  }

  /** Calcola il percorso migliore con il traffico attuale e lo rende attivo. */
  async plan(dest, from, { heading = null } = {}) {
    const json = await this.api.routeRaw({ from, to: dest, avoid: this.avoidList(), alternatives: 2, heading });
    const routes = parseTomTomRoutes(json);
    if (!routes.length) throw new Error('no_route');
    routes.sort((a, b) => a.timeS - b.timeS);
    this.destination = dest;
    this._setRoute(routes[0], routes.slice(1), 'plan');
    this.state = 'navigating';
    this.progress = null; this.offCount = 0; this.announced.clear(); this.pending = null; this.previousRoute = null;
    this.lastCheckAt = this.now();
    store.set('trip', { dest, ts: this.now() });
    this.bus.emit('nav:state', { state: this.state });
    return { route: this.route, level: trafficLevel(this.route) };
  }

  stop({ silent = false } = {}) {
    if (this.state === 'idle') return;
    this.state = 'idle';
    this.route = null; this.alternatives = []; this.progress = null; this.pending = null; this.previousRoute = null;
    this.destination = null;
    store.del('trip');
    this.bus.emit('nav:state', { state: 'idle' });
    this.bus.emit('nav:route', { route: null });
    if (!silent) this.voice.announce({ key: 'nav:stopped', text: Persona.navStopped(), priority: Priority.IMPORTANT, force: true });
  }

  _setRoute(route, alternatives = [], source = 'check') {
    this.route = route;
    this.alternatives = alternatives;
    this.bus.emit('nav:route', { route, alternatives, destination: this.destination, source });
  }

  // --------------------------------------------------------------- avanzamento
  onFix(fix) {
    if (!this.active) return;
    this.lastFix = fix;
    const { points, cum } = this.route;
    const prev = this.progress;

    const win = prev ? { fromIdx: Math.max(0, prev.idx - 5), toIdx: Math.min(points.length - 2, prev.idx + 120) } : {};
    let np = nearestOnPolyline(points, cum, fix, win);
    if (prev && np.distM > this.cfg.offRouteM * 2) {
      const g = nearestOnPolyline(points, cum, fix);   // magari siamo rientrati su un altro tratto
      if (g.distM < np.distM) np = g;
    }
    let along = np.alongM;
    if (prev && along < prev.alongM - 80) along = prev.alongM; // ignora salti all'indietro dovuti al rumore GPS

    const total = this.route.lengthM || cum[cum.length - 1];
    const remainingM = Math.max(0, total - along);
    const remainingS = timeRemainingAt(this.route, along);
    const next = this._nextInstruction(along);
    this.progress = {
      idx: np.idx, alongM: along, crossM: np.distM, remainingM, remainingS,
      eta: new Date(this.now() + remainingS * 1000),
      next: next ? { ...next.ins, distM: Math.max(0, next.ins.offsetM - along) } : null,
      following: next?.following ?? null,
    };

    // fuori strada?
    const speed = fix.speed ?? 0;
    const threshold = Math.max(this.cfg.offRouteM, (fix.accuracy ?? 0) * 1.5);
    if (np.distM > threshold && speed > 2) this.offCount++; else this.offCount = 0;

    this.bus.emit('nav:progress', this.progress);

    if (this.offCount >= this.cfg.offRouteFixes && !this.rerouting) { this.reroute({ reason: 'offroute' }); return; }
    if (remainingM <= this.cfg.arrivalM) { this._arrive(); return; }

    this._announceManeuver(fix, along);

    if (this.now() - this.lastCheckAt > this.cfg.recheckEveryMs) this.checkAlternatives({ manual: false });
  }

  _nextInstruction(along) {
    const list = this.route.instructions;
    for (let i = 0; i < list.length; i++) {
      const ins = list[i];
      if (SKIP_MANEUVERS.has(ins.maneuver) || ins.maneuver.startsWith('ARRIVE')) continue;
      if (ins.offsetM > along + 5) {
        let following = null;
        for (let j = i + 1; j < list.length; j++) {
          if (SKIP_MANEUVERS.has(list[j].maneuver) || list[j].maneuver.startsWith('ARRIVE')) continue;
          following = list[j]; break;
        }
        return { ins, following };
      }
    }
    return null;
  }

  _announceManeuver(fix, along) {
    const p = this.progress;
    if (!p?.next) return;
    const ins = p.next;
    const th = stageThresholds(fix.speed);
    const d = ins.distM;
    const stage = d <= th.near ? 'near' : d <= th.mid ? 'mid' : d <= th.far ? 'far' : null;
    if (!stage) return;
    // chiave geografica: sopravvive al ricalcolo della rotta senza ripetere l'annuncio
    const gk = ins.point ? `${ins.point.lat.toFixed(4)},${ins.point.lon.toFixed(4)}` : `${ins.idx}`;
    const done = this.announced.get(gk) ?? -1;
    if (STAGE[stage] <= done) return;
    this.announced.set(gk, STAGE[stage]);

    const follow = p.following && p.following.offsetM - ins.offsetM < 250 ? p.following : null;
    const ttl = { far: 14000, mid: 9000, near: 5000 }[stage];
    this.voice.announce({
      key: `man:${gk}:${stage}`,
      text: Persona.turn(stage, d, ins, { next: stage === 'near' ? null : follow }),
      priority: Priority.IMPORTANT,
      ttlMs: ttl,
      cooldownMs: 120000,
      source: 'navigation',
    });
  }

  _arrive() {
    if (this.state !== 'navigating') return;
    this.state = 'arrived';
    store.del('trip');
    this.voice.announce({ key: 'nav:arrived', text: Persona.arrival(), priority: Priority.IMPORTANT, force: true, ttlMs: 20000 });
    this.bus.emit('nav:arrived', { destination: this.destination });
    this.bus.emit('nav:state', { state: 'arrived' });
  }

  // ----------------------------------------------------------------- ricalcolo
  async reroute({ reason = 'manual' } = {}) {
    if (this.rerouting || !this.destination || !this.lastFix) return false;
    this.rerouting = true;
    try {
      if (reason === 'offroute') {
        this.voice.announce({ key: 'nav:offroute', text: Persona.offRoute(), priority: Priority.IMPORTANT, cooldownMs: 20000, ttlMs: 8000 });
      }
      let routes = null;
      for (let attempt = 0; attempt < 3 && !routes; attempt++) {
        try {
          const json = await this.api.routeRaw({
            from: this.lastFix, to: this.destination, avoid: this.avoidList(), alternatives: 2,
            heading: (this.lastFix.speed ?? 0) > 2 ? this.lastFix.heading : null,
          });
          const parsed = parseTomTomRoutes(json);
          if (parsed.length) routes = parsed;
        } catch (e) {
          if (e.code === 'unauthorized') throw e;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (!routes) {
        this.voice.announce({ key: 'nav:route-failed', text: Persona.routeFailed(), priority: Priority.IMPORTANT, cooldownMs: 60000 });
        return false;
      }
      routes.sort((a, b) => a.timeS - b.timeS);
      this.progress = null; this.offCount = 0;
      this._setRoute(routes[0], routes.slice(1), 'reroute');
      this.lastCheckAt = this.now();
      this.voice.announce({ key: 'nav:rerouted', text: Persona.rerouted(), priority: Priority.IMPORTANT, cooldownMs: 15000, ttlMs: 10000 });
      this.bus.emit('nav:rerouted', { reason });
      return true;
    } catch (e) {
      console.warn('[nav] ricalcolo fallito', e);
      return false;
    } finally {
      this.rerouting = false;
    }
  }

  /**
   * Ricalcola dal punto attuale con il traffico fresco: aggiorna la rotta corrente
   * e, se esiste un'alternativa molto più veloce, la propone/adotta.
   */
  async checkAlternatives({ manual = false, reason = 'periodic', announceNoAlternative = false } = {}) {
    if (this.checking || !this.active || !this.lastFix) return null;
    this.checking = true;
    this.lastCheckAt = this.now();
    try {
      if (manual) this.voice.reply(Persona.checkingAlternative());
      const json = await this.api.routeRaw({
        from: this.lastFix, to: this.destination, avoid: this.avoidList(), alternatives: 3,
        heading: (this.lastFix.speed ?? 0) > 2 ? this.lastFix.heading : null,
      });
      const routes = parseTomTomRoutes(json);
      if (!routes.length || !this.active) return null;

      const along = this.progress?.alongM ?? 0;
      // quale delle rotte restituite è "quella che sto già seguendo"?
      const scored = routes.map((r) => ({ r, div: routeDivergence(r, this.route, along) }));
      scored.sort((a, b) => a.div - b.div);
      const cur = scored[0].r;
      const best = routes.reduce((a, b) => (b.timeS < a.timeS ? b : a));
      const saving = cur.timeS - best.timeS;
      const enough = saving >= Math.max(this.cfg.minSavingS, this.cfg.minSavingPct * cur.timeS);
      const cooled = this.now() >= this.altBlockedUntil && this.now() - this.lastSwitchAt > this.cfg.altCooldownMs;

      if (best !== cur && enough && (cooled || manual)) {
        this.voice.announce({ key: `nav:alt-found:${Math.round(saving / 60)}`, text: Persona.altFound(saving), priority: Priority.IMPORTANT, force: manual, cooldownMs: 120000 });
        if (this.settings.get('autoAcceptAlternative') || manual) {
          this.adoptRoute(best, routes.filter((r) => r !== best));
          this.voice.announce({ key: 'nav:alt-adopted', text: Persona.altAdopted(), priority: Priority.IMPORTANT, force: true });
        } else {
          this.pending = { route: best, others: routes.filter((r) => r !== best), savingS: saving, at: this.now() };
          this.bus.emit('nav:alternative', { savingS: saving });
        }
        return { adopted: !!this.settings.get('autoAcceptAlternative') || manual, savingS: saving };
      }

      // nessun cambio: si aggiorna comunque la rotta corrente (traffico, ETA) senza annunci
      this.progress = null;
      this._setRoute(cur, routes.filter((r) => r !== cur), 'check');
      if (manual) this.voice.reply(Persona.noAlternative());
      else if (announceNoAlternative) this.voice.announce({ key: 'nav:no-alt', text: Persona.noAlternative(), priority: Priority.IMPORTANT, cooldownMs: 120000 });
      return { adopted: false, savingS: Math.max(0, saving) };
    } catch (e) {
      if (manual) this.voice.reply(Persona.routeFailed());
      console.warn('[nav] verifica alternative fallita', e?.message || e);
      return null;
    } finally {
      this.checking = false;
    }
  }

  adoptRoute(route, others = []) {
    this.previousRoute = this.route;
    this.pending = null;
    this.progress = null; this.offCount = 0;
    this.lastSwitchAt = this.now();
    this._setRoute(route, others, 'alternative');
    this.bus.emit('nav:rerouted', { reason: 'alternative' });
  }

  acceptPending() {
    if (!this.pending) return false;
    const { route, others } = this.pending;
    this.adoptRoute(route, others);
    this.voice.reply(Persona.altAdopted());
    return true;
  }

  rejectPending() {
    if (!this.pending) return false;
    this.pending = null;
    this.altBlockedUntil = this.now() + 10 * 60000;
    this.voice.reply(Persona.altKept());
    return true;
  }

  /** "Annulla" dopo un cambio automatico: torna alla rotta di prima. */
  revert() {
    if (!this.previousRoute) return false;
    const cur = this.route;
    this.progress = null; this.offCount = 0;
    this._setRoute(this.previousRoute, [cur], 'revert');
    this.previousRoute = null;
    this.altBlockedUntil = this.now() + 15 * 60000;
    this.voice.reply(Persona.altRevert());
    return true;
  }

  getEta() {
    if (!this.active || !this.progress) return null;
    return { remainingS: this.progress.remainingS, remainingM: this.progress.remainingM, arrival: this.progress.eta };
  }

  /** Istantanea per il Contextual Engine. */
  snapshot() {
    if (!this.route) return { state: this.state, active: false };
    const lastPending = this.pending && this.now() - this.pending.at > 30000 ? (this.pending = null) : this.pending;
    return {
      state: this.state,
      active: this.active,
      destination: this.destination,
      alongM: this.progress?.alongM ?? 0,
      remainingM: this.progress?.remainingM ?? this.route.lengthM,
      remainingS: this.progress?.remainingS ?? this.route.timeS,
      eta: this.progress?.eta ?? null,
      next: this.progress?.next ?? null,
      level: trafficLevel(this.route),
      delayS: this.route.delayS,
      route: this.route,
      pendingAlternative: lastPending ? { savingS: lastPending.savingS } : null,
    };
  }
}

