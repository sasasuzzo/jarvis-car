// Utilità condivise: geometria, formattazione per la voce, storage, event bus.
// Nessuna dipendenza dal DOM: tutto il file è importabile anche da Node (test).

const R = 6371008.8; // raggio terrestre medio, metri
export const toRad = (d) => (d * Math.PI) / 180;
export const toDeg = (r) => (r * 180) / Math.PI;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const KMH = 3.6; // m/s -> km/h

// ---------------------------------------------------------------- geometria

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Rotta iniziale da a a b, gradi 0..360 (0 = nord). */
export function bearing(a, b) {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Differenza angolare minima in gradi, 0..180. */
export function angDiff(a, b) {
  const d = Math.abs(((a - b) % 360 + 540) % 360 - 180);
  return d;
}

export function destPoint(p, brg, distM) {
  const δ = distM / R, θ = toRad(brg);
  const φ1 = toRad(p.lat), λ1 = toRad(p.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

// Proiezione locale equirettangolare: precisa a poche centinaia di metri.
function toXY(p, ref) {
  return {
    x: toRad(p.lon - ref.lon) * Math.cos(toRad(ref.lat)) * R,
    y: toRad(p.lat - ref.lat) * R,
  };
}

/** Proietta p sul segmento a-b. t in [0,1], distM = distanza p-segmento. */
export function projectOnSegment(p, a, b) {
  const A = toXY(a, p), B = toXY(b, p); // p all'origine
  const dx = B.x - A.x, dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : (-(A.x * dx + A.y * dy)) / len2;
  t = clamp(t, 0, 1);
  const cx = A.x + t * dx, cy = A.y + t * dy;
  return {
    t,
    distM: Math.hypot(cx, cy),
    point: { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t },
    segLen: Math.sqrt(len2),
  };
}

export function cumulativeDistances(points) {
  const cum = new Array(points.length);
  cum[0] = 0;
  for (let i = 1; i < points.length; i++) cum[i] = cum[i - 1] + haversine(points[i - 1], points[i]);
  return cum;
}

/**
 * Punto più vicino a p lungo la polilinea. fromIdx/toIdx limitano la ricerca
 * (utile per seguire la rotta senza "saltare" su tratti paralleli).
 */
export function nearestOnPolyline(points, cum, p, { fromIdx = 0, toIdx = points.length - 2 } = {}) {
  let best = null;
  const lo = clamp(fromIdx, 0, points.length - 2);
  const hi = clamp(toIdx, lo, points.length - 2);
  for (let i = lo; i <= hi; i++) {
    const pr = projectOnSegment(p, points[i], points[i + 1]);
    if (!best || pr.distM < best.distM) {
      best = { idx: i, t: pr.t, distM: pr.distM, point: pr.point, alongM: cum[i] + pr.t * (cum[i + 1] - cum[i]) };
    }
  }
  return best;
}

/** Punto a distanza d (metri) dall'inizio della polilinea. */
export function pointAtDistance(points, cum, d) {
  if (d <= 0) return { ...points[0], idx: 0 };
  const total = cum[cum.length - 1];
  if (d >= total) return { ...points[points.length - 1], idx: points.length - 2 };
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  const seg = cum[lo + 1] - cum[lo];
  const t = seg === 0 ? 0 : (d - cum[lo]) / seg;
  return {
    lat: points[lo].lat + (points[lo + 1].lat - points[lo].lat) * t,
    lon: points[lo].lon + (points[lo + 1].lon - points[lo].lon) * t,
    idx: lo,
  };
}

/** Direzione di marcia della polilinea alla distanza d. */
export function headingAtDistance(points, cum, d) {
  const here = pointAtDistance(points, cum, d);
  const i = clamp(here.idx, 0, points.length - 2);
  return bearing(points[i], points[i + 1]);
}

/** Campiona la polilinea ogni stepM metri (incluso l'ultimo punto). */
export function resample(points, cum, stepM) {
  const out = [];
  const total = cum[cum.length - 1];
  for (let d = 0; d < total; d += stepM) {
    const p = pointAtDistance(points, cum, d);
    out.push({ lat: p.lat, lon: p.lon, alongM: d });
  }
  const last = points[points.length - 1];
  out.push({ lat: last.lat, lon: last.lon, alongM: total });
  return out;
}

export function bboxOf(points, padM = 0) {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  const dLat = toDeg(padM / R);
  const dLon = toDeg(padM / (R * Math.cos(toRad((minLat + maxLat) / 2))));
  return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLon: minLon - dLon, maxLon: maxLon + dLon };
}

// ------------------------------------------------- formattazione per la voce

const UNITS = ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci',
  'undici', 'dodici', 'tredici', 'quattordici', 'quindici', 'sedici', 'diciassette', 'diciotto', 'diciannove'];
const TENS = ['', '', 'venti', 'trenta', 'quaranta', 'cinquanta', 'sessanta', 'settanta', 'ottanta', 'novanta'];

/** 0..99 in lettere ("sette", "ventitré"); oltre, restituisce le cifre. */
export function numberToItalian(n) {
  n = Math.round(n);
  if (n < 0 || n > 99) return String(n);
  if (n < 20) return UNITS[n];
  const t = Math.floor(n / 10), u = n % 10;
  if (u === 0) return TENS[t];
  let tens = TENS[t];
  if (u === 1 || u === 8) tens = tens.slice(0, -1); // ventuno, ventotto
  const unit = u === 3 ? 'tré' : UNITS[u];
  return tens + unit;
}

/** Distanza parlata: "400 metri", "1,5 chilometri", "1 chilometro". */
export function distanceSpeech(m) {
  if (m < 1000) {
    let r;
    if (m < 100) r = Math.max(10, Math.round(m / 10) * 10);
    else if (m < 300) r = Math.round(m / 50) * 50;
    else r = Math.round(m / 100) * 100;
    if (r >= 1000) return '1 chilometro';
    return `${r} metri`;
  }
  const km = m / 1000;
  if (km < 10) {
    const r = Math.round(km * 10) / 10;
    if (r === 1) return '1 chilometro';
    return `${String(r).replace('.', ',')} chilometri`;
  }
  return `${Math.round(km)} chilometri`;
}

/** Durata parlata: "28 minuti", "1 ora e 5 minuti", "meno di un minuto". */
export function durationSpeech(s, { words = false } = {}) {
  if (s < 45) return 'meno di un minuto';
  const totMin = Math.round(s / 60);
  const num = (n) => (words ? numberToItalian(n) : String(n));
  const minStr = (n) => (n === 1 ? 'un minuto' : `${num(n)} minuti`);
  if (totMin < 60) return minStr(totMin);
  const h = Math.floor(totMin / 60), m = totMin % 60;
  const hStr = h === 1 ? "un'ora" : `${num(h)} ore`;
  return m === 0 ? hStr : `${hStr} e ${minStr(m)}`;
}

export function clockText(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ storage

const memStore = new Map();
export const store = {
  get(key, fallback = null) {
    try {
      const raw = globalThis.localStorage?.getItem('jc.' + key);
      if (raw != null) return JSON.parse(raw);
    } catch { /* storage non disponibile: si usa la memoria */ }
    return memStore.has(key) ? memStore.get(key) : fallback;
  },
  set(key, value) {
    memStore.set(key, value);
    try { globalThis.localStorage?.setItem('jc.' + key, JSON.stringify(value)); } catch { /* ignora */ }
  },
  del(key) {
    memStore.delete(key);
    try { globalThis.localStorage?.removeItem('jc.' + key); } catch { /* ignora */ }
  },
};

// ---------------------------------------------------------------- event bus

export class Bus {
  constructor() { this.map = new Map(); }
  on(evt, fn) {
    if (!this.map.has(evt)) this.map.set(evt, new Set());
    this.map.get(evt).add(fn);
    return () => this.map.get(evt)?.delete(fn);
  }
  emit(evt, data) {
    for (const fn of this.map.get(evt) ?? []) {
      try { fn(data); } catch (e) { console.error(`[bus:${evt}]`, e); }
    }
  }
}
export const bus = new Bus();

// ------------------------------------------------------------------- varie

export const uid = () => Math.random().toString(36).slice(2, 10);

export function withTimeout(promise, ms, label = 'timeout') {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/** Normalizza per il confronto di testo parlato (minuscolo, senza accenti/punteggiatura). */
export function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9%\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
