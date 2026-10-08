// Client Overpass (OpenStreetMap): autovelox (highway=speed_camera) e semafori
// (highway=traffic_signals) lungo un percorso o intorno alla posizione.
// Dati reali e pubblici (ODbL). Copertura variabile: OSM non contiene i controlli mobili.

import { CONFIG } from './config.js';
import { resample, clamp } from './util.js';

const COMPASS = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };

function parseDirection(tags) {
  const raw = tags['camera:direction'] ?? tags['traffic_signals:direction'] ?? tags.direction;
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  if (COMPASS[s] != null) return COMPASS[s];
  const n = parseFloat(s);
  return Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(s) ? ((n % 360) + 360) % 360 : null; // 'forward'/'backward' non risolvibili senza la strada
}

function parseMaxspeed(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{2,3})(\s*mph)?$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return m[2] ? Math.round(n * 1.609) : n;
}

/** Converte la risposta Overpass in elementi dell'app. */
export function parseOverpass(json) {
  const out = [];
  for (const el of json?.elements ?? []) {
    if (el.type !== 'node' || el.lat == null) continue;
    const t = el.tags ?? {};
    if (t.highway === 'speed_camera') {
      out.push({
        id: `n${el.id}`, kind: 'camera', lat: el.lat, lon: el.lon,
        maxspeed: parseMaxspeed(t.maxspeed), dir: parseDirection(t),
        average: t.enforcement === 'average_speed' || t.camera_type === 'average_speed',
      });
    } else if (t.highway === 'traffic_signals') {
      out.push({ id: `n${el.id}`, kind: 'light', lat: el.lat, lon: el.lon, dir: parseDirection(t), ped: false });
    } else if (t.crossing === 'traffic_signals' || (t.highway === 'crossing' && t.crossing === 'traffic_signals')) {
      out.push({ id: `n${el.id}`, kind: 'light', lat: el.lat, lon: el.lon, dir: null, ped: true }); // semaforo pedonale
    }
  }
  return out;
}

const TAGS = ['[highway=speed_camera]', '[highway=traffic_signals]', '[crossing=traffic_signals]'];

export function corridorQuery(points, radiusM = 35) {
  const coords = points.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(',');
  const stmts = TAGS.map((t) => `node(around:${radiusM},${coords})${t};`).join('');
  return `[out:json][timeout:25];(${stmts});out body;`;
}

export function aroundQuery(lat, lon, radiusM) {
  const stmts = TAGS.map((t) => `node(around:${radiusM},${lat.toFixed(5)},${lon.toFixed(5)})${t};`).join('');
  return `[out:json][timeout:20];(${stmts});out body;`;
}

/** Spezza la rotta in tratti da ~8 km, ordinati partendo dalla posizione attuale. */
export function corridorChunks(route, alongM = 0, { stepM = 120, perChunk = 70 } = {}) {
  const pts = resample(route.points, route.cum, stepM).filter((p) => p.alongM >= alongM - stepM);
  const chunks = [];
  for (let i = 0; i < pts.length - 1; i += perChunk - 1) chunks.push(pts.slice(i, i + perChunk));
  return chunks.filter((c) => c.length >= 2);
}

export class OverpassClient {
  constructor({ fetchImpl, endpoints = CONFIG.overpass, timeoutMs = 25000 } = {}) {
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.endpoints = endpoints;
    this.timeoutMs = timeoutMs;
    this.lastGood = 0;
  }

  async query(ql) {
    let lastErr = null;
    for (let k = 0; k < this.endpoints.length; k++) {
      const i = (this.lastGood + k) % this.endpoints.length;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const r = await this.fetch(this.endpoints[i], {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(ql),
          signal: ctl.signal,
        });
        if (!r.ok) throw new Error(`overpass ${r.status}`);
        const json = await r.json();
        this.lastGood = i;
        return json;
      } catch (e) {
        lastErr = e;
      } finally {
        clearTimeout(t);
      }
    }
    throw lastErr || new Error('overpass non raggiungibile');
  }

  async corridor(points) { return parseOverpass(await this.query(corridorQuery(points))); }
  async around(lat, lon, radiusM = 1200) { return parseOverpass(await this.query(aroundQuery(lat, lon, clamp(radiusM, 200, 3000)))); }
}
